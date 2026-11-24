#!/usr/bin/env bash
# ==============================================================================
# pi-teams: Uninstaller for pi & pi-web
# ==============================================================================
set -euo pipefail

PI_AGENT_DIR="${HOME}/.pi/agent"

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

PURGE=false
for arg in "$@"; do
  if [ "$arg" = "--purge" ] || [ "$arg" = "-p" ]; then
    PURGE=true
  fi
done

echo -e "${YELLOW}======================================================${NC}"
echo -e "${YELLOW}   🗑️  pi-teams 多智能体工作流插件卸载程序${NC}"
echo -e "${YELLOW}======================================================${NC}"

if [ ! -d "${PI_AGENT_DIR}" ]; then
  echo "未检测到 ~/.pi/agent 目录，无需卸载。"
  exit 0
fi

echo "正在移除 pi-teams 核心插件与 Agent 角色档案..."

# 移除核心 extension 入口
rm -f "${PI_AGENT_DIR}/extensions/team.ts"

# 移除核心支持模块
CORE_FILES=(
  "team-ledger.ts"
  "team-recovery.ts"
  "team-gc.ts"
  "team-review.ts"
  "team-review-evidence.ts"
  "team-scope.ts"
)

for file in "${CORE_FILES[@]}"; do
  rm -f "${PI_AGENT_DIR}/${file}"
done

# 移除 Agent 角色定义
ROLES=("cp" "booker" "bridges" "ayton" "cameron")
for role in "${ROLES[@]}"; do
  rm -f "${PI_AGENT_DIR}/agents/${role}.md"
done

# 移除更新脚本与版本标记
rm -f "${PI_AGENT_DIR}/update.sh"
rm -f "${PI_AGENT_DIR}/bin/pi-teams-update"
rm -f "${PI_AGENT_DIR}/.pi-teams-version"
rm -f "${PI_AGENT_DIR}/.pi-teams-source"
rm -f "${PI_AGENT_DIR}/team.default.json"

if [ "${PURGE}" = true ]; then
  echo -e "${RED}⚠️  [--purge] 正在清除配置文件与备份...${NC}"
  rm -f "${PI_AGENT_DIR}/team.json"
  rm -f "${PI_AGENT_DIR}/team-pending.json"
  echo "已彻底清除所有 team.json 配置文件。"
else
  echo -e "${GREEN}✅ 已保留您的个性化配置文件: ${PI_AGENT_DIR}/team.json${NC}"
  echo "（如果希望彻底删除配置文件，请运行: ./uninstall.sh --purge）"
fi

echo -e "\n${GREEN}======================================================${NC}"
echo -e "${GREEN}🎉 pi-teams 插件已成功卸载。${NC}"
echo -e "${GREEN}======================================================${NC}"
