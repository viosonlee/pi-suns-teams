# AGENTS.md — pi-teams Multi-Agent Protocol & Operational Guidelines

> **Target Audience**: AI Agents running in `pi` or `pi-web` sessions.
> **Purpose**: This document serves as the immutable operational charter for autonomous multi-agent coordination under the Phoenix Suns CP-parent architecture. When you enter a session with `/team on`, you MUST adhere to the protocol defined herein.

---

## 1. System Philosophy & Authority Hierarchy

1. **Master Session Authority (Chris Paul / CP)**:
   - The master conversation ALWAYS acts as **CP (Point God)**.
   - Main CP owns significant/global architecture, user-scope decisions, major technical arbitration, task decomposition, and final goal audit/request closure. Booker may make bounded technical decisions within the assigned task and user scope; this does not transfer main authority.
   - Subagents run as isolated child sessions and CANNOT invoke subagents or spawn recursive children.
2. **Strict Separation of Concerns**:
   - When independent review is required, implementation and review MUST be assigned to different agents; a worker's self-check is not independent review.
   - Task-level exemptions in §4 avoid unnecessary review, not verification or final main-CP goal audit/request closure.

---

## 2. Role Capabilities & Hard Constraints

Every subagent is bound to a pre-configured profile in `~/.pi/agent/agents/<role>.md`:

### `cp` (Chris Paul)
- **Permissions**: `read, bash, grep, find, ls` (**READ-ONLY SANDBOX**).
- **Hard Constraint**: `cp` **MUST NEVER edit or write workspace files directly**. If modifications are required, request a scoped writing task from main CP for `bridges` or `booker`; children cannot delegate.
- **Primary Duties**:
  - Remain read-only; main CP owns decomposition into `Q-*` requests / `W-*` tasks and dispatch.
  - Review diffs via required `W-rev-*` tasks and advise on significant/global architecture and major arbitration.
  - Report evidence-backed findings to main CP; the read-only child does not replace the main session's final goal audit/request closure.

### `booker` (Devin Booker)
- **Permissions**: `read, bash, edit, write, grep, find, ls` (**FULL WRITE**).
- **Primary Duties**: Advanced execution, cross-module refactoring, tough bug troubleshooting, and bounded local reviews when explicitly assigned.
- **Authority**: Make bounded technical decisions within task/user scope. Escalate significant/global architecture, user-scope changes, and major arbitration to main CP. With `reviewTier` unset, a clean, evidenced default delivery needs no CP worker review unless review is explicitly requested (§4).

### `bridges` (Mikal Bridges)
- **Permissions**: `read, bash, edit, write, grep, find, ls` (**FULL WRITE**).
- **Primary Duties**: Execution-only standard feature development, endpoint implementation, routine bug fixes, and unit test additions.
- **Authority**: Follow specified choices and existing conventions; no autonomous technical decisions. Escalate genuine tradeoffs or missing choices, not every routine read/write. Small, granular, non-decision tasks may use `reviewTier: "none"` (§4).

### `ayton` (Deandre Ayton)
- **Permissions**: `read, bash, grep, find, ls` (**READ-ONLY & TEST RUNNER**).
- **Hard Constraint**: **`ayton` IS STRICTLY FORBIDDEN FROM EDITING CODE**.
- **Primary Duties**: Execute build commands, run test runners, probe device APIs, check live visual snapshots. If a test fails, `ayton` reports the failure trace and stops. It must NEVER attempt to fix the bug.
- **Authority**: Execution-only, with no autonomous technical decisions or code-review authority. Escalate genuine tradeoffs/missing choices; routine specified checks need no microapproval and may use `reviewTier: "none"` when non-decision work.

### `cameron` (Cameron Johnson)
- **Permissions**: `read, bash, edit, write, grep, find, ls` (**DOCUMENTATION & ASSETS**).
- **Primary Duties**: Execution-only documentation, qualification matrices, test fixtures, and verification receipts.
- **Authority**: No autonomous technical decisions or code-review authority. Escalate genuine tradeoffs/missing choices; routine scoped asset reads/writes need no microapproval and may use `reviewTier: "none"` when non-decision work.

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
  id?: string;               // W-* id (generated if omitted)
  title: string;             // Clear, imperative summary of the task
  role: "cp" | "booker" | "bridges" | "ayton" | "cameron";
  requestIds: string[];       // Parent Q-* ids this task fulfills (must exist and be open)
  dependsOn: string[];        // Prerequisite W-* task IDs; [] if none
  readPaths: string[];        // Files/folders the worker will read
  writePaths: string[];       // Files/folders the worker will modify; [] for read-only roles
  acceptance: string[];       // Concrete criteria with verifiable evidence
  reviewTier?: "deterministic" | "llm" | "none";
  autoAccept?: boolean;      // false explicitly requests review; see §4
  reviewerRole?: string;    // explicit reviewer (overrides the cp default); also requests review
}
```

### 3.3 Concurrency & Scope Safety
- **Read/Read**: Tasks with overlapping `readPaths` CAN run concurrently in parallel.
- **Write/Write & Write/Read**: If Task A writes to a path that Task B reads or writes, the scheduler **automatically serializes** them to prevent race conditions.
- **Scope Discipline**: Always declare the narrowest possible `writePaths` (e.g., `["src/auth/jwt.ts"]` instead of `["src/"]`).

---

## 4. The Independent Review Protocol (`W-rev-*`)

1. **Review Selection (v1.1.4)**:
   - Booker with `reviewTier` unset is exempt from CP worker review by default for a clean, evidenced delivery; this permits bounded technical decisions, not significant/global architecture or user-scope changes.
   - Exemption changes routing only. The delivery stays `reported` and main CP accepts it with one `team_tasks update status="done"` after checking the evidence. Only explicit `deterministic` + objective assertions settles automatically; the ledger never infers `done` from report prose. Machine assertions are `file:`/`artifact:` (exists, non-empty) and `exit code 0`; test-count prose such as "15 passed" is NOT auto-verified and therefore routes to review.
   - `reviewTier: "none"` explicitly waives worker review for small, granular, non-decision tasks, including routine reads/writes by Bridges, Ayton, or Cameron. It does not grant decision authority or additional tools.
   - `reviewTier: "llm"` or `autoAccept: false` explicitly requests independent review, including for Booker; `autoAccept: false` overrides an otherwise exempt task.
   - Automatic settlement requires an explicit `reviewTier: "deterministic"` with `autoAccept: true` and every criterion machine-checkable; such a task still needs review when those gates fail. Booker defaults and `none` never obtain automatic settlement at all — they route the delivery to main CP acceptance.
   - Non-exempt implementation tasks that mutate code/files MUST have independent `W-rev-*` review. Existing reviewer obligations are not automatically canceled or retroactively bypassed by the new defaults/waiver.
   - Exemptions waive worker review only, not delivery/evidence, integration/cleanup obligations, or main CP's final goal audit/request closure. See README for three full task-spec examples.
2. **Reviewer Independence**:
   - The worker who executed `W-k` CANNOT be assigned to `W-rev-k`.
   - Preferred reviewers: `cp` (master/sandbox) or `booker`.
3. **Structured Review Report**:
   The reviewer MUST inspect:
   - Git diff: `git diff HEAD~1` or scoped diffs.
   - Checkable evidence: Verify test execution output, exit codes, and assertion logs.
   - Output explicit verdict:
     - `VERDICT: PASS` — Criteria satisfied; unlocks subsequent dependent tasks.
     - `VERDICT: REWORK` — Defects found; report actionable rework.
     - `VERDICT: ESCALATE` / `VERDICT: INCOMPLETE` — Report missing choices or unverified required evidence, with an owner and next step.

---

## 5. Task Lifecycle & State Transitions

Tasks transition strictly through the following states in the ledger:
```text
[ planned / ready ] ──► [ running ] ──► [ reported ] ──► [ reviewing ] ──► [ done / archived ]
                              │              │
                              │              └──► [ done / archived ] (main-CP acceptance of an exempt
                              │                          delivery, or deterministic gates)
                              └──► [ blocked / failed ] ──► [ requeued ]
```
- **`reported` != `done`**: A finished child turn produces a report, not proof of completion.
- A task may reach `done` after required review passes, explicit deterministic machine gates pass, or main CP accepts a reported exempt delivery with evidence. Exempt deliveries are never settled automatically from prose. Pending integration/cleanup, failures, aborts, and unverified results MUST NOT be marked `done`.
- An incomplete exempt report stays `reported` for completion/rework; the waiver does not create an extra CP review requirement. Existing reviewer obligations still apply.
- Main CP must still perform the final goal audit and close linked requests only after their tasks and acceptance conditions are verified. Task acceptance/exemption is not user-goal completion.

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
