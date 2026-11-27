import { strict as assert } from "node:assert";
import { newLedger, addRequest, addTasks, updateTask, moveTask, ledgerPrompt } from "../team-ledger.ts";
import teamExtension, {
	defaultConfig,
	initialState,
	computeStateDelta,
	applyStateDelta,
	stateFromEntries,
} from "../extensions/team.ts";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
	await fn();
	console.log(`✓ ${name}`);
	passed++;
}

await test("computeStateDelta + applyStateDelta round-trips 500-task board bit-for-bit at <1% size", () => {
	const cfg = defaultConfig();
	const s1 = initialState(cfg);
	s1.enabled = true;
	const board = newLedger();
	const q1 = addRequest(board, "Large production project", "user");
	const batch = [];
	for (let i = 1; i <= 500; i++) {
		batch.push({
			id: `W-${i}`,
			title: `Implement module ${i} with full verification`,
			requestIds: [q1.id],
			role: i % 2 === 0 ? "bridges" : "booker",
			dependsOn: [],
			readPaths: [`/tmp/proj/src/mod_${i}.ts`],
			writePaths: [`/tmp/proj/src/mod_${i}.ts`],
			acceptance: [`module ${i} passes unit tests`, `no regressions in mod_${i}`],
		});
	}
	addTasks(board, batch, "/tmp/proj");
	s1.ledger = board;
	const fullBytes = JSON.stringify(s1).length;
	assert.ok(fullBytes > 100_000, `expected >100KB full state, got ${fullBytes}`);

	// Mutate 1 single task + call counter
	const s2 = structuredClone(s1);
	s2.calls.bridges += 1;
	updateTask(s2.ledger!, { id: "W-250", status: "done", evidence: ["test ok"], reason: "verified" });

	const delta1 = computeStateDelta(s1, s2);
	const delta1Bytes = JSON.stringify(delta1).length;
	assert.ok(delta1Bytes < fullBytes * 0.02, `delta should be <2% of full snapshot (${delta1Bytes} vs ${fullBytes})`);

	// Reorder a task + add a new request & task + append reviewRecord
	const s3 = structuredClone(s2);
	const q2 = addRequest(s3.ledger!, "Follow-up request", "user");
	addTasks(s3.ledger!, [{
		id: "W-501",
		title: "Follow-up work",
		requestIds: [q2.id],
		role: "cameron",
		dependsOn: [],
		readPaths: ["/tmp/proj/README.md"],
		writePaths: ["/tmp/proj/README.md"],
		acceptance: ["README updated"],
	}], "/tmp/proj");
	moveTask(s3.ledger!, { id: "W-501", position: "front", reason: "urgent" });
	(s3.ledger!.reviewRecords ??= []).push({
		reviewTaskId: "W-rev-250",
		workerTaskId: "W-250",
		verdict: "PASS",
		checks: [],
		defects: [],
		nextActions: [],
		raw: "VERDICT: PASS",
		parsed: true,
		reasons: [],
		deliveryVersion: "v1",
		createdAt: new Date().toISOString(),
	});
	const delta2 = computeStateDelta(s2, s3);

	const entries = [
		{ type: "custom", customType: "team-state", data: structuredClone(s1) },
		{ type: "custom", customType: "team-state-delta", data: delta1 },
		{ type: "custom", customType: "team-state-delta", data: delta2 },
	];
	const restored = stateFromEntries(entries, cfg).state;
	assert.deepEqual(restored, s3, "replayed state from checkpoint + deltas must match exact final state");
});

await test("extension persist() automatically switches to team-state-delta on large (>32KB) ledgers", async () => {
	const handlers = new Map<string, any[]>();
	const tools = new Map<string, any>();
	const cmds: any = {};
	const entries: any[] = [];
	const api: any = {
		on(ev: string, fn: any) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
		registerTool(t: any) { tools.set(t.name, t); },
		registerCommand(name: string, cmd: any) { cmds[name] = cmd; },
		registerFlag() {},
		getFlag() { return false; },
		appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
		sendUserMessage() {},
	};
	teamExtension(api);
	const ctx: any = {
		cwd: "/tmp/proj",
		hasUI: false,
		ui: { notify() {}, setStatus() {} },
		sessionManager: { getSessionId: () => "delta-sid", getEntries: () => entries, getBranch: () => entries },
	};
	for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);
	await cmds.team.handler("on", ctx);
	for (const fn of handlers.get("input") ?? []) await fn({ text: "big board", source: "rpc" }, ctx);
	const qid = stateFromEntries(entries, defaultConfig()).state.ledger!.requests[0].id;

	// Add 300 tasks (>80KB)
	const tasks = Array.from({ length: 300 }, (_, i) => ({
		id: `W-${i + 1}`,
		title: `Task ${i + 1} with substantial scope description`,
		requestIds: [qid],
		role: "bridges",
		dependsOn: [],
		readPaths: [`/tmp/proj/src/f${i + 1}.ts`],
		writePaths: [`/tmp/proj/src/f${i + 1}.ts`],
		acceptance: [`file f${i + 1}.ts passes lint and tests`],
	}));
	const addRes = await tools.get("team_tasks").execute("1", { action: "add", autoDispatch: false, tasks }, null, null, ctx);
	// Large board details must use compact ledgerSummary instead of full details.ledger
	assert.equal(addRes.details.ledger, undefined, "large board (>60 tasks) should not duplicate full ledger in toolResult details");
	assert.equal(addRes.details.ledgerSummary.totalTasks, 300);

	// Now update 5 tasks one by one — every persist should emit compact team-state-delta!
	const beforeCount = entries.length;
	for (let i = 1; i <= 5; i++) {
		await tools.get("team_tasks").execute(`u-${i}`, {
			action: "update",
			autoDispatch: false,
			updates: [{ id: `W-${i}`, status: "done", evidence: ["ok"], reason: "done" }],
		}, null, null, ctx);
	}
	const newStateEntries = entries.slice(beforeCount).filter(e => e.customType === "team-state" || e.customType === "team-state-delta");
	assert.equal(newStateEntries.length, 5);
	assert.ok(newStateEntries.every(e => e.customType === "team-state-delta"), "all 5 single-task updates on large board must emit team-state-delta");
	const maxDeltaBytes = Math.max(...newStateEntries.map(e => JSON.stringify(e.data).length));
	assert.ok(maxDeltaBytes < 2048, `delta should be tiny (<2KB), got ${maxDeltaBytes}B`);

	// Verify full state restores accurately across all 5 deltas
	const restored = stateFromEntries(entries, defaultConfig()).state;
	assert.equal(restored.ledger!.tasks.filter(t => t.status === "done").length, 5);
	assert.equal(restored.ledger!.tasks.length, 300);
});

await test("ledgerPrompt stays compact on 300-open-task board while preserving active/dispatchable items", () => {
	const board = newLedger();
	const q = addRequest(board, "huge board", "user");
	addTasks(board, Array.from({ length: 300 }, (_, i) => ({
		id: `W-${i + 1}`,
		title: `Task ${i + 1}`,
		requestIds: [q.id],
		role: "bridges",
		dependsOn: [],
		readPaths: [`/tmp/proj/src/f${i + 1}.ts`],
		writePaths: [`/tmp/proj/src/f${i + 1}.ts`],
		acceptance: [`f${i + 1} verified`],
	})), "/tmp/proj");
	board.tasks[150].status = "running";
	const prompt = ledgerPrompt(board);
	assert.ok(prompt.includes("W-151 [running]"), "running task must never be omitted");
	assert.ok(prompt.includes("additional open tasks omitted"), "overflow open tasks should be summarized");
	assert.ok(prompt.length < 40_000, `ledgerPrompt must stay compact (<40KB), got ${prompt.length}`);
});

await test("ledgerPrompt surfaces manualDispatch hold clearly in fmtTask lines", () => {
	const board = newLedger();
	const q = addRequest(board, "manual hold check", "user");
	addTasks(board, [{
		id: "W-hold",
		title: "Held task",
		requestIds: [q.id],
		role: "bridges",
		dependsOn: [],
		readPaths: [],
		writePaths: ["src/h.ts"],
		acceptance: ["ok"],
	}], "/tmp/proj", { manualDispatch: true });
	const prompt = ledgerPrompt(board);
	assert.ok(prompt.includes("hold=manualDispatch"), "manualDispatch hold must be visible in ledgerPrompt");
});

console.log(`\nAll ${passed} team-state-delta anti-bloat tests passed!`);
