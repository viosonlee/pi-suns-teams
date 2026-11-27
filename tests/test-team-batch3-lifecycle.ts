import assert from "node:assert/strict";
import { test } from "node:test";
import { newLedger, buildChildLifecycleView, type WorkTask } from "../team-ledger.ts";

function task(partial: Partial<WorkTask> & { id: string }): WorkTask {
	return {
		title: `t-${partial.id}`,
		role: "bridges",
		requestIds: ["Q-1"],
		dependsOn: [],
		readPaths: [],
		writePaths: [`src/${partial.id}.ts`],
		acceptance: ["evidence"],
		status: "ready",
		...partial,
	} as WorkTask;
}

function boardOf(...tasks: WorkTask[]) {
	const board = newLedger();
	board.tasks = tasks;
	return board;
}

test("2b: never-dispatched planned task is terminated/stable, writesCommitted yes-adjacent unknown", () => {
	const t = task({ id: "W-1", status: "planned" });
	const view = buildChildLifecycleView(boardOf(t), []);
	assert.equal(view.length, 1);
	assert.equal(view[0].terminated, true, "no session/runId/dispatchedAt → nothing to terminate");
	assert.equal(view[0].writesCommitted, "unknown", "no delivery evidence → unknown");
	assert.equal(view[0].leaseLive, false);
	assert.equal(view[0].liveConflictHolders.length, 0);
});

test("2b: running task with live probe is never safe to settle", () => {
	const t = task({ id: "W-2", status: "running", sessionId: "s-live", runId: "r1", dispatchedAt: new Date().toISOString() });
	const lease = { ...t };
	const view = buildChildLifecycleView(boardOf(t), [lease], () => true);
	assert.equal(view[0].terminated, false, "probe true = still live");
	assert.equal(view[0].writesCommitted, "no");
	assert.equal(view[0].leaseLive, true);
	assert.equal(view[0].safeToSettle, false);
	assert.ok(view[0].safeToSettleReasons.some(r => /still be running|live/.test(r)));
});

test("2b: unknown termination confidence is surfaced, never guessed safe", () => {
	// hosted child: non-live status, lease gone, but probe cannot decide → terminated null
	const t = task({ id: "W-3", status: "blocked", sessionId: "s-hosted", runId: "r3", dispatchedAt: new Date().toISOString(), evidence: ["delivery"] });
	const view = buildChildLifecycleView(boardOf(t), [], () => null);
	assert.equal(view[0].terminated, null, "probe indecisive → unknown confidence");
	assert.equal(view[0].writesCommitted, "yes", "non-live with delivery evidence → no longer writes (heuristic)");
	assert.equal(view[0].safeToSettle, false, "unknown-confidence must never read as safe");
	assert.ok(view[0].safeToSettleReasons.some(r => /UNKNOWN/.test(r)));
});

test("2b: proven-terminated blocked child with delivery evidence IS safe to settle", () => {
	const t = task({ id: "W-4", status: "blocked", sessionId: "s-dead", runId: "r4", dispatchedAt: new Date().toISOString(), evidence: ["delivery"] });
	const view = buildChildLifecycleView(boardOf(t), [], () => false);
	assert.equal(view[0].terminated, true);
	assert.equal(view[0].writesCommitted, "yes");
	assert.equal(view[0].safeToSettle, true);
});

test("2b: live lease held by this task blocks settlement", () => {
	const t = task({ id: "W-5", status: "blocked", sessionId: "s5", runId: "r5", dispatchedAt: new Date().toISOString(), evidence: ["delivery"] });
	// A lease is settled-on-board when its runId/sessionId matches the non-live board copy — so a
	// genuinely live lease (e.g. cross-branch child whose attempt identity differs) is the only
	// way leaseLive can be true for a blocked task. This mirrors isLeaseSettledOnBoard deliberately.
	const lease = { ...t, status: "running" as const, runId: "r5-branchB" };
	const view = buildChildLifecycleView(boardOf(t), [lease], () => false);
	assert.equal(view[0].leaseLive, true);
	assert.equal(view[0].safeToSettle, false);
	assert.ok(view[0].safeToSettleReasons.some(r => /live lease/.test(r)));
});

test("2b: stale settled lease does not count as live (same runId, board terminal)", () => {
	const t = task({ id: "W-6", status: "done", sessionId: "s6", runId: "r6", evidence: ["ok"] });
	const lease = { ...t, status: "running" as const };
	const view = buildChildLifecycleView(boardOf(t), [lease], () => false);
	assert.equal(view[0].leaseLive, false, "settled-on-board lease is dead");
	assert.equal(view[0].safeToSettle, true, "terminal and stable");
});

test("2b: write-write live conflict holders are enumerated", () => {
	const holder = task({ id: "W-7A", status: "running", sessionId: "sA", runId: "rA", dispatchedAt: new Date().toISOString(), writePaths: ["src/shared.ts"] });
	const target = task({ id: "W-7B", status: "ready", writePaths: ["src/shared.ts"] });
	const view = buildChildLifecycleView(boardOf(holder, target), [], () => null);
	const vB = view.find(v => v.id === "W-7B")!;
	assert.ok(vB.liveConflictHolders.includes("W-7A"), `expected W-7A in holders: ${vB.liveConflictHolders}`);
});

test("2b: filterIds narrows the view", () => {
	const a = task({ id: "W-8A" });
	const b = task({ id: "W-8B", writePaths: ["src/other.ts"] });
	const view = buildChildLifecycleView(boardOf(a, b), [], undefined, ["W-8B"]);
	assert.equal(view.length, 1);
	assert.equal(view[0].id, "W-8B");
});

test("2b: write-read conflict with a strict reader holder is reported", () => {
	const reader = task({ id: "W-9A", status: "running", sessionId: "sR", runId: "rR", dispatchedAt: new Date().toISOString(), readPaths: ["src/lib.ts"], writePaths: [] });
	const writer = task({ id: "W-9B", status: "ready", writePaths: ["src/lib.ts"] });
	const view = buildChildLifecycleView(boardOf(reader, writer), [], () => null);
	const vW = view.find(v => v.id === "W-9B")!;
	assert.ok(vW.liveConflictHolders.includes("W-9A"), `expected W-9A: ${vW.liveConflictHolders}`);
});

console.log("\nbatch3 lifecycle view tests passed");
