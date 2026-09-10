"""Regression tests for the local-only provisioner foundation."""

from __future__ import annotations

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from provisioner import core
from provisioner.cli import _default_state_dir, main


ROOT = Path(__file__).resolve().parents[1]


def private_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")
    path.chmod(0o600)


def valid_config() -> dict[str, object]:
    return {
        "ownerEmail": "owner@example.com",
        "spreadsheetId": "",
        "spreadsheetName": "My Coupons",
        "sheetName": "Coupon Manager",
        "labelName": "Coupon Code Discount",
        "locale": "en",
        "timeZone": "Europe/Rome",
        "initialDate": "",
        "developerProject": "",
        "vertexProject": "vertex-project",
        "vertexBillingAccount": "",
        "cloudInstallationId": "",
        "vertexLocation": "global",
        "model": "gemini-flash-latest",
        "autoVertexFallback": False,
        "fetchRemoteImages": True,
    }


def valid_cloud_config() -> dict[str, object]:
    config = valid_config()
    config.update(
        {
            "developerProject": "developer-project",
            "vertexProject": "vertex-project",
            "vertexBillingAccount": "ABCDEF-123456-ABCDEF",
            "cloudInstallationId": "installation-demo",
        }
    )
    return config


class ProvisionerConfigTests(unittest.TestCase):
    def test_public_provisioning_template_loads_with_the_complete_cloud_shape(self) -> None:
        template = ROOT / "config" / "provisioner.example.json"
        with tempfile.TemporaryDirectory() as temporary:
            copied = Path(temporary) / "config.json"
            configured = json.loads(template.read_text(encoding="utf-8"))
            configured["vertexProject"] = "vertex-project"
            private_json(copied, configured)
            loaded = core.load_config(copied)
        self.assertEqual(set(loaded), core.CONFIG_KEYS)
        self.assertEqual(loaded["vertexBillingAccount"], "")
        self.assertEqual(loaded["cloudInstallationId"], "")

    def test_config_requires_private_file_and_exact_installer_shape(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config_path = Path(temporary) / "config.json"
            private_json(config_path, valid_config())
            self.assertEqual(core.load_config(config_path)["ownerEmail"], "owner@example.com")
            bad = valid_config()
            bad["labelId"] = "private-id"
            private_json(config_path, bad)
            with self.assertRaisesRegex(core.ProvisionerError, "keys"):
                core.load_config(config_path)
            private_json(config_path, valid_config())
            config_path.chmod(0o644)
            with self.assertRaisesRegex(core.ProvisionerError, "0600"):
                core.load_config(config_path)

    def test_config_rejects_duplicate_json_keys_and_impossible_dates(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config_path = Path(temporary) / "config.json"
            config_path.write_text('{"ownerEmail":"one@example.com","ownerEmail":"two@example.com"}', encoding="utf-8")
            config_path.chmod(0o600)
            with self.assertRaisesRegex(core.ProvisionerError, "malformed"):
                core.load_config(config_path)
            invalid_date = valid_config()
            invalid_date["initialDate"] = "2026-02-30"
            private_json(config_path, invalid_date)
            with self.assertRaisesRegex(core.ProvisionerError, "initialDate"):
                core.load_config(config_path)

    def test_config_rejects_reserved_sheet_and_invalid_vertex_dependency(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config_path = Path(temporary) / "config.json"
            bad = valid_config()
            bad["sheetName"] = "_MYCOUPONS MESSAGES"
            private_json(config_path, bad)
            with self.assertRaisesRegex(core.ProvisionerError, "reserved"):
                core.load_config(config_path)
            bad = valid_config()
            bad["vertexProject"] = ""
            private_json(config_path, bad)
            with self.assertRaisesRegex(core.ProvisionerError, "required"):
                core.load_config(config_path)
            valid_short_location = valid_config()
            valid_short_location["vertexLocation"] = "us"
            private_json(config_path, valid_short_location)
            self.assertEqual(core.load_config(config_path)["vertexLocation"], "us")
            invalid_identifier = valid_config()
            invalid_identifier["spreadsheetId"] = "café"
            private_json(config_path, invalid_identifier)
            with self.assertRaisesRegex(core.ProvisionerError, "spreadsheetId"):
                core.load_config(config_path)

    def test_config_uses_ecmascript_whitespace_and_safe_tilde_expansion(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config_path = Path(temporary) / "config.json"
            for key in ("spreadsheetName", "sheetName", "labelName"):
                invalid = valid_config()
                invalid[key] = "\ufeff"
                private_json(config_path, invalid)
                with self.assertRaisesRegex(core.ProvisionerError, key):
                    core.load_config(config_path)
            invalid = valid_config()
            invalid["labelName"] = "valid/\ufeff"
            private_json(config_path, invalid)
            with self.assertRaisesRegex(core.ProvisionerError, "labelName"):
                core.load_config(config_path)
            invalid = valid_config()
            invalid["ownerEmail"] = "owner\ufeff@example.com"
            private_json(config_path, invalid)
            with self.assertRaisesRegex(core.ProvisionerError, "ownerEmail"):
                core.load_config(config_path)
        with self.assertRaisesRegex(core.ProvisionerError, "cannot be resolved"):
            core.load_config(Path("~missing-user/config.json"))

    def test_config_size_limit_is_checked_before_an_unbounded_read(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config_path = Path(temporary) / "config.json"
            config_path.write_bytes(b"{" + b"x" * (core.MAX_CONFIG_BYTES + 1) + b"}")
            config_path.chmod(0o600)
            with self.assertRaisesRegex(core.ProvisionerError, "too large"):
                core.load_config(config_path)

    def test_config_rejects_nonstandard_constants_and_excessive_nesting(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config_path = Path(temporary) / "config.json"
            config_path.write_text('{"ownerEmail":NaN}', encoding="utf-8")
            config_path.chmod(0o600)
            with self.assertRaisesRegex(core.ProvisionerError, "malformed"):
                core.load_config(config_path)
            config_path.write_text("[" * 1100 + "]" * 1100, encoding="utf-8")
            with self.assertRaisesRegex(core.ProvisionerError, "malformed"):
                core.load_config(config_path)
            config_path.write_text('{"ownerEmail":1e400}', encoding="utf-8")
            config_path.chmod(0o600)
            with self.assertRaisesRegex(core.ProvisionerError, "malformed"):
                core.load_config(config_path)


class ProvisionerStateTests(unittest.TestCase):
    def test_empty_xdg_state_home_uses_the_standard_default(self) -> None:
        with mock.patch.dict(os.environ, {"XDG_STATE_HOME": ""}):
            self.assertEqual(_default_state_dir(), Path.home() / ".local" / "state" / "mycoupons")

    def test_state_rejects_a_directory_inside_the_git_worktree(self) -> None:
        with self.assertRaisesRegex(core.ProvisionerError, "outside the Git worktree"):
            core.ensure_state_dir(ROOT / "private-state-forbidden")
        with tempfile.TemporaryDirectory() as temporary:
            worktree = Path(temporary) / "other-worktree"
            worktree.mkdir()
            (worktree / ".git").write_text("gitdir: /private/elsewhere\n", encoding="utf-8")
            original = Path.cwd()
            try:
                os.chdir(Path(temporary).parent)
                with self.assertRaisesRegex(core.ProvisionerError, "outside the Git worktree"):
                    core.ensure_state_dir(worktree / "private-state-forbidden")
            finally:
                os.chdir(original)
        with tempfile.TemporaryDirectory() as temporary:
            linked_root = Path(temporary) / "linked-root"
            linked_root.symlink_to(ROOT / "src", target_is_directory=True)
            with self.assertRaisesRegex(core.ProvisionerError, "outside the Git worktree"):
                core.ensure_state_dir(linked_root / "locales" / "private-state-forbidden")

    def test_state_creates_missing_private_parents(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            private_json(config_path, valid_config())
            config = core.load_config(config_path)
            state_dir = root / "missing" / "nested" / "state"
            core.initialize_state(state_dir, config)
            self.assertEqual(stat.S_IMODE((root / "missing").stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((root / "missing" / "nested").stat().st_mode), 0o700)

    def test_state_is_resumable_and_bound_to_config_and_private_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            private_json(config_path, valid_config())
            config = core.load_config(config_path)
            state_dir = root / "state"
            first = core.initialize_state(state_dir, config)
            second = core.initialize_state(state_dir, config)
            self.assertEqual(first["installationId"], second["installationId"])
            self.assertEqual(stat.S_IMODE((state_dir / "state.json").stat().st_mode), 0o600)
            changed = dict(config)
            changed["labelName"] = "Other"
            with self.assertRaisesRegex(core.ProvisionerError, "does not match"):
                core.initialize_state(state_dir, changed)
            tampered = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
            tampered["configDigest"] = "0" * 64
            private_json(state_dir / "state.json", tampered)
            with self.assertRaisesRegex(core.ProvisionerError, "not bound"):
                core.initialize_state(state_dir, config)

    def test_state_integrity_proof_covers_resumable_phase_and_bundle_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            private_json(config_path, valid_config())
            config = core.load_config(config_path)
            state_dir = root / "state"
            core.initialize_state(state_dir, config)
            state_path = state_dir / "state.json"
            tampered = json.loads(state_path.read_text(encoding="utf-8"))
            tampered["phase"] = "bundle-validated"
            tampered["bundleDigest"] = "0" * 64
            private_json(state_path, tampered)
            with self.assertRaisesRegex(core.ProvisionerError, "not bound"):
                core.initialize_state(state_dir, config)

    def test_signed_v1_state_migrates_without_losing_its_bundle_phase(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            private_json(config_path, valid_config())
            config = core.load_config(config_path)
            state_dir = root / "state"
            core.initialize_state(state_dir, config)
            core.mark_bundle_validated(state_dir, config, "a" * 64)
            state_path = state_dir / "state.json"
            v2 = json.loads(state_path.read_text(encoding="utf-8"))
            v1 = {key: value for key, value in v2.items() if key != "cloud"}
            v1["version"] = 1
            key = core._read_private_bytes(state_dir / "identity.key", maximum_bytes=32)
            v1["configDigest"] = core._legacy_installer_config_digest(config)
            v1["identityProof"] = core._identity_proof_v1(key, v1)
            private_json(state_path, v1)
            migrated = core.initialize_state(state_dir, config)
            self.assertEqual(migrated["version"], core.STATE_VERSION)
            self.assertEqual(migrated["phase"], "bundle-validated")
            self.assertEqual(migrated["cloud"], {"developer": None, "vertex": None})
            self.assertEqual(migrated["configDigest"], core.config_digest(config))
            cloud_config = valid_cloud_config()
            upgraded = core.initialize_state(state_dir, cloud_config)
            self.assertEqual(upgraded["configDigest"], core.config_digest(cloud_config))
            changed_cloud_config = valid_cloud_config()
            changed_cloud_config["cloudInstallationId"] = "another-installation"
            with self.assertRaisesRegex(core.ProvisionerError, "does not match"):
                core.initialize_state(state_dir, changed_cloud_config)

            existing_developer = valid_config()
            existing_developer["developerProject"] = "developer-project"
            state_dir = root / "existing-developer-state"
            core.initialize_state(state_dir, existing_developer)
            core.mark_bundle_validated(state_dir, existing_developer, "b" * 64)
            upgraded_existing = dict(existing_developer)
            upgraded_existing.update({"vertexBillingAccount": "ABCDEF-123456-ABCDEF", "cloudInstallationId": "installation-demo"})
            self.assertEqual(core.initialize_state(state_dir, upgraded_existing)["configDigest"], core.config_digest(upgraded_existing))

    def test_state_resume_status_is_decided_under_the_installation_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            private_json(config_path, valid_config())
            config = core.load_config(config_path)
            state_dir = root / "state"
            _state, resumed = core.initialize_state_with_status(state_dir, config)
            self.assertFalse(resumed)
            _state, resumed = core.initialize_state_with_status(state_dir, config)
            self.assertTrue(resumed)

    def test_identity_key_uses_a_bounded_private_read(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            private_json(config_path, valid_config())
            config = core.load_config(config_path)
            state_dir = root / "state"
            core.initialize_state(state_dir, config)
            key_path = state_dir / "identity.key"
            key_path.write_bytes(b"x" * 33)
            key_path.chmod(0o600)
            with self.assertRaisesRegex(core.ProvisionerError, "too large"):
                core.initialize_state(state_dir, config)

    def test_private_special_files_fail_without_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            fifo_path = Path(temporary) / "config.fifo"
            os.mkfifo(fifo_path, 0o600)
            with self.assertRaisesRegex(core.ProvisionerError, "regular mode-0600"):
                core.load_config(fifo_path)

    def test_state_rejects_non_string_bundle_digest(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            private_json(config_path, valid_config())
            config = core.load_config(config_path)
            state_dir = root / "state"
            core.initialize_state(state_dir, config)
            state_path = state_dir / "state.json"
            state = json.loads(state_path.read_text(encoding="utf-8"))
            state["bundleDigest"] = 42
            private_json(state_path, state)
            with self.assertRaisesRegex(core.ProvisionerError, "bundle digest"):
                core.initialize_state(state_dir, config)

    def test_state_rejects_non_string_phase(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            private_json(config_path, valid_config())
            config = core.load_config(config_path)
            state_dir = root / "state"
            core.initialize_state(state_dir, config)
            state_path = state_dir / "state.json"
            state = json.loads(state_path.read_text(encoding="utf-8"))
            state["phase"] = []
            private_json(state_path, state)
            with self.assertRaisesRegex(core.ProvisionerError, "version or phase"):
                core.initialize_state(state_dir, config)

    def test_state_rejects_symlink_and_nonblocking_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            private_json(config_path, valid_config())
            config = core.load_config(config_path)
            state_dir = root / "state"
            core.initialize_state(state_dir, config)
            with core.InstallationLock(state_dir):
                with self.assertRaisesRegex(core.ProvisionerError, "already running"):
                    with core.InstallationLock(state_dir):
                        pass
            link = root / "link"
            link.symlink_to(state_dir, target_is_directory=True)
            with self.assertRaisesRegex(core.ProvisionerError, "symlink"):
                core.initialize_state(link, config)

    def test_lock_rejects_a_special_file_without_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            state_dir = Path(temporary) / "state"
            state_dir.mkdir(mode=0o700)
            lock_path = state_dir / "install.lock"
            os.mkfifo(lock_path, 0o600)
            reader = os.open(lock_path, os.O_RDONLY | os.O_NONBLOCK)
            try:
                with self.assertRaisesRegex(core.ProvisionerError, "regular mode-0600"):
                    with core.InstallationLock(state_dir):
                        pass
            finally:
                os.close(reader)


class ProvisionerCloudTests(unittest.TestCase):
    def _bundle_validated_state(self, root: Path, config: dict[str, object]) -> Path:
        state_dir = root / "state"
        core.initialize_state(state_dir, config)
        core.mark_bundle_validated(state_dir, config, "a" * 64)
        return state_dir

    def _cloud_command_responder(self, resources: dict[str, dict[str, object]], billing: dict[str, dict[str, object]], services: set[tuple[str, str]]):
        def response(command: tuple[str, ...], **_kwargs: object) -> object:
            if command[1:3] == ("auth", "list"):
                return [{"account": "owner@example.com", "status": "ACTIVE"}]
            if command[1:3] == ("projects", "describe"):
                project_id = command[3]
                if project_id not in resources:
                    raise core.ProjectNotFound("Cloud project was not found")
                return resources[project_id]
            if command[1:3] == ("projects", "get-iam-policy"):
                return {"bindings": [{"role": "roles/owner", "members": ["user:owner@example.com"]}]}
            if command[1:4] == ("billing", "projects", "describe"):
                return {"projectId": command[4], **billing[command[4]]}
            if command[1:4] == ("billing", "accounts", "describe"):
                return {"name": f"billingAccounts/{command[4]}", "open": True}
            if command[1:3] == ("services", "list"):
                project_id = next(part.removeprefix("--project=") for part in command if part.startswith("--project="))
                service = next(part.removeprefix("--filter=config.name=") for part in command if part.startswith("--filter=config.name="))
                return [{"config": {"name": service}}] if (project_id, service) in services else []
            raise AssertionError(command)

        return response

    def test_cloud_provision_creates_resumes_and_never_relinks_billed_resources(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = valid_cloud_config()
            config["ownerEmail"] = "Owner@example.com"
            state_dir = self._bundle_validated_state(root, config)
            resources: dict[str, dict[str, object]] = {}
            billing = {
                "developer-project": {"billingEnabled": False, "billingAccountName": ""},
                "vertex-project": {"billingEnabled": False, "billingAccountName": ""},
            }
            services: set[tuple[str, str]] = set()
            commands: list[tuple[str, ...]] = []

            def mutate(command: tuple[str, ...], **_kwargs: object) -> None:
                commands.append(command)
                if command[1:3] == ("projects", "create"):
                    project_id = command[3]
                    labels = next(part.removeprefix("--labels=") for part in command if part.startswith("--labels="))
                    resources[project_id] = {
                        "projectId": project_id,
                        "projectNumber": "123456" if project_id == "developer-project" else "654321",
                        "lifecycleState": "ACTIVE",
                        "labels": dict(item.split("=", 1) for item in labels.split(",")),
                    }
                    return
                if command[1:4] == ("billing", "projects", "link"):
                    project_id = command[4]
                    billing[project_id] = {
                        "billingEnabled": True,
                        "billingAccountName": f"billingAccounts/{command[5].removeprefix('--billing-account=')}",
                    }
                    return
                if command[1:3] == ("services", "enable"):
                    services.add((next(part.removeprefix("--project=") for part in command if part.startswith("--project=")), command[3]))
                    return
                raise AssertionError(command)

            responder = self._cloud_command_responder(resources, billing, services)
            with mock.patch("provisioner.core.discover_tools", return_value={"gcloud": "/safe/gcloud"}), mock.patch(
                "provisioner.core._run_json", side_effect=responder
            ) as run_json, mock.patch("provisioner.core._run_success", side_effect=mutate):
                state = core.provision_cloud(state_dir, config)
            self.assertEqual(state["phase"], "cloud-ready")
            self.assertEqual(state["cloud"]["developer"]["provenance"], "created")
            self.assertEqual(state["cloud"]["vertex"]["provenance"], "created")
            self.assertIn(
                (
                    "/safe/gcloud",
                    "billing",
                    "projects",
                    "link",
                    "vertex-project",
                    "--billing-account=ABCDEF-123456-ABCDEF",
                    "--quiet",
                    "--account=owner@example.com",
                ),
                commands,
            )
            self.assertEqual({service for _project, service in services}, set(core.DEVELOPER_SERVICES + core.VERTEX_SERVICES))
            remote_reads = [call.args[0] for call in run_json.call_args_list if call.args[0][1:3] != ("auth", "list")]
            self.assertTrue(all("--account=owner@example.com" in command for command in remote_reads))
            self.assertTrue(all("--account=owner@example.com" in command for command in commands))
            commands.clear()
            with mock.patch("provisioner.core.discover_tools", return_value={"gcloud": "/safe/gcloud"}), mock.patch(
                "provisioner.core._run_json", side_effect=responder
            ), mock.patch("provisioner.core._run_success", side_effect=mutate):
                resumed = core.provision_cloud(state_dir, config)
            self.assertEqual(resumed["phase"], "cloud-ready")
            self.assertEqual(commands, [])

    def test_cloud_provision_rejects_foreign_labels_and_billed_developer_before_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = valid_cloud_config()
            state_dir = self._bundle_validated_state(root, config)
            resources = {
                "developer-project": {
                    "projectId": "developer-project",
                    "projectNumber": "123456",
                    "lifecycleState": "ACTIVE",
                    "labels": {core.CLOUD_INSTALLATION_LABEL: "other-installation", core.CLOUD_ROLE_LABEL: "developer"},
                }
            }
            billing = {
                "developer-project": {"billingEnabled": True, "billingAccountName": "billingAccounts/OTHER"},
                "vertex-project": {"billingEnabled": False, "billingAccountName": ""},
            }
            responder = self._cloud_command_responder(resources, billing, set())
            with mock.patch("provisioner.core.discover_tools", return_value={"gcloud": "/safe/gcloud"}), mock.patch(
                "provisioner.core._run_json", side_effect=responder
            ), mock.patch("provisioner.core._run_success") as mutate:
                with self.assertRaisesRegex(core.ProvisionerError, "eligible"):
                    core.provision_cloud(state_dir, config)
            mutate.assert_not_called()

            resources["developer-project"]["labels"] = {
                core.CLOUD_INSTALLATION_LABEL: "installation-demo",
                core.CLOUD_ROLE_LABEL: "developer",
            }
            with mock.patch("provisioner.core.discover_tools", return_value={"gcloud": "/safe/gcloud"}), mock.patch(
                "provisioner.core._run_json", side_effect=responder
            ), mock.patch("provisioner.core._run_success") as mutate:
                with self.assertRaisesRegex(core.ProvisionerError, "unbilled"):
                    core.provision_cloud(state_dir, config)
            mutate.assert_not_called()

    def test_cloud_creation_intent_is_signed_before_a_failed_create_can_be_retried(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = valid_cloud_config()
            state_dir = self._bundle_validated_state(root, config)
            responder = self._cloud_command_responder(
                {},
                {
                    "developer-project": {"billingEnabled": False, "billingAccountName": ""},
                    "vertex-project": {"billingEnabled": False, "billingAccountName": ""},
                },
                set(),
            )
            with mock.patch("provisioner.core.discover_tools", return_value={"gcloud": "/safe/gcloud"}), mock.patch(
                "provisioner.core._run_json", side_effect=responder
            ), mock.patch("provisioner.core._run_success", side_effect=core.ProvisionerError("Cloud project creation was rejected")):
                with self.assertRaisesRegex(core.ProvisionerError, "creation was rejected"):
                    core.provision_cloud(state_dir, config)
            state = core.initialize_state(state_dir, config)
            self.assertEqual(
                state["cloud"]["developer"],
                {"projectId": "developer-project", "projectNumber": None, "provenance": "creating"},
            )
            self.assertIsNone(state["cloud"]["vertex"])

    def test_cloud_provision_does_not_create_after_an_unclassified_project_inspection_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = valid_cloud_config()
            state_dir = self._bundle_validated_state(root, config)

            def rejected_inspection(command: tuple[str, ...], **_kwargs: object) -> object:
                if command[1:3] == ("auth", "list"):
                    return [{"account": "owner@example.com", "status": "ACTIVE"}]
                raise core.ProvisionerError("Cloud project inspection was rejected")

            with mock.patch("provisioner.core.discover_tools", return_value={"gcloud": "/safe/gcloud"}), mock.patch(
                "provisioner.core._run_json", side_effect=rejected_inspection
            ), mock.patch("provisioner.core._run_success") as mutate:
                with self.assertRaisesRegex(core.ProvisionerError, "inspection was rejected"):
                    core.provision_cloud(state_dir, config)
            mutate.assert_not_called()

    def test_cloud_provision_rejects_an_open_billing_subaccount_before_linkage(self) -> None:
        with mock.patch(
            "provisioner.core._run_json",
            return_value={
                "name": "billingAccounts/ABCDEF-123456-ABCDEF",
                "open": True,
                "masterBillingAccount": "billingAccounts/PARENT",
            },
        ), mock.patch("provisioner.core._run_success") as mutate:
            with self.assertRaisesRegex(core.ProvisionerError, "selected billing account"):
                core._reconcile_vertex_billing(
                    "/safe/gcloud",
                    "vertex-project",
                    "ABCDEF-123456-ABCDEF",
                    installation_label="installation-demo",
                    expected_owner="owner@example.com",
                    persisted={"projectId": "vertex-project", "projectNumber": "654321", "provenance": "created"},
                )
        mutate.assert_not_called()

    def test_cloud_config_requires_distinct_projects_billing_and_adoption_identity(self) -> None:
        config = valid_cloud_config()
        core.validate_cloud_config(config)
        for key, value in (("developerProject", ""), ("vertexBillingAccount", ""), ("cloudInstallationId", "short")):
            invalid = valid_cloud_config()
            invalid[key] = value
            with self.assertRaises(core.ProvisionerError):
                core.validate_cloud_config(invalid)
        same = valid_cloud_config()
        same["vertexProject"] = same["developerProject"]
        with self.assertRaisesRegex(core.ProvisionerError, "distinct"):
            core.validate_cloud_config(same)
        trailing_hyphen = valid_cloud_config()
        trailing_hyphen["cloudInstallationId"] = "installation-demo-"
        with self.assertRaisesRegex(core.ProvisionerError, "Cloud installation identity"):
            core.validate_cloud_config(trailing_hyphen)


class ProvisionerBundleTests(unittest.TestCase):
    def test_bundle_digest_is_deterministic_and_manifest_contract_is_checked(self) -> None:
        source = ROOT / "src"
        first = core.validate_bundle(source)
        self.assertRegex(first, r"^[0-9a-f]{64}$")
        self.assertEqual(first, core.validate_bundle(source))
        with tempfile.TemporaryDirectory() as temporary:
            source_link = Path(temporary) / "source-link"
            source_link.symlink_to(source, target_is_directory=True)
            with self.assertRaisesRegex(core.ProvisionerError, "symlink"):
                core.validate_bundle(source_link)
            source_alias = Path(temporary) / "source-alias"
            source_alias.symlink_to(ROOT, target_is_directory=True)
            self.assertEqual(first, core.validate_bundle(source_alias / "src"))
            copied = Path(temporary) / "src"
            shutil_copytree(source, copied)
            manifest = json.loads((copied / "appsscript.json").read_text(encoding="utf-8"))
            manifest["executionApi"] = {"access": "ANYONE"}
            (copied / "appsscript.json").write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(core.ProvisionerError, "access"):
                core.validate_bundle(copied)
            manifest["executionApi"] = {"access": "MYSELF"}
            manifest["webapp"] = {"access": "ANYONE_ANONYMOUS"}
            (copied / "appsscript.json").write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(core.ProvisionerError, "access"):
                core.validate_bundle(copied)
            del manifest["webapp"]
            (copied / "Injected.gs").write_text("const changed = true;\n", encoding="utf-8")
            manifest["executionApi"] = {"access": "MYSELF"}
            (copied / "appsscript.json").write_text(json.dumps(manifest), encoding="utf-8")
            self.assertNotEqual(first, core.validate_bundle(copied))
            gs_digest = core.validate_bundle(copied)
            (copied / "Injected.js").write_text("const changedJs = true;\n", encoding="utf-8")
            self.assertNotEqual(gs_digest, core.validate_bundle(copied))
            (copied / "Injected.js").unlink()
            (copied / "Injected.html").write_text("<p>changed</p>\n", encoding="utf-8")
            html_digest = core.validate_bundle(copied)
            self.assertNotEqual(gs_digest, html_digest)
            with self.assertRaisesRegex(core.ProvisionerError, "path is not valid Unicode"):
                core._bundle_digest({"invalid-\udcff.gs": b"const invalid = true;\n"})
            original_loads = core.json.loads

            def replace_manifest_after_capture(payload: str, **kwargs: object) -> object:
                manifest["executionApi"] = {"access": "ANYONE"}
                (copied / "appsscript.json").write_text(json.dumps(manifest), encoding="utf-8")
                return original_loads(payload, **kwargs)

            with mock.patch("provisioner.core.json.loads", side_effect=replace_manifest_after_capture):
                self.assertEqual(html_digest, core.validate_bundle(copied))
            outside = Path(temporary) / "outside.gs"
            outside.write_text("const escaped = true;\n", encoding="utf-8")
            original_iter = core._iter_bundle_files

            def replace_listed_file(source_dir: Path):
                for listed_path in original_iter(source_dir):
                    if listed_path.name == "Injected.html":
                        listed_path.unlink()
                        listed_path.symlink_to(outside)
                    yield listed_path

            with mock.patch("provisioner.core._iter_bundle_files", side_effect=replace_listed_file):
                with self.assertRaisesRegex(core.ProvisionerError, "cannot be read"):
                    core.validate_bundle(copied)
            (copied / "Injected.html").unlink()
            (copied / "Injected.html").write_text("<p>changed</p>\n", encoding="utf-8")
            manifest["executionApi"] = {"access": "MYSELF"}
            (copied / "appsscript.json").write_text(json.dumps(manifest), encoding="utf-8")
            nested_directory = copied / "inside"
            nested_directory.mkdir()
            nested_file = nested_directory / "payload.gs"
            nested_file.write_text("const inside = true;\n", encoding="utf-8")
            outside_directory = Path(temporary) / "outside-directory"
            outside_directory.mkdir()
            (outside_directory / "payload.gs").write_text("const outside = true;\n", encoding="utf-8")

            def replace_listed_directory(source_dir: Path):
                for listed_path in original_iter(source_dir):
                    if listed_path.name == "payload.gs":
                        nested_directory.rename(copied / "inside-original")
                        nested_directory.symlink_to(outside_directory, target_is_directory=True)
                    yield listed_path

            with mock.patch("provisioner.core._iter_bundle_files", side_effect=replace_listed_directory):
                with self.assertRaisesRegex(core.ProvisionerError, "cannot be read"):
                    core.validate_bundle(copied)
            nested_directory.unlink()
            (copied / "inside-original").rename(nested_directory)
            (copied / "appsscript.json").write_text('{"exceptionLogging":NaN}', encoding="utf-8")
            with self.assertRaisesRegex(core.ProvisionerError, "malformed"):
                core.validate_bundle(copied)
            manifest["executionApi"] = {"access": "MYSELF"}
            (copied / "appsscript.json").write_text(json.dumps(manifest), encoding="utf-8")
            overflowing_manifest = json.dumps(manifest)[:-1] + ',"unvalidated":1e400}'
            (copied / "appsscript.json").write_text(overflowing_manifest, encoding="utf-8")
            with self.assertRaisesRegex(core.ProvisionerError, "malformed"):
                core.validate_bundle(copied)
            (copied / "appsscript.json").write_text(json.dumps(manifest), encoding="utf-8")
            (copied / "Installer.gs").write_text('// function bootstrapFromSecret(\n"function bootstrapFromSecret("\nnew /}/.test(\'\');\nfunction outer() { function bootstrapFromSecret() {} }\n', encoding="utf-8")
            with self.assertRaisesRegex(core.ProvisionerError, "bootstrapFromSecret"):
                core.validate_bundle(copied)

    def test_bundle_validation_holds_the_installation_lock_until_state_is_written(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            private_json(config_path, valid_config())
            config = core.load_config(config_path)
            state_dir = root / "state"
            original_validate = core.validate_bundle

            def validate_while_locked(source_dir: Path) -> str:
                with self.assertRaisesRegex(core.ProvisionerError, "already running"):
                    with core.InstallationLock(state_dir):
                        pass
                return original_validate(source_dir)

            with mock.patch("provisioner.core.validate_bundle", side_effect=validate_while_locked):
                digest, state = core.validate_and_mark_bundle(state_dir, config, ROOT / "src")
            self.assertEqual(state["bundleDigest"], digest)

    def test_bundle_rejects_invalid_text_large_files_and_late_file_additions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            copied = Path(temporary) / "src"
            shutil_copytree(ROOT / "src", copied)
            invalid = copied / "Invalid.js"
            invalid.write_bytes(b"const invalid = '\xff';\n")
            with self.assertRaisesRegex(core.ProvisionerError, "valid UTF-8"):
                core.validate_bundle(copied)
            invalid.unlink()
            large = copied / "Large.gs"
            large.write_bytes(b"x" * (core.MAX_BUNDLE_FILE_BYTES + 1))
            with self.assertRaisesRegex(core.ProvisionerError, "too large"):
                core.validate_bundle(copied)
            large.unlink()
            original_read = core._read_bundle_file
            late_file = copied / "Late.js"

            def add_file_during_capture(*args: object, **kwargs: object) -> bytes:
                content = original_read(*args, **kwargs)
                relative = args[1]
                if isinstance(relative, Path) and relative.name == "appsscript.json":
                    late_file.write_text("const late = true;\n", encoding="utf-8")
                return content

            with mock.patch("provisioner.core._read_bundle_file", side_effect=add_file_during_capture):
                with self.assertRaisesRegex(core.ProvisionerError, "changed during validation"):
                    core.validate_bundle(copied)
            late_file.unlink()
            base_size = sum(path.stat().st_size for path in core._iter_bundle_files(copied))
            (copied / "Fill.js").write_bytes(b"x" * 8)
            (copied / "ZZEmpty.js").write_bytes(b"")
            with mock.patch.object(core, "MAX_BUNDLE_TOTAL_BYTES", base_size + 8):
                self.assertRegex(core.validate_bundle(copied), r"^[0-9a-f]{64}$")
            original_iter = core._iter_bundle_files
            iterations = 0

            def replace_after_capture(source_dir: Path):
                nonlocal iterations
                iterations += 1
                if iterations == 2:
                    config_source = copied / "Config.gs"
                    config_source.write_text(config_source.read_text(encoding="utf-8") + "\nconst changed = true;\n", encoding="utf-8")
                return original_iter(source_dir)

            with mock.patch("provisioner.core._iter_bundle_files", side_effect=replace_after_capture):
                with self.assertRaisesRegex(core.ProvisionerError, "changed during validation"):
                    core.validate_bundle(copied)
            with mock.patch.object(core, "MAX_BUNDLE_FILES", 1):
                with self.assertRaisesRegex(core.ProvisionerError, "too many files"):
                    core.validate_bundle(copied)

    def test_bundle_rejects_a_traversal_error(self) -> None:
        def inaccessible_walk(*_args: object, **kwargs: object) -> object:
            onerror = kwargs["onerror"]
            assert callable(onerror)
            onerror(PermissionError("unreadable"))
            return iter(())

        with mock.patch("provisioner.core.os.walk", side_effect=inaccessible_walk), self.assertRaisesRegex(
            core.ProvisionerError, "cannot be traversed"
        ):
            list(core._iter_bundle_files(ROOT / "src"))


def shutil_copytree(source: Path, target: Path) -> None:
    import shutil

    shutil.copytree(source, target)


class ProvisionerCommandTests(unittest.TestCase):
    def test_oauth_command_targets_the_active_gcloud_credential_store(self) -> None:
        self.assertEqual(
            core.oauth_authorization_command(),
            "gcloud auth login --update-adc",
        )

    def test_tool_discovery_returns_a_canonical_executable_path_without_running_it(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "real"
            target.write_text("", encoding="utf-8")
            target.chmod(0o700)
            link = Path(temporary) / "gcloud"
            link.symlink_to(target)
            with mock.patch("provisioner.core.shutil.which", return_value=str(link)):
                self.assertEqual(core.discover_tools(("gcloud",)), {"gcloud": str(target.resolve())})

    def test_identity_preflight_parses_only_expected_json_and_redacts_failure_output(self) -> None:
        with mock.patch("provisioner.core.discover_tools", return_value={"gcloud": "/safe/gcloud"}), mock.patch(
            "provisioner.core._run_json",
            side_effect=[
                [{"account": "owner@example.com", "status": "ACTIVE"}],
                {"projectId": "vertex-project"},
            ],
        ) as run_json:
            result = core.authenticated_identity_preflight("owner@example.com", "vertex-project")
        self.assertEqual(result, {"ownerMatched": True, "projectReadable": True})
        self.assertNotIn("owner@example.com", json.dumps(result))
        self.assertNotIn("vertex-project", json.dumps(result))
        self.assertEqual(run_json.call_args_list[1].args[0][1:4], ("projects", "describe", "vertex-project"))
        with mock.patch("provisioner.core.discover_tools", return_value={"gcloud": "/safe/gcloud"}), mock.patch(
            "provisioner.core._run_json", return_value=[{"account": "owner@example.com", "status": "ACTIVE"}, {"status": "ACTIVE"}]
        ):
            with self.assertRaisesRegex(core.ProvisionerError, "unexpected accounts"):
                core.authenticated_identity_preflight("owner@example.com", "vertex-project")
        with mock.patch("provisioner.core.discover_tools", return_value={"gcloud": "/safe/gcloud"}), mock.patch(
            "provisioner.core._run_json", return_value=[{"account": "owner@strasse.de", "status": "ACTIVE"}]
        ):
            with self.assertRaisesRegex(core.ProvisionerError, "does not match"):
                core.authenticated_identity_preflight("owner@ſtrasse.de", "vertex-project")

    def test_preflight_command_output_is_bounded_and_redacted(self) -> None:
        invalid_json = (sys.executable, "-c", "import sys; sys.stdout.write('not json'); sys.stderr.write('secret=never-show')")
        with self.assertRaisesRegex(core.ProvisionerError, "unexpected output") as raised:
            core._run_json(invalid_json)
        self.assertNotIn("secret", str(raised.exception))
        excessive_output = (sys.executable, "-c", f"import sys; sys.stdout.buffer.write(b'x' * {core.MAX_COMMAND_OUTPUT_BYTES + 1})")
        with self.assertRaisesRegex(core.ProvisionerError, "unexpected output"):
            core._run_json(excessive_output)
        nonstandard_constant = (sys.executable, "-c", "import sys; sys.stdout.write('{\\\"account\\\":NaN}')")
        with self.assertRaisesRegex(core.ProvisionerError, "unexpected output"):
            core._run_json(nonstandard_constant)
        overflowing_number = (sys.executable, "-c", "import sys; sys.stdout.write('{\\\"unvalidated\\\":1e400}')")
        with self.assertRaisesRegex(core.ProvisionerError, "unexpected output"):
            core._run_json(overflowing_number)

    def test_project_not_found_classifier_accepts_only_the_exact_gcloud_error(self) -> None:
        project_id = "developer-project"
        self.assertTrue(
            core._gcloud_reports_project_not_found(
                b"ERROR: (gcloud.projects.describe) [developer-project] not found\n", project_id
            )
        )
        self.assertTrue(
            core._gcloud_reports_project_not_found(
                b"ERROR: (gcloud.projects.describe) [developer-project] not found.\n", project_id
            )
        )
        for response in (
            b"ERROR: (gcloud.projects.describe) [developer-project] not found or permission denied\n",
            b"ERROR: (gcloud.projects.describe) developer-project not found while impersonation is unavailable\n",
            b"ERROR: (gcloud.projects.describe) PERMISSION_DENIED\n",
        ):
            self.assertFalse(core._gcloud_reports_project_not_found(response, project_id))

    def test_cli_rejects_secret_like_config_output(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config_path = root / "config.json"
            private_json(config_path, valid_config())
            state_dir = root / "state"
            with mock.patch("sys.stdout") as stdout:
                exit_code = main(["--state-dir", str(state_dir), "initialize", "--config", str(config_path)])
            self.assertEqual(exit_code, 0)
            output = "".join(str(call.args[0]) for call in stdout.write.call_args_list)
            self.assertNotIn("owner@example.com", output)
            self.assertNotIn("vertex-project", output)


if __name__ == "__main__":
    unittest.main()
