#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: scripts/prepare-deployment.sh --auth-json PATH --project-id ID'
}

auth_json=''
project_id=''
while (($#)); do
  case "$1" in
    --auth-json) [[ $# -ge 2 ]] || { usage >&2; exit 2; }; auth_json=$2; shift 2 ;;
    --project-id) [[ $# -ge 2 ]] || { usage >&2; exit 2; }; project_id=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

[[ -n "${auth_json}" && -f "${auth_json}" ]] || { printf '%s\n' 'auth JSON file is required and must exist' >&2; exit 2; }
[[ "${project_id}" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || { printf '%s\n' 'invalid Google Cloud project ID' >&2; exit 2; }
command -v clasp >/dev/null || { printf '%s\n' 'clasp is required for deployment preparation' >&2; exit 1; }
command -v gcloud >/dev/null || { printf '%s\n' 'gcloud is required for deployment preparation' >&2; exit 1; }
printf '%s\n' 'Prerequisites passed. Deployment preparation only; no Google resource was changed.'
