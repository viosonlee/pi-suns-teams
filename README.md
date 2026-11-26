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
| **Chris Paul (`cp`)** | `cp` | **严格只读** (`read, bash, grep, find, ls` + `bwrap` 只读沙盒) | **独立 Code Reviewer / 架构仲裁**：专门审查 `booker`/`bridges` 的业务代码变更（`W-rev-*`）与全局架构仲裁，不干跑腿侦察；主会话担任 **Head Coach（总控）**负责拆解、调度与终验。 | `max` |
| **Devin Booker** | `booker` | **读写** (`read, bash, edit, write, ...`) | **核心架构攻坚专家**：复杂实现、跨模块重构、并发/协议与疑难排障；**不再兼职跑常规测试或实机部署**。业务实现默认经过 `cp` 独立复核把关（纯分析可 `reviewTier: "none"`）。 | `high` |
| **Mikal Bridges** | `bridges` | **读写** (`read, bash, edit, write, ...`) | **主力研发 & 只读侦察**：日常功能、Bugfix、代码/日志侦察（`declaredReadOnly: true`）与分支集成。业务改动默认经过 `cp` 复核，小改/侦察可 `reviewTier: "none"` 秒过。 | `high` |
| **Deandre Ayton** | `ayton` | **测试与实机验证** (`read, bash, edit, write, grep, find, ls`，写权限受 `writePaths` 约束) | **全能 QA & 实机测试工程师**：单元/集成/回归测试、UIQA 与**授权实机/物理设备巡检**，允许在 `tests/`/`artifacts/` 等测试目录写入脚本/日志/截图，**严禁修改产品源码**。默认**免 `cp` 二审**（主会话验收或确定性断言自动过账）。 | `medium` |
| **Cameron Johnson** | `cameron` | **读写** (`read, bash, edit, write, ...`) | **Release & Ops + 文档管家**：编译打包、测试环境/实机推包部署、发布清单、CHANGELOG/README、验收矩阵一致性核对（不改产品逻辑，不重复 Ayton 的测试）。默认**免 `cp` 二审**。 | `medium` |

---

## ✨ 关键特性

- **动态账本与 DAG 任务队列（Team Ledger）**：支持将需求分解为 `Q-*` 需求与 `W-*` 有序工单，支持任务插队（`front/tail/before/after`）、读写冲突（Scope Collision）自动排队与依赖拓扑检查。
- **按任务选择独立复核（Review Protocol）**：需要复核的任务由不同 Agent 审查 Diff 与证据，杜绝“自写自审”；Booker 默认交付和显式 `reviewTier: "none"` 的小型非决策任务可豁免工单复核，显式复核/确定性门禁与已有复核义务仍保留（见下节）。
- **中断恢复对账（Reconcile）**：网络闪断、会话中断或超时后，无需重跑，通过 `/team reconcile` 自动读取底层 JSONL 恢复子会话结果与分支状态。
- **孤儿会话垃圾回收（GC）**：长期运行产生的庞大历史子任务会自动物理归档至 `sessions-archive/`，保证主扫描器轻量秒开。
- **双模式自由切换**：支持 `standard`（标准模式）、`economy`（经济成本优先）与 `strict`（严格规范模式）。
- **零数值硬编码**：移除虚假的并发数与调用次数熔断，模型单价实时从 `~/.pi/agent/models.json` 动态读取。
- **双运行器**：在 pi-web 中，新的子 Agent 优先通过宿主的受跟踪子会话运行，侧栏实时收到创建与状态通知；在 CLI 中仍使用独立 `pi --mode json` 进程。已有原生进程子会话保持原方式恢复，不在运行中迁移。宿主启动失败不会偷偷改用另一种方式重复派发。团队任务统一通过 `Agent` 派发，避免绕过台账重复执行。
- **手动与自动派发协调**：`team_tasks add/update` 的 `autoDispatch:false` 为受影响任务持久保留手动派发权，不影响其他自动任务；用 `Agent` 提供完整任务说明/旧子会话 `resume`，或用 `team_dispatch` 显式释放给自动调度器。同一任务、同一角色的重复派发返回已有运行会话，不新增执行。重新排队的已执行任务默认保留手动恢复权，明确 `autoDispatch:true` 才授权后台重新派发。
- **内置在线检查与自动更新**：支持一键 `/team check-update` 与 `/team update`。

### v1.2.1：彻底整治主会话消极 `yield`、僵尸 `running` 卡锁与阻塞静默不上报

- **`yield_to_subsessions` 防躺平与阻塞唤醒门禁**：当账本仍有可直接派发的 `ready` 任务、可由主会话验收/处理的 `reported` 交付、或新暴露且未处理/上报的 `blocked` / `uncertain` / `failed` 阻塞项时，拦截静默挂起，强制主会话先拆解派满可用槽位、结算已完成结果或将具体阻塞点明确上报给用户。
- **修复 `Hosted role does not match` 幽灵 `running` 死锁与报错吞没**：`Agent` 传入/恢复时统一将解析后的角色回写 `subagent_type` 并在 `executeNativeAgent` 对齐台账任务角色；`get_subagent_result` 在遇到 `running + error` 时完整透出错误原因不再误导主会话；`refreshHostedNotifications` 在未获终态且遇错时不永久毒化探活印记。
- **`manage_subsession(stop)` 与磁盘终态即时回收**：当子会话被停机或磁盘已有终端快照/完成通知时，立即清除 `pollCounts` 并直接放行非阻塞 `get_subagent_result(wait=false)` 完成结算，消除“刚 stop 完却因防轮询被拒收”的卡顿。
- **豁免 `cp` 只读咨询/简报任务的自我递归 `W-rev-*`**：`role: "cp"` 的独立分析/简报任务交付后直接进入 `reported` 由 Head Coach 验收（除非显式 `reviewTier: "llm"`），消除 `cp` 审 `cp` 陷入 `Review INCOMPLETE` 阻塞死循环。
- **台账置顶 `ACTION REQUIRED` 与激进拆解引导**：在每次上下文注入的账本头部高亮待派发、待验收和阻塞任务清单，督促主会话按文件粒度或独立 `worktree` 批量填满并发。

### v1.2.0：方案 B 角色定位重塑（速度 × 质量平衡 + Ayton 实机/测试赋权）

- **解除 `ayton` 的“全盘只读死结”，统一归口自动化与实机测试**：`team-ledger.ts` 与 `team.ts` 允许 `ayton` 在 `writePaths` 中声明测试脚本与日志/截图产物目录（如 `tests/`、`artifacts/`），仅在 `writePaths: []` 时维持内核 `bwrap` 只读沙盒；放开授权范围内的实机/物理设备检验权限，仅严禁修改产品源码或未经授权刷写固件/删数据，避免实机测试再误派给 `booker`。
- **`cameron` 转型为 `Release & Ops + 文档管家`**：承接编译打包、测试/实机环境部署推包、发布清单、CHANGELOG/文档与一致性核对，与 `ayton`（专职验证/抓证据）形成清晰衔接。
- **“速度 × 质量”双轨复核倒挂纠偏**：
  - `ayton`（测试/实机验证）与 `cameron`（打包/部署/文档）在 `reviewTier` 未设置时**默认免除 `cp` 二次复核**（交付停在 `reported` 由主会话验收，或走 `deterministic + autoAccept` 自动过账），极大加快闭环；
  - `booker` 与 `bridges`（产品代码修改）在 `reviewTier` 未设置时**统一默认经过独立 `cp` 复核**，确保核心代码质量底线；纯侦察与小改动可显式设 `reviewTier: "none"` 快速通过。
- **清晰区分 `Head Coach` 与 `cp`**：全链路统一主会话为 **Head Coach（总控/调度台）**，子角色 `cp` 专职做独立代码评审与重大仲裁。

### v1.1.6：强化纯调度编排边界、消除延迟重复唤醒与补全只读交付评审上下文

- **默认严格总控模式 (`parentSoloWork: "delegated"`)**：将默认配置模板中的 `parentSoloWork` 设为 `"delegated"`，并强化主会话总控纪律：专注意图分析、需求拆解、任务台账编排、派发与验收，不亲自下场排查代码库、跑测试或替子会话抢活。
- **消除 `get_subagent_result` 同步取回后的重复唤醒与过期通知**：通过 `syncConsumedCompletions` 与 `sentCompletionNotices` 去重，避免同步调用 `get_subagent_result` 取回结果后又延迟弹出 `pi-web:subagent-notification` 二次唤醒；并对 `runId` 已更新或任务已处于 `done` / `cancelled` / `superseded` 终态的过期子会话完成事件抑制错误状态回写与延迟唤醒。
- **为 `W-rev-*` 复核注入工人交付报告摘要**：`refreshNativeNotifications` 在创建 reviewer 工单前自动持久化工人汇报文本到 `task.evidence`，并在 `buildReviewContract` 中向 `cp` 注入有界汇报/证据摘要，避免分析类、文档类或只读交付因看不到工人汇报而误判 `VERDICT: INCOMPLETE`。

### v1.1.5：彻底根治 ACP 重复拦截、后台定时器抢占与状态门禁冲突

- **零 `check_subsession` 轮询**：移除 `team-host.ts` 中 `getHostedSubagentResult` 的 250ms 紧轮询死循环，且 `refreshHostedNotifications` 在子任务运行期间仅以零工具开销检查磁盘快照与 `subsession.completion` 通知，仅在子任务真正完成或异常退出时触发一次宿主核验，彻底消除 ACP guardrail 重复调用熔断。
- **恢复 `pi-web` 实时子会话可见性且不撞车**：在 `pi-web` 中恢复受跟踪子会话派发（实时推送侧栏创建、运行状态灯与 `yield_to_subsessions` 挂起唤醒），并通过设置 `PI_TEAMS_DISABLE_HOSTED=1` 保留随时切回纯原生 CLI 进程模式的开关。
- **后台调度与原生/托管工具隔离**：`ensureSchedulerDaemon` 仅在存在真正可调度的就绪任务时工作；`pi.on("context")` 不再调用宿主工具；`Native` 后台派发不再复用已结束工具调用的 `ctx.executeTool`。
- **消除门禁死胡同与异常续跑**：消解 `pollCounts` 与 `get_subagent_result(wait: true)` 的冲突提示，限制同一运行中任务对 `wait: true` 的连续重复调用；在纯 Native 运行时拦截误调 `yield_to_subsessions` / `check_subsession`；`agent_before_settle` 尊重非 `completed`（如 `aborted`）的回合终止边界，不再强行续跑已取消回合。

### v1.1.4：决策权限、工单复核与完成条件

- **Booker 默认豁免**：`reviewTier` 未设置时不生成 CP 复核工单，交付后任务停在 `reported`，由主 CP 检查证据后一句话验收；Booker 可在任务及用户范围内做有界技术决策。重要/全局架构、用户范围变更、重大仲裁仍归 CP/main。
- **小工单显式豁免**：`reviewTier: "none"` 让小型、细粒度、非决策任务不生成 worker review，适用于 Bridges/Ayton/Cameron 的常规指定读写/检查；不增加工具权限，也不赋予自主决策权。真实取舍或缺失选择需上报，不能把执行豁免变成决策授权。
- **显式复核优先**：`reviewTier: "llm"`、`autoAccept: false` 或显式 `reviewerRole` 要求独立复核（包括 Booker；`autoAccept: false` 优先于豁免）。显式 `reviewTier: "deterministic"` 保留机器断言门禁：`autoAccept: true` 且全部验收条件都是客观机器断言（`file:` / `artifact:` / `exit code 0`）时才自动结算，否则仍需复核。报告文字里的“N passed / N failed”**不再**参与自动判定——把自由文本当通过/失败信号只会误判。已有 reviewer 义务不会自动取消或被追溯绕过。
- **豁免只改派发，不自动判定完成**：豁免任务不会根据报告里的措辞自动标 `done`（先后出过“将来时”被当成完成、`Status: pending` 配 `PASS` 被接受等问题）。唯一自动结算路径是 deterministic 客观断言（文件存在、退出码）；豁免交付一律由主 CP 验收，也仍然检查依赖是否完成。
- **完成不是结束一轮对话**：报告必须包含实际干净交付与证据；待集成/清理、失败、中止、未验证结果不得标记 `done`。主 CP 仍须最终审核整个目标，并在关联任务与验收条件全部核实后关闭需求；工单豁免不是用户目标完成。
- **沟通语言**：内部任务 brief、验收条件与报告使用 English；面向用户的语言不受限制。

#### 三个简短完整工单示例

假定 `Q-1` 已登记且开放；以下仅使用已有 task-spec 字段，路径与命令按项目替换。

```typescript
tools.team_tasks({ action: "add", tasks: [
  { // Booker default: bounded technical decisions; no implicit CP worker review.
    id: "W-1", title: "Fix the bounded cache race", role: "booker",
    requestIds: ["Q-1"], dependsOn: [],
    readPaths: ["src/cache.ts", "tests/cache.test.ts"],
    writePaths: ["src/cache.ts", "tests/cache.test.ts"],
    acceptance: ["Concurrent cache access preserves existing behavior; provide diff and passing cache-test evidence."]
  },
  { // Simple Bridges task: execute a specified choice, skip the reviewer child (parent still accepts).
    id: "W-2", title: "Set the token error text to Invalid token", role: "bridges",
    requestIds: ["Q-1"], dependsOn: [],
    readPaths: ["src/errors.ts"], writePaths: ["src/errors.ts"],
    acceptance: ["Only the specified error text changes; provide scoped diff evidence."],
    reviewTier: "none"
  },
  { // Important task: explicitly request independent review, even for Booker.
    id: "W-3", title: "Implement the approved authentication policy", role: "booker",
    requestIds: ["Q-1"], dependsOn: [],
    readPaths: ["docs/auth-policy.md", "src/auth.ts", "tests/auth.test.ts"],
    writePaths: ["src/auth.ts", "tests/auth.test.ts"],
    acceptance: ["Implementation matches the approved policy; provide scoped diff and passing authentication-test evidence."],
    reviewTier: "llm", autoAccept: false
  }
] });
```

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
