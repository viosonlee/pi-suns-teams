import { strict as assert } from "node:assert";
import {
	newLedger,
	addRequest,
	addTasks,
	updateTask,
	createReviewerTask,
	pruneStaleReviews,
} from "../team-ledger.ts";
import teamExtension, { buildReviewContract } from "../extensions/team.ts";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
	await fn();
	console.log(`✓ ${name}`);
	passed++;
}

await test("buildReviewContract injects canonical AC1..ACn and machine-parsed rules", () => {
	const board = newLedger();
	const req = addRequest(board, "implement clamp", "test");
	addTasks(board, [{
		id: "W-10",
		title: "Implement clamp",
		requestIds: [req.id],
		role: "bridges",
		dependsOn: [],
		readPaths: ["src/calc.mjs"],
		writePaths: ["src/calc.mjs"],
		acceptance: [
			"clamp(val, min, max) returns min when val < min",
			"clamp(val, min, max) returns max when val > max",
		],
	}], "/tmp/demo");
	const worker = board.tasks[0];
	worker.status = "reported";
	const rev = createReviewerTask(board, worker);
	const contract = buildReviewContract(rev, worker);
	assert.ok(contract.includes("[CANONICAL REVIEW CONTRACT — AUTO-INJECTED FROM LEDGER for W-rev-10]"));
	assert.ok(contract.includes("AC1. clamp(val, min, max) returns min when val < min"));
	assert.ok(contract.includes("AC2. clamp(val, min, max) returns max when val > max"));
	assert.ok(contract.includes("VERDICT: PASS | REWORK | ESCALATE | INCOMPLETE"));
	assert.ok(contract.includes("CRITERION: AC1"));
});

await test("updateTask auto-cancels orphan non-live W-rev-* when worker becomes terminal", () => {
	const board = newLedger();
	const req = addRequest(board, "demo", "test");
	addTasks(board, [{
		id: "W-20",
		title: "Fix bug",
		requestIds: [req.id],
		role: "bridges",
		dependsOn: [],
		readPaths: ["src/a.ts"],
		writePaths: ["src/a.ts"],
		acceptance: ["bug fixed"],
	}], "/tmp/demo");
	const worker = board.tasks[0];
	worker.status = "reported";
	const rev = createReviewerTask(board, worker);
	assert.equal(rev.status, "ready");

	updateTask(board, { id: "W-20", status: "done", evidence: ["verified"], reason: "accepted" });
	assert.equal(worker.status, "done");
	assert.equal(rev.status, "cancelled");
	assert.ok(rev.reason?.includes("Auto-cancelled"));
});

await test("pruneStaleReviews safely prunes orphans/terminal/blocked/duplicates/failed and migrates legacy roles to cp", () => {
	const board = newLedger();
	const req = addRequest(board, "bulk backlog", "test");
	addTasks(board, [
		{ id: "W-done", title: "done worker", requestIds: [req.id], role: "bridges", dependsOn: [], readPaths: ["a.ts"], writePaths: ["a.ts"], acceptance: ["a"] },
		{ id: "W-blocked", title: "blocked worker", requestIds: [req.id], role: "bridges", dependsOn: [], readPaths: ["b.ts"], writePaths: ["b.ts"], acceptance: ["b"] },
		{ id: "W-rep-legacy", title: "reported legacy", requestIds: [req.id], role: "bridges", dependsOn: [], readPaths: ["c.ts"], writePaths: ["c.ts"], acceptance: ["c"] },
		{ id: "W-live", title: "live reviewing", requestIds: [req.id], role: "bridges", dependsOn: [], readPaths: ["d.ts"], writePaths: ["d.ts"], acceptance: ["d"] },
		{ id: "W-failed-rev", title: "reported with failed rev", requestIds: [req.id], role: "bridges", dependsOn: [], readPaths: ["e.ts"], writePaths: ["e.ts"], acceptance: ["e"] },
	], "/tmp/demo");

	const byId = (id: string) => board.tasks.find(t => t.id === id)!;
	byId("W-done").status = "done";
	byId("W-blocked").status = "blocked";
	byId("W-rep-legacy").status = "reported";
	byId("W-live").status = "reviewing";
	byId("W-failed-rev").status = "reported";

	// Push synthetic historical W-rev-* records matching real production taxonomy
	board.tasks.push(
		{ id: "W-rev-missing", parentTaskId: "W-nonexistent", title: "orphan", requestIds: [req.id], role: "cp", dependsOn: [], readPaths: [], writePaths: [], acceptance: ["x"], status: "ready", evidence: [] },
		{ id: "W-rev-done", parentTaskId: "W-done", title: "done rev", requestIds: [req.id], role: "cameron", dependsOn: [], readPaths: [], writePaths: [], acceptance: ["x"], status: "ready", evidence: [] },
		{ id: "W-rev-blocked", parentTaskId: "W-blocked", title: "blocked rev", requestIds: [req.id], role: "ayton", dependsOn: [], readPaths: [], writePaths: [], acceptance: ["x"], status: "ready", evidence: [] },
		{ id: "W-rev-rep-legacy-old", parentTaskId: "W-rep-legacy", title: "dup old", requestIds: [req.id], role: "cameron", dependsOn: [], readPaths: [], writePaths: [], acceptance: ["x"], status: "ready", evidence: [] },
		{ id: "W-rev-rep-legacy", parentTaskId: "W-rep-legacy", title: "legacy cameron", requestIds: [req.id], role: "cameron", dependsOn: [], readPaths: [], writePaths: [], acceptance: ["x"], status: "ready", evidence: [] },
		{ id: "W-rev-live", parentTaskId: "W-live", title: "running cp", requestIds: [req.id], role: "cp", dependsOn: [], readPaths: [], writePaths: [], acceptance: ["x"], status: "running", evidence: [] },
		{ id: "W-rev-failed-rev", parentTaskId: "W-failed-rev", title: "failed rev", requestIds: [req.id], role: "ayton", dependsOn: [], readPaths: [], writePaths: [], acceptance: ["x"], status: "failed", evidence: [] },
	);

	// 1. Dry-run must not mutate anything
	const beforeJson = JSON.stringify(board);
	const dry = pruneStaleReviews(board, { dryRun: true });
	assert.equal(JSON.stringify(board), beforeJson, "dryRun must not mutate board");
	assert.equal(dry.pruned.length, 5, "should preview 5 pruned reviews (missing, done, blocked, duplicate, failed)");
	assert.equal(dry.migratedToCp.length, 1, "should preview 1 migrated legacy cameron review");
	assert.equal(dry.keptActive, 1, "running review must be kept active");
	assert.equal(dry.keptPendingCp, 1, "migrated review becomes pending cp");

	// 2. Real run applies prune + migration cleanly
	const real = pruneStaleReviews(board, { dryRun: false });
	assert.equal(real.pruned.length, 5);
	assert.equal(real.migratedToCp.length, 1);
	assert.equal(byId("W-rev-missing").status, "cancelled");
	assert.equal(byId("W-rev-done").status, "cancelled");
	assert.equal(byId("W-rev-blocked").status, "cancelled");
	assert.equal(byId("W-rev-rep-legacy-old").status, "cancelled");
	assert.equal(byId("W-rev-failed-rev").status, "cancelled");
	assert.equal(byId("W-rev-rep-legacy").role, "cp");
	assert.equal(byId("W-rev-rep-legacy").status, "ready");
	assert.equal(byId("W-rev-live").status, "running", "running review must never be touched");

	// 3. Re-running is idempotent
	const second = pruneStaleReviews(board, { dryRun: false });
	assert.equal(second.pruned.length, 0);
	assert.equal(second.migratedToCp.length, 0);
	assert.equal(second.keptActive, 1);
	assert.equal(second.keptPendingCp, 1);
});

await test("tool_call hook auto-injects canonical AC1..ACn contract into minimalist W-rev-* dispatch prompt", async () => {
	const handlers = new Map<string, any[]>();
	const tools = new Map<string, any>();
	const entries: any[] = [];
	const api: any = {
		on(ev: string, fn: any) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
		registerTool(t: any) { tools.set(t.name, t); },
		registerCommand() {},
		registerFlag() {},
		getFlag() { return false; },
		appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
		sendUserMessage() {},
	};
	teamExtension(api);
	const ctx: any = {
		cwd: "/tmp/demo",
		hasUI: false,
		ui: { notify() {}, setStatus() {} },
		sessionManager: {
			getSessionId: () => "parent-test-sid",
			getEntries: () => entries,
			getBranch: () => entries,
		},
	};
	for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);
	// Enable team & add task + review
	const tool = tools.get("team_tasks");
	const stEntry = () => [...entries].reverse().find(e => e.customType === "team-state")?.data;
	// Enable via command or directly start with input
	const cmds: any = {};
	const api2: any = {
		...api,
		registerCommand(name: string, cmd: any) { cmds[name] = cmd; },
	};
	handlers.clear(); tools.clear(); entries.length = 0;
	teamExtension(api2);
	for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);
	await cmds.team.handler("on", ctx);
	for (const fn of handlers.get("input") ?? []) await fn({ text: "implement foo", source: "rpc" }, ctx);
	const qid = stEntry().ledger.requests[0].id;
	await tools.get("team_tasks").execute("1", {
		action: "add",
		autoDispatch: false,
		tasks: [{
			id: "W-foo",
			title: "Implement foo",
			requestIds: [qid],
			role: "bridges",
			dependsOn: [],
			readPaths: ["src/foo.ts"],
			writePaths: ["src/foo.ts"],
			acceptance: ["foo(1) returns 2", "foo(-1) throws RangeError"],
		}],
	}, null, null, ctx);
	// Mark W-foo reported, create W-rev-foo in persisted state, and restore via session_start
	const ledger = stEntry().ledger;
	const wFoo = ledger.tasks.find((t: any) => t.id === "W-foo");
	wFoo.status = "reported";
	createReviewerTask(ledger, wFoo);
	for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);

	// Dispatch W-rev-foo with a bare 1-line prompt (no ACs written by parent!)
	const input: any = { subagent_type: "cp", prompt: "TEAM_TASK: W-rev-foo\nPlease review W-foo." };
	for (const fn of handlers.get("tool_call") ?? []) {
		const res = await fn({ toolName: "Agent", toolCallId: "tc-1", input }, ctx);
		assert.notEqual(res?.block, true, `dispatch should succeed: ${res?.reason}`);
	}
	assert.ok(input.prompt.includes("[CANONICAL REVIEW CONTRACT — AUTO-INJECTED FROM LEDGER for W-rev-foo]"));
	assert.ok(input.prompt.includes("AC1. foo(1) returns 2"));
	assert.ok(input.prompt.includes("AC2. foo(-1) throws RangeError"));
	assert.ok(input.prompt.includes("VERDICT: PASS | REWORK | ESCALATE | INCOMPLETE"));
});

await test("buildReviewContract injects worker delivered evidence excerpt when recorded", () => {
	const board = newLedger();
	const req = addRequest(board, "analyze module", "test");
	addTasks(board, [{
		id: "W-ro",
		title: "Analyze root cause",
		requestIds: [req.id],
		role: "bridges",
		dependsOn: [],
		readPaths: ["src/a.ts"],
		writePaths: [],
		acceptance: ["Identify root cause with file:line"],
	}], "/tmp/demo");
	const worker = board.tasks[0];
	worker.status = "reported";
	worker.evidence = ["Delivered analysis: src/a.ts:42 leaks timer handles"];
	const rev = createReviewerTask(board, worker);
	const contract = buildReviewContract(rev, worker);
	assert.ok(contract.includes("Worker delivered report / recorded evidence"));
	assert.ok(contract.includes("Delivered analysis: src/a.ts:42 leaks timer handles"));
});

console.log(`\nAll ${passed} prune-reviews & auto-review-contract tests passed!`);
