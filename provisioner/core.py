"""Fail-closed local foundation for a future MyCoupons provisioner.

This module deliberately has no Google API client dependency.  Its only
external process support is a narrowly constrained, read-only gcloud preflight.
"""

from __future__ import annotations

import dataclasses
import datetime
import hashlib
import hmac
import json
import math
import os
import re
import selectors
import secrets
import shutil
import stat
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


class ProvisionerError(Exception):
    """A safe, operator-facing failure that never includes command output."""


CONFIG_KEYS = frozenset(
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
    "vertexLocation": "global",
    "model": "gemini-flash-latest",
    "autoVertexFallback": False,
    "fetchRemoteImages": True,
}

IDENTITY_FILE = "identity.key"
STATE_FILE = "state.json"
LOCK_FILE = "install.lock"
STATE_VERSION = 1
MAX_CONFIG_BYTES = 8000
MAX_COMMAND_OUTPUT_BYTES = 65536
MAX_BUNDLE_FILE_BYTES = 1024 * 1024
MAX_BUNDLE_TOTAL_BYTES = 8 * 1024 * 1024
MAX_BUNDLE_FILES = 1000
MAX_BUNDLE_PATH_BYTES = 128 * 1024
PROJECT_ID_RE = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
EMAIL_RE = re.compile(r"^[^@]+@[^@]+\.[^@]+$")
MODEL_RE = re.compile(r"^gemini-[a-z0-9._-]+$")
VERTEX_LOCATION_RE = re.compile(r"^[a-z][a-z0-9-]*$")
ECMASCRIPT_TRIM_CHARS = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
ECMASCRIPT_WHITESPACE_RE = re.compile(f"[{re.escape(ECMASCRIPT_TRIM_CHARS)}]")


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
    if set(config) != CONFIG_KEYS:
        raise ProvisionerError("installation config keys must exactly match the installer contract")
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


def config_digest(config: Mapping[str, Any]) -> str:
    return _sha256(_canonical_json(dict(config)))


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
        }
    )
    return hmac.new(key, b"mycoupons-state\0" + signed, hashlib.sha256).hexdigest()


def _validate_state(state: Any, key: bytes) -> dict[str, Any]:
    if not isinstance(state, dict) or set(state) != {"version", "installationId", "configDigest", "identityProof", "phase", "bundleDigest"}:
        raise ProvisionerError("installation state has an unsupported shape")
    if state["version"] != STATE_VERSION or not isinstance(state["phase"], str) or state["phase"] not in {"initialized", "bundle-validated"}:
        raise ProvisionerError("installation state has an unsupported version or phase")
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
    expected = _identity_proof(key, state)
    if not hmac.compare_digest(state["identityProof"], expected):
        raise ProvisionerError("installation state is not bound to this local installation")
    return state


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
        state = _validate_state(_read_json_file(state_path, maximum_bytes=4096), key)
        if state["configDigest"] != digest:
            raise ProvisionerError("installation config does not match persisted installation identity")
        return state
    installation_id = str(uuid.uuid4())
    state: dict[str, Any] = {
        "version": STATE_VERSION,
        "installationId": installation_id,
        "configDigest": digest,
        "phase": "initialized",
        "bundleDigest": None,
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
    state = _validate_state(_read_json_file(state_path, maximum_bytes=4096), key)
    if state["configDigest"] != config_digest(config):
        raise ProvisionerError("installation config does not match persisted installation identity")
    state = dict(state)
    state["phase"] = "bundle-validated"
    state["bundleDigest"] = digest
    state["identityProof"] = _identity_proof(key, state)
    _write_private_atomic(state_path, _canonical_json(state))
    return state


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
            if path.is_file() and path.suffix in {".gs", ".html", ".js", ".json"}:
                try:
                    relative_bytes = path.relative_to(source_dir).as_posix().encode("utf-8")
                except UnicodeEncodeError as exc:
                    raise ProvisionerError("Apps Script source bundle path is not valid Unicode") from exc
                if len(bundle_files) >= MAX_BUNDLE_FILES or bundle_path_bytes + len(relative_bytes) > MAX_BUNDLE_PATH_BYTES:
                    raise ProvisionerError("Apps Script source bundle has too many files or path bytes")
                bundle_files.append(path)
                bundle_path_bytes += len(relative_bytes)
    yield from sorted(bundle_files)


def _has_bootstrap_entry_point(content: bytes) -> bool:
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
    for match in re.finditer(r"(?m)^[ \t]*function[ \t]+bootstrapFromSecret[ \t]*\(", visible_source):
        prefix = visible_source[: match.start()]
        if prefix.count("{") == prefix.count("}"):
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
    if "webapp" in manifest or manifest.get("executionApi") != {"access": "MYSELF"} or set(scopes) != expected_scopes:
        raise ProvisionerError("Apps Script manifest access or OAuth scope contract is invalid")
    dependencies = manifest.get("dependencies")
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
    if installer_source is None or not _has_bootstrap_entry_point(installer_source):
        raise ProvisionerError("Apps Script source bundle is missing the bootstrapFromSecret entry point")
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


def _run_json(command: Sequence[str]) -> Any:
    process: subprocess.Popen[bytes] | None = None
    selector: selectors.BaseSelector | None = None
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if process.stdout is None:
            raise OSError("gcloud stdout pipe was not created")
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        output = bytearray()
        deadline = time.monotonic() + 30
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, 30)
            if not selector.select(remaining):
                continue
            chunk = os.read(process.stdout.fileno(), min(8192, MAX_COMMAND_OUTPUT_BYTES + 1 - len(output)))
            if not chunk:
                selector.unregister(process.stdout)
                continue
            output.extend(chunk)
            if len(output) > MAX_COMMAND_OUTPUT_BYTES:
                raise ProvisionerError("read-only authentication preflight returned unexpected output")
        completed_returncode = process.wait(timeout=max(0, deadline - time.monotonic()))
    except (OSError, subprocess.TimeoutExpired) as exc:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        raise ProvisionerError("read-only authentication preflight could not run") from exc
    except ProvisionerError:
        if process is not None and process.poll() is None:
            process.kill()
            process.wait()
        raise
    finally:
        if selector is not None:
            selector.close()
        if process is not None and process.stdout is not None:
            process.stdout.close()
    if completed_returncode != 0:
        raise ProvisionerError("read-only authentication preflight was rejected")
    try:
        response = json.loads(
            bytes(output).decode("utf-8"),
            object_pairs_hook=_no_duplicate_object,
            parse_constant=_reject_json_constant,
            parse_float=_finite_json_float,
        )
        _assert_well_formed_unicode(response)
        return response
    except (RecursionError, json.JSONDecodeError, ValueError) as exc:
        raise ProvisionerError("read-only authentication preflight returned unexpected output") from exc


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
    accounts = _run_json((gcloud, "auth", "list", "--format=json", "--quiet"))
    if not isinstance(accounts, list) or any(
        not isinstance(entry, dict) or not isinstance(entry.get("account"), str) or not isinstance(entry.get("status"), str)
        for entry in accounts
    ):
        raise ProvisionerError("read-only authentication preflight returned unexpected accounts")
    active = [entry for entry in accounts if entry["status"] == "ACTIVE"]
    if len(active) != 1 or active[0]["account"].lower() != expected_owner.lower():
        raise ProvisionerError("active gcloud identity is absent, ambiguous, or does not match ownerEmail")
    project = _run_json((gcloud, "projects", "describe", project_id, "--format=json", "--quiet"))
    if not isinstance(project, dict) or project.get("projectId") != project_id:
        raise ProvisionerError("read-only project identity response is malformed or mismatched")
    return {"ownerMatched": True, "projectReadable": True}
