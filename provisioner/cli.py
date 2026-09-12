"""Command-line interface for the local-only MyCoupons provisioning foundation."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Sequence

from .core import (
    ProvisionerError,
    authenticated_identity_preflight,
    deploy_apps_script,
    discover_tools,
    initialize_state_with_status,
    load_config,
    oauth_authorization_command,
    provision_cloud,
    validate_and_mark_bundle,
)


def _default_state_dir() -> Path:
    state_home = os.environ.get("XDG_STATE_HOME") or (Path.home() / ".local" / "state")
    return Path(state_home) / "mycoupons"


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="mycoupons-provisioner", description="Local-only MyCoupons provisioning foundation")
    parser.add_argument("--state-dir", type=Path, default=_default_state_dir(), help="private local state directory (default: %(default)s)")
    subcommands = parser.add_subparsers(dest="command", required=True)
    initialize = subcommands.add_parser("initialize", help="validate config and initialize/resume local state")
    initialize.add_argument("--config", type=Path, required=True)
    bundle = subcommands.add_parser("validate-bundle", help="validate and digest the Apps Script source bundle")
    bundle.add_argument("--config", type=Path, required=True)
    bundle.add_argument("--source-dir", type=Path, default=Path("src"))
    subcommands.add_parser("oauth-command", help="print the exact OAuth command for local gcloud preflight")
    subcommands.add_parser("tools", help="safely inspect local deployment-tool availability")
    preflight = subcommands.add_parser("preflight-identity", help="perform harmless authenticated identity and project reads")
    preflight.add_argument("--config", type=Path, required=True)
    preflight.add_argument("--project-id", required=True, help="Cloud project to inspect without mutation")
    cloud = subcommands.add_parser("provision-cloud", help="create or adopt the labelled Cloud projects and reconcile required services")
    cloud.add_argument("--config", type=Path, required=True)
    deploy = subcommands.add_parser("deploy-apps-script", help="deploy and securely bootstrap one private Apps Script installation")
    deploy.add_argument("--config", type=Path, required=True)
    deploy.add_argument("--source-dir", type=Path, default=Path("src"))
    deploy.add_argument("--clasp-auth", type=Path, required=True, help="private isolated clasp authorization file")
    deploy.add_argument("--bootstrap-payload", type=Path, help="private one-time Secret Manager bootstrap payload; required until bootstrap completes")
    deploy.add_argument("--acknowledge-association", action="store_true", help="confirm the operator completed the required Apps Script Cloud association")
    return parser


def _emit(value: object) -> None:
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))


def main(arguments: Sequence[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(arguments)
    try:
        if args.command == "oauth-command":
            print(oauth_authorization_command())
            return 0
        if args.command == "tools":
            _emit(discover_tools())
            return 0
        config = load_config(args.config)
        if args.command == "initialize":
            state, resumed = initialize_state_with_status(args.state_dir, config)
            _emit({"installationId": state["installationId"], "phase": state["phase"], "resumed": resumed})
            return 0
        if args.command == "validate-bundle":
            digest, state = validate_and_mark_bundle(args.state_dir, config, args.source_dir)
            _emit({"bundleDigest": digest, "installationId": state["installationId"], "phase": state["phase"]})
            return 0
        if args.command == "preflight-identity":
            _emit(authenticated_identity_preflight(config["ownerEmail"], args.project_id))
            return 0
        if args.command == "provision-cloud":
            state = provision_cloud(args.state_dir, config)
            _emit(
                {
                    "cloudReady": state["phase"]
                    in {
                        "cloud-ready",
                        "bootstrap-complete",
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
                    },
                    "phase": state["phase"],
                }
            )
            return 0
        if args.command == "deploy-apps-script":
            state = deploy_apps_script(args.state_dir, config, args.source_dir, args.clasp_auth, args.bootstrap_payload, association_acknowledged=args.acknowledge_association)
            _emit(
                {
                    "appsScriptReady": state["phase"] in {"apps-script-ready", "bootstrap-complete"},
                    "bootstrapComplete": state["phase"] == "bootstrap-complete",
                    "phase": state["phase"],
                }
            )
            return 0
        raise AssertionError("unhandled command")
    except ProvisionerError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
