#!/usr/bin/env bash
# ==============================================================================
# pi-teams: Check and Apply Updates
#   update.sh               update when the remote version is newer
#   update.sh --check-only  only report
#   update.sh --force       reinstall even when versions match
# ==============================================================================
set -euo pipefail

REPO_DEFAULT="lifeng/pi-teams"
REPO="${PI_TEAMS_REPO:-$REPO_DEFAULT}"
BRANCH="${PI_TEAMS_BRANCH:-main}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
VERSION_FILE="${AGENT_DIR}/.pi-teams-version"
SOURCE_FILE="${AGENT_DIR}/.pi-teams-source"
MODE_FILE="${AGENT_DIR}/.pi-teams-mode"
RAW_BASE="${PI_TEAMS_RAW_BASE:-https://raw.githubusercontent.com/${REPO}/${BRANCH}}"

CHECK_ONLY=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --check-only) CHECK_ONLY=true ;;
    --force) FORCE=true ;;
  esac
done

# Returns 0 when $1 > $2 (numeric dotted versions; pre-release suffixes ignored).
version_gt() {
  local a b i
  IFS=. read -r -a a <<< "${1%%-*}"
  IFS=. read -r -a b <<< "${2%%-*}"
  for i in 0 1 2; do
    local x="${a[$i]:-0}" y="${b[$i]:-0}"
    x="${x//[^0-9]/}"; y="${y//[^0-9]/}"
    if (( ${x:-0} > ${y:-0} )); then return 0; fi
    if (( ${x:-0} < ${y:-0} )); then return 1; fi
  done
  return 1
}

CURRENT_VERSION="0.0.0"
[ -f "${VERSION_FILE}" ] && CURRENT_VERSION="$(tr -d ' \r\n' < "${VERSION_FILE}")"

SRC_DIR=""
if [ -f "${SOURCE_FILE}" ]; then
  SRC_DIR="$(cat "${SOURCE_FILE}")"
  [ -d "${SRC_DIR}/.git" ] || SRC_DIR=""
fi

echo "🔍 [pi-teams update] 当前版本 v${CURRENT_VERSION}（${SRC_DIR:+本地仓库 ${SRC_DIR}}${SRC_DIR:-远程 ${REPO}@${BRANCH}}）"

REMOTE_VERSION=""
if [ -n "${SRC_DIR}" ]; then
  if git -C "${SRC_DIR}" fetch --quiet origin "${BRANCH}" 2>/dev/null; then
    REMOTE_VERSION="$(git -C "${SRC_DIR}" show "origin/${BRANCH}:package.json" 2>/dev/null | grep -o '"version": *"[^"]*"' | head -n1 | cut -d'"' -f4 || true)"
  fi
  # A checkout without a reachable remote still updates from its working tree.
  [ -n "${REMOTE_VERSION}" ] || REMOTE_VERSION="$(grep -o '"version": *"[^"]*"' "${SRC_DIR}/package.json" | head -n1 | cut -d'"' -f4 || true)"
else
  REMOTE_VERSION="$(curl -fsSL --connect-timeout 5 "${RAW_BASE}/package.json" 2>/dev/null | grep -o '"version": *"[^"]*"' | head -n1 | cut -d'"' -f4 || true)"
fi

if [ -z "${REMOTE_VERSION}" ]; then
  echo "⚠️  无法获取远程版本号（网络、私有仓库或 PI_TEAMS_REPO 设置有误）。"
  exit 1
fi
echo "🌐 最新版本 v${REMOTE_VERSION}"

if ! version_gt "${REMOTE_VERSION}" "${CURRENT_VERSION}" && [ "${FORCE}" != true ]; then
  echo "✅ 已是最新版本，无需更新。"
  exit 0
fi
if [ "${CHECK_ONLY}" = true ]; then
  echo "💡 发现新版本 v${REMOTE_VERSION}！运行 update.sh 或在 pi 中输入 /team update 升级。"
  exit 0
fi

BACKUP_DIR="${AGENT_DIR}/backups/pi-teams-$(date +%Y%m%d%H%M%S)"
mkdir -p "${BACKUP_DIR}/agents"
echo "📦 备份当前版本至 ${BACKUP_DIR}"
cp -L "${AGENT_DIR}/extensions/team.ts" "${BACKUP_DIR}/" 2>/dev/null || true
cp -L "${AGENT_DIR}"/team-*.ts "${BACKUP_DIR}/" 2>/dev/null || true
for r in cp booker bridges ayton cameron; do cp -L "${AGENT_DIR}/agents/${r}.md" "${BACKUP_DIR}/agents/" 2>/dev/null || true; done

INSTALL_ARGS=()
if [ -f "${MODE_FILE}" ] && [ "$(cat "${MODE_FILE}")" = "symlink" ]; then INSTALL_ARGS+=(--symlink); fi
if [ -L "${AGENT_DIR}/extensions/team.ts" ]; then INSTALL_ARGS=(--symlink); fi

if [ -n "${SRC_DIR}" ]; then
  echo "🔄 git pull --ff-only (${SRC_DIR})"
  git -C "${SRC_DIR}" pull --ff-only --quiet origin "${BRANCH}" || echo "⚠️  git pull 失败，使用当前工作区内容安装。"
  bash "${SRC_DIR}/install.sh" "${INSTALL_ARGS[@]}"
else
  # Run the freshly downloaded installer: one file list, atomic replacement.
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR}"' EXIT
  curl -fsSL "${RAW_BASE}/install.sh" -o "${TMP_DIR}/install.sh"
  PI_TEAMS_REPO="${REPO}" PI_TEAMS_BRANCH="${BRANCH}" bash "${TMP_DIR}/install.sh"
fi

echo "🎉 pi-teams 已更新到 v${REMOTE_VERSION}。team.json 未改动；在 pi 中 /reload 或新开会话生效。"
