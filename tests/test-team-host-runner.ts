/**
 * test-team-host-runner.ts — offline tests for the tracked pi-web host adapter.
 * The host tools are mocked (spawn/check/manage only): no provider calls, no
 * native `pi`, no independent pi-web sessions, no transcript writes.
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createHostedRunnerState, getHostedSubagentResult, isHostedSubagent,
	launchHostedSubagent, normalizeHostToolResult, type HostedRunnerOptions,
} from "../team-host.ts";
import type { ChildCompletion } from "../team-runner.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-team-host-"));
const agentDir = path.join(root, "agent");
const workCwd = path.join(root, "work");
const sessionsRoot = path.join(agentDir, "sessions");
const childDir = path.join(sessionsRoot, "--work--");
fs.mkdirSync(childDir, { recursive: true });
fs.mkdirSync(workCwd, { recursive: true });
fs.cpSync(path.join(repoRoot, "agents"), path.join(agentDir, "agents"), { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_TEAMS_DISABLE_NATIVE_SPAWN = "1";

// A hostile sentinel: if the adapter ever fell back to a CLI child, it would run this.
const cliSentinel = path.join(root, "cli-spawned.flag");
const fakePi = path.join(root, "pi");
fs.writeFileSync(fakePi, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(cliSentinel)}, "spawned");\n`, { mode: 0o755 });
process.env.PI_BIN = fakePi;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
	await fn();
	passed += 1;
	console.log(`✓ ${name}`);
}

let seq = 0;
const nextId = () => `aaaaaaaa-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const files = new Map<string, string>();
const sessionFile = (id: string) => files.get(id) ?? (() => {
	const file = path.join(childDir, `${new Date().toISOString().replace(/:/g, "-")}_${id}.jsonl`);
	files.set(id, file);
	return file;
})();

interface HostFixture {
	spawns: number;
	checks: number;
	resumes: number;
	spawnArgs: Array<Record<string, unknown>>;
	manageArgs: Array<Record<string, unknown>>;
	status: "working" | "idle" | "error";
	finalText: string;
	errorDetail?: string;
	messageCount?: number;
	failSpawn?: string;
	failCheck?: string;
	failManage?: string;
}
function makeHost(): { host: HostFixture; executeTool: HostedRunnerOptions["executeTool"] } {
	const host: HostFixture = { spawns: 0, checks: 0, resumes: 0, spawnArgs: [], manageArgs: [], status: "idle", finalText: "", messageCount: 2 };
	const ok = (details: Record<string, unknown>) => ({
		toolCall: { toolName: "host", args: {} },
		result: { content: [{ type: "text", text: "MODEL-FACING TEXT MUST BE IGNORED" }], details },
		isError: false,
	});
	const executeTool: HostedRunnerOptions["executeTool"] = async (name, args) => {
		if (name === "spawn_subsession") {
			host.spawns += 1;
			host.spawnArgs.push(args);
			if (host.failSpawn) return { toolCall: {}, result: { content: [{ type: "text", text: "ignored" }] }, isError: true, error: host.failSpawn };
			return ok({ sessionId: idFromPromptCounter(), cwd: workCwd });
		}
		if (name === "check_subsession") {
			host.checks += 1;
			if (host.failCheck) throw new Error(host.failCheck);
			return ok({
				sessionId: args.sessionId, cwd: workCwd, status: host.status,
				finalText: host.finalText, ...(host.messageCount === undefined ? {} : { messageCount: host.messageCount }),
				...(host.errorDetail === undefined ? {} : { errorDetail: host.errorDetail }),
			});
		}
		if (name === "manage_subsession") {
			host.manageArgs.push(args);
			if (args.action === "resume") host.resumes += 1;
			if (host.failManage) throw new Error(host.failManage);
			return ok({ sessionId: args.sessionId, cwd: workCwd, status: "working" });
		}
		throw new Error(`unexpected host tool ${name}`);
	};
	return { host, executeTool };
}
let spawnCounter = 0;
function idFromPromptCounter() { return hostSpawnId ?? (hostSpawnId = nextId()); }
let hostSpawnId: string | undefined;

function hostedFile(id: string, opts: {
	assistant?: { text?: string; stopReason?: string; errorMessage?: string; timestamp: number };
	spawnedBy?: string;
	legacyCli?: boolean;
	parentFile?: string;
	noMarker?: boolean;
} = {}) {
	const entries: any[] = [
		{ type: "session", version: 3, id, timestamp: new Date(opts.assistant?.timestamp ?? Date.now()).toISOString(), cwd: workCwd, ...(opts.parentFile ? { parentSession: opts.parentFile } : {}) },
	];
	if (!opts.noMarker) entries.push({ type: "custom", id: "link", parentId: null, customType: "pi-web.subsession.spawned", data: { spawnedBySessionId: opts.spawnedBy ?? "parent-host", spawnedSessionId: id } });
	if (opts.legacyCli) entries.push({ type: "custom", id: "meta", parentId: "link", customType: "pi-web:subagent", data: { parentSessionId: "parent-host" } });
	entries.push({ type: "message", id: "u1", parentId: opts.legacyCli ? "meta" : "link", timestamp: new Date().toISOString(), message: { role: "user", content: "work", timestamp: Date.now() } });
	if (opts.assistant) {
		entries.push({
			type: "message", id: "a1", parentId: "u1", timestamp: new Date(opts.assistant.timestamp).toISOString(),
			message: {
				role: "assistant", timestamp: opts.assistant.timestamp, stopReason: opts.assistant.stopReason ?? "stop",
				...(opts.assistant.errorMessage ? { errorMessage: opts.assistant.errorMessage } : {}),
				content: opts.assistant.text ? [{ type: "text", text: opts.assistant.text }] : [],
			},
		});
	}
	const file = sessionFile(id);
	fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
	return file;
}
function appendAssistant(id: string, assistant: { text?: string; stopReason?: string; errorMessage?: string; timestamp: number }) {
	const file = sessionFile(id);
	const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const leaf = lines.at(-1).id;
	lines.push({
		type: "message", id: `a-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, parentId: leaf,
		timestamp: new Date(assistant.timestamp).toISOString(),
		message: {
			role: "assistant", timestamp: assistant.timestamp, stopReason: assistant.stopReason ?? "stop",
			...(assistant.errorMessage ? { errorMessage: assistant.errorMessage } : {}),
			content: assistant.text ? [{ type: "text", text: assistant.text }] : [],
		},
	});
	fs.writeFileSync(file, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
function freshHostSpawn(): { host: HostFixture; options: HostedRunnerOptions; id: string } {
	const { host, executeTool } = makeHost();
	hostSpawnId = nextId();
	const id = hostSpawnId;
	return {
		host, id,
		options: {
			agentDir, cwd: workCwd, parentSessionId: "parent-host", executeTool,
			state: createHostedRunnerState(), pollIntervalMs: 1, waitTimeoutMs: 40,
		},
	};
}

try {
	await test("normalizeHostToolResult unwraps the SDK wrapper, keeps outer isError, accepts raw mocks", () => {
		assert.deepEqual(normalizeHostToolResult({ toolCall: {}, result: { content: [], details: { sessionId: "s" } }, isError: false }),
			{ details: { sessionId: "s" }, isError: false });
		assert.deepEqual(normalizeHostToolResult({ content: [], details: { sessionId: "s" }, isError: true }),
			{ details: { sessionId: "s" }, isError: true });
		assert.deepEqual(normalizeHostToolResult({ toolCall: {}, result: { content: [], details: { sessionId: "s" } }, isError: true, error: "blocked" }),
			{ details: { sessionId: "s" }, isError: true, errorText: "blocked" });
		assert.deepEqual(normalizeHostToolResult({ toolCall: {}, result: { content: [] }, isError: false }), { isError: false });
		assert.throws(() => normalizeHostToolResult(undefined), /non-object/);
	});

	await test("hosted provenance: spawned marker without pi-web:subagent; legacy CLI is not hosted", () => {
		const hosted = nextId();
		hostedFile(hosted, { spawnedBy: "parent-host", assistant: { text: "r", timestamp: Date.now() } });
		assert.equal(isHostedSubagent(hosted, { agentDir, parentSessionId: "parent-host" }), true);
		const foreign = nextId();
		hostedFile(foreign, { spawnedBy: "someone-else" });
		assert.equal(isHostedSubagent(foreign, { agentDir, parentSessionId: "parent-host" }), false);
		const legacy = nextId();
		hostedFile(legacy, { spawnedBy: "parent-host", legacyCli: true });
		assert.equal(isHostedSubagent(legacy, { agentDir, parentSessionId: "parent-host" }), false, "native CLI marker routes native");
		const unmarked = nextId();
		hostedFile(unmarked, { spawnedBy: "parent-host", noMarker: true });
		assert.equal(isHostedSubagent(unmarked, { agentDir }), false);
		assert.equal(isHostedSubagent(nextId(), { agentDir }), false, "unknown id");
	});

	await test("spawn: forwarded prompt starts with exact role marker + full profile + brief; idle report completes once", async () => {
		const { host, options, id } = freshHostSpawn();
		hostedFile(id, { spawnedBy: "parent-host", assistant: { text: "VERDICT: PASS host", timestamp: Date.now() + 5 } });
		host.status = "idle"; host.finalText = "VERDICT: PASS host"; host.messageCount = 3;
		const completions: ChildCompletion[] = [];
		const result = await launchHostedSubagent(
			{ subagent_type: "bridges", prompt: "TEAM_TASK: W-9\nImplement it", run_id: "run-W-9", run_in_background: true },
			{ ...options, onChildComplete: (info) => completions.push(info) },
		);
		assert.equal(result.status, "running");
		assert.equal(result.sessionId, id);
		assert.equal(host.spawns, 1);
		assert.equal(host.checks, 0, "background launch never polls");
		const args = host.spawnArgs[0];
		const prompt = String(args.prompt);
		assert.ok(prompt.startsWith(`PI_TEAMS_HOST_ROLE: bridges\n`), "role marker is the first line");
		assert.ok(prompt.includes("PI_TEAMS_HOST_ROLE: bridges") && prompt.includes("TEAM_TASK: W-9"));
		const bridgesBody = fs.readFileSync(path.join(agentDir, "agents", "bridges.md"), "utf8");
		const bodyStart = bridgesBody.split(/\n---\r?\n/)[1]?.trim().slice(0, 80);
		assert.ok(bodyStart && prompt.includes(bodyStart), "profile instructions are not lost");
		assert.equal(args.model, "magpie/devin/claude-haiku-5-5", "profile model is forwarded for a NEW child");
		assert.equal(args.thinkingLevel, "high", "profile thinking is forwarded for a NEW child");
		assert.ok(!("empty" in args), "no unrelated fields");

		const beforeHarvest = fs.readFileSync(sessionFile(id), "utf8");
		const harvested = await getHostedSubagentResult(id, false, { ...options, role: "bridges", runId: "run-W-9", onChildComplete: (i) => completions.push(i) });
		assert.equal(fs.readFileSync(sessionFile(id), "utf8"), beforeHarvest, "adapter never appends to the host-owned JSONL");
		assert.equal(harvested.status, "completed");
		assert.equal(harvested.isError, false);
		assert.equal(harvested.reportText, "VERDICT: PASS host");
		assert.equal(harvested.completion?.taskId, "W-9");
		assert.equal(completions.length, 1);
		await getHostedSubagentResult(id, false, { ...options, role: "bridges", runId: "run-W-9", onChildComplete: (i) => completions.push(i) });
		assert.equal(completions.length, 1, "no repeated terminal callback");
		assert.ok(!fs.existsSync(cliSentinel), "never falls back to the CLI");
	});

	await test("empty optional model/thinking are omitted, not forwarded as empty strings", async () => {
		const { host, options, id } = freshHostSpawn();
		hostedFile(id, { spawnedBy: "parent-host" });
		fs.writeFileSync(path.join(agentDir, "agents", "naked.md"), "---\ntools: read\nprompt_mode: append\n---\nNaked profile body\n");
		await launchHostedSubagent({ subagent_type: "naked", prompt: "brief", run_in_background: true }, options);
		assert.deepEqual(Object.keys(host.spawnArgs[0]), ["prompt"]);
		assert.ok(String(host.spawnArgs[0].prompt).includes("Naked profile body"));
	});

	await test("working child: no success, no callback, partial output withheld", async () => {
		const { host, options, id } = freshHostSpawn();
		hostedFile(id, { spawnedBy: "parent-host", assistant: { text: "OLD success", timestamp: Date.now() - 60_000 } });
		host.status = "working"; host.finalText = "partial"; host.messageCount = 3;
		const completions: ChildCompletion[] = [];
		const result = await getHostedSubagentResult(id, false, { ...options, role: "bridges", onChildComplete: (i) => completions.push(i) });
		assert.equal(result.status, "running");
		assert.equal(result.isError, false);
		assert.equal(result.reportText, undefined);
		assert.equal(completions.length, 0);
	});

	await test("quota failure: idle with empty finalText has no errorDetail; disk latest assistant.errorMessage is the literal", async () => {
		const { host, options, id } = freshHostSpawn();
		hostedFile(id, { spawnedBy: "parent-host" });
		appendAssistant(id, { stopReason: "error", errorMessage: "额度不足:US$0.00 < US$0.03", timestamp: Date.now() + 5 });
		// The host scanner may still expose its previous successful answer; disk wins.
		host.status = "idle"; host.finalText = "OLD SUCCESS"; host.errorDetail = undefined; host.messageCount = 4;
		const completions: ChildCompletion[] = [];
		const result = await getHostedSubagentResult(id, false, { ...options, role: "ayton", runId: "run-quota", onChildComplete: (i) => completions.push(i) });
		assert.equal(result.status, "failed");
		assert.equal(result.isError, true);
		assert.match(String(result.error), /额度不足:US\$0\.00 < US\$0\.03/);
		assert.equal(result.reportText, undefined, "stale host success is not reported");
		assert.equal(completions.length, 1);
		const repeated = await getHostedSubagentResult(id, false, { ...options, role: "ayton", runId: "run-quota", onChildComplete: (i) => completions.push(i) });
		assert.equal(repeated.status, "failed");
		assert.equal(completions.length, 1, "failure callback is also once-only");
	});

	await test("non-final latest assistant (toolUse/aborted) is never completed from prefatory text", async () => {
		const toolUse = freshHostSpawn();
		hostedFile(toolUse.id, { spawnedBy: "parent-host", assistant: {
			text: "I will run the tests now", stopReason: "toolUse", timestamp: Date.now() + 5,
		} });
		toolUse.host.status = "idle"; toolUse.host.finalText = "I will run the tests now"; toolUse.host.messageCount = 3;
		const completions: ChildCompletion[] = [];
		const result = await getHostedSubagentResult(toolUse.id, false, {
			...toolUse.options, role: "bridges", runId: "run-tooluse", onChildComplete: (i) => completions.push(i),
		});
		assert.equal(result.status, "failed");
		assert.equal(result.isError, true);
		assert.equal(result.reportText, undefined, "pre-tool-call commentary is not a final report");
		assert.match(String(result.error), /non-final stopReason=toolUse/);
		assert.notEqual(result.completion?.success, true);
		assert.equal(completions.length, 1);

		const aborted = freshHostSpawn();
		hostedFile(aborted.id, { spawnedBy: "parent-host", assistant: {
			text: "partial answer", stopReason: "aborted", timestamp: Date.now() + 5,
		} });
		aborted.host.status = "idle"; aborted.host.finalText = "partial answer"; aborted.host.messageCount = 3;
		const abortedResult = await getHostedSubagentResult(aborted.id, false, { ...aborted.options, role: "bridges", runId: "run-aborted" });
		assert.equal(abortedResult.status, "aborted");
		assert.equal(abortedResult.reportText, undefined);
		assert.match(String(abortedResult.error), /non-final stopReason=aborted/);
	});

	await test("idle empty without any evidence is failed, never success", async () => {
		const { host, options, id } = freshHostSpawn();
		hostedFile(id, { spawnedBy: "parent-host" });
		host.status = "idle"; host.finalText = ""; host.messageCount = 2;
		const result = await getHostedSubagentResult(id, false, { ...options, role: "Ayton" });
		assert.equal(result.status, "failed", "role is normalized");
		assert.match(String(result.error), /without a final assistant report/);

		// Restart-style harvest: no in-memory attempt, only a persisted dispatchedAt.
		const recoveryOptions = { ...options, state: createHostedRunnerState(), role: "ayton", runId: "run-restart", reportNotBefore: new Date(Date.now() - 5000).toISOString() };
		const recovered = await getHostedSubagentResult(id, false, recoveryOptions);
		assert.equal(recovered.status, "failed");
		assert.match(String(recovered.error), /without a final assistant report/);
	});

	await test("host check error: structured running+isError, no terminal callback, no CLI fallback", async () => {
		const { host, options, id } = freshHostSpawn();
		hostedFile(id, { spawnedBy: "parent-host", assistant: { text: "maybe done", timestamp: Date.now() } });
		host.failCheck = "host unavailable";
		const completions: ChildCompletion[] = [];
		const result = await getHostedSubagentResult(id, false, { ...options, role: "bridges", onChildComplete: (i) => completions.push(i) });
		assert.equal(result.status, "running");
		assert.equal(result.isError, true);
		assert.match(String(result.error), /host unavailable/);
		assert.equal(completions.length, 0);
		assert.equal(host.spawns, 0);
		assert.ok(!fs.existsSync(cliSentinel));
	});

	await test("spawn failure and malformed details are launchUncertain running, identity never inferred from text", async () => {
		const a = freshHostSpawn();
		a.host.failSpawn = "spawn rejected";
		const failed = await launchHostedSubagent({ subagent_type: "bridges", prompt: "x" }, a.options);
		assert.equal(failed.status, "running");
		assert.equal(failed.isError, true);
		assert.equal(failed.launchUncertain, true);
		assert.equal(failed.sessionId, "");
		assert.match(String(failed.error), /spawn rejected/);
		assert.equal(a.host.spawns, 1, "no duplicate retry");

		const b = freshHostSpawn();
		const raw = { ...b.options, executeTool: async () => ({ toolCall: {}, result: { content: [{ type: "text", text: "started child 123" }] }, isError: false }) };
		const malformed = await launchHostedSubagent({ subagent_type: "bridges", prompt: "x" }, raw);
		assert.equal(malformed.status, "running");
		assert.equal(malformed.isError, true);
		assert.equal(malformed.launchUncertain, true);
		assert.equal(malformed.sessionId, "", "text identity is never inferred");
		assert.match(String(malformed.error), /missing structured details/);
		assert.ok(!fs.existsSync(cliSentinel), "text never substitutes for details");
	});

	await test("accepted identity survives outer.isError with quota diagnostic; no delayed second host invocation", async () => {
		const base = freshHostSpawn();
		let spawns = 0;
		const options = {
			...base.options,
			executeTool: async (name: string) => {
				if (name !== "spawn_subsession") throw new Error(`unexpected ${name}`);
				spawns += 1;
				return {
					toolCall: { toolName: "spawn_subsession", args: {} },
					result: { content: [{ type: "text", text: "started but quota" }], details: { sessionId: "known-host-child" } },
					isError: true, error: "额度不足:US$0.00 < US$0.03",
				};
			},
		};
		const result = await launchHostedSubagent({ subagent_type: "bridges", prompt: "x" }, options);
		assert.equal(result.status, "running");
		assert.equal(result.isError, true);
		assert.equal(result.launchUncertain, true);
		assert.equal(result.sessionId, "known-host-child", "structured identity is preserved");
		assert.equal(result.error, "额度不足:US$0.00 < US$0.03", "host diagnostic preserves the quota literal");
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(spawns, 1, "no delayed second spawn invocation");
	});

	await test("pre-host validation errors are safe failures without launchUncertain", async () => {
		const { host, options, id } = freshHostSpawn();
		const missingProfile = await launchHostedSubagent({ subagent_type: "ghost-role", prompt: "x" }, options);
		assert.equal(missingProfile.status, "failed");
		assert.equal(missingProfile.isError, true);
		assert.ok(!missingProfile.launchUncertain);
		assert.equal(host.spawns, 0);
		const override = await launchHostedSubagent({ subagent_type: "bridges", resume: id, prompt: "x", model: "explicit/model" }, options);
		assert.equal(override.status, "failed");
		assert.ok(!override.launchUncertain);
		assert.equal(host.resumes, 0);
	});

	await test("resume: explicit model/thinking rejected, inherited getters/profile omitted, stale report fenced, then completes once", async () => {
		const { host, options, id } = freshHostSpawn();
		const oldTimestamp = Date.now() - 60_000;
		hostedFile(id, { spawnedBy: "parent-host", assistant: { text: "OLD REPORT", timestamp: oldTimestamp } });
		host.status = "idle"; host.finalText = "OLD REPORT"; host.messageCount = 2;
		let getModelCalls = 0;
		const resumeOptions: HostedRunnerOptions = {
			...options,
			getModelOverride: () => { getModelCalls += 1; return "inherited/model"; },
			getThinkingOverride: () => { getModelCalls += 1; return "high"; },
		};
		for (const override of [{ model: "explicit/model" }, { thinking: "high" }]) {
			const rejected = await launchHostedSubagent({ subagent_type: "bridges", resume: id, prompt: "continue", ...override }, resumeOptions);
			assert.equal(rejected.isError, true);
			assert.match(String(rejected.error), /cannot override model\/thinking/);
		}
		assert.equal(host.resumes, 0);
		assert.equal(getModelCalls, 0);

		const reportNotBefore = new Date().toISOString();
		const launched = await launchHostedSubagent({ subagent_type: "bridges", resume: id, prompt: "continue", run_id: "run-resume" }, resumeOptions);
		assert.equal(launched.status, "running");
		assert.equal(host.resumes, 1);
		assert.deepEqual(Object.keys(host.manageArgs[0]), ["action", "sessionId", "prompt"], "no host-unsupported override fields");
		assert.equal(host.manageArgs[0].action, "resume");
		assert.ok(String(host.manageArgs[0].prompt).startsWith("PI_TEAMS_HOST_ROLE: bridges\n"));
		assert.equal(getModelCalls, 0, "inherited overrides are not resolved on resume");
		assert.equal(host.spawns, 0, "resume never spawns again");

		const completions: ChildCompletion[] = [];
		const stale = await getHostedSubagentResult(id, false, {
			...options, role: "bridges", runId: "run-resume", reportNotBefore,
			onChildComplete: (i) => completions.push(i),
		});
		assert.equal(stale.status, "running", "old success is not reported after the resume boundary");
		assert.equal(completions.length, 0);

		appendAssistant(id, { text: "NEW REPORT", timestamp: Date.now() + 1000 });
		host.finalText = "NEW REPORT"; host.messageCount = 4;
		const done = await getHostedSubagentResult(id, false, {
			...options, role: "bridges", runId: "run-resume", reportNotBefore,
			onChildComplete: (i) => completions.push(i),
		});
		assert.equal(done.status, "completed");
		assert.equal(done.reportText, "NEW REPORT");
		assert.equal(completions.length, 1);
	});

	await test("resume: refusals when working or check unavailable; wait is bounded for working", async () => {
		const { host, options, id } = freshHostSpawn();
		hostedFile(id, { spawnedBy: "parent-host", assistant: { text: "OLD", timestamp: Date.now() - 1000 } });
		host.status = "working";
		const busy = await launchHostedSubagent({ subagent_type: "bridges", resume: id, prompt: "x" }, options);
		assert.equal(busy.status, "running");
		assert.equal(busy.isError, true);
		assert.equal(host.resumes, 0);
		host.failCheck = "check down";
		const unavailable = await launchHostedSubagent({ subagent_type: "bridges", resume: id, prompt: "x" }, options);
		assert.equal(unavailable.isError, true);
		assert.equal(host.resumes, 0);
		host.failCheck = undefined;
		const waited = await getHostedSubagentResult(id, true, { ...options, role: "bridges", waitTimeoutMs: 5, pollIntervalMs: 1 });
		assert.equal(waited.status, "running", "bounded foreground wait");
	});

	await test("resume with unreadable child history fails closed instead of trusting host text", async () => {
		const { host, options, id } = freshHostSpawn();
		hostedFile(id, { spawnedBy: "parent-host", assistant: { text: "OLD", timestamp: Date.now() - 60_000 } });
		host.status = "idle"; host.finalText = "OLD"; host.messageCount = 2;
		const launched = await launchHostedSubagent({ subagent_type: "bridges", resume: id, prompt: "continue", run_id: "run-unreadable" }, options);
		assert.equal(launched.status, "running");
		const diskFile = sessionFile(id);
		fs.renameSync(diskFile, `${diskFile}.moved`);
		host.finalText = "NEW HOST TEXT"; host.messageCount = 4;
		const completions: ChildCompletion[] = [];
		const result = await getHostedSubagentResult(id, false, { ...options, role: "bridges", runId: "run-unreadable", onChildComplete: (i) => completions.push(i) });
		assert.equal(result.status, "running");
		assert.equal(result.isError, true);
		assert.match(String(result.error), /validate hosted resume output from disk/);
		assert.equal(completions.length, 0);
	});

	await test("foreground launch waits for a deterministic idle result", async () => {
		const { host, options, id } = freshHostSpawn();
		hostedFile(id, { spawnedBy: "parent-host", assistant: { text: "DONE", timestamp: Date.now() + 5 } });
		host.status = "idle"; host.finalText = "DONE"; host.messageCount = 3;
		const result = await launchHostedSubagent({ subagent_type: "cameron", prompt: "x", run_in_background: false }, { ...options, waitTimeoutMs: 500 });
		assert.equal(result.status, "completed");
		assert.equal(result.reportText, "DONE");
		assert.equal(host.checks, 1);
	});

	console.log(`all ${passed} host adapter tests passed`);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}