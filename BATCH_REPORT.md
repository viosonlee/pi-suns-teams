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

本阶段提交、push 尚待执行；实际 commit 范围将在下一次报告更新中记录。任何后续阶段必须等本阶段全量通过并成功 push 后才开始。

## 改造 2 / Batch 1–3

尚未在主工作区实现或验收；不得从另一 worktree 的旧测试报告推定已通过。后续按顺序记录每阶段完整测试、审查、commit 与 `origin main` push 结果。
