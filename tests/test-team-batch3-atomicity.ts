import assert from "node:assert/strict";
import { test } from "node:test";
import {
	newLedger, assessFullDispatchFailure, rollbackDispatchedBatchToDraft, publishTasks,
	type WorkTask,
} from "../team-ledger.ts";

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

// ---------- assessFullDispatchFailure matrix ----------
test("1a: full failure of attempted batch tasks → rollback warranted", () => {
	const board = boardOf(task({ id: "W-1", dispatchAttempts: 1 } as any), task({ id: "W-2", dispatchAttempts: 1 } as any));
	const a = assessFullDispatchFailure({
		newIds: ["W-1", "W-2"], board, launched: [],
		pumpErrors: ["W-1: launch exploded", "W-2: launch exploded"], autoDispatch: true,
	});
	assert.equal(a.rollback, true);
	assert.deepEqual(a.candidates.sort(), ["W-1", "W-2"]);
});
test("1a: partial launch NEVER rolls back", () => {
	const board = boardOf(task({ id: "W-1" }), task({ id: "W-2", dispatchAttempts: 1 } as any));
	const a = assessFullDispatchFailure({
		newIds: ["W-1", "W-2"], board, launched: ["W-1"],
		pumpErrors: ["W-2: boom"], autoDispatch: true,
	});
	assert.equal(a.rollback, false);
	assert.match(a.reason, /partial launch/);
});
test("1a: manualDispatch opt-out is intentionally undispatched, never waste", () => {
	const board = boardOf(task({ id: "W-1", manualDispatch: true } as any));
	const a = assessFullDispatchFailure({
		newIds: ["W-1"], board, launched: [], pumpErrors: [], autoDispatch: true,
	});
	assert.equal(a.rollback, false);
});
test("1a: autoDispatch:false add never rolls back", () => {
	const board = boardOf(task({ id: "W-1" }));
	const a = assessFullDispatchFailure({
		newIds: ["W-1"], board, launched: [], pumpErrors: ["W-1: x"], autoDispatch: false,
	});
	assert.equal(a.rollback, false);
	assert.match(a.reason, /intentionally undispatched/);
});
test("1a: draft stage never rolls back", () => {
	const board = boardOf(task({ id: "W-1", status: "planned" }));
	const a = assessFullDispatchFailure({
		newIds: ["W-1"], board, launched: [], pumpErrors: [], autoDispatch: true, stage: "draft",
	});
	assert.equal(a.rollback, false);
});
test("1a: pump_in_progress is transient — rows stay queued for the daemon retry", () => {
	const board = boardOf(task({ id: "W-1" }));
	const a = assessFullDispatchFailure({
		newIds: ["W-1"], board, launched: [], pumpErrors: ["pump_in_progress"], autoDispatch: true,
	});
	assert.equal(a.rollback, false);
	assert.match(a.reason, /transient/);
});
test("1a: drain error is transient", () => {
	const board = boardOf(task({ id: "W-1" }));
	const a = assessFullDispatchFailure({
		newIds: ["W-1"], board, launched: [], pumpErrors: ["draining since 2026 — /team resume to continue dispatching"], autoDispatch: true,
	});
	assert.equal(a.rollback, false);
});
test("1a: no errors at all means the pump never attempted — recoverable, not waste", () => {
	const board = boardOf(task({ id: "W-1" }));
	const a = assessFullDispatchFailure({
		newIds: ["W-1"], board, launched: [], pumpErrors: [], autoDispatch: true,
	});
	assert.equal(a.rollback, false);
	assert.match(a.reason, /recoverable/);
});
test("1a: errors naming only OLD tasks do not drag the new batch down", () => {
	const board = boardOf(task({ id: "W-0", status: "ready" }), task({ id: "W-1" }));
	const a = assessFullDispatchFailure({
		newIds: ["W-1"], board, launched: [], pumpErrors: ["W-0: old failure"], autoDispatch: true,
	});
	assert.equal(a.rollback, false);
});

// ---------- rollbackDispatchedBatchToDraft ----------
test("1a: rollback returns attempted failed rows to planned/draft with evidence", () => {
	const w1 = task({ id: "W-1", status: "failed", evidence: ["launch failed x3"] });
	(w1 as any).dispatchAttempts = 3;
	const board = boardOf(w1);
	const rolled = rollbackDispatchedBatchToDraft(board, ["W-1"]);
	assert.deepEqual(rolled, ["W-1"]);
	const t = board.tasks[0];
	assert.equal(t.status, "planned");
	assert.equal(t.stage, "draft");
	assert.ok(t.evidence!.some(e => /ROLLBACK-TO-DRAFT/.test(e)), "failure evidence preserved");
	assert.equal((t as any).dispatchAttempts, undefined, "attempt counter reset for the retry");
	// and publishTasks re-publishes it cleanly
	publishTasks(board, ["W-1"]);
	assert.equal(board.tasks[0].status, "ready");
});
test("1a: rollback clears retry holds and manual holds so re-publish is clean", () => {
	const w1 = task({ id: "W-1", status: "ready" });
	(w1 as any).dispatchAttempts = 1;
	(w1 as any).nextRetryAt = Date.now() + 60000;
	(w1 as any).manualDispatch = true;
	(w1 as any).manualDispatchReason = "prior child preserved";
	const board = boardOf(w1);
	rollbackDispatchedBatchToDraft(board, ["W-1"]);
	assert.equal((board.tasks[0] as any).nextRetryAt, undefined);
	assert.equal((board.tasks[0] as any).manualDispatch, undefined);
});
test("1a: rollback never touches tasks the pump never attempted", () => {
	const neverTried = task({ id: "W-1", status: "ready" }); // no dispatchAttempts
	const board = boardOf(neverTried);
	const rolled = rollbackDispatchedBatchToDraft(board, ["W-1"]);
	assert.deepEqual(rolled, []);
	assert.equal(board.tasks[0].status, "ready", "unattempted rows stay queued for retry");
});
test("1a: rollback never touches terminal or live statuses", () => {
	const board = boardOf(
		task({ id: "W-1", status: "done" }),
		task({ id: "W-2", status: "running" }),
	);
	const rolled = rollbackDispatchedBatchToDraft(board, ["W-1", "W-2"]);
	assert.deepEqual(rolled, []);
});

console.log("\nbatch3 atomicity tests passed");
