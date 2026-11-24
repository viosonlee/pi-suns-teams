/**
 * W75 — review lifecycle safety regression suite (ledger-only, no live sessions).
 *
 * Counterexamples taken from the W74 audit:
 * - team-ledger.ts:665-704 duplicate reviewer identity (a `done` review was not reusable, so
 *   ESCALATE -> requeue -> redelivery pushed a SECOND `W-rev-<id>` and every later addTasks threw);
 * - team-ledger.ts:748-758/818-825 STALE demoted a NEWER running/uncertain delivery to `reported`;
 * - team-ledger.ts:806-816 INCOMPLETE re-armed the reviewer (`ready`, lease cleared) forever;
 * - team-ledger.ts:761-762 a same-verdict receipt overwrote the earlier attempt's raw report.
 *
 * Every test uses its own mkdtemp TMPDIR; nothing touches the real ledger, a session, or a child.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	newLedger, addRequest, addTasks, createReviewerTask, recordReview, deliveryVersionOf,
	reviewRecordsOf, hasValidReview, readyTasks, nextDispatchableTasks, markDispatched, observeTask,
	updateTask, reviewerTaskId, isReviewTask, reviewReceiptKey, pruneStaleReviews, reviewAttemptIdentity,
	retireDuplicateReviewSlots, canonicalReviewSlots,
	completeReviewTask, reviewCompletionOrigin, ReviewReceiptConflictError, ReviewReceiptOriginError,
	reviewDispatchOwnershipProblem, reviewOriginFromDispatchLease,
	type ReviewRecord, type WorkLedger, type WorkTask,
} from '../team-ledger.ts';

// The real persistence delta/replay helpers are imported READ-ONLY: extensions/team.ts is owned by another task
// and is never edited here, but the D5 regression must exercise the actual path the host persists the ledger with
// (its delta store is keyed by `task.id`).
const teamPersistence = await import('../extensions/team.ts');

// Round 8: the fixture root is overridable so the suite also runs where /tmp is read-only (the reviewer sandbox
// failed with EROFS on mkdtemp /tmp/w75-review-lifecycle-*). Set W75_FIXTURE_ROOT to any writable directory.
const ROOT = (() => {
	const override = process.env.W75_FIXTURE_ROOT;
	if (override) { mkdirSync(override, { recursive: true }); return override; }
	return mkdtempSync(join(tmpdir(), 'w75-review-lifecycle-'));
})();
mkdirSync(join(ROOT, 'src'), { recursive: true });
writeFileSync(join(ROOT, 'src', 'mod.ts'), 'export const one = 1;\n');

let passed = 0;
const failures: string[] = [];
const test = (name: string, fn: () => void) => {
	try { fn(); passed++; console.log(`✓ ${name}`); }
	catch (err) { failures.push(name); throw err; }
};

const receipt = (over: Partial<ReviewRecord> = {}): ReviewRecord => ({
	reviewTaskId: 'W-rev-1', workerTaskId: 'W-1',
	verdict: 'PASS', checks: [], defects: [], nextActions: [],
	raw: 'VERDICT: PASS', parsed: true, reasons: [], deliveryVersion: '',
	createdAt: '2026-01-01T00:00:00.000Z',
	...over,
});

/** Worker W-1 delivered once and is waiting for its reviewer. */
function boardWithDeliveredWorker(): { board: WorkLedger; worker: WorkTask; requestId: string } {
	const board = newLedger();
	const request = addRequest(board, 'repair the ledger lifecycle', 'w75-test');
	addTasks(board, [{
		title: 'repair ledger', role: 'bridges', requestIds: [request.id], dependsOn: [],
		readPaths: [join(ROOT, 'src')], writePaths: [join(ROOT, 'src')], acceptance: ['a passes', 'b passes'],
	}], ROOT);
	const worker = board.tasks[0];
	worker.status = 'reported';
	worker.runId = 'run-1';
	worker.sessionId = 'sess-1';
	worker.dispatchedAt = '2026-01-01T00:00:00.000Z';
	return { board, worker, requestId: request.id };
}

const countId = (board: WorkLedger, id: string): number => board.tasks.filter(t => t.id === id).length;
const ownershipOf = (task: WorkTask) => ({
	status: task.status,
	runId: task.runId,
	sessionId: task.sessionId,
	dispatchedAt: task.dispatchedAt,
	retryCount: task.retryCount,
	reason: task.reason,
	evidenceLength: task.evidence.length,
});

// ─────────────────── AC1: canonical reviewer id is unique through ESCALATE ───────────────────

test('ESCALATE -> requeue -> redelivery keeps one canonical reviewer id and addTasks still works', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const first = createReviewerTask(board, worker);
	assert.equal(first.id, 'W-rev-1');
	const escalate = recordReview(board, receipt({
		verdict: 'ESCALATE', deliveryVersion: deliveryVersionOf(worker),
		defects: ['acceptance contradicts itself'], raw: 'VERDICT: ESCALATE\nDEFECTS:\n- acceptance contradicts itself',
	}));
	assert.equal(escalate.workerTask.status, 'blocked');
	assert.equal(escalate.reviewTask.status, 'done');
	assert.equal(countId(board, 'W-rev-1'), 1);
	const escalateRaw = reviewRecordsOf(board)[0].raw;

	// Parent arbitrates and the worker is requeued for a new attempt.
	updateTask(board, { id: worker.id, status: 'ready', evidence: ['parent: acceptance clarified'], reason: 'arbitration done, retry' });
	markDispatched(board, worker.id, 'bridges', 'run-2');
	assert.equal(worker.status, 'running');
	assert.ok(observeTask(board, 'run-2', undefined, 'reported'));
	assert.equal(worker.status, 'reported');
	const second = createReviewerTask(board, worker);

	// The bug: the `done` review was not reusable, so a duplicate `W-rev-1` was pushed here.
	assert.equal(second.id, 'W-rev-1');
	assert.equal(countId(board, 'W-rev-1'), 1, 'canonical reviewer id must stay unique after redelivery');
	assert.equal(second.status, 'ready');
	assert.equal(second.reviewedDeliveryVersion, deliveryVersionOf(worker));
	assert.ok(second.evidence.some(line => line.includes('PRIOR ATTEMPT W-rev-1') && line.includes('last_verdict=ESCALATE')), second.evidence.join('\n'));
	assert.equal(reviewRecordsOf(board).length, 1, 'the ESCALATE receipt survives the slot reuse');
	assert.equal(reviewRecordsOf(board)[0].raw, escalateRaw, 'raw report of the closed attempt is not overwritten');

	// The bug's visible symptom: a duplicated id made EVERY later addTasks throw.
	const added = addTasks(board, [{
		title: 'follow-up after redelivery', role: 'ayton', requestIds: [second.requestIds[0]], dependsOn: [],
		readPaths: [], writePaths: [], acceptance: ['follow-up verified'],
	}], ROOT);
	assert.equal(added.length, 1);
	assert.equal(addTasks(board, [{
		title: 'second follow-up', role: 'ayton', requestIds: [second.requestIds[0]], dependsOn: [],
		readPaths: [], writePaths: [], acceptance: ['second follow-up verified'],
	}], ROOT).length, 1);

	const pass = recordReview(board, receipt({
		verdict: 'PASS', deliveryVersion: deliveryVersionOf(worker), attemptId: reviewAttemptIdentity(second)!.attemptId, raw: 'VERDICT: PASS\nCRITERION: a passes => PASS | evidence: src/mod.ts:1',
	}));
	assert.equal(pass.workerTask.status, 'done');
	assert.equal(pass.reviewTask.status, 'done');
	assert.equal(countId(board, 'W-rev-1'), 1);
	const records = reviewRecordsOf(board);
	assert.equal(records.length, 2);
	assert.notEqual(records[0].raw, records[1].raw);
	assert.equal(records[1].attempt, 2);
	assert.equal(hasValidReview(board, worker), true);
});

test('createReviewerTask is idempotent for the same delivery and never forks the id', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const a = createReviewerTask(board, worker, 'cp', 'fp-1');
	const b = createReviewerTask(board, worker, 'cp', 'fp-1');
	assert.equal(a, b);
	assert.equal(countId(board, 'W-rev-1'), 1);
	assert.equal(b.reviewFingerprint, 'fp-1');
});

test('a live reviewer of an older delivery is preserved, its verdict goes STALE, then the slot reopens', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const oldVersion = deliveryVersionOf(worker);
	rev.status = 'running';
	rev.runId = 'rev-run-old';
	rev.sessionId = 'rev-sess-old';
	const ownedBefore = ownershipOf(rev);

	// The worker is re-dispatched while that reviewer is still running.
	worker.retryCount = 2;
	const held = createReviewerTask(board, worker);
	assert.equal(held.id, 'W-rev-1');
	assert.equal(held.status, 'running', 'live review work is never superseded behind the child');
	assert.equal(held.reviewedDeliveryVersion, oldVersion);
	assert.deepEqual(ownershipOf(held), ownedBefore, 'the live attempt is not mutated');
	assert.equal(countId(board, 'W-rev-1'), 1, 'no second reviewer is stacked on one worker');

	// Its late verdict must never reach the newer delivery.
	const applied = recordReview(board, receipt({
		verdict: 'PASS', deliveryVersion: oldVersion, attemptId: reviewAttemptIdentity(rev)!.attemptId, reviewerRunId: 'rev-run-old', reviewerSessionId: 'rev-sess-old',
		raw: 'VERDICT: PASS (old delivery)',
	}), { deliveryVersion: deliveryVersionOf(worker) });
	assert.equal(applied.workerTask.status, 'reported');
	assert.equal(applied.reviewTask.status, 'superseded');
	assert.equal(reviewRecordsOf(board).at(-1)!.verdict, 'STALE');
	assert.equal(hasValidReview(board, worker), false);

	// Only now does the canonical slot reopen for the newer delivery.
	const fresh = createReviewerTask(board, worker);
	assert.equal(fresh.status, 'ready');
	assert.equal(fresh.reviewedDeliveryVersion, deliveryVersionOf(worker));
	assert.equal(countId(board, 'W-rev-1'), 1);
	assert.ok(fresh.evidence.some(line => line.includes('last_verdict=STALE')), fresh.evidence.join('\n'));
});

test('an idle review hold for an older delivery is closed and rebound to the same id', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	rev.status = 'ready';
	const oldVersion = deliveryVersionOf(worker);
	worker.retryCount = 3;
	const fresh = createReviewerTask(board, worker);
	assert.equal(fresh.status, 'ready');
	assert.notEqual(fresh.reviewedDeliveryVersion, oldVersion);
	assert.equal(fresh.reviewedDeliveryVersion, deliveryVersionOf(worker));
	assert.equal(countId(board, 'W-rev-1'), 1);
	assert.ok(fresh.evidence.some(line => line.includes('PRIOR ATTEMPT W-rev-1 status=superseded')), fresh.evidence.join('\n'));
});

// ─────────────────── AC3: review-of-review is rejected ───────────────────

test('the exported reviewer helper rejects review-of-review without mutating the ledger', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	assert.equal(isReviewTask(rev), true);
	const before = JSON.stringify(board);
	assert.throws(() => createReviewerTask(board, rev), /review task \(parent=W-1\)|never the deliverable of another verdict/i);
	assert.throws(() => createReviewerTask(board, rev, 'cp', 'fp-x'), /review task/i);
	assert.equal(JSON.stringify(board), before, 'rejecting review-of-review must not create or mutate a task');

	assert.throws(() => recordReview(board, receipt({
		reviewTaskId: rev.id, workerTaskId: rev.id, verdict: 'PASS', deliveryVersion: deliveryVersionOf(rev),
	})), /never the deliverable of another review/i);
	assert.equal(reviewRecordsOf(board).length, 0, 'no verdict is recorded for a review-of-review');
});

// ─────────────────── AC4: ambiguous legacy duplicates fail closed ───────────────────

test('ambiguous legacy live duplicate ownership fails closed and deletes nothing', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const template = createReviewerTask(board, worker);
	const legacyA: WorkTask = {
		...structuredClone(template), id: 'W-rev-1', status: 'running', runId: 'rev-run-a', sessionId: 'rev-sess-a',
		evidence: ['legacy attempt A verdict lines'], reviewAttempts: 1,
	};
	const legacyB: WorkTask = {
		...structuredClone(template), id: 'W-rev-1', status: 'running', runId: 'rev-run-b', sessionId: 'rev-sess-b',
		evidence: ['legacy attempt B verdict lines'], reviewAttempts: 1,
	};
	board.tasks = board.tasks.filter(t => t.id !== 'W-rev-1');
	board.tasks.push(legacyA, legacyB);
	board.reviewRecords = [];
	const before = JSON.stringify(board);

	assert.throws(() => createReviewerTask(board, worker), /2 open review tasks share the canonical reviewer id/i);
	assert.throws(() => createReviewerTask(board, worker), /rev-run-a/);
	assert.throws(() => createReviewerTask(board, worker), /rev-run-b/);
	assert.equal(JSON.stringify(board), before, 'fail closed must not mutate status, evidence, owners, or revision');
	assert.deepEqual(board.tasks.filter(t => t.id === 'W-rev-1').map(t => t.evidence), [['legacy attempt A verdict lines'], ['legacy attempt B verdict lines']]);
});

test('closed legacy duplicates are reused, not multiplied', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const template = createReviewerTask(board, worker);
	board.tasks = board.tasks.filter(t => t.id !== 'W-rev-1');
	board.tasks.push({ ...structuredClone(template), status: 'cancelled', evidence: ['old A'], reason: 'legacy' });
	board.tasks.push({ ...structuredClone(template), status: 'superseded', evidence: ['old B'], reason: 'legacy' });
	const total = board.tasks.length;
	const fresh = createReviewerTask(board, worker);
	assert.equal(fresh.status, 'ready');
	assert.equal(countId(board, 'W-rev-1'), 1, 'the canonical reviewer id stays unique after reuse');
	assert.equal(board.tasks.length, total, 'no third copy is appended and no legacy copy is deleted');
	assert.ok(fresh.evidence.some(line => line.includes('PRIOR ATTEMPT W-rev-1 status=superseded')), fresh.evidence.join('\n'));
	// W75 round 7: the surplus closed duplicate is RENAMED (unique archival id) instead of keeping the canonical id.
	const tombstone = board.tasks.find(t => t.retiredFrom === 'W-rev-1');
	assert.equal(tombstone?.id, 'W-rev-1~retired-1', 'the surplus closed duplicate gets a unique archival id');
	assert.equal(tombstone?.status, 'cancelled');
	assert.ok(tombstone?.evidence.includes('old A'), 'its evidence stays verbatim');
	assert.equal(fresh.evidence.filter(line => line.startsWith('[RETAINED DUPLICATE]')).length, 1, 'the retained reference is carried exactly once');
});

test('a failed review of the same delivery is a hold, never silently re-armed', () => {
	const { board, worker } = boardWithDeliveredWorker();
	createReviewerTask(board, worker);
	const rev = board.tasks.find(t => t.id === 'W-rev-1')!;
	rev.status = 'failed';
	rev.reason = 'reviewer child crashed';
	rev.evidence = ['crash terminal state'];
	const same = createReviewerTask(board, worker);
	assert.equal(same.status, 'failed', 'a dead attempt is not relaunched automatically');
	assert.equal(countId(board, 'W-rev-1'), 1);
	// The documented recovery is an explicit parent action (prune_reviews cancels it), then a fresh attempt.
	pruneStaleReviews(board);
	assert.equal(board.tasks.find(t => t.id === 'W-rev-1')!.status, 'cancelled');
	const fresh = createReviewerTask(board, worker);
	assert.equal(fresh.status, 'ready');
	assert.equal(countId(board, 'W-rev-1'), 1);
	assert.ok(fresh.evidence.some(line => line.includes('PRIOR ATTEMPT W-rev-1 status=cancelled')), fresh.evidence.join('\n'));
});

// ─────────────────── AC5: STALE never mutates a newer live attempt ───────────────────

for (const liveStatus of ['running', 'uncertain'] as const) {
	test(`STALE leaves a newer ${liveStatus} attempt's ownership untouched`, () => {
		const { board, worker } = boardWithDeliveredWorker();
		const rev = createReviewerTask(board, worker);
		const pinned = deliveryVersionOf(worker);
		// The worker was re-dispatched while the reviewer was still running.
		worker.runId = 'run-newer';
		worker.sessionId = 'sess-newer';
		worker.dispatchedAt = '2026-02-02T00:00:00.000Z';
		worker.retryCount = 1;
		worker.status = liveStatus;
		worker.reason = 'newer attempt owns this task';
		const owned = ownershipOf(worker);

		const applied = recordReview(board, receipt({
			verdict: 'PASS', deliveryVersion: pinned, raw: 'VERDICT: PASS',
		}), { deliveryVersion: deliveryVersionOf(worker) });

		assert.equal(applied.workerTask.status, liveStatus);
		assert.deepEqual(ownershipOf(applied.workerTask), owned, 'status/run/session/dispatch/retry/lease ownership must not change');
		assert.equal(hasValidReview(board, worker), false);
		const record = reviewRecordsOf(board).at(-1)!;
		assert.equal(record.verdict, 'STALE');
		assert.equal(record.deliveryVersion, pinned);
		assert.equal(record.observedDeliveryVersion, deliveryVersionOf(worker));
		assert.ok(record.reasons.some(r => r.startsWith('delivery_version_drift')), record.reasons.join(','));
		assert.equal(applied.reviewTask.status, 'superseded');
	});
}

test('STALE on a finished attempt never rewrites the worker reason/owner', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const pinned = deliveryVersionOf(worker);
	worker.runId = 'run-newer';
	worker.retryCount = 1;
	const owned = ownershipOf(worker);
	const applied = recordReview(board, receipt({ verdict: 'PASS', deliveryVersion: pinned }), { deliveryVersion: deliveryVersionOf(worker) });
	assert.equal(applied.workerTask.status, 'reported');
	assert.deepEqual(ownershipOf(applied.workerTask), { ...owned, evidenceLength: owned.evidenceLength + 1 });
	assert.ok(applied.workerTask.evidence.some(e => e.startsWith('[STALE REVIEW DISCARDED]')));
	assert.equal(applied.reviewTask.status, 'superseded');
});

test('fingerprint drift keeps the reviewed attempt reported and discards the verdict', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker, 'cp', 'fp-open');
	const version = deliveryVersionOf(worker);
	const applied = recordReview(board, receipt({ verdict: 'PASS', deliveryVersion: version }), { deliveryVersion: version, fingerprint: 'fp-changed' });
	assert.equal(applied.workerTask.status, 'reported');
	assert.equal(reviewRecordsOf(board).at(-1)!.verdict, 'STALE');
	assert.ok(reviewRecordsOf(board).at(-1)!.reasons.some(r => r.startsWith('artefact_fingerprint_drift')));
	assert.equal(hasValidReview(board, worker), false);
});

// ─────────────────── AC6: INCOMPLETE must not auto-launch ───────────────────

test('INCOMPLETE blocks the review hold instead of re-arming the reviewer', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	rev.status = 'running';
	rev.runId = 'rev-run-1';
	rev.sessionId = 'rev-sess-1';
	rev.dispatchedAt = '2026-01-01T00:10:00.000Z';
	const out = recordReview(board, receipt({
		verdict: 'INCOMPLETE', deliveryVersion: deliveryVersionOf(worker), attemptId: reviewAttemptIdentity(rev)!.attemptId,
		reviewerRunId: 'rev-run-1', reviewerSessionId: 'rev-sess-1', reasons: ['missing_verdict'], raw: 'looks fine',
	}));

	assert.equal(out.workerTask.status, 'reported', 'the worker is never accepted by INCOMPLETE');
	assert.match(String(out.workerTask.reason), /INCOMPLETE/);
	assert.equal(out.reviewTask.status, 'blocked', 'no auto relaunch: the hold is a semantic parent decision');
	assert.match(String(out.reviewTask.reason), /Parent decision required/i);
	assert.match(String(out.reviewTask.reason), /explicitly requeue/);
	assert.ok(out.reviewTask.evidence.some(e => e.startsWith('[LEASE RELEASED]') && e.includes('rev-run-1')), out.reviewTask.evidence.join('\n'));
	assert.equal(out.reviewTask.runId, undefined);
	assert.equal(out.reviewTask.sessionId, undefined);

	assert.ok(!readyTasks(board).some(t => t.id === rev.id), 'a blocked review is not dispatchable');
	assert.ok(!nextDispatchableTasks(board).some(t => t.id === rev.id));
	assert.ok(!board.tasks.some(t => t.status === 'ready' && t.id === rev.id));
});

test('an unchanged INCOMPLETE receipt is idempotent (no duplicate record, evidence, or revision bump)', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const payload = receipt({ verdict: 'INCOMPLETE', deliveryVersion: deliveryVersionOf(worker), reasons: ['missing_verdict'], raw: 'looks fine' });
	recordReview(board, { ...payload });
	const revision = board.revision;
	const evidenceLength = board.tasks.find(t => t.id === rev.id)!.evidence.length;
	const workerEvidenceLength = worker.evidence.length;

	recordReview(board, { ...payload });
	recordReview(board, { ...payload });

	assert.equal(reviewRecordsOf(board).length, 1, 'the identical receipt is stored once');
	assert.equal(board.revision, revision, 'no mutation at all for an identical receipt');
	assert.equal(board.tasks.find(t => t.id === rev.id)!.evidence.length, evidenceLength);
	assert.equal(worker.evidence.length, workerEvidenceLength);
	assert.equal(board.tasks.find(t => t.id === rev.id)!.status, 'blocked');
});

test('a changed INCOMPLETE receipt is a new attempt but still does not auto-launch', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const version = deliveryVersionOf(worker);
	const firstAttempt = reviewAttemptIdentity(rev)!.attemptId;
	recordReview(board, receipt({ verdict: 'INCOMPLETE', deliveryVersion: version, attemptId: firstAttempt, reasons: ['missing_verdict'], raw: 'attempt 1: no verdict header' }));
	updateTask(board, { id: rev.id, status: 'ready', evidence: ['parent: brief clarified'], reason: 'explicit requeue after fixing the brief' });
	assert.ok(readyTasks(board).some(t => t.id === rev.id), 'an explicit requeue re-arms the reviewer');
	markDispatched(board, rev.id, 'cp', 'rev-run-2');
	assert.ok(observeTask(board, 'rev-run-2', undefined, 'reported'));
	const secondAttempt = reviewAttemptIdentity(rev)!.attemptId;
	assert.notEqual(secondAttempt, firstAttempt, 'the explicit requeue minted a new attempt identity');

	const second = recordReview(board, receipt({
		verdict: 'INCOMPLETE', deliveryVersion: version, attemptId: secondAttempt,
		reviewerRunId: rev.runId, reviewerSessionId: rev.sessionId, reasons: ['unmatched_criteria:AC2'], raw: 'attempt 2: new evidence, AC2 unmatched',
	}));
	assert.equal(second.reviewTask.status, 'blocked');
	const records = reviewRecordsOf(board);
	assert.equal(records.length, 2, 'distinct attempts are both retained');
	assert.equal(records[0].raw, 'attempt 1: no verdict header');
	assert.equal(records[1].raw, 'attempt 2: new evidence, AC2 unmatched');
	assert.equal(records[1].attempt, 2);
	assert.notEqual(reviewReceiptKey(records[0]), reviewReceiptKey(records[1]));
});

test('repeated INCOMPLETE rounds are never capped and never truncate raw/evidence', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const version = deliveryVersionOf(worker);
	const rounds = 25;
	for (let i = 1; i <= rounds; i++) {
		if (i > 1) {
			updateTask(board, { id: rev.id, status: 'ready', evidence: [`parent requeue ${i}`], reason: `round ${i}` });
			markDispatched(board, rev.id, 'cp', `rev-run-${i}`);
			assert.ok(observeTask(board, `rev-run-${i}`, undefined, 'reported'));
		}
		const raw = `attempt ${i}: ${'x'.repeat(2000)}`;
		const attemptId = reviewAttemptIdentity(rev)!.attemptId;
		recordReview(board, receipt({
			verdict: 'INCOMPLETE', deliveryVersion: version, attemptId, reviewerRunId: rev.runId, reviewerSessionId: rev.sessionId,
			reasons: [`round_${i}`], raw,
		}));
		assert.equal(board.tasks.find(t => t.id === rev.id)!.status, 'blocked');
	}
	const records = reviewRecordsOf(board);
	assert.equal(records.length, rounds, 'no round/cost/failure cap drops receipts');
	assert.equal(records.at(-1)!.raw.length, `attempt ${rounds}: ${'x'.repeat(2000)}`.length, 'raw is never truncated');
	assert.equal(records.at(-1)!.attempt, rounds);
	assert.deepEqual(records.map(r => r.attempt), Array.from({ length: rounds }, (_, i) => i + 1));
	const held = board.tasks.find(t => t.id === rev.id)!;
	assert.equal(held.status, 'blocked');
	assert.ok(held.evidence.some(e => e.includes('Verdict: INCOMPLETE')), 'the latest verdict stays on the held task');
	assert.ok(held.evidence.some(e => e.startsWith('[LEASE RELEASED]')));
});

test('pruneStaleReviews never deletes a blocked parent-decision hold', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	recordReview(board, receipt({ verdict: 'INCOMPLETE', deliveryVersion: deliveryVersionOf(worker), reasons: ['missing_verdict'], raw: 'looks fine' }));
	const result = pruneStaleReviews(board);
	assert.equal(result.pruned.length, 0);
	const held = board.tasks.find(t => t.id === rev.id)!;
	assert.equal(held.status, 'blocked');
	assert.ok(held.evidence.some(e => e.includes('Verdict: INCOMPLETE')));
});

// ─────────────────── raw report immutability ───────────────────

test('records are append-only: an earlier attempt object is never replaced in place', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const version = deliveryVersionOf(worker);
	recordReview(board, receipt({ verdict: 'REWORK', deliveryVersion: version, defects: ['first defect'], raw: 'VERDICT: REWORK\nDEFECTS:\n- first defect' }));
	const firstObject = reviewRecordsOf(board)[0];
	const snapshot = structuredClone(firstObject);
	worker.status = 'reported';
	recordReview(board, receipt({ reviewTaskId: rev.id, verdict: 'REWORK', deliveryVersion: version, defects: ['second defect'], raw: 'VERDICT: REWORK\nDEFECTS:\n- second defect' }));
	assert.equal(reviewRecordsOf(board).length, 2);
	assert.deepEqual(reviewRecordsOf(board)[0], snapshot, 'the first attempt record is untouched');
	assert.equal(reviewRecordsOf(board)[0].raw, 'VERDICT: REWORK\nDEFECTS:\n- first defect');
	assert.equal(reviewRecordsOf(board)[1].raw, 'VERDICT: REWORK\nDEFECTS:\n- second defect');
});

// ─────────────────── D1: originating attempt/lease identity decides settlement ───────────────────

const attemptIdOf = (task: WorkTask): string => {
	const identity = reviewAttemptIdentity(task);
	assert.ok(identity, `expected an attempt identity for ${task.id}`);
	return identity!.attemptId;
};

/**
 * Epoch 1 settles INCOMPLETE (a parent hold) and is explicitly requeued; epoch 2 is then dispatched.
 * Both epochs refer to the SAME worker delivery: only attempt/lease identity can tell them apart.
 */
function sameDeliveryRequeuedSlot(): { board: WorkLedger; worker: WorkTask; rev: WorkTask; version: string; epoch1: string; epoch2: string } {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker, 'cp', 'fp-1');
	const version = deliveryVersionOf(worker);
	const epoch1 = attemptIdOf(rev);
	recordReview(board, receipt({
		reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'INCOMPLETE', deliveryVersion: version, attemptId: epoch1,
		reasons: ['missing_verdict'], raw: 'epoch 1: reviewer never produced a verdict',
	}));
	assert.equal(rev.status, 'blocked');
	updateTask(board, { id: rev.id, status: 'ready', evidence: ['parent: brief clarified'], reason: 'explicit requeue after fixing the review brief' });
	const epoch2 = attemptIdOf(rev);
	assert.notEqual(epoch2, epoch1);
	markDispatched(board, rev.id, 'cp', 'rev-run-2');
	assert.equal(rev.status, 'running');
	return { board, worker, rev, version, epoch1, epoch2 };
}

for (const verdict of ['PASS', 'REWORK', 'ESCALATE', 'INCOMPLETE', 'STALE'] as const) {
	for (const workerState of ['reported', 'running', 'uncertain'] as const) {
		test(`D1 old ${verdict} receipt of a requeued attempt never settles the newer owner (worker=${workerState})`, () => {
			const { board, worker, rev, version, epoch1 } = sameDeliveryRequeuedSlot();
			if (workerState !== 'reported') {
				// A NEWER delivery of the same worker is executing while the old receipt arrives.
				worker.status = workerState;
				worker.runId = 'run-newer';
				worker.sessionId = 'sess-newer';
				worker.dispatchedAt = '2026-02-02T00:00:00.000Z';
				worker.retryCount = 1;
				worker.reason = 'newer attempt owns this task';
			}
			const workerOwned = ownershipOf(worker);
			const slotOwned = ownershipOf(rev);
			const revision = board.revision;
			const applied = recordReview(board, receipt({
				reviewTaskId: rev.id, workerTaskId: worker.id, verdict, deliveryVersion: version, attemptId: epoch1,
				raw: `late ${verdict} report from the closed epoch 1`,
			}));
			assert.deepEqual(ownershipOf(worker), workerOwned, 'the worker status/run/session/dispatch/lease is untouched');
			assert.deepEqual(ownershipOf(rev), slotOwned, 'the newer reviewer status/run/session/dispatch/lease is untouched');
			assert.equal(applied.reviewTask.runId, 'rev-run-2');
			assert.equal(board.revision, revision + 1, 'only the discarded receipt is appended');
			const stored = reviewRecordsOf(board).at(-1)!;
			assert.equal(stored.verdict, 'STALE');
			assert.equal(stored.originalVerdict ?? stored.verdict, verdict, 'the raw submitted verdict is preserved');
			assert.equal(stored.discarded, true);
			assert.equal(stored.deliveryVersion, version);
			assert.ok(stored.reasons.some(r => r.startsWith('receipt_for_closed_attempt')), stored.reasons.join(','));
			assert.equal(stored.raw, `late ${verdict} report from the closed epoch 1`);
		});
	}
}

test('D1 an unattributed same-delivery receipt after requeue fails closed instead of guessing the attempt', () => {
	const { board, worker, rev, version } = sameDeliveryRequeuedSlot();
	const before = JSON.stringify(board);
	assert.throws(() => recordReview(board, receipt({
		reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'PASS', deliveryVersion: version, raw: 'unattributed late PASS',
	})), /retains ownership evidence|cannot be attributed to one/);
	assert.equal(JSON.stringify(board), before, 'fail closed must not mutate tasks, evidence, or revision');
	assert.equal(reviewRecordsOf(board).length, 1);
	// The SAME receipt stamped with the current epoch is legitimate and settles the current owner.
	const pass = recordReview(board, receipt({
		reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'PASS', deliveryVersion: version, attemptId: attemptIdOf(rev),
		reviewerRunId: 'rev-run-2', raw: 'current-epoch PASS',
	}));
	assert.equal(pass.workerTask.status, 'done');
	assert.equal(pass.reviewTask.status, 'done');
	assert.equal(reviewRecordsOf(board).length, 2);
});

test('D1 old-delivery receipt after slot reuse is discarded on its archived attempt, never on the new delivery', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const oldVersion = deliveryVersionOf(worker);
	const oldAttempt = attemptIdOf(rev);
	rev.status = 'running';
	rev.runId = 'rev-run-old';
	rev.sessionId = 'rev-sess-old';
	// The worker is re-dispatched while that reviewer runs, so the late receipt is discarded as STALE.
	worker.runId = 'run-2';
	worker.sessionId = 'sess-2';
	worker.retryCount = 1;
	worker.dispatchedAt = '2026-01-02T00:00:00.000Z';
	const lateFirst = recordReview(board, receipt({
		reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'PASS', deliveryVersion: oldVersion, attemptId: oldAttempt,
		reviewerRunId: 'rev-run-old', reviewerSessionId: 'rev-sess-old', raw: 'old delivery PASS',
	}), { deliveryVersion: deliveryVersionOf(worker) });
	assert.equal(lateFirst.reviewTask.status, 'superseded');
	const fresh = createReviewerTask(board, worker);
	const newVersion = deliveryVersionOf(worker);
	assert.notEqual(newVersion, oldVersion);
	assert.equal(fresh.reviewAttemptId === oldAttempt, false);
	const workerOwned = ownershipOf(worker);
	const freshOwned = ownershipOf(fresh);
	const legacyReplay = recordReview(board, receipt({
		reviewTaskId: fresh.id, workerTaskId: worker.id, verdict: 'REWORK', deliveryVersion: oldVersion, raw: 'legacy replay without attemptId',
	}));
	const stampedReplay = recordReview(board, receipt({
		reviewTaskId: fresh.id, workerTaskId: worker.id, verdict: 'ESCALATE', deliveryVersion: oldVersion, attemptId: oldAttempt, raw: 'replay stamped with the archived attempt',
	}));
	assert.deepEqual(ownershipOf(worker), workerOwned);
	assert.deepEqual(ownershipOf(fresh), freshOwned);
	assert.equal(fresh.status, 'ready');
	for (const applied of [legacyReplay, stampedReplay]) {
		const stored = reviewRecordsOf(board).at(-1)!;
		assert.equal(stored.verdict, 'STALE');
		assert.equal(stored.discarded, true);
		assert.equal(stored.deliveryVersion, oldVersion);
		assert.equal(stored.observedDeliveryVersion, newVersion);
	}
	assert.ok(reviewRecordsOf(board).at(-2)!.originalVerdict === 'REWORK');
	assert.ok(reviewRecordsOf(board).at(-1)!.originalVerdict === 'ESCALATE');
});

// ─────────────────── D2: ambiguous legacy ownership fails closed ───────────────────

test('D2 settlement refuses ambiguous legacy duplicate ownership, even when the receipt names one owner', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const template = createReviewerTask(board, worker);
	const legacyA: WorkTask = {
		...structuredClone(template), reviewAttemptId: 'attempt-A', reviewEpoch: 1, status: 'running', runId: 'rev-run-a', sessionId: 'rev-sess-a',
		evidence: ['legacy attempt A verdict lines'],
	};
	const legacyB: WorkTask = {
		...structuredClone(template), reviewAttemptId: 'attempt-B', reviewEpoch: 1, status: 'running', runId: 'rev-run-b', sessionId: 'rev-sess-b',
		evidence: ['legacy attempt B verdict lines'],
	};
	board.tasks = board.tasks.filter(t => t.id !== 'W-rev-1');
	board.tasks.push(legacyA, legacyB);
	board.reviewRecords = [];
	const before = JSON.stringify(board);
	assert.throws(() => recordReview(board, receipt({
		reviewTaskId: 'W-rev-1', workerTaskId: worker.id, verdict: 'PASS', deliveryVersion: deliveryVersionOf(worker), raw: 'ambiguous PASS',
	})), /share the canonical reviewer id/);
	assert.throws(() => recordReview(board, receipt({
		reviewTaskId: 'W-rev-1', workerTaskId: worker.id, verdict: 'PASS', deliveryVersion: deliveryVersionOf(worker), attemptId: 'attempt-B', reviewerRunId: 'rev-run-b', raw: 'receipt names B',
	})), /share the canonical reviewer id/);
	assert.equal(JSON.stringify(board), before, 'no obligation, evidence, status, or revision changes');
	assert.equal(reviewRecordsOf(board).length, 0);
	assert.deepEqual(board.tasks.filter(t => t.id === 'W-rev-1').map(t => t.evidence), [['legacy attempt A verdict lines'], ['legacy attempt B verdict lines']]);
});

// ─────────────────── D3: a live unbound legacy reviewer is never rebound ───────────────────

test('D3 a running legacy reviewer with no originating delivery is preserved and cannot be settled', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	delete rev.reviewedDeliveryVersion;
	rev.status = 'running';
	rev.runId = 'legacy-run';
	rev.sessionId = 'legacy-sess';
	rev.dispatchedAt = '2026-01-01T00:20:00.000Z';
	const again = createReviewerTask(board, worker);
	assert.equal(again, rev, 'the live attempt is reused, never replaced');
	assert.equal(rev.reviewedDeliveryVersion, undefined, 'the missing delivery is not inferred');
	assert.equal(rev.runId, 'legacy-run');
	assert.equal(rev.sessionId, 'legacy-sess');
	assert.equal(rev.evidence.filter(e => e.startsWith('[REVIEW UNBOUND]')).length, 1, 'the parent sees exactly one decision note');
	const owned = ownershipOf(rev);
	assert.deepEqual(ownershipOf(createReviewerTask(board, worker)), owned, 'a refresh tick does not mutate the live lease');
	const before = JSON.stringify(board);
	assert.throws(() => recordReview(board, receipt({
		reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'PASS', deliveryVersion: deliveryVersionOf(worker), raw: 'guessed delivery PASS',
	})), /unbound review attempt/);
	assert.throws(() => recordReview(board, receipt({
		reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'PASS', attemptId: rev.reviewAttemptId, raw: 'stamped but still unbound',
	})), /unbound review attempt/);
	assert.equal(JSON.stringify(board), before, 'no silent rebind and no settlement');
	assert.equal(reviewRecordsOf(board).length, 0);
});

// ─────────────────── D4: full history across repeated reuse ───────────────────

test('D4 all historical evidence survives 3+ slot reuses, including epochs with no receipt, without prefix duplication', () => {
	const { board, worker } = boardWithDeliveredWorker();
	let rev = createReviewerTask(board, worker);
	const notes: string[] = [];
	for (let epoch = 1; epoch <= 4; epoch++) {
		const note = `epoch-${epoch}-unreviewed-evidence:${'z'.repeat(40)}:${epoch}`;
		notes.push(note);
		rev.evidence.push(note);
		if (epoch === 3) {
			recordReview(board, receipt({
				reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'REWORK', deliveryVersion: deliveryVersionOf(worker),
				attemptId: attemptIdOf(rev), reasons: ['style only'], raw: 'epoch3 rework raw report',
			}));
			assert.equal(rev.status, 'superseded');
		} else {
			rev.status = 'superseded';
			rev.reason = `closed legacy epoch ${epoch}`;
		}
		const priorEpoch = rev.reviewEpoch ?? 1;
		rev = createReviewerTask(board, worker);
		assert.equal(rev.reviewEpoch, priorEpoch + 1, 'every recycle mints a new epoch');
		assert.equal(countId(board, 'W-rev-1'), 1, 'the canonical id stays unique through repeated reuse');
	}
	const history = rev.reviewHistory ?? [];
	assert.equal(history.length, 4, 'all four closed epochs are retained');
	for (const note of notes) {
		assert.equal(history.filter(entry => entry.evidence.includes(note)).length, 1, `evidence ${note} survives verbatim in exactly one epoch`);
	}
	const records = reviewRecordsOf(board);
	assert.equal(records.length, 1, 'no receipt is dropped across reuses');
	assert.equal(records[0].raw, 'epoch3 rework raw report');
	assert.equal(rev.evidence.length, 4, 'the live slot carries one lineage line per closed epoch');
	assert.ok(rev.evidence.every(line => line.startsWith('[PRIOR ATTEMPT ')));
	assert.equal(new Set(rev.evidence).size, 4, 'lineage lines are never duplicated');
	for (const entry of history) {
		assert.ok(entry.evidence.every(line => !line.startsWith('[PRIOR ATTEMPT ')), 'history stores full text, never nested lineage');
	}
	const joined = history.map(entry => entry.evidence.join('\n')).join('\n') + '\n' + rev.evidence.join('\n');
	for (const note of notes) assert.equal(joined.split(note).length - 1, 1, `no exponential prefix duplication of ${note}`);
});

// ─────────────────── D5: caller/stored immutability and receipt identity ───────────────────

test('D5 caller input and stored receipts stay immutable; a genuine replay after drift is a no-op', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const version = deliveryVersionOf(worker);
	const payload = receipt({
		reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'PASS', deliveryVersion: version, attemptId: attemptIdOf(rev),
		reasons: ['calm review'], raw: 'VERDICT: PASS\nCRITERION: a passes => PASS | evidence: src/mod.ts:1',
	});
	const callerSnapshot = structuredClone(payload);
	// The worker is re-dispatched while the reviewer runs: the same object is replayed after the drift.
	worker.retryCount = 1;
	const applied = recordReview(board, payload, { deliveryVersion: deliveryVersionOf(worker) });
	assert.deepEqual(payload, callerSnapshot, 'caller input is never mutated');
	assert.equal(payload.verdict, 'PASS');
	assert.equal(applied.workerTask.status, 'reported');
	const stored = reviewRecordsOf(board)[0];
	assert.equal(stored.verdict, 'STALE');
	assert.equal(stored.originalVerdict, 'PASS');
	assert.equal(stored.raw, callerSnapshot.raw);
	const storedSnapshot = structuredClone(stored);
	const revision = board.revision;
	const slotSnapshot = ownershipOf(rev);
	const workerSnapshot = ownershipOf(worker);
	const replay = recordReview(board, payload, { deliveryVersion: deliveryVersionOf(worker) });
	assert.deepEqual(payload, callerSnapshot, 'replay must not mutate the caller object either');
	assert.equal(board.revision, revision, 'a genuine replay does not bump the revision');
	assert.equal(reviewRecordsOf(board).length, 1, 'a genuine replay is deduplicated');
	assert.deepEqual(reviewRecordsOf(board)[0], storedSnapshot, 'the stored receipt is immutable');
	assert.deepEqual(ownershipOf(rev), slotSnapshot);
	assert.deepEqual(ownershipOf(worker), workerSnapshot);
	assert.equal(replay.workerTask.status, 'reported');
});

test('D5 a reused reportId with a different payload fails closed, while an identical payload stays deduplicated', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const version = deliveryVersionOf(worker);
	const first = receipt({
		reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'PASS', deliveryVersion: version, attemptId: attemptIdOf(rev),
		reportId: 'report-1', raw: 'VERDICT: PASS\nCRITERION: a passes => PASS | evidence: src/mod.ts:1',
	});
	recordReview(board, first);
	assert.equal(reviewRecordsOf(board).length, 1);
	const storedSnapshot = structuredClone(reviewRecordsOf(board)[0]);
	const before = JSON.stringify(board);
	assert.throws(() => recordReview(board, receipt({ ...first, raw: 'VERDICT: PASS\nreworded after the fact' })), /already recorded with a different (submitted )?payload/);
	assert.equal(JSON.stringify(board), before, 'a conflicting reused reportId mutates nothing');
	assert.deepEqual(reviewRecordsOf(board)[0], storedSnapshot);
	recordReview(board, structuredClone(first));
	assert.equal(reviewRecordsOf(board).length, 1, 'the identical receipt is a no-op replay');
});

// ─────────────────── R3: completeReviewTask must use captured origin, not the current slot ───────────────────

function dispatchedReviewer() {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker, 'cp', 'fp-1');
	markDispatched(board, rev.id, 'cp', 'rev-run-1');
	const origin = reviewCompletionOrigin(rev)!;
	assert.ok(origin, 'a dispatched attempt has a capturable originating envelope');
	return { board, worker, rev, origin: origin!, version: deliveryVersionOf(worker) };
}

function requeuedSameDeliveryReviewer() {
	const base = dispatchedReviewer();
	const { board, rev } = base;
	updateTask(board, { id: rev.id, status: 'blocked', childStopped: true, evidence: ['parent verified the reviewer child stopped'], reason: 'stop epoch 1 before an explicit requeue' });
	updateTask(board, { id: rev.id, status: 'ready', evidence: ['parent: new review brief'], reason: 'explicit requeue' });
	markDispatched(board, rev.id, 'cp', 'rev-run-2');
	return base;
}

function requeuedNewDeliveryReviewer() {
	const base = dispatchedReviewer();
	const { board, worker, rev } = base;
	updateTask(board, { id: rev.id, status: 'blocked', childStopped: true, evidence: ['parent verified the reviewer child stopped'], reason: 'stop the old-delivery reviewer' });
	// Explicitly requeue the closed epoch so its lease is archived before the worker delivery changes.
	updateTask(board, { id: rev.id, status: 'ready', evidence: ['parent: archive the closed epoch'], reason: 'requeue before rebinding the new delivery' });
	worker.runId = 'run-2';
	worker.sessionId = 'sess-2';
	worker.retryCount = 1;
	worker.dispatchedAt = '2026-01-02T00:00:00.000Z';
	const fresh = createReviewerTask(board, worker);
	markDispatched(board, fresh.id, 'cp', 'rev-run-2');
	return { ...base, rev: fresh };
}

for (const verdict of ['PASS', 'REWORK', 'FAIL'] as const) {
	for (const liveState of ['running', 'uncertain'] as const) {
		for (const mode of ['same-delivery', 'redelivery'] as const) {
			test(`R3 completeReviewTask old ${verdict} from the originating attempt never settles a newer ${liveState} owner (${mode})`, () => {
				const setup = mode === 'same-delivery' ? requeuedSameDeliveryReviewer() : requeuedNewDeliveryReviewer();
				const { board, worker, rev, origin } = setup;
				rev.status = liveState;
				rev.reason = `newer ${liveState} attempt owns the review`;
				const workerOwned = ownershipOf(worker);
				const slotOwned = ownershipOf(rev);
				const revision = board.revision;
				const out = completeReviewTask(board, rev.id, verdict, [`old ${verdict} evidence`], origin);
				assert.equal(out.workerTask.status, workerOwned.status, 'the newer worker owner is untouched');
				assert.deepEqual(ownershipOf(worker), workerOwned, 'worker status/run/session/lease/evidence is untouched');
				assert.deepEqual(ownershipOf(rev), slotOwned, 'the newer reviewer status/run/session/lease/evidence is untouched');
				assert.equal(board.revision, revision + 1, 'only the discarded originating receipt is appended');
				const stored = reviewRecordsOf(board).at(-1)!;
				assert.equal(stored.verdict, 'STALE');
				assert.equal(stored.discarded, true);
				assert.equal(stored.attemptId, origin.attemptId, 'the receipt keeps its captured originating attempt identity');
				assert.equal(stored.resolvedAttemptId, origin.attemptId);
				assert.equal(stored.deliveryVersion, origin.deliveryVersion);
				assert.ok(stored.reasons.some(r => r.startsWith('receipt_for_closed_attempt')), stored.reasons.join(','));
			});
		}
	}
}

test('R3 completeReviewTask without a captured origin fails closed on requeued/reused/live attempts', () => {
	const cases: Array<[string, () => { board: WorkLedger; rev: WorkTask }, RegExp]> = [
		['same-delivery requeue', () => { const s = requeuedSameDeliveryReviewer(); return { board: s.board, rev: s.rev }; }, /legacy-safe boundary/],
		['new-delivery slot reuse', () => { const s = requeuedNewDeliveryReviewer(); return { board: s.board, rev: s.rev }; }, /legacy-safe boundary/],
		['live first epoch', () => { const s = dispatchedReviewer(); return { board: s.board, rev: s.rev }; }, /legacy-safe boundary/],
		['stale delivery pin', () => {
			const { board, worker } = boardWithDeliveredWorker();
			const rev = createReviewerTask(board, worker);
			worker.runId = 'run-2'; worker.sessionId = 'sess-2'; worker.retryCount = 1; worker.dispatchedAt = '2026-01-03T00:00:00.000Z';
			return { board, rev };
		}, /legacy-safe boundary/],
	];
	for (const [label, make, pattern] of cases) {
		const { board, rev } = make();
		const before = JSON.stringify(board);
		assert.throws(() => completeReviewTask(board, rev.id, 'PASS', ['legacy PASS']), pattern, label);
		assert.equal(JSON.stringify(board), before, `${label}: fail closed mutates nothing`);
	}
});

test('R3 completeReviewTask with the captured CURRENT origin settles normally (positive control)', () => {
	const { board, worker, rev, origin } = dispatchedReviewer();
	assert.ok(observeTask(board, 'rev-run-1', undefined, 'reported'));
	const out = completeReviewTask(board, rev.id, 'PASS', ['captured current origin verified'], origin);
	assert.equal(out.workerTask.status, 'done');
	assert.equal(out.reviewTask.status, 'done');
	const stored = reviewRecordsOf(board).at(-1)!;
	assert.equal(stored.verdict, 'PASS');
	assert.notEqual(stored.discarded, true);
	assert.equal(stored.attemptId, origin.attemptId);
	assert.equal(stored.resolvedAttemptId, origin.attemptId);
});

test('R3 completeReviewTask FAIL maps to REWORK for the captured current origin', () => {
	const { board, worker, rev, origin } = dispatchedReviewer();
	assert.ok(observeTask(board, 'rev-run-1', undefined, 'reported'));
	const retryBefore = worker.retryCount || 0;
	const out = completeReviewTask(board, rev.id, 'FAIL', ['missing boundary'], origin);
	assert.equal(out.workerTask.status, 'ready');
	assert.equal(worker.retryCount, retryBefore + 1);
	assert.equal(out.reviewTask.status, 'superseded');
	assert.equal(reviewRecordsOf(board).at(-1)!.verdict, 'REWORK');
});

test('R3 completeReviewTask four-argument legacy boundary settles only a single non-executing first epoch without inventing identity', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const out = completeReviewTask(board, rev.id, 'PASS', ['legacy pass without origin']);
	assert.equal(out.workerTask.status, 'done');
	const stored = reviewRecordsOf(board)[0];
	assert.equal(stored.verdict, 'PASS');
	assert.notEqual(stored.discarded, true);
	assert.equal(stored.attemptId, undefined, 'the legacy boundary never manufactures a caller attempt identity');
	assert.equal(stored.resolvedAttemptId, rev.reviewAttemptId, 'the ledger itself attributes the single existing epoch');
});

// ─────────────────── R3: hasValidReview unattributed legacy fallback ───────────────────

for (const live of ['running', 'uncertain'] as const) {
	test(`R3 hasValidReview rejects an unattributed legacy PASS while the reused slot has a live ${live} epoch`, () => {
		const { board, worker } = boardWithDeliveredWorker();
		const slot = createReviewerTask(board, worker);
		const version = deliveryVersionOf(worker);
		slot.reviewHistory = [{ attemptId: 'legacy-epoch-1', epoch: 1, status: 'superseded', deliveryVersion: 'W-1|run-old||other|0', reviewerRole: 'cp', closedAt: '2026-01-01T00:00:00.000Z', evidence: ['epoch 1 evidence'] }];
		slot.reviewEpoch = 2;
		slot.reviewAttemptId = 'legacy-epoch-2';
		slot.reviewedDeliveryVersion = version;
		slot.status = live;
		slot.runId = 'rev-new-run';
		slot.sessionId = 'rev-new-sess';
		board.reviewRecords.push(receipt({
			workerTaskId: worker.id, reviewTaskId: slot.id, verdict: 'PASS', deliveryVersion: version,
			observedDeliveryVersion: version, raw: 'legacy PASS without attribution', createdAt: '2026-01-02T00:00:00.000Z',
		}));
		assert.equal(hasValidReview(board, worker), false, 'reuse history plus live ownership defeats unique attribution');
	});
}

test('R3 hasValidReview rejects an unattributed legacy PASS when the reviewer slot is unknown', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const version = deliveryVersionOf(worker);
	board.reviewRecords.push(receipt({
		workerTaskId: worker.id, reviewTaskId: 'W-rev-1', verdict: 'PASS', deliveryVersion: version,
		observedDeliveryVersion: version, raw: 'orphan legacy PASS',
	}));
	assert.equal(hasValidReview(board, worker), false, 'unknown epoch cannot be attributed');
});

test('R3 hasValidReview accepts an explicit safe first-epoch legacy PASS and an attributed current PASS', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const version = deliveryVersionOf(worker);
	rev.status = 'done';
	rev.archivedAt = '2026-01-01T00:00:00.000Z';
	board.reviewRecords.push(receipt({
		workerTaskId: worker.id, reviewTaskId: rev.id, verdict: 'PASS', deliveryVersion: version,
		observedDeliveryVersion: version, raw: 'safe legacy PASS', createdAt: '2026-01-01T00:00:00.000Z',
	}));
	assert.equal(hasValidReview(board, worker), true, 'single non-executing first epoch is the documented legacy boundary');

	const freshBoard = boardWithDeliveredWorker().board;
	const freshWorker = freshBoard.tasks[0];
	const freshRev = createReviewerTask(freshBoard, freshWorker);
	freshWorker.status = 'reported';
	recordReview(freshBoard, receipt({
		reviewTaskId: freshRev.id, workerTaskId: freshWorker.id, verdict: 'PASS',
		deliveryVersion: deliveryVersionOf(freshWorker), attemptId: attemptIdOf(freshRev), raw: 'attributed current PASS',
	}));
	assert.equal(hasValidReview(freshBoard, freshWorker), true, 'an attributed PASS for the current epoch stays valid');
});

test('R3 hasValidReview rejects an attributed PASS after the slot was recycled to a new epoch', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	recordReview(board, receipt({
		reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'PASS',
		deliveryVersion: deliveryVersionOf(worker), attemptId: attemptIdOf(rev), raw: 'epoch 1 PASS',
	}));
	assert.equal(hasValidReview(board, worker), true);
	const recycled = createReviewerTask(board, worker);
	assert.notEqual(recycled.reviewAttemptId, rev.reviewAttemptId);
	assert.equal(hasValidReview(board, worker), false, 'a PASS for the closed epoch never unlocks the new one');
});

// ─────────────────── R3: complete submitted-payload equality for replay/reportId ───────────────────

function richReviewSetup() {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker, 'cp', 'fp-1');
	markDispatched(board, rev.id, 'cp', 'rev-run-1');
	rev.sessionId = 'rev-sess-1';
	return { board, worker, rev, version: deliveryVersionOf(worker), attemptId: attemptIdOf(rev) };
}

const richPayload = (env: ReturnType<typeof richReviewSetup>, over: Partial<ReviewRecord> = {}): ReviewRecord => receipt({
	reviewTaskId: env.rev.id, workerTaskId: env.worker.id, verdict: 'PASS', deliveryVersion: env.version,
	attemptId: env.attemptId, reportId: 'report-r3',
	checks: [{ criterion: 'AC1. a passes', status: 'pass', evidence: 'src/mod.ts:1' }],
	reasons: ['citation verified on disk'], parsed: true,
	evidenceAudit: { verified: ['src/mod.ts:1'], failed: [], unverifiable: [], ok: true },
	reviewerRunId: 'rev-run-1', reviewerSessionId: 'rev-sess-1', reviewerRole: 'cp',
	evid: undefined,
	raw: 'VERDICT: PASS\nCRITERION: AC1. a passes => PASS | evidence: src/mod.ts:1',
	createdAt: '2026-03-01T00:00:00.000Z',
	...over,
} as ReviewRecord);

test('R3 every changed submitted field under the same reportId raises a recoverable conflict and never mutates the ledger', () => {
	const env = richReviewSetup();
	const base = richPayload(env);
	recordReview(env.board, base);
	const stored = structuredClone(reviewRecordsOf(env.board)[0]);
	const before = JSON.stringify(env.board);
	const variants: Array<[string, ReviewRecord]> = [
		['check status', { ...base, checks: [{ criterion: 'AC1. a passes', status: 'fail', evidence: 'src/mod.ts:1' }] }],
		['check evidence', { ...base, checks: [{ criterion: 'AC1. a passes', status: 'pass', evidence: 'src/other.ts:9' }] }],
		['check criterion', { ...base, checks: [{ criterion: 'AC2. b passes', status: 'pass', evidence: 'src/mod.ts:1' }] }],
		['reasons', { ...base, reasons: ['a different reason'] }],
		['defects', { ...base, defects: ['new defect'] }],
		['nextActions', { ...base, nextActions: ['do more'] }],
		['evidenceAudit', { ...base, evidenceAudit: { verified: [], failed: ['src/mod.ts:1'], unverifiable: [], ok: false } }],
		['parsed', { ...base, parsed: false }],
		['reviewerRole', { ...base, reviewerRole: 'ayton' }],
		['createdAt', { ...base, createdAt: '2026-03-02T00:00:00.000Z' }],
		['raw', { ...base, raw: 'VERDICT: PASS\ndifferent raw' }],
	];
	for (const [label, variant] of variants) {
		assert.throws(() => recordReview(env.board, variant), (err: unknown) => {
			assert.ok(err instanceof ReviewReceiptConflictError, `${label}: explicit conflict error`);
			assert.deepEqual(err.rejected, variant, `${label}: the rejected envelope is retained verbatim`);
			assert.deepEqual(err.existing, stored, `${label}: the stored receipt is retained`);
			return true;
		}, label);
		assert.equal(JSON.stringify(env.board), before, `${label}: conflict mutates nothing`);
	}
	assert.equal(reviewRecordsOf(env.board).length, 1);
	// Changing a supplied ownership identity is not a free payload edit: it is a contradiction and fails closed
	// with the full envelope retained, even under the same reportId.
	const ownershipBefore = JSON.stringify(env.board);
	for (const [label, variant] of [
		['run ownership', { ...base, reviewerRunId: 'rev-run-2' }],
		['session ownership', { ...base, reviewerSessionId: 'rev-sess-2' }],
	] as Array<[string, ReviewRecord]>) {
		assert.throws(() => recordReview(env.board, variant), (err: unknown) => {
			assert.ok(err instanceof ReviewReceiptConflictError || err instanceof ReviewReceiptOriginError, `${label}: ownership contradiction is recoverable, never applied`);
			assert.deepEqual(err.rejected, variant, `${label}: full rejected envelope retained`);
			return true;
		}, label);
		assert.equal(JSON.stringify(env.board), ownershipBefore, `${label}: zero mutation`);
	}
	assert.equal(reviewRecordsOf(env.board).length, 1);
});

test('R3 changed submitted fields without a reportId stay distinct preserved receipts (no silent dedup)', () => {
	const env = richReviewSetup();
	const base = richPayload(env, {});
	delete base.reportId;
	recordReview(env.board, base);
	const ownershipBeforeDistinct = JSON.stringify(env.board);
	for (const [label, variant] of [
		['run ownership', { ...base, reviewerRunId: 'rev-run-2' }],
		['session ownership', { ...base, reviewerSessionId: 'rev-sess-2' }],
	] as Array<[string, ReviewRecord]>) {
		assert.throws(() => recordReview(env.board, variant), ReviewReceiptOriginError, `${label}: a contradictory owner never appends a receipt`);
		assert.equal(JSON.stringify(env.board), ownershipBeforeDistinct, `${label}: zero mutation`);
	}
	assert.equal(reviewRecordsOf(env.board).length, 1);
	const variants: Array<[string, ReviewRecord]> = [
		['check status', { ...base, checks: [{ criterion: 'AC1. a passes', status: 'fail', evidence: 'src/mod.ts:1' }] }],
		['check evidence', { ...base, checks: [{ criterion: 'AC1. a passes', status: 'pass', evidence: 'src/other.ts:9' }] }],
		['reasons', { ...base, reasons: ['a different reason'] }],
		['defects', { ...base, defects: ['new defect'] }],
		['evidenceAudit', { ...base, evidenceAudit: { verified: [], failed: ['src/mod.ts:1'], unverifiable: [], ok: false } }],
		['reviewerRole', { ...base, reviewerRole: 'ayton' }],
		['parsed', { ...base, parsed: false }],
		['raw', { ...base, raw: 'VERDICT: PASS\ndifferent raw' }],
	];
	let expected = 1;
	for (const [label, variant] of variants) {
		recordReview(env.board, variant);
		expected++;
		assert.equal(reviewRecordsOf(env.board).length, expected, `${label}: distinct payload is preserved, never deduplicated`);
		assert.ok(reviewRecordsOf(env.board).at(-1)!.submittedKey, `${label}: the stored receipt keeps its submitted digest`);
	}
	const records = reviewRecordsOf(env.board);
	assert.ok(records.some(r => r.checks[0]?.status === 'fail'));
	assert.ok(records.some(r => r.checks[0]?.evidence === 'src/other.ts:9'));
	assert.ok(records.some(r => r.reasons.includes('a different reason')));
	assert.ok(records.some(r => r.defects.includes('new defect')));
	assert.ok(records.some(r => r.evidenceAudit?.ok === false));
	assert.ok(records.some(r => r.reviewerRole === 'ayton'));
	assert.ok(records.some(r => r.parsed === false));
	assert.ok(records.some(r => r.raw.includes('different raw')));
});

test('R3 a genuine deep-clone replay remains idempotent after normalization and after drift', () => {
	const env = richReviewSetup();
	const base = richPayload(env);
	recordReview(env.board, base);
	const snapshot = structuredClone(reviewRecordsOf(env.board));
	const revision = env.board.revision;
	recordReview(env.board, structuredClone(base));
	assert.equal(env.board.revision, revision, 'identical clone replay is a no-op');
	assert.deepEqual(reviewRecordsOf(env.board), snapshot);

	const driftEnv = richReviewSetup();
	const driftBase = richPayload(driftEnv, { reportId: 'report-r3-drift' });
	driftEnv.worker.retryCount = 1;
	recordReview(driftEnv.board, driftBase, { deliveryVersion: deliveryVersionOf(driftEnv.worker) });
	const drifted = reviewRecordsOf(driftEnv.board)[0];
	assert.equal(drifted.verdict, 'STALE');
	assert.equal(drifted.originalVerdict, 'PASS');
	const driftSnapshot = structuredClone(drifted);
	const driftRevision = driftEnv.board.revision;
	recordReview(driftEnv.board, structuredClone(driftBase), { deliveryVersion: deliveryVersionOf(driftEnv.worker) });
	assert.equal(driftEnv.board.revision, driftRevision);
	assert.equal(reviewRecordsOf(driftEnv.board).length, 1);
	assert.deepEqual(reviewRecordsOf(driftEnv.board)[0], driftSnapshot);
});

// ─────────────────── R4 class1: complete origin must prove the current/closed owner ───────────────────

test('R4 current-attempt PASS/REWORK/FAIL with a contradictory run or session never settles RUNNING/UNCERTAIN', () => {
	for (const liveState of ['running', 'uncertain'] as const) {
		for (const verdict of ['PASS', 'REWORK', 'FAIL'] as const) {
			for (const mode of ['run', 'session'] as const) {
				const { board, rev, origin } = dispatchedReviewer();
				rev.status = liveState;
				rev.sessionId = 'rev-sess-1';
				const fullOrigin = reviewCompletionOrigin(rev)!;
				const badOrigin = mode === 'run'
					? { ...fullOrigin, reviewerRunId: 'rev-run-foreign' }
					: { ...fullOrigin, reviewerSessionId: 'rev-sess-foreign' };
				const before = JSON.stringify(board);
				const records = reviewRecordsOf(board).length;
				assert.throws(() => completeReviewTask(board, rev.id, verdict, ['old origin'], badOrigin), (err: unknown) => {
					assert.ok(err instanceof ReviewReceiptOriginError, `${liveState}/${verdict}/${mode}: recoverable origin error`);
					assert.equal(err.rejected.attemptId, fullOrigin.attemptId, 'full submitted origin is retained');
					return true;
				});
				assert.equal(JSON.stringify(board), before, `${liveState}/${verdict}/${mode}: completeReviewTask fail closed mutates nothing`);

				// The same contradiction through direct recordReview must fail identically.
				assert.throws(() => recordReview(board, receipt({
					reviewTaskId: rev.id, workerTaskId: 'W-1', verdict, deliveryVersion: fullOrigin.deliveryVersion,
					attemptId: fullOrigin.attemptId, reviewerRunId: badOrigin.reviewerRunId, reviewerSessionId: badOrigin.reviewerSessionId,
					raw: `bad ${mode} ${verdict}`,
				})), ReviewReceiptOriginError);
				assert.equal(JSON.stringify(board), before, `${liveState}/${verdict}/${mode}: direct record fail closed mutates nothing`);
				assert.equal(reviewRecordsOf(board).length, records);
			}
		}
	}
});

test('R4 a supplied origin carrying only deliveryVersion never bypasses the required attempt pin on a live owner', () => {
	for (const liveState of ['running', 'uncertain'] as const) {
		for (const verdict of ['PASS', 'REWORK', 'FAIL'] as const) {
			const { board, rev } = dispatchedReviewer();
			rev.status = liveState;
			rev.sessionId = 'rev-sess-1';
			const partial = { deliveryVersion: rev.reviewedDeliveryVersion } as unknown as ReturnType<typeof reviewCompletionOrigin>;
			const before = JSON.stringify(board);
			assert.throws(() => completeReviewTask(board, rev.id, verdict, ['partial origin'], partial), ReviewReceiptOriginError);
			assert.equal(JSON.stringify(board), before, `${liveState}/${verdict}: partial origin settled nothing`);
			assert.equal(reviewRecordsOf(board).length, 0, 'no receipt is invented from a partial origin');
		}
	}
});

test('R4 four-argument legacy completion rejects a first-epoch READY slot that still has unknown run ownership', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	rev.runId = 'unknown-run';
	rev.status = 'ready';
	const before = JSON.stringify(board);
	assert.throws(() => completeReviewTask(board, rev.id, 'PASS', ['legacy READY with unknown run']), ReviewReceiptOriginError);
	assert.equal(JSON.stringify(board), before, 'unknown residual ownership fails closed, no DONE settlement');
	assert.equal(worker.status, 'reported');
	assert.equal(reviewRecordsOf(board).length, 0);
});

test('R4 malformed/partial/foreign origins fail closed and retain the complete rejected payload', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const version = deliveryVersionOf(worker);
	const attempt = attemptIdOf(rev);
	rev.status = 'running';
	rev.runId = 'rev-run-1';
	rev.sessionId = 'rev-sess-1';
	const cases: Array<[string, ReviewRecord]> = [
		['attempt without delivery pin', receipt({ reviewTaskId: rev.id, verdict: 'PASS', attemptId: attempt, reviewerRunId: 'rev-run-1', raw: 'no pin' })],
		['unknown run identity', receipt({ reviewTaskId: rev.id, verdict: 'PASS', deliveryVersion: version, reviewerRunId: 'ghost-run', reviewerSessionId: 'rev-sess-1', raw: 'ghost run' })],
		['unknown session identity', receipt({ reviewTaskId: rev.id, verdict: 'PASS', deliveryVersion: version, reviewerRunId: 'rev-run-1', reviewerSessionId: 'ghost-sess', raw: 'ghost session' })],
		['unknown attempt identity', receipt({ reviewTaskId: rev.id, verdict: 'PASS', deliveryVersion: version, attemptId: 'ghost-attempt', raw: 'ghost attempt' })],
		['contradictory delivery for the current attempt', receipt({ reviewTaskId: rev.id, verdict: 'PASS', deliveryVersion: 'W-1|run-x||x|0', attemptId: attempt, reviewerRunId: 'rev-run-1', raw: 'bad pin' })],
	];
	for (const [label, payload] of cases) {
		const before = JSON.stringify(board);
		assert.throws(() => recordReview(board, payload), (err: unknown) => {
			assert.ok(err instanceof ReviewReceiptOriginError, `${label}: recoverable origin error`);
			assert.deepEqual(err.rejected, payload, `${label}: complete submitted payload retained verbatim`);
			return true;
		}, label);
		assert.equal(JSON.stringify(board), before, `${label}: zero mutation, no newer owner released`);
	}
	assert.equal(reviewRecordsOf(board).length, 0);
});

test('R4 a fully captured CURRENT origin (attempt + delivery + run + session) settles normally', () => {
	const { board, worker, rev } = dispatchedReviewer();
	rev.sessionId = 'rev-sess-1';
	const origin = reviewCompletionOrigin(rev)!;
	assert.ok(observeTask(board, 'rev-run-1', 'rev-sess-1', 'reported'));
	const out = completeReviewTask(board, rev.id, 'PASS', ['captured current full lease'], origin);
	assert.equal(out.workerTask.status, 'done');
	assert.equal(out.reviewTask.status, 'done');
	const stored = reviewRecordsOf(board).at(-1)!;
	assert.equal(stored.attemptId, origin.attemptId);
	assert.equal(stored.reviewerRunId, 'rev-run-1');
	assert.equal(stored.reviewerSessionId, 'rev-sess-1');
	assert.equal(stored.verdict, 'PASS');
});

// ─────────────────── R4 class2: hasValidReview enumerates every owner ───────────────────

test('R4 hasValidReview rejects an unattributed PASS when the reviewer delivery pin is missing', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	delete rev.reviewedDeliveryVersion;
	const version = deliveryVersionOf(worker);
	board.reviewRecords.push(receipt({ workerTaskId: worker.id, reviewTaskId: rev.id, verdict: 'PASS', deliveryVersion: version, observedDeliveryVersion: version, raw: 'pinless PASS' }));
	assert.equal(hasValidReview(board, worker), false, 'a missing originating pin never authorises the gate');
});

test('R4 hasValidReview refuses duplicate canonical owners even when the first is DONE and the second is UNCERTAIN with a new lease', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const template = createReviewerTask(board, worker);
	const version = deliveryVersionOf(worker);
	const first: WorkTask = { ...structuredClone(template), status: 'done', runId: 'old-run', reviewAttemptId: 'attempt-old', reviewEpoch: 1 };
	const second: WorkTask = { ...structuredClone(template), status: 'uncertain', runId: 'new-run', sessionId: 'new-sess', reviewAttemptId: 'attempt-new', reviewEpoch: 2 };
	board.tasks = board.tasks.filter(t => t.id !== 'W-rev-1');
	board.tasks.push(first, second);
	board.reviewRecords.push(receipt({
		workerTaskId: worker.id, reviewTaskId: 'W-rev-1', verdict: 'PASS', deliveryVersion: version, observedDeliveryVersion: version,
		attemptId: 'attempt-old', reviewerRunId: 'old-run', raw: 'PASS from the first duplicate owner',
	}));
	assert.equal(hasValidReview(board, worker), false, 'two owners on the canonical id never authorise either gate');
});

test('R4 hasValidReview rejects an attributed PASS that does not cover a READY slot unknown run/session ownership', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const version = deliveryVersionOf(worker);
	rev.status = 'ready';
	rev.runId = 'unknown-run';
	rev.sessionId = 'unknown-sess';
	board.reviewRecords.push(receipt({
		workerTaskId: worker.id, reviewTaskId: rev.id, verdict: 'PASS', deliveryVersion: version, observedDeliveryVersion: version,
		attemptId: rev.reviewAttemptId, reviewerRunId: 'ghost-run', reviewerSessionId: 'ghost-sess', raw: 'foreign lease PASS',
	}));
	assert.equal(hasValidReview(board, worker), false, 'foreign lease identities never authorise');
	board.reviewRecords.push(receipt({
		workerTaskId: worker.id, reviewTaskId: rev.id, verdict: 'PASS', deliveryVersion: version, observedDeliveryVersion: version,
		attemptId: rev.reviewAttemptId, raw: 'unattributed lease PASS',
	}));
	assert.equal(hasValidReview(board, worker), false, 'a receipt covering none of the retained ownership never authorises');
});

test('R4 hasValidReview accepts only a current attributed PASS whose run/session fully match the slot', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const version = deliveryVersionOf(worker);
	rev.status = 'ready';
	rev.runId = 'rev-run-1';
	rev.sessionId = 'rev-sess-1';
	board.reviewRecords.push(receipt({
		workerTaskId: worker.id, reviewTaskId: rev.id, verdict: 'PASS', deliveryVersion: version, observedDeliveryVersion: version,
		attemptId: rev.reviewAttemptId, reviewerRunId: 'rev-run-1', reviewerSessionId: 'rev-sess-1', raw: 'fully attributed PASS',
	}));
	assert.equal(hasValidReview(board, worker), true, 'a fully covered current attribution is the positive control');
	board.reviewRecords.at(-1)!.reviewerSessionId = 'rev-sess-2';
	assert.equal(hasValidReview(board, worker), false, 'a partial/foreign session reverts the gate');
});

// ─────────────────── R4 class3: full recursive submitted-payload identity ───────────────────

const unknownPayload = (env: ReturnType<typeof richReviewSetup>, over: Partial<ReviewRecord> = {}) => ({
	...richPayload(env, over),
	futureRoot: { tag: 'root-v1', nested: { list: [1, 2], deep: { ok: true } } },
	checks: [{
		criterion: 'AC1. a passes', status: 'pass', evidence: 'src/mod.ts:1',
		futureCheck: { tag: 'check-v1', nested: { arr: ['a', 'b'] } },
	}],
	evidenceAudit: {
		verified: ['src/mod.ts:1'], failed: [], unverifiable: [], ok: true,
		futureAudit: { tag: 'audit-v1', deeper: { levels: [3, 4, 5] } },
	},
	...over,
} as unknown as ReviewRecord);

test('R4 unknown future fields at root/check/audit/deeper levels are retained and drive reportId conflicts', () => {
	const env = richReviewSetup();
	const base = unknownPayload(env, { reportId: 'r4-future-1' });
	recordReview(env.board, base);
	const stored = structuredClone(reviewRecordsOf(env.board)[0]);
	const revision = env.board.revision;
	recordReview(env.board, structuredClone(base));
	assert.equal(env.board.revision, revision, 'a genuine deep clone of an extended payload is a no-op replay');
	assert.equal(reviewRecordsOf(env.board).length, 1);
	assert.deepEqual((reviewRecordsOf(env.board)[0] as any).futureRoot, (base as any).futureRoot);
	assert.deepEqual((reviewRecordsOf(env.board)[0] as any).checks[0].futureCheck, (base as any).checks[0].futureCheck);
	assert.deepEqual((reviewRecordsOf(env.board)[0] as any).evidenceAudit.futureAudit, (base as any).evidenceAudit.futureAudit);

	const variants: Array<[string, ReviewRecord]> = [];
	const deeper = structuredClone(base) as any;
	deeper.futureRoot.nested.deep.ok = false;
	variants.push(['root nested unknown field', deeper]);
	const check = structuredClone(base) as any;
	check.checks[0].futureCheck.nested.arr = ['b', 'a'];
	variants.push(['check nested array order', check]);
	const audit = structuredClone(base) as any;
	audit.evidenceAudit.futureAudit.deeper.levels = [3, 4, 5, 6];
	variants.push(['audit deeper levels', audit]);

	const before = JSON.stringify(env.board);
	for (const [label, variant] of variants) {
		assert.throws(() => recordReview(env.board, variant), (err: unknown) => {
			assert.ok(err instanceof ReviewReceiptConflictError, `${label}: explicit conflict`);
			assert.deepEqual(err.rejected, variant, `${label}: full rejected payload retained, including unknown fields`);
			assert.deepEqual(err.existing, stored, `${label}: immutable stored receipt retained`);
			return true;
		}, label);
		assert.equal(JSON.stringify(env.board), before, `${label}: conflict mutates nothing`);
	}
});

test('R4 without reportId every changed unknown/future structure is a distinct full receipt, never silently dropped', () => {
	const env = richReviewSetup();
	const base = unknownPayload(env, {});
	delete base.reportId;
	recordReview(env.board, base);
	const variants: Array<[string, ReviewRecord]> = [];
	const root = structuredClone(base) as any;
	root.futureRoot.tag = 'root-v2';
	variants.push(['root extra changed', root]);
	const check = structuredClone(base) as any;
	check.checks[0].futureCheck.tag = 'check-v2';
	variants.push(['check extra changed', check]);
	const audit = structuredClone(base) as any;
	audit.evidenceAudit.futureAudit.deeper.levels.reverse();
	variants.push(['audit deeper array order', audit]);
	const revision = env.board.revision;
	for (const [label, variant] of variants) {
		recordReview(env.board, variant);
		assert.ok(env.board.revision > revision, `${label}: a distinct receipt is a real mutation`);
		const stored = reviewRecordsOf(env.board).at(-1) as any;
		assert.deepEqual(stored.futureRoot, (variant as any).futureRoot, `${label}: root unknown structure retained`);
		assert.deepEqual(stored.checks[0].futureCheck, (variant as any).checks[0].futureCheck, `${label}: check unknown structure retained`);
		assert.deepEqual(stored.evidenceAudit.futureAudit, (variant as any).evidenceAudit.futureAudit, `${label}: audit unknown structure retained`);
		assert.ok(stored.submittedKey, `${label}: stored digest exists`);
	}
	assert.equal(reviewRecordsOf(env.board).length, 1 + variants.length, 'nothing is silently deduplicated or dropped');
	const revisionBeforeReplay = env.board.revision;
	recordReview(env.board, structuredClone(variants[0][1]));
	assert.equal(env.board.revision, revisionBeforeReplay, 'deep clone replay stays idempotent');
});

test('R4 caller-derived originalVerdict/discarded/digest/spoofed lease cannot override the actual submitted verdict or bypass conflict', () => {
	const env = richReviewSetup();
	const first = richPayload(env, { verdict: 'REWORK', reportId: 'r4-spoof-1', raw: 'VERDICT: REWORK' });
	recordReview(env.board, first);
	const stored = structuredClone(reviewRecordsOf(env.board)[0]);
	assert.equal(stored.originalVerdict, undefined, 'the caller supplied no originalVerdict and the ledger did not invent one');
	const revision = env.board.revision;
	const spoofedReplay = {
		...structuredClone(first),
		originalVerdict: 'PASS' as const, discarded: true, submittedKey: 'caller-forged-digest',
		observedDeliveryVersion: 'caller-forged-observed', attempt: 99, resolvedAttemptId: 'caller-forged-attempt',
	} as unknown as ReviewRecord;
	recordReview(env.board, spoofedReplay);
	assert.equal(env.board.revision, revision, 'derived metadata is stripped for key processing; an otherwise identical receipt is a no-op');
	assert.deepEqual(reviewRecordsOf(env.board)[0], stored, 'stored ledger-derived metadata is immutable and never caller-overwritten');

	const spoofedPass = {
		...structuredClone(first), verdict: 'PASS' as const, originalVerdict: 'REWORK', discarded: false,
		submittedKey: stored.submittedKey, raw: 'VERDICT: PASS',
	} as unknown as ReviewRecord;
	const before = JSON.stringify(env.board);
	assert.throws(() => recordReview(env.board, spoofedPass), (err: unknown) => {
		assert.ok(err instanceof ReviewReceiptConflictError, 'a spoofed digest cannot make a different verdict appear identical');
		assert.equal((err.rejected as any).originalVerdict, 'REWORK', 'the full caller payload is retained in .rejected');
		assert.equal(err.rejected.verdict, 'PASS', 'the actual submitted verdict is never overridden by originalVerdict');
		assert.deepEqual(err.existing, stored);
		return true;
	});
	assert.equal(JSON.stringify(env.board), before, 'the rejected spoof mutates nothing');
});

// ─────────────────── R5: ownership and settlement holes found by fresh CP review ───────────────────

test('R5 a bogus review id never settles a worker or auto-creates a reviewer', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const version = deliveryVersionOf(worker);
	const before = JSON.stringify(board);
	const rejected = receipt({ reviewTaskId: 'missing-review', workerTaskId: worker.id, deliveryVersion: version, raw: 'VERDICT: PASS from nowhere' });
	assert.throws(() => recordReview(board, rejected), (err: unknown) => {
		assert.ok(err instanceof ReviewReceiptOriginError);
		assert.equal(err.rejected.raw, rejected.raw, 'the full rejected report is retained');
		return true;
	});
	assert.equal(JSON.stringify(board), before, 'no reviewer, worker status, evidence, or revision changed');
	assert.equal(reviewRecordsOf(board).length, 0);

	const legacy = receipt({ reviewTaskId: 'W-rev-999', workerTaskId: worker.id, deliveryVersion: version, raw: 'legacy PASS naming W-rev-999' });
	assert.throws(() => recordReview(board, legacy), ReviewReceiptOriginError);
	assert.equal(countId(board, 'W-rev-999'), 0, 'a bogus canonical id is never created');
	assert.equal(reviewRecordsOf(board).length, 0);
	assert.equal(JSON.stringify(board), before);
});

test('R5 a receipt naming worker W-2 with the attempt pin of W-rev-1 fails closed without superseding it', () => {
	const { board, worker, requestId } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const pin = deliveryVersionOf(worker);
	const attempt = reviewAttemptIdentity(rev)!.attemptId;
	const [second] = addTasks(board, [{
		title: 'second worker', role: 'ayton', requestIds: [requestId], dependsOn: [],
		readPaths: [], writePaths: [], acceptance: ['second worker verified'],
	}], ROOT);
	second.status = 'reported';
	second.runId = 'run-2';
	second.sessionId = 'sess-2';
	second.dispatchedAt = '2026-01-01T00:00:00.000Z';
	const revBefore = ownershipOf(rev);
	const secondBefore = ownershipOf(second);
	const before = JSON.stringify(board);
	assert.throws(() => recordReview(board, receipt({
		reviewTaskId: rev.id, workerTaskId: second.id, deliveryVersion: pin, attemptId: attempt,
		reviewerRunId: 'rev-run', reviewerSessionId: 'rev-sess', raw: 'foreign worker PASS',
	})), ReviewReceiptOriginError);
	assert.deepEqual(ownershipOf(rev), revBefore, 'W-rev-1 is not superseded by a foreign worker receipt');
	assert.deepEqual(ownershipOf(second), secondBefore);
	assert.equal(JSON.stringify(board), before, 'no obligation, evidence, or revision changes');
	assert.equal(reviewRecordsOf(board).length, 0);
});

test('R5 caller-supplied STALE cannot supersede a still-matching current reviewer', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	rev.status = 'running';
	rev.runId = 'rev-run-1';
	rev.sessionId = 'rev-sess-1';
	rev.dispatchedAt = '2026-01-01T00:10:00.000Z';
	const before = JSON.stringify(board);
	assert.throws(() => recordReview(board, receipt({
		verdict: 'STALE', deliveryVersion: deliveryVersionOf(worker), attemptId: rev.reviewAttemptId,
		reviewerRunId: 'rev-run-1', reviewerSessionId: 'rev-sess-1', raw: 'caller says stale',
	})), ReviewReceiptOriginError);
	assert.equal(rev.status, 'running', 'a matching live reviewer is never superseded by caller metadata');
	assert.equal(rev.runId, 'rev-run-1');
	assert.equal(rev.sessionId, 'rev-sess-1');
	assert.equal(JSON.stringify(board), before, 'the rejected STALE mutates nothing');
	assert.equal(reviewRecordsOf(board).length, 0);
});

test('R5 dispatch and the PASS gate reject the same ambiguous duplicate reviewer ownership', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const template = createReviewerTask(board, worker);
	const ready: WorkTask = { ...structuredClone(template), status: 'ready', reviewAttemptId: 'attempt-ready', reviewEpoch: 2, evidence: ['ready owner'] };
	delete ready.runId; delete ready.sessionId; delete ready.dispatchedAt;
	const uncertain: WorkTask = { ...structuredClone(template), status: 'uncertain', reviewAttemptId: 'attempt-uncertain', reviewEpoch: 1, evidence: ['uncertain owner'], runId: 'new-run', sessionId: 'new-sess', dispatchedAt: '2026-02-02T00:00:00.000Z' };
	board.tasks = board.tasks.filter(t => t.id !== 'W-rev-1');
	board.tasks.push(ready, uncertain);
	const before = JSON.stringify(board);
	assert.equal(readyTasks(board).some(t => t.id === 'W-rev-1'), false, 'a READY owner before an UNCERTAIN same-id owner is never dispatchable');
	assert.equal(nextDispatchableTasks(board).some(t => t.id === 'W-rev-1'), false);
	assert.throws(() => markDispatched(board, 'W-rev-1', 'cp', 'run-new-2'), /share the canonical reviewer id/);
	assert.equal(hasValidReview(board, worker), false, 'the PASS gate refuses the same duplicate ownership');
	assert.equal(reviewDispatchOwnershipProblem(board, ready)?.includes('share the canonical reviewer id'), true);
	assert.equal(JSON.stringify(board), before, 'all checks are read-only and fail closed');
});

test('R5 a pinless READY reviewer with only dispatchedAt is never rebound, dispatchable, or gate-settleable', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	delete rev.reviewedDeliveryVersion;
	rev.status = 'ready';
	delete rev.runId; delete rev.sessionId;
	rev.dispatchedAt = '2026-01-01T00:15:00.000Z';
	const before = JSON.stringify(board);
	const again = createReviewerTask(board, worker);
	assert.equal(again, rev, 'the canonical slot is reused, never replaced');
	assert.equal(rev.reviewedDeliveryVersion, undefined, 'a dispatch stamp is not inferred as a delivery pin');
	assert.equal(rev.dispatchedAt, '2026-01-01T00:15:00.000Z', 'the residual dispatch stamp is preserved');
	assert.equal(rev.evidence.filter(line => line.startsWith('[REVIEW UNBOUND]')).length, 1);
	assert.equal(readyTasks(board).some(t => t.id === rev.id), false, 'residual ownership is not dispatchable');
	assert.throws(() => markDispatched(board, rev.id, 'cp', 'rebind-run'), /retains dispatch ownership/);
	assert.notEqual(JSON.stringify(board), before, 'only the single parent-decision note is added; no rebind');

	// Even if a legacy caller pins the delivery afterwards, an attributed receipt with no lease cannot pass.
	rev.reviewedDeliveryVersion = deliveryVersionOf(worker);
	board.reviewRecords.push(receipt({
		workerTaskId: worker.id, reviewTaskId: rev.id, verdict: 'PASS', deliveryVersion: deliveryVersionOf(worker),
		observedDeliveryVersion: deliveryVersionOf(worker), attemptId: rev.reviewAttemptId, raw: 'attributed but no lease',
	}));
	assert.equal(hasValidReview(board, worker), false, 'dispatchedAt without run/session never authorises the gate');
});

test('R5 an unbound review attempt is never dispatchable even without a residual lease', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	delete rev.reviewedDeliveryVersion;
	delete rev.runId; delete rev.sessionId; delete rev.dispatchedAt;
	assert.equal(reviewDispatchOwnershipProblem(board, rev)?.includes('unbound review attempt'), true);
	assert.equal(readyTasks(board).some(t => t.id === rev.id), false);
	assert.throws(() => markDispatched(board, rev.id, 'cp', 'unbound-run'), /unbound review attempt/);
});

test('R5 INCOMPLETE archives its epoch WITH lease; late same-origin reports are retained, originless PASS cannot clear the hold', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const version = deliveryVersionOf(worker);
	const attempt1 = reviewAttemptIdentity(rev)!.attemptId;
	rev.status = 'running';
	rev.runId = 'rev-run-1';
	rev.sessionId = 'rev-sess-1';
	rev.dispatchedAt = '2026-01-01T00:10:00.000Z';
	const first = recordReview(board, receipt({
		verdict: 'INCOMPLETE', deliveryVersion: version, attemptId: attempt1,
		reviewerRunId: 'rev-run-1', reviewerSessionId: 'rev-sess-1', reasons: ['missing_verdict'], raw: 'first INCOMPLETE report',
	}));
	assert.equal(first.reviewTask.status, 'blocked');
	assert.equal(first.reviewTask.runId, undefined);
	assert.equal(first.reviewTask.sessionId, undefined);
	const heldEpoch = first.reviewTask.reviewHistory?.find(entry => entry.attemptId === attempt1);
	assert.ok(heldEpoch, 'the closed INCOMPLETE epoch is archived');
	assert.equal(heldEpoch!.status, 'blocked');
	assert.equal(heldEpoch!.reviewerRunId, 'rev-run-1', 'the lease is preserved, not erased');
	assert.equal(heldEpoch!.reviewerSessionId, 'rev-sess-1');
	assert.equal(heldEpoch!.deliveryVersion, version);
	assert.ok(heldEpoch!.evidence.some(line => line.includes('Verdict: INCOMPLETE')));

	const late = recordReview(board, receipt({
		verdict: 'INCOMPLETE', deliveryVersion: version, attemptId: attempt1,
		reviewerRunId: 'rev-run-1', reviewerSessionId: 'rev-sess-1', reasons: ['missing_verdict'], raw: 'distinct late INCOMPLETE report',
	}));
	assert.equal(late.reviewTask.status, 'blocked', 'a late same-origin receipt never reopens the hold');
	const lateRecord = reviewRecordsOf(board).at(-1)!;
	assert.equal(lateRecord.raw, 'distinct late INCOMPLETE report');
	assert.equal(lateRecord.discarded, true);
	assert.equal(lateRecord.verdict, 'STALE');
	assert.equal(lateRecord.resolvedAttemptId, attempt1);
	assert.equal(reviewRecordsOf(board).length, 2, 'distinct late reports are retained, only identical receipts dedup');

	assert.throws(() => recordReview(board, receipt({
		verdict: 'PASS', deliveryVersion: version, raw: 'originless PASS before requeue',
	})), ReviewReceiptOriginError);
	assert.equal(late.reviewTask.status, 'blocked', 'an originless PASS cannot clear the parent hold');
	assert.equal(reviewRecordsOf(board).length, 2);

	updateTask(board, { id: rev.id, status: 'ready', evidence: ['parent: review brief clarified'], reason: 'explicit requeue' });
	const archived = (rev.reviewHistory ?? []).find(entry => entry.attemptId === attempt1)!;
	assert.equal(archived.reviewerRunId, 'rev-run-1', 'the requeue does not lose the closed epoch lease');
	assert.equal(archived.reviewerSessionId, 'rev-sess-1');
	assert.notEqual(reviewAttemptIdentity(rev)!.attemptId, attempt1, 'the explicit requeue mints a new attempt');
});

test('R5 archive keeps verbatim user evidence that only starts with the lineage prefix', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	rev.status = 'blocked';
	rev.evidence = ['[PRIOR ATTEMPT plain user evidence', 'user supplied the original log verbatim'];
	updateTask(board, { id: rev.id, status: 'ready', evidence: ['parent requeue after reading the user log'], reason: 'explicit parent requeue' });
	const history = rev.reviewHistory ?? [];
	assert.equal(history.length, 1);
	assert.deepEqual(history[0].evidence, ['[PRIOR ATTEMPT plain user evidence', 'user supplied the original log verbatim'], 'user evidence is archived verbatim');
});

test('R5 repeated identical-fingerprint REWORK holds instead of relaunching; an explicit parent requeue authorises one retry', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const common = {
		workerTaskId: worker.id, defects: ['same defect'], nextActions: ['apply same fix'], reasons: ['same finding'],
		checks: [{ criterion: 'a passes', status: 'pass' as const, evidence: 'src/mod.ts:1' }],
	};
	const rev1 = createReviewerTask(board, worker, 'cp', 'fp-same');
	const first = recordReview(board, receipt({ ...common, reviewTaskId: rev1.id, verdict: 'REWORK', deliveryVersion: deliveryVersionOf(worker), raw: 'REWORK report 1' }));
	assert.equal(first.workerTask.status, 'ready', 'the first REWORK has a progress baseline to establish');
	assert.equal(first.workerTask.retryCount, 1);

	markDispatched(board, worker.id, 'bridges', 'run-2');
	assert.ok(observeTask(board, 'run-2', undefined, 'reported'));
	const version2 = deliveryVersionOf(worker);
	const rev2 = createReviewerTask(board, worker, 'cp', 'fp-same');
	assert.notEqual(reviewAttemptIdentity(rev2)!.attemptId, reviewAttemptIdentity(rev1)!.attemptId);
	const second = recordReview(board, receipt({ ...common, reviewTaskId: rev2.id, verdict: 'REWORK', deliveryVersion: version2, attemptId: reviewAttemptIdentity(rev2)!.attemptId, raw: 'REWORK report 2' }));
	assert.equal(second.workerTask.status, 'blocked', 'identical findings on the same fingerprint never auto-relaunch');
	assert.equal(second.workerTask.retryCount, 1, 'no progress means no new retry budget was consumed');
	assert.match(String(second.workerTask.reason), /no progress/);
	assert.ok(second.workerTask.evidence.some(line => line.startsWith('[REWORK HELD]')));
	assert.equal(second.reviewTask.status, 'blocked');
	assert.equal(second.reviewTask.runId, undefined);
	assert.equal(reviewRecordsOf(board).length, 2, 'both raw reports are retained');
	assert.equal(reviewRecordsOf(board)[0].raw, 'REWORK report 1');
	assert.equal(reviewRecordsOf(board)[1].raw, 'REWORK report 2');

	// The parent explicitly requeues the held worker: this is the authorised bypass for one new attempt.
	updateTask(board, { id: worker.id, status: 'ready', evidence: ['parent: artefact will be changed'], reason: 'explicit requeue after no-progress hold' });
	markDispatched(board, worker.id, 'bridges', 'run-3');
	assert.ok(observeTask(board, 'run-3', undefined, 'reported'));
	const version3 = deliveryVersionOf(worker);
	const rev3 = createReviewerTask(board, worker, 'cp', 'fp-same');
	const third = recordReview(board, receipt({ ...common, reviewTaskId: rev3.id, verdict: 'REWORK', deliveryVersion: version3, attemptId: reviewAttemptIdentity(rev3)!.attemptId, raw: 'REWORK report 3' }));
	assert.equal(third.workerTask.status, 'ready', 'the explicit parent requeue authorises one retry');
	assert.equal(third.workerTask.retryCount, 2);

	// D1 regression: ONE requeue authorises exactly ONE following attempt, never an unlimited bypass. Round 4 is
	// the next unchanged round and must hold again (before the fix it returned `ready`, and every later round
	// kept relaunching the same no-progress review with retryCount 3,4,5...).
	markDispatched(board, worker.id, 'bridges', 'run-4');
	assert.ok(observeTask(board, 'run-4', undefined, 'reported'));
	const version4 = deliveryVersionOf(worker);
	const rev4 = createReviewerTask(board, worker, 'cp', 'fp-same');
	const fourth = recordReview(board, receipt({ ...common, reviewTaskId: rev4.id, verdict: 'REWORK', deliveryVersion: version4, attemptId: reviewAttemptIdentity(rev4)!.attemptId, raw: 'REWORK report 4' }));
	assert.equal(fourth.workerTask.status, 'blocked', 'the single parent requeue must not authorise a second unchanged round');
	assert.equal(fourth.workerTask.retryCount, 2, 'a held round consumes no retry budget');
	assert.ok(fourth.workerTask.evidence.at(-1)!.startsWith('[REWORK HELD]'), 'the following unchanged round records its own hold');
	// The requeue authorisation is recorded as consumed and scoped to the attempt that spent it.
	const consumedLines = fourth.workerTask.evidence.filter(line => line.startsWith('review-rework-parent-requeue-consumed:'));
	assert.equal(consumedLines.length, 1, 'exactly one requeue authorisation was consumed so far');
	assert.ok(consumedLines[0].includes(`attempt=${reviewAttemptIdentity(rev3)!.attemptId}`), 'consumption names the attempt epoch that used it');
	assert.equal(readyTasks(board).some(t => t.id === worker.id), false, 'a held worker is not relaunchable without a NEW requeue');

	// A NEW explicit parent requeue authorises exactly one more attempt: authorisation is per-requeue, never a cap.
	updateTask(board, { id: worker.id, status: 'ready', evidence: ['parent: artefact will be changed again'], reason: 'second explicit requeue' });
	markDispatched(board, worker.id, 'bridges', 'run-5');
	assert.ok(observeTask(board, 'run-5', undefined, 'reported'));
	const version5 = deliveryVersionOf(worker);
	const rev5 = createReviewerTask(board, worker, 'cp', 'fp-same');
	const fifth = recordReview(board, receipt({ ...common, reviewTaskId: rev5.id, verdict: 'REWORK', deliveryVersion: version5, attemptId: reviewAttemptIdentity(rev5)!.attemptId, raw: 'REWORK report 5' }));
	assert.equal(fifth.workerTask.status, 'ready', 'a new explicit requeue authorises exactly one more attempt');
	assert.equal(fifth.workerTask.retryCount, 3);
	markDispatched(board, worker.id, 'bridges', 'run-6');
	assert.ok(observeTask(board, 'run-6', undefined, 'reported'));
	const version6 = deliveryVersionOf(worker);
	const rev6 = createReviewerTask(board, worker, 'cp', 'fp-same');
	const sixth = recordReview(board, receipt({ ...common, reviewTaskId: rev6.id, verdict: 'REWORK', deliveryVersion: version6, attemptId: reviewAttemptIdentity(rev6)!.attemptId, raw: 'REWORK report 6' }));
	assert.equal(sixth.workerTask.status, 'blocked', 'the second requeue is spent by its own single following attempt');
	assert.equal(sixth.workerTask.retryCount, 3);
	assert.ok(sixth.workerTask.evidence.at(-1)!.startsWith('[REWORK HELD]'), 'the round after an authorised attempt holds again');
	assert.equal(reviewRecordsOf(board).length, 6, 'every raw report is retained; holds never truncate receipts');
});

test('R5 three same-slot identical REWORK receipts are retained as lineage but never mutate or relaunch the worker', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const common = {
		workerTaskId: worker.id, defects: ['same defect'], nextActions: ['same fix'], reasons: ['same finding'],
		checks: [{ criterion: 'a passes', status: 'pass' as const, evidence: 'src/mod.ts:1' }],
	};
	const rev = createReviewerTask(board, worker, 'cp', 'fp-same');
	const version = deliveryVersionOf(worker);
	const first = recordReview(board, receipt({ ...common, reviewTaskId: rev.id, verdict: 'REWORK', deliveryVersion: version, raw: 'same-slot REWORK 1' }));
	assert.equal(first.workerTask.status, 'ready');
	assert.equal(first.workerTask.retryCount, 1);
	const settledWorker = structuredClone(worker);
	// The first receipt closed the only epoch; later legacy no-attempt reports cannot be attributed to it.
	for (const n of [2, 3]) {
		const late = recordReview(board, receipt({ ...common, reviewTaskId: rev.id, verdict: 'REWORK', deliveryVersion: version, raw: `same-slot REWORK ${n}` }));
		assert.equal(late.workerTask.status, settledWorker.status, 'a closed-slot repeat never re-arms the worker');
		assert.equal(late.workerTask.retryCount, settledWorker.retryCount);
		assert.deepEqual(late.workerTask.evidence, settledWorker.evidence);
		const stored = reviewRecordsOf(board).at(-1)!;
		assert.equal(stored.raw, `same-slot REWORK ${n}`);
		assert.equal(stored.verdict, 'REWORK', 'the submitted verdict is retained as lineage');
		assert.equal(stored.discarded, true, 'but it is explicitly marked non-settling');
	}
	assert.equal(reviewRecordsOf(board).length, 3, 'all three distinct raw reports are retained');
	assert.equal(new Set(reviewRecordsOf(board).map(r => r.raw)).size, 3);
});

test('R5 the dispatch-origin helper accepts only the same task/run and a late old origin never settles a requeued owner', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	rev.status = 'running';
	rev.runId = 'rev-run-old';
	rev.sessionId = 'rev-sess-old';
	rev.dispatchedAt = '2026-01-01T00:10:00.000Z';
	const dispatchLease = structuredClone(rev);
	const origin = reviewOriginFromDispatchLease(rev, dispatchLease)!;
	assert.equal(origin.attemptId, rev.reviewAttemptId);
	assert.equal(origin.deliveryVersion, rev.reviewedDeliveryVersion);
	assert.equal(origin.reviewerRunId, 'rev-run-old');
	assert.equal(reviewOriginFromDispatchLease(rev, { ...dispatchLease, id: 'W-rev-2' }), undefined, 'a foreign task lease is rejected');
	assert.equal(reviewOriginFromDispatchLease(rev, { ...dispatchLease, runId: 'foreign-run' }), undefined, 'a foreign run lease is rejected');

	// The slot is requeued while the old child is still the source of the late report.
	rev.status = 'reported';
	updateTask(board, { id: rev.id, status: 'ready', evidence: ['parent: new review lease'], reason: 'explicit review requeue' });
	markDispatched(board, rev.id, 'cp', 'rev-run-new');
	rev.sessionId = 'rev-sess-new';
	const before = JSON.stringify(board);
	const late = completeReviewTask(board, rev.id, 'PASS', ['late PASS from the closed lease'], origin);
	assert.equal(late.reviewTask.status, 'running', 'the current reviewer lease is never superseded');
	assert.equal(late.reviewTask.runId, 'rev-run-new');
	assert.equal(JSON.stringify(late.workerTask), JSON.stringify(JSON.parse(before).tasks.find((t: WorkTask) => t.id === worker.id)));
	const stored = reviewRecordsOf(board).at(-1)!;
	assert.equal(stored.verdict, 'STALE');
	assert.equal(stored.discarded, true);
	assert.equal(stored.raw, 'late PASS from the closed lease');
});

test('D2 delivery drift never replaces a dispatch-only reviewer owner and the newer delivery is never silently bound', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	const boundDelivery = rev.reviewedDeliveryVersion;
	const attempt = reviewAttemptIdentity(rev)!.attemptId;
	// Ownership is a dispatch stamp without a verifiable run/session lease (the child was released between ticks).
	rev.status = 'ready';
	rev.dispatchedAt = '2026-01-01T00:10:00.000Z';
	delete rev.runId; delete rev.sessionId;
	assert.equal(readyTasks(board).some(t => t.id === rev.id), false, 'dispatch-only ownership is not dispatchable');
	assert.throws(() => markDispatched(board, rev.id, 'cp', 'redispatch'), /retains dispatch ownership/);

	// The worker is re-delivered after drift: the older reviewer must NOT be replaced by a fresh attempt.
	worker.runId = 'run-2';
	worker.dispatchedAt = '2026-01-01T00:20:00.000Z';
	const after = createReviewerTask(board, worker);
	assert.equal(after, rev, 'the dispatch-only owner is preserved instead of being replaced');
	assert.equal(countId(board, 'W-rev-1'), 1, 'no replacement attempt is stacked on the canonical id');
	assert.equal(reviewAttemptIdentity(rev)!.attemptId, attempt, 'the attempt identity is not recycled');
	assert.equal(rev.dispatchedAt, '2026-01-01T00:10:00.000Z', 'the dispatch stamp is preserved for reconciliation');
	assert.equal(rev.reviewedDeliveryVersion, boundDelivery, 'the slot never silently binds the newer delivery');
	assert.equal(rev.status, 'ready', 'the preserved attempt is parked, not relaunched');
	assert.equal(readyTasks(board).some(t => t.id === rev.id), false, 'the preserved owner stays non-dispatchable');
	assert.throws(() => markDispatched(board, rev.id, 'cp', 'rebind'), /retains dispatch ownership/);
	assert.ok(rev.evidence.some(line => line.startsWith('[REVIEW DISPATCH OWNERSHIP]')), 'the parent decision is recorded in evidence');
	assert.equal(hasValidReview(board, worker), false, 'no PASS can settle the newer delivery through the old owner');
});

test('D3 a missing review slot never accepts an invented attempt identity or a foreign lease', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const version = deliveryVersionOf(worker);
	const beforeTasks = JSON.stringify(board.tasks);
	const beforeRecords = reviewRecordsOf(board).length;
	assert.throws(() => recordReview(board, receipt({
		reviewTaskId: 'W-rev-1', verdict: 'PASS', deliveryVersion: version,
		attemptId: 'unregistered-attempt', reviewerRunId: 'foreign-run', reviewerSessionId: 'foreign-sess',
		raw: 'invented origin PASS',
	})), ReviewReceiptOriginError);
	assert.equal(countId(board, 'W-rev-1'), 0, 'no reviewer slot is created from an invented origin');
	assert.equal(JSON.stringify(board.tasks), beforeTasks, 'the rejected receipt mutates nothing');
	assert.equal(worker.status, 'reported', 'the worker is never settled by an unverifiable provenance');
	assert.equal(reviewRecordsOf(board).length, beforeRecords, 'no receipt is recorded');
	assert.equal(hasValidReview(board, worker), false);

	// A lease-only origin is exactly as unverifiable when no attempt is registered.
	assert.throws(() => recordReview(board, receipt({
		reviewTaskId: 'W-rev-1', verdict: 'PASS', deliveryVersion: version, reviewerRunId: 'foreign-run', raw: 'foreign lease PASS',
	})), /cannot be validated/);
	assert.equal(countId(board, 'W-rev-1'), 0);
	assert.equal(worker.status, 'reported');

	// Unchanged accepted behavior: an originless legacy receipt for the live delivery still opens the reviewer.
	const legacy = recordReview(board, receipt({ reviewTaskId: 'W-rev-1', verdict: 'PASS', deliveryVersion: version, raw: 'originless legacy PASS' }));
	assert.equal(legacy.workerTask.status, 'done');
});

test('D4 the PASS gate rejects a persisted PASS receipt that names a foreign reviewer id', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	rev.status = 'running';
	rev.runId = 'rev-run-1';
	rev.sessionId = 'rev-sess-1';
	rev.dispatchedAt = '2026-01-01T00:10:00.000Z';
	const version = deliveryVersionOf(worker);
	// A record already persisted on disk (written before ingestion-time canonical id validation existed).
	board.reviewRecords!.push(receipt({
		reviewTaskId: 'W-rev-999', workerTaskId: worker.id, verdict: 'PASS',
		deliveryVersion: version, observedDeliveryVersion: version,
		attemptId: rev.reviewAttemptId, reviewerRunId: 'rev-run-1', reviewerSessionId: 'rev-sess-1',
		raw: 'PASS from a foreign reviewer id',
	}));
	assert.equal(hasValidReview(board, worker), false, 'a foreign reviewer id never authorises the gate');
	// The identical receipt naming the canonical slot stays valid: the gate only added the id check.
	board.reviewRecords!.push(receipt({
		reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'PASS',
		deliveryVersion: version, observedDeliveryVersion: version,
		attemptId: rev.reviewAttemptId, reviewerRunId: 'rev-run-1', reviewerSessionId: 'rev-sess-1',
		raw: 'PASS from the canonical reviewer id',
	}));
	assert.equal(hasValidReview(board, worker), true);
});

test('D5 fully closed legacy duplicates recover by tombstoning surplus slots and retaining every evidence line', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	rev.status = 'done';
	rev.archivedAt = '2026-01-01T00:05:00.000Z';
	rev.evidence = [...rev.evidence, 'done-slot evidence A'];
	const duplicate: WorkTask = {
		...structuredClone(rev), status: 'cancelled', reviewAttemptId: 'legacy-cancelled-attempt',
		evidence: ['cancelled-slot evidence B', '[RETAINED DUPLICATE user supplied this line verbatim'], reason: 'legacy duplicate',
	};
	board.tasks.push(duplicate);
	assert.equal(countId(board, 'W-rev-1'), 2);
	assert.equal(board.tasks.filter(t => t.id === 'W-rev-1' && !t.retiredInto).length, 2, 'the closed duplicates are ambiguous before recovery');
	assert.equal(reviewDispatchOwnershipProblem(board, rev)?.includes('share the canonical reviewer id'), true);
	assert.equal(readyTasks(board).some(t => t.id === 'W-rev-1'), false, 'no slot is executable while fully closed duplicates exist');

	// prune_reviews was documented as the recovery but used to change nothing (terminal slots are never pruned).
	const prune = pruneStaleReviews(board);
	assert.equal(prune.retiredDuplicates.length, 1, 'prune_reviews now performs the documented recovery');
	assert.equal(prune.retiredDuplicates[0].id, 'W-rev-1', 'the report names the original id that was retired');
	assert.equal(prune.retiredDuplicates[0].archivedAs, 'W-rev-1~retired-1', 'and the unique archival id it was renamed to');
	assert.equal(prune.retiredDuplicates[0].into, 'W-rev-1', 'the canonical survivor is unchanged');
	const retired = board.tasks.filter(t => t.retiredInto);
	assert.equal(retired.length, 1);
	// DEFECT A (round 7): the tombstone is RENAMED, so it can never collide with the canonical slot in `addTasks`
	// or in the id-keyed persistence delta. The original id stays discoverable via retiredFrom + the tombstone line.
	assert.equal(retired[0].id, 'W-rev-1~retired-1', 'the retired duplicate gets a unique archival id');
	assert.equal(retired[0].retiredFrom, 'W-rev-1');
	assert.equal(retired[0].retiredInto, 'W-rev-1');
	assert.equal(retired[0].status, 'done', 'the retired duplicate keeps its terminal status');
	assert.ok(retired[0].evidence.includes('done-slot evidence A'), 'the retired duplicate keeps its evidence verbatim');
	assert.ok(retired[0].evidence.some(line => line.startsWith('[DUPLICATE RETIRED] W-rev-1 retired as W-rev-1~retired-1; evidence retained verbatim')), 'the tombstone states what was retained and where it was renamed to');
	assert.equal(reviewDispatchOwnershipProblem(board, retired[0])?.includes('never executable'), true, 'a tombstone can never be dispatched, even by direct reference');
	assert.equal(board.tasks.filter(t => t.id === 'W-rev-1' && !t.retiredInto).length, 1, 'exactly ONE executable canonical slot remains');
	assert.equal(countId(board, 'W-rev-1'), 1, 'only the canonical slot holds the original id');
	assert.equal(board.tasks.length, 3, 'both tasks stay in the ledger: nothing is deleted');
	// Stable/idempotent: a second recovery pass must neither rename again nor invent a new archival id.
	const afterRecovery = structuredClone(board);
	const secondPass = pruneStaleReviews(board);
	assert.equal(secondPass.retiredDuplicates.length, 0, 'recovery never retires the same duplicate twice');
	assert.deepEqual(board, afterRecovery, 'a second recovery pass is a no-op');
	assert.deepEqual(board.tasks.filter(t => t.retiredFrom).map(t => t.id), ['W-rev-1~retired-1']);

	const fresh = createReviewerTask(board, worker);
	assert.equal(fresh.status, 'ready');
	assert.equal(board.tasks.filter(t => t.id === 'W-rev-1' && !t.retiredInto).length, 1);
	assert.ok(readyTasks(board).some(t => t.id === 'W-rev-1'), 'the canonical slot is dispatchable again');
	assert.ok(fresh.evidence.some(line => line.startsWith('[RETAINED DUPLICATE]')), 'the canonical slot references the retired duplicate in evidence');
	// AC2 preservation: user evidence that only starts with the bookkeeping prefix is archived verbatim and
	// never mistaken for (or copied as) a ledger-generated retained reference.
	assert.ok((fresh.reviewHistory ?? []).some(entry => entry.evidence.includes('[RETAINED DUPLICATE user supplied this line verbatim')), 'prefix-only user evidence is archived verbatim');
	assert.equal(fresh.evidence.includes('[RETAINED DUPLICATE user supplied this line verbatim'), false, 'user evidence is never re-emitted as bookkeeping');

	markDispatched(board, fresh.id, 'cp', 'rev-run-recovered');
	fresh.sessionId = 'rev-sess-recovered';
	const settled = recordReview(board, receipt({
		verdict: 'PASS', deliveryVersion: deliveryVersionOf(worker), attemptId: reviewAttemptIdentity(fresh)!.attemptId,
		reviewerRunId: 'rev-run-recovered', reviewerSessionId: 'rev-sess-recovered', raw: 'recovered canonical PASS',
	}));
	assert.equal(settled.workerTask.status, 'done', 'the recovered slot settles the worker normally');
	assert.equal(hasValidReview(board, worker), true, 'and the PASS gate now agrees with the settlement');
	assert.equal(fresh.evidence.filter(line => line.startsWith('[RETAINED DUPLICATE]')).length, 1, 'the retained reference is not duplicated on slot reuse');
	assert.ok(board.tasks.filter(t => t.retiredInto).every(t => t.id === 'W-rev-1~retired-1' && t.retiredFrom === 'W-rev-1'));
});

// ────────── DEFECT A (round 7): recovery leaves `addTasks` usable and the persistence delta faithful ──────────

test('D5 recovered boards accept follow-up registration and survive the real delta round trip', () => {
	const cfg = teamPersistence.defaultConfig();
	const stateOf = (ledger: WorkLedger) => ({ ...teamPersistence.initialState(cfg), ledger: structuredClone(ledger), tasks: ledger.tasks.length });

	// Legacy shape: a CLOSED canonical attempt (DONE, with A-only evidence) plus an OPEN dispatchable slot.
	const { board, worker } = boardWithDeliveredWorker();
	const canonical = createReviewerTask(board, worker);
	canonical.status = 'done';
	canonical.archivedAt = '2026-01-01T00:05:00.000Z';
	canonical.evidence = [...canonical.evidence, 'A-only-evidence'];
	const openSlot: WorkTask = {
		...structuredClone(canonical), status: 'ready', reviewAttemptId: 'legacy-open-attempt',
		evidence: ['B-only-evidence'], reviewAttempts: 1,
	};
	delete openSlot.archivedAt; delete openSlot.runId; delete openSlot.sessionId; delete openSlot.dispatchedAt;
	board.tasks.push(openSlot);
	const legacyIds = board.tasks.map(t => t.id);
	assert.ok(new Set(legacyIds).size < legacyIds.length, 'the legacy fixture really carries two tasks with the canonical id');

	// The state the host persisted BEFORE recovery (its delta baseline).
	const prev = stateOf(board);
	const prune = pruneStaleReviews(board);
	assert.equal(prune.retiredDuplicates.length, 1);
	assert.equal(prune.retiredDuplicates[0].id, 'W-rev-1');
	assert.equal(prune.retiredDuplicates[0].archivedAs, 'W-rev-1~retired-1');
	assert.equal(board.tasks.length, legacyIds.length, 'recovery deletes nothing and duplicates nothing');
	assert.equal(new Set(board.tasks.map(t => t.id)).size, board.tasks.length, 'every task id is unique after recovery (what the delta store keys on)');
	assert.equal(countId(board, 'W-rev-1'), 1, 'exactly one task holds the original id');
	const survivor = board.tasks.find(t => t.id === 'W-rev-1')!;
	const tombstone = board.tasks.find(t => t.retiredFrom === 'W-rev-1')!;
	assert.equal(survivor.status, 'ready');
	assert.ok(survivor.evidence.includes('B-only-evidence'), 'the canonical attempt keeps its own evidence');
	assert.ok(survivor.evidence.some(line => line.startsWith('[RETAINED DUPLICATE] W-rev-1 ') && line.includes('archivedAs=W-rev-1~retired-1')));
	assert.equal(tombstone.id, 'W-rev-1~retired-1');
	assert.equal(tombstone.retiredInto, 'W-rev-1');
	assert.ok(tombstone.evidence.includes('A-only-evidence'), 'A-only-evidence is retained verbatim on the tombstone');
	assert.deepEqual(readyTasks(board).filter(isReviewTask).map(t => t.id), ['W-rev-1'], 'the dispatchable reviewer set is preserved by recovery');

	// (a) follow-up registration after recovery: the archival id must not occupy a registrable id.
	const next = stateOf(board);
	assert.equal(addTasks(board, [{ id: 'W-rev-2', title: 'follow-up review', role: 'cp', requestIds: [worker.requestIds[0]], dependsOn: [], readPaths: [], writePaths: [], acceptance: ['follow-up review registered'] }], ROOT).length, 1, 'addTasks accepts a fresh reviewer id after recovery');
	assert.equal(addTasks(board, [{ id: 'W-9', title: 'follow-up worker', role: 'ayton', requestIds: [worker.requestIds[0]], dependsOn: [], readPaths: [], writePaths: [], acceptance: ['follow-up worker registered'] }], ROOT).length, 1);
	// ...while the original id stays owned by exactly ONE real canonical slot (refusal names that slot, not a tombstone).
	assert.throws(() => addTasks(board, [{ id: 'W-rev-1', title: 'second slot', role: 'cp', requestIds: [worker.requestIds[0]], dependsOn: [], readPaths: [], writePaths: [], acceptance: ['x'] }], ROOT), /Duplicate task id \(W-rev-1\(status=ready, role=cp\)\)/);
	assert.equal(new Set(board.tasks.map(t => t.id)).size, board.tasks.length, 'the rejected registration mutated nothing');

	// (b) the REAL delta/replay path across the recovery transition must reproduce the recovered board exactly.
	const replayed = teamPersistence.applyStateDelta(prev, teamPersistence.computeStateDelta(prev, next), cfg);
	assert.deepEqual(replayed.ledger, next.ledger, 'delta replay reproduces the recovered board byte for byte');
	const replayedLedger = replayed.ledger!;
	const replayedSurvivor = replayedLedger.tasks.find(t => t.id === 'W-rev-1')!;
	assert.equal(replayedSurvivor.status, 'ready', 'the recovered canonical attempt is not replaced by the older closed attempt');
	assert.ok(replayedSurvivor.evidence.includes('B-only-evidence'));
	assert.ok(replayedSurvivor.evidence.some(line => line.startsWith('[RETAINED DUPLICATE]')), 'its retained reference survives the replay');
	const replayedTombstone = replayedLedger.tasks.find(t => t.retiredFrom === 'W-rev-1')!;
	assert.equal(replayedTombstone.id, 'W-rev-1~retired-1');
	assert.ok(replayedTombstone.evidence.includes('A-only-evidence'), 'A-only-evidence survives the replay');
	assert.ok(replayedTombstone.evidence.some(line => line.startsWith('[DUPLICATE RETIRED]')), 'the tombstone line survives the replay');
	assert.deepEqual(readyTasks(replayedLedger).filter(isReviewTask).map(t => t.id), ['W-rev-1'], 'the dispatchable reviewer set survives the replay');

	// ...and a follow-up registration on the recovered board also round-trips.
	const next2 = stateOf(board);
	const replayed2 = teamPersistence.applyStateDelta(next, teamPersistence.computeStateDelta(next, next2), cfg);
	assert.deepEqual(replayed2.ledger, next2.ledger, 'a follow-up registration after recovery round-trips through the delta');
});

test('D5 archival ids are unique per pass and are never reused by a later recovery', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const survivor = createReviewerTask(board, worker);
	survivor.evidence = [...survivor.evidence, 'B-only-evidence'];
	const closedA: WorkTask = { ...structuredClone(survivor), status: 'done', evidence: ['closed-A-evidence'], reviewAttemptId: 'legacy-a' };
	const closedB: WorkTask = { ...structuredClone(survivor), status: 'cancelled', evidence: ['closed-B-evidence'], reviewAttemptId: 'legacy-b' };
	board.tasks.push(closedA, closedB);

	// A dry run predicts the archival ids it would assign, and renames nothing.
	const beforeDryRun = structuredClone(board);
	const preview = pruneStaleReviews(board, { dryRun: true });
	assert.deepEqual(preview.retiredDuplicates.map(duplicate => duplicate.archivedAs), ['W-rev-1~retired-1', 'W-rev-1~retired-2'], 'a dry run previews the exact archival ids');
	assert.deepEqual(board, beforeDryRun, 'a dry run never renames or tombstones');

	const pruned = pruneStaleReviews(board);
	assert.deepEqual(pruned.retiredDuplicates.map(duplicate => duplicate.archivedAs), ['W-rev-1~retired-1', 'W-rev-1~retired-2'], 'two duplicates retired in one pass get distinct archival ids');
	assert.equal(new Set(board.tasks.map(t => t.id)).size, board.tasks.length, 'ids stay unique after a multi-duplicate recovery');
	assert.deepEqual(board.tasks.filter(t => t.retiredFrom).flatMap(t => t.evidence.filter(line => line.startsWith('closed-'))).sort(), ['closed-A-evidence', 'closed-B-evidence'], 'every retired slot keeps its own evidence verbatim');
	assert.ok(board.tasks.filter(t => t.retiredFrom).every(t => t.retiredInto === 'W-rev-1' && t.status !== 'ready'), 'tombstones point at the canonical slot and are all terminal');

	// A later legacy duplicate reopening the same id must receive the NEXT archival id, never a reused one.
	const late: WorkTask = { ...structuredClone(survivor), status: 'cancelled', evidence: ['late-evidence'], reviewAttemptId: 'legacy-late' };
	delete late.retiredInto;
	delete late.retiredFrom;
	board.tasks.push(late);
	const second = pruneStaleReviews(board);
	assert.equal(second.retiredDuplicates.length, 1, 'only the new duplicate is retired');
	assert.equal(second.retiredDuplicates[0].archivedAs, 'W-rev-1~retired-3', 'archival ids are never reused');
	assert.equal(new Set(board.tasks.map(t => t.id)).size, board.tasks.length);
	assert.ok(board.tasks.find(t => t.id === 'W-rev-1~retired-3')!.evidence.includes('late-evidence'));
	assert.equal(countId(board, 'W-rev-1'), 1, 'the canonical id still belongs to exactly one executable slot');

	// The exported recovery helper follows the same rename rule and is idempotent as well.
	const direct: WorkTask = { ...structuredClone(survivor), status: 'superseded', evidence: ['direct-evidence'], reviewAttemptId: 'legacy-direct' };
	delete direct.retiredInto;
	delete direct.retiredFrom;
	board.tasks.push(direct);
	const directRetired = retireDuplicateReviewSlots(board, 'W-rev-1');
	assert.equal(directRetired.length, 1);
	assert.equal(directRetired[0].id, 'W-rev-1~retired-4', 'the helper assigns the next free archival id');
	assert.equal(directRetired[0].retiredFrom, 'W-rev-1');
	assert.ok(directRetired[0].evidence.includes('direct-evidence'));
	assert.equal(retireDuplicateReviewSlots(board, 'W-rev-1').length, 0, 'the helper never retires twice');
	assert.equal(new Set(board.tasks.map(t => t.id)).size, board.tasks.length);
});

// ────────── DEFECT B (round 7): a rejected receipt is mutation-free on a legacy board ──────────

test('D3 legacy boards without reviewRecords stay byte-identical after every rejected origin', () => {
	// A legacy snapshot predates the receipt store: `reviewRecords` is absent, not an empty array.
	const legacyBoard = () => {
		const made = boardWithDeliveredWorker();
		delete made.board.reviewRecords;
		assert.equal('reviewRecords' in made.board, false, 'the fixture really has no receipt store');
		return made;
	};

	// (1) No registered attempt: an invented attemptId or a foreign/partial lease is never accepted.
	for (const origin of [
		{ attemptId: 'invented-attempt' },
		{ reviewerRunId: 'foreign-run' },
		{ reviewerSessionId: 'foreign-sess' },
	] as Array<Partial<ReviewRecord>>) {
		const { board, worker } = legacyBoard();
		const version = deliveryVersionOf(worker);
		const before = structuredClone(board);
		const label = Object.keys(origin)[0];
		assert.throws(() => recordReview(board, receipt({ verdict: 'PASS', deliveryVersion: version, raw: `invented origin ${label}`, ...origin })), ReviewReceiptOriginError);
		assert.deepEqual(board, before, `a rejected ${label} leaves the WHOLE legacy board identical`);
		assert.equal('reviewRecords' in board, false, `a rejected ${label} never materializes the receipt store`);
		assert.equal(worker.status, 'reported', `the worker is never settled by a rejected ${label}`);
	}

	// (2) A registered attempt with a contradictory lease: origin validation must also reject before defaulting.
	for (const origin of [
		{ reviewerRunId: 'foreign-run' },
		{ reviewerSessionId: 'foreign-sess' },
	] as Array<Partial<ReviewRecord>>) {
		const { board, worker } = legacyBoard();
		const slot = createReviewerTask(board, worker);
		const before = structuredClone(board);
		const label = Object.keys(origin)[0];
		assert.throws(() => recordReview(board, receipt({
			verdict: 'PASS', deliveryVersion: deliveryVersionOf(worker),
			attemptId: reviewAttemptIdentity(slot)!.attemptId, raw: `foreign lease ${label}`, ...origin,
		})), ReviewReceiptOriginError);
		assert.deepEqual(board, before, `a rejected ${label} on an existing attempt leaves the WHOLE legacy board identical`);
		assert.equal('reviewRecords' in board, false, `a rejected ${label} never materializes the receipt store`);
	}
});

// ────────── DEFECT 1 (round 8): round-6 same-id tombstones are migrated on upgrade ──────────

test('D5 upgrade migrates legacy same-id tombstones, so registration works without deleting evidence', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const survivor = createReviewerTask(board, worker);
	survivor.evidence = [...survivor.evidence, 'B-only-evidence'];
	// EXACT round-6 representation (the implementation in backups/team-bugfix-W75/round7-pre/team-ledger.ts): the
	// terminal duplicate was tombstoned but KEPT the canonical id, only `retiredInto` was set and the survivor
	// recorded a retained reference WITHOUT the archival `archivedAs` clause. No `retiredFrom` exists yet.
	const delivery = survivor.reviewedDeliveryVersion || 'unbound';
	const legacyTombstone: WorkTask = {
		...structuredClone(survivor), status: 'done', archivedAt: '2026-01-01T00:05:00.000Z',
		reviewAttemptId: 'legacy-done-attempt', retiredInto: 'W-rev-1',
		evidence: ['A-only-evidence', `[DUPLICATE RETIRED] W-rev-1 retired into W-rev-1: status=done attempt=legacy-done-attempt epoch=1 delivery=${delivery}; evidence/history/receipts retained verbatim on this task (nothing deleted).`],
	};
	delete legacyTombstone.retiredFrom;
	survivor.evidence.push(`[RETAINED DUPLICATE] W-rev-1 status=done attempt=legacy-done-attempt epoch=1 delivery=${delivery} evidence=2 lines retained verbatim on the retired slot; executable canonical slot=W-rev-1`);
	board.tasks.splice(1, 0, legacyTombstone);
	assert.equal(countId(board, 'W-rev-1'), 2, 'the legacy fixture really carries two same-id tasks');
	assert.equal(legacyTombstone.retiredFrom, undefined, 'round-6 tombstone carries no archival pointer yet');
	const legacyHistory = structuredClone(legacyTombstone.reviewHistory ?? []);
	// Registration is broken on the round-6 board: the tombstone still holds the canonical id.
	assert.throws(() => addTasks(board, [{ id: 'W-rev-2', title: 'pre-upgrade', role: 'cp', requestIds: [worker.requestIds[0]], dependsOn: [], readPaths: [], writePaths: [], acceptance: ['x'] }], ROOT), /Duplicate task id \(W-rev-1/);

	const prune = pruneStaleReviews(board);
	assert.equal(prune.retiredDuplicates.length, 1, 'the upgrade pass retires the legacy tombstone (round 7 retired 0)');
	assert.equal(prune.retiredDuplicates[0].id, 'W-rev-1');
	assert.equal(prune.retiredDuplicates[0].archivedAs, 'W-rev-1~retired-1');
	assert.equal(new Set(board.tasks.map(t => t.id)).size, board.tasks.length, 'upgrade leaves unique ids');
	assert.equal(countId(board, 'W-rev-1'), 1, 'exactly one task holds the canonical id after upgrade');
	const migrated = board.tasks.find(t => t.retiredFrom === 'W-rev-1')!;
	assert.equal(migrated.id, 'W-rev-1~retired-1');
	assert.equal(migrated.retiredInto, 'W-rev-1', 'the migrated tombstone still points at its survivor');
	assert.equal(migrated.status, 'done');
	assert.ok(migrated.evidence.includes('A-only-evidence'), 'original evidence is retained verbatim');
	assert.ok(migrated.evidence.some(line => line.startsWith('[DUPLICATE RETIRED] W-rev-1 retired into W-rev-1: status=done')), 'the round-6 tombstone line is kept verbatim');
	assert.ok(migrated.evidence.some(line => line.startsWith('[DUPLICATE RETIRED] W-rev-1 retired as W-rev-1~retired-1; evidence retained verbatim')), 'the upgrade appends the archival rename');
	assert.deepEqual(migrated.reviewHistory ?? [], legacyHistory, 'no history is deleted');
	// Defect 3: the canonical survivor must be moved AHEAD of its tombstone (the round-7 reorder branch was dead).
	assert.deepEqual(board.tasks.map(t => t.id), ['W-1', 'W-rev-1', 'W-rev-1~retired-1'], 'the canonical slot takes the earliest former position of its id');
	assert.equal(board.tasks[1].id, 'W-rev-1');
	// Stable/idempotent: a second pass neither renames again nor invents ids.
	const afterUpgrade = structuredClone(board);
	assert.equal(pruneStaleReviews(board).retiredDuplicates.length, 0, 'a migrated tombstone never re-enters a plan');
	assert.deepEqual(board, afterUpgrade, 'a second upgrade pass is a no-op');
	// The registration error is GONE (asserting on the error itself, not just the retire count).
	assert.equal(addTasks(board, [{ id: 'W-rev-2', title: 'post-upgrade', role: 'cp', requestIds: [worker.requestIds[0]], dependsOn: [], readPaths: [], writePaths: [], acceptance: ['follow-up review registered'] }], ROOT).length, 1, 'addTasks accepts a fresh reviewer id after the upgrade');
	assert.throws(() => addTasks(board, [{ id: 'W-rev-1', title: 'second canonical slot', role: 'cp', requestIds: [worker.requestIds[0]], dependsOn: [], readPaths: [], writePaths: [], acceptance: ['x'] }], ROOT), /Duplicate task id \(W-rev-1\(status=ready, role=cp\)\)/, 'the canonical id still belongs to exactly one executable slot');
});

// ────────── DEFECT 2 (round 8): one canonical identity rule for supplied origins ──────────

test('R8 padded or blank-only supplied identities are refused before mutation and can never settle without a PASS', () => {
	const withField = (base: Partial<ReviewRecord>, field: 'attemptId' | 'reviewerRunId' | 'reviewerSessionId', value: string): Partial<ReviewRecord> => ({ ...base, [field]: value });
	for (const field of ['attemptId', 'reviewerRunId', 'reviewerSessionId'] as const) {
		const { board, worker } = boardWithDeliveredWorker();
		const slot = createReviewerTask(board, worker);
		markDispatched(board, slot.id, 'cp', 'rev-run-1');
		slot.sessionId = 'rev-sess-1';
		const version = deliveryVersionOf(worker);
		const exact: Partial<ReviewRecord> = {
			reviewTaskId: slot.id, verdict: 'PASS', deliveryVersion: version,
			attemptId: reviewAttemptIdentity(slot)!.attemptId, reviewerRunId: 'rev-run-1', reviewerSessionId: 'rev-sess-1',
		};
		for (const [kind, value] of [['padded', ` ${exact[field]} `], ['blank-only', '   ']] as const) {
			const before = structuredClone(board);
			const recordsBefore = reviewRecordsOf(board).length;
			assert.throws(() => recordReview(board, receipt({ ...exact, raw: `${kind} ${field}`, ...withField({}, field, value) })), /not a canonical reviewer identity/, `${kind} ${field} is refused`);
			assert.deepEqual(board, before, `${kind} ${field} rejection leaves the WHOLE board byte-identical`);
			assert.equal(worker.status, 'reported', `${kind} ${field} never settles the worker`);
			assert.equal(slot.status, 'running', `${kind} ${field} never closes or re-arms the reviewer slot`);
			assert.equal(hasValidReview(board, worker), false, `${kind} ${field} never produces a valid PASS either`);
			assert.equal(reviewRecordsOf(board).length, recordsBefore, `${kind} ${field} records no receipt`);
		}
		// Positive control: the exact canonical identities settle, and the PASS gate agrees byte for byte.
		const settled = recordReview(board, receipt({ ...exact, raw: 'canonical PASS' }));
		assert.equal(settled.workerTask.status, 'done');
		assert.equal(hasValidReview(board, worker), true, 'settlement and the PASS gate agree on canonical bytes');
	}
	// Invented origins on a board WITHOUT a registered attempt stay fail-closed for padded/blank bytes as well.
	for (const field of ['attemptId', 'reviewerRunId', 'reviewerSessionId'] as const) {
		const { board, worker } = boardWithDeliveredWorker();
		const before = structuredClone(board);
		assert.throws(() => recordReview(board, receipt({ reviewTaskId: 'W-rev-1', verdict: 'PASS', deliveryVersion: deliveryVersionOf(worker), raw: `blank ${field}`, ...withField({}, field, '  ') })), /not a canonical reviewer identity/);
		assert.deepEqual(board, before, `blank-only ${field} on a missing slot mutates nothing`);
		assert.equal(countId(board, 'W-rev-1'), 0, 'no reviewer is created from a blank identity');
		assert.equal(worker.status, 'reported');
	}
});

test('R9 padded deliveryVersion is never a canonical origin: neither entry point settles without a valid PASS', () => {
	const variants: Array<[string, (v: string) => string]> = [
		['space', v => ` ${v} `], ['unicode-space', v => `\u00A0${v}\u00A0`], ['tab', v => `\t${v}\t`],
	];
	for (const [kind, pad] of variants) {
		// recordReview: a padded delivery pin is rejected BEFORE any read settlement or mutation.
		{
			const { board, worker } = boardWithDeliveredWorker();
			const slot = createReviewerTask(board, worker);
			markDispatched(board, slot.id, 'cp', 'rev-run-1');
			slot.sessionId = 'rev-sess-1';
			const version = deliveryVersionOf(worker);
			const before = structuredClone(board);
			assert.throws(() => recordReview(board, receipt({
				reviewTaskId: slot.id, verdict: 'PASS', deliveryVersion: pad(version),
				attemptId: reviewAttemptIdentity(slot)!.attemptId, reviewerRunId: 'rev-run-1', reviewerSessionId: 'rev-sess-1',
				raw: `${kind} delivery`,
			})), /deliveryVersion .* is not canonical/, `${kind}-padded delivery is refused by recordReview`);
			assert.deepEqual(board, before, `${kind}-padded delivery rejection leaves the WHOLE board byte-identical`);
			assert.equal(worker.status, 'reported', `${kind}-padded delivery never settles the worker`);
			assert.equal(slot.status, 'running', `${kind}-padded delivery never closes the reviewer slot`);
			assert.equal(hasValidReview(board, worker), false, `${kind}-padded delivery never becomes a valid PASS either`);
		}
		// completeReviewTask routes through the same gate: the reviewer's exact reproduction shape.
		{
			const { board, worker } = boardWithDeliveredWorker();
			const slot = createReviewerTask(board, worker);
			markDispatched(board, slot.id, 'cp', 'rev-run-1');
			slot.sessionId = 'rev-sess-1';
			const origin = reviewCompletionOrigin(slot)!;
			const before = structuredClone(board);
			assert.throws(() => completeReviewTask(board, slot.id, 'PASS', [`${kind} delivery`], { ...origin, deliveryVersion: pad(origin.deliveryVersion) }), /deliveryVersion .* is not canonical/, `${kind}-padded delivery is refused by completeReviewTask`);
			assert.deepEqual(board, before, `${kind}-padded completeReviewTask leaves the WHOLE board byte-identical`);
			assert.equal(worker.status, 'reported', `${kind}-padded completeReviewTask never settles the worker`);
			assert.equal(slot.status, 'running', `${kind}-padded completeReviewTask never closes the reviewer slot`);
			assert.equal(hasValidReview(board, worker), false, `${kind}-padded completeReviewTask never yields done && !hasValidReview`);
		}
	}
	// Positive control: the canonical pin still settles through both entry points and the PASS gate agrees.
	const { board, worker } = boardWithDeliveredWorker();
	const slot = createReviewerTask(board, worker);
	markDispatched(board, slot.id, 'cp', 'rev-run-1');
	slot.sessionId = 'rev-sess-1';
	const origin = reviewCompletionOrigin(slot)!;
	const settled = completeReviewTask(board, slot.id, 'PASS', ['canonical delivery'], origin);
	assert.equal(settled.workerTask.status, 'done', 'canonical delivery still settles the worker');
	assert.equal(settled.reviewTask.status, 'done', 'canonical delivery still closes the reviewer');
	assert.equal(hasValidReview(board, worker), true, 'canonical settlement and the PASS gate agree byte for byte');
});

test('R9 an all-tombstone reviewer id fails closed instead of creating a duplicate id', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const tombstone = createReviewerTask(board, worker);
	// The interrupted-recovery shape: every same-id slot is a tombstone (retiredInto set, no retiredFrom).
	tombstone.status = 'done';
	tombstone.archivedAt = '2026-01-01T00:00:00.000Z';
	tombstone.retiredInto = tombstone.id;
	const second = structuredClone(tombstone);
	second.status = 'cancelled';
	second.reviewAttemptId = 'legacy-second';
	second.reviewedDeliveryVersion = '';
	second.reviewHistory = [];
	board.tasks.push(second);
	assert.equal(countId(board, 'W-rev-1'), 2, 'precondition: two same-id tombstones');
	assert.equal(new Set(board.tasks.map(t => t.id)).size, 2, 'precondition: the legacy board already holds one duplicated id');
	const before = structuredClone(board);
	assert.throws(() => createReviewerTask(board, worker), /every task holding the canonical reviewer id is a retired tombstone/);
	assert.deepEqual(board, before, 'the all-tombstone refusal leaves the WHOLE board byte-identical (no new slot)');
	assert.equal(countId(board, 'W-rev-1'), 2, 'no third same-id slot was added');
	assert.equal(countId(board, 'W-rev-2'), 0, 'no reviewer was invented');
	assert.deepEqual(board.tasks.map(t => t.id), before.tasks.map(t => t.id), 'the id set is exactly the legacy one');
	// The legacy duplicate already blocks global registration before our call (the state this refusal protects,
	// not one it created). Prove only that the refusal adds nothing: registration stays refused by the PRE-EXISTING
	// duplicate, and no fresh task materialised.
	assert.throws(() => addTasks(board, [{
		title: 'fresh follow-up after refusal', role: 'bridges', requestIds: [worker.requestIds[0]], dependsOn: [],
		readPaths: [join(ROOT, 'src')], writePaths: [join(ROOT, 'src')], acceptance: ['x'], id: 'W-fresh-9',
	}], ROOT), /Duplicate task id .*W-rev-1/, 'the pre-existing duplicate (found on entry) still blocks registration');
	assert.equal(countId(board, 'W-fresh-9'), 0, 'the ledger refused before adding anything');
	// The supported recovery path migrates a mixed board FIRST, and a fresh id is then registrable beside it.
	const mixed = boardWithDeliveredWorker();
	const survivor = createReviewerTask(mixed.board, mixed.worker);
	const legacyDup = structuredClone(survivor);
	legacyDup.status = 'done';
	legacyDup.archivedAt = '2026-01-01T00:00:00.000Z';
	legacyDup.reviewAttemptId = 'legacy-dup';
	legacyDup.reviewedDeliveryVersion = '';
	legacyDup.reviewHistory = [];
	mixed.board.tasks.push(legacyDup);
	createReviewerTask(mixed.board, mixed.worker);
	assert.equal(canonicalReviewSlots(mixed.board, 'W-rev-1').length, 1, 'a real migration leaves exactly one executable slot');
	assert.equal(addTasks(mixed.board, [{
		title: 'after real migration', role: 'bridges', requestIds: [mixed.worker.requestIds[0]], dependsOn: [],
		readPaths: [join(ROOT, 'src')], writePaths: [join(ROOT, 'src')], acceptance: ['y'], id: 'W-fresh-10',
	}], ROOT).length, 1, 'addTasks succeeds after a real migration');
});

test('reviewerTaskId/isReviewTask helpers keep their contract', () => {
	const { board, worker } = boardWithDeliveredWorker();
	const rev = createReviewerTask(board, worker);
	assert.equal(reviewerTaskId(worker.id), 'W-rev-1');
	assert.equal(rev.id, reviewerTaskId(worker.id));
	assert.equal(isReviewTask(rev), true);
	assert.equal(isReviewTask(worker), false);
	assert.equal(rev.parentTaskId, worker.id);
	assert.deepEqual(rev.dependsOn, [worker.id]);
	assert.deepEqual(rev.writePaths, []);
	assert.equal(rev.declaredReadOnly, true);
});

const total = passed + failures.length;
console.log(`\n${passed}/${total} review lifecycle safety tests passed (tmp=${ROOT})`);
if (failures.length) {
	console.error(`FAILED: ${failures.join('; ')}`);
	process.exit(1);
}