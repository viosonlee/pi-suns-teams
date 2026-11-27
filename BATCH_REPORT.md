# pi-teams 分阶段执行报告

## 基线、权限与红线

- 基线：`main = origin/main = 0f5520151213869e500b17c0405031601ca471d6`（v1.2.7），开始时工作区干净；未回退到 detached 5ade490。
- 根据机主追加交接，顺序为：**改造 1 → 改造 2 → Batch 1 → Batch 2 → Batch 3**。本会话独占仓库交付；另一 worktree 的未验收草稿已冻结，不整批合并。
- 本仓库 Git 身份按用户明确答复配置为 `li feng <viosonlee114@gamil.com>`（邮箱按原样使用）。
- 没有重启/停止 `pi-web.service`、`pi-web-sessiond.service`；没有执行 `install.sh` / `update.sh` 或写入正在运行的 `~/.pi/agent`；没有发版、改版本号、创建/推送 tag。
- 所有生产改动保持 live writer/writer 和 running writer/strict reader 互斥；worktree、snapshot 与已有 deliveryVersion/artefactFingerprint 安全机制仍保留。测试清理不使用 `git worktree remove --force` / `git branch -D`。

## 改造 1：auto-worktree 调度接线

### 文件与设计

`config/team.default.json`、`extensions/team.ts`、`team-ledger.ts`、`team-worktree.ts`、`tests/test-team-audit-regression.ts`、`tests/test-team-ledger-hooks.ts`。

- 默认开启 `autoWorktreeOnConflict`；自动调度和显式 Agent 预检均在 readiness 检查前尝试创建 worktree，手动入口只授权当前 ID。
- 纯函数 `sharedResourcesConflict` / `autoWorktreeEligible`；共享外部资源保持排他，依赖/已有 child/活 lease/已有 worktree 不得被自动 relocation 绕过。
- `provisionAutoWorktree` 只在干净树成功时回填 ownership/branch/path；失败时间和原因持久化，保持原 scope 与串行锁。
- 对绝对 scope 做仓库内路径重映射并验证 symlink；native 执行器实际设置 cwd 与允许写入路径，prompt 也说明目标 worktree。Hosted 不支持不同 cwd 时 fail-closed，不伪称已提供隔离。
- 临时 Git 仓库、scope、共享资源、手动派发、hosted 兼容性均有回归。独立只读 reviewer `01a21cc7-5a68-7278-8ea5-040f95072114` 给出代码 PASS；主会话承担测试验收。

### 实测

- `LC_ALL=C node tests/test-team-audit-regression.ts` → **29 passed / 0 failed**；日志 `artifacts/batch-report/stage1-target-resume.txt`。
- `LC_ALL=C npm test` 首次本会话复核 → **35/36 test files passed / 1 failed**，`test-team-v21-verification.ts` 的已有 `<10ms` scheduler 时延断言测得 `15.731ms`；完整日志 `artifacts/batch-report/stage1-full-resume.txt`。
- 不修改测试或阈值，再执行相同 `LC_ALL=C npm test` → **36/36 test files passed / 0 failed**，exit 0；日志 `artifacts/batch-report/stage1-full-resume-retry.txt`。
- 更早开发/验证也出现过 locale 与时延波动，未将失败算作通过；使用 `LC_ALL=C` 固定 locale，但没有降低任何断言。全量 runner 的统计单位是 test file，不把文件数伪称为 individual assertions。
- `git diff --cached --check` → exit 0。

### Commit / push

`feat(scheduler): provision isolated worktrees for conflicted writers`，commit `b854bcec067c4f2b832918361001ef63c876342e`。
`git push origin main` → exit 0，实际目标 `github.com:viosonlee/pi-suns-teams.git`，范围 **`0f55201..b854bce main -> main`**。

## 改造 2：reviewing 下严格只读放行

### 文件与设计

`team-ledger.ts`、`extensions/team.ts`、`tests/test-team-reviewing-readers.ts`、`tests/test-team-audit-regression.ts`。

- 纯函数 `reviewingReadAllowed` 只允许 `writePaths=[]` 且无 writer 能力、无共享资源交集的候选绕过已停写的 reviewing 持有者；`scopeBlockingLive` / `isActiveReviewHold` 不改。
- `readyTasks`、`heldConflict`、两种持锁提示同用该判断；同任务 lease 不绕过。不同 worktree 分支也显式保留共享资源互斥。
- reviewing writer 候选仍受待审交付保护；真正 running/uncertain writer 对严格读者仍互斥。
- 改造 1 中有一项刻意保留的旧严格读者期望，在本阶段按明确新语义更新并注释；没有删掉 writer/共享资源/live writer 反例。

### 实测

- `LC_ALL=C node tests/test-team-reviewing-readers.ts` → **6 passed / 0 failed**（纯函数 + 实际 extension/Agent/lease hooks）；`artifacts/batch-report/stage2-target.txt`。开发时初版 fixture 未初始化 ledger，修正后通过，没有产品失败被伪报通过。
- `LC_ALL=C npm test` → 初次 **36/37 test files passed / 1 failed**，改造 1 旧测试期望 `ready`、实际正确为 `running`；独立 reviewer 也指出同一项 REWORK。原日志 `artifacts/batch-report/stage2-full.txt`。
- 更新该明确要求改变的期望，`LC_ALL=C npm test` → **37/37 test files passed / 0 failed**，exit 0；`artifacts/batch-report/stage2-full-final.txt`。既有 review 生命周期与 lease-release 套件均包含在全量回归中。

### Commit / push

待最终只读复核后提交并 push；下阶段开始前将确认成功。实际范围随后写回报告。

## Batch 1–3

尚未在主工作区实现或验收；不得从另一 worktree 的旧测试报告推定已通过。
