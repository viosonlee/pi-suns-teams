#!/usr/bin/env bash
# ==============================================================================
# pi-teams: One-click Installer for pi
# Supports: Linux, macOS, WSL2
#
#   Local (git clone):   ./install.sh [--symlink]
#   Remote (no clone):   curl -fsSL https://raw.githubusercontent.com/<owner>/pi-suns-teams/main/install.sh | bash
#
# Env: PI_TEAMS_REPO (owner/name), PI_TEAMS_BRANCH (default main), PI_CODING_AGENT_DIR
# ==============================================================================
set -euo pipefail

REPO_DEFAULT="viosonlee/pi-suns-teams"
REPO="${PI_TEAMS_REPO:-$REPO_DEFAULT}"
BRANCH="${PI_TEAMS_BRANCH:-main}"
PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"
RAW_BASE="${PI_TEAMS_RAW_BASE:-https://raw.githubusercontent.com/${REPO}/${BRANCH}}"

# Single source of truth for installed files (paths relative to the repo root / agent dir).
EXTENSION_FILE="extensions/team.ts"
CORE_FILES=(
  "team-ledger.ts"
  "team-recovery.ts"
  "team-gc.ts"
  "team-worktree.ts"
  "team-review.ts"
  "team-review-evidence.ts"
  "team-scope.ts"
  "team-runner.ts"
  "team-host.ts"
  "team-doctor.ts"
)
ROLES=("cp" "booker" "bridges" "ayton" "cameron")
SCRIPTS=("update.sh" "uninstall.sh")

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

USE_SYMLINK=false
for arg in "$@"; do
  case "$arg" in
    --symlink|-s) USE_SYMLINK=true ;;
  esac
done

# Local mode only when this script is a real file sitting in a pi-teams checkout.
# (Under `curl | bash`, BASH_SOURCE is empty and $0 is "bash": never trust the CWD.)
IS_LOCAL=false
SCRIPT_DIR=""
SELF="${BASH_SOURCE[0]:-}"
if [ -n "${SELF}" ] && [ -f "${SELF}" ]; then
  CANDIDATE="$(cd "$(dirname "${SELF}")" && pwd)"
  if [ -f "${CANDIDATE}/package.json" ] && [ -f "${CANDIDATE}/${EXTENSION_FILE}" ] && grep -q '"name": *"pi-teams"' "${CANDIDATE}/package.json"; then
    IS_LOCAL=true
    SCRIPT_DIR="${CANDIDATE}"
  fi
fi
if [ "${USE_SYMLINK}" = true ] && [ "${IS_LOCAL}" != true ]; then
  echo -e "${RED}❌ --symlink 只能在本地 git 仓库中使用。${NC}"; exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

# Fetch every source file into SRC_ROOT (local checkout, or a temp dir for remote installs).
if [ "${IS_LOCAL}" = true ]; then
  SRC_ROOT="${SCRIPT_DIR}"
else
  command -v curl >/dev/null 2>&1 || { echo -e "${RED}❌ 需要 curl。${NC}"; exit 1; }
  SRC_ROOT="${TMP_DIR}/src"
  fetch() { mkdir -p "$(dirname "${SRC_ROOT}/$1")"; curl -fsSL "${RAW_BASE}/$1" -o "${SRC_ROOT}/$1"; }
  echo -e "⬇️  正在从 GitHub (${REPO}@${BRANCH}) 下载..."
  fetch "package.json"
  fetch "${EXTENSION_FILE}"
  for f in "${CORE_FILES[@]}"; do fetch "$f"; done
  for r in "${ROLES[@]}"; do fetch "agents/${r}.md"; done
  for s in "${SCRIPTS[@]}"; do fetch "$s"; done
  fetch "config/team.default.json"
fi

VERSION="$(grep -o '"version": *"[^"]*"' "${SRC_ROOT}/package.json" | head -n1 | cut -d'"' -f4)"
VERSION="${VERSION:-unknown}"

echo -e "${BLUE}======================================================${NC}"
echo -e "${GREEN}   🏀 pi-teams 五人多 Agent 工作流插件安装程序 v${VERSION}${NC}"
echo -e "${BLUE}======================================================${NC}"

echo -e "\n🔍 [1/5] 检查系统环境依赖..."
if ! command -v node >/dev/null 2>&1; then
  echo -e "${RED}❌ 未检测到 Node.js，请先安装 Node.js (>= 22)。${NC}"; exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo -e "${YELLOW}⚠️  当前 Node.js $(node -v)；建议 >= 22（与 pi 要求一致）。${NC}"
fi
if [ -z "${PI_BIN:-}" ] && ! command -v pi >/dev/null 2>&1; then
  echo -e "${YELLOW}⚠️  PATH 中未找到 pi；子 Agent 需要 pi CLI（或设置 PI_BIN=/path/to/pi）。${NC}"
fi

echo -e "📁 [2/5] 初始化 ${PI_AGENT_DIR} ..."
mkdir -p "${PI_AGENT_DIR}/extensions" "${PI_AGENT_DIR}/agents" "${PI_AGENT_DIR}/bin" "${PI_AGENT_DIR}/backups"

# Atomic replace: copy to a temp name, then rename over the target. Renaming also replaces a previous
# symlink (no "same file" error) and never rewrites the inode of a script that is currently running.
install_file() {
  local src="$1" dst="$2" mode="${3:-644}"
  if [ "${USE_SYMLINK}" = true ]; then
    rm -f "${dst}"
    ln -s "${src}" "${dst}"
  else
    cp "${src}" "${dst}.pi-teams-tmp"
    chmod "${mode}" "${dst}.pi-teams-tmp"
    mv -f "${dst}.pi-teams-tmp" "${dst}"
  fi
}

echo -e "📦 [3/5] 安装插件核心文件与 Agent 角色档案（$([ "${USE_SYMLINK}" = true ] && echo 符号链接 || echo 复制)模式）..."
install_file "${SRC_ROOT}/${EXTENSION_FILE}" "${PI_AGENT_DIR}/${EXTENSION_FILE}"
for f in "${CORE_FILES[@]}"; do install_file "${SRC_ROOT}/${f}" "${PI_AGENT_DIR}/${f}"; done
for r in "${ROLES[@]}"; do install_file "${SRC_ROOT}/agents/${r}.md" "${PI_AGENT_DIR}/agents/${r}.md"; done
for s in "${SCRIPTS[@]}"; do install_file "${SRC_ROOT}/${s}" "${PI_AGENT_DIR}/pi-teams-${s}" 755; done
install_file "${SRC_ROOT}/update.sh" "${PI_AGENT_DIR}/bin/pi-teams-update" 755
# Legacy location used by older releases and by `/team update`.
install_file "${SRC_ROOT}/update.sh" "${PI_AGENT_DIR}/update.sh" 755

if [ "${IS_LOCAL}" = true ]; then
  echo "${SCRIPT_DIR}" > "${PI_AGENT_DIR}/.pi-teams-source"
else
  rm -f "${PI_AGENT_DIR}/.pi-teams-source"
fi
echo "$([ "${USE_SYMLINK}" = true ] && echo symlink || echo copy)" > "${PI_AGENT_DIR}/.pi-teams-mode"

echo -e "🛡️  [4/5] 检查配置文件 (team.json)..."
TARGET_CONFIG="${PI_AGENT_DIR}/team.json"
if [ -f "${TARGET_CONFIG}" ]; then
  cp "${SRC_ROOT}/config/team.default.json" "${PI_AGENT_DIR}/team.default.json"
  echo -e "   -> ${GREEN}已有 team.json，完整保留；最新模板另存为 team.default.json 供对比。${NC}"
  # Prevent template agents/*.md copy from reverting user-configured role model/thinking on upgrade.
  if [ "${USE_SYMLINK}" != true ] && command -v node >/dev/null 2>&1; then
    node - "${TARGET_CONFIG}" "${PI_AGENT_DIR}/agents" <<'EOF'
const fs = require("fs");
const path = require("path");
const [cfgPath, agentsDir] = process.argv.slice(2);
const sentinels = new Set(["inherit", "default", "auto", "none", "unset", "null", "undefined"]);
const clean = (v) => (typeof v === "string" && v.trim() && !sentinels.has(v.trim().toLowerCase()) ? v.trim() : "");
try {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const roles = cfg && cfg.roles && typeof cfg.roles === "object" ? cfg.roles : {};
  for (const role of ["cp", "booker", "bridges", "ayton", "cameron"]) {
    const r = roles[role];
    const mdPath = path.join(agentsDir, `${role}.md`);
    if (!r || typeof r !== "object" || !fs.existsSync(mdPath)) continue;
    const model = clean(r.model);
    const thinking = clean(r.thinking);
    if (!model && !thinking) continue;
    const raw = fs.readFileSync(mdPath, "utf8");
    const parts = raw.split("---");
    if (parts.length < 3) continue;
    let fm = parts[1];
    if (model) {
      fm = /^model:\s*.*$/m.test(fm) ? fm.replace(/^model:\s*.*$/m, `model: ${model}`) : `${fm.trimEnd()}\nmodel: ${model}\n`;
    }
    if (thinking) {
      fm = /^thinking:\s*.*$/m.test(fm) ? fm.replace(/^thinking:\s*.*$/m, `thinking: ${thinking}`) : `${fm.trimEnd()}\nthinking: ${thinking}\n`;
    }
    if (fm !== parts[1]) {
      parts[1] = fm;
      fs.writeFileSync(mdPath, parts.join("---"), "utf8");
    }
  }
} catch {}
EOF
  fi
else
  cp "${SRC_ROOT}/config/team.default.json" "${TARGET_CONFIG}"
  echo -e "   -> 已生成默认配置: ${TARGET_CONFIG}（请按本机可用模型修改 roles.*.model）"
fi

echo -e "🔖 [5/5] 写入版本信息..."
echo "${VERSION}" > "${PI_AGENT_DIR}/.pi-teams-version"

echo -e "\n${GREEN}🎉 pi-teams v${VERSION} 已安装到 ${PI_AGENT_DIR}${NC}"
echo -e "💡 在 pi 中执行 /reload（或新开会话）后输入 ${BLUE}/team on${NC}；${BLUE}/team help${NC} 查看命令；${BLUE}/team model list${NC} 分配模型。"
