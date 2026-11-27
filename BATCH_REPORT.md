# BATCH_REPORT.md — pi-teams 流程与调度优化批次交付报告

日期：2026-11-27（JST）。执行仓库：`/home/viosonlee/pi-workspace/pi-suns-teams`。
任务来源：`/home/viosonlee/pi-workspace/pi-teams-task-20261127/TASK.md`（含 17:39 追加交接）。

---

## 1. 基线与执行口径

- 基线：干净 `main` = `origin/main` = `0f5520151213869e500b17c0405031601ca471d6`（`chore(release): v1.2.7`）。未 checkout 到 `5ade490` detached 状态；`5ade490..0f55201` 仅 3 文件（README/package.json 版本/extensions/team.ts 版本行），功能代码一致。
- 执行顺序严格遵守：改造 1 → 改造 2 → Batch 1 → Batch 2 → Batch 3，逐阶段测试、英文 conventional commit、全量测试通过后 push `origin main`。
- 测试环境：Node v22.23.2（`~/.local/opt/node/bin`），命令统一为 `npm test`（`node tests/run-all.mjs`）。
- 测试性质声明：全部为离线 TypeScript 单元测试与 extension-hook 集成测试；不声称验证了真实 hosted/native 在线部署行为。

## 2. 各阶段修改与核心设计变更

### 改造 1 — auto-worktree 接入调度器（commit `b854bce`）

修改文件：`config/team.default.json`、`extensions/team.ts`、`team-ledger.ts`、`tests/test-team-audit-regression.ts`。

- `TeamConfig` 新增 `autoWorktreeOnConflict`（默认 true，`normalizeConfig` 复制）。
- `team-ledger.ts`：`taskConflict` 顶部 sharedResources 判定抽为导出 `sharedResourcesConflict(a,b)`；新增导出 `autoWorktreeEligible(task, blockers)`；`WorkTask` 新增 `autoWorktreeFailedAt?: string`。
- `extensions/team.ts`：`autoProvisionWorktreesForReadyTasks(ctx)`——对写者冲突且无 sharedResources 交集的 ready/queued 任务调用 `provisionAutoWorktree`；成功回填 `isolation/worktreePath/worktreeBranch/worktreeOwned` + evidence，失败写 `autoWorktreeFailedAt`（fail-closed 保持串行）；`schedulerPump` 与手动 `Agent` 派发路径均接入。
- 测试：单测覆盖 eligible 各分支；集成测试在临时 git 仓库验证 running writer A + ready writer B → provision → `taskConflict` 解除。

### 改造 2 — reviewing 下严格只读放行（commit `becf24f`）

修改文件：`extensions/team.ts`、`team-ledger.ts`、`tests/test-team-audit-regression.ts`。

- `readyTasks`/`heldConflict`/`describeScopeHold` 三处一致新增放行：`reviewing` 持有者不再阻塞主树内严格只读候选（`writePaths.length===0 && !isWriterTask`）；writer 候选仍被阻塞保护待审改动；sharedResources 冲突不受影响。
- 新增回归：只读放行 / 同路径 writer 阻塞 / sharedResources 相交只读仍阻塞。既有 review-lifecycle / review-lease-release 测试仅断言 writer 受保护，语义未变。

### Batch 1 — 收口死锁与撤回/纠偏原语（commit `b17382b`）

修改文件：`team-ledger.ts`（+635）、`extensions/team.ts`（+756）、`tests/test-team-batch1-controls.ts`（新增）、`tests/test-team-role-review.ts`（语义更新）。

- 1.1：`isMetadataSettlementTransition`——非 live 目标的 `done/cancelled/superseded` 结算跳过无关 write-vs-read 锁；live 目标仍拒绝静默结算。`createReviewerTask` 的 `W-rev-*` 默认 `readMode:"snapshot"`（STALE 由 deliveryVersion/fingerprint 既有机制判定）。
- 1.2：`team_tasks` 新增 `action:"cancel"`（native/hosted 统一停止尝试，**fail-closed**：停止未确认绝不释放 lease）；新增 `action:"steer"` 受控父子通信（替换一刀切拦截）。
- 1.3：`WorkTask` 新增可变 `brief` + `briefHistory`；`action:"amend"` 原地修正 brief/acceptance/scope（scope 变更校验 live 冲突）；`retryAsRework` 原地重试避免编号膨胀；brief 注入派发/resume prompt。
- 1.4：`manualDispatch` 继承（自动 W-rev-* 与 REWORK 回退任务保持手动调度，schedulerPump 不偷跑）；统一 `decideReviewPolicy`：`reviewTier:"none"` 明确优先豁免，`autoAccept:false` 仅表示留在 reported 等显式结算，消除双轨规则。
- 评审：首轮 REWORK 6 项 → 返工后复审 PASS 零阻塞。

### Batch 2 — 结构化证据、审查刹车、上下文减负、Draining（commit `89f9154`）

修改文件：`team-ledger.ts`（累计 +2060）、`extensions/team.ts`（+1460）、新增 `team-structured-evidence.ts`、`tests/test-team-batch2-{controls,evidence,prompt-slim}.ts`、`tests/test-team-worktree.ts`（+333 修复既有集成测试缺口）。

- 2.1：一等 `structuredEvidence`（commands/artifacts/gitSha）+ artifact 持久化，超出截断的完整汇报落盘给路径引用而非丢尾；`verifyEvidenceRefs` 优先校验结构化记录。
- 2.2：`reviewTier:"advisory"` 非门禁等级（只记录不阻塞不打回）；连续 2 轮零进展 REWORK 自动止损升级（`classifyReworkProgress` 纯函数），主会话可 PASS-with-notes 或显式放行；显式 reviewerRole/llm 审查不受刹车压制。
- 2.3：`ledgerPrompt` 精简（首次/verbose 全量、常规精简）、`reconcileBacklog`/`team_goal` 输出截断封顶、顶部显式列出 `uncoveredRequests`；session_start 注水块同纪律裁剪。
- 2.4：`draining` 模式开关（禁派新任务、允许在飞收尾）+ 输入分类（`classifyInputKind` 纯函数）：纯情绪/反馈不建幽灵 `Q-*`；mustAct 指令永不进丢弃路径；critical 反馈永不自动关闭。
- 评审：首轮 REWORK 6 项（含 1 critical 误分类）→ 返工后复审 PASS 零阻塞。

### Batch 3 — 派活原子性、扇出提示、生命周期视图（commit `c444038`）

修改文件：`team-ledger.ts`（+326）、`extensions/team.ts`（+575）、`team-recovery.ts`（+11）、`tests/test-team-batch3-controls.ts`（新增）。

- 1a：`rollbackToDraft` 原子失败补偿——自动派发全失败时回滚为 draft 而非留废单；manualDispatch 任务不视为失败；诚实声明为补偿式恢复而非事务原子性。
- 1b：write-write 冲突报错内含可落地的 worktree 扇出 + 串行集成方案指引。
- 1c：破坏操作 preflight 扫描（title/brief/acceptance 启发式），派发前要求附本地只读验证证据。
- 2a：`validateSubagentMetadata` 识别 `pi-web.subsession.spawned`，消除 hosted 子会话 `foreign-parent` 误报（双向验证）。
- 2b：统一只读生命周期视图（`action:"status"`：`status/terminated/writesCommitted/liveConflictHolder`），一次调用判断子会话是否停稳可结算。
- 评审：首轮 PASS 零阻塞；评审确认 1c 的任务级 acceptance 扫描层缺口非实质（见 §4）。

## 3. 测试命令与通过统计

每阶段均实际执行 `LC_ALL=C npm test`（即 `node tests/run-all.mjs`）全量回归：

| 阶段 | 全量结果 | 新增/更新套件结果 |
|---|---|---|
| 改造 1 | 36/36 文件通过 | audit-regression 集成含 worktree provision 断言 |
| 改造 2 | 36/36 文件通过 | 只读放行回归 3 例 |
| Batch 1 | 36/36 文件通过（曾现 35/36 时序抖动，未降低阈值，原样重跑全绿后采信） | batch1-controls 全过 |
| Batch 2 | 39/39 文件通过；返工后 39/39 | batch2 三套件 56/56→60/60；注入防线 12/12 |
| Batch 3 | 40/40 文件通过，exit 0 | batch3-controls 43/43 |

最终 HEAD `c444038` 全量复跑：`LC_ALL=C npm test` exit 0，**40/40 测试文件全部通过**。

## 4. 未完成项与诚实声明

- Batch 3 1c 的「任务级 acceptance 扫描层」未实现（recon 缺口）；评审裁决非实质：dispatch-preflight 已扫描 title/brief/acceptance 且本质为启发式护栏。残余限制：纯关键词匹配可被规避，为护栏而非安全边界。
- 全部为离线测试；未在真实运行中的 hosted/native 部署上验证（红线禁止安装到 `~/.pi/agent`）。
- `5ade490` 基线差异未引入任何功能偏差（仅版本号文件）。
- 无已知测试弱化、无跳过失败硬凑。

## 5. Push 历史（目标均为 `origin main`，无 tag）

| Push | Commit 范围 | 结果 |
|---|---|---|
| 改造 1+2 | `0f55201..becf24f`（含 `b854bce`、`becf24f`） | 成功 |
| Batch 1 | `becf24f..b17382b` | 成功 |
| Batch 2 | `b17382b..89f9154` | 成功 |
| Batch 3 + 本报告 | `89f9154..c444038`（含本报告修正提交） | 成功 |

 Commit 信息均为英文 conventional commits，沿用仓库 `feat(...)`/`fix(...)` 风格。

## 6. 红线合规确认

- **未重启** `pi-web-sessiond.service` / `pi-web.service`：全程未执行任何 restart/stop；改动前只读快照 `/tmp/pi-teams-services-before.txt`（两服务 active，启动于 2026-11-27 14:17:43 JST），交付后状态一致。
- **未发版、未打 tag**：无 version bump、无 `git tag`、无 npm publish。
- **未安装到 `~/.pi/agent`**：未执行 install.sh/update.sh；`~/.pi/agent/.pi-teams-version` 现读数为 1.2.7（机主在任务开始前自行升级 v1.2.7 所致，非本次会话改动；本会话全程未执行 install.sh/update.sh、未触碰该目录）。
- 生产代码未使用 `git worktree remove --force` / `git branch -D`。
