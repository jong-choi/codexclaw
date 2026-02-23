#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WORKSPACE_ROOT="${CODEXCLAW_WORKSPACE_ROOT:-${PROJECT_DIR}/.codexclaw/workspace}"
TEMPLATE_ROOT="${CODEXCLAW_WORKSPACE_TEMPLATE_ROOT:-${PROJECT_DIR}/.codexclaw/initial-workspace}"
MEMORY_FILE="${WORKSPACE_ROOT}/MEMORY.md"
INSTRUCTIONS_FILE="${WORKSPACE_ROOT}/INSTRUCTIONS.md"
AUTO_YES=0

ask_yes_no() {
  local prompt="${1:-Are you sure?}"
  local answer=""

  while true; do
    read -r -p "${prompt} [y/N]: " answer
    case "${answer}" in
      [yY]|[yY][eE][sS])
        return 0
        ;;
      ""|[nN]|[nN][oO])
        return 1
        ;;
      *)
        echo "Please answer y or n."
        ;;
    esac
  done
}

print_help() {
  cat <<EOF
CodexClaw workspace reset helper

Usage:
  ./scripts/reset-workspace.sh [--yes] [--workspace-root <path>] [--template-root <path>]

Options:
  --yes                     Skip confirmation prompt.
  --workspace-root <path>   Override workspace root.
  --template-root <path>    Override initial workspace template root.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --yes|-y)
        AUTO_YES=1
        shift
        ;;
      --workspace-root)
        if [[ $# -lt 2 ]]; then
          echo "Error: --workspace-root requires a value." >&2
          exit 1
        fi
        local custom_root="$2"
        if [[ "${custom_root}" != /* ]]; then
          custom_root="${PROJECT_DIR}/${custom_root}"
        fi
        WORKSPACE_ROOT="${custom_root}"
        MEMORY_FILE="${WORKSPACE_ROOT}/MEMORY.md"
        INSTRUCTIONS_FILE="${WORKSPACE_ROOT}/INSTRUCTIONS.md"
        shift 2
        ;;
      --template-root)
        if [[ $# -lt 2 ]]; then
          echo "Error: --template-root requires a value." >&2
          exit 1
        fi
        local custom_template="$2"
        if [[ "${custom_template}" != /* ]]; then
          custom_template="${PROJECT_DIR}/${custom_template}"
        fi
        TEMPLATE_ROOT="${custom_template}"
        shift 2
        ;;
      --help|-h)
        print_help
        exit 0
        ;;
      *)
        echo "Unknown option: $1" >&2
        print_help >&2
        exit 1
        ;;
    esac
  done
}

copy_template_contents() {
  if [[ ! -d "${TEMPLATE_ROOT}" ]]; then
    return 0
  fi
  if command -v rsync >/dev/null 2>&1; then
    rsync -a "${TEMPLATE_ROOT}/" "${WORKSPACE_ROOT}/"
    return 0
  fi

  shopt -s dotglob nullglob
  local entries=("${TEMPLATE_ROOT}"/*)
  shopt -u dotglob nullglob
  if [[ "${#entries[@]}" -gt 0 ]]; then
    cp -R "${entries[@]}" "${WORKSPACE_ROOT}/"
  fi
}

reset_workspace() {
  if [[ -e "${WORKSPACE_ROOT}" && ! -d "${WORKSPACE_ROOT}" ]]; then
    echo "Error: workspace path exists but is not a directory: ${WORKSPACE_ROOT}" >&2
    exit 1
  fi

  if [[ "${AUTO_YES}" -ne 1 ]]; then
    echo "Workspace root: ${WORKSPACE_ROOT}"
    echo "Template root: ${TEMPLATE_ROOT}"
    echo "This will delete all files inside the workspace directory and copy template contents."
    if ! ask_yes_no "Initialize workspace now?"; then
      echo "Skipped: workspace reset"
      exit 0
    fi
  fi

  rm -rf "${WORKSPACE_ROOT}"
  mkdir -p "${WORKSPACE_ROOT}"
  copy_template_contents
  : > "${MEMORY_FILE}"
  : > "${INSTRUCTIONS_FILE}"

  echo "Workspace initialized: ${WORKSPACE_ROOT}"
  echo "Template copied from: ${TEMPLATE_ROOT}"
  echo "Ensured: ${MEMORY_FILE}"
  echo "Ensured: ${INSTRUCTIONS_FILE}"
}

parse_args "$@"
reset_workspace
