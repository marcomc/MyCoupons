"""Fail-closed, resumable local provisioning support for MyCoupons.

The module deliberately has no Google API client dependency.  Cloud commands
are narrowly constrained, bounded, and never return their raw diagnostics.
"""

from __future__ import annotations

import dataclasses
import datetime
import hashlib
import hmac
import http.client
import json
import math
import os
import re
import selectors
import secrets
import shutil
import signal
import stat
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence


class ProvisionerError(Exception):
    """A safe, operator-facing failure that never includes command output."""


class ProjectNotFound(ProvisionerError):
    """An internal, narrowly classified absent-project result."""


class BootstrapSecretNotFound(ProvisionerError):
    """An internal, narrowly classified absent bootstrap-secret result."""


class AppsScriptHttpError(ProvisionerError):
    """An Apps Script HTTP failure whose status is safe to classify locally."""

    def __init__(self, status: int) -> None:
        super().__init__("Apps Script API request was rejected")
        self.status = status


INSTALLER_CONFIG_KEYS = frozenset(
    {
        "ownerEmail",
        "spreadsheetId",
        "spreadsheetName",
        "sheetName",
        "labelName",
        "locale",
        "timeZone",
        "initialDate",
        "developerProject",
        "vertexProject",
        "vertexLocation",
        "model",
        "autoVertexFallback",
        "fetchRemoteImages",
    }
)

CLOUD_CONFIG_KEYS = frozenset({"vertexBillingAccount", "cloudInstallationId"})
CONFIG_KEYS = INSTALLER_CONFIG_KEYS | CLOUD_CONFIG_KEYS

CONFIG_DEFAULTS: dict[str, Any] = {
    "spreadsheetId": "",
    "spreadsheetName": "My Coupons",
    "sheetName": "Coupon Manager",
    "labelName": "Coupon Code Discount",
    "locale": "en",
    "timeZone": "Europe/Rome",
    "initialDate": "",
    "developerProject": "",
    "vertexProject": "",
    "vertexBillingAccount": "",
    "cloudInstallationId": "",
    "vertexLocation": "global",
    "model": "gemini-flash-latest",
    "autoVertexFallback": False,
    "fetchRemoteImages": True,
}

IDENTITY_FILE = "identity.key"
STATE_FILE = "state.json"
LOCK_FILE = "install.lock"
STATE_VERSION = 3
MAX_CONFIG_BYTES = 8000
MAX_COMMAND_OUTPUT_BYTES = 65536
MAX_BUNDLE_FILE_BYTES = 1024 * 1024
MAX_BUNDLE_TOTAL_BYTES = 8 * 1024 * 1024
MAX_BUNDLE_FILES = 1000
MAX_BUNDLE_PATH_BYTES = 128 * 1024
# Source responses include the complete bundle and JSON escaping overhead.  Keep
# this distinct from the small, non-source command response bound.
MAX_APPS_SCRIPT_SOURCE_RESPONSE_BYTES = MAX_BUNDLE_TOTAL_BYTES * 8 + MAX_BUNDLE_PATH_BYTES + 1024 * 1024
PROJECT_ID_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
PROJECT_NUMBER_RE = re.compile(r"^[1-9][0-9]{5,31}$")
INSTALLATION_LABEL_RE = re.compile(r"^[a-z][a-z0-9-]{14,61}[a-z0-9]$")
BILLING_ACCOUNT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{4,98}$")
EMAIL_RE = re.compile(r"^[^@]+@[^@]+\.[^@]+$")
MODEL_RE = re.compile(r"^gemini-[a-z0-9._-]+$")
VERTEX_LOCATION_RE = re.compile(r"^[a-z][a-z0-9-]*$")
ECMASCRIPT_TRIM_CHARS = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
ECMASCRIPT_WHITESPACE_RE = re.compile(f"[{re.escape(ECMASCRIPT_TRIM_CHARS)}]")

CLOUD_INSTALLATION_LABEL = "mycoupons-installation"
CLOUD_ROLE_LABEL = "mycoupons-role"
CLOUD_ROLES = frozenset(("developer", "vertex"))
DEVELOPER_SERVICES = ("apikeys.googleapis.com", "generativelanguage.googleapis.com")
VERTEX_SERVICES = ("aiplatform.googleapis.com", "script.googleapis.com", "secretmanager.googleapis.com", "cloudresourcemanager.googleapis.com", "drive.googleapis.com", "gmail.googleapis.com")
APPS_SCRIPT_TITLE = "MyCoupons"
APPS_SCRIPT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,200}$")
BOOTSTRAP_SECRET_NAME = "mycoupons-bootstrap"
BOOTSTRAP_SECRET_LABEL = "mycoupons-installation"


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, allow_nan=False, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _finite_json_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("non-finite JSON number")
    return parsed


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _is_private_mode(mode: int, required: int) -> bool:
    return stat.S_IMODE(mode) & 0o077 == 0 and stat.S_IMODE(mode) & required == required


def _assert_not_symlink(path: Path) -> None:
    if path.is_symlink():
        raise ProvisionerError("refusing symlinked provisioning path")


def _no_duplicate_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"unsupported JSON constant: {value}")


def _valid_email(value: str) -> bool:
    return not ECMASCRIPT_WHITESPACE_RE.search(value) and EMAIL_RE.fullmatch(value) is not None


def _assert_well_formed_unicode(value: Any) -> None:
    if isinstance(value, str):
        try:
            value.encode("utf-16-le")
        except UnicodeEncodeError as exc:
            raise ProvisionerError("private provisioning JSON contains malformed Unicode") from exc
    elif isinstance(value, list):
        for item in value:
            _assert_well_formed_unicode(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            _assert_well_formed_unicode(key)
            _assert_well_formed_unicode(item)


def _utf16_units(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _expand_absolute_path(path: Path, *, error_message: str) -> Path:
    try:
        return Path(os.path.abspath(os.fspath(path.expanduser())))
    except RuntimeError as exc:
        raise ProvisionerError(error_message) from exc


def _assert_private_directory(path: Path) -> None:
    _assert_not_symlink(path)
    try:
        directory_stat = path.stat()
    except OSError as exc:
        raise ProvisionerError("provisioning directory cannot be inspected") from exc
    if not stat.S_ISDIR(directory_stat.st_mode) or not _is_private_mode(directory_stat.st_mode, 0o700):
        raise ProvisionerError("provisioning directory must be mode 0700 and not group/world accessible")


def _assert_existing_parents_safe(path: Path) -> None:
    missing: list[Path] = []
    parent = path.parent
    while True:
        _assert_not_symlink(parent)
        try:
            parent_stat = parent.stat()
        except FileNotFoundError:
            missing.append(parent)
            if parent == parent.parent:
                raise ProvisionerError("provisioning directory has no usable parent")
            parent = parent.parent
            continue
        except OSError as exc:
            raise ProvisionerError("provisioning directory parent cannot be inspected") from exc
        if not stat.S_ISDIR(parent_stat.st_mode):
            raise ProvisionerError("provisioning directory parent is not a directory")
        break
    for directory in reversed(missing):
        try:
            directory.mkdir(mode=0o700)
        except FileExistsError:
            _assert_private_directory(directory)
        except OSError as exc:
            raise ProvisionerError("unable to create private provisioning parent directory") from exc
        _assert_private_directory(directory)


def _inside_git_worktree(path: Path) -> bool:
    for candidate in (path, *path.parents):
        if (candidate / ".git").exists():
            return True
    return False


def _assert_outside_worktree(path: Path) -> None:
    if _inside_git_worktree(path):
        raise ProvisionerError("private provisioning state must be outside the Git worktree")


def ensure_state_dir(path: Path) -> Path:
    """Create or validate a local state directory without following symlinks."""
    path = _expand_absolute_path(path, error_message="provisioning directory cannot be resolved")
    _assert_not_symlink(path)
    path = path.resolve(strict=False)
    _assert_outside_worktree(path)
    _assert_existing_parents_safe(path)
    if path.exists():
        _assert_private_directory(path)
        return path
    try:
        path.mkdir(mode=0o700, parents=False, exist_ok=False)
    except OSError as exc:
        raise ProvisionerError("unable to create provisioning directory") from exc
    _assert_private_directory(path)
    return path


def _read_private_bytes(path: Path, *, maximum_bytes: int) -> bytes:
    descriptor = -1
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        file_stat = os.fstat(descriptor)
        if not stat.S_ISREG(file_stat.st_mode) or not _is_private_mode(file_stat.st_mode, 0o600):
            raise ProvisionerError("private provisioning file must be a regular mode-0600 file")
        if file_stat.st_size > maximum_bytes:
            raise ProvisionerError("private provisioning file is too large")
        with os.fdopen(descriptor, "rb", closefd=True) as handle:
            descriptor = -1
            raw = handle.read(maximum_bytes + 1)
    except OSError as exc:
        raise ProvisionerError("unable to read private provisioning file") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if len(raw) > maximum_bytes:
        raise ProvisionerError("private provisioning file is too large")
    return raw


def _read_json_file(path: Path, *, maximum_bytes: int) -> Any:
    raw = _read_private_bytes(path, maximum_bytes=maximum_bytes)
    try:
        result = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_no_duplicate_object,
            parse_constant=_reject_json_constant,
            parse_float=_finite_json_float,
        )
        _assert_well_formed_unicode(result)
        return result
    except (RecursionError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ProvisionerError("private provisioning file is malformed") from exc


def load_config(path: Path) -> dict[str, Any]:
    """Load a private local config and validate the Apps Script installer shape."""
    path = _expand_absolute_path(path, error_message="private provisioning file cannot be resolved")
    _assert_not_symlink(path)
    try:
        path = path.resolve(strict=True)
    except OSError as exc:
        raise ProvisionerError("private provisioning file cannot be resolved") from exc
    config = _read_json_file(path, maximum_bytes=MAX_CONFIG_BYTES)
    if not isinstance(config, dict):
        raise ProvisionerError("installation config must be a JSON object")
    if set(config) not in {INSTALLER_CONFIG_KEYS, CONFIG_KEYS}:
        raise ProvisionerError("installation config keys must exactly match the installer contract")
    if set(config) == INSTALLER_CONFIG_KEYS:
        config = {**config, **{key: CONFIG_DEFAULTS[key] for key in CLOUD_CONFIG_KEYS}}
    if _utf16_units(_canonical_json(config).decode("utf-8")) > MAX_CONFIG_BYTES:
        raise ProvisionerError("installation config exceeds the installer size limit")
    if not isinstance(config["ownerEmail"], str) or not _valid_email(config["ownerEmail"]):
        raise ProvisionerError("installation config ownerEmail is invalid")
    for key, expected in CONFIG_DEFAULTS.items():
        if not isinstance(config[key], type(expected)):
            raise ProvisionerError(f"installation config {key} has the wrong type")
    if config["locale"] != "en" or config["timeZone"] != "Europe/Rome":
        raise ProvisionerError("installation config locale and timeZone are unsupported")
    if not MODEL_RE.fullmatch(config["model"]) or not VERTEX_LOCATION_RE.fullmatch(config["vertexLocation"]):
        raise ProvisionerError("installation config model or vertexLocation is invalid")
    for key, limit in (("spreadsheetName", 200), ("sheetName", 100), ("labelName", 200)):
        value = config[key]
        if not value.strip(ECMASCRIPT_TRIM_CHARS) or _utf16_units(value) > limit or any(ord(char) < 32 for char in value):
            raise ProvisionerError(f"installation config {key} is invalid")
    if re.search(r"[\[\]*?:/\\]", config["sheetName"]) or config["sheetName"].casefold() == "_mycoupons messages":
        raise ProvisionerError("installation config sheetName is reserved or invalid")
    if any(not part.strip(ECMASCRIPT_TRIM_CHARS) for part in config["labelName"].split("/")):
        raise ProvisionerError("installation config labelName is invalid")
    for key in ("developerProject", "vertexProject"):
        if config[key] and not PROJECT_ID_RE.fullmatch(config[key]):
            raise ProvisionerError(f"installation config {key} is invalid")
    for key in ("vertexBillingAccount", "cloudInstallationId"):
        if not isinstance(config[key], str):
            raise ProvisionerError(f"installation config {key} has the wrong type")
    if config["vertexBillingAccount"] and not BILLING_ACCOUNT_RE.fullmatch(
        config["vertexBillingAccount"].removeprefix("billingAccounts/")
    ):
        raise ProvisionerError("installation config vertexBillingAccount is invalid")
    if config["cloudInstallationId"] and not INSTALLATION_LABEL_RE.fullmatch(config["cloudInstallationId"]):
        raise ProvisionerError("installation config cloudInstallationId is invalid")
    if not config["vertexProject"]:
        raise ProvisionerError("installation config vertexProject is required for bootstrap")
    if config["initialDate"]:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", config["initialDate"]):
            raise ProvisionerError("installation config initialDate is invalid")
        try:
            datetime.date.fromisoformat(config["initialDate"])
        except ValueError as exc:
            raise ProvisionerError("installation config initialDate is invalid") from exc
    if config["spreadsheetId"] and not re.fullmatch(r"[A-Za-z0-9_-]+", config["spreadsheetId"]):
        raise ProvisionerError("installation config spreadsheetId is invalid")
    return config


def validate_cloud_config(config: Mapping[str, Any]) -> None:
    """Require the explicit, immutable settings needed for Cloud mutation."""
    developer_project = config.get("developerProject")
    vertex_project = config.get("vertexProject")
    billing_account = config.get("vertexBillingAccount")
    installation_label = config.get("cloudInstallationId")
    if not all(isinstance(value, str) for value in (developer_project, vertex_project, billing_account, installation_label)):
        raise ProvisionerError("installation config Cloud settings are malformed")
    if not PROJECT_ID_RE.fullmatch(developer_project) or not PROJECT_ID_RE.fullmatch(vertex_project):
        raise ProvisionerError("installation config requires both Cloud project IDs")
    if developer_project == vertex_project:
        raise ProvisionerError("installation config Cloud project IDs must be distinct")
    if not BILLING_ACCOUNT_RE.fullmatch(billing_account.removeprefix("billingAccounts/")):
        raise ProvisionerError("installation config requires a selected Vertex billing account")
    if not INSTALLATION_LABEL_RE.fullmatch(installation_label):
        raise ProvisionerError("installation config requires a Cloud installation identity")


def config_digest(config: Mapping[str, Any]) -> str:
    return _sha256(_canonical_json(dict(config)))


def _legacy_installer_config_digest(config: Mapping[str, Any]) -> str:
    """Reconstruct the v1 config identity before local Cloud defaults existed."""
    return _sha256(_canonical_json({key: config[key] for key in INSTALLER_CONFIG_KEYS}))


def _precloud_config_digest(config: Mapping[str, Any]) -> str:
    """Identify the installation before its one allowed Cloud-only upgrade."""
    precloud = dict(config)
    precloud.update({key: CONFIG_DEFAULTS[key] for key in CLOUD_CONFIG_KEYS})
    return config_digest(precloud)


def _empty_developer_precloud_config_digest(config: Mapping[str, Any]) -> str:
    """Support the initial assignment of a developer project during Cloud upgrade."""
    precloud = dict(config)
    precloud.update({key: CONFIG_DEFAULTS[key] for key in CLOUD_CONFIG_KEYS})
    precloud["developerProject"] = CONFIG_DEFAULTS["developerProject"]
    return config_digest(precloud)


def _write_private_atomic(path: Path, content: bytes) -> None:
    _assert_private_directory(path.parent)
    _assert_not_symlink(path)
    descriptor = -1
    temporary_path: Path | None = None
    try:
        descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
        temporary_path = Path(temporary_name)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            descriptor = -1
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        os.chmod(path, 0o600)
        directory_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except OSError as exc:
        raise ProvisionerError("unable to atomically persist provisioning state") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink(missing_ok=True)


def _load_or_create_identity_key(state_dir: Path) -> bytes:
    key_path = state_dir / IDENTITY_FILE
    if key_path.exists():
        key = _read_private_bytes(key_path, maximum_bytes=32)
        if len(key) != 32:
            raise ProvisionerError("installation identity key is malformed")
        return key
    _write_private_atomic(key_path, secrets.token_bytes(32))
    return _read_private_bytes(key_path, maximum_bytes=32)


def _identity_proof(key: bytes, state: Mapping[str, Any]) -> str:
    signed = _canonical_json(
        {
            "version": state["version"],
            "installationId": state["installationId"],
            "configDigest": state["configDigest"],
            "phase": state["phase"],
            "bundleDigest": state["bundleDigest"],
            "cloud": state["cloud"],
            "appsScript": state["appsScript"],
            "bootstrap": state["bootstrap"],
        }
    )
    return hmac.new(key, b"mycoupons-state\0" + signed, hashlib.sha256).hexdigest()


def _identity_proof_v1(key: bytes, state: Mapping[str, Any]) -> str:
    """Verify the already-published state format before its local-only migration."""
    signed = _canonical_json(
        {
            "version": state["version"],
            "installationId": state["installationId"],
            "configDigest": state["configDigest"],
            "phase": state["phase"],
            "bundleDigest": state["bundleDigest"],
        }
    )
    return hmac.new(key, b"mycoupons-state\0" + signed, hashlib.sha256).hexdigest()


def _validate_common_state_identity(state: Mapping[str, Any]) -> None:
    if not isinstance(state["installationId"], str) or not isinstance(state["configDigest"], str) or not isinstance(state["identityProof"], str):
        raise ProvisionerError("installation state has invalid identity fields")
    try:
        uuid.UUID(state["installationId"])
    except ValueError as exc:
        raise ProvisionerError("installation state has invalid identity") from exc
    if not re.fullmatch(r"[0-9a-f]{64}", state["configDigest"]) or not re.fullmatch(r"[0-9a-f]{64}", state["identityProof"]):
        raise ProvisionerError("installation state has invalid digests")
    if state["bundleDigest"] is not None and (
        not isinstance(state["bundleDigest"], str) or not re.fullmatch(r"[0-9a-f]{64}", state["bundleDigest"])
    ):
        raise ProvisionerError("installation state has invalid bundle digest")


def _validate_state(state: Any, key: bytes) -> dict[str, Any]:
    if not isinstance(state, dict) or set(state) != {
        "version", "installationId", "configDigest", "identityProof", "phase", "bundleDigest", "cloud", "appsScript", "bootstrap"
    }:
        raise ProvisionerError("installation state has an unsupported shape")
    if state["version"] != STATE_VERSION or not isinstance(state["phase"], str) or state["phase"] not in {
        "initialized", "bundle-validated", "cloud-projects-reconciled", "cloud-ready", "apps-script-creation-intent", "apps-script-creation-pending", "apps-script-creation-posted", "apps-script-association-required", "apps-script-adoption-pending", "apps-script-version-creation-intent", "apps-script-version-creation-pending", "apps-script-version-ready", "apps-script-deployment-creation-pending", "apps-script-ready", "bootstrap-complete"
    }:
        raise ProvisionerError("installation state has an unsupported version or phase")
    _validate_common_state_identity(state)
    cloud = state["cloud"]
    if not isinstance(cloud, dict) or set(cloud) != CLOUD_ROLES:
        raise ProvisionerError("installation state has an invalid Cloud resource map")
    for role, record in cloud.items():
        if record is None:
            continue
        if not isinstance(record, dict) or set(record) != {"projectId", "projectNumber", "provenance"}:
            raise ProvisionerError("installation state has an invalid Cloud project record")
        if not isinstance(record["projectId"], str) or not PROJECT_ID_RE.fullmatch(record["projectId"]):
            raise ProvisionerError("installation state has an invalid Cloud project record")
        if record["provenance"] == "creating" and record["projectNumber"] is None:
            continue
        if (
            not isinstance(record["projectNumber"], str)
            or not PROJECT_NUMBER_RE.fullmatch(record["projectNumber"])
            or record["provenance"] not in {"created", "adopted"}
        ):
            raise ProvisionerError("installation state has an invalid Cloud project record")
    apps_script = state["appsScript"]
    if not isinstance(apps_script, dict) or set(apps_script) != {"scriptId", "provenance", "bundleDigest", "versionNumber", "deploymentId"}:
        raise ProvisionerError("installation state has an invalid Apps Script record")
    if apps_script["scriptId"] is None:
        if any(value is not None for value in apps_script.values()):
            raise ProvisionerError("installation state has an invalid Apps Script record")
    elif not isinstance(apps_script["scriptId"], str) or not APPS_SCRIPT_ID_RE.fullmatch(apps_script["scriptId"]) or apps_script["provenance"] not in {"created", "adopted"}:
        raise ProvisionerError("installation state has an invalid Apps Script record")
    elif all(apps_script[key] is None for key in ("bundleDigest", "versionNumber", "deploymentId")):
        if (apps_script["provenance"] == "created" and state["phase"] != "apps-script-association-required") or (
            apps_script["provenance"] == "adopted" and state["phase"] != "apps-script-adoption-pending"
        ):
            raise ProvisionerError("installation state has an invalid Apps Script record")
    elif not isinstance(apps_script["bundleDigest"], str) or not re.fullmatch(r"[0-9a-f]{64}", apps_script["bundleDigest"]):
        raise ProvisionerError("installation state has an invalid Apps Script record")
    elif apps_script["versionNumber"] is None:
        if apps_script["deploymentId"] is not None and (
            not isinstance(apps_script["deploymentId"], str)
            or not APPS_SCRIPT_ID_RE.fullmatch(apps_script["deploymentId"])
            or state["phase"] != "apps-script-version-creation-pending"
        ):
            raise ProvisionerError("installation state has an invalid Apps Script record")
        if state["phase"] not in {"apps-script-version-creation-intent", "apps-script-version-creation-pending"}:
            raise ProvisionerError("installation state has an invalid Apps Script record")
    elif (
        not isinstance(apps_script["versionNumber"], int)
        or apps_script["versionNumber"] < 1
        or apps_script["deploymentId"] is not None
        and (not isinstance(apps_script["deploymentId"], str) or not APPS_SCRIPT_ID_RE.fullmatch(apps_script["deploymentId"]))
        or state["phase"] not in {"apps-script-version-creation-pending", "apps-script-version-ready", "apps-script-deployment-creation-pending", "apps-script-ready", "bootstrap-complete"}
        or state["phase"] in {"apps-script-ready", "bootstrap-complete"}
        and apps_script["deploymentId"] is None
    ):
        raise ProvisionerError("installation state has an invalid Apps Script record")
    bootstrap = state["bootstrap"]
    if not isinstance(bootstrap, dict) or set(bootstrap) != {"secretVersion", "status"}:
        raise ProvisionerError("installation state has an invalid bootstrap record")
    if isinstance(bootstrap["status"], str) and bootstrap["status"] in {"not-started", "staging"} and bootstrap["secretVersion"] is None:
        pass
    elif isinstance(bootstrap["status"], str) and bootstrap["status"] in {"replacement-staging", "staged", "verified", "complete"} and isinstance(bootstrap["secretVersion"], str) and re.fullmatch(
        rf"projects/(?:{PROJECT_ID_RE.pattern[1:-1]}|{PROJECT_NUMBER_RE.pattern[1:-1]})/secrets/{BOOTSTRAP_SECRET_NAME}/versions/[1-9][0-9]*", bootstrap["secretVersion"]
    ):
        pass
    else:
        raise ProvisionerError("installation state has an invalid bootstrap record")
    expected = _identity_proof(key, state)
    if not hmac.compare_digest(state["identityProof"], expected):
        raise ProvisionerError("installation state is not bound to this local installation")
    return state


def _migrate_v1_state(state: Any, key: bytes) -> dict[str, Any]:
    expected_keys = {"version", "installationId", "configDigest", "identityProof", "phase", "bundleDigest"}
    if not isinstance(state, dict) or set(state) != expected_keys or state.get("version") != 1:
        raise ProvisionerError("installation state has an unsupported shape")
    if state.get("phase") not in {"initialized", "bundle-validated"}:
        raise ProvisionerError("installation state has an unsupported version or phase")
    _validate_common_state_identity(state)
    if not hmac.compare_digest(state["identityProof"], _identity_proof_v1(key, state)):
        raise ProvisionerError("installation state is not bound to this local installation")
    migrated = dict(state)
    migrated["version"] = 2
    migrated["cloud"] = {"developer": None, "vertex": None}
    migrated["identityProof"] = _identity_proof_v2(key, migrated)
    return _migrate_v2_state(migrated, key)


def _identity_proof_v2(key: bytes, state: Mapping[str, Any]) -> str:
    signed = _canonical_json(
        {key_name: value for key_name, value in state.items() if key_name != "identityProof"}
    )
    return hmac.new(key, b"mycoupons-state\0" + signed, hashlib.sha256).hexdigest()


def _migrate_v2_state(state: Any, key: bytes) -> dict[str, Any]:
    expected_keys = {"version", "installationId", "configDigest", "identityProof", "phase", "bundleDigest", "cloud"}
    if not isinstance(state, dict) or set(state) != expected_keys or state.get("version") != 2:
        raise ProvisionerError("installation state has an unsupported shape")
    _validate_common_state_identity(state)
    if not hmac.compare_digest(state.get("identityProof", ""), _identity_proof_v2(key, state)):
        raise ProvisionerError("installation state is not bound to this local installation")
    migrated = dict(state)
    migrated["version"] = STATE_VERSION
    # Version 2 considered the Cloud setup ready before deployment required
    # Cloud Resource Manager and Drive.  Make an upgraded ready state repeat
    # service reconciliation before it can deploy.
    if migrated["phase"] == "cloud-ready":
        migrated["phase"] = "cloud-projects-reconciled"
    migrated["appsScript"] = {"scriptId": None, "provenance": None, "bundleDigest": None, "versionNumber": None, "deploymentId": None}
    migrated["bootstrap"] = {"secretVersion": None, "status": "not-started"}
    migrated["identityProof"] = _identity_proof(key, migrated)
    return _validate_state(migrated, key)


def _load_state_locked(state_dir: Path, key: bytes) -> dict[str, Any]:
    state_path = state_dir / STATE_FILE
    state = _read_json_file(state_path, maximum_bytes=4096)
    if isinstance(state, dict) and state.get("version") == 1:
        state = _migrate_v1_state(state, key)
        _write_private_atomic(state_path, _canonical_json(state))
        return state
    if isinstance(state, dict) and state.get("version") == 2:
        state = _migrate_v2_state(state, key)
        _write_private_atomic(state_path, _canonical_json(state))
        return state
    return _validate_state(state, key)


@dataclasses.dataclass
class InstallationLock:
    """Advisory non-blocking process lock for a single installation directory."""

    state_dir: Path
    descriptor: int | None = None

    def __enter__(self) -> "InstallationLock":
        import fcntl

        _assert_private_directory(self.state_dir)
        lock_path = self.state_dir / LOCK_FILE
        _assert_not_symlink(lock_path)
        try:
            self.descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            lock_stat = os.fstat(self.descriptor)
            if not stat.S_ISREG(lock_stat.st_mode) or not _is_private_mode(lock_stat.st_mode, 0o600):
                raise ProvisionerError("installation lock must be a regular mode-0600 file")
            os.fchmod(self.descriptor, 0o600)
            fcntl.flock(self.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except ProvisionerError:
            if self.descriptor is not None:
                os.close(self.descriptor)
                self.descriptor = None
            raise
        except (OSError, BlockingIOError) as exc:
            if self.descriptor is not None:
                os.close(self.descriptor)
                self.descriptor = None
            raise ProvisionerError("another provisioning operation is already running") from exc
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        if self.descriptor is not None:
            import fcntl

            fcntl.flock(self.descriptor, fcntl.LOCK_UN)
            os.close(self.descriptor)
            self.descriptor = None


def initialize_state_with_status(state_dir: Path, config: Mapping[str, Any]) -> tuple[dict[str, Any], bool]:
    """Create or resume state and report whether it existed under the installation lock."""
    state_dir = ensure_state_dir(state_dir)
    with InstallationLock(state_dir):
        resumed = (state_dir / STATE_FILE).exists()
        return _initialize_state_locked(state_dir, config), resumed


def initialize_state(state_dir: Path, config: Mapping[str, Any]) -> dict[str, Any]:
    """Create resumable state or safely resume the exact same installation."""
    state, _resumed = initialize_state_with_status(state_dir, config)
    return state


def _initialize_state_locked(state_dir: Path, config: Mapping[str, Any]) -> dict[str, Any]:
    digest = config_digest(config)
    key = _load_or_create_identity_key(state_dir)
    state_path = state_dir / STATE_FILE
    if state_path.exists():
        state = _load_state_locked(state_dir, key)
        if state["configDigest"] != digest:
            if (
                state["cloud"] == {"developer": None, "vertex": None}
                and state["phase"] in {"initialized", "bundle-validated"}
                and state["configDigest"] in {
                    _legacy_installer_config_digest(config),
                    _precloud_config_digest(config),
                    _empty_developer_precloud_config_digest(config),
                }
            ):
                state = dict(state)
                state["configDigest"] = digest
                state = _persist_state_locked(state_dir, state, key)
            else:
                raise ProvisionerError("installation config does not match persisted installation identity")
        return state
    installation_id = str(uuid.uuid4())
    state: dict[str, Any] = {
        "version": STATE_VERSION,
        "installationId": installation_id,
        "configDigest": digest,
        "phase": "initialized",
        "bundleDigest": None,
        "cloud": {"developer": None, "vertex": None},
        "appsScript": {"scriptId": None, "provenance": None, "bundleDigest": None, "versionNumber": None, "deploymentId": None},
        "bootstrap": {"secretVersion": None, "status": "not-started"},
    }
    state["identityProof"] = _identity_proof(key, state)
    _write_private_atomic(state_path, _canonical_json(state))
    return state


def mark_bundle_validated(state_dir: Path, config: Mapping[str, Any], digest: str) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise ProvisionerError("bundle digest is invalid")
    state_dir = ensure_state_dir(state_dir)
    with InstallationLock(state_dir):
        return _mark_bundle_validated_locked(state_dir, config, digest)


def _mark_bundle_validated_locked(state_dir: Path, config: Mapping[str, Any], digest: str) -> dict[str, Any]:
    key = _load_or_create_identity_key(state_dir)
    state_path = state_dir / STATE_FILE
    state = _load_state_locked(state_dir, key)
    if state["configDigest"] != config_digest(config):
        raise ProvisionerError("installation config does not match persisted installation identity")
    state = dict(state)
    if state["phase"] == "initialized":
        state["phase"] = "bundle-validated"
    state["bundleDigest"] = digest
    state["identityProof"] = _identity_proof(key, state)
    _write_private_atomic(state_path, _canonical_json(state))
    return state


def _persist_state_locked(state_dir: Path, state: Mapping[str, Any], key: bytes) -> dict[str, Any]:
    """Sign and atomically persist one already-validated installation state."""
    updated = dict(state)
    updated["identityProof"] = _identity_proof(key, updated)
    _validate_state(updated, key)
    _write_private_atomic(state_dir / STATE_FILE, _canonical_json(updated))
    return updated


def validate_and_mark_bundle(state_dir: Path, config: Mapping[str, Any], source_dir: Path) -> tuple[str, dict[str, Any]]:
    """Validate and persist one source digest under a single installation lock."""
    state_dir = ensure_state_dir(state_dir)
    with InstallationLock(state_dir):
        digest = validate_bundle(source_dir)
        _initialize_state_locked(state_dir, config)
        return digest, _mark_bundle_validated_locked(state_dir, config, digest)


def _iter_bundle_files(source_dir: Path) -> Iterable[Path]:
    if not source_dir.is_dir() or source_dir.is_symlink():
        raise ProvisionerError("Apps Script source directory must be a real directory")

    def traversal_error(error: OSError) -> None:
        raise ProvisionerError("Apps Script source bundle cannot be traversed") from error

    bundle_files: list[Path] = []
    bundle_path_bytes = 0
    for directory_name, directory_names, file_names in os.walk(
        source_dir,
        topdown=True,
        followlinks=False,
        onerror=traversal_error,
    ):
        directory = Path(directory_name)
        for child_name in directory_names:
            if (directory / child_name).is_symlink():
                raise ProvisionerError("Apps Script source bundle cannot contain symlinks")
        for child_name in file_names:
            path = directory / child_name
            if path.is_symlink():
                raise ProvisionerError("Apps Script source bundle cannot contain symlinks")
            if path.is_file() and path.suffix == ".js":
                raise ProvisionerError("Apps Script source bundle cannot contain .js files")
            if path.is_file() and path.suffix == ".json" and path.relative_to(source_dir).as_posix() != "appsscript.json":
                raise ProvisionerError("Apps Script source bundle can contain only appsscript.json")
            if path.is_file() and path.suffix in {".gs", ".html", ".json"}:
                try:
                    relative_bytes = path.relative_to(source_dir).as_posix().encode("utf-8")
                except UnicodeEncodeError as exc:
                    raise ProvisionerError("Apps Script source bundle path is not valid Unicode") from exc
                if len(bundle_files) >= MAX_BUNDLE_FILES or bundle_path_bytes + len(relative_bytes) > MAX_BUNDLE_PATH_BYTES:
                    raise ProvisionerError("Apps Script source bundle has too many files or path bytes")
                bundle_files.append(path)
                bundle_path_bytes += len(relative_bytes)
    yield from sorted(bundle_files)


def _has_bootstrap_entry_point(content: bytes, entry_point: str) -> bool:
    """Recognize the required top-level declaration without accepting comments or strings."""
    try:
        source = content.decode("utf-8")
    except UnicodeDecodeError:
        return False
    visible: list[str] = []
    index = 0
    quote: str | None = None
    block_comment = False
    line_comment = False
    while index < len(source):
        char = source[index]
        next_char = source[index + 1] if index + 1 < len(source) else ""
        if line_comment:
            if char == "\n":
                line_comment = False
                visible.append(char)
            else:
                visible.append(" ")
        elif block_comment:
            if char == "*" and next_char == "/":
                block_comment = False
                visible.extend((" ", " "))
                index += 1
            else:
                visible.append("\n" if char == "\n" else " ")
        elif quote is not None:
            if char == "\\":
                visible.extend((" ", " "))
                index += 1
            elif char == quote:
                quote = None
                visible.append(" ")
            else:
                visible.append("\n" if char == "\n" else " ")
        elif char == "/" and next_char == "/":
            line_comment = True
            visible.extend((" ", " "))
            index += 1
        elif char == "/" and next_char == "*":
            block_comment = True
            visible.extend((" ", " "))
            index += 1
        elif char in {"'", '"', "`"}:
            quote = char
            visible.append(" ")
        else:
            visible.append(char)
        index += 1
    visible_source = "".join(visible)
    visible_source = re.sub(
        r"(^|[({[=,:;!?&|+\-*%^~<>][ \t]*)/(?:\\.|\[[^\]\n]*(?:\\.[^\]\n]*)*\]|[^/\n])+/[a-z]*",
        lambda match: match.group(1) + " " * (len(match.group()) - len(match.group(1))),
        visible_source,
        flags=re.MULTILINE,
    )
    visible_source = re.sub(
        r"(\b(?:if|while|for|catch)\s*\([^\n]*?\)\s*|\b(?:do|else|return|throw|void|typeof|delete|yield|await|new|of|in|instanceof|extends)\s*|}\s*)/(?:\\.|\[[^\]\n]*(?:\\.[^\]\n]*)*\]|[^/\n])+/[a-z]*",
        lambda match: match.group(1) + " " * (len(match.group()) - len(match.group(1))),
        visible_source,
    )
    for match in re.finditer(rf"(?m)^[ \t]*function[ \t]+{re.escape(entry_point)}[ \t]*\(", visible_source):
        prefix = visible_source[: match.start()]
        preceding = prefix.rstrip()
        if prefix.count("{") == prefix.count("}") and (not preceding or preceding[-1] in ";}"):
            return True
    return False


def _bundle_digest(captured: Mapping[str, bytes]) -> str:
    digest = hashlib.sha256()
    for name, content in sorted(captured.items()):
        try:
            relative = name.encode("utf-8")
        except UnicodeEncodeError as exc:
            raise ProvisionerError("Apps Script source bundle path is not valid Unicode") from exc
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def _open_bundle_root(source_dir: Path) -> int:
    descriptor = -1
    try:
        descriptor = os.open(source_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK)
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            raise ProvisionerError("Apps Script source directory must be a real directory")
        return descriptor
    except OSError as exc:
        if descriptor >= 0:
            os.close(descriptor)
        raise ProvisionerError("Apps Script source directory cannot be read") from exc
    except Exception:
        if descriptor >= 0:
            os.close(descriptor)
        raise


def _read_bundle_file(root_descriptor: int, relative: Path, *, maximum_bytes: int) -> bytes:
    descriptor = -1
    directories: list[int] = []
    try:
        if relative.is_absolute() or not relative.parts or any(part in {"", ".", ".."} for part in relative.parts):
            raise ProvisionerError("Apps Script source bundle path is invalid")
        parent_descriptor = root_descriptor
        for component in relative.parts[:-1]:
            directory_descriptor = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK,
                dir_fd=parent_descriptor,
            )
            if not stat.S_ISDIR(os.fstat(directory_descriptor).st_mode):
                os.close(directory_descriptor)
                raise ProvisionerError("Apps Script source bundle cannot contain non-directory paths")
            directories.append(directory_descriptor)
            parent_descriptor = directory_descriptor
        descriptor = os.open(
            relative.name,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=parent_descriptor,
        )
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ProvisionerError("Apps Script source bundle cannot contain non-regular files")
        if before.st_size > maximum_bytes:
            raise ProvisionerError("Apps Script source bundle file is too large")
        with os.fdopen(descriptor, "rb", closefd=True) as handle:
            descriptor = -1
            content = handle.read(maximum_bytes + 1)
            after = os.fstat(handle.fileno())
    except OSError as exc:
        raise ProvisionerError("Apps Script source bundle cannot be read") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        for directory_descriptor in reversed(directories):
            os.close(directory_descriptor)
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
        after.st_dev,
        after.st_ino,
        after.st_size,
        after.st_mtime_ns,
    ):
        raise ProvisionerError("Apps Script source bundle changed during validation")
    if len(content) > maximum_bytes:
        raise ProvisionerError("Apps Script source bundle file is too large")
    return content


def validate_bundle(source_dir: Path) -> str:
    """Validate the checked-in Apps Script manifest and hash all source files."""
    source_dir = _expand_absolute_path(source_dir, error_message="Apps Script source directory cannot be resolved")
    _assert_not_symlink(source_dir)
    try:
        source_dir = source_dir.resolve(strict=True)
    except OSError as exc:
        raise ProvisionerError("Apps Script source directory cannot be resolved") from exc
    captured: dict[str, bytes] = {}
    captured_bytes = 0
    root_descriptor = _open_bundle_root(source_dir)
    try:
        for path in _iter_bundle_files(source_dir):
            relative_path = path.relative_to(source_dir)
            relative = relative_path.as_posix()
            remaining_bytes = MAX_BUNDLE_TOTAL_BYTES - captured_bytes
            if remaining_bytes < 0:
                raise ProvisionerError("Apps Script source bundle is too large")
            content = _read_bundle_file(root_descriptor, relative_path, maximum_bytes=min(MAX_BUNDLE_FILE_BYTES, remaining_bytes))
            try:
                content.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise ProvisionerError("Apps Script source bundle must be valid UTF-8") from exc
            captured[relative] = content
            captured_bytes += len(content)
        verified_paths: set[str] = set()
        verified_bytes = 0
        for path in _iter_bundle_files(source_dir):
            relative_path = path.relative_to(source_dir)
            relative = relative_path.as_posix()
            expected = captured.get(relative)
            if expected is None:
                raise ProvisionerError("Apps Script source bundle changed during validation")
            remaining_bytes = MAX_BUNDLE_TOTAL_BYTES - verified_bytes
            if remaining_bytes < 0:
                raise ProvisionerError("Apps Script source bundle is too large")
            current = _read_bundle_file(root_descriptor, relative_path, maximum_bytes=min(MAX_BUNDLE_FILE_BYTES, remaining_bytes))
            if current != expected:
                raise ProvisionerError("Apps Script source bundle changed during validation")
            verified_paths.add(relative)
            verified_bytes += len(current)
        if verified_paths != set(captured) or verified_bytes != captured_bytes:
            raise ProvisionerError("Apps Script source bundle changed during validation")
    finally:
        os.close(root_descriptor)
    manifest_content = captured.get("appsscript.json")
    if manifest_content is None:
        raise ProvisionerError("Apps Script manifest is missing")
    try:
        manifest = json.loads(
            manifest_content.decode("utf-8"),
            object_pairs_hook=_no_duplicate_object,
            parse_constant=_reject_json_constant,
            parse_float=_finite_json_float,
        )
        _assert_well_formed_unicode(manifest)
    except (OSError, RecursionError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise ProvisionerError("Apps Script manifest is malformed") from exc
    expected_scopes = {
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/script.external_request",
        "https://www.googleapis.com/auth/script.scriptapp",
        "https://www.googleapis.com/auth/script.send_mail",
        "https://www.googleapis.com/auth/userinfo.email",
        "https://www.googleapis.com/auth/cloud-platform",
    }
    if not isinstance(manifest, dict) or manifest.get("timeZone") != "Europe/Rome" or manifest.get("runtimeVersion") != "V8":
        raise ProvisionerError("Apps Script manifest runtime contract is invalid")
    scopes = manifest.get("oauthScopes")
    if not isinstance(scopes, list) or len(scopes) != len(expected_scopes) or not all(isinstance(scope, str) for scope in scopes):
        raise ProvisionerError("Apps Script manifest OAuth scope contract is invalid")
    whitelist = manifest.get("urlFetchWhitelist")
    if "webapp" in manifest or "addOns" in manifest or whitelist is not None or manifest.get("executionApi") != {"access": "MYSELF"} or set(scopes) != expected_scopes:
        raise ProvisionerError("Apps Script manifest access or OAuth scope contract is invalid")
    dependencies = manifest.get("dependencies")
    if not isinstance(dependencies, dict) or set(dependencies) != {"enabledAdvancedServices"}:
        raise ProvisionerError("Apps Script manifest dependency contract is invalid")
    services = dependencies.get("enabledAdvancedServices") if isinstance(dependencies, dict) else None
    expected_services = {("Gmail", "gmail", "v1"), ("Drive", "drive", "v3")}
    if not isinstance(services, list) or len(services) != len(expected_services) or not all(
        isinstance(service, dict) and all(isinstance(service.get(key), str) for key in ("userSymbol", "serviceId", "version"))
        for service in services
    ):
        raise ProvisionerError("Apps Script manifest service contract is invalid")
    found_services = {(service["userSymbol"], service["serviceId"], service["version"]) for service in services}
    if found_services != expected_services:
        raise ProvisionerError("Apps Script manifest service contract is invalid")
    installer_source = captured.get("Installer.gs")
    if installer_source is None or not _has_bootstrap_entry_point(installer_source, "bootstrapFromSecret"):
        raise ProvisionerError("Apps Script source bundle is missing the bootstrapFromSecret entry point")
    if not _has_bootstrap_entry_point(installer_source, "verifyBootstrapExecutionAccess"):
        raise ProvisionerError("Apps Script source bundle is missing the verifyBootstrapExecutionAccess entry point")
    return _bundle_digest(captured)


def oauth_authorization_command() -> str:
    """Return the Cloud SDK login command used by the active-account preflight."""
    return "gcloud auth login --update-adc"


def discover_tools(names: Sequence[str] = ("gcloud", "clasp")) -> dict[str, str | None]:
    """Discover executables without running them, returning canonical paths."""
    result: dict[str, str | None] = {}
    for name in names:
        candidate = shutil.which(name)
        if candidate is None:
            result[name] = None
            continue
        path = Path(candidate)
        try:
            resolved = path.resolve(strict=True)
            mode = resolved.stat().st_mode
        except OSError:
            result[name] = None
            continue
        result[name] = str(resolved) if stat.S_ISREG(mode) and os.access(resolved, os.X_OK) else None
    return result


def _terminate_process(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        process.kill()
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass


def _gcloud_reports_project_not_found(stderr: bytes, project_id: str) -> bool:
    """Recognize only gcloud's exact absent-project forms; all else fails closed."""
    try:
        message = stderr.decode("utf-8")
    except UnicodeDecodeError:
        return False
    escaped_id = re.escape(project_id)
    return re.fullmatch(
        rf"ERROR: \(gcloud\.projects\.describe\) \[{escaped_id}\] not found\.?\s*",
        message,
        flags=re.IGNORECASE,
    ) is not None


def _gcloud_reports_bootstrap_secret_not_found(
    stderr: bytes, project_id: str, project_number: str, secret_name: str, owner: str
) -> bool:
    """Recognize only owner-pinned gcloud's exact absent-secret diagnostics."""
    try:
        message = stderr.decode("utf-8")
    except UnicodeDecodeError:
        return False
    resource = rf"projects/(?:{re.escape(project_id)}|{re.escape(project_number)})/secrets/{re.escape(secret_name)}"
    account_context = (
        rf"(?:\n| )This command is authenticated as {re.escape(owner)} which is the active account "
        r"specified by the \[core/account\] property\."
    )
    return re.fullmatch(
        rf"ERROR: \(gcloud\.secrets\.describe\) NOT_FOUND: Secret \[{resource}\] not found(?:\.{account_context}|\.?)\n?",
        message,
    ) is not None


def _run_command_output(
    command: Sequence[str], *, operation: str, absent_project: str | None = None,
    absent_secret: tuple[str, str, str, str] | None = None,
) -> bytes:
    """Run one fixed-argument command with bounded output and no diagnostics."""
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    try:
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE if absent_project is not None or absent_secret is not None else subprocess.DEVNULL,
            close_fds=True,
            start_new_session=True,
        )
        if process.stdout is None or (absent_project is not None and process.stderr is None):
            raise OSError("gcloud stdout pipe was not created")
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        if process.stderr is not None:
            selector.register(process.stderr, selectors.EVENT_READ)
        output = bytearray()
        stderr = bytearray()
        deadline = time.monotonic() + 30
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, 30)
            selected = selector.select(remaining)
            if not selected:
                continue
            stream = selected[0][0].fileobj
            if not hasattr(stream, "fileno"):
                raise OSError("gcloud stream cannot be read")
            target = output if stream is process.stdout else stderr
            chunk = os.read(stream.fileno(), min(8192, MAX_COMMAND_OUTPUT_BYTES + 1 - len(target)))
            if not chunk:
                selector.unregister(stream)
                continue
            target.extend(chunk)
            if len(target) > MAX_COMMAND_OUTPUT_BYTES:
                raise ProvisionerError(f"{operation} returned unexpected output")
        completed_returncode = process.wait(timeout=max(0, deadline - time.monotonic()))
    except (OSError, subprocess.TimeoutExpired) as exc:
        if process is not None:
            _terminate_process(process)
        raise ProvisionerError(f"{operation} could not run") from exc
    except ProvisionerError:
        if process is not None:
            _terminate_process(process)
        raise
    finally:
        if selector is not None:
            selector.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()
        if process is not None and process.stderr is not None:
            process.stderr.close()
    if completed_returncode != 0:
        if absent_project is not None and _gcloud_reports_project_not_found(bytes(stderr), absent_project):
            raise ProjectNotFound("Cloud project was not found")
        if absent_secret is not None and _gcloud_reports_bootstrap_secret_not_found(bytes(stderr), *absent_secret):
            raise BootstrapSecretNotFound("bootstrap secret was not found")
        raise ProvisionerError(f"{operation} was rejected")
    return bytes(output)


def _run_json(
    command: Sequence[str], *, operation: str = "read-only authentication preflight", absent_project: str | None = None,
    absent_secret: tuple[str, str, str, str] | None = None,
) -> Any:
    output = _run_command_output(command, operation=operation, absent_project=absent_project, absent_secret=absent_secret)
    try:
        response = json.loads(
            output.decode("utf-8"),
            object_pairs_hook=_no_duplicate_object,
            parse_constant=_reject_json_constant,
            parse_float=_finite_json_float,
        )
        _assert_well_formed_unicode(response)
        return response
    except (RecursionError, json.JSONDecodeError, ValueError) as exc:
        raise ProvisionerError(f"{operation} returned unexpected output") from exc


def _run_success(command: Sequence[str], *, operation: str) -> None:
    """Run a mutation whose output must never become an operator diagnostic."""
    _run_command_output(command, operation=operation)


def authenticated_identity_preflight(expected_owner: str, project_id: str) -> dict[str, bool]:
    """Prove active gcloud identity and project access with harmless JSON reads.

    Raw command output is never returned, because gcloud diagnostics may expose
    local paths or authorization details.
    """
    if not _valid_email(expected_owner) or not PROJECT_ID_RE.fullmatch(project_id):
        raise ProvisionerError("preflight identity or project is invalid")
    gcloud = discover_tools(("gcloud",))["gcloud"]
    if gcloud is None:
        raise ProvisionerError("gcloud is required for authentication preflight")
    account = _require_active_gcloud_owner(gcloud, expected_owner)
    project = _cloud_json(
        (gcloud, "projects", "describe", project_id, "--format=json", "--quiet"),
        account=account,
        operation="read-only authentication preflight",
        absent_project=project_id,
    )
    if not isinstance(project, dict) or project.get("projectId") != project_id:
        raise ProvisionerError("read-only project identity response is malformed or mismatched")
    return {"ownerMatched": True, "projectReadable": True}


def _require_active_gcloud_owner(gcloud: str, expected_owner: str) -> str:
    accounts = _run_json((gcloud, "auth", "list", "--format=json", "--quiet"))
    if not isinstance(accounts, list) or any(
        not isinstance(entry, dict) or not isinstance(entry.get("account"), str) or not isinstance(entry.get("status"), str)
        for entry in accounts
    ):
        raise ProvisionerError("read-only authentication preflight returned unexpected accounts")
    active = [entry for entry in accounts if entry["status"] == "ACTIVE"]
    if len(active) != 1 or active[0]["account"].lower() != expected_owner.lower():
        raise ProvisionerError("active gcloud identity is absent, ambiguous, or does not match ownerEmail")
    return active[0]["account"]


def _billing_account_id(value: str) -> str:
    identifier = value.removeprefix("billingAccounts/")
    if not BILLING_ACCOUNT_RE.fullmatch(identifier):
        raise ProvisionerError("installation config vertexBillingAccount is invalid")
    return identifier


def _canonical_billing_account(value: str) -> str:
    return f"billingAccounts/{_billing_account_id(value)}"


def _cloud_json(command: Sequence[str], *, account: str, operation: str, absent_project: str | None = None) -> Any:
    return _run_json((*command, f"--account={account}"), operation=operation, absent_project=absent_project)


def _cloud_success(command: Sequence[str], *, account: str, operation: str) -> None:
    _run_success((*command, f"--account={account}"), operation=operation)


def _project_details(response: Any, *, project_id: str, installation_label: str, role: str) -> dict[str, str]:
    if not isinstance(response, dict):
        raise ProvisionerError("Cloud project inspection returned an invalid project")
    number = response.get("projectNumber")
    labels = response.get("labels")
    if (
        response.get("projectId") != project_id
        or response.get("lifecycleState") != "ACTIVE"
        or not isinstance(number, str)
        or not PROJECT_NUMBER_RE.fullmatch(number)
        or not isinstance(labels, dict)
        or any(not isinstance(key, str) or not isinstance(value, str) for key, value in labels.items())
        or labels.get(CLOUD_INSTALLATION_LABEL) != installation_label
        or labels.get(CLOUD_ROLE_LABEL) != role
    ):
        raise ProvisionerError("Cloud project identity, lifecycle, or ownership labels are not eligible")
    return {"projectId": project_id, "projectNumber": number}


def _describe_project(gcloud: str, project_id: str, account: str) -> Any:
    return _cloud_json(
        (gcloud, "projects", "describe", project_id, "--format=json", "--quiet"),
        account=account,
        operation="Cloud project inspection",
        absent_project=project_id,
    )


def _describe_project_after_create(gcloud: str, project_id: str, account: str) -> Any:
    last_error: ProvisionerError | None = None
    for delay in (0.0, 0.1, 0.3):
        if delay:
            time.sleep(delay)
        try:
            return _describe_project(gcloud, project_id, account)
        except ProvisionerError as exc:
            last_error = exc
    raise ProvisionerError("new Cloud project could not be verified") from last_error


def _verify_project_owner(gcloud: str, project_id: str, expected_owner: str) -> None:
    policy = _cloud_json(
        (gcloud, "projects", "get-iam-policy", project_id, "--format=json", "--quiet"),
        account=expected_owner,
        operation="Cloud project ownership inspection",
    )
    bindings = policy.get("bindings") if isinstance(policy, dict) else None
    expected_member = f"user:{expected_owner.lower()}"
    if not isinstance(bindings, list):
        raise ProvisionerError("Cloud project ownership inspection returned an invalid policy")
    for binding in bindings:
        if not isinstance(binding, dict) or binding.get("role") != "roles/owner" or "condition" in binding:
            continue
        members = binding.get("members")
        if isinstance(members, list) and all(isinstance(member, str) for member in members):
            if expected_member in {member.lower() for member in members}:
                return
    raise ProvisionerError("configured owner lacks an unconditional owner binding on a Cloud project")


def _reconcile_project(
    gcloud: str,
    *,
    project_id: str,
    installation_label: str,
    role: str,
    expected_owner: str,
    persisted: Any,
    persist_creation_intent: Callable[[], None],
) -> dict[str, str]:
    """Create one labelled project or adopt only an already-labelled owner project."""
    if role not in CLOUD_ROLES:
        raise ProvisionerError("Cloud project role is invalid")
    created = False
    try:
        response = _describe_project(gcloud, project_id, expected_owner)
    except ProjectNotFound:
        if persisted is None:
            persist_creation_intent()
            persisted = {"projectId": project_id, "projectNumber": None, "provenance": "creating"}
        if not isinstance(persisted, dict) or persisted.get("projectId") != project_id or persisted.get("provenance") != "creating":
            raise ProvisionerError("Cloud project cannot be created without a persisted creation intent")
        _cloud_success(
            (
                gcloud,
                "projects",
                "create",
                project_id,
                f"--name=MyCoupons {role.title()} Runtime",
                f"--labels={CLOUD_INSTALLATION_LABEL}={installation_label},{CLOUD_ROLE_LABEL}={role}",
                "--quiet",
            ),
            account=expected_owner,
            operation="Cloud project creation",
        )
        created = True
        response = _describe_project_after_create(gcloud, project_id, expected_owner)
    details = _project_details(response, project_id=project_id, installation_label=installation_label, role=role)
    if persisted is not None:
        if not isinstance(persisted, dict) or persisted.get("projectId") != project_id:
            raise ProvisionerError("persisted Cloud project identity does not match the configured project")
        provenance = persisted.get("provenance")
        if provenance == "creating":
            provenance = "created"
        elif persisted.get("projectNumber") != details["projectNumber"] or provenance not in {"created", "adopted"}:
            raise ProvisionerError("persisted Cloud project provenance is invalid")
    else:
        provenance = "created" if created else "adopted"
    _verify_project_owner(gcloud, project_id, expected_owner)
    return {**details, "provenance": provenance}


def _revalidate_project_before_mutation(
    gcloud: str, *, project_id: str, installation_label: str, role: str, expected_owner: str, persisted: Mapping[str, Any]
) -> None:
    """Close the read-to-write gap for every non-creation Cloud mutation."""
    details = _project_details(
        _describe_project(gcloud, project_id, expected_owner), project_id=project_id, installation_label=installation_label, role=role
    )
    if persisted.get("projectId") != project_id or persisted.get("projectNumber") != details["projectNumber"]:
        raise ProvisionerError("persisted Cloud project identity does not match the configured project")
    _verify_project_owner(gcloud, project_id, expected_owner)


def _billing_info(gcloud: str, project_id: str, account: str) -> dict[str, Any]:
    response = _cloud_json(
        (gcloud, "billing", "projects", "describe", project_id, "--format=json", "--quiet"),
        account=account,
        operation="Cloud project billing inspection",
    )
    if not isinstance(response, dict) or response.get("projectId") != project_id or not isinstance(response.get("billingEnabled"), bool):
        raise ProvisionerError("Cloud project billing inspection returned invalid data")
    account = response.get("billingAccountName", "")
    if not isinstance(account, str) or (account and not account.startswith("billingAccounts/")):
        raise ProvisionerError("Cloud project billing inspection returned invalid data")
    return {"billingEnabled": response["billingEnabled"], "billingAccountName": account}


def _require_unbilled_developer_project(gcloud: str, project_id: str, account: str) -> None:
    billing = _billing_info(gcloud, project_id, account)
    if billing["billingEnabled"] or billing["billingAccountName"]:
        raise ProvisionerError("Gemini Developer API project must remain unbilled")


def _reconcile_vertex_billing(
    gcloud: str,
    project_id: str,
    billing_account: str,
    *,
    installation_label: str,
    expected_owner: str,
    persisted: Mapping[str, Any],
) -> None:
    selected_id = _billing_account_id(billing_account)
    selected = f"billingAccounts/{selected_id}"
    account = _cloud_json(
        (gcloud, "billing", "accounts", "describe", selected_id, "--format=json", "--quiet"),
        account=expected_owner,
        operation="selected billing account inspection",
    )
    master = account.get("masterBillingAccount", "") if isinstance(account, dict) else None
    if (
        not isinstance(account, dict)
        or account.get("name") != selected
        or account.get("open") is not True
        or not isinstance(master, str)
        or master
    ):
        raise ProvisionerError("selected billing account is not open or could not be verified")
    current = _billing_info(gcloud, project_id, expected_owner)
    if current["billingEnabled"] and current["billingAccountName"] == selected:
        return
    if current["billingEnabled"] or current["billingAccountName"]:
        raise ProvisionerError("Vertex fallback project is linked to a different billing account")
    _revalidate_project_before_mutation(
        gcloud,
        project_id=project_id,
        installation_label=installation_label,
        role="vertex",
        expected_owner=expected_owner,
        persisted=persisted,
    )
    _cloud_success(
        (gcloud, "billing", "projects", "link", project_id, f"--billing-account={selected_id}", "--quiet"),
        account=expected_owner,
        operation="Vertex fallback billing linkage",
    )
    confirmed = _billing_info(gcloud, project_id, expected_owner)
    if not confirmed["billingEnabled"] or confirmed["billingAccountName"] != selected:
        raise ProvisionerError("Vertex fallback billing linkage could not be verified")


def _service_enabled(gcloud: str, project_id: str, service: str, account: str) -> bool:
    response = _cloud_json(
        (
            gcloud,
            "services",
            "list",
            "--enabled",
            f"--filter=config.name={service}",
            "--format=json(config.name)",
            "--quiet",
            f"--project={project_id}",
        ),
        account=account,
        operation="Cloud API service inspection",
    )
    if not isinstance(response, list) or any(not isinstance(entry, dict) or not isinstance(entry.get("config"), dict) for entry in response):
        raise ProvisionerError("Cloud API service inspection returned invalid data")
    names = [entry["config"].get("name") for entry in response]
    if any(not isinstance(name, str) for name in names) or any(name != service for name in names):
        raise ProvisionerError("Cloud API service inspection returned unexpected resources")
    if len(names) > 1:
        raise ProvisionerError("Cloud API service inspection returned unexpected resources")
    return bool(names)


def _ensure_service(
    gcloud: str,
    project_id: str,
    service: str,
    *,
    installation_label: str,
    role: str,
    expected_owner: str,
    persisted: Mapping[str, Any],
) -> None:
    if _service_enabled(gcloud, project_id, service, expected_owner):
        return
    _revalidate_project_before_mutation(
        gcloud,
        project_id=project_id,
        installation_label=installation_label,
        role=role,
        expected_owner=expected_owner,
        persisted=persisted,
    )
    _cloud_success(
        (gcloud, "services", "enable", service, f"--project={project_id}", "--quiet"),
        account=expected_owner,
        operation="Cloud API service enablement",
    )
    for delay in (0.0, 0.1, 0.3):
        if delay:
            time.sleep(delay)
        if _service_enabled(gcloud, project_id, service, expected_owner):
            return
    raise ProvisionerError("Cloud API service enablement could not be verified")


def provision_cloud(state_dir: Path, config: Mapping[str, Any]) -> dict[str, Any]:
    """Safely reconcile the two Cloud projects for one signed installation state."""
    validate_cloud_config(config)
    state_dir = ensure_state_dir(state_dir)
    with InstallationLock(state_dir):
        state = _initialize_state_locked(state_dir, config)
        if state["bundleDigest"] is None or state["phase"] == "initialized":
            raise ProvisionerError("validate the Apps Script source bundle before Cloud provisioning")
        key = _load_or_create_identity_key(state_dir)
        app_script_pending = state["phase"] in {
            "apps-script-creation-intent",
            "apps-script-creation-pending",
            "apps-script-creation-posted",
            "apps-script-association-required",
            "apps-script-adoption-pending",
            "apps-script-version-creation-intent",
            "apps-script-version-creation-pending",
            "apps-script-version-ready",
            "apps-script-deployment-creation-pending",
            "apps-script-ready",
        }
        gcloud = discover_tools(("gcloud",))["gcloud"]
        if gcloud is None:
            raise ProvisionerError("gcloud is required for Cloud provisioning")
        owner_account = _require_active_gcloud_owner(gcloud, config["ownerEmail"])
        state = dict(state)
        cloud = dict(state["cloud"])
        for role, project_id in (("developer", config["developerProject"]),):
            def persist_developer_creation_intent() -> None:
                nonlocal state, cloud
                cloud["developer"] = {"projectId": project_id, "projectNumber": None, "provenance": "creating"}
                state["cloud"] = cloud
                state = _persist_state_locked(state_dir, state, key)

            record = _reconcile_project(
                gcloud,
                project_id=project_id,
                installation_label=config["cloudInstallationId"],
                role=role,
                expected_owner=owner_account,
                persisted=cloud[role],
                persist_creation_intent=persist_developer_creation_intent,
            )
            if cloud[role] != record:
                cloud[role] = record
                state["cloud"] = cloud
                state = _persist_state_locked(state_dir, state, key)
        _require_unbilled_developer_project(gcloud, config["developerProject"], owner_account)
        for role, project_id in (("vertex", config["vertexProject"]),):
            def persist_vertex_creation_intent() -> None:
                nonlocal state, cloud
                cloud["vertex"] = {"projectId": project_id, "projectNumber": None, "provenance": "creating"}
                state["cloud"] = cloud
                state = _persist_state_locked(state_dir, state, key)

            record = _reconcile_project(
                gcloud,
                project_id=project_id,
                installation_label=config["cloudInstallationId"],
                role=role,
                expected_owner=owner_account,
                persisted=cloud[role],
                persist_creation_intent=persist_vertex_creation_intent,
            )
            if cloud[role] != record:
                cloud[role] = record
                state["cloud"] = cloud
                state = _persist_state_locked(state_dir, state, key)
        state["phase"] = (
            "bootstrap-complete"
            if state["bootstrap"]["status"] == "complete"
            else state["phase"]
            if app_script_pending
            else "cloud-projects-reconciled"
        )
        state["cloud"] = cloud
        state = _persist_state_locked(state_dir, state, key)
        _reconcile_vertex_billing(
            gcloud,
            config["vertexProject"],
            config["vertexBillingAccount"],
            installation_label=config["cloudInstallationId"],
            expected_owner=owner_account,
            persisted=cloud["vertex"],
        )
        for role, project_id, services in (
            ("developer", config["developerProject"], DEVELOPER_SERVICES),
            ("vertex", config["vertexProject"], VERTEX_SERVICES),
        ):
            for service in services:
                _ensure_service(
                    gcloud,
                    project_id,
                    service,
                    installation_label=config["cloudInstallationId"],
                    role=role,
                    expected_owner=owner_account,
                    persisted=cloud[role],
                )
        state["phase"] = (
            "bootstrap-complete"
            if state["bootstrap"]["status"] == "complete"
            else state["phase"]
            if app_script_pending
            else "cloud-ready"
        )
        return _persist_state_locked(state_dir, state, key)


def _read_private_oauth_token(path: Path) -> str:
    """Read a refreshed isolated clasp token without returning its contents."""
    auth = _read_json_file(path, maximum_bytes=256 * 1024)
    if not isinstance(auth, dict):
        raise ProvisionerError("isolated Apps Script authorization is malformed")
    tokens = auth.get("tokens")
    default = tokens.get("default") if isinstance(tokens, dict) else None
    token = default.get("access_token") if isinstance(default, dict) else None
    if not isinstance(token, str) or not token or "\r" in token or "\n" in token:
        raise ProvisionerError("isolated Apps Script authorization has no usable access token")
    return token


def _apps_script_json(
    access_token: str,
    method: str,
    resource: str,
    body: Any | None = None,
    *,
    maximum_bytes: int = MAX_COMMAND_OUTPUT_BYTES,
) -> Any:
    """Make one bounded Apps Script or Drive API request without surfacing data."""
    if not access_token or not resource.startswith("https://"):
        raise ProvisionerError("Apps Script API request is invalid")
    content = None if body is None else _canonical_json(body)
    request = urllib.request.Request(
        resource,
        data=content,
        method=method,
        headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json", **({"Content-Type": "application/json"} if content else {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw = response.read(maximum_bytes + 1)
    except urllib.error.HTTPError as exc:
        raise AppsScriptHttpError(exc.code) from exc
    except (OSError, http.client.HTTPException) as exc:
        raise ProvisionerError("Apps Script API request was rejected") from exc
    if len(raw) > maximum_bytes:
        raise ProvisionerError("Apps Script API returned unexpected output")
    try:
        result = json.loads(raw.decode("utf-8"), object_pairs_hook=_no_duplicate_object, parse_constant=_reject_json_constant, parse_float=_finite_json_float)
        _assert_well_formed_unicode(result)
        return result
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as exc:
        raise ProvisionerError("Apps Script API returned unexpected output") from exc


def _require_isolated_clasp_owner(auth_path: Path, owner_email: str) -> str:
    auth_path = _expand_absolute_path(auth_path, error_message="isolated Apps Script authorization cannot be resolved")
    _assert_not_symlink(auth_path)
    try:
        auth_path = auth_path.resolve(strict=True)
    except OSError as exc:
        raise ProvisionerError("isolated Apps Script authorization cannot be resolved") from exc
    _assert_outside_worktree(auth_path)
    try:
        auth_stat = auth_path.stat()
    except OSError as exc:
        raise ProvisionerError("isolated Apps Script authorization cannot be resolved") from exc
    if not stat.S_ISREG(auth_stat.st_mode) or not _is_private_mode(auth_stat.st_mode, 0o600):
        raise ProvisionerError("isolated Apps Script authorization must be a regular mode-0600 file")
    clasp = discover_tools(("clasp",))["clasp"]
    if clasp is None:
        raise ProvisionerError("clasp is required to refresh isolated Apps Script authorization")
    identity = _run_json((clasp, "-A", str(auth_path), "--json", "show-authorized-user"), operation="isolated Apps Script authorization inspection")
    if not isinstance(identity, dict) or identity.get("loggedIn") is not True or not isinstance(identity.get("email"), str):
        raise ProvisionerError("isolated Apps Script authorization identity is malformed")
    if identity["email"].lower() != owner_email.lower():
        raise ProvisionerError("isolated Apps Script authorization does not match ownerEmail")
    return _read_private_oauth_token(auth_path)


def _apps_script_file_name(relative: str) -> tuple[str, str]:
    if relative == "appsscript.json":
        return "appsscript", "JSON"
    # Apps Script reports SERVER_JS without the source extension.  Accepting
    # .js here would make a verified read-back indistinguishable from .gs.
    suffixes = {".gs": "SERVER_JS", ".html": "HTML"}
    suffix = Path(relative).suffix
    if suffix not in suffixes or any(part in {"", ".", ".."} for part in Path(relative).parts):
        raise ProvisionerError("Apps Script source bundle contains an unsupported deployment path")
    return relative[: -len(suffix)], suffixes[suffix]


def _deployment_bundle(source_dir: Path) -> tuple[str, list[dict[str, str]]]:
    expected_digest = validate_bundle(source_dir)
    source_dir = _expand_absolute_path(source_dir, error_message="Apps Script source directory cannot be resolved")
    root_descriptor = _open_bundle_root(source_dir)
    captured: dict[str, bytes] = {}
    captured_bytes = 0
    try:
        for path in _iter_bundle_files(source_dir):
            relative_path = path.relative_to(source_dir)
            remaining_bytes = MAX_BUNDLE_TOTAL_BYTES - captured_bytes
            if remaining_bytes < 0:
                raise ProvisionerError("Apps Script source bundle changed during deployment capture")
            content = _read_bundle_file(root_descriptor, relative_path, maximum_bytes=min(MAX_BUNDLE_FILE_BYTES, remaining_bytes))
            captured[relative_path.as_posix()] = content
            captured_bytes += len(content)
    finally:
        os.close(root_descriptor)
    if _bundle_digest(captured) != expected_digest:
        raise ProvisionerError("Apps Script source bundle changed during deployment capture")
    files = []
    for relative, content in sorted(captured.items()):
        name, file_type = _apps_script_file_name(relative)
        files.append({"name": name, "type": file_type, "source": content.decode("utf-8")})
    return expected_digest, files


def _assert_private_owner_script(metadata: Any, owner_email: str, expected_id: str | None = None) -> str:
    if not isinstance(metadata, dict):
        raise ProvisionerError("Apps Script project inspection returned invalid data")
    script_id = metadata.get("id") or metadata.get("scriptId")
    owners = metadata.get("owners")
    permissions = metadata.get("permissions")
    owner_address = (
        owners[0].get("emailAddress")
        if isinstance(owners, list) and len(owners) == 1 and isinstance(owners[0], dict)
        else None
    )
    permission_address = (
        permissions[0].get("emailAddress")
        if isinstance(permissions, list) and len(permissions) == 1 and isinstance(permissions[0], dict)
        else None
    )
    if (
        not isinstance(script_id, str)
        or not APPS_SCRIPT_ID_RE.fullmatch(script_id)
        or expected_id is not None and script_id != expected_id
        or metadata.get("mimeType") != "application/vnd.google-apps.script"
        or not isinstance(owner_address, str)
        or owner_address.lower() != owner_email.lower()
        or not isinstance(permission_address, str)
        or permissions[0].get("type") != "user"
        or permissions[0].get("role") != "owner"
        or permission_address.lower() != owner_email.lower()
    ):
        raise ProvisionerError("Apps Script project is not private and owner-only")
    return script_id


def _drive_script_metadata(access_token: str, script_id: str) -> Any:
    if not APPS_SCRIPT_ID_RE.fullmatch(script_id):
        raise ProvisionerError("Apps Script project identity is invalid")
    fields = "id,mimeType,owners(emailAddress),permissions(type,role,emailAddress)"
    return _apps_script_json(access_token, "GET", f"https://www.googleapis.com/drive/v3/files/{script_id}?fields={fields}")


def _find_or_create_apps_script(access_token: str, owner_email: str, state: Mapping[str, Any], persist_creation_intent: Callable[[], None], persist_creation_posted: Callable[[], None], persist_created_script: Callable[[str], None], clear_creation_intent: Callable[[], None]) -> tuple[str, str]:
    record = state["appsScript"]
    if record["scriptId"] is not None:
        script_id = _assert_private_owner_script(_drive_script_metadata(access_token, record["scriptId"]), owner_email, record["scriptId"])
        return script_id, record["provenance"]
    query = "mimeType = 'application/vnd.google-apps.script' and name = 'MyCoupons' and trashed = false"
    fields = "nextPageToken,files(id,mimeType,owners(emailAddress),permissions(type,role,emailAddress))"
    files = _apps_script_list(
        access_token,
        "https://www.googleapis.com/drive/v3/files?" + urllib.parse.urlencode({"corpora": "user", "q": query, "fields": fields}),
        "files",
    )
    if len(files) > 1:
        raise ProvisionerError("Apps Script project adoption is ambiguous")
    if len(files) == 1:
        return _assert_private_owner_script(files[0], owner_email), "created" if state["phase"] in {"apps-script-creation-intent", "apps-script-creation-pending", "apps-script-creation-posted"} else "adopted"
    if state["phase"] == "apps-script-creation-intent":
        # The pre-send intent is safe to clear: it is persisted before the
        # may-have-been-sent state, so a process exit here cannot duplicate a
        # project on retry.
        clear_creation_intent()
    elif state["phase"] in {"apps-script-creation-pending", "apps-script-creation-posted"}:
        raise ProvisionerError("Apps Script project creation is pending Drive visibility")
    persist_creation_intent()
    # Persist an ambiguous outcome before the non-idempotent request can reach
    # Apps Script.  A retry now waits for Drive reconciliation instead of
    # issuing another create request.
    persist_creation_posted()
    try:
        created = _apps_script_json(access_token, "POST", "https://script.googleapis.com/v1/projects", {"title": APPS_SCRIPT_TITLE})
    except AppsScriptHttpError as exc:
        if 400 <= exc.status < 500:
            clear_creation_intent()
        raise
    except ProvisionerError:
        # The request was already recorded as potentially accepted.
        raise
    script_id = created.get("scriptId") if isinstance(created, dict) else None
    if not isinstance(script_id, str) or not APPS_SCRIPT_ID_RE.fullmatch(script_id):
        raise ProvisionerError("Apps Script project creation returned invalid data")
    # A successful create response is the durable creation boundary.  Record
    # its opaque ID before any Drive metadata request so retries cannot create
    # a duplicate after an interrupted verification.
    persist_created_script(script_id)
    return script_id, "created"


def _remote_bundle_digest(access_token: str, script_id: str, version_number: int | None = None) -> str:
    suffix = "" if version_number is None else f"?versionNumber={version_number}"
    content = _apps_script_json(
        access_token,
        "GET",
        f"https://script.googleapis.com/v1/projects/{script_id}/content{suffix}",
        maximum_bytes=MAX_APPS_SCRIPT_SOURCE_RESPONSE_BYTES,
    )
    files = content.get("files") if isinstance(content, dict) else None
    if not isinstance(files, list):
        raise ProvisionerError("Apps Script source inspection returned invalid data")
    captured: dict[str, bytes] = {}
    for entry in files:
        if not isinstance(entry, dict) or not isinstance(entry.get("name"), str) or not isinstance(entry.get("type"), str) or not isinstance(entry.get("source"), str):
            raise ProvisionerError("Apps Script source inspection returned invalid data")
        if entry["type"] == "JSON" and entry["name"] == "appsscript":
            relative = "appsscript.json"
        elif entry["type"] == "SERVER_JS":
            relative = entry["name"] + ".gs"
        elif entry["type"] == "HTML":
            relative = entry["name"] + ".html"
        else:
            raise ProvisionerError("Apps Script source inspection returned an unsupported file")
        if relative in captured:
            raise ProvisionerError("Apps Script source inspection returned duplicate files")
        captured[relative] = entry["source"].encode("utf-8")
    return _bundle_digest(captured)


def _validate_owner_only_deployment(deployment: Any, script_id: str, version_number: int | None = None) -> tuple[str, int]:
    if not isinstance(deployment, dict):
        raise ProvisionerError("Apps Script deployment inspection returned invalid data")
    deployment_id = deployment.get("deploymentId")
    config = deployment.get("deploymentConfig")
    entry_points = deployment.get("entryPoints")
    if (
        not isinstance(deployment_id, str)
        or not APPS_SCRIPT_ID_RE.fullmatch(deployment_id)
        or not isinstance(config, dict)
        or config.get("scriptId") != script_id
        or not isinstance(config.get("versionNumber"), int)
        or config["versionNumber"] < 1
        or config.get("manifestFileName") != "appsscript"
        or version_number is not None and config["versionNumber"] != version_number
        or not isinstance(entry_points, list)
        or len(entry_points) != 1
        or not isinstance(entry_points[0], dict)
        or entry_points[0].get("entryPointType") != "EXECUTION_API"
        or not isinstance(entry_points[0].get("executionApi"), dict)
        or not isinstance(entry_points[0]["executionApi"].get("entryPointConfig"), dict)
        or entry_points[0]["executionApi"]["entryPointConfig"].get("access") != "MYSELF"
    ):
        raise ProvisionerError("Apps Script deployment is not an owner-only API executable")
    return deployment_id, config["versionNumber"]


def _validate_expected_owner_only_deployment(
    deployment: Any, script_id: str, deployment_id: str, version_number: int, description: str
) -> tuple[str, int]:
    """Validate a deployment response is for the exact resource requested."""
    validated_id, validated_version = _validate_owner_only_deployment(deployment, script_id, version_number)
    if validated_id != deployment_id or deployment["deploymentConfig"].get("description") != description:
        raise ProvisionerError("Apps Script deployment response returned a different deployment")
    return validated_id, validated_version


def _verify_persisted_owner_only_deployment(
    access_token: str, script_id: str, digest: str, version_number: int, deployment_id: str
) -> tuple[str, int]:
    """Read and verify a durable deployment identity before source changes."""
    marker = f"MyCoupons owner-only {digest}"
    deployment = _apps_script_json(access_token, "GET", f"https://script.googleapis.com/v1/projects/{script_id}/deployments/{deployment_id}")
    verified = _validate_expected_owner_only_deployment(deployment, script_id, deployment_id, version_number, marker)
    if _remote_bundle_digest(access_token, script_id, version_number) != digest:
        raise ProvisionerError("Apps Script version content does not match the verified source bundle")
    return verified


def _is_automatic_head_deployment(deployment: Any, script_id: str) -> bool:
    """Recognize only the mutable automatic HEAD deployment Apps Script creates."""
    if not isinstance(deployment, dict):
        return False
    deployment_id = deployment.get("deploymentId")
    config = deployment.get("deploymentConfig")
    if not (
        isinstance(deployment_id, str)
        and deployment_id != "HEAD"
        and APPS_SCRIPT_ID_RE.fullmatch(deployment_id) is not None
        and isinstance(config, dict)
        and set(config) == {"scriptId", "manifestFileName"}
        and config.get("scriptId") == script_id
        and config.get("manifestFileName") == "appsscript"
    ):
        return False
    return "entryPoints" not in deployment or deployment["entryPoints"] == [
        {
            "entryPointType": "EXECUTION_API",
            "executionApi": {"entryPointConfig": {"access": "MYSELF"}},
        }
    ]


def _apps_script_list(access_token: str, resource: str, key: str) -> list[Any]:
    result: list[Any] = []
    token = ""
    seen_tokens: set[str] = set()
    for _page in range(1000):
        separator = "&" if "?" in resource else "?"
        response = _apps_script_json(access_token, "GET", resource if not token else resource + separator + urllib.parse.urlencode({"pageToken": token}))
        entries = response.get(key, []) if isinstance(response, dict) else None
        next_token = response.get("nextPageToken", "") if isinstance(response, dict) else None
        if not isinstance(entries, list) or not isinstance(next_token, str) or len(next_token) > 4096:
            raise ProvisionerError("Apps Script resource discovery returned invalid data")
        result.extend(entries)
        if not next_token:
            return result
        if next_token in seen_tokens:
            raise ProvisionerError("Apps Script resource discovery returned a repeated page token")
        seen_tokens.add(next_token)
        token = next_token
    raise ProvisionerError("Apps Script resource discovery exceeded its page limit")


def _deployment_list(access_token: str, script_id: str) -> list[Any]:
    deployments = _apps_script_list(access_token, f"https://script.googleapis.com/v1/projects/{script_id}/deployments", "deployments")
    executable_count = 0
    automatic_head_count = 0
    for deployment in deployments:
        # Every script has an automatic mutable HEAD deployment.  It has no
        # immutable version number and cannot satisfy the deployment contract.
        if _is_automatic_head_deployment(deployment, script_id):
            automatic_head_count += 1
            continue
        _validate_owner_only_deployment(deployment, script_id)
        executable_count += 1
    if automatic_head_count > 1 or executable_count > 1:
        raise ProvisionerError("Apps Script deployment recovery is ambiguous")
    return deployments


def _recover_bundle_version(access_token: str, script_id: str, digest: str) -> int | None:
    description = f"MyCoupons owner-only {digest}"
    versions = _apps_script_list(access_token, f"https://script.googleapis.com/v1/projects/{script_id}/versions", "versions")
    candidates = [item for item in versions if isinstance(item, dict) and item.get("description") == description]
    if not candidates:
        return None
    numbers: list[int] = []
    for candidate in candidates:
        number = candidate.get("versionNumber")
        if type(number) is not int or number < 1:
            raise ProvisionerError("Apps Script version recovery returned invalid data")
        if number in numbers:
            raise ProvisionerError("Apps Script version recovery is ambiguous")
        if _remote_bundle_digest(access_token, script_id, number) != digest:
            raise ProvisionerError("Apps Script version recovery content does not match the verified source bundle")
        numbers.append(number)
    # A prior interrupted request can leave equivalent immutable versions.
    # They are interchangeable only after every candidate has independently
    # read back as the exact reviewed bundle; choose the oldest deterministically
    # and persist that identity before a deployment mutation.
    return min(numbers)


def _create_bundle_version(access_token: str, script_id: str, digest: str) -> int:
    description = f"MyCoupons owner-only {digest}"
    created = _apps_script_json(access_token, "POST", f"https://script.googleapis.com/v1/projects/{script_id}/versions", {"description": description})
    number = created.get("versionNumber") if isinstance(created, dict) else None
    if type(number) is not int or number < 1 or created.get("description") != description:
        raise ProvisionerError("Apps Script version creation returned invalid data")
    return number


def _ensure_owner_only_deployment(
    access_token: str,
    script_id: str,
    digest: str,
    version: int,
    persisted_deployment_id: str | None = None,
    *,
    creation_pending: bool = False,
    persist_creation_pending: Callable[[], None] | None = None,
    clear_creation_pending: Callable[[], None] | None = None,
    persist_created_identity: Callable[[str], None] | None = None,
) -> tuple[str, int]:
    marker = f"MyCoupons owner-only {digest}"
    if persisted_deployment_id is not None:
        # deploy_apps_script verifies this durable identity against its prior
        # immutable version before it can replace source. Re-read the exact
        # resource for its owner-only shape, but do not replace that exact-ID
        # operation with a potentially delayed collection listing.
        persisted = _apps_script_json(access_token, "GET", f"https://script.googleapis.com/v1/projects/{script_id}/deployments/{persisted_deployment_id}")
        verified_id, _ = _validate_owner_only_deployment(persisted, script_id)
        if verified_id != persisted_deployment_id:
            raise ProvisionerError("Apps Script persisted deployment recovery is ambiguous")
        matching = None
    else:
        deployments = _deployment_list(access_token, script_id)
        matching = [deployment for deployment in deployments if isinstance(deployment, dict) and not _is_automatic_head_deployment(deployment, script_id) and isinstance(deployment.get("deploymentConfig"), dict) and deployment["deploymentConfig"].get("description") == marker]
        if not matching and not creation_pending:
            matching = [deployment for deployment in deployments if not _is_automatic_head_deployment(deployment, script_id)]
        if len(matching) > 1:
            raise ProvisionerError("Apps Script deployment recovery is ambiguous")
    if persisted_deployment_id is not None or len(matching) == 1:
        if persisted_deployment_id is not None:
            deployment_id = persisted_deployment_id
        else:
            deployment_id = matching[0].get("deploymentId")
            if not isinstance(deployment_id, str) or not APPS_SCRIPT_ID_RE.fullmatch(deployment_id):
                raise ProvisionerError("Apps Script deployment inspection returned invalid data")
        updated = _apps_script_json(
            access_token,
            "PUT",
            f"https://script.googleapis.com/v1/projects/{script_id}/deployments/{deployment_id}",
            {
                "deploymentConfig": {
                    "scriptId": script_id,
                    "versionNumber": version,
                    "description": marker,
                    "manifestFileName": "appsscript",
                }
            },
        )
        _validate_expected_owner_only_deployment(updated, script_id, deployment_id, version, marker)
        verified = _apps_script_json(access_token, "GET", f"https://script.googleapis.com/v1/projects/{script_id}/deployments/{deployment_id}")
        return _validate_expected_owner_only_deployment(verified, script_id, deployment_id, version, marker)
    if creation_pending:
        raise ProvisionerError("Apps Script deployment creation is pending recovery")
    if persist_creation_pending is None:
        raise ProvisionerError("Apps Script deployment creation cannot be persisted")
    persist_creation_pending()
    try:
        created = _apps_script_json(
            access_token,
            "POST",
            f"https://script.googleapis.com/v1/projects/{script_id}/deployments",
            {"versionNumber": version, "description": marker, "manifestFileName": "appsscript"},
        )
    except AppsScriptHttpError as exc:
        if 400 <= exc.status < 500 and clear_creation_pending is not None:
            clear_creation_pending()
        raise
    deployment_id, _ = _validate_owner_only_deployment(created, script_id, version)
    _validate_expected_owner_only_deployment(created, script_id, deployment_id, version, marker)
    if persist_created_identity is None:
        raise ProvisionerError("Apps Script deployment identity cannot be persisted")
    persist_created_identity(deployment_id)
    verified = _apps_script_json(access_token, "GET", f"https://script.googleapis.com/v1/projects/{script_id}/deployments/{deployment_id}")
    return _validate_expected_owner_only_deployment(verified, script_id, deployment_id, version, marker)


def _validate_bootstrap_payload(path: Path, config: Mapping[str, Any]) -> bytes:
    path = _expand_absolute_path(path, error_message="bootstrap payload cannot be resolved")
    _assert_not_symlink(path)
    try:
        path = path.resolve(strict=True)
    except OSError as exc:
        raise ProvisionerError("bootstrap payload cannot be resolved") from exc
    _assert_outside_worktree(path)
    payload = _read_json_file(path, maximum_bytes=64 * 1024)
    if not isinstance(payload, dict) or set(payload) != {"version", "config", "geminiApiKey"} or type(payload.get("version")) is not int or payload["version"] != 1:
        raise ProvisionerError("bootstrap payload is malformed")
    expected_config = {key: config[key] for key in INSTALLER_CONFIG_KEYS}
    if not isinstance(payload["config"], dict) or _canonical_json(payload["config"]) != _canonical_json(expected_config):
        raise ProvisionerError("bootstrap payload config does not match the installation")
    key = payload["geminiApiKey"]
    if not isinstance(key, str) or _utf16_units(key) > 512 or not re.fullmatch(r"AIza[A-Za-z0-9_-]{20,}", key):
        raise ProvisionerError("bootstrap payload is malformed")
    canonical = _canonical_json(payload)
    if _utf16_units(canonical.decode("utf-8")) > 12000:
        raise ProvisionerError("bootstrap payload is malformed")
    return canonical


def _require_cloud_ready_state(state: Mapping[str, Any], config: Mapping[str, Any]) -> Mapping[str, Any]:
    vertex = state["cloud"].get("vertex") if isinstance(state.get("cloud"), dict) else None
    if state["phase"] not in {"cloud-ready", "apps-script-creation-intent", "apps-script-creation-pending", "apps-script-creation-posted", "apps-script-association-required", "apps-script-adoption-pending", "apps-script-version-creation-intent", "apps-script-version-creation-pending", "apps-script-version-ready", "apps-script-deployment-creation-pending", "apps-script-ready", "bootstrap-complete"} or not isinstance(vertex, dict):
        raise ProvisionerError("Cloud provisioning must complete before Apps Script deployment")
    if vertex.get("projectId") != config["vertexProject"] or vertex.get("provenance") not in {"created", "adopted"}:
        raise ProvisionerError("persisted Vertex project identity does not match the installation")
    return vertex


def _secret_describe(gcloud: str, project_id: str, project_number: str, owner: str) -> Any:
    return _run_json(
        (gcloud, "secrets", "describe", BOOTSTRAP_SECRET_NAME, f"--project={project_id}", "--format=json", "--quiet", f"--account={owner}"),
        operation="bootstrap secret inspection",
        absent_secret=(project_id, project_number, BOOTSTRAP_SECRET_NAME, owner),
    )


def _secret_access_policy(gcloud: str, project_id: str, owner: str) -> Any:
    return _cloud_json(
        (gcloud, "secrets", "get-iam-policy", BOOTSTRAP_SECRET_NAME, f"--project={project_id}", "--format=json", "--quiet"),
        account=owner,
        operation="bootstrap secret access inspection",
    )


def _assert_owner_only_secret_accessor(policy: Any, owner: str, *, require_owner: bool) -> None:
    bindings = policy.get("bindings", []) if isinstance(policy, dict) else None
    expected_member = f"user:{owner.lower()}"
    if not isinstance(bindings, list):
        raise ProvisionerError("bootstrap secret access inspection returned invalid data")
    owner_found = False
    for binding in bindings:
        if not isinstance(binding, dict):
            raise ProvisionerError("bootstrap secret access inspection returned invalid data")
        members = binding.get("members")
        if "condition" in binding or not isinstance(members, list) or any(not isinstance(member, str) for member in members):
            raise ProvisionerError("bootstrap secret has unsafe access bindings")
        if any(member.lower() != expected_member for member in members):
            raise ProvisionerError("bootstrap secret has unsafe access bindings")
        owner_found = owner_found or (
            binding.get("role") == "roles/secretmanager.secretAccessor" and expected_member in {member.lower() for member in members}
        )
    if require_owner and not owner_found:
        raise ProvisionerError("bootstrap secret access grant could not be verified")


def _secret_resource_pattern(project_id: str, project_number: str) -> str:
    return rf"projects/(?:{re.escape(project_id)}|{re.escape(project_number)})/secrets/{BOOTSTRAP_SECRET_NAME}"


def _role_can_access_secret_versions(gcloud: str, role: str, owner: str) -> bool:
    if not isinstance(role, str) or not role:
        raise ProvisionerError("Cloud project access inspection returned invalid data")
    described = _cloud_json(
        (gcloud, "iam", "roles", "describe", role, "--format=json", "--quiet"),
        account=owner,
        operation="Cloud role access inspection",
    )
    permissions = described.get("includedPermissions") if isinstance(described, dict) else None
    if not isinstance(permissions, list) or any(not isinstance(permission, str) for permission in permissions):
        raise ProvisionerError("Cloud role access inspection returned invalid data")
    return bool(
        {"secretmanager.versions.access", "secretmanager.secrets.setIamPolicy", "resourcemanager.projects.setIamPolicy", "resourcemanager.folders.setIamPolicy", "resourcemanager.organizations.setIamPolicy", "iam.roles.update", "*"}
        & set(permissions)
    )


def _assert_owner_only_project_secret_accessor(gcloud: str, policy: Any, owner: str) -> None:
    """Reject foreign effective secret-version access on one Cloud resource."""
    bindings = policy.get("bindings", []) if isinstance(policy, dict) else None
    expected_member = f"user:{owner.lower()}"
    if not isinstance(bindings, list):
        raise ProvisionerError("Cloud project access inspection returned invalid data")
    for binding in bindings:
        if not isinstance(binding, dict):
            raise ProvisionerError("Cloud project access inspection returned invalid data")
        members = binding.get("members")
        if not isinstance(members, list) or any(not isinstance(member, str) for member in members):
            raise ProvisionerError("Cloud project has unsafe inherited secret access")
        foreign_member = any(member.lower() != expected_member for member in members)
        if "condition" in binding:
            if _role_can_access_secret_versions(gcloud, binding.get("role"), owner):
                raise ProvisionerError("Cloud project has unsafe inherited secret access")
            continue
        if foreign_member and _role_can_access_secret_versions(gcloud, binding.get("role"), owner):
            raise ProvisionerError("Cloud project has unsafe inherited secret access")


def _project_ancestor_secret_policies(gcloud: str, project_id: str, project_number: str, owner: str) -> list[Any]:
    """Return every policy inherited by a project, rejecting unknown ancestry."""
    ancestors = _cloud_json(
        (gcloud, "projects", "get-ancestors", project_id, "--format=json", "--quiet"),
        account=owner,
        operation="Cloud resource hierarchy inspection",
    )
    if not isinstance(ancestors, list):
        raise ProvisionerError("Cloud resource hierarchy inspection returned invalid data")
    seen: set[tuple[str, str]] = set()
    project_seen = False
    policies: list[Any] = []
    for ancestor in ancestors:
        if not isinstance(ancestor, dict):
            raise ProvisionerError("Cloud resource hierarchy inspection returned invalid data")
        resource_type = ancestor.get("type")
        resource_id = ancestor.get("id")
        if not isinstance(resource_type, str) or not isinstance(resource_id, str) or (resource_type, resource_id) in seen:
            raise ProvisionerError("Cloud resource hierarchy inspection returned invalid data")
        seen.add((resource_type, resource_id))
        if resource_type == "project" and resource_id in {project_id, project_number}:
            if project_seen:
                raise ProvisionerError("Cloud resource hierarchy inspection returned invalid data")
            project_seen = True
            command = (gcloud, "projects", "get-iam-policy", project_id, "--format=json", "--quiet")
        elif resource_type == "folder" and PROJECT_NUMBER_RE.fullmatch(resource_id):
            command = (gcloud, "resource-manager", "folders", "get-iam-policy", resource_id, "--format=json", "--quiet")
        elif resource_type == "organization" and PROJECT_NUMBER_RE.fullmatch(resource_id):
            command = (gcloud, "organizations", "get-iam-policy", resource_id, "--format=json", "--quiet")
        else:
            raise ProvisionerError("Cloud resource hierarchy inspection returned invalid data")
        policies.append(
            _cloud_json(command, account=owner, operation="Cloud project access inspection")
        )
    if not project_seen:
        raise ProvisionerError("Cloud resource hierarchy inspection returned invalid data")
    return policies


def _ensure_bootstrap_secret(gcloud: str, config: Mapping[str, Any], owner: str, project_number: str) -> None:
    _assert_bootstrap_secret_owned(gcloud, config, owner, project_number, create=True)
    project_id = config["vertexProject"]
    _disable_enabled_bootstrap_secret_versions(gcloud, config, owner, project_number)
    for policy in _project_ancestor_secret_policies(gcloud, project_id, project_number, owner):
        _assert_owner_only_project_secret_accessor(gcloud, policy, owner)
    _assert_owner_only_secret_accessor(_secret_access_policy(gcloud, project_id, owner), owner, require_owner=False)
    _cloud_success((gcloud, "secrets", "add-iam-policy-binding", BOOTSTRAP_SECRET_NAME, f"--project={project_id}", f"--member=user:{owner}", "--role=roles/secretmanager.secretAccessor", "--quiet"), account=owner, operation="bootstrap secret access grant")
    _assert_owner_only_secret_accessor(_secret_access_policy(gcloud, project_id, owner), owner, require_owner=True)


def _assert_bootstrap_secret_owned(gcloud: str, config: Mapping[str, Any], owner: str, project_number: str, *, create: bool) -> None:
    project_id = config["vertexProject"]
    try:
        secret = _secret_describe(gcloud, project_id, project_number, owner)
    except BootstrapSecretNotFound:
        if not create:
            raise ProvisionerError("bootstrap secret is not owned by this installation")
        _cloud_success((gcloud, "secrets", "create", BOOTSTRAP_SECRET_NAME, f"--project={project_id}", f"--labels={BOOTSTRAP_SECRET_LABEL}={config['cloudInstallationId']}", "--quiet"), account=owner, operation="bootstrap secret creation")
        secret = _secret_describe(gcloud, project_id, project_number, owner)
    labels = secret.get("labels") if isinstance(secret, dict) else None
    expected_name = _secret_resource_pattern(project_id, project_number)
    if not isinstance(secret, dict) or not isinstance(secret.get("name"), str) or not re.fullmatch(expected_name, secret["name"]) or not isinstance(labels, dict) or labels.get(BOOTSTRAP_SECRET_LABEL) != config["cloudInstallationId"]:
        raise ProvisionerError("bootstrap secret is not owned by this installation")


def _disable_enabled_bootstrap_secret_versions(gcloud: str, config: Mapping[str, Any], owner: str, project_number: str) -> None:
    versions = _cloud_json(
        (gcloud, "secrets", "versions", "list", BOOTSTRAP_SECRET_NAME, f"--project={config['vertexProject']}", "--format=json", "--quiet"),
        account=owner,
        operation="bootstrap secret version reconciliation",
    )
    expected = _secret_resource_pattern(config["vertexProject"], project_number) + r"/versions/[1-9][0-9]*"
    if not isinstance(versions, list):
        raise ProvisionerError("bootstrap secret version reconciliation returned invalid data")
    names: set[str] = set()
    for version in versions:
        name = version.get("name") if isinstance(version, dict) else None
        state = version.get("state") if isinstance(version, dict) else None
        if (
            not isinstance(name, str)
            or name in names
            or not re.fullmatch(expected, name)
            or not isinstance(state, str)
            or state not in {"ENABLED", "DISABLED", "DESTROYED"}
        ):
            raise ProvisionerError("bootstrap secret version reconciliation returned invalid data")
        names.add(name)
        if state == "ENABLED":
            _disable_bootstrap_secret_version(gcloud, config, owner, project_number, name)


def _stage_bootstrap_secret(gcloud: str, config: Mapping[str, Any], owner: str, project_number: str, payload: bytes) -> str:
    result = _run_json_with_input(
        (gcloud, "secrets", "versions", "add", BOOTSTRAP_SECRET_NAME, f"--project={config['vertexProject']}", "--data-file=-", "--format=json", "--quiet", f"--account={owner}"),
        payload,
        operation="bootstrap secret staging",
    )
    name = result.get("name") if isinstance(result, dict) else None
    expected = _secret_resource_pattern(config["vertexProject"], project_number) + r"/versions/[1-9][0-9]*"
    if not isinstance(name, str) or not re.fullmatch(expected, name):
        raise ProvisionerError("bootstrap secret staging returned invalid data")
    return name


def _run_json_with_input(command: Sequence[str], input_data: bytes, *, operation: str) -> Any:
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    try:
        process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, close_fds=True, start_new_session=True)
        if process.stdin is None or process.stdout is None:
            raise OSError("command pipes were not created")
        selector = selectors.DefaultSelector()
        selector.register(process.stdin, selectors.EVENT_WRITE)
        selector.register(process.stdout, selectors.EVENT_READ)
        output = bytearray()
        offset = 0
        deadline = time.monotonic() + 30
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, 30)
            for selected, _events in selector.select(remaining):
                stream = selected.fileobj
                if stream is process.stdin:
                    written = os.write(stream.fileno(), input_data[offset:])
                    offset += written
                    if offset == len(input_data):
                        selector.unregister(stream)
                        stream.close()
                else:
                    chunk = os.read(stream.fileno(), min(8192, MAX_COMMAND_OUTPUT_BYTES + 1 - len(output)))
                    if not chunk:
                        selector.unregister(stream)
                        continue
                    output.extend(chunk)
                    if len(output) > MAX_COMMAND_OUTPUT_BYTES:
                        raise ProvisionerError(f"{operation} was rejected")
        completed_returncode = process.wait(timeout=max(0, deadline - time.monotonic()))
    except (OSError, subprocess.TimeoutExpired) as exc:
        if process is not None:
            _terminate_process(process)
        raise ProvisionerError(f"{operation} could not run") from exc
    except ProvisionerError:
        if process is not None:
            _terminate_process(process)
        raise
    finally:
        if selector is not None:
            selector.close()
        if process is not None and process.stdin is not None:
            process.stdin.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()
    if completed_returncode != 0:
        raise ProvisionerError(f"{operation} was rejected")
    try:
        return json.loads(bytes(output).decode("utf-8"), object_pairs_hook=_no_duplicate_object, parse_constant=_reject_json_constant, parse_float=_finite_json_float)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError, RecursionError) as exc:
        raise ProvisionerError(f"{operation} returned unexpected output") from exc


def _validate_bootstrap_result(value: Any) -> None:
    if not isinstance(value, dict) or set(value) != {"version", "installed", "resumed", "spreadsheetId", "labelId", "triggerCreated", "reviewTriggerCreated", "locale", "timeZone"}:
        raise ProvisionerError("Apps Script bootstrap returned invalid data")
    if value["version"] != 1 or value["installed"] is not True or value["locale"] != "en" or value["timeZone"] != "Europe/Rome":
        raise ProvisionerError("Apps Script bootstrap did not confirm installation")
    if not all(isinstance(value[key], bool) for key in ("resumed", "triggerCreated", "reviewTriggerCreated")) or not all(isinstance(value[key], str) and value[key] for key in ("spreadsheetId", "labelId")):
        raise ProvisionerError("Apps Script bootstrap returned invalid data")


def _invoke_bootstrap(access_token: str, script_id: str, secret_version: str) -> None:
    result = _apps_script_json(access_token, "POST", f"https://script.googleapis.com/v1/scripts/{script_id}:run", {"function": "bootstrapFromSecret", "parameters": [secret_version], "devMode": False})
    if not isinstance(result, dict) or result.get("done") is not True:
        raise ProvisionerError("Apps Script bootstrap was rejected")
    _validate_bootstrap_result(result.get("response", {}).get("result") if isinstance(result.get("response"), dict) else None)


def _verify_execution_api_access(access_token: str, script_id: str) -> None:
    """Prove the OAuth client can invoke this immutable API deployment first."""
    result = _apps_script_json(
        access_token,
        "POST",
        f"https://script.googleapis.com/v1/scripts/{script_id}:run",
        {"function": "verifyBootstrapExecutionAccess", "parameters": [], "devMode": False},
    )
    value = result.get("response", {}).get("result") if isinstance(result, dict) and isinstance(result.get("response"), dict) else None
    if not isinstance(result, dict) or result.get("done") is not True or value != {"version": 1, "ready": True}:
        raise ProvisionerError("Apps Script execution API authorization was rejected")


def _bootstrap_secret_version_state(gcloud: str, config: Mapping[str, Any], owner: str, project_number: str, secret_version: str) -> str:
    version = secret_version.rsplit("/", 1)[-1]
    result = _cloud_json(
        (gcloud, "secrets", "versions", "describe", version, f"--secret={BOOTSTRAP_SECRET_NAME}", f"--project={config['vertexProject']}", "--format=json", "--quiet"),
        account=owner,
        operation="bootstrap secret version inspection",
    )
    expected = _secret_resource_pattern(config["vertexProject"], project_number) + r"/versions/[1-9][0-9]*"
    if not isinstance(result, dict) or result.get("name") != secret_version or not re.fullmatch(expected, secret_version) or result.get("state") not in {"ENABLED", "DISABLED", "DESTROYED"}:
        raise ProvisionerError("bootstrap secret version inspection returned invalid data")
    return result["state"]


def _disable_bootstrap_secret_version(gcloud: str, config: Mapping[str, Any], owner: str, project_number: str, secret_version: str) -> None:
    if _bootstrap_secret_version_state(gcloud, config, owner, project_number, secret_version) in {"DISABLED", "DESTROYED"}:
        return
    version = secret_version.rsplit("/", 1)[-1]
    _cloud_success((gcloud, "secrets", "versions", "disable", version, f"--secret={BOOTSTRAP_SECRET_NAME}", f"--project={config['vertexProject']}", "--quiet"), account=owner, operation="bootstrap secret version disablement")
    if _bootstrap_secret_version_state(gcloud, config, owner, project_number, secret_version) != "DISABLED":
        raise ProvisionerError("bootstrap secret version disablement could not be verified")


def deploy_apps_script(state_dir: Path, config: Mapping[str, Any], source_dir: Path, clasp_auth: Path, bootstrap_payload: Path | None, *, association_acknowledged: bool = False) -> dict[str, Any]:
    """Deploy one verified private source snapshot and complete its secret bootstrap."""
    validate_cloud_config(config)
    state_dir = ensure_state_dir(state_dir)
    with InstallationLock(state_dir):
        state = _initialize_state_locked(state_dir, config)
        key = _load_or_create_identity_key(state_dir)
        if state["bootstrap"]["status"] in {"staged", "verified", "staging", "replacement-staging"}:
            vertex = state["cloud"].get("vertex")
            if not isinstance(vertex, dict) or vertex.get("projectId") != config["vertexProject"] or not isinstance(vertex.get("projectNumber"), str):
                raise ProvisionerError("persisted Vertex project identity does not match the installation")
            gcloud = discover_tools(("gcloud",))["gcloud"]
            if gcloud is None:
                raise ProvisionerError("gcloud is required for secure bootstrap")
            owner = _require_active_gcloud_owner(gcloud, config["ownerEmail"])
            status = state["bootstrap"]["status"]
            if status in {"staged", "verified"}:
                _assert_bootstrap_secret_owned(gcloud, config, owner, vertex["projectNumber"], create=False)
            if status == "staged":
                _disable_bootstrap_secret_version(gcloud, config, owner, vertex["projectNumber"], state["bootstrap"]["secretVersion"])
            elif status in {"staging", "replacement-staging"}:
                _assert_bootstrap_secret_owned(gcloud, config, owner, vertex["projectNumber"], create=False)
                _disable_enabled_bootstrap_secret_versions(gcloud, config, owner, vertex["projectNumber"])
            else:
                secret_version = state["bootstrap"]["secretVersion"]
                _disable_bootstrap_secret_version(gcloud, config, owner, vertex["projectNumber"], secret_version)
                state = dict(state)
                state["bootstrap"] = {"secretVersion": secret_version, "status": "complete"}
                state["phase"] = "bootstrap-complete"
                state = _persist_state_locked(state_dir, state, key)
        _require_cloud_ready_state(state, config)
        digest, files = _deployment_bundle(source_dir)
        # Reject every private input before any Apps Script or Cloud mutation.
        if state["bootstrap"]["status"] == "complete":
            payload = None
        elif bootstrap_payload is None:
            raise ProvisionerError("bootstrap payload is required until bootstrap completes")
        else:
            payload = _validate_bootstrap_payload(bootstrap_payload, config)
        state = _mark_bundle_validated_locked(state_dir, config, digest)
        access_token = _require_isolated_clasp_owner(clasp_auth, config["ownerEmail"])
        created_this_run = False
        def persist_creation_intent() -> None:
            nonlocal state
            state = dict(state)
            state["phase"] = "apps-script-creation-intent"
            state = _persist_state_locked(state_dir, state, key)

        def persist_creation_posted() -> None:
            nonlocal state
            state = dict(state)
            state["phase"] = "apps-script-creation-posted"
            state = _persist_state_locked(state_dir, state, key)

        def persist_created_script(script_id: str) -> None:
            nonlocal created_this_run, state
            state = dict(state)
            state["appsScript"] = {
                "scriptId": script_id,
                "provenance": "created",
                "bundleDigest": None,
                "versionNumber": None,
                "deploymentId": None,
            }
            state["phase"] = "apps-script-association-required"
            state = _persist_state_locked(state_dir, state, key)
            created_this_run = True

        def clear_creation_intent() -> None:
            nonlocal state
            state = dict(state)
            state["phase"] = "cloud-ready"
            state = _persist_state_locked(state_dir, state, key)

        script_id, provenance = _find_or_create_apps_script(access_token, config["ownerEmail"], state, persist_creation_intent, persist_creation_posted, persist_created_script, clear_creation_intent)
        _assert_private_owner_script(_drive_script_metadata(access_token, script_id), config["ownerEmail"], script_id)
        if created_this_run or (state["phase"] == "apps-script-association-required" and not association_acknowledged):
            return state
        if state["appsScript"]["scriptId"] is None and provenance == "created":
            state = dict(state)
            state["appsScript"] = {
                "scriptId": script_id,
                "provenance": provenance,
                "bundleDigest": None,
                "versionNumber": None,
                "deploymentId": None,
            }
            state["phase"] = "apps-script-association-required"
            return _persist_state_locked(state_dir, state, key)
        if state["appsScript"]["scriptId"] is None and provenance == "adopted":
            state = dict(state)
            state["appsScript"] = {
                "scriptId": script_id,
                "provenance": "adopted",
                "bundleDigest": None,
                "versionNumber": None,
                "deploymentId": None,
            }
            state["phase"] = "apps-script-adoption-pending"
            state = _persist_state_locked(state_dir, state, key)
        pending_apps_script = state["appsScript"]
        # A project we can adopt may still have a deployment that violates the
        # owner-only contract. Validate every established deployment before
        # replacing source. Only the immediately persisted result of a create
        # request can bypass a potentially delayed collection listing while its
        # exact ID is reconciled.
        if not (
            state["phase"] == "apps-script-deployment-creation-pending"
            and pending_apps_script["deploymentId"] is not None
        ):
            _deployment_list(access_token, script_id)
        if state["phase"] == "apps-script-deployment-creation-pending":
            if pending_apps_script["deploymentId"] is None:
                deployment_id, version_number = _ensure_owner_only_deployment(
                    access_token,
                    script_id,
                    pending_apps_script["bundleDigest"],
                    pending_apps_script["versionNumber"],
                    creation_pending=True,
                )
            else:
                deployment_id, version_number = _verify_persisted_owner_only_deployment(
                    access_token,
                    script_id,
                    pending_apps_script["bundleDigest"],
                    pending_apps_script["versionNumber"],
                    pending_apps_script["deploymentId"],
                )
            state = dict(state)
            state["appsScript"] = {
                "scriptId": script_id,
                "provenance": provenance,
                "bundleDigest": pending_apps_script["bundleDigest"],
                "versionNumber": version_number,
                "deploymentId": deployment_id,
            }
            state["phase"] = "bootstrap-complete" if state["bootstrap"]["status"] == "complete" else "apps-script-ready"
            state = _persist_state_locked(state_dir, state, key)
        elif state["phase"] == "apps-script-version-creation-pending":
            recovered_version = pending_apps_script["versionNumber"]
            if recovered_version is None:
                recovered_version = _recover_bundle_version(access_token, script_id, pending_apps_script["bundleDigest"])
                if recovered_version is None:
                    raise ProvisionerError("Apps Script version creation is pending recovery")
            elif _remote_bundle_digest(access_token, script_id, recovered_version) != pending_apps_script["bundleDigest"]:
                raise ProvisionerError("Apps Script version creation content does not match the verified source bundle")
            state = dict(state)
            state["appsScript"] = {
                "scriptId": script_id,
                "provenance": provenance,
                "bundleDigest": pending_apps_script["bundleDigest"],
                "versionNumber": recovered_version,
                "deploymentId": pending_apps_script["deploymentId"],
            }
            state["phase"] = "apps-script-version-ready"
            state = _persist_state_locked(state_dir, state, key)
        elif state["phase"] == "apps-script-version-ready" and pending_apps_script["deploymentId"] is not None:
            _ensure_owner_only_deployment(
                access_token,
                script_id,
                pending_apps_script["bundleDigest"],
                pending_apps_script["versionNumber"],
                pending_apps_script["deploymentId"],
            )
        elif pending_apps_script["deploymentId"] is not None:
            _verify_persisted_owner_only_deployment(
                access_token,
                script_id,
                pending_apps_script["bundleDigest"],
                pending_apps_script["versionNumber"],
                pending_apps_script["deploymentId"],
            )
        if _remote_bundle_digest(access_token, script_id) != digest:
            _apps_script_json(
                access_token,
                "PUT",
                f"https://script.googleapis.com/v1/projects/{script_id}/content",
                {"files": files},
                maximum_bytes=MAX_APPS_SCRIPT_SOURCE_RESPONSE_BYTES,
            )
            if _remote_bundle_digest(access_token, script_id) != digest:
                raise ProvisionerError("Apps Script source deployment could not be verified")
        apps_script = state["appsScript"]
        persisted_deployment_id = apps_script["deploymentId"]

        def persist_version_state(version_number: int | None, phase: str) -> None:
            nonlocal state
            state = dict(state)
            state["appsScript"] = {
                "scriptId": script_id,
                "provenance": provenance,
                "bundleDigest": digest,
                "versionNumber": version_number,
                "deploymentId": persisted_deployment_id,
            }
            state["phase"] = phase
            state = _persist_state_locked(state_dir, state, key)

        if apps_script["bundleDigest"] == digest and isinstance(apps_script["versionNumber"], int):
            version_number = apps_script["versionNumber"]
        elif state["phase"] == "apps-script-version-creation-pending" and apps_script["bundleDigest"] == digest:
            recovered_version = _recover_bundle_version(access_token, script_id, digest)
            if recovered_version is None:
                raise ProvisionerError("Apps Script version creation is pending recovery")
            persist_version_state(recovered_version, "apps-script-version-ready")
            version_number = recovered_version
        else:
            recovered_version = _recover_bundle_version(access_token, script_id, digest)
            if recovered_version is None:
                persist_version_state(None, "apps-script-version-creation-pending")
                try:
                    recovered_version = _create_bundle_version(access_token, script_id, digest)
                except AppsScriptHttpError as exc:
                    if 400 <= exc.status < 500:
                        if persisted_deployment_id is None:
                            persist_version_state(None, "apps-script-version-creation-intent")
                        else:
                            # The POST was definitively rejected. Restore the
                            # prior verified deployment identity so the next
                            # run can retry the new version without treating
                            # its absent marker as an uncertain deployment.
                            state = dict(state)
                            state["appsScript"] = apps_script
                            state["phase"] = "bootstrap-complete" if state["bootstrap"]["status"] == "complete" else "apps-script-ready"
                            state = _persist_state_locked(state_dir, state, key)
                    raise
                persist_version_state(recovered_version, "apps-script-version-creation-pending")
                if _remote_bundle_digest(access_token, script_id, recovered_version) != digest:
                    raise ProvisionerError("Apps Script version creation content does not match the verified source bundle")
            persist_version_state(recovered_version, "apps-script-version-ready")
            version_number = recovered_version

        def persist_deployment_creation_pending() -> None:
            nonlocal state
            state = dict(state)
            state["appsScript"] = {
                "scriptId": script_id,
                "provenance": provenance,
                "bundleDigest": digest,
                "versionNumber": version_number,
                "deploymentId": None,
            }
            state["phase"] = "apps-script-deployment-creation-pending"
            state = _persist_state_locked(state_dir, state, key)

        def clear_deployment_creation_pending() -> None:
            nonlocal state
            state = dict(state)
            state["appsScript"] = {
                "scriptId": script_id,
                "provenance": provenance,
                "bundleDigest": digest,
                "versionNumber": version_number,
                "deploymentId": None,
            }
            state["phase"] = "apps-script-version-ready"
            state = _persist_state_locked(state_dir, state, key)

        def persist_created_deployment_identity(deployment_id: str) -> None:
            nonlocal state
            state = dict(state)
            state["appsScript"] = {
                "scriptId": script_id,
                "provenance": provenance,
                "bundleDigest": digest,
                "versionNumber": version_number,
                "deploymentId": deployment_id,
            }
            state["phase"] = "apps-script-deployment-creation-pending"
            state = _persist_state_locked(state_dir, state, key)

        deployment_id, version_number = _ensure_owner_only_deployment(
            access_token,
            script_id,
            digest,
            version_number,
            persisted_deployment_id,
            creation_pending=state["phase"] == "apps-script-deployment-creation-pending",
            persist_creation_pending=persist_deployment_creation_pending,
            clear_creation_pending=clear_deployment_creation_pending,
            persist_created_identity=persist_created_deployment_identity,
        )
        state = dict(state)
        state["appsScript"] = {"scriptId": script_id, "provenance": provenance, "bundleDigest": digest, "versionNumber": version_number, "deploymentId": deployment_id}
        state["phase"] = "bootstrap-complete" if state["bootstrap"]["status"] == "complete" else "apps-script-ready"
        state = _persist_state_locked(state_dir, state, key)
        if state["bootstrap"]["status"] == "complete":
            return state
        gcloud = discover_tools(("gcloud",))["gcloud"]
        if gcloud is None:
            raise ProvisionerError("gcloud is required for secure bootstrap")
        owner = _require_active_gcloud_owner(gcloud, config["ownerEmail"])
        project_number = state["cloud"]["vertex"]["projectNumber"]
        bootstrap = state["bootstrap"]
        if bootstrap["status"] == "verified":
            # Bootstrap was already invoked.  Only gcloud is needed to make
            # its exact persisted version unusable; do that before checks
            # needed solely to stage or invoke another bootstrap request.
            _disable_bootstrap_secret_version(gcloud, config, owner, project_number, bootstrap["secretVersion"])
            state = dict(state)
            state["bootstrap"] = {"secretVersion": bootstrap["secretVersion"], "status": "complete"}
            state["phase"] = "bootstrap-complete"
            return _persist_state_locked(state_dir, state, key)
        _revalidate_project_before_mutation(
            gcloud,
            project_id=config["vertexProject"],
            installation_label=config["cloudInstallationId"],
            role="vertex",
            expected_owner=owner,
            persisted=state["cloud"]["vertex"],
        )
        _ensure_service(
            gcloud, config["vertexProject"], "gmail.googleapis.com",
            installation_label=config["cloudInstallationId"], role="vertex", expected_owner=owner,
            persisted=state["cloud"]["vertex"],
        )
        _ensure_service(
            gcloud, config["vertexProject"], "drive.googleapis.com",
            installation_label=config["cloudInstallationId"], role="vertex", expected_owner=owner,
            persisted=state["cloud"]["vertex"],
        )
        _ensure_service(gcloud, config["vertexProject"], "cloudresourcemanager.googleapis.com", installation_label=config["cloudInstallationId"], role="vertex", expected_owner=owner, persisted=state["cloud"]["vertex"])
        if bootstrap["status"] in {"staging", "replacement-staging"}:
            # An interrupted `versions add` has no durable new-version ID.
            # Reconcile every dedicated-secret version before making this
            # signed state retryable again.
            _ensure_bootstrap_secret(gcloud, config, owner, project_number)
            state = dict(state)
            state["bootstrap"] = {"secretVersion": None, "status": "not-started"}
            state = _persist_state_locked(state_dir, state, key)
            bootstrap = state["bootstrap"]
        _verify_execution_api_access(access_token, script_id)
        if bootstrap["status"] in {"staged", "verified"}:
            _ensure_bootstrap_secret(gcloud, config, owner, project_number)
            secret_version = bootstrap["secretVersion"]
            if bootstrap["status"] == "staged" and _bootstrap_secret_version_state(gcloud, config, owner, project_number, secret_version) != "ENABLED":
                if payload is None:
                    raise ProvisionerError("bootstrap payload is required until bootstrap completes")
                state = dict(state)
                state["bootstrap"] = {"secretVersion": secret_version, "status": "replacement-staging"}
                state = _persist_state_locked(state_dir, state, key)
                secret_version = _stage_bootstrap_secret(gcloud, config, owner, project_number, payload)
                state = dict(state)
                state["bootstrap"] = {"secretVersion": secret_version, "status": "staged"}
                state = _persist_state_locked(state_dir, state, key)
        else:
            if bootstrap["status"] != "not-started":
                raise ProvisionerError("bootstrap state is invalid")
            if bootstrap["status"] == "not-started":
                _ensure_bootstrap_secret(gcloud, config, owner, project_number)
                state = dict(state)
                state["bootstrap"] = {"secretVersion": None, "status": "staging"}
                state = _persist_state_locked(state_dir, state, key)
            if payload is None:
                raise ProvisionerError("bootstrap payload is required until bootstrap completes")
            secret_version = _stage_bootstrap_secret(gcloud, config, owner, project_number, payload)
            state = dict(state)
            state["bootstrap"] = {"secretVersion": secret_version, "status": "staged"}
            state = _persist_state_locked(state_dir, state, key)
        if state["bootstrap"]["status"] == "staged":
            _invoke_bootstrap(access_token, script_id, secret_version)
            state = dict(state)
            state["bootstrap"] = {"secretVersion": secret_version, "status": "verified"}
            state = _persist_state_locked(state_dir, state, key)
        _disable_bootstrap_secret_version(gcloud, config, owner, project_number, secret_version)
        state = dict(state)
        state["bootstrap"] = {"secretVersion": secret_version, "status": "complete"}
        state["phase"] = "bootstrap-complete"
        return _persist_state_locked(state_dir, state, key)
