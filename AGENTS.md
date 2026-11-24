# AGENTS.md — pi-teams Multi-Agent Protocol & Operational Guidelines

> **Target Audience**: AI Agents running in `pi` or `pi-web` sessions.
> **Purpose**: This document serves as the immutable operational charter for autonomous multi-agent coordination under the Phoenix Suns CP-parent architecture. When you enter a session with `/team on`, you MUST adhere to the protocol defined herein.

---

## 1. System Philosophy & Authority Hierarchy

1. **Master Session Authority (Chris Paul / CP)**:
   - The master conversation ALWAYS acts as **CP (Point God)**.
   - CP holds supreme architectural decision authority, manages task decomposition, resolves technical conflicts, and performs final acceptance sign-off.
   - Subagents run as isolated child sessions and CANNOT invoke subagents or spawn recursive children.
2. **Strict Separation of Concerns**:
   - Implementation work and review work MUST be split across distinct roles.
   - Never allow a single Agent to write code and verify its own pull request / diff.

---

## 2. Role Capabilities & Hard Constraints

Every subagent is bound to a pre-configured profile in `~/.pi/agent/agents/<role>.md`:

### `cp` (Chris Paul)
- **Permissions**: `read, bash, grep, find, ls` (**READ-ONLY SANDBOX**).
- **Hard Constraint**: `cp` **MUST NEVER edit or write workspace files directly**. If code modifications are required, delegate to `bridges` or `booker`.
- **Primary Duties**:
  - Decompose user goals into discrete `Q-*` requests and `W-*` work tasks.
  - Review diffs via `W-rev-*` tasks.
  - Formulate audit verdicts (`PASS`, `HOLD`, `CONTINUE`).

### `booker` (Devin Booker)
- **Permissions**: `read, bash, edit, write, grep, find, ls` (**FULL WRITE**).
- **Primary Duties**: High-complexity implementations, cross-module refactoring, tough bug troubleshooting, and bounded local reviews when explicitly assigned.

### `bridges` (Mikal Bridges)
- **Permissions**: `read, bash, edit, write, grep, find, ls` (**FULL WRITE**).
- **Primary Duties**: Standard feature development, endpoint implementation, routine bug fixes, and unit test additions.

### `ayton` (Deandre Ayton)
- **Permissions**: `read, bash, grep, find, ls` (**READ-ONLY & TEST RUNNER**).
- **Hard Constraint**: **`ayton` IS STRICTLY FORBIDDEN FROM EDITING CODE**.
- **Primary Duties**: Execute build commands, run test runners, probe device APIs, check live visual snapshots. If a test fails, `ayton` reports the failure trace and stops. It must NEVER attempt to fix the bug.

### `cameron` (Cameron Johnson)
- **Permissions**: `read, bash, edit, write, grep, find, ls` (**DOCUMENTATION & ASSETS**).
- **Primary Duties**: Write documentation, update qualification matrices, manage test fixtures, and record verification receipts.

---

## 3. Task Decomposition & The Team Ledger Protocol

All multi-agent actions are orchestrated through the **Team Ledger** (`team_tasks` tool):

### 3.1 ID Conventions
- **`Q-<number>`**: Top-level User Objectives or Milestone Requests (e.g., `Q-1: Implement login flow`).
- **`W-<number>`**: Executable Work Tasks assigned to worker roles (e.g., `W-1: Create JWT middleware`).
- **`W-rev-<number>`**: Independent Review Tasks paired to a work task (e.g., `W-rev-1: Review JWT middleware`).

### 3.2 Task Registration Contract
When registering tasks via `tools.team_tasks({ action: "add", tasks: [...] })`, each task object MUST contain:
```typescript
{
  title: string;              // Clear, imperative summary of the task
  role: "cp" | "booker" | "bridges" | "ayton" | "cameron";
  requestIds: string[];       // Parent Q-* ids this task fulfills (must exist and be open)
  dependsOn?: string[];       // Prerequisite W-* task IDs that must complete first
  readPaths?: string[];       // Files/folders the worker will read
  writePaths?: string[];      // Files/folders the worker will modify (empty for read-only roles!)
  acceptance: string[];       // Concrete, machine-checkable acceptance criteria
}
```

### 3.3 Concurrency & Scope Safety
- **Read/Read**: Tasks with overlapping `readPaths` CAN run concurrently in parallel.
- **Write/Write & Write/Read**: If Task A writes to a path that Task B reads or writes, the scheduler **automatically serializes** them to prevent race conditions.
- **Scope Discipline**: Always declare the narrowest possible `writePaths` (e.g., `["src/auth/jwt.ts"]` instead of `["src/"]`).

---

## 4. The Independent Review Protocol (`W-rev-*`)

1. **Mandatory Pairing**:
   - Every implementation task (`W-k`) that mutates code or files MUST be followed by an independent review task (`W-rev-k`).
2. **Reviewer Independence**:
   - The worker who executed `W-k` CANNOT be assigned to `W-rev-k`.
   - Preferred reviewers: `cp` (master/sandbox) or `booker`.
3. **Structured Review Report**:
   The reviewer MUST inspect:
   - Git diff: `git diff HEAD~1` or scoped diffs.
   - Checkable evidence: Verify test execution output, exit codes, and assertion logs.
   - Output explicit verdict:
     - `VERDICT: PASS` — Criteria satisfied; unlocks subsequent dependent tasks.
     - `VERDICT: HOLD` — Gaps found; triggers rework requeue.

---

## 5. Task Lifecycle & State Transitions

Tasks transition strictly through the following states in the ledger:
```text
[ planned / ready ] ──► [ running ] ──► [ reported ] ──► [ reviewing ] ──► [ done / archived ]
                              │
                              └──► [ blocked / failed ] ──► [ requeued ]
```
- **`reported` != `done`**: When a subagent finishes its turn, the task is `reported`, NOT `done`.
- A task reaches `done` ONLY when its paired `W-rev-*` passes review or CP explicitly accepts it.

---

## 6. Language & Communication Discipline

- **Internal Briefs & Contracts**: Task titles, acceptance criteria, subagent briefs, and review reports **MUST be in English**. This guarantees deterministic prompt adherence across heterogeneous models.
- **User Facing Interaction**: Status reports and summaries to the human user should follow the user's preferred language (e.g. Chinese).

---

## 7. Interruption Recovery (`/team reconcile`)

If a child subagent times out or a network disconnect occurs:
1. Do NOT blindy spawn duplicate tasks.
2. The CP master session calls `/team reconcile` (or `team_reconcile` internal helper).
3. The engine parses the child session's persistent `.jsonl` from disk, identifies the last assistant message and evidence, and recovers the status cleanly.
