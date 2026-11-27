/** Real extension hooks + mocked tracked host tools. No model calls or host daemon changes. */
import { strict as assert } from "node:assert";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const root = mkdtempSync(join(tmpdir(), "team-host-hooks-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_BIN = join(root, "NEVER-SPAWN-NATIVE");
cpSync(resolve(import.meta.dirname, "../agents"), join(root, "agents"), { recursive: true });
writeFileSync(join(root, "team.json"), JSON.stringify({ maxConcurrent: 1, roles: { bridges: { model: "fixture/model" } }, autoGcChildSessions: false }));
const { default: team, initialState, defaultConfig } = await import("../extensions/team.ts");
const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval;
const intervals = new Set<Function>();
globalThis.setInterval = ((fn: Function) => { intervals.add(fn); return { unref() {}, fn }; }) as any;
globalThis.clearInterval = ((timer: any) => intervals.delete(timer?.fn)) as any;
let sequence = 0;
let passed = 0;
const cleanup: Array<() => Promise<void>> = [];

function harness(options: { child?: boolean; entries?: any[]; children?: Map<string, { status: string; text: string; file: string; lines: any[] }>; parentId?: string; parentFile?: string; noExecutor?: boolean; uncertain?: boolean } = {}) {
 const cwd = join(root, "work"); mkdirSync(cwd, { recursive: true });
 const parentId = options.parentId ?? randomUUID(), parentFile = options.parentFile ?? join(root, `parent-${parentId}.jsonl`);
 const seed = initialState(defaultConfig()); seed.enabled = true; seed.startedAt = new Date().toISOString();
 const entries: any[] = options.entries ?? [{ type: "custom", customType: "team-state", data: seed }];
 if (options.child) entries.push({ type: "custom", customType: "pi-web.subsession.spawned", data: { spawnedSessionId: parentId, spawnedBySessionId: "another-parent" } });
 writeFileSync(parentFile, JSON.stringify({ type: "session", version: 3, id: parentId, timestamp: new Date().toISOString(), cwd }) + "\n");
 const hooks = new Map<string, Function[]>(), tools = new Map<string, any>();
 const calls: Array<{ name: string; args: any }> = [], messages: any[] = [], activeTools: string[][] = [];
 const children = options.children ?? new Map<string, { status: string; text: string; file: string; lines: any[] }>();
 const manager = { getEntries: () => entries, getBranch: () => entries, getSessionId: () => parentId, getSessionFile: () => parentFile };
 const ctx: any = { cwd, hasUI: false, isIdle: () => true, sessionManager: manager, ui: { notify() {}, setStatus() {} }, modelRegistry: { find() {} } };
 const eventCtx = { ...ctx };
 async function emit(name: string, event: any = {}, context = eventCtx) {
  let result = event;
  for (const fn of hooks.get(name) ?? []) { const patch = await fn(result, context); if (patch) result = { ...result, ...patch }; }
  return result;
 }
 const pi: any = {
  on: (name: string, fn: Function) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
  registerFlag() {}, getFlag: () => false, registerCommand() {},
  registerTool: (tool: any) => tools.set(tool.name, tool),
  getAllTools: () => [...tools.values(), { name: "spawn_subsession" }, { name: "check_subsession" }, { name: "manage_subsession" }],
  setActiveTools: (names: string[]) => activeTools.push(names), getThinkingLevel: () => "high",
  appendEntry: (customType: string, data: any) => entries.push({ type: "custom", id: `p${++sequence}`, customType, data: structuredClone(data) }),
  sendMessage: (message: any) => messages.push(message), sendUserMessage() {},
 };
 function append(id: string, message: any) {
  const child = children.get(id)!;
  child.lines.push({ type: "message", id: `c${++sequence}`, parentId: child.lines.at(-1)?.id ?? null, timestamp: new Date().toISOString(), message: { ...message, timestamp: Date.now() } });
  writeFileSync(child.file, child.lines.map(l => JSON.stringify(l)).join("\n") + "\n");
 }
 ctx.executeTool = async (name: string, args: any) => {
  const toolCallId = `nested-${++sequence}`;
  const event = await emit("tool_call", { toolName: name, toolCallId, input: args }, eventCtx);
  if (event.block) return { isError: true, result: { content: [{ type: "text", text: event.reason }], details: {} } };
  let result: any;
  if (tools.has(name)) result = await tools.get(name).execute(toolCallId, event.input, undefined, undefined, ctx);
  else {
   calls.push({ name, args: structuredClone(event.input) });
   assert.equal(event.input.__piTeamsHostCall, undefined, "private one-use token is consumed before host execution");
   if (name === "spawn_subsession") {
    if (options.uncertain) result = { isError: true, content: [{ type: "text", text: "transport disconnected after acceptance" }], details: {} };
    else {
     const id = randomUUID(); const dir = join(root, "sessions", "host-fixture"); mkdirSync(dir, { recursive: true });
     const file = join(dir, `${id}.jsonl`);
     const lines = [
      { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd, parentSession: parentFile },
      { type: "custom", id: "marker", parentId: null, timestamp: new Date().toISOString(), customType: "pi-web.subsession.spawned", data: { version: 1, spawnedBySessionId: parentId, spawnedSessionId: id } },
     ];
     children.set(id, { status: "working", text: "", file, lines }); append(id, { role: "user", content: args.prompt });
     result = { content: [{ type: "text", text: "started" }], details: { sessionId: id, cwd } };
    }
   } else if (name === "check_subsession") {
    const child = children.get(args.sessionId)!;
    result = { content: [], details: { sessionId: args.sessionId, status: child.status, finalText: child.text, messageCount: child.lines.filter(l => l.type === "message").length } };
   } else if (name === "manage_subsession") {
    const child = children.get(args.sessionId)!; child.status = "working";
    append(args.sessionId, { role: "user", content: args.prompt });
    result = { content: [], details: { sessionId: args.sessionId, status: "working", cwd } };
   } else throw new Error(`unexpected host tool: ${name}`);
  }
  const post = await emit("tool_result", { toolName: name, toolCallId, input: event.input, ...result }, eventCtx);
  return { toolCall: { id: toolCallId }, isError: result.isError === true, result: { ...result, content: post.content ?? result.content } };
 };
 if (!options.noExecutor) eventCtx.executeTool = ctx.executeTool;
 team(pi);
 const state = () => [...entries].reverse().find(e => e.customType === "team-state")?.data;
 const task = (id: string) => state().ledger.tasks.find((t: any) => t.id === id);
 cleanup.push(() => emit("session_shutdown"));
 return { ctx, eventCtx, emit, tools, calls, children, messages, activeTools, entries, parentId, parentFile, state, task, append,
  async start() { await emit("session_start"); if (!options.child) await emit("input", { text: "Authorized fixture request", source: "rpc" }); },
  async ledger(params: any) { return tools.get("team_tasks").execute(`ledger-${++sequence}`, params, undefined, undefined, ctx); },
  async agent(params: any) { return ctx.executeTool("Agent", params); },
  async result(id: string) { return tools.get("get_subagent_result").execute(`result-${++sequence}`, { agent_id: id, wait: false }, undefined, undefined, ctx); },
  spec(id: string, role = "bridges") { return { id, title: id, role, requestIds: [state().ledger.requests.at(-1).id], dependsOn: [], readPaths: [], writePaths: role === "ayton" ? [] : [`src/${id}`], acceptance: ["Verified report"] }; },
 };
}
async function test(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log(`✓ ${name}`); }
async function tick() { for (const fn of [...intervals]) await fn(); }
try {
 await test("pi-web scheduler defers until a real host tool context exists, never falls back to CLI", async () => {
  const h = harness({ noExecutor: true }); await h.start(); await tick();
  assert.equal(h.calls.length, 0);
  const added = await h.ledger({ action: "add", tasks: [h.spec("W-auto")] });
  assert.notEqual(added.isError, true); assert.equal(h.calls.filter(c => c.name === "spawn_subsession").length, 1);
  assert.equal(h.task("W-auto").executionTransport, "hosted");
  assert.ok(h.task("W-auto").sessionId, "SDK nested wrapper identity is bound");
  await h.emit("session_shutdown");
 });
 await test("manual full brief uses tracked host; empty resume duplicate returns existing child without extra accounting", async () => {
  const h = harness(); await h.start(); await h.ledger({ action: "add", autoDispatch: false, tasks: [h.spec("W-manual")] });
  await tick(); assert.equal(h.calls.length, 0);
  const result = await h.agent({ subagent_type: "bridges", prompt: "TEAM_TASK: W-manual\nCUSTOM BRIEF must survive", run_in_background: true });
  assert.equal(result.isError, false, JSON.stringify(result));
  const id = result.result.details.sessionId;
  assert.match(h.calls[0].args.prompt, /^PI_TEAMS_HOST_ROLE: bridges/); assert.match(h.calls[0].args.prompt, /CUSTOM BRIEF must survive/);
  const count = h.state().tasks;
  const duplicate = await h.agent({ subagent_type: "bridges", prompt: "TEAM_TASK: W-manual\nSame task", resume: "", model: "", thinking: "" });
  assert.equal(duplicate.isError, false); assert.equal(duplicate.result.details.sessionId, id); assert.equal(duplicate.result.details.duplicate, true);
  assert.equal(h.state().tasks, count); assert.equal(h.calls.filter(c => c.name === "spawn_subsession").length, 1);
  const working = await h.result(id); assert.equal(working.details.status, "running");
  const child = h.children.get(id)!; child.status = "idle"; child.text = "Delivery with evidence";
  h.append(id, { role: "assistant", content: [{ type: "text", text: child.text }], stopReason: "stop" });
  const complete = await h.result(id); assert.equal(complete.details.status, "completed");
  assert.ok(["reported", "reviewing", "done"].includes(h.task("W-manual").status));
  await h.emit("session_shutdown");
 });
 await test("uncertain host launch with no ID holds scope and cannot be retried by the daemon", async () => {
  const h = harness({ uncertain: true }); await h.start();
  const response = await h.ledger({ action: "add", tasks: [h.spec("W-unknown")] });
  assert.notEqual(response.isError, true); assert.equal(h.task("W-unknown").status, "uncertain");
  assert.match(h.task("W-unknown").reason, /No automatic retry/);
  await tick(); await tick(); assert.equal(h.calls.filter(c => c.name === "spawn_subsession").length, 1);
  await h.emit("session_shutdown");
 });
 await test("failed hosted child requeue preserves its ID, resumes through manage, and cannot accept the stale report", async () => {
  const h = harness(); await h.start(); await h.ledger({ action: "add", autoDispatch: false, tasks: [h.spec("W-resume")] });
  const started = await h.agent({ subagent_type: "bridges", prompt: "TEAM_TASK: W-resume\nInitial task" });
  const id = started.result.details.sessionId, child = h.children.get(id)!;
  child.status = "idle"; child.text = "";
  h.append(id, { role: "assistant", content: [], stopReason: "error", errorMessage: "Controlled synthetic failure" });
  const failed = await h.result(id); assert.equal(failed.details.status, "failed"); assert.equal(h.task("W-resume").status, "failed");
  const update = await h.ledger({ action: "update", updates: [{ id: "W-resume", status: "ready", evidence: ["Verified stopped child from fixture"], reason: "Authorized controlled retry" }] });
  assert.notEqual(update.isError, true); assert.equal(h.task("W-resume").manualDispatch, true);
  await tick(); assert.equal(h.calls.filter(c => c.name === "spawn_subsession").length, 1);
  const resumed = await h.agent({ subagent_type: "bridges", resume: id, prompt: "TEAM_TASK: W-resume\nExact recovery instructions" });
  assert.equal(resumed.isError, false, JSON.stringify(resumed)); assert.equal(resumed.result.details.sessionId, id);
  const managed = h.calls.find(c => c.name === "manage_subsession")!;
  assert.match(managed.args.prompt, /Exact recovery instructions/); assert.equal(managed.args.model, undefined);
  child.status = "idle";
  const stale = await h.result(id); assert.equal(stale.details.status, "running", "old error/report cannot settle new attempt");
  child.text = "Fresh recovered report";
  h.append(id, { role: "assistant", content: [{ type: "text", text: child.text }], stopReason: "stop" });
  const fresh = await h.result(id); assert.equal(fresh.details.status, "completed");
  assert.equal(h.calls.filter(c => c.name === "spawn_subsession").length, 1);
  await h.emit("session_shutdown");
 });
 await test("hosted child marker disables team orchestration and enforces role tools/read-only scope", async () => {
  const h = harness({ child: true }); await h.start();
  await h.emit("before_agent_start", { prompt: "PI_TEAMS_HOST_ROLE: ayton\nTEAM_TASK: W-test\nRole: ayton\nWrite Paths: none" });
  assert.ok(h.activeTools.at(-1)?.includes("bash")); assert.ok(!h.activeTools.at(-1)?.includes("write"));
  const spawn = await h.emit("tool_call", { toolName: "Agent", input: { prompt: "delegate" } }); assert.equal(spawn.block, true);
  const write = await h.emit("tool_call", { toolName: "write", input: { path: "oops", content: "no" } }); assert.equal(write.block, true);
  const bash = await h.emit("tool_call", { toolName: "bash", input: { command: "echo bad > /tmp/oops" } }); assert.equal(bash.block, true);
  const denied = await h.ledger({ action: "list" }); assert.equal(denied.isError, true);
  await tick(); assert.equal(h.calls.length, 0); await h.emit("session_shutdown");
 });
 await test("hosted exemption skips the reviewer child and waits for one parent acceptance; booker/bridges default CP review", async () => {
  const h = harness(); await h.start();
  const proof = join(h.ctx.cwd, "role-proof.md"); writeFileSync(proof, "Fixture verification evidence\n");
  for (const role of ["booker", "bridges", "ayton", "cameron"]) {
   const id = `W-light-${role}`;
   const spec: any = h.spec(id, role);
   if (role === "booker" || role === "bridges") spec.reviewTier = "none";
   await h.ledger({ action: "add", autoDispatch: false, tasks: [spec] });
   const started = await h.agent({ subagent_type: role, prompt: `TEAM_TASK: ${id}\nPerform the bounded non-decision fixture task` });
   assert.equal(started.isError, false, JSON.stringify(started));
   const childId = started.result.details.sessionId, child = h.children.get(childId)!;
   child.status = "idle";
   child.text = `Changes: ${"Scoped fixture work verified. ".repeat(15)}\nStatus: complete\nVerification: ${proof}:1; exit code 0\nRemaining issues: none.`;
   h.append(childId, { role: "assistant", content: [{ type: "text", text: child.text }], stopReason: "stop" });
   const completed = await h.result(childId); assert.equal(completed.details.status, "completed"); await tick();
   // Exemption never settles by itself: the delivery stays reported for the parent.
   assert.equal(h.task(id).status, "reported", `${role}: ${h.task(id).reason}`);
   assert.match(h.task(id).reason, /awaiting parent acceptance/);
   assert.ok(h.task(id).evidence.some((e: string) => e.includes(proof)), "full report evidence is retained");
   assert.ok(!h.state().ledger.tasks.some((t: any) => t.parentTaskId === id), "no reviewer child is spent");
   // One parent call settles it and releases dependents.
   const accepted = await h.ledger({ action: "update", autoDispatch: false, updates: [{ id, status: "done", evidence: [`Parent checked ${proof}`], reason: "Parent verified the reported evidence" }] });
   assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
   assert.equal(h.task(id).status, "done");
  }
  await h.ledger({ action: "add", autoDispatch: false, tasks: [h.spec("W-booker-default-rev", "booker")] });
  const revStarted = await h.agent({ subagent_type: "booker", prompt: "TEAM_TASK: W-booker-default-rev\nComplex core fix" });
  const revChildId = revStarted.result.details.sessionId, revChild = h.children.get(revChildId)!;
  revChild.status = "idle";
  revChild.text = `Changes: Core fix.\nStatus: complete\nVerification: ${proof}:1; exit code 0`;
  h.append(revChildId, { role: "assistant", content: [{ type: "text", text: revChild.text }], stopReason: "stop" });
  await h.result(revChildId); await tick();
  assert.ok(h.state().ledger.tasks.some((t: any) => t.parentTaskId === "W-booker-default-rev" && t.role === "cp"), "booker default routes to independent cp review");
  await h.emit("session_shutdown");
 });
 await test("hosted ayton with writable test writePaths retains scoped write access while blocking product paths", async () => {
  const h = harness({ child: true }); await h.start();
  await h.emit("before_agent_start", { prompt: "PI_TEAMS_HOST_ROLE: ayton\nTEAM_TASK: W-test-write\nRole: ayton\nRead Paths: src/app.ts\nWrite Paths: tests/app.test.ts" });
  assert.ok(h.activeTools.at(-1)?.includes("write"), "ayton with declared test writePaths keeps write tool");
  const blockedProd = await h.emit("tool_call", { toolName: "write", toolCallId: "tc-prod", input: { path: "src/app.ts", content: "bad" } });
  assert.equal(blockedProd.block, true, "writes outside declared test writePaths remain blocked");
  const allowedTest = await h.emit("tool_call", { toolName: "write", toolCallId: "tc-test", input: { path: "tests/app.test.ts", content: "ok" } });
  assert.notEqual(allowedTest.block, true, "writes inside declared test writePaths are permitted");
  await h.emit("session_shutdown");
 });
 await test("hosted deterministic delivery auto-accepts while an explicit review request still routes to CP", async () => {
  const h = harness(); await h.start();
  const proof = join(h.ctx.cwd, "det-proof.md"); writeFileSync(proof, "Fixture verification evidence\n");
  const specs: any[] = [
   { ...h.spec("W-det", "booker"), reviewTier: "deterministic", autoAccept: true, acceptance: [`file:${proof}`, "exit code 0"] },
   { ...h.spec("W-review", "booker"), reviewTier: "llm" },
   { ...h.spec("W-manual-review", "booker"), autoAccept: false }];
  for (const spec of specs) {
   await h.ledger({ action: "add", autoDispatch: false, tasks: [spec] });
   const started = await h.agent({ subagent_type: spec.role, prompt: `TEAM_TASK: ${spec.id}\nScoped fixture task` });
   assert.equal(started.isError, false, JSON.stringify(started));
   const childId = started.result.details.sessionId, child = h.children.get(childId)!;
   child.status = "idle"; child.text = `Status: complete\nVerification: ${proof}:1; exit code 0\nRemaining issues: none.`;
   h.append(childId, { role: "assistant", content: [{ type: "text", text: child.text }], stopReason: "stop" });
   await h.result(childId); await tick();
   if (spec.id === "W-det") {
    assert.equal(h.task(spec.id).status, "done", "deterministic machine assertions still settle automatically");
    assert.ok(!h.state().ledger.tasks.some((t: any) => t.parentTaskId === spec.id));
   } else {
    assert.notEqual(h.task(spec.id).status, "done");
    assert.ok(h.state().ledger.tasks.some((t: any) => t.parentTaskId === spec.id && t.role === "cp"), "explicit review is preserved");
   }
  }
  await h.emit("session_shutdown");
 });
 await test("a working team child is checked once; repeated polls are refused before the harness aborts", async () => {
  const h = harness(); await h.start();
  await h.ledger({ action: "add", autoDispatch: false, tasks: [h.spec("W-poll", "bridges")] });
  const started = await h.agent({ subagent_type: "bridges", prompt: "TEAM_TASK: W-poll\nBounded fixture task" });
  assert.equal(started.isError, false, JSON.stringify(started));
  const childId = started.result.details.sessionId;
  // First check is allowed (the parent may legitimately ask once).
  const first = await h.ctx.executeTool("check_subsession", { sessionId: childId });
  assert.equal(first.isError, false, JSON.stringify(first.result));
  // The child is still working: a second, identical status call is refused with the next action.
  const second = await h.ctx.executeTool("check_subsession", { sessionId: childId });
  assert.equal(second.isError, true, "repeated poll must be blocked");
  const reason = String(second.result?.content?.map((c: any) => c.text ?? "").join(" ") ?? "");
  assert.match(reason, /still working/);
  assert.match(reason, /completion notice wakes this session automatically/);
  assert.match(reason, /get_subagent_result ONCE with wait:true/);
  // A real join with wait:true stays available once, and a repeat while still working is refused.
  const waited = await h.ctx.executeTool("get_subagent_result", { agent_id: childId, wait: true });
  assert.equal(waited.isError, false, JSON.stringify(waited.result));
  const waitedAgain = await h.ctx.executeTool("get_subagent_result", { agent_id: childId, wait: true });
  assert.equal(waitedAgain.isError, true, "repeated wait:true while still working must be blocked");
  // Completion clears the counter so the delivered result can be read afterwards.
  const child = h.children.get(childId)!;
  child.status = "idle"; child.text = "Status: complete\nVerification: exit code 0";
  h.append(childId, { role: "assistant", content: [{ type: "text", text: child.text }], stopReason: "stop" });
  await h.result(childId); await tick();
  const after = await h.ctx.executeTool("check_subsession", { sessionId: childId });
  assert.equal(after.isError, false, "post-completion read is allowed");
  await h.emit("session_shutdown");
 });
 await test("working hosted children trigger zero check_subsession polls across context/before_agent_start/ticks until disk completion; aborted boundary stays stopped", async () => {
  const h = harness(); await h.start();
  await h.ledger({ action: "add", autoDispatch: false, tasks: [h.spec("W-nopoll", "bridges")] });
  const started = await h.agent({ subagent_type: "bridges", prompt: "TEAM_TASK: W-nopoll\nBounded fixture task" });
  assert.equal(started.isError, false, JSON.stringify(started));
  const childId = started.result.details.sessionId;
  const checksBefore = h.calls.filter(c => c.name === "check_subsession").length;
  for (let i = 0; i < 6; i++) {
   await h.emit("before_agent_start", { systemPrompt: "sys", prompt: "" });
   await h.emit("context", { messages: [] });
   await tick();
  }
  assert.equal(h.calls.filter(c => c.name === "check_subsession").length, checksBefore, "no check_subsession polling while hosted child is working");
  const child = h.children.get(childId)!;
  child.status = "idle"; child.text = "Status: complete\nVerification: exit code 0";
  h.append(childId, { role: "assistant", content: [{ type: "text", text: child.text }], stopReason: "stop" });
  await h.emit("before_agent_start", { systemPrompt: "sys", prompt: "" });
  assert.equal(h.calls.filter(c => c.name === "check_subsession").length, checksBefore + 1, "harvests once when disk completion arrives");
  assert.ok(["reported", "reviewing", "done"].includes(h.task("W-nopoll").status));
  // Active goal must NOT force continuation on an aborted boundary.
  h.state().goal = { objective: "g", acceptance: ["a"], status: "active", rounds: 0, stalls: 0, audits: [], nextTasks: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", lastProgressAt: "2026-01-01" };
  const abortedBoundary = await h.emit("agent_before_settle", { entries: [], outcome: "aborted" });
  assert.notEqual(abortedBoundary.continue, true, "aborted turn boundary must not force goal continuation");
  await h.emit("session_shutdown");
 });
 await test("get_subagent_result suppresses duplicate follow-up notification and persists worker evidence for review", async () => {
  const h = harness(); await h.start();
  await h.ledger({ action: "add", autoDispatch: false, tasks: [h.spec("W-sync", "bridges")] });
  const started = await h.agent({ subagent_type: "bridges", prompt: "TEAM_TASK: W-sync\nBounded read-only deliverable" });
  assert.equal(started.isError, false, JSON.stringify(started));
  const childId = started.result.details.sessionId;
  const child = h.children.get(childId)!;
  const beforeNotices = h.messages.filter(m => m.customType === "pi-web:subagent-notification").length;
  child.status = "idle";
  child.text = "Changes: Analyzed module telemetry.\nStatus: complete\nVerification: src/telemetry.ts:18 verified";
  h.append(childId, { role: "assistant", content: [{ type: "text", text: child.text }], stopReason: "stop" });
  const res = await h.result(childId);
  assert.equal(res.details.status, "completed");
  await tick();
  const afterNotices = h.messages.filter(m => m.customType === "pi-web:subagent-notification").length;
  assert.equal(afterNotices, beforeNotices, "synchronous get_subagent_result must not emit delayed duplicate pi-web:subagent-notification");
  assert.ok(h.task("W-sync").evidence.some((e: string) => e.includes("Analyzed module telemetry")), "delivered report is retained on task.evidence for reviewer");
  await h.emit("session_shutdown");
 });
 await test("v1.2.1 yield guard blocks passivity on ready/reported/unwarned-blockers; cp brief skips self-review and role aligns", async () => {
  const h = harness(); await h.start();
  await h.ledger({ action: "add", autoDispatch: false, tasks: [
   { ...h.spec("W-cp-brief", "cp"), writePaths: [], acceptance: ["Brief complete"] },
   { ...h.spec("W-ready-extra", "ayton"), writePaths: [], acceptance: ["Checks complete"] },
  ] });
  // Cannot yield while ready tasks exist.
  const yieldOnReady = await h.emit("tool_call", { toolName: "yield_to_subsessions", toolCallId: "y-ready", input: {} });
  assert.equal(yieldOnReady.block, true);
  assert.match(yieldOnReady.reason, /ready unconflicted task/);
  // Launch W-cp-brief even if subagent_type was omitted -> aligns to task's cp role cleanly.
  const cpStarted = await h.agent({ prompt: "TEAM_TASK: W-cp-brief\nInspect scope", run_in_background: true });
  assert.equal(cpStarted.isError, false, JSON.stringify(cpStarted));
  const cpCall = h.calls.find(c => c.name === "spawn_subsession");
  assert.match(cpCall!.args.prompt, /^PI_TEAMS_HOST_ROLE: cp/);
  const ayStarted = await h.agent({ subagent_type: "ayton", prompt: "TEAM_TASK: W-ready-extra\nRun checks", run_in_background: true });
  const ayId = ayStarted.result.details.sessionId;
  // Poll twice while working to trip pollCounts, then finish on disk -> immediate wait=false must unlock.
  await h.ctx.executeTool("get_subagent_result", { agent_id: ayId, wait: false });
  const blockedPoll = await h.ctx.executeTool("get_subagent_result", { agent_id: ayId, wait: false });
  assert.equal(blockedPoll.isError, true, "second poll while still working blocks");
  h.children.get(ayId)!.status = "idle";
  h.children.get(ayId)!.text = "Verification: exit code 0";
  h.append(ayId, { role: "assistant", content: [{ type: "text", text: "Verification: exit code 0" }], stopReason: "stop" });
  const unlockedHarvest = await h.result(ayId);
  assert.equal(unlockedHarvest.details.status, "completed", "disk completion immediately unlocks get_subagent_result(wait=false)");
  // Finish cp brief -> must stay reported without spawning recursive W-rev-cp-brief, and block yield while reported awaits acceptance.
  const cpId = cpStarted.result.details.sessionId;
  h.children.get(cpId)!.status = "idle";
  h.children.get(cpId)!.text = "Findings: verified file:line";
  h.append(cpId, { role: "assistant", content: [{ type: "text", text: "Findings: verified file:line" }], stopReason: "stop" });
  const cpRes = await h.result(cpId);
  assert.equal(cpRes.details.status, "completed");
  assert.equal(h.task("W-cp-brief").status, "reported");
  assert.ok(!h.state().ledger.tasks.some((t: any) => t.parentTaskId === "W-cp-brief"), "cp brief must not create recursive cp-review-cp");
  const yieldOnReported = await h.emit("tool_call", { toolName: "yield_to_subsessions", toolCallId: "y-rep", input: {} });
  assert.equal(yieldOnReported.block, true);
  assert.match(yieldOnReported.reason, /reported delivery/);
  // Settle both reported tasks, block one new task, and verify blocker escalation blocks once before allowing explicit yield.
  await h.ledger({ action: "update", autoDispatch: false, updates: [
   { id: "W-cp-brief", status: "done", evidence: ["verified"], reason: "accepted" },
   { id: "W-ready-extra", status: "done", evidence: ["exit code 0"], reason: "accepted" },
  ] });
  await h.ledger({ action: "add", autoDispatch: false, tasks: [
   { ...h.spec("W-blocked-need-user", "ayton"), writePaths: [], acceptance: ["device check"] },
  ] });
  await h.ledger({ action: "update", autoDispatch: false, updates: [
   { id: "W-blocked-need-user", status: "blocked", evidence: ["device offline"], reason: "Waiting on physical device access" },
  ] });
  const yieldOnBlocker = await h.emit("tool_call", { toolName: "yield_to_subsessions", toolCallId: "y-blk", input: {} });
  assert.equal(yieldOnBlocker.block, true);
  assert.match(yieldOnBlocker.reason, /blocked\/uncertain\/failed task/);
  const yieldAfterWarn = await h.emit("tool_call", { toolName: "yield_to_subsessions", toolCallId: "y-blk2", input: {} });
  assert.notEqual(yieldAfterWarn.block, true, "second yield for same already-surfaced blocker set does not trap loop");
  await h.emit("session_shutdown");
 });
 await test("reported hosted task never re-harvests or duplicates notifications after session reload/restart; rework resume notifies once for new runId", async () => {
  const h1 = harness(); await h1.start();
  await h1.ledger({ action: "add", autoDispatch: false, tasks: [{ ...h1.spec("W-reload-nodup", "ayton"), acceptance: ["Verified pass"] }] });
  const started = await h1.agent({ subagent_type: "ayton", prompt: "TEAM_TASK: W-reload-nodup\nRun checks" });
  const childId = started.result.details.sessionId;
  const firstRunId = h1.task("W-reload-nodup").runId;
  const child = h1.children.get(childId)!;
  child.status = "idle";
  child.text = "Conclusion: PASS\nVerification: exit code 0";
  h1.append(childId, { role: "assistant", content: [{ type: "text", text: child.text }], stopReason: "stop" });
  // Parent observes host completion, delivers inline once via before_agent_start (NOT delayed followUp!)
  const startEvent = await h1.emit("before_agent_start", { systemPrompt: "sys", prompt: "" });
  assert.equal(startEvent.message?.customType, "pi-web:subagent-notification", "before_agent_start delivers hosted report inline for the current turn");
  assert.equal(h1.messages.filter(m => m.customType === "pi-web:subagent-notification").length, 0, "before_agent_start must not enqueue delayed followUp notification");
  assert.equal(h1.task("W-reload-nodup").status, "reported");
  assert.equal(h1.task("W-reload-nodup").completedNotifiedRunId, firstRunId);
  await h1.emit("session_shutdown");

  // Reload/restart a brand-new extension instance over the persisted entries + shared child files (wiping all in-memory Sets)
  const h2 = harness({ entries: h1.entries, children: h1.children, parentId: h1.parentId, parentFile: h1.parentFile });
  await h2.emit("session_start");
  const checksBeforeReload = h2.calls.filter(c => c.name === "check_subsession").length;
  const reloadStart = await h2.emit("before_agent_start", { systemPrompt: "sys", prompt: "" });
  await tick();
  assert.equal(reloadStart.message, undefined, "reloaded session must not re-deliver already-notified reported task inline");
  assert.equal(h2.calls.filter(c => c.name === "check_subsession").length, checksBeforeReload, "reloaded session must not re-poll already-notified reported task");
  assert.equal(h2.messages.filter(m => m.customType === "pi-web:subagent-notification").length, 0, "reloaded session must not re-send followUp notice");

  // Rework via explicit resume mints a new runId -> eligible to notify once when the new attempt finishes
  const requeued = await h2.ledger({ action: "update", autoDispatch: false, updates: [{ id: "W-reload-nodup", status: "ready", evidence: ["Rework round 2"], reason: "Run additional assertion" }] });
  assert.notEqual(requeued.isError, true);
  const resumed = await h2.agent({ subagent_type: "ayton", resume: childId, prompt: "TEAM_TASK: W-reload-nodup\nRound 2" });
  assert.equal(resumed.isError, false, JSON.stringify(resumed));
  const secondRunId = h2.task("W-reload-nodup").runId;
  assert.notEqual(secondRunId, firstRunId);
  assert.equal(h2.task("W-reload-nodup").completedNotifiedRunId, undefined, "new dispatch clears old completedNotifiedRunId");
  child.status = "idle";
  child.text = "Conclusion: PASS (round 2)\nVerification: exit code 0";
  h2.append(childId, { role: "assistant", content: [{ type: "text", text: child.text }], stopReason: "stop" });
  const round2Start = await h2.emit("before_agent_start", { systemPrompt: "sys", prompt: "" });
  assert.equal(round2Start.message?.customType, "pi-web:subagent-notification");
  assert.match(round2Start.message.content, /round 2/);
  assert.equal(h2.task("W-reload-nodup").completedNotifiedRunId, secondRunId);
  await h2.emit("session_shutdown");
 });
 await test("parallel get_subagent_result calls suppress sibling notifications and persist across reload", async () => {
  const h1 = harness(); await h1.start();
  await h1.ledger({ action: "add", autoDispatch: false, tasks: [
   { ...h1.spec("W-par-a", "ayton"), acceptance: ["a ok"] },
   { ...h1.spec("W-par-b", "cameron"), acceptance: ["b ok"] },
  ] });
  const sa = await h1.agent({ subagent_type: "ayton", prompt: "TEAM_TASK: W-par-a\nRun A" });
  const sb = await h1.agent({ subagent_type: "cameron", prompt: "TEAM_TASK: W-par-b\nRun B" });
  const idA = sa.result.details.sessionId, idB = sb.result.details.sessionId;
  for (const [id, txt] of [[idA, "Report A: exit 0"], [idB, "Report B: exit 0"]] as const) {
   const ch = h1.children.get(id)!;
   ch.status = "idle"; ch.text = txt;
   h1.append(id, { role: "assistant", content: [{ type: "text", text: txt }], stopReason: "stop" });
  }
  const ra = await h1.result(idA);
  assert.equal(ra.details.status, "completed");
  assert.equal(h1.messages.filter(m => m.customType === "pi-web:subagent-notification").length, 0, "get_subagent_result(A) must not trigger premature followUp notification for sibling B");
  const rb = await h1.result(idB);
  assert.equal(rb.details.status, "completed");
  assert.equal(h1.messages.filter(m => m.customType === "pi-web:subagent-notification").length, 0);
  await tick();
  const afterStart = await h1.emit("before_agent_start", { systemPrompt: "sys", prompt: "" });
  assert.equal(afterStart.message, undefined);
  assert.equal(h1.messages.filter(m => m.customType === "pi-web:subagent-notification").length, 0);
  await h1.emit("session_shutdown");
 });
 console.log(`\nTeam host hook tests passed: ${passed}`);
} finally {
 for (const stop of cleanup) await stop();
 globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear;
 rmSync(root, { recursive: true, force: true });
}
