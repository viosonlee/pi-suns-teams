#!/usr/bin/env bash
# ==============================================================================
# pi-teams: Check and Apply Updates
# ==============================================================================
set -euo pipefail

REPO_DEFAULT="lifeng/pi-teams"
REPO="${PI_TEAMS_REPO:-$REPO_DEFAULT}"
BRANCH="${PI_TEAMS_BRANCH:-main}"
AGENT_DIR="${HOME}/.pi/agent"
VERSION_FILE="${AGENT_DIR}/.pi-teams-version"
GIT_SOURCE_FILE="${AGENT_DIR}/.pi-teams-source"

echo "🔍 [pi-teams update] 正在检查更新 (仓库: ${REPO}, 分支: ${BRANCH})..."

# 获取本地版本
CURRENT_VERSION="1.0.0"
if [ -f "${VERSION_FILE}" ]; then
  CURRENT_VERSION=$(cat "${VERSION_FILE}" | tr -d ' \r\n')
fi

# 获取远程版本
REMOTE_PKG_URL="https://raw.githubusercontent.com/${REPO}/${BRANCH}/package.json"
REMOTE_VERSION=""
if command -v curl >/dev/null 2>&1; then
  REMOTE_VERSION=$(curl -fsSL --connect-timeout 5 "${REMOTE_PKG_URL}" 2>/dev/null | grep -o '"version": *"[^"]*"' | head -n1 | cut -d'"' -f4 || true)
fi

if [ -z "${REMOTE_VERSION}" ]; then
  echo "⚠️  未能从 ${REMOTE_PKG_URL} 获取远程版本号，请检查网络或 GitHub 仓库地址。"
  # 如果仅检查更新，退出
  if [ "${1:-}" = "--check-only" ]; then
    exit 1
  fi
  echo "将尝试继续通过常规模式拉取..."
fi

echo "📌 当前本地版本: v${CURRENT_VERSION}"
if [ -n "${REMOTE_VERSION}" ]; then
  echo "🌐 远程最新版本: v${REMOTE_VERSION}"
  if [ "${CURRENT_VERSION}" = "${REMOTE_VERSION}" ] && [ "${1:-}" != "--force" ]; then
    echo "✅ 当前已是最新版本 (v${CURRENT_VERSION})，无需更新。"
    exit 0
  fi
fi

if [ "${1:-}" = "--check-only" ]; then
  if [ -n "${REMOTE_VERSION}" ] && [ "${CURRENT_VERSION}" != "${REMOTE_VERSION}" ]; then
    echo "💡 发现新版本 v${REMOTE_VERSION}！可运行 update.sh 或在对话中输入 /team update 进行升级。"
    exit 0
  fi
  exit 0
fi

echo "🚀 开始更新 pi-teams..."

# 备份当前配置与核心文件
BACKUP_DIR="${AGENT_DIR}/backups/pi-teams-$(date +%Y%m%d%H%M%S)"
mkdir -p "${BACKUP_DIR}"
echo "📦 正在备份现有版本至: ${BACKUP_DIR}"
[ -f "${AGENT_DIR}/extensions/team.ts" ] && cp "${AGENT_DIR}/extensions/team.ts" "${BACKUP_DIR}/" || true
[ -d "${AGENT_DIR}/agents" ] && cp -r "${AGENT_DIR}/agents" "${BACKUP_DIR}/" || true
cp "${AGENT_DIR}"/team-*.ts "${BACKUP_DIR}/" 2>/dev/null || true

# 检查是否为 Git Clone 本地安装模式
if [ -f "${GIT_SOURCE_FILE}" ] && [ -d "$(cat "${GIT_SOURCE_FILE}")/.git" ]; then
  SRC_DIR=$(cat "${GIT_SOURCE_FILE}")
  echo "🔄 检测到本地 Git 开发安装源: ${SRC_DIR}，正在执行 git pull..."
  git -C "${SRC_DIR}" pull --ff-only
  bash "${SRC_DIR}/install.sh" --skip-prompt
else
  # 远程文件下载模式
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "${TMP_DIR}"' EXIT

  echo "⬇️  正在下载最新核心文件..."
  CORE_FILES=(
    "team-ledger.ts"
    "team-recovery.ts"
    "team-gc.ts"
    "team-review.ts"
    "team-review-evidence.ts"
    "team-scope.ts"
  )

  for file in "${CORE_FILES[@]}"; do
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/${file}" -o "${TMP_DIR}/${file}"
    cp "${TMP_DIR}/${file}" "${AGENT_DIR}/${file}"
  done

  # 更新 extension
  mkdir -p "${TMP_DIR}/extensions" "${AGENT_DIR}/extensions"
  curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/extensions/team.ts" -o "${TMP_DIR}/extensions/team.ts"
  cp "${TMP_DIR}/extensions/team.ts" "${AGENT_DIR}/extensions/team.ts"

  # 更新 agents 角色
  mkdir -p "${TMP_DIR}/agents" "${AGENT_DIR}/agents"
  ROLES=("cp" "booker" "bridges" "ayton" "cameron")
  for role in "${ROLES[@]}"; do
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/agents/${role}.md" -o "${TMP_DIR}/agents/${role}.md"
    cp "${TMP_DIR}/agents/${role}.md" "${AGENT_DIR}/agents/${role}.md"
  done

  # 写入新版本号
  if [ -n "${REMOTE_VERSION}" ]; then
    echo "${REMOTE_VERSION}" > "${VERSION_FILE}"
  fi
fi

echo "🎉 pi-teams 更新成功！当前版本: v${REMOTE_VERSION:-latest}"
echo "💡 提示：已有 team.json 自定义配置已完整保留。在 pi 或 pi-web 中开启新会话即可生效新代码。"
