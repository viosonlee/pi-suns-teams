#!/usr/bin/env bash
# ==============================================================================
# pi-teams: Uninstaller
#   uninstall.sh          remove code, keep team.json
#   uninstall.sh --purge  also remove team.json and pi-teams backups
# ==============================================================================
set -euo pipefail

PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; NC='\033[0m'

PURGE=false
for arg in "$@"; do
  case "$arg" in --purge|-p) PURGE=true ;; esac
done

if [ ! -d "${PI_AGENT_DIR}" ]; then
  echo "未检测到 ${PI_AGENT_DIR}，无需卸载。"; exit 0
fi

echo -e "${YELLOW}🗑️  正在移除 pi-teams ...${NC}"
rm -f "${PI_AGENT_DIR}/extensions/team.ts"
for f in team-ledger.ts team-recovery.ts team-gc.ts team-worktree.ts team-review.ts team-review-evidence.ts team-scope.ts team-runner.ts team-host.ts team-doctor.ts; do
  rm -f "${PI_AGENT_DIR}/${f}"
done
for r in cp booker bridges ayton cameron; do
  rm -f "${PI_AGENT_DIR}/agents/${r}.md"
done
rm -f "${PI_AGENT_DIR}/update.sh" "${PI_AGENT_DIR}/pi-teams-update.sh" "${PI_AGENT_DIR}/pi-teams-uninstall.sh" \
  "${PI_AGENT_DIR}/bin/pi-teams-update" "${PI_AGENT_DIR}/.pi-teams-version" "${PI_AGENT_DIR}/.pi-teams-source" \
  "${PI_AGENT_DIR}/.pi-teams-mode" "${PI_AGENT_DIR}/team.default.json"

if [ "${PURGE}" = true ]; then
  echo -e "${RED}⚠️  [--purge] 删除 team.json、team-pending.json 与 pi-teams 备份${NC}"
  rm -f "${PI_AGENT_DIR}/team.json" "${PI_AGENT_DIR}/team-pending.json"
  if [ -n "${PI_AGENT_DIR}" ] && [ "${PI_AGENT_DIR}" != "/" ] && [ -d "${PI_AGENT_DIR}/backups" ]; then
    find "${PI_AGENT_DIR}/backups" -maxdepth 1 -name 'pi-teams-*' -exec rm -rf -- {} +
  fi
else
  echo -e "${GREEN}✅ 已保留配置 ${PI_AGENT_DIR}/team.json（--purge 可一并删除）${NC}"
fi
echo -e "${GREEN}🎉 pi-teams 已卸载。在 pi 中 /reload 生效。${NC}"
