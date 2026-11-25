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

function harness(options: { child?: boolean; entries?: any[]; noExecutor?: boolean; uncertain?: boolean } = {}) {
 const cwd = join(root, "work"); mkdirSync(cwd, { recursive: true });
 const parentId = randomUUID(), parentFile = join(root, `parent-${parentId}.jsonl`);
 const seed = initialState(defaultConfig()); seed.enabled = true; seed.startedAt = new Date().toISOString();
 const entries: any[] = options.entries ?? [{ type: "custom", customType: "team-state", data: seed }];
 if (options.child) entries.push({ type: "custom", customType: "pi-web.subsession.spawned", data: { spawnedSessionId: parentId, spawnedBySessionId: "another-parent" } });
 writeFileSync(parentFile, JSON.stringify({ type: "session", version: 3, id: parentId, timestamp: new Date().toISOString(), cwd }) + "\n");
 const hooks = new Map<string, Function[]>(), tools = new Map<string, any>();
 const calls: Array<{ name: string; args: any }> = [], messages: any[] = [], activeTools: string[][] = [];
 const children = new Map<string, { status: string; text: string; file: string; lines: any[] }>();
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
 return { ctx, eventCtx, emit, tools, calls, children, messages, activeTools, state, task, append,
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
 await test("hosted exemption skips the reviewer child and waits for one parent acceptance", async () => {
  const h = harness(); await h.start();
  const proof = join(h.ctx.cwd, "role-proof.md"); writeFileSync(proof, "Fixture verification evidence\n");
  for (const role of ["booker", "bridges", "ayton", "cameron"]) {
   const id = `W-light-${role}`;
   const spec: any = h.spec(id, role);
   if (role !== "booker") spec.reviewTier = "none";
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
 console.log(`\nTeam host hook tests passed: ${passed}`);
} finally {
 for (const stop of cleanup) await stop();
 globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear;
 rmSync(root, { recursive: true, force: true });
}
