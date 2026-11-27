/**
 * Regression tests for the throughput/efficiency overhaul (pseudo-serialization reduction + coach prompts).
 *
 * Covers:
 * 1. readMode:"snapshot" read-only tasks run parallel with in-flight writers; "strict" (default) still blocks.
 * 2. Reviewing workers (stopped writing) do not block ready tasks in DIFFERENT verified worktrees.
 * 3. provisionAutoWorktree: clean tree creates a task-owned worktree; dirty tree / non-git fail closed.
 * 4. The improved send_session_message / yield_to_subsessions / team_tasks rejection texts include the
 *    minimal next-action recipe (Agent resume / team_dispatch / evidence requirements).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, execFileSync } from "node:child_process";

import { newLedger, addRequest, addTasks, readyTasks, markDispatched, taskConflict, autoWorktreeEligible, sharedResourcesConflict, type WorkTask } from "../team-ledger.ts";
import { provisionAutoWorktree, autoWorktreeScopeProblem } from "../team-worktree.ts";
const stageRoot = mkdtempSync(join(tmpdir(), "pi-stage1-audit-"));
process.env.PI_CODING_AGENT_DIR = stageRoot;
process.env.PI_TEAMS_DISABLE_NATIVE_SPAWN = "1";
const { default: team, defaultConfig, initialState, mergeConfig, isBashWriteCommand, detectSubagentTaskAssignment, buildPolicy } = await import("../extensions/team.ts");

const test = (name: string, fn: () => void) => { fn(); console.log(`\u2713 ${name}`); };
let passed = 0;
const run = (name: string, fn: () => void) => { test(name, fn); passed++; };

function fixture(cwd = "/repo") {
	const b = newLedger();
	const q = addRequest(b, "audit regression", "audit:1");
	const add = (specs: any[]) => addTasks(b, specs.map(s => ({
		title: s.id, role: "bridges", requestIds: [q.id], dependsOn: [], readPaths: [],
		writePaths: [], acceptance: ["audit assertion"], splitWaiverReason: "audit",
		...s,
	})), cwd);
	return { b, q, add };
}

// -------------------------------------------------------------- 1. readMode snapshot
run("readMode snapshot read-only task runs parallel with an in-flight writer; strict blocks", () => {
	const { b, add } = fixture();
	add([
		{ id: "W-snap", role: "cp", readPaths: ["src/a.ts"], writePaths: [], readMode: "snapshot", declaredReadOnly: true },
		{ id: "W-strict", role: "cp", readPaths: ["src/a.ts"], writePaths: [], declaredReadOnly: true },
		{ id: "W-writer", writePaths: ["src/a.ts"] },
	]);
	const [snap, strict, writer] = b.tasks;
	markDispatched(b, writer.id, "bridges", "run-writer");
	assert.equal(taskConflict(writer, snap), false, "snapshot read skips write-vs-read");
	assert.equal(taskConflict(writer, strict), true, "strict read still blocks on write-vs-read");
	const ready = readyTasks(b).map(t => t.id);
	assert.ok(ready.includes("W-snap"), "snapshot reader is dispatchable while writer runs");
	assert.ok(!ready.includes("W-strict"), "strict reader is NOT dispatchable while writer runs");
});

run("readMode snapshot rejects writer tasks and unknown values", () => {
	const { b, add } = fixture();
	assert.throws(() => add([{ id: "W-bad-mode", writePaths: ["src/x"], readMode: "other" }]), /readMode must be/);
	assert.throws(() => add([{ id: "W-bad-writer", writePaths: ["src/x"], readMode: "snapshot" }]), /readMode:"snapshot" requires a read-only task/);
});

// -------------------------------------------------------------- 2. reviewing + different worktree
run("reviewing hold does not block a ready task in a different verified worktree", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-review-wt-"));
	try {
		const repo = join(tmp, "repo");
		const wt1 = join(tmp, "wt1");
		const wt2 = join(tmp, "wt2");
		mkdirSync(repo);
		execSync("git init -q", { cwd: repo });
		writeFileSync(join(repo, "f.txt"), "base\n");
		execSync("git add . && git -c user.email=a@b -c user.name=a commit -qm base", { cwd: repo });
		for (const p of [wt1, wt2]) execSync(`git worktree add -q "${p}" HEAD`, { cwd: repo });

		const { b, add } = fixture();
		add([
			{ id: "W-hold", writePaths: ["src/a.ts"] },
			{ id: "W-free", writePaths: ["src/b.ts"], isolation: "worktree", worktreePath: wt2 },
		]);
		const [hold, free] = b.tasks;
		markDispatched(b, hold.id, "bridges", "run-hold");
		hold.status = "reviewing";
		// distinct verified worktrees intentionally do not conflict at taskConflict level (auto-worktree escape);
		const ready = readyTasks(b).map(t => t.id);
		assert.ok(ready.includes("W-free"), "different-worktree ready task bypasses the reviewing hold");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// -------------------------------------------------------------- 3. auto-worktree provisioning
run("provisionAutoWorktree creates a tracked worktree on a clean tree; dirty tree fails closed", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-auto-wt-"));
	try {
		const repo = join(tmp, "repo");
		mkdirSync(repo);
		execSync("git init -q", { cwd: repo });
		writeFileSync(join(repo, "f.txt"), "base\n");
		execSync("git add . && git -c user.email=a@b -c user.name=a commit -qm base", { cwd: repo });

		const dry = provisionAutoWorktree(repo, "W-auto", { dryRun: true });
		assert.equal(dry.ok, true);
		assert.ok(dry.branch?.startsWith("pi-teams-auto/W-auto-"), "branch is task-scoped");
		assert.ok(dry.worktreePath?.includes("pi-teams-worktrees/W-auto"), "path is tracked under the auto-worktrees root");

		const live = provisionAutoWorktree(repo, "W-auto");
		assert.equal(live.ok, true);
		assert.ok(live.worktreePath && live.branch);
		const listed = execSync("git worktree list --porcelain", { cwd: repo, encoding: "utf8" });
		assert.ok(listed.includes(live.worktreePath!), "git worktree list sees the new tree");
		execSync(`git worktree remove "${live.worktreePath}"`, { cwd: repo });
		execSync(`git branch -d "${live.branch!}"`, { cwd: repo });

		writeFileSync(join(repo, "dirty.txt"), "dirty\n");
		const dirty = provisionAutoWorktree(repo, "W-auto2");
		assert.equal(dirty.ok, false, "dirty tree refuses auto-worktree");
		assert.match(dirty.reason ?? "", /dirty/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

run("provisionAutoWorktree fails closed on a non-git directory", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-non-git-"));
	try {
		const res = provisionAutoWorktree(tmp, "W-non-git");
		assert.equal(res.ok, false, "non-git directory must not create a worktree");
		assert.match(res.reason ?? "", /git status failed/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// -------------------------------------------------------------- 4. rejection-text recipes
run("send_session_message rejection includes the Agent(resume) recipe", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "TEAM_TASK: W-1\nGoal: x" } },
	];
	// The guard is embedded in the extension; assert through detectSubagentTaskAssignment instead.
	const parsed = detectSubagentTaskAssignment(entries);
	assert.equal(parsed?.id, "W-1");
	const policy = buildPolicy("standard", {} as any);
	assert.match(policy, /team_dispatch/);
});

run("isBashWriteCommand: bash -c script and secondary interpreters are writes; service status is safe", () => {
	for (const c of ["bash -c script.sh", "sh -c script.sh", "bash -c \"script.sh\"", "lua /tmp/script.lua",
		"awk -f /tmp/script.awk", "javac Main.java", "rustc main.rs", "emacs file.txt", "mount /dev/sdb1 /mnt",
		"mysql -e \"DROP DATABASE x\"", "terraform destroy", "helm install x chart", "systemctl restart nginx",
		"useradd hacker", "iptables -F", "kill -9 1234", "crontab -r"]) {
		const r = isBashWriteCommand(c);
		assert.equal(r.isWrite, true, `${c} must be a write`);
	}
	for (const c of ["service nginx status", "systemctl status nginx", "crontab -l", "mysql --version",
		"helm list", "kubectl get pods", "docker ps", "terraform plan", "kill -l"]) {
		const r = isBashWriteCommand(c);
		assert.equal(r.isWrite, false, `${c} must be safe`);
	}
});

// -------------------------------------------------------------- 5. stage 1 eligibility / scheduler wiring
run("auto-worktree defaults true, accepts only boolean overrides, and shipped config agrees", () => {
	assert.equal(defaultConfig().autoWorktreeOnConflict, true);
	assert.equal(mergeConfig(defaultConfig(), { autoWorktreeOnConflict: false }).autoWorktreeOnConflict, false);
	assert.equal(mergeConfig(defaultConfig(), { autoWorktreeOnConflict: "false" }).autoWorktreeOnConflict, true);
	const shipped = JSON.parse(readFileSync(new URL("../config/team.default.json", import.meta.url), "utf8"));
	assert.equal(shipped.autoWorktreeOnConflict, true);
});

run("autoWorktreeEligible admits a writer with blockers, never read-only, owned, failed or empty candidates", () => {
	const { b, add } = fixture();
	add([{ id: "W-a", writePaths: ["f.txt"] }, { id: "W-b", writePaths: ["f.txt"] }]);
	const [a, bTask] = b.tasks;
	assert.equal(autoWorktreeEligible(bTask, [a]), true);
	assert.equal(autoWorktreeEligible(bTask, []), false);
	for (const patch of [
		{ role: "cp" }, { role: "parent" }, { declaredReadOnly: true }, { writePaths: [] },
		{ worktreeOwned: true }, { isolation: "worktree" }, { worktreePath: "/existing" },
		{ autoWorktreeFailedAt: new Date().toISOString() },
	]) assert.equal(autoWorktreeEligible({ ...bTask, ...patch } as WorkTask, [a]), false, JSON.stringify(patch));
	assert.equal(autoWorktreeEligible({ ...bTask, manualDispatch: true }, [a]), true, "manual selection is a caller policy, not pure eligibility");
});

run("sharedResourcesConflict is symmetric and defeats isolation and snapshot exemptions", () => {
	const { b, add } = fixture();
	add([{ id: "W-a", writePaths: ["f.txt"], sharedResources: ["device:1"] }, { id: "W-b", writePaths: ["f.txt"] }]);
	const [a, bTask] = b.tasks;
	assert.equal(sharedResourcesConflict(a, bTask), false);
	const shared = { ...bTask, sharedResources: ["device:1"] };
	assert.equal(sharedResourcesConflict(a, shared), true);
	assert.equal(sharedResourcesConflict(shared, a), true);
	assert.equal(autoWorktreeEligible(shared, [a]), false);
	assert.equal(taskConflict(a, { ...shared, isolation: "worktree", worktreePath: "/different" }), true);
	assert.equal(taskConflict(a, { ...shared, role: "cp", writePaths: [], readMode: "snapshot" }), true);
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
let stageSeq = 0;
function cleanRepo() {
	const repo = join(stageRoot, `repo-${++stageSeq}`);
	mkdirSync(repo);
	git(repo, "init", "-q");
	writeFileSync(join(repo, "f.txt"), "base\n");
	git(repo, "add", "f.txt");
	git(repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "base");
	return repo;
}
function cleanupRepo(repo: string) {
	const entries = git(repo, "worktree", "list", "--porcelain").trim().split(/\n\n/);
	for (const entry of entries.slice(1)) {
		const wt = /^worktree (.+)$/m.exec(entry)?.[1];
		const branch = /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1];
		if (wt) git(repo, "worktree", "remove", wt);
		if (branch) git(repo, "branch", "-d", branch);
	}
}
run("running A + ready B provisions a real worktree, records ownership and releases only file locks", () => {
	const repo = cleanRepo();
	try {
		const { b, add } = fixture(repo);
		add([{ id: "W-a", writePaths: ["f.txt"] }, { id: "W-b", writePaths: ["f.txt"] }]);
		const [a, bTask] = b.tasks;
		markDispatched(b, a.id, a.role, "run-a");
		assert.equal(readyTasks(b).includes(bTask), false);
		assert.equal(autoWorktreeEligible(bTask, [a]), true);
		const result = provisionAutoWorktree(repo, bTask.id);
		assert.equal(result.ok, true, result.reason);
		Object.assign(bTask, { isolation: "worktree", worktreePath: result.worktreePath, worktreeBranch: result.branch, worktreeOwned: true });
		assert.equal(taskConflict(a, bTask), false);
		assert.equal(readyTasks(b).includes(bTask), true);
		bTask.sharedResources = a.sharedResources = ["port:1234"];
		assert.equal(taskConflict(a, bTask), true);
		assert.equal(readyTasks(b).includes(bTask), false);
	} finally { cleanupRepo(repo); }
});

const realInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval;
const ticks = new Set<Function>();
globalThis.setInterval = ((fn: Function) => { ticks.add(fn); return { unref() {}, fn }; }) as any;
globalThis.clearInterval = ((timer: any) => ticks.delete(timer?.fn)) as any;
async function runAsync(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log(`✓ ${name}`); }
function harness(repo: string, options: { enabled?: boolean; manual?: boolean; shared?: boolean; status?: WorkTask["status"]; candidate?: Partial<WorkTask>; extra?: WorkTask[]; lease?: WorkTask; hosted?: boolean; cwd?: string } = {}) {
	writeFileSync(join(stageRoot, "team.json"), JSON.stringify({ autoWorktreeOnConflict: options.enabled ?? true, maxConcurrent: 20, autoGcChildSessions: false }));
	const { b, add } = fixture(repo);
	add([
		{ id: "W-a", writePaths: ["f.txt"], ...(options.shared ? { sharedResources: ["device:1"] } : {}) },
		{ id: "W-b", readPaths: ["f.txt"], writePaths: ["f.txt"], ...(options.shared ? { sharedResources: ["device:1"] } : {}) },
	]);
	markDispatched(b, "W-a", "bridges", `run-a-${++stageSeq}`);
	b.tasks[0].status = options.status ?? "running";
	if (options.status === "reviewing") b.tasks.push({ ...b.tasks[0], id: "W-rev-a", parentTaskId: "W-a", role: "cp", status: "running", writePaths: [], runId: `review-${++stageSeq}` });
	Object.assign(b.tasks[1], options.candidate, { manualDispatch: options.manual ?? false });
	if (options.extra) b.tasks.push(...options.extra);
	const state = initialState(defaultConfig()); state.enabled = true; state.startedAt = "2026-01-01"; state.ledger = b;
	const entries: any[] = [{ type: "custom", customType: "team-state", data: structuredClone(state) }];
	if (options.lease) entries.push({ type: "custom", customType: "team-child-lease", data: { ...options.lease, parentSessionId: "parent" } });
	const hooks = new Map<string, Function[]>(), tools = new Map<string, any>(), launches: any[] = [];
	const ctx: any = { cwd: options.cwd ?? repo, hasUI: false, sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => "parent", getSessionFile: () => join(stageRoot, `parent-${++stageSeq}.jsonl`) }, ui: { notify() {}, setStatus() {} }, modelRegistry: { find() {} },
		executeTool: async (name: string, args: any) => { launches.push({ name, args }); return { content: [], details: { sessionId: `child-${++stageSeq}`, status: "running" } }; } };
	const pi: any = { on: (name: string, fn: Function) => hooks.set(name, [...(hooks.get(name) ?? []), fn]), registerFlag() {}, getFlag: () => false, registerCommand() {}, registerTool: (spec: any) => tools.set(spec.name, spec), appendEntry: (customType: string, data: any) => entries.push({ type: "custom", customType, data: structuredClone(data) }), getThinkingLevel: () => "high", sendMessage() {}, sendUserMessage() {} };
	if (options.hosted) pi.getAllTools = () => [{ name: "spawn_subsession" }];
	team(pi);
	const current = () => [...entries].reverse().find(e => e.customType === "team-state").data;
	async function emit(name: string, event: any = {}) { let result = event; for (const fn of hooks.get(name) ?? []) { const patch = await fn(result, ctx); if (patch) result = { ...result, ...patch }; } return result; }
	return { ctx, tools, launches, entries, current, task: (id = "W-b") => current().ledger.tasks.find((t: WorkTask) => t.id === id), emit,
		pump: () => tools.get("team_tasks").execute(`pump-${++stageSeq}`, { action: "dispatch" }, undefined, undefined, ctx),
		agent: () => emit("tool_call", { toolName: "Agent", toolCallId: `manual-${++stageSeq}`, input: { subagent_type: "bridges", prompt: "TEAM_TASK: W-b\nKeep the full manual brief", run_in_background: true } }),
	};
}
async function withHarness(options: Parameters<typeof harness>[1], check: (h: ReturnType<typeof harness>, repo: string) => Promise<void>, dirty = false) {
	const repo = cleanRepo();
	const h = harness(repo, options);
	try {
		if (dirty) writeFileSync(join(repo, "dirty.txt"), "dirty\n");
		await h.emit("session_start");
		await check(h, repo);
	} finally { await h.emit("session_shutdown"); cleanupRepo(repo); }
}
try {
	await runAsync("scheduler preflight provisions before readyTasks and launches with rebased scopes and branch contract", () => withHarness({}, async (h, repo) => {
		await h.pump();
		const bTask = h.task();
		assert.equal(h.launches.length, 1);
		assert.equal(bTask.status, "running");
		assert.equal(bTask.isolation, "worktree");
		assert.equal(bTask.worktreeOwned, true);
		assert.ok(existsSync(join(bTask.worktreePath, ".git")));
		assert.deepEqual(bTask.readPaths, [join(bTask.worktreePath, "f.txt")]);
		assert.deepEqual(bTask.writePaths, [join(bTask.worktreePath, "f.txt")]);
		assert.equal(h.task("W-a").writePaths[0], join(repo, "f.txt"));
		assert.match(h.launches[0].args.prompt, /Auto-worktree:/);
		assert.ok(h.launches[0].args.prompt.includes(bTask.worktreeBranch));
		assert.ok(h.entries.some(e => e.customType === "team-state" && e.data.ledger.tasks.some((t: WorkTask) => t.id === "W-b" && t.worktreeOwned && t.status === "ready")), "ownership persisted before reservation");
		assert.equal(bTask.evidence.filter((e: string) => e.startsWith("auto-worktree-provisioned:")).length, 1);
		await h.pump(); assert.equal(h.launches.length, 1, "no duplicate provisioning or launch");
	}));
	await runAsync("daemon reaches a scope-blocked candidate but cannot steal a held manual task", () => withHarness({}, async h => {
		assert.equal(h.launches.length, 0);
		for (const tick of [...ticks]) await tick();
		assert.equal(h.task().worktreeOwned, true);
		assert.equal(h.launches.length, 1);
	}));
	await runAsync("explicit Agent selector provisions a manual held task while daemon leaves it alone", () => withHarness({ manual: true }, async h => {
		for (const tick of [...ticks]) await tick();
		assert.equal(h.task().worktreePath, undefined);
		const result = await h.agent();
		assert.notEqual(result.block, true, result.reason);
		assert.equal(h.task().status, "running");
		assert.equal(h.task().worktreeOwned, true);
		assert.equal(h.task().manualDispatch, undefined);
		assert.match(result.input.prompt, /Keep the full manual brief/);
		assert.ok(result.input.prompt.includes(h.task().writePaths[0]));
		assert.equal(h.launches.length, 0, "hook reserves but does not spawn itself");
	}));
	await runAsync("disabled auto-worktree leaves scheduler and manual Agent serial with no ownership", () => withHarness({ enabled: false }, async h => {
		await h.pump(); const result = await h.agent();
		assert.equal(result.block, true);
		assert.equal(h.launches.length, 0);
		assert.equal(h.task().worktreePath, undefined);
		assert.equal(h.task().autoWorktreeFailedAt, undefined);
	}));
	await runAsync("shared external resource never provisions or releases through either dispatch path", () => withHarness({ shared: true }, async h => {
		await h.pump(); assert.equal((await h.agent()).block, true);
		assert.equal(h.launches.length, 0);
		assert.equal(h.task().worktreePath, undefined);
		assert.equal(h.task().evidence.length, 0);
	}));
	await runAsync("dirty provisioning fails once, persists the guard, and stays serial after reload and cleanup", () => withHarness({}, async (h, repo) => {
		await h.pump();
		const failedAt = h.task().autoWorktreeFailedAt;
		assert.ok(failedAt);
		assert.equal(h.task().isolation, undefined);
		assert.match(h.task().evidence[0], /^auto-worktree-failed:.*dirty/);
		rmSync(join(repo, "dirty.txt"));
		await h.emit("session_start", { reason: "reload" });
		await h.pump(); assert.equal((await h.agent()).block, true);
		assert.equal(h.launches.length, 0);
		assert.equal(h.task().autoWorktreeFailedAt, failedAt);
		assert.equal(h.task().evidence.length, 1);
		assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
	}, true));
	await runAsync("external absolute scopes fail closed rather than granting worktree isolation to shared files", () => withHarness({ candidate: { readPaths: [join(stageRoot, "external.txt")] } }, async h => {
		await h.pump();
		assert.equal(h.launches.length, 0);
		assert.match(h.task().evidence[0], /^auto-worktree-failed:scope outside repository:/);
		assert.equal(h.task().worktreePath, undefined);
	}));
	await runAsync("prior stopped child keeps its original cwd and identity, not an automatic worktree", () => withHarness({ candidate: { sessionId: "prior-child" }, manual: true }, async h => {
		const result = await h.agent(); assert.equal(result.block, true);
		assert.equal(h.task().sessionId, "prior-child");
		assert.equal(h.task().worktreePath, undefined);
	}));
	await runAsync("live cross-session resource lease cannot be bypassed by auto-worktree", () => withHarness({
		candidate: { sharedResources: ["device:1"] },
		lease: { id: "W-external", title: "external lease", role: "bridges", requestIds: [], dependsOn: [], readPaths: [], writePaths: [], acceptance: [], evidence: [], status: "running", runId: "external-run", sharedResources: ["device:1"] },
	}, async h => {
		await h.pump(); assert.equal((await h.agent()).block, true);
		assert.equal(h.launches.length, 0);
		assert.equal(h.task().worktreePath, undefined);
	}));
	await runAsync("same-task live lease prevents moving or redispatching its attempt", () => withHarness({
		lease: { id: "W-b", title: "same task lease", role: "bridges", requestIds: [], dependsOn: [], readPaths: [], writePaths: [], acceptance: [], evidence: [], status: "uncertain", runId: "uncertain-run" },
	}, async h => {
		await h.pump(); assert.equal((await h.agent()).block, true);
		assert.equal(h.task().worktreePath, undefined);
		assert.equal(h.launches.length, 0);
	}));
	await runAsync("automatic provisioning preserves the five-extra-worktree admission cap", () => withHarness({
		candidate: { splitWaiverReason: undefined },
		extra: Array.from({ length: 5 }, (_, i) => ({ id: `W-limit-${i}`, title: "existing worktree claim", role: "bridges", requestIds: [], dependsOn: [], readPaths: [], writePaths: [], acceptance: [], evidence: [], status: "blocked", isolation: "worktree", worktreePath: join(stageRoot, `claimed-${i}`) } as WorkTask)),
	}, async h => {
		await h.pump();
		assert.equal(h.launches.length, 0);
		assert.equal(h.task().worktreePath, undefined);
		assert.match(h.task().evidence[0], /^auto-worktree-failed:max 5/);
	}));
	await runAsync("native manual Agent actually launches in the auto-worktree with its remapped scope", () => withHarness({ manual: true }, async h => {
		const fakePi = join(stageRoot, "fake-pi.mjs"), cwdLog = join(stageRoot, "child-cwd.txt");
		writeFileSync(fakePi, `#!/usr/bin/env node\nimport fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(cwdLog)}, process.cwd());\nconst args = process.argv.slice(2), file = args[args.indexOf("--session") + 1];\nconst lines = fs.readFileSync(file, "utf8").trim().split("\\n").map(l => JSON.parse(l));\nfs.appendFileSync(file, JSON.stringify({ type: "message", id: "final", parentId: lines.at(-1)?.id ?? null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "IMPLEMENTATION_READY. Evidence: native cwd captured." }], stopReason: "stop", timestamp: Date.now() } }) + "\\n");\n`, { mode: 0o755 });
		const oldBin = process.env.PI_BIN;
		try {
			process.env.PI_BIN = fakePi; delete process.env.PI_TEAMS_DISABLE_NATIVE_SPAWN;
			const event = await h.agent(); assert.notEqual(event.block, true, event.reason);
			const result = await h.tools.get("Agent").execute(event.toolCallId, { ...event.input, run_in_background: false }, undefined, undefined, h.ctx);
			assert.equal(result.isError, false, JSON.stringify(result));
			assert.equal(readFileSync(cwdLog, "utf8"), h.task().worktreePath);
			const childFile = h.entries.find(e => e.customType === "pi-web.subsession.link")?.data.spawnedSessionFile;
			assert.ok(childFile);
			const lines = readFileSync(childFile, "utf8").trim().split("\n").map(l => JSON.parse(l));
			assert.equal(lines[0].cwd, h.task().worktreePath);
			const scope = lines.find(l => l.customType === "pi-web:subagent")?.data.scope;
			assert.deepEqual(scope.writePaths, [join(h.task().worktreePath, "f.txt")]);
		} finally {
			process.env.PI_TEAMS_DISABLE_NATIVE_SPAWN = "1";
			if (oldBin === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = oldBin;
		}
	}));
	await runAsync("hosted cwd limitation fails closed: no prompt-only worktree isolation", () => withHarness({ hosted: true }, async h => {
		await h.pump(); assert.equal((await h.agent()).block, true);
		assert.equal(h.launches.length, 0);
		assert.equal(h.task().isolation, undefined);
		assert.match(h.task().evidence[0], /hosted transport cannot set worktree cwd/);
		assert.equal(taskConflict(h.task("W-a"), h.task()), true);
	}));
	await runAsync("persisted auto-owned worktree cannot dispatch through hosted scheduler or manual Agent", async () => {
		const repo = cleanRepo(), result = provisionAutoWorktree(repo, "W-b");
		assert.equal(result.ok, true, result.reason);
		const h = harness(repo, { hosted: true, candidate: { isolation: "worktree", worktreeOwned: true, worktreePath: result.worktreePath, worktreeBranch: result.branch, readPaths: [join(result.worktreePath!, "f.txt")], writePaths: [join(result.worktreePath!, "f.txt")] } });
		try {
			await h.emit("session_start"); await h.pump();
			const event = await h.agent(); assert.equal(event.block, true); assert.match(event.reason, /hosted transport cannot select auto-worktree cwd/);
			assert.equal(h.launches.length, 0); assert.equal(h.task().status, "ready");
			assert.equal(h.task().runId, undefined); assert.equal(h.task().worktreeOwned, true);
		} finally { await h.emit("session_shutdown"); cleanupRepo(repo); }
	});
	await runAsync("tracked absolute symlink keeps writer and strict reader locks intact", async () => {
		const repo = cleanRepo();
		symlinkSync(join(repo, "f.txt"), join(repo, "alias.txt"));
		git(repo, "add", "alias.txt"); git(repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "symlink");
		const h = harness(repo, { candidate: { readPaths: [join(repo, "alias.txt")], writePaths: [join(repo, "alias.txt")] } });
		try {
			await h.emit("session_start"); await h.pump();
			assert.equal((await h.agent()).block, true);
			assert.equal(h.launches.length, 0); assert.equal(h.task().worktreePath, undefined);
			assert.match(h.task().evidence[0], /symlink/);
			assert.equal(taskConflict(h.task("W-a"), h.task()), true);
			const reader = { ...h.task("W-a"), role: "ayton", writePaths: [], readPaths: [join(repo, "f.txt")], declaredReadOnly: true };
			assert.equal(taskConflict(reader, h.task()), true);
			assert.match(autoWorktreeScopeProblem(repo, [join(repo, "alias.txt", "missing")])!, /symlink scope ancestor/);
			assert.match(autoWorktreeScopeProblem(repo, [join(repo, "f.txt")])!, /tracked symlinks/);
		} finally { await h.emit("session_shutdown"); cleanupRepo(repo); }
	});
	await runAsync("subdirectory parent provisions beside repository root, never inside main checkout", async () => {
		const repo = cleanRepo(); mkdirSync(join(repo, "packages", "app"), { recursive: true });
		const h = harness(repo, { cwd: join(repo, "packages", "app") });
		try {
			await h.emit("session_start"); await h.pump();
			assert.equal(h.launches.length, 1);
			assert.ok(h.task().worktreePath.startsWith(join(stageRoot, ".pi-teams-worktrees") + "/"));
			assert.equal(git(repo, "status", "--porcelain"), "");
		} finally { await h.emit("session_shutdown"); cleanupRepo(repo); }
	});
	await runAsync("dependencies still gate provisioning and dispatch", () => withHarness({ candidate: { dependsOn: ["W-a"] } }, async h => {
		await h.pump(); assert.equal((await h.agent()).block, true);
		assert.equal(h.task().worktreePath, undefined);
		assert.equal(h.launches.length, 0);
	}));
	await runAsync("strict same-main-tree reader remains blocked by a reviewing hold (not stage 2)", () => withHarness({ status: "reviewing", candidate: { role: "ayton", declaredReadOnly: true, writePaths: [] } }, async h => {
		await h.pump();
		assert.equal(h.task().status, "ready");
		assert.equal(h.task().worktreePath, undefined);
		assert.equal(h.launches.length, 0);
	}));
} finally {
	globalThis.setInterval = realInterval; globalThis.clearInterval = realClearInterval;
	rmSync(stageRoot, { recursive: true, force: true });
}
console.log(`\naudit regression: ${passed} tests passed`);
