# Local provisioner foundation

## Table of contents

- [Scope](#scope)
- [Private local inputs and state](#private-local-inputs-and-state)
- [Implemented commands](#implemented-commands)
- [Authentication preflight](#authentication-preflight)
- [Source bundle contract](#source-bundle-contract)
- [Cloud provisioning](#cloud-provisioning)
- [Deferred deployment actions](#deferred-deployment-actions)

## Scope

`python3 -m provisioner.cli` is a standard-library-only local provisioner. Its
`provision-cloud` command creates or adopts the two labelled Cloud projects,
links the eligible Vertex project to its configured billing account, and enables
the documented services. It does not deploy Apps Script, call the bootstrap
endpoint, create an API key or OAuth client, access Secret Manager, or read
credentials.

Do not use a shared global `clasp` profile. Later deployment work must instead
use an installation-owned, private authorization location.

## Private local inputs and state

Copy [`config/example.json`](../config/example.json) outside the repository for
Apps Script-only preparation, or copy
[`config/provisioner.example.json`](../config/provisioner.example.json) for
Cloud provisioning. Complete all fields and set file mode 0600. The file is
non-secret but the CLI uses a private-file policy so that an installation's
identity and configuration cannot be silently redirected through
broad-permission paths.

Local state defaults to `${XDG_STATE_HOME:-$HOME/.local/state}/mycoupons`.
The directory is created mode 0700; its state, key, and lock files are mode
0600. The CLI refuses symlinked config, state, source-root, and bundle-entry
inputs; it canonicalizes an ancestor alias before reading a config or source bundle.
It also rejects permissive state/config files, malformed JSON, unexpected
config keys, and a config whose digest differs from existing local state.
State updates are atomically written and signed with a random local identity
key. Concurrent operations fail immediately rather than wait.

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

The digest includes deployable UTF-8 `.gs`, `.html`, `.js`, and `.json` files
only. Each file is limited to 1 MiB and the complete bundle to 8 MiB; at most
1,000 deployable files and 128 KiB of UTF-8 path names are accepted. Manifest
validation and digesting consume the same captured bytes; a file or deployable
file set that changes during capture fails validation. Vendor license files
remain part of repository provenance but are not Apps Script deployment inputs.

## Cloud provisioning

After `validate-bundle`, `provision-cloud` reconciles the two explicitly named
projects from the same private config:

```sh
python3 -m provisioner.cli provision-cloud \
  --config /private/path/mycoupons.local.json
```

The Cloud command requires these otherwise-empty configuration fields:

| Field | Contract |
| --- | --- |
| `developerProject` | Distinct Gemini Developer API project ID. It must remain unbilled. |
| `vertexProject` | Distinct paid Vertex fallback project ID. |
| `vertexBillingAccount` | The selected open Generic Billing Account ID, with or without `billingAccounts/`. |
| `cloudInstallationId` | A 16–63-character lowercase label value identifying this installation. |

It first requires exactly one active `gcloud` account matching `ownerEmail`.
Every subsequent Cloud read and mutation is pinned to that verified account,
instead of the mutable active Cloud SDK configuration.
For an existing project, it requires an active lifecycle, an unconditional
`roles/owner` binding for that account, and both ownership labels:
`mycoupons-installation=CLOUD_INSTALLATION_ID` and
`mycoupons-role=developer` or `vertex`. A nonmatching, unlabeled, inaccessible,
or ambiguous project is never adopted or changed. If a configured project is
reported absent by gcloud's exact not-found response, the command attempts
creation with those labels. Timeouts, malformed output, authorization failures,
and every other inspection failure fail closed without exposing Cloud diagnostics.

The developer project is checked before the Vertex project is created or
changed. Any billing linkage on it is a hard error: this command never links,
unlinks, or relinks its billing. The Vertex project may be linked only when it
is currently unlinked; it must then verify the selected account is open and the
exact requested linkage. A billing subaccount is rejected; a different existing
linkage is rejected rather than relabeled.

After verified ownership, the command enables only the required services:

| Project | Services |
| --- | --- |
| Gemini Developer API | `apikeys.googleapis.com`, `generativelanguage.googleapis.com` |
| Vertex fallback | `aiplatform.googleapis.com`, `script.googleapis.com`, `secretmanager.googleapis.com` |

State records a signed creation intent before project creation, then only
project IDs, project numbers, provenance, phase, and other non-secret metadata
in the private state directory. Existing signed foundation state is migrated
locally before Cloud work and rebinds its prior installer-only config digest;
malformed or unbound state is rejected. Every command is
single-process locked, uses fixed arguments, has a 30-second bounded subprocess
deadline, discards stderr, bounds stdout, and returns generic redacted errors.
Retries resume through `cloud-projects-reconciled` and `cloud-ready`; already
enabled services and the exact confirmed billing link are left unchanged.

This command creates no API key, OAuth client, secret, Apps Script project, or
deployment. It is not evidence that Google has accepted a model request.

## Deferred deployment actions

The next increment may use this local contract to use an isolated `clasp`
authorization, deploy the validated digest, create an immutable temporary
Secret Manager version, invoke
`bootstrapFromSecret`, verify its non-secret result, and disable that version
after success. None of those actions are implemented or authorized here.
