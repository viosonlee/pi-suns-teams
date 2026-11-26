/**
 * Real extension factory + native runner with a fake `pi` executable (PI_BIN).
 * Covers child completion → ledger, idle-parent wake-up, quota fallback requeue,
 * crash settlement, and listener detachment on session_shutdown. No model calls.
 */
import { strict as assert } from "node:assert";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "team-native-hooks-"));
process.env.PI_CODING_AGENT_DIR = root;
delete process.env.PI_TEAMS_DISABLE_NATIVE_SPAWN;
cpSync(join(repoRoot, "agents"), join(root, "agents"), { recursive: true });
writeFileSync(join(root, "team.json"), JSON.stringify({ maxConcurrent: 4, fallbacks: { bridges: ["fb/model"] } }));
const work = join(root, "work");
mkdirSync(work, { recursive: true });

const fakePi = join(root, "fake-pi.mjs");
writeFileSync(fakePi, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_PI_ARGV_LOG, JSON.stringify(args) + "\\n");
const file = args[args.indexOf("--session") + 1];
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "";
const prompt = args[args.indexOf("--") + 1] || "";
const lines = fs.readFileSync(file, "utf8").split("\\n").filter(Boolean).map(l => JSON.parse(l));
let leaf = lines.filter(e => e.type !== "session").map(e => e.id).at(-1) ?? null;
const add = (message) => { const id = Math.random().toString(16).slice(2, 10); fs.appendFileSync(file, JSON.stringify({ type: "message", id, parentId: leaf, timestamp: new Date().toISOString(), message }) + "\\n"); leaf = id; };
add({ role: "user", content: prompt, timestamp: Date.now() });
if (prompt.includes("SLEEP-ME")) { await new Promise((r) => setTimeout(r, 30000)); }
if (prompt.includes("CRASH-ME")) { process.stderr.write("boom: segfault in provider\\n"); process.exit(3); }
if ((prompt.includes("QUOTA-ME") && model !== "fb/model") || (prompt.includes("QUOTA-ALWAYS") && model !== "manual/override")) { add({ role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit exceeded: quota exhausted", timestamp: Date.now() }); process.exit(0); }
add({ role: "assistant", content: [{ type: "text", text: "Implemented. Evidence: exit 0." }], stopReason: "stop", timestamp: Date.now() });
`, { mode: 0o755 });
const argvLog = join(root, "argv.log");
writeFileSync(argvLog, "");
process.env.PI_BIN = fakePi;
process.env.FAKE_PI_ARGV_LOG = argvLog;

const { default: team, initialState, defaultConfig, newGoal } = await import("../extensions/team.ts");

let seq = 0;
let passed = 0;
function harness() {
	const state = initialState(defaultConfig());
	state.enabled = true;
	state.startedAt = "2026-01-01";
	state.goal = newGoal("Original goal", ["Original acceptance"]);
	const entries: any[] = [{ type: "custom", id: "seed", customType: "team-state", data: state }];
	const hooks = new Map<string, Function[]>(), tools = new Map<string, any>(), commands = new Map<string, any>();
	const notes: string[] = [], messages: Array<{ message: any; options: any }> = [];
	const ctx: any = {
		cwd: work, hasUI: true, isIdle: () => true,
		sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => "parent", getSessionFile: () => join(root, "parent.jsonl") },
		ui: { notify: (m: string) => notes.push(m), setStatus() {} },
		model: { provider: "fixture", id: "unused" }, modelRegistry: { find: () => undefined },
	};
	const pi: any = {
		on: (n: string, f: Function) => hooks.set(n, [...(hooks.get(n) ?? []), f]),
		registerFlag() {}, getFlag: () => false,
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: (n: string, c: any) => commands.set(n, c),
		appendEntry: (t: string, data: any) => { entries.push({ type: "custom", id: `e${++seq}`, customType: t, data }); },
		getThinkingLevel: () => "high",
		sendMessage: (message: any, options: any) => {
			messages.push({ message, options });
			entries.push({ type: "custom_message", id: `m${++seq}`, customType: message.customType, details: message.details, timestamp: new Date().toISOString() });
		},
		sendUserMessage: async () => {},
	};
	team(pi);
	return {
		ctx, tools, commands, notes, messages, entries,
		state: () => [...entries].reverse().find((e) => e.customType === "team-state")?.data,
		task: (id: string) => [...entries].reverse().find((e) => e.customType === "team-state")?.data.ledger.tasks.find((t: any) => t.id === id),
		async emit(name: string, event: any = {}) { let e = event; for (const f of hooks.get(name) ?? []) { const p = await f(e, ctx); if (p) e = { ...e, ...p }; } return e; },
		ledger(p: any) { return tools.get("team_tasks").execute(`ledger${++seq}`, p, undefined, undefined, ctx); },
	};
}
async function test(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log(`✓ ${name}`); }
async function until(cond: () => boolean, label: string, ms = 8000) {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > ms) throw new Error(`timeout waiting for: ${label}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}
const spec = (q: string, id: string, title = id) => ({ id, title, role: "bridges", requestIds: [q], dependsOn: [], readPaths: [], writePaths: [`src/${id}`], acceptance: ["verified output"] });

try {
	const h = harness();
	await h.emit("session_start", { reason: "startup" });
	await h.emit("input", { text: "native fixture work", source: "rpc" });
	const q = h.state().ledger.requests.at(-1).id;

	await test("model-issued Agent dispatch runs natively; completion settles the task and wakes the idle parent", async () => {
		await h.ledger({ action: "add", autoDispatch: false, tasks: [spec(q, "W-a")] });
		const call = await h.emit("tool_call", { toolName: "Agent", toolCallId: "call-a", input: { subagent_type: "bridges", prompt: "TEAM_TASK: W-a\nDo the work." } });
		assert.notEqual(call.block, true, call.reason);
		assert.equal(typeof call.input.run_id, "string", "the ledger run id travels to the runner");
		const res = await h.tools.get("Agent").execute("call-a", call.input, undefined, undefined, h.ctx);
		assert.equal(res.isError, false, JSON.stringify(res.content));
		const sessionId = res.details.sessionId;
		await h.emit("tool_result", { toolName: "Agent", toolCallId: "call-a", input: call.input, isError: false, details: res.details, content: res.content });
		await until(() => h.messages.some((m) => m.message.details?.sessionId === sessionId), "completion notification");
		const note = h.messages.find((m) => m.message.details?.sessionId === sessionId)!;
		assert.equal(note.options.triggerTurn, true, "idle parent is woken");
		assert.equal(note.options.deliverAs, "followUp", "busy parent gets it after the current turn");
		assert.match(note.message.content, /Implemented\. Evidence: exit 0\./);
		await until(() => h.task("W-a")?.status !== "running", "W-a leaves running");
		assert.ok(["reported", "reviewing", "done"].includes(h.task("W-a").status), `W-a status ${h.task("W-a").status}`);
	});

	await test("native children are linked so pi-web nests them (collapsible) under the parent", async () => {
		const sessionId = h.task("W-a").sessionId;
		const parentFile = join(root, "parent.jsonl");
		const link = h.entries.find((e: any) => e.customType === "pi-web.subsession.link" && e.data?.spawnedSessionId === sessionId);
		assert.ok(link, "parent carries the reciprocal pi-web.subsession.link entry");
		assert.equal(link.data.spawnedBySessionId, "parent");
		assert.equal(link.data.cwd, work);
		const childLines = readFileSync(link.data.spawnedSessionFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		assert.equal(childLines[0].parentSession, parentFile, "child header points at the parent file");
		assert.ok(childLines.some((e) => e.customType === "pi-web.subsession.spawned" && e.data.spawnedBySessionId === "parent" && e.data.spawnedSessionId === sessionId), "child carries pi-web.subsession.spawned");
		const ids = new Set<string>();
		for (const e of childLines.slice(1)) { assert.ok(e.parentId === null || ids.has(e.parentId), `broken parentId chain at ${e.id}`); ids.add(e.id); }

		// Classify with pi-web's own scanner when pi-web is installed next to this node (skipped elsewhere).
		const scannerPath = join(dirname(process.execPath), "..", "lib", "node_modules", "@jmfederico", "pi-web", "dist", "server", "sessions", "sessionSummaryScanner.js");
		if (existsSync(scannerPath)) {
			writeFileSync(parentFile, [{ type: "session", version: 3, id: "parent", timestamp: new Date().toISOString(), cwd: work }, ...h.entries.filter((e: any) => e.type === "custom").map((e: any, i: number) => ({ ...e, parentId: null, timestamp: new Date().toISOString(), id: e.id ?? `p${i}` }))].map((e) => JSON.stringify(e)).join("\n") + "\n");
			const { SessionSummaryScanner } = await import(pathToFileURL(scannerPath).href);
			const rows = await new SessionSummaryScanner().scanSessionSummariesInDir(dirname(link.data.spawnedSessionFile));
			const row = rows.find((r: any) => r.id === sessionId);
			assert.equal(row?.agentSubsession, true, "pi-web classifies the native child as a nested agent subsession");
			console.log("  (verified with pi-web SessionSummaryScanner)");
		}
	});

	await test("pi-web child tools cannot bypass the ledger for team work", async () => {
		await h.ledger({ action: "add", autoDispatch: false, tasks: [spec(q, "W-s")] });
		const spawn = await h.emit("tool_call", { toolName: "spawn_subsession", toolCallId: "call-s", input: { prompt: "TEAM_TASK: W-s\nROLE: bridges. Do it." } });
		assert.equal(spawn.block, true);
		assert.match(spawn.reason, /must be dispatched with the Agent tool/);
		assert.equal(h.task("W-s").status, "ready", "blocked spawn leaves the task schedulable by the ledger only");
		const plain = await h.emit("tool_call", { toolName: "spawn_subsession", toolCallId: "call-p", input: { prompt: "Summarize the README for me." } });
		assert.notEqual(plain.block, true, "non-team subsessions stay allowed");

		const call = await h.emit("tool_call", { toolName: "Agent", toolCallId: "call-z", input: { subagent_type: "bridges", prompt: "TEAM_TASK: W-s\nSLEEP-ME then finish." } });
		assert.notEqual(call.block, true, call.reason);
		const res = await h.tools.get("Agent").execute("call-z", call.input, undefined, undefined, h.ctx);
		const child = res.details.sessionId;
		await h.emit("tool_result", { toolName: "Agent", toolCallId: "call-z", input: call.input, isError: false, details: res.details, content: res.content });
		const msg = await h.emit("tool_call", { toolName: "send_session_message", toolCallId: "call-m", input: { sessionId: child, message: "also do X" } });
		assert.equal(msg.block, true);
		assert.match(msg.reason, /concurrently with the running process/);
		const resume = await h.emit("tool_call", { toolName: "manage_subsession", toolCallId: "call-r", input: { action: "resume", sessionId: child } });
		assert.equal(resume.block, true);
		const stop = await h.emit("tool_call", { toolName: "manage_subsession", toolCallId: "call-t", input: { action: "stop", sessionId: child } });
		assert.equal(stop.block, true);
		assert.match(stop.reason, /SIGTERM/);
		await until(() => h.messages.some((m) => m.message.details?.sessionId === child && m.message.details?.status === "aborted"), "stopped child reports aborted");
		const other = await h.emit("tool_call", { toolName: "send_session_message", toolCallId: "call-o", input: { sessionId: "unrelated-session", message: "hi" } });
		assert.notEqual(other.block, true, "messages to unrelated sessions stay allowed");
	});

	await test("quota failure (exit 0 + stopReason=error) switches to the fallback model and requeues the task", async () => {
		await h.ledger({ action: "add", autoDispatch: false, tasks: [spec(q, "W-q", "QUOTA-ME fixture")] });
		const call = await h.emit("tool_call", { toolName: "Agent", toolCallId: "call-q", input: { subagent_type: "bridges", prompt: "TEAM_TASK: W-q\nQUOTA-ME please." } });
		assert.notEqual(call.block, true, call.reason);
		const res = await h.tools.get("Agent").execute("call-q", call.input, undefined, undefined, h.ctx);
		await h.emit("tool_result", { toolName: "Agent", toolCallId: "call-q", input: call.input, isError: false, details: res.details, content: res.content });
		await until(() => h.state().roleModel?.bridges === "fb/model", "fallback model applied");
		// The requeued task is re-dispatched by the scheduler with the fallback model and then succeeds.
		await until(() => readFileSync(argvLog, "utf8").split("\n").some((l) => l.includes("fb/model") && l.includes("QUOTA-ME")), "re-dispatch with fallback model");
		await until(() => ["reported", "reviewing", "done"].includes(h.task("W-q")?.status), `W-q settles (now ${h.task("W-q")?.status})`);
	});

	await test("crashed child (non-zero exit) is settled as failed with the log tail as reason", async () => {
		await h.ledger({ action: "add", autoDispatch: false, tasks: [spec(q, "W-c")] });
		const call = await h.emit("tool_call", { toolName: "Agent", toolCallId: "call-c", input: { subagent_type: "bridges", prompt: "TEAM_TASK: W-c\nCRASH-ME now." } });
		const res = await h.tools.get("Agent").execute("call-c", call.input, undefined, undefined, h.ctx);
		await h.emit("tool_result", { toolName: "Agent", toolCallId: "call-c", input: call.input, isError: false, details: res.details, content: res.content });
		await until(() => h.task("W-c")?.status === "failed", "W-c failed");
		assert.match(h.task("W-c").reason, /boom: segfault/);
	});

	await test("paused role unlocks on explicit different model and /team model command (without overwriting input.model)", async () => {
		// Exhaust the remaining bridges fallback (`fb/model`) with QUOTA-ALWAYS so `unavailable.bridges` is set
		await h.ledger({ action: "add", autoDispatch: false, tasks: [spec(q, "W-pause")] });
		const c1 = await h.emit("tool_call", { toolName: "Agent", toolCallId: "call-p1", input: { subagent_type: "bridges", prompt: "TEAM_TASK: W-pause\nQUOTA-ALWAYS fail." } });
		assert.notEqual(c1.block, true, c1.reason);
		const r1 = await h.tools.get("Agent").execute("call-p1", c1.input, undefined, undefined, h.ctx);
		await h.emit("tool_result", { toolName: "Agent", toolCallId: "call-p1", input: c1.input, isError: false, details: r1.details, content: r1.content });
		await until(() => Boolean(h.state().unavailable?.bridges), "bridges paused on exhausted fallback");
		assert.equal(h.state().unavailableModel?.bridges, "fb/model");

		// Calling without an explicit model is blocked while paused
		await h.ledger({ action: "add", autoDispatch: false, tasks: [spec(q, "W-pause-2")] });
		const blocked = await h.emit("tool_call", { toolName: "Agent", toolCallId: "call-p2", input: { subagent_type: "bridges", prompt: "TEAM_TASK: W-pause-2\nTry same model." } });
		assert.equal(blocked.block, true);

		// Calling with explicit different model (`manual/override`) bypasses stale pause AND preserves `input.model`
		const bypass = await h.emit("tool_call", { toolName: "Agent", toolCallId: "call-p3", input: { subagent_type: "bridges", model: "manual/override", prompt: "TEAM_TASK: W-pause-2\nQUOTA-ALWAYS succeed on manual." } });
		assert.notEqual(bypass.block, true, bypass.reason);
		assert.equal(bypass.input.model, "manual/override", "applyRoleModelOverrides must not overwrite explicit input.model");
		const r3 = await h.tools.get("Agent").execute("call-p3", bypass.input, undefined, undefined, h.ctx);
		await h.emit("tool_result", { toolName: "Agent", toolCallId: "call-p3", input: bypass.input, isError: false, details: r3.details, content: r3.content });
		await until(() => !h.state().unavailable?.bridges && ["reported", "reviewing", "done"].includes(h.task("W-pause-2")?.status), "success with manual model clears pause and settles task");

		// Re-pause via QUOTA-ALWAYS, then run `/team model bridges switched/model` and verify lock clears
		await h.ledger({ action: "add", autoDispatch: false, tasks: [spec(q, "W-pause-3")] });
		const c4 = await h.emit("tool_call", { toolName: "Agent", toolCallId: "call-p4", input: { subagent_type: "bridges", prompt: "TEAM_TASK: W-pause-3\nQUOTA-ALWAYS fail again." } });
		const r4 = await h.tools.get("Agent").execute("call-p4", c4.input, undefined, undefined, h.ctx);
		await h.emit("tool_result", { toolName: "Agent", toolCallId: "call-p4", input: c4.input, isError: false, details: r4.details, content: r4.content });
		await until(() => Boolean(h.state().unavailable?.bridges), "bridges re-paused");

		await h.commands.get("team").handler("model bridges switched/model", h.ctx);
		assert.equal(h.state().roleModel?.bridges, "switched/model");
		assert.equal(h.state().unavailable?.bridges, undefined, "/team model must clear stale unavailable lock");
		assert.equal(h.state().fallbackTried?.bridges, undefined, "/team model must reset fallbackTried");
	});

	await test("after session_shutdown the instance no longer reacts to child completions", async () => {
		await h.emit("session_shutdown", { reason: "reload" });
		const { launchNativeSubagent } = await import("../team-runner.ts");
		const before = h.messages.length;
		const res = await launchNativeSubagent({ subagent_type: "bridges", prompt: "late child", run_in_background: false }, { agentDir: root, cwd: work, parentSessionId: "parent" });
		assert.equal(res.status, "completed");
		await new Promise((r) => setTimeout(r, 100));
		assert.equal(h.messages.length, before, "a disposed instance must not post notifications");
	});

	console.log(`\nTeam native hook tests passed: ${passed}`);
} finally {
	rmSync(root, { recursive: true, force: true });
}
