import { strict as assert } from 'node:assert';
import {
	newLedger, addRequest, addTasks, recordReview, deliveryVersionOf, updateTask,
	createReviewerTask, consecutiveReworkCount, decideReviewPolicy, addTasks as addTasksLedger,
	type WorkLedger,
} from '../team-ledger.ts';

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };

const review = (over: any = {}) => ({
	reviewTaskId: 'W-rev-1', workerTaskId: 'W-1',
	verdict: 'PASS', checks: [], defects: [], nextActions: [],
	raw: 'VERDICT: PASS', parsed: true, reasons: [], deliveryVersion: '', createdAt: '2026-01-01T00:00:00.000Z',
	...over,
});

const setup = (specChanges: any = {}): WorkLedger => {
	const board = newLedger();
	const request = addRequest(board, 'do the thing', 'user-setup');
	addTasks(board, [{
		title: 'work', role: 'bridges', requestIds: [request.id], dependsOn: [],
		readPaths: ['/a'], writePaths: ['/b'], acceptance: ['a passes'],
		...specChanges,
	}], '/');
	const worker = board.tasks[0];
	worker.status = 'reported';
	worker.runId = 'run-1';
	worker.sessionId = 'sess-1';
	worker.dispatchedAt = '2026-01-01T00:00:00.000Z';
	createReviewerTask(board, worker);
	const rev = board.tasks[1];
	rev.status = 'running';
	return board;
};

test('reviewTier "advisory" is accepted by registration validation and spawns a non-gating reviewer', () => {
	const board = newLedger();
	const request = addRequest(board, 'x', 'src');
	const tasks = addTasks(board, [{
		title: 'advisory work', role: 'bridges', requestIds: [request.id], dependsOn: [],
		readPaths: [], writePaths: ['/x'], acceptance: ['x'], reviewTier: 'advisory',
	}], '/');
	assert.equal(tasks[0].reviewTier, 'advisory');
	const decision = decideReviewPolicy('bridges', tasks[0]);
	assert.equal(decision.spawnReviewerOnDelivery, true, 'advisory still spawns the reviewer lane');
	assert.equal(decision.requireIndependentReview, false, 'advisory is non-gating');
	// invalid tiers still reject
	assert.throws(() => addTasks(board, [{
		title: 'bad', role: 'bridges', requestIds: [request.id], dependsOn: [],
		readPaths: [], writePaths: ['/y'], acceptance: ['x'], reviewTier: 'bogus',
	}], '/'), /reviewTier must be deterministic, llm, none or advisory/);
});

test('advisory PASS records feedback but never settles the worker; the review slot closes', () => {
	const board = setup({ reviewTier: 'advisory' });
	const worker = board.tasks[0];
	const rev = board.tasks[1];
	assert.equal(rev.reviewAdvisory, true, 'reviewAdvisory propagated to reviewer slot');
	const out = recordReview(board, review({ deliveryVersion: deliveryVersionOf(worker) }));
	assert.equal(out.workerTask.status, 'reported', 'worker is NOT settled by advisory PASS');
	assert.equal(out.reviewTask.status, 'done', 'advisory review closes its slot');
	assert.ok(out.workerTask.evidence.some(e => e.includes('[ADVISORY VERDICT — NON-GATING]')));
});

test('advisory REWORK does not send the worker back and never counts toward the brake', () => {
	const board = setup({ reviewTier: 'advisory' });
	const worker = board.tasks[0];
	const out = recordReview(board, review({
		verdict: 'REWORK', deliveryVersion: deliveryVersionOf(worker),
		defects: ['style issue'], nextActions: ['polish'],
	}));
	assert.equal(out.workerTask.status, 'reported', 'worker is never sent back by advisory REWORK');
	assert.equal(out.workerTask.retryCount ?? 0, 0, 'no retry bump');
	assert.equal(consecutiveReworkCount(board, 'W-1'), 0, 'advisory REWORK never counts as a gating round');
});

test('two consecutive gating REWORK rounds trip the hard brake without parent authorization', () => {
	const board = setup();
	const worker = board.tasks[0];
	// round 1: REWORK sends worker back to ready (progressing findings each round)
	recordReview(board, review({
		verdict: 'REWORK', deliveryVersion: deliveryVersionOf(worker),
		defects: ['first defect'],
	}));
	assert.equal(worker.status, 'ready');
	assert.equal(consecutiveReworkCount(board, 'W-1'), 1);
	// simulate redelivery: worker re-dispatches and reports a new delivery version
	worker.status = 'reported';
	worker.runId = 'run-2';
	worker.sessionId = 'sess-2';
	createReviewerTask(board, worker);
	const rev2 = board.tasks.find(t => t.id === 'W-rev-1')!;
	rev2.status = 'running';
	const out = recordReview(board, review({
		verdict: 'REWORK', deliveryVersion: deliveryVersionOf(worker),
		attemptId: rev2.reviewAttemptId,
		defects: ['a completely different second defect — genuine progress'],
	}));
	assert.equal(out.workerTask.status, 'blocked', 'second consecutive REWORK hits the hard brake even with progress');
	assert.equal(out.reviewTask.status, 'blocked');
	assert.ok(out.workerTask.evidence.some(e => e.includes('[REWORK HARD BRAKE]')));
	assert.match(out.workerTask.reason ?? '', /explicitly requeue/);
});

test('a PASS between reworks resets the consecutive counter', () => {
	const board = newLedger();
	// directly exercise the counter across a mixed receipt history
	(board as any).reviewRecords = [
		{ reviewTaskId: 'W-rev-1', workerTaskId: 'W-1', verdict: 'REWORK', createdAt: 't1' },
		{ reviewTaskId: 'W-rev-1', workerTaskId: 'W-1', verdict: 'PASS', createdAt: 't2' },
		{ reviewTaskId: 'W-rev-1', workerTaskId: 'W-1', verdict: 'REWORK', createdAt: 't3' },
	];
	assert.equal(consecutiveReworkCount(board, 'W-1'), 1, 'PASS breaks the run');
});

test('advisory ESCALATE annotates the worker reason without blocking it', () => {
	const board = setup({ reviewTier: 'advisory' });
	const worker = board.tasks[0];
	const out = recordReview(board, review({
		verdict: 'ESCALATE', deliveryVersion: deliveryVersionOf(worker),
		defects: ['architecture concern'],
	}));
	assert.equal(out.workerTask.status, 'reported', 'advisory ESCALATE never blocks the worker');
	assert.match(out.workerTask.reason ?? '', /Advisory review ESCALATE/);
});

test('PASS-with-notes advisory verdict releases the parent-held task on requeue/acceptance', () => {
	const board = newLedger(); addRequest(board, 'obj', 'in', 'user');
	addTasks(board, [{ role: 'bridges', title: 'T', requestIds: ['Q-1'], dependsOn: [], readPaths: [], writePaths: ['w.ts'], acceptance: ['a'], reviewTier: 'advisory' }], '/');
	const t = board.tasks[0];
	t.status = 'reported';
	createReviewerTask(board, t);
	const revTask = board.tasks[1];
	revTask.status = 'reported';
	const rr = recordReview(board, review({ workerTaskId: t.id, reviewTaskId: revTask.id, verdict: 'PASS', notes: 'minor nits: naming could be better', deliveryVersion: deliveryVersionOf(t) }));
	assert.equal(rr.workerTask.status, 'reported', 'worker stays reported for parent');
	// parent accepts the reported delivery directly (release path) — updateTask is the ledger entry point
	updateTask(board, { id: t.id, status: 'done', evidence: ['parent accepted with advisory notes reviewed'], reason: 'advisory PASS acknowledged' });
	assert.equal(t.status, 'done', 'parent acceptance releases the advisory-held task');
	assert.ok((t.evidence ?? []).some(e => /ADVISORY|notes|accepted/i.test(e)), 'advisory notes/acceptance preserved in evidence for traceability');
});

console.log(`\n${passed} assertions passed`);
