"""Regression tests for the local-only provisioner foundation."""

from __future__ import annotations

import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from provisioner import core
from provisioner.cli import main


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
        "vertexLocation": "global",
        "model": "gemini-flash-latest",
        "autoVertexFallback": False,
        "fetchRemoteImages": True,
    }


class ProvisionerConfigTests(unittest.TestCase):
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
            bad["autoVertexFallback"] = True
            private_json(config_path, bad)
            with self.assertRaisesRegex(core.ProvisionerError, "requires"):
                core.load_config(config_path)
            valid_short_location = valid_config()
            valid_short_location["vertexLocation"] = "us"
            private_json(config_path, valid_short_location)
            self.assertEqual(core.load_config(config_path)["vertexLocation"], "us")


class ProvisionerStateTests(unittest.TestCase):
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


class ProvisionerBundleTests(unittest.TestCase):
    def test_bundle_digest_is_deterministic_and_manifest_contract_is_checked(self) -> None:
        source = ROOT / "src"
        first = core.validate_bundle(source)
        self.assertRegex(first, r"^[0-9a-f]{64}$")
        self.assertEqual(first, core.validate_bundle(source))
        with tempfile.TemporaryDirectory() as temporary:
            source_link = Path(temporary) / "source-link"
            source_link.symlink_to(source, target_is_directory=True)
            with self.assertRaisesRegex(core.ProvisionerError, "real directory"):
                core.validate_bundle(source_link)
            copied = Path(temporary) / "src"
            shutil_copytree(source, copied)
            manifest = json.loads((copied / "appsscript.json").read_text(encoding="utf-8"))
            manifest["executionApi"] = {"access": "ANYONE"}
            (copied / "appsscript.json").write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(core.ProvisionerError, "access"):
                core.validate_bundle(copied)
            (copied / "Injected.gs").write_text("const changed = true;\n", encoding="utf-8")
            manifest["executionApi"] = {"access": "MYSELF"}
            (copied / "appsscript.json").write_text(json.dumps(manifest), encoding="utf-8")
            self.assertNotEqual(first, core.validate_bundle(copied))
            gs_digest = core.validate_bundle(copied)
            (copied / "Injected.html").write_text("<p>changed</p>\n", encoding="utf-8")
            html_digest = core.validate_bundle(copied)
            self.assertNotEqual(gs_digest, html_digest)
            original_loads = core.json.loads

            def replace_manifest_after_capture(payload: str, **kwargs: object) -> object:
                manifest["executionApi"] = {"access": "ANYONE"}
                (copied / "appsscript.json").write_text(json.dumps(manifest), encoding="utf-8")
                return original_loads(payload, **kwargs)

            with mock.patch("provisioner.core.json.loads", side_effect=replace_manifest_after_capture):
                self.assertEqual(html_digest, core.validate_bundle(copied))


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
        commands: list[tuple[str, ...]] = []

        def fake_run(command: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
            commands.append(tuple(command))
            if "auth" in command:
                return subprocess.CompletedProcess(command, 0, '[{"account":"owner@example.com","status":"ACTIVE"}]', "token=private")
            return subprocess.CompletedProcess(command, 0, '{"projectId":"vertex-project"}', "")

        with mock.patch("provisioner.core.discover_tools", return_value={"gcloud": "/safe/gcloud"}), mock.patch("provisioner.core.subprocess.run", side_effect=fake_run):
            result = core.authenticated_identity_preflight("owner@example.com", "vertex-project")
        self.assertEqual(result, {"ownerMatched": True, "projectReadable": True})
        self.assertNotIn("owner@example.com", json.dumps(result))
        self.assertNotIn("vertex-project", json.dumps(result))
        self.assertEqual(commands[1][1:4], ("projects", "describe", "vertex-project"))
        with mock.patch("provisioner.core.discover_tools", return_value={"gcloud": "/safe/gcloud"}), mock.patch(
            "provisioner.core.subprocess.run", return_value=subprocess.CompletedProcess(("gcloud",), 0, "not json", "secret=never-show")
        ):
            with self.assertRaisesRegex(core.ProvisionerError, "unexpected output") as raised:
                core.authenticated_identity_preflight("owner@example.com", "vertex-project")
        self.assertNotIn("secret", str(raised.exception))
        with mock.patch("provisioner.core.discover_tools", return_value={"gcloud": "/safe/gcloud"}), mock.patch(
            "provisioner.core.subprocess.run", return_value=subprocess.CompletedProcess(("gcloud",), 0, '[{"account":"one","account":"two"}]', "")
        ):
            with self.assertRaisesRegex(core.ProvisionerError, "unexpected output"):
                core.authenticated_identity_preflight("owner@example.com", "vertex-project")

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
