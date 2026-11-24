#!/usr/bin/env bash
# ==============================================================================
# pi-teams: One-click Installer for pi & pi-web
# Supports: Linux, macOS, WSL2
# ==============================================================================
set -euo pipefail

VERSION="1.0.0"
REPO_DEFAULT="lifeng/pi-teams"
REPO="${PI_TEAMS_REPO:-$REPO_DEFAULT}"
BRANCH="${PI_TEAMS_BRANCH:-main}"
PI_AGENT_DIR="${HOME}/.pi/agent"

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}======================================================${NC}"
echo -e "${GREEN}   🏀 pi-teams 五人多 Agent 工作流插件安装程序 v${VERSION}${NC}"
echo -e "${BLUE}======================================================${NC}"

# 1. 环境依赖检查
echo -e "\n🔍 [1/5] 检查系统环境依赖..."
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}❌ 错误: 未检测到 Node.js，请先安装 Node.js (>= 20.0.0)。${NC}"
  exit 1
fi

NODE_VER=$(node -v | sed 's/v//' | cut -d'.' -f1)
if [ "${NODE_VER}" -lt 20 ]; then
  echo -e "${YELLOW}⚠️  警告: 当前 Node.js 版本为 $(node -v)，建议使用 Node.js >= 20 以获得最佳兼容性。${NC}"
fi

# 2. 准备目录结构
echo -e "📁 [2/5] 初始化 ~/.pi/agent 目标目录..."
mkdir -p "${PI_AGENT_DIR}/extensions"
mkdir -p "${PI_AGENT_DIR}/agents"
mkdir -p "${PI_AGENT_DIR}/bin"
mkdir -p "${PI_AGENT_DIR}/backups"

# 判断安装来源：本地 Git 模式 vs 远程 Curl 管道模式
IS_LOCAL=false
SCRIPT_DIR=""
if [ -f "$(dirname "$0")/package.json" ]; then
  IS_LOCAL=true
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
fi

USE_SYMLINK=false
for arg in "$@"; do
  if [ "$arg" = "--symlink" ] || [ "$arg" = "-s" ]; then
    USE_SYMLINK=true
  fi
done

# 3. 安装/分发核心文件
echo -e "📦 [3/5] 安装插件核心文件与 Agent 角色档案..."

CORE_FILES=(
  "team-ledger.ts"
  "team-recovery.ts"
  "team-gc.ts"
  "team-review.ts"
  "team-review-evidence.ts"
  "team-scope.ts"
)

ROLES=("cp" "booker" "bridges" "ayton" "cameron")

if [ "${IS_LOCAL}" = true ]; then
  echo -e "   -> 检测到本地安装源: ${SCRIPT_DIR}"
  echo "${SCRIPT_DIR}" > "${PI_AGENT_DIR}/.pi-teams-source"

  if [ "${USE_SYMLINK}" = true ]; then
    echo -e "   -> 使用 ${YELLOW}符号链接模式 (Symlink)${NC} 进行开发安装..."
    ln -sf "${SCRIPT_DIR}/extensions/team.ts" "${PI_AGENT_DIR}/extensions/team.ts"
    for file in "${CORE_FILES[@]}"; do
      ln -sf "${SCRIPT_DIR}/${file}" "${PI_AGENT_DIR}/${file}"
    done
    for role in "${ROLES[@]}"; do
      ln -sf "${SCRIPT_DIR}/agents/${role}.md" "${PI_AGENT_DIR}/agents/${role}.md"
    done
    ln -sf "${SCRIPT_DIR}/update.sh" "${PI_AGENT_DIR}/update.sh"
    ln -sf "${SCRIPT_DIR}/update.sh" "${PI_AGENT_DIR}/bin/pi-teams-update"
  else
    echo -e "   -> 使用 ${GREEN}物理复制模式${NC} 安装..."
    cp "${SCRIPT_DIR}/extensions/team.ts" "${PI_AGENT_DIR}/extensions/team.ts"
    for file in "${CORE_FILES[@]}"; do
      cp "${SCRIPT_DIR}/${file}" "${PI_AGENT_DIR}/${file}"
    done
    for role in "${ROLES[@]}"; do
      cp "${SCRIPT_DIR}/agents/${role}.md" "${PI_AGENT_DIR}/agents/${role}.md"
    done
    cp "${SCRIPT_DIR}/update.sh" "${PI_AGENT_DIR}/update.sh"
    cp "${SCRIPT_DIR}/update.sh" "${PI_AGENT_DIR}/bin/pi-teams-update"
  fi
else
  # 远程 Curl 下载模式
  echo -e "   -> 正在从 GitHub (${REPO}@${BRANCH}) 下载最新文件..."
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "${TMP_DIR}"' EXIT

  # 下载核心扩展入口
  curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/extensions/team.ts" -o "${PI_AGENT_DIR}/extensions/team.ts"

  # 下载核心模块
  for file in "${CORE_FILES[@]}"; do
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/${file}" -o "${PI_AGENT_DIR}/${file}"
  done

  # 下载 Agent 角色
  for role in "${ROLES[@]}"; do
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/agents/${role}.md" -o "${PI_AGENT_DIR}/agents/${role}.md"
  done

  # 下载更新脚本
  curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/update.sh" -o "${PI_AGENT_DIR}/update.sh"
  cp "${PI_AGENT_DIR}/update.sh" "${PI_AGENT_DIR}/bin/pi-teams-update"
fi

chmod +x "${PI_AGENT_DIR}/update.sh" "${PI_AGENT_DIR}/bin/pi-teams-update" 2>/dev/null || true

# 4. 配置合并与安全保护
echo -e "🛡️  [4/5] 检查与合并配置文件 (team.json)..."
TARGET_CONFIG="${PI_AGENT_DIR}/team.json"
DEFAULT_CONFIG_SRC=""

if [ "${IS_LOCAL}" = true ] && [ -f "${SCRIPT_DIR}/config/team.default.json" ]; then
  DEFAULT_CONFIG_SRC="${SCRIPT_DIR}/config/team.default.json"
fi

if [ -f "${TARGET_CONFIG}" ]; then
  echo -e "   -> ${GREEN}检测到已有 team.json 配置！予以完整保留，绝不覆盖。${NC}"
  if [ -n "${DEFAULT_CONFIG_SRC}" ]; then
    cp "${DEFAULT_CONFIG_SRC}" "${PI_AGENT_DIR}/team.default.json"
    echo -e "   -> 最新默认模板已另存为 ~/.pi/agent/team.default.json 供对比查阅。"
  fi
else
  echo -e "   -> 未发现已有 team.json，正在初始化默认配置..."
  if [ -n "${DEFAULT_CONFIG_SRC}" ]; then
    cp "${DEFAULT_CONFIG_SRC}" "${TARGET_CONFIG}"
  else
    curl -fsSL "https://raw.githubusercontent.com/${REPO}/${BRANCH}/config/team.default.json" -o "${TARGET_CONFIG}"
  fi
  echo -e "   -> 默认配置已生成至: ${TARGET_CONFIG}"
fi

# 5. 记录版本信息
echo -e "🔖 [5/5] 写入安装版本信息..."
echo "${VERSION}" > "${PI_AGENT_DIR}/.pi-teams-version"

echo -e "\n${GREEN}======================================================${NC}"
echo -e "${GREEN}🎉 恭喜！pi-teams 多智能体工作流插件已成功安装！${NC}"
echo -e "${GREEN}======================================================${NC}"
echo -e "📌 安装位置: ${PI_AGENT_DIR}"
echo -e "📌 当前版本: v${VERSION}"
echo -e "\n💡 快速上手："
echo -e "1. 启动 pi 或刷新浏览器进入 pi-web。"
echo -e "2. 在聊天输入框中输入 ${BLUE}/team on${NC} 即可开启五人多智能体工作流。"
echo -e "3. 输入 ${BLUE}/team help${NC} 查看完整命令清单。"
echo -e "4. 输入 ${BLUE}/team model list${NC} 或编辑 ~/.pi/agent/team.json 分配你喜欢的模型。"
echo -e "5. 随时可在会话中输入 ${BLUE}/team check-update${NC} 检查并在线更新！"
echo ""
