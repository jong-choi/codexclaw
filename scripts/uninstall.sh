#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${PROJECT_DIR}/docker-compose.yml"
DEFAULT_IMAGE="codexclaw:local"
CONFIG_DIR="${CODEXCLAW_CONFIG_DIR:-${HOME}/.codexclaw}"
WORKSPACE_ROOT="${CODEXCLAW_WORKSPACE_ROOT:-${PROJECT_DIR}/.codexclaw/workspace}"
WORKSPACE_TEMPLATE_ROOT="${CODEXCLAW_WORKSPACE_TEMPLATE_ROOT:-${PROJECT_DIR}/.codexclaw/initial-workspace}"
RESET_WORKSPACE_SCRIPT="${SCRIPT_DIR}/reset-workspace.sh"

DOCKER_AVAILABLE=0
DOCKER_DAEMON_READY=0
DOCKER_COMPOSE_AVAILABLE=0
PROJECT_NAME=""

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

unique_lines() {
  awk 'NF && !seen[$0]++'
}

resolve_project_name() {
  local from_compose=""
  if [[ "${DOCKER_COMPOSE_AVAILABLE}" -eq 1 ]] && [[ -f "${COMPOSE_FILE}" ]]; then
    from_compose="$(docker compose -f "${COMPOSE_FILE}" config 2>/dev/null | awk -F': ' '/^name:/{print $2; exit}')"
  fi

  if [[ -n "${from_compose}" ]]; then
    printf '%s' "${from_compose}"
    return 0
  fi

  local fallback
  fallback="$(basename "${PROJECT_DIR}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/_/g')"
  if [[ -z "${fallback}" ]]; then
    fallback="codexclaw"
  fi
  printf '%s' "${fallback}"
}

setup_docker_context() {
  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi
  DOCKER_AVAILABLE=1

  if ! docker info >/dev/null 2>&1; then
    return 0
  fi
  DOCKER_DAEMON_READY=1

  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE_AVAILABLE=1
  fi

  PROJECT_NAME="$(resolve_project_name)"
}

list_running_project_containers() {
  if [[ "${DOCKER_DAEMON_READY}" -ne 1 ]] || [[ -z "${PROJECT_NAME}" ]]; then
    return 0
  fi
  docker ps \
    --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --format '{{.ID}} {{.Names}}' 2>/dev/null || true
}

compose_image_candidates() {
  if [[ "${DOCKER_COMPOSE_AVAILABLE}" -ne 1 ]] || [[ ! -f "${COMPOSE_FILE}" ]]; then
    return 0
  fi
  docker compose -f "${COMPOSE_FILE}" config --images 2>/dev/null || true
}

container_image_candidates() {
  if [[ "${DOCKER_DAEMON_READY}" -ne 1 ]] || [[ -z "${PROJECT_NAME}" ]]; then
    return 0
  fi
  docker ps -a \
    --filter "label=com.docker.compose.project=${PROJECT_NAME}" \
    --format '{{.Image}}' 2>/dev/null || true
}

list_existing_project_images() {
  local candidates
  candidates="$({
    compose_image_candidates
    container_image_candidates
    printf '%s\n' "${DEFAULT_IMAGE}"
  } | unique_lines)"

  while IFS= read -r image; do
    [[ -z "${image}" ]] && continue
    if docker image inspect "${image}" >/dev/null 2>&1; then
      printf '%s\n' "${image}"
    fi
  done <<< "${candidates}" | unique_lines
}

compose_volume_candidates() {
  if [[ "${DOCKER_COMPOSE_AVAILABLE}" -ne 1 ]] || [[ ! -f "${COMPOSE_FILE}" ]]; then
    return 0
  fi
  docker compose -f "${COMPOSE_FILE}" config --volumes 2>/dev/null || true
}

list_existing_project_volumes() {
  local compose_volumes
  compose_volumes="$(compose_volume_candidates)"

  local candidates
  candidates="$({
    if [[ -n "${PROJECT_NAME}" ]]; then
      docker volume ls -q --filter "label=com.docker.compose.project=${PROJECT_NAME}" 2>/dev/null || true
    fi

    printf '%s\n' "${compose_volumes}"
    while IFS= read -r volume; do
      [[ -z "${volume}" ]] && continue
      if [[ -n "${PROJECT_NAME}" ]]; then
        printf '%s_%s\n' "${PROJECT_NAME}" "${volume}"
      fi
    done <<< "${compose_volumes}"
  } | unique_lines)"

  while IFS= read -r volume; do
    [[ -z "${volume}" ]] && continue
    if docker volume inspect "${volume}" >/dev/null 2>&1; then
      printf '%s\n' "${volume}"
    fi
  done <<< "${candidates}" | unique_lines
}

print_bullet_list() {
  local items="${1:-}"
  while IFS= read -r item; do
    [[ -z "${item}" ]] && continue
    echo "  - ${item}"
  done <<< "${items}"
}

main() {
  setup_docker_context

  echo "CodexClaw uninstall helper"
  echo "Project directory: ${PROJECT_DIR}"
  echo "Global config directory: ${CONFIG_DIR}"

  if [[ "${DOCKER_AVAILABLE}" -eq 0 ]]; then
    echo "Docker CLI not found: skipping Docker checks."
  elif [[ "${DOCKER_DAEMON_READY}" -eq 0 ]]; then
    echo "Docker daemon not reachable: skipping Docker checks."
  else
    if [[ -n "${PROJECT_NAME}" ]]; then
      echo "Docker Compose project: ${PROJECT_NAME}"
    fi
  fi
  echo

  if [[ "${DOCKER_DAEMON_READY}" -eq 1 ]]; then
    local running_containers
    running_containers="$(list_running_project_containers)"
    if [[ -n "${running_containers}" ]]; then
      echo "Running project container(s) detected:"
      print_bullet_list "${running_containers}"
      if ask_yes_no "Bring down Docker Compose services?"; then
        if [[ "${DOCKER_COMPOSE_AVAILABLE}" -eq 1 ]] && [[ -f "${COMPOSE_FILE}" ]]; then
          docker compose -f "${COMPOSE_FILE}" down --remove-orphans
          echo "Compose services are down."
        else
          echo "Docker Compose file not available, skipped compose down."
        fi
      else
        echo "Skipped: compose down"
      fi
      echo
    else
      echo "No running project containers found."
      echo
    fi

    local existing_images
    existing_images="$(list_existing_project_images)"
    if [[ -n "${existing_images}" ]]; then
      echo "Project image(s) detected:"
      print_bullet_list "${existing_images}"
      if ask_yes_no "Delete Docker image(s)?"; then
        while IFS= read -r image; do
          [[ -z "${image}" ]] && continue
          if docker image rm "${image}"; then
            echo "Removed image: ${image}"
          else
            echo "Failed to remove image: ${image}"
          fi
        done <<< "${existing_images}"
      else
        echo "Skipped: image deletion"
      fi
      echo
    else
      echo "No project images found."
      echo
    fi

    local existing_volumes
    existing_volumes="$(list_existing_project_volumes)"
    if [[ -n "${existing_volumes}" ]]; then
      echo "Project volume(s) detected:"
      print_bullet_list "${existing_volumes}"
      if ask_yes_no "Delete Docker volume(s)?"; then
        while IFS= read -r volume; do
          [[ -z "${volume}" ]] && continue
          if docker volume rm "${volume}"; then
            echo "Removed volume: ${volume}"
          else
            echo "Failed to remove volume: ${volume}"
          fi
        done <<< "${existing_volumes}"
      else
        echo "Skipped: volume deletion"
      fi
      echo
    else
      echo "No project volumes found."
      echo
    fi

  fi

  if [[ -d "${WORKSPACE_ROOT}" ]]; then
    echo "Workspace directory detected: ${WORKSPACE_ROOT}"
  else
    echo "Workspace directory not found: ${WORKSPACE_ROOT}"
  fi
  if [[ -d "${WORKSPACE_TEMPLATE_ROOT}" ]]; then
    echo "Workspace template directory: ${WORKSPACE_TEMPLATE_ROOT}"
  else
    echo "Workspace template directory not found: ${WORKSPACE_TEMPLATE_ROOT}"
  fi
  if [[ -x "${RESET_WORKSPACE_SCRIPT}" ]]; then
    if ask_yes_no "Initialize workspace files (${WORKSPACE_ROOT})?"; then
      CODEXCLAW_WORKSPACE_ROOT="${WORKSPACE_ROOT}" \
      CODEXCLAW_WORKSPACE_TEMPLATE_ROOT="${WORKSPACE_TEMPLATE_ROOT}" \
      "${RESET_WORKSPACE_SCRIPT}" --yes
    else
      echo "Skipped: workspace initialization"
    fi
  else
    echo "Workspace reset script not executable: ${RESET_WORKSPACE_SCRIPT}"
  fi
  echo

  if [[ -d "${CONFIG_DIR}" ]]; then
    echo "Global config directory detected: ${CONFIG_DIR}"
    if ask_yes_no "Delete global config directory (${CONFIG_DIR})?"; then
      rm -rf "${CONFIG_DIR}"
      echo "Removed config directory: ${CONFIG_DIR}"
    else
      echo "Skipped: global config deletion"
    fi
  else
    echo "No global config directory found at ${CONFIG_DIR}."
  fi

  echo
  echo "Done. Project files in ${PROJECT_DIR} were not modified or deleted."
}

main "$@"
