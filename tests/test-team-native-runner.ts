/**
 * test-team-native-runner.ts
 *
 * Verification suite for the native Pi subagent runner. Uses a fake `pi` executable (PI_BIN),
 * so no provider/model calls are made.
 */

import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
	appendSessionMarker,
	buildChildArgs,
	findPiExecutable,
	getSessionDirPath,
	getSubagentResult,
	launchNativeSubagent,
	onSubagentComplete,
	parseTeamTaskIdFromPrompt,
	PROMPT_ARGV_LIMIT,
	readAgentProfile,
	readSessionOutcome,
	type ChildCompletion,
} from "../team-runner.ts";
import { buildActiveBranch, parseSessionJsonl, recoverChildReport } from "../team-recovery.ts";

// run-all.mjs disables native spawning for hook tests; this suite drives a fake pi binary itself.
delete process.env.PI_TEAMS_DISABLE_NATIVE_SPAWN;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
	await fn();
	passed += 1;
	console.log(`✓ ${name}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-native-runner-test-"));
const agentDir = path.join(tmpRoot, "agent");
fs.mkdirSync(agentDir, { recursive: true });
fs.cpSync(path.join(repoRoot, "agents"), path.join(agentDir, "agents"), { recursive: true });
const workCwd = path.join(tmpRoot, "work");
fs.mkdirSync(workCwd, { recursive: true });

// Fake pi: appends a user + assistant message chained to the current leaf, like real pi does.
const fakePi = path.join(tmpRoot, "fake-pi.mjs");
fs.writeFileSync(fakePi, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_PI_ARGV_LOG, JSON.stringify(args) + "\\n");
const file = args[args.indexOf("--session") + 1];
const lines = fs.readFileSync(file, "utf8").split("\\n").filter(Boolean).map(l => JSON.parse(l));
const ids = lines.filter(e => e.type !== "session").map(e => e.id);
const seenUser = lines.filter(e => e.type === "message" && e.message.role === "user").length;
let leaf = ids.at(-1) ?? null;
const prompt = args[args.indexOf("--") + 1];
const mode = process.env.FAKE_PI_MODE || "ok";
const now = new Date().toISOString();
const add = (message) => { const id = Math.random().toString(16).slice(2, 10); fs.appendFileSync(file, JSON.stringify({ type: "message", id, parentId: leaf, timestamp: now, message }) + "\\n"); leaf = id; };
add({ role: "user", content: prompt, timestamp: Date.now() });
if (mode === "crash") { process.stderr.write("boom: provider exploded\\n"); process.exit(2); }
if (mode === "error") { add({ role: "assistant", content: [], stopReason: "error", errorMessage: "429 Too Many Requests: rate limit exceeded", timestamp: Date.now() }); process.exit(0); }
if (mode === "slow") await new Promise(r => setTimeout(r, 400));
add({ role: "assistant", content: [{ type: "text", text: "VERDICT: PASS (history users before this run: " + seenUser + ")" }], stopReason: "stop", timestamp: Date.now() });
process.stdout.write("done\\n");
`, { mode: 0o755 });
const argvLog = path.join(tmpRoot, "argv.log");
process.env.PI_BIN = fakePi;
process.env.FAKE_PI_ARGV_LOG = argvLog;
const lastArgv = (): string[] => JSON.parse(fs.readFileSync(argvLog, "utf8").trim().split("\n").at(-1)!);

const baseOptions = { agentDir, cwd: workCwd, parentSessionId: "parent-1" };

function activeBranchOf(file: string) {
	const parsed = parseSessionJsonl(fs.readFileSync(file, "utf8"));
	assert.ok(parsed.ok, "session parses");
	const branch = buildActiveBranch(parsed.value.entries.filter((e) => e.type !== "session"));
	assert.ok(branch.ok, "active branch builds");
	return branch.branch;
}

function sessionFileOf(sessionId: string): string {
	const dir = getSessionDirPath(workCwd, agentDir);
	const name = fs.readdirSync(dir).find((f) => f.endsWith(`_${sessionId}.jsonl`));
	assert.ok(name, `session file for ${sessionId}`);
	return path.join(dir, name);
}

try {
	await test("pi executable: PI_BIN wins and no hardcoded user path is used", () => {
		assert.equal(findPiExecutable(), fakePi);
		const src = fs.readFileSync(path.join(repoRoot, "team-runner.ts"), "utf8");
		assert.ok(!/\/home\/[a-z]/.test(src), "runner must not contain a hardcoded /home/<user> path");
	});

	await test("profiles: tools, read-only roles and frontmatter switches are parsed", () => {
		for (const role of ["cp", "booker", "bridges", "ayton", "cameron"]) {
			const profile = readAgentProfile(role, agentDir);
			assert.ok(profile && profile.tools.length > 0 && profile.systemPrompt.length > 50, `${role} profile`);
		}
		const cp = readAgentProfile("cp", agentDir)!;
		assert.ok(!cp.tools.includes("edit") && !cp.tools.includes("write"), "cp is read-only");
		assert.equal(cp.loadMcp, false, "mcp: 'off' is honored");
		assert.equal(cp.loadSkills, false, "skills: false is honored");
		assert.equal(cp.loadExtensions, true, "extensions stay on (child guards live in the team extension)");
		assert.equal(cp.promptMode, "append");
	});

	await test("args: profile switches become CLI flags, prompt follows `--`, long prompts go to a file", () => {
		const profile = readAgentProfile("cp", agentDir)!;
		const args = buildChildArgs({ sessionFile: "/s.jsonl", prompt: "-starts-with-dash", model: "p/m", thinking: "high", tools: profile.tools, profile, systemPromptFile: "/sys.md" });
		assert.ok(args.includes("--no-mcp") && args.includes("--no-skills"));
		assert.ok(!args.includes("--mode"), "text print mode so pi reports model errors through its exit code");
		assert.deepEqual(args.slice(args.indexOf("--append-system-prompt"), args.indexOf("--append-system-prompt") + 2), ["--append-system-prompt", "/sys.md"]);
		assert.deepEqual(args.slice(-2), ["--", "-starts-with-dash"]);
		const noExt = buildChildArgs({ sessionFile: "/s", prompt: "x", tools: [], profile: { ...profile, loadExtensions: false }, teamExtensionPath: "/team.ts" });
		assert.ok(noExt.includes("--no-extensions") && noExt[noExt.indexOf("-e") + 1] === "/team.ts", "team extension is force-loaded");
		const viaFile = buildChildArgs({ sessionFile: "/s", prompt: "x", tools: [], profile: null, promptFile: "/p.md" });
		assert.equal(viaFile[viaFile.indexOf("--") + 1], "@/p.md");
	});

	await test("markers are chained to the leaf so the active branch keeps the conversation", () => {
		const file = path.join(tmpRoot, "chain.jsonl");
		fs.writeFileSync(file, [
			{ type: "session", version: 3, id: "c", timestamp: new Date().toISOString(), cwd: tmpRoot },
			{ type: "custom", id: "meta", parentId: null, customType: "pi-web:subagent", data: {} },
			{ type: "message", id: "u1", parentId: "meta", message: { role: "user", content: "hi" } },
			{ type: "message", id: "a1", parentId: "u1", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "report" }] } },
		].map((e) => JSON.stringify(e)).join("\n") + "\n");
		appendSessionMarker(file, "pi-web:subagent-result", { status: "completed" });
		appendSessionMarker(file, "pi-web:subagent-status", { status: "running" });
		const ids = activeBranchOf(file).map((e) => e.id);
		assert.deepEqual(ids.slice(0, 4), ["meta", "u1", "a1", ids[3]]);
		assert.equal(ids.length, 5, "both markers are on the active branch, after the conversation");
		assert.equal(readSessionOutcome(file).text, "report");
	});

	await test("background success: completion listener fires, report recovered, result marker bound", async () => {
		process.env.FAKE_PI_MODE = "ok";
		const events: ChildCompletion[] = [];
		const off = onSubagentComplete((info) => events.push(info));
		const res = await launchNativeSubagent({ subagent_type: "bridges", prompt: "TEAM_TASK: W-1\nDo it", run_id: "run-W-1" }, baseOptions);
		assert.equal(res.status, "running");
		const done = await getSubagentResult(res.sessionId, true, baseOptions);
		off();
		assert.equal(done.status, "completed");
		assert.match(done.reportText ?? "", /VERDICT: PASS/);
		assert.equal(events.length, 1);
		assert.equal(events[0].success, true);
		assert.equal(events[0].taskId, "W-1");
		assert.equal(events[0].parentSessionId, "parent-1");
		const argv = lastArgv();
		assert.ok(argv.includes("--tools") && argv.includes("-p") && argv.includes("--"), "child argv shape");
		const recovered = recoverChildReport(res.sessionId, { parentSessionId: "parent-1", sessionsDir: path.join(agentDir, "sessions"), assumeStale: true, runId: "run-W-1" });
		assert.ok(recovered.status === "native-completed" || recovered.status === "recovered", `recovery after completion: ${recovered.status} ${recovered.reason ?? ""}`);
	});

	await test("resume keeps prior conversation on the active branch", async () => {
		process.env.FAKE_PI_MODE = "ok";
		const first = await launchNativeSubagent({ subagent_type: "bridges", prompt: "first", run_in_background: false }, baseOptions);
		assert.equal(first.status, "completed");
		const second = await launchNativeSubagent({ subagent_type: "bridges", prompt: "second", resume: first.sessionId, run_in_background: false }, baseOptions);
		assert.equal(second.status, "completed");
		assert.match(second.reportText ?? "", /history users before this run: 1/, "resumed child saw the first run's user message");
		const branch = activeBranchOf(sessionFileOf(first.sessionId));
		const userTurns = branch.filter((e) => e.type === "message" && e.message?.role === "user").length;
		assert.equal(userTurns, 2, "both runs are on the active branch");
	});

	await test("model error with exit code 0 is a failure (quota text preserved for fallback)", async () => {
		process.env.FAKE_PI_MODE = "error";
		const events: ChildCompletion[] = [];
		const off = onSubagentComplete((info) => events.push(info));
		const res = await launchNativeSubagent({ subagent_type: "bridges", prompt: "x", run_in_background: false }, baseOptions);
		off();
		assert.equal(res.isError, true);
		assert.equal(res.status, "failed");
		assert.match(res.error ?? "", /rate limit/);
		assert.equal(events[0].stopReason, "error");
	});

	await test("crash: non-zero exit is a failure, log tail is the error, log kept", async () => {
		process.env.FAKE_PI_MODE = "crash";
		const events: ChildCompletion[] = [];
		const off = onSubagentComplete((info) => events.push(info));
		const res = await launchNativeSubagent({ subagent_type: "bridges", prompt: "x", run_in_background: false }, baseOptions);
		off();
		assert.equal(res.status, "failed");
		assert.match(res.error ?? "", /boom/);
		assert.ok(events[0].logFile && fs.existsSync(events[0].logFile), "failure log is kept for diagnosis");
	});

	await test("resume of a still-running child is refused", async () => {
		process.env.FAKE_PI_MODE = "slow";
		const res = await launchNativeSubagent({ subagent_type: "bridges", prompt: "slow" }, baseOptions);
		const again = await launchNativeSubagent({ subagent_type: "bridges", prompt: "again", resume: res.sessionId }, baseOptions);
		assert.equal(again.isError, true);
		assert.equal(again.status, "running");
		assert.equal((await getSubagentResult(res.sessionId, true, baseOptions)).status, "completed");
	});

	await test("long prompts are passed as an attached file", async () => {
		process.env.FAKE_PI_MODE = "ok";
		const big = "x".repeat(PROMPT_ARGV_LIMIT + 10);
		const res = await launchNativeSubagent({ subagent_type: "bridges", prompt: big, run_in_background: false }, baseOptions);
		assert.equal(res.status, "completed");
		const argv = lastArgv();
		assert.ok(argv[argv.indexOf("--") + 1].startsWith("@"), "prompt passed via @file");
		assert.ok(!argv.some((a) => a.length > PROMPT_ARGV_LIMIT), "no oversized argv entry");
	});

	await test("TEAM_TASK parser and session dir slug", () => {
		assert.equal(parseTeamTaskIdFromPrompt("TEAM_TASK: W-101\nSome task"), "W-101");
		assert.equal(parseTeamTaskIdFromPrompt("Hello\n  TEAM_TASK: W-rev-fix-1\nGoal"), "W-rev-fix-1");
		assert.equal(parseTeamTaskIdFromPrompt("No task here"), undefined);
		assert.ok(getSessionDirPath("/home/u/workspace/repo", "/a").endsWith("--home-u-workspace-repo--"));
	});

	await test("PI_TEAMS_DISABLE_NATIVE_SPAWN blocks spawning", async () => {
		process.env.PI_TEAMS_DISABLE_NATIVE_SPAWN = "1";
		try {
			const res = await launchNativeSubagent({ subagent_type: "bridges", prompt: "x" }, baseOptions);
			assert.equal(res.isError, true);
			assert.match(res.error ?? "", /disabled/);
		} finally {
			delete process.env.PI_TEAMS_DISABLE_NATIVE_SPAWN;
		}
	});

	console.log(`\nNative runner tests passed: ${passed}`);
} finally {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}
