import { strict as assert } from 'node:assert';
import {
	newLedger, addRequest, addTasks, recordReview, deliveryVersionOf, hasValidReview,
	reviewRecordsOf, createReviewerTask, occupiesSlot, liveWork, readyTasks, nextDispatchableTasks,
	type WorkLedger, type WorkTask,
} from '../team-ledger.ts';

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };

const review = (over: Partial<Parameters<typeof recordReview>[1]> = {}) => ({
	reviewTaskId: 'W-rev-1', workerTaskId: 'W-1',
	attemptId: 'review-attempt-1', reviewerRunId: 'run-rev', reviewerSessionId: 'sess-rev',
	verdict: 'PASS' as const, checks: [], defects: [], nextActions: [],
	raw: 'VERDICT: PASS', parsed: true, reasons: [], deliveryVersion: '', createdAt: '2026-01-01T00:00:00.000Z',
	...over,
});

const setup = (): WorkLedger => {
	const board = newLedger();
	const request = addRequest(board, 'do the thing', 'user-setup');
	addTasks(board, [{
		title: 'work', role: 'bridges', requestIds: [request.id], dependsOn: [],
		readPaths: ['/a'], writePaths: ['/b'], acceptance: ['a passes', 'b passes'],
	}], '/');
	const worker = board.tasks[0];
	worker.status = 'reported';
	worker.runId = 'run-1';
	worker.sessionId = 'sess-1';
	worker.dispatchedAt = '2026-01-01T00:00:00.000Z';
	createReviewerTask(board, worker);
	const rev = board.tasks[1];
	rev.runId = 'run-rev'; rev.sessionId = 'sess-rev'; rev.dispatchedAt = '2026-01-01T00:00:00.000Z';
	rev.reviewAttemptId = 'review-attempt-1'; rev.status = 'running';
	return board;
};

test('reviewing releases its execution slot; running still holds one', () => {
	assert.equal(occupiesSlot('reviewing'), false);
	assert.equal(occupiesSlot('running'), true);
	assert.equal(occupiesSlot('reported'), false);
	// dependency semantics keep the old broader meaning
	assert.equal(liveWork('reviewing'), true);
});

test('PASS marks the worker done and appends the record', () => {
	const board = setup();
	const worker = board.tasks[0];
	const out = recordReview(board, review({ deliveryVersion: deliveryVersionOf(worker) }));
	assert.equal(out.workerTask.status, 'done');
	assert.equal(out.reviewTask.status, 'done');
	assert.equal(reviewRecordsOf(board).length, 1);
	assert.equal(hasValidReview(board, worker), true);
});

test('PASS evidence is never truncated', () => {
	const board = setup();
	const raw = 'VERDICT: PASS\n' + 'x'.repeat(8000);
	recordReview(board, review({ deliveryVersion: deliveryVersionOf(board.tasks[0]), raw }));
	assert.equal(reviewRecordsOf(board)[0].raw.length, raw.length);
});

test('a stale PASS from an older delivery version does not count', () => {
	const board = setup();
	const worker = board.tasks[0];
	recordReview(board, review({ deliveryVersion: deliveryVersionOf(worker) }));
	assert.equal(hasValidReview(board, worker), true);
	worker.retryCount = 1; // re-dispatched attempt
	assert.equal(hasValidReview(board, worker), false);
});

test('REWORK sends the worker back to ready with defects and bumps retryCount', () => {
	const board = setup();
	const worker = board.tasks[0];
	const out = recordReview(board, review({
		verdict: 'REWORK', deliveryVersion: deliveryVersionOf(worker),
		defects: ['slot not released'], nextActions: ['use occupiesSlot in runningCount'],
	}));
	assert.equal(out.workerTask.status, 'ready');
	assert.equal(out.workerTask.retryCount, 1);
	assert.ok(out.workerTask.evidence.some(e => e.includes('slot not released')));
	assert.ok(out.workerTask.evidence.some(e => e.startsWith('[NEXT] use occupiesSlot')));
	assert.equal(out.reviewTask.status, 'superseded');
});

test('INCOMPLETE keeps the worker reported and blocks the review pending parent action', () => {
	const board = setup();
	const worker = board.tasks[0];
	const out = recordReview(board, review({
		verdict: 'INCOMPLETE', deliveryVersion: deliveryVersionOf(worker), reasons: ['missing_verdict'], raw: 'looks fine',
	}));
	assert.equal(out.workerTask.status, 'reported');
	assert.equal(out.reviewTask.status, 'blocked');
	assert.equal(out.reviewTask.sessionId, undefined);
	assert.match(out.workerTask.reason, /INCOMPLETE/);
	assert.match(String(out.reviewTask.reason), /Parent decision required/i);
	assert.match(String(out.reviewTask.reason), /explicitly requeue/i);
	assert.ok(out.reviewTask.evidence.some(e => e.startsWith('[LEASE RELEASED]') && e.includes('run-rev')));
	assert.equal(out.reviewTask.runId, undefined);
	assert.ok(!readyTasks(board).some(t => t.id === out.reviewTask.id), 'INCOMPLETE must not auto-retry');
	assert.ok(!nextDispatchableTasks(board).some(t => t.id === out.reviewTask.id), 'INCOMPLETE review stays held for parent action');
});

test('ESCALATE blocks the worker for the parent', () => {
	const board = setup();
	const worker = board.tasks[0];
	const out = recordReview(board, review({
		verdict: 'ESCALATE', deliveryVersion: deliveryVersionOf(worker), defects: ['acceptance contradicts itself'],
	}));
	assert.equal(out.workerTask.status, 'blocked');
	assert.match(out.workerTask.reason, /ESCALATE/);
});

test('review task is bound to one delivery version', () => {
	const board = setup();
	const worker = board.tasks[0];
	const existing = board.tasks[1];
	existing.status = 'ready';
	delete existing.runId; delete existing.sessionId; delete existing.dispatchedAt;
	const same = createReviewerTask(board, worker);
	assert.equal(same.reviewedDeliveryVersion, deliveryVersionOf(worker));
	assert.equal(board.tasks.filter(t => t.id === 'W-rev-1' && t.status !== 'superseded').length, 1);
	worker.retryCount = 2;
	const fresh = createReviewerTask(board, worker);
	assert.equal(fresh.status, 'ready');
	assert.equal(board.tasks.filter(t => t.id === 'W-rev-1' && t.status !== 'superseded').length, 1);
});

test('repeating the same verdict is idempotent instead of duplicating records', () => {
	const board = setup();
	const worker = board.tasks[0] as WorkTask;
	const payload = review({ deliveryVersion: deliveryVersionOf(worker) });
	recordReview(board, payload);
	worker.status = 'reported';
	createReviewerTask(board, worker);
	recordReview(board, { ...payload, reviewTaskId: 'W-rev-1' });
	assert.equal(reviewRecordsOf(board).length, 1);
});

console.log(`\n${passed} review-gate tests passed`);
