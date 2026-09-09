# Local provisioner foundation

## Table of contents

- [Scope](#scope)
- [Private local inputs and state](#private-local-inputs-and-state)
- [Implemented commands](#implemented-commands)
- [Authentication preflight](#authentication-preflight)
- [Source bundle contract](#source-bundle-contract)
- [Deferred cloud actions](#deferred-cloud-actions)

## Scope

`python3 -m provisioner.cli` is a standard-library-only local foundation for
the later provisioning workflow. This increment is deliberately read-only
toward Google: it does not deploy Apps Script, call the bootstrap endpoint,
create or alter Cloud resources, access Secret Manager, or read credentials.

Do not use a shared global `clasp` profile. Later deployment work must instead
use an installation-owned, private authorization location.

## Private local inputs and state

Copy [`config/example.json`](../config/example.json) outside the repository,
complete all fields, and set file mode 0600. The file is non-secret but the CLI
uses a private-file policy so that an installation's identity and configuration
cannot be silently redirected through broad-permission paths.

Local state defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/mycoupons`.
The directory is created mode 0700; its state, key, and lock files are mode
0600. The CLI refuses symlinked config, state, and source-bundle inputs,
permissive state/config files, malformed JSON, unexpected config keys, and a
config whose digest differs from existing local state. State updates are
atomically written and signed with a random local identity key. Concurrent
operations fail immediately rather than wait.

## Implemented commands

```sh
# Validate the complete Installer.gs-compatible config and create/resume local state.
python3 -m provisioner.cli initialize --config /private/path/mycoupons.local.json

# Validate src/appsscript.json and digest the Apps Script source bundle.
python3 -m provisioner.cli validate-bundle \
  --config /private/path/mycoupons.local.json --source-dir src

# Safely inspect whether the later deployment tools are available locally.
python3 -m provisioner.cli tools

# Print, but do not execute, the OAuth command for local gcloud preflight.
python3 -m provisioner.cli oauth-command
```

`validate-bundle` checks the owner-only Execution API setting, the exact
manifest OAuth scopes, the required Gmail/Drive advanced services, and a stable
SHA-256 digest over deployable source paths and bytes. A later deployment step
can use that digest to bind a reviewed source snapshot to its action.

## Authentication preflight

The displayed authorization command is `gcloud auth login --update-adc`. It
authorizes the exact active Cloud SDK credential store that the preflight reads
and also refreshes ADC for later operator-owned work. Cloud SDK controls this
command's built-in authorization scope set; this foundation adds no Gmail,
Drive, Sheets, Apps Script, or Secret Manager authorization scopes. The exact
application scopes remain the separately validated Apps Script manifest
contract below.

After authorization, a harmless preflight can require the one active local
gcloud account to match `ownerEmail` and read one explicitly chosen project:

```sh
python3 -m provisioner.cli preflight-identity \
  --config /private/path/mycoupons.local.json --project-id vertex-project
```

The command uses `gcloud auth list --format=json` and `gcloud projects describe
PROJECT --format=json --quiet`. It parses only expected JSON, rejects an absent
or ambiguous active account, and never prints raw command output, tokens,
credentials, configuration values, identity values, or errors returned by
gcloud. A success result contains only boolean confirmation fields.

## Source bundle contract

The validated manifest contract matches the current Apps Script source:

- `Europe/Rome`, V8, and owner-only Execution API access.
- Gmail modify, Sheets, read-only Drive, external request, trigger, mail,
  email identity, and cloud-platform application scopes.
- Gmail v1 and Drive v3 advanced services.

The digest includes deployable `.gs`, `.html`, and `.json` files only. Manifest
validation and digesting consume the same captured bytes; a file that changes
while it is being read fails validation. Vendor license files remain part of
repository provenance but are not Apps Script deployment inputs.

## Deferred cloud actions

The next increment may use this local contract to provision the operator-owned
Cloud project, use an isolated `clasp` authorization, deploy the validated
digest, create an immutable temporary Secret Manager version, invoke
`bootstrapFromSecret`, verify its non-secret result, and disable that version
after success. None of those actions are implemented or authorized by this
foundation.
