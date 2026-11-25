# pi-teams: 5-Agent Collaborative Workflow for pi

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Linux%20%7C%20macOS%20%7C%20WSL2-orange.svg)](#)
[![pi](https://img.shields.io/badge/pi-extension-brightgreen.svg)](#)

**pi-teams** 是专为 [`pi`](https://github.com/earendil-works/pi) 打造的**五人多智能体协作工作流插件（Phoenix Suns CP-parent 架构）**。

它彻底解决单智能体在应对中大型复杂开发任务时的三大痛点：
1. **上下文膨胀（Context Explosion）**：任务跑久了上下文塞满无用日志与代码堆栈，导致模型变笨或触发截断。
2. **缺乏独立复核（Lack of Independent Review）**：由编写代码的同一个 Agent 自己检查自己，极易产生盲区与代码幻觉。
3. **长期任务漂移（Goal Drift）**：多轮会话后忘记原始验收标准或未交付完成即草草汇报完成。

---

## 🏀 核心架构：五人分工与权限矩阵

`pi-teams` 将复杂软件工程任务拆解为具有严格职责边界的五人制团队：

| 角色 | 代号 | 权限约束 | 职责定位 | 默认思考等级 |
|---|---|---|---|---|
| **Chris Paul (CP)** | `cp` | **只读** (`read, bash, grep, find, ls`，禁止修改代码) | **主控总指挥 / 最终仲裁官**：统筹需求拆解、调度流水线、独立代码复核（`W-rev-*`）、最终验收签字。主会话即担任 CP 角色。 | `max` |
| **Devin Booker** | `booker` | **读写** (`read, bash, edit, write, ...`) | **资深攻坚手**：承担高难度复杂实现、多模块大型重构、疑难底层故障排查，必要时可承担局部代码复核。 | `xhigh` |
| **Mikal Bridges** | `bridges` | **读写** (`read, bash, edit, write, ...`) | **主力开发员**：高效率承接明确的业务功能实现、接口编写与标准 Bug 修复。 | `high` |
| **Deandre Ayton** | `ayton` | **只读** (`read, bash, grep, find, ls`，**坚决不写代码**) | **质量验证员**：专职运行测试套件、设备脚本、构建验证、巡检设备画面。发现缺陷只负责汇报证据，禁止越权改代码。 | `medium` |
| **Cameron Johnson** | `cameron` | **读写** (`read, bash, edit, write, ...`) | **资产与矩阵管家**：维护回归测试资产、同步 Qualification 矩阵状态、维护交付证据与说明文档。 | `medium` |

---

## ✨ 关键特性

- **动态账本与 DAG 任务队列（Team Ledger）**：支持将需求分解为 `Q-*` 需求与 `W-*` 有序工单，支持任务插队（`front/tail/before/after`）、读写冲突（Scope Collision）自动排队与依赖拓扑检查。
- **只读独立复核门禁（Review Protocol）**：任何写代码的任务必须派发只读复核任务（`W-rev-*`），由 CP 或不同角色审查 Diff 与可机检证据（Checkable Evidence），杜绝“自写自审”。
- **中断恢复对账（Reconcile）**：网络闪断、会话中断或超时后，无需重跑，通过 `/team reconcile` 自动读取底层 JSONL 恢复子会话结果与分支状态。
- **孤儿会话垃圾回收（GC）**：长期运行产生的庞大历史子任务会自动物理归档至 `sessions-archive/`，保证主扫描器轻量秒开。
- **双模式自由切换**：支持 `standard`（标准模式）、`economy`（经济成本优先）与 `strict`（严格规范模式）。
- **零数值硬编码**：移除虚假的并发数与调用次数熔断，模型单价实时从 `~/.pi/agent/models.json` 动态读取。
- **双运行器**：在 pi-web 中，新的子 Agent 优先通过宿主的受跟踪子会话运行，侧栏实时收到创建与状态通知；在 CLI 中仍使用独立 `pi --mode json` 进程。已有原生进程子会话保持原方式恢复，不在运行中迁移。宿主启动失败不会偷偷改用另一种方式重复派发。团队任务统一通过 `Agent` 派发，避免绕过台账重复执行。
- **手动与自动派发协调**：`team_tasks add/update` 的 `autoDispatch:false` 为受影响任务持久保留手动派发权，不影响其他自动任务；用 `Agent` 提供完整任务说明/旧子会话 `resume`，或用 `team_dispatch` 显式释放给自动调度器。同一任务、同一角色的重复派发返回已有运行会话，不新增执行。重新排队的已执行任务默认保留手动恢复权，明确 `autoDispatch:true` 才授权后台重新派发。
- **内置在线检查与自动更新**：支持一键 `/team check-update` 与 `/team update`。

### 运行要求
- Node.js >= 22.6（与 pi 一致，测试直接用 node 运行 TypeScript）
- CLI / 旧原生子会话需要 `pi` 在 `PATH` 中（或设置 `PI_BIN=/path/to/pi`）。pi-web 新子会话使用宿主工具，不依赖另一个 CLI 进程。
- pi-web 子会话采用宿主的资源加载设置；角色提示、允许工具与任务写入范围仍由 team 强制约束。每角色的 CLI 发现开关（skills/MCP/extensions/context）仅适用于原生进程，不宣称宿主工具支持这些参数。
- `~/.pi/agent/team.json` 中 `roles.*.model` 需改为**本机已配置**的模型（默认模板里的模型名只是示例）

---

## 🚀 跨机器一键安装

### 方式 1：远程一键安装（推荐，无需克隆代码）
在目标机器的终端中运行：
```bash
curl -fsSL https://raw.githubusercontent.com/viosonlee/pi-suns-teams/main/install.sh | bash
```
> 仓库需为 **public**（raw.githubusercontent.com 不支持私有仓库匿名下载）；私有仓库请用方式 2。fork 后可用 `PI_TEAMS_REPO=<owner>/pi-suns-teams` 指定来源。

### 方式 2：Git Clone 本地安装（适合开发者）
```bash
git clone https://github.com/viosonlee/pi-suns-teams.git
cd pi-suns-teams
./install.sh
```
> **开发者提示**：支持符号链接模式 `./install.sh --symlink`，修改本地仓库文件即可实时在 `pi` 中生效，无需反复拷贝。

### 配置保护机制
安装脚本具有**绝对配置保护**：
- 如果目标机器已有 `~/.pi/agent/team.json`，安装脚本**绝对不会覆盖**你的自定义模型配置，只会创建 `team.default.json` 供对比参考。

---

## 🛠️ 交互命令速查（在 pi 对话框中输入）

### 工作流启停与状态
- `/team on` — 启用团队多 Agent 调度模式
- `/team off` — 退出团队工作流
- `/team status` — 查看当前运行状态、调度中子会话与任务账本进度
- `/team mode [standard|economy|strict]` — 切换工作流模式

### 目标推进与长循环（Goal Loop）
- `/team goal <总目标描述>` — 登记长期总目标并启动主控自主推进循环
- `/team goal status` — 查看当前目标完成度与主控审核轮次
- `/team goal stop` — 暂停推进（保留当前所有未完成工单）
- `/team goal resume` — 恢复推进

### 任务队列管理（Tasks）
- `/team tasks` — 查看任务账本（就绪 / 运行中 / 待验收）
- `/team tasks move <任务ID> front|tail|before <目标ID>|after <目标ID>` — 工单优先级插队
- `/team tasks archive` — 查看已验收或归档的历史工单与证据
- `/team dispatch` — 手动触发一次调度派发

### 模型与思考分配（Models）
- `/team model` — 查看当前 5 个角色的模型与思考深度
- `/team model list [关键词]` — 模糊搜索本地可用大模型列表（快捷命令：`/models`）
- `/team model <角色> <模型ID> [思考级别]` — 一键调配指定角色的模型与思考（如 `/team model bridges deepseek-v3.1 high`）
- `/team model <角色> thinking <级别>` — 仅调整角色的思考深度（`off|low|medium|high|xhigh|max`）

### 维护与在线更新
- `/team check-update` — 联网检查 GitHub 仓库最新发布版本
- `/team update` — 在线拉取最新核心文件并完成安全热升级
- `/team reconcile [子会话ID]` — 对账并恢复中断掉线的子任务结果
- `/team gc` — 手动触发历史已结束子会话的物理归档

---

## ⚙️ 模型配置与自定义（`~/.pi/agent/team.json`）

`team.json` 掌控各角色的默认底模与备选容灾梯队：
```json
{
  "defaultEnabled": false,
  "defaultMode": "standard",
  "mainModelPolicy": "preserve",
  "roles": {
    "cp": {
      "label": "Chris Paul",
      "model": "your-provider/gpt-4o",
      "maxCalls": 0
    },
    "booker": {
      "label": "Devin Booker",
      "model": "your-provider/claude-3-7-sonnet",
      "maxCalls": 0
    },
    "bridges": {
      "label": "Mikal Bridges",
      "model": "your-provider/deepseek-v3",
      "maxCalls": 0
    },
    "ayton": {
      "label": "Deandre Ayton",
      "model": "your-provider/deepseek-v3",
      "maxCalls": 0
    },
    "cameron": {
      "label": "Cameron Johnson",
      "model": "your-provider/deepseek-v3",
      "maxCalls": 0
    }
  },
  "fallbacks": {
    "cp": ["backup-provider/gpt-4o", "backup-provider/deepseek-r1"],
    "booker": ["backup-provider/claude-3-7-sonnet"],
    "bridges": ["backup-provider/deepseek-v3"]
  }
}
```

---

## 🔄 升级与卸载

### 检查与升级
- **聊天内升级**：在任一已启用插件的会话中输入 `/team update`。
- **终端升级**：在命令行中直接运行（`--check-only` 只检查，`--force` 强制重装）：
  ```bash
  ~/.pi/agent/bin/pi-teams-update
  ```
- Git 安装会在原仓库 `git pull --ff-only` 后重新安装（保持复制/符号链接模式）；远程安装会下载最新 `install.sh` 执行。升级前自动备份到 `~/.pi/agent/backups/pi-teams-*`。

### 卸载插件
运行随附的卸载脚本（仓库内为 `./uninstall.sh`，远程安装为 `~/.pi/agent/pi-teams-uninstall.sh`）：
```bash
# 卸载核心代码并保留您的 team.json 配置
~/.pi/agent/pi-teams-uninstall.sh

# 彻底清理所有配置与备份
~/.pi/agent/pi-teams-uninstall.sh --purge
```

---

## 🧪 自动化测试验证

仓库内嵌了完善的无依赖纯逻辑测试套件：
```bash
# 运行全部离线测试（不调用真实模型；原生运行器测试使用假 pi 可执行文件）
npm test
# 或分项运行
node tests/test-team.ts
node tests/test-team-native-runner.ts
```

---

## 📄 授权协议

本项目采用 [MIT License](LICENSE) 开源协议。
