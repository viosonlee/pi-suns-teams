import { strict as assert } from 'node:assert';
import {
	amendTask,
	classifyUserInput, addRequest, addTasks, newLedger, uncoveredRequests, completionBlockers,
	consecutiveReworkCount, recordReview, createReviewerTask, updateTask, deliveryVersionOf,
	CONSECUTIVE_REWORK_BRAKE, CONSECUTIVE_REWORK_BRAKE_EXPLICIT, extractStructuredEvidence, ledgerPrompt,
	REWORK_BRAKE_PREFIX, drainSettlementAllowed, prunableReportArtifacts, referencedReportArtifacts,
} from '../team-ledger.ts';
import { collectEvidenceRefs, verifyEvidenceRefs } from '../team-review-evidence.ts';
let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };

function workerBoard(): { board: ReturnType<typeof newLedger>; wid: string } {
	const board = newLedger('/repo');
	const req = addRequest(board, 'do the work', 'input:Q-1');
	addTasks(board, [{
		id: 'W-1', title: 'implement feature', role: 'bridges', requestIds: [req.id],
		dependsOn: [], readPaths: ['/repo/src'], writePaths: ['/repo/src/x.ts'],
		acceptance: ['src/x.ts exists'],
	}], '/repo');
	return { board, wid: 'W-1' };
}

let round = 0;
function deliverAndReview(board: ReturnType<typeof newLedger>, wid: string, verdict: 'REWORK' | 'PASS', opts?: { reviewerRole?: string; reviewTier?: 'llm' | 'none' | 'advisory'; findings?: string[] }) {
	const worker = board.tasks.find(t => t.id === wid)!;
	if (opts?.reviewerRole) worker.reviewerRole = opts.reviewerRole;
	if (opts?.reviewTier) worker.reviewTier = opts.reviewTier;
	round++;
	worker.runId = `run-${round}`;
	worker.sessionId = `sess-${round}`;
	worker.dispatchedAt = new Date().toISOString();
	worker.status = 'reported';
	createReviewerTask(board, worker, 'cp');
	const rev = board.tasks.find(t => t.id === `W-rev-${wid.replace(/^W-/, '')}`) ?? board.tasks.find(t => t.parentTaskId === wid);
	if (!rev) throw new Error('review slot missing');
	rev.status = 'running';
	const findings = opts?.findings ?? [`finding-${round}-${Math.random()}`];
	recordReview(board, {
		reviewTaskId: rev.id, workerTaskId: wid, verdict,
		checks: [], defects: findings, nextActions: [], raw: `VERDICT: ${verdict}\n${findings.join('\n')}`,
		parsed: true, reasons: [], deliveryVersion: deliveryVersionOf(worker),
		attemptId: rev.reviewAttemptId,
		createdAt: new Date().toISOString(),
	}, { deliveryVersion: deliveryVersionOf(worker), fingerprint: `fp-${round}-${Math.random()}` });
	return rev;
}

// ── R1 (rework prompt) — misclassification must never drop real work; steering tokens are work ──
test('R1: critical/emergency imperatives classify as work, never feedback', () => {
	for (const t of [
		'stop everything now',
		'this is critical and broken',
		'continue', 'go ahead', 'proceed', 'carry on', 'keep going', 'sure', 'yes',
		'thanks, now fix the build',
	]) {
		assert.equal(classifyUserInput(t), 'work', JSON.stringify(t));
	}
	// genuine acknowledgements still absorb
	for (const t of ['thanks!', 'thank you', 'great', 'ok', 'lgtm', 'sounds good']) {
		assert.equal(classifyUserInput(t), 'feedback', JSON.stringify(t));
	}
});

// ── R3/R4 — feedback absorbed at ingestion; mixed input is a full-text work request, never orphan ──
test('R3+R4: feedback requests are closed bookkeeping at ingestion; nothing leaks or orphans', () => {
	const board = newLedger('/repo');
	const fb = addRequest(board, 'thanks!', 'input:Q-1', 'feedback');
	assert.equal(fb.status, 'done', 'feedback absorbed at ingestion — no open entry can accumulate');
	assert.ok(fb.evidence.length > 0 && fb.evidence[0].includes('FEEDBACK ABSORBED'));
	const mixed = addRequest(board, 'thanks, now fix the build', 'input:Q-2', 'user');
	assert.equal(mixed.status, 'open', 'mixed input registered as full-text work request');
	assert.ok(completionBlockers(board).some(b => b.startsWith(mixed.id)), 'mixed request is a visible obligation — never silently orphaned');
	// no open feedback entry can ever exist
	assert.equal(board.requests.filter(r => r.kind === 'feedback' && r.status === 'open').length, 0);
});

test('R4b: uncoveredRequests counts user requests only — goal/feedback never trigger the banner', () => {
	const board = newLedger('/repo');
	addRequest(board, 'internal goal prompt text', 'goal:kickoff', 'goal');
	addRequest(board, 'thanks!', 'input:Q-x', 'feedback');
	assert.equal(uncoveredRequests(board).length, 0);
	addRequest(board, 'real user objective', 'input:Q-y', 'user');
	assert.equal(uncoveredRequests(board).length, 1);
});

// ── R5 — brake threshold: 2 for automatic lanes, 4 for explicit reviewer lanes ──
test('R5: hard brake at 2 consecutive rounds for automatic review lanes', () => {
	const { board, wid } = workerBoard();
	deliverAndReview(board, wid, 'REWORK');
	assert.equal(board.tasks.find(t => t.id === wid)!.status, 'ready');
	deliverAndReview(board, wid, 'REWORK');
	const worker = board.tasks.find(t => t.id === wid)!;
	assert.equal(worker.status, 'blocked');
	assert.ok(worker.evidence.some(e => e.includes(REWORK_BRAKE_PREFIX)));
});

test('R5: explicit reviewer lane (reviewerRole) gets the raised threshold of 4', () => {
	const { board, wid } = workerBoard();
	// rounds 1-2: no brake yet even at the automatic cap
	deliverAndReview(board, wid, 'REWORK', { reviewerRole: 'cp' });
	deliverAndReview(board, wid, 'REWORK', { reviewerRole: 'cp' });
	assert.equal(board.tasks.find(t => t.id === wid)!.status, 'ready', 'explicit lane survives the automatic cap of 2');
	// rounds 3-4: brake at 4
	deliverAndReview(board, wid, 'REWORK', { reviewerRole: 'cp' });
	deliverAndReview(board, wid, 'REWORK', { reviewerRole: 'cp' });
	assert.equal(board.tasks.find(t => t.id === wid)!.status, 'blocked');
	assert.ok(board.tasks.find(t => t.id === wid)!.evidence.some(e => e.includes('explicit reviewer lane')));
	assert.equal(CONSECUTIVE_REWORK_BRAKE_EXPLICIT, 4);
	assert.equal(CONSECUTIVE_REWORK_BRAKE, 2);
});

test('R5b: explicit lane is NOT exempt — the treadmill still terminates', () => {
	const { board, wid } = workerBoard();
	for (let i = 0; i < 4; i++) deliverAndReview(board, wid, 'REWORK', { reviewTier: 'llm' });
	assert.equal(board.tasks.find(t => t.id === wid)!.status, 'blocked', 'even explicit reviewTier:llm caps at 4');
});

// ── M2 — advisory flag is stamped on the receipt itself, durable across slot reuse ──
test('M2: advisory receipts carry the durable advisory flag on the record', () => {
	const board = newLedger('/repo');
	const req = addRequest(board, 'advisory target', 'input:Q-1');
	addTasks(board, [{
		id: 'W-1', title: 'implement with advisory review', role: 'bridges', requestIds: [req.id],
		dependsOn: [], readPaths: ['/repo/src'], writePaths: ['/repo/src/x.ts'],
		acceptance: ['src/x.ts exists'], reviewTier: 'advisory',
	}], '/repo');
	const worker = board.tasks.find(t => t.id === 'W-1')!;
	worker.status = 'reported';
	const rev = createReviewerTask(board, worker, 'cp');
	assert.ok(rev.reviewAdvisory, 'slot carries the advisory hint');
	rev.status = 'reported';
	recordReview(board, {
		reviewTaskId: rev.id, workerTaskId: 'W-1', verdict: 'REWORK',
		checks: [], defects: ['cosmetic'], nextActions: [], raw: 'VERDICT: REWORK\nnon-gating',
		parsed: true, reasons: [], deliveryVersion: deliveryVersionOf(worker),
		createdAt: new Date().toISOString(),
	}, { deliveryVersion: deliveryVersionOf(worker), fingerprint: 'fp-a' });
	const receipt = board.reviewRecords!.find(r => r.workerTaskId === 'W-1')!;
	assert.equal(receipt.advisory, true, 'receipt itself carries the durable flag');
	// Even with the slot gone, consecutive count must exclude advisory receipts.
	for (const t of board.tasks) if (t.id === rev.id) t.status = 'superseded' as any;
	assert.equal(consecutiveReworkCount(board, 'W-1'), 0);
	// Worker settlement lane never gated
	assert.equal(worker.status, 'reported');
});

// ── H4 — exit-code attribution is segment-exact, never substring-loose ──
test('H4: cited commands inherit observed exits only at shell-segment boundaries', () => {
	const refs = collectEvidenceRefs('ran `npm test`', '/repo');
	// exact segment inside a composite line → inherits
	const composite = extractStructuredEvidence('ran `npm test`', refs, { observedCommands: ['cd /repo && npm test'] });
	assert.equal(composite.commands[0]?.exitCode, 0);
	// citation carries extra args — never inherits the exit of the bare command
	const loose = extractStructuredEvidence('ran `npm test --reporter=x`', collectEvidenceRefs('ran `npm test --reporter=x`', '/repo'), { observedCommands: ['npm test'] });
	assert.equal(loose.commands[0]?.exitCode, undefined, 'npm test --reporter=x must not inherit npm test exit');
	// failed observation wins over a clean observation of the same command
	const failed = extractStructuredEvidence('ran `npm test`', refs, { observedCommands: ['npm test'], observedFailures: ['npm test'] });
	assert.equal(failed.commands[0]?.exitCode, 1);
});

// ── M1 — verifyEvidenceRefs prefers worker-observed commands over unverifiable ──
test('M1: command citations verify against worker-side harness observation', () => {
	const refs = [{ kind: 'command' as const, raw: 'npm test', command: 'npm test' }];
	const without = verifyEvidenceRefs(refs, { cwd: '/repo', observedCommands: [] });
	assert.equal(without.verified.length, 0);
	assert.ok(without.unverifiable.length >= 1);
	const withWorker = verifyEvidenceRefs(refs, { cwd: '/repo', observedCommands: [], workerObservedCommands: ['cd /repo && npm test'] });
	assert.equal(withWorker.verified.length, 1);
	assert.ok(withWorker.verified[0].includes('[worker-observed]'));
});

// ── R2 — compact prompt caps acceptance verbosity ──
test('R2: compact ledger prompt caps acceptance to short references with remainder counts', () => {
	const board = newLedger('/repo');
	const req = addRequest(board, 'obj', 'input:Q-1');
	const longCriteria = Array.from({ length: 8 }, (_, i) => `criterion-${i}-${'x'.repeat(200)}`);
	addTasks(board, [{
		id: 'W-1', title: 'big acceptance', role: 'bridges', requestIds: [req.id],
		dependsOn: [], readPaths: ['/repo/src'], writePaths: ['/repo/src/x.ts'],
		acceptance: longCriteria,
		splitWaiverReason: 'test needs verbose acceptance payload',
	}], '/repo');
	const full = ledgerPrompt(board, 20, []);
	const compact = ledgerPrompt(board, 20, [], { compact: true });
	assert.ok(compact.includes('+5 more acceptance criteria'), 'compact caps at 3 with remainder count');
	assert.ok(!compact.includes(longCriteria[0]), 'long criterion body trimmed in compact mode');
	assert.ok(full.includes(longCriteria[0]), 'full injection keeps acceptance verbatim');
});

// ── R6 — rework dispatch never clobbers the ledger brief (prompt composition verified statically) ──
test('R6: amendTask brief history survives and the brief field is the single mutable source', () => {
	
	const { board, wid } = workerBoard();
	const worker = board.tasks.find(t => t.id === wid)!;
	worker.brief = 'worker-authored operational guidance';
	amendTask(board, { id: wid, brief: 'parent rework assignment', reason: 'rework round', evidence: ['review'], by: 'parent' });
	const after = board.tasks.find(t => t.id === wid)!;
	assert.equal(after.brief, 'parent rework assignment');
	assert.ok((after.briefHistory ?? []).length >= 1, 'prior brief preserved in append-only history');
	assert.equal(after.briefHistory![after.briefHistory!.length - 1].prior?.brief, 'worker-authored operational guidance');
});

// ── H2 — drain settlement filter: in-flight workers' reviews pass, new work parks ──
test('H2: drain settlement filter admits only reviews of mid-flight workers', () => {
	const board = newLedger('/repo');
	const req = addRequest(board, 'drain obj', 'input:Q-1');
	addTasks(board, [
		{ id: 'W-1', title: 'running worker', role: 'bridges', requestIds: [req.id], dependsOn: [], readPaths: [], writePaths: ['/repo/a.ts'], acceptance: ['a'] },
		{ id: 'W-2', title: 'queued fresh work', role: 'bridges', requestIds: [req.id], dependsOn: [], readPaths: [], writePaths: ['/repo/b.ts'], acceptance: ['b'] },
	], '/repo');
	const w1 = board.tasks.find(t => t.id === 'W-1')!;
	w1.status = 'running';
	addTasks(board, [{ id: 'W-rev-1', title: 'review', role: 'cp', requestIds: [req.id], dependsOn: [], readPaths: [], writePaths: [], acceptance: ['v'], parentTaskId: 'W-1' }], '/repo');
	const rev = board.tasks.find(t => t.id === 'W-rev-1')!;
	assert.equal(drainSettlementAllowed(rev, board), true, 'review of running worker settles during drain');
	const w2 = board.tasks.find(t => t.id === 'W-2')!;
	assert.equal(drainSettlementAllowed(w2, board), false, 'fresh work never launches during drain');
	w1.status = 'done';
	assert.equal(drainSettlementAllowed(rev, board), false, 'review of a settled worker is NEW work and parks');
});

// ── M2-prune — referenced evidence is never prunable; orphans age out ──
test('M2-prune: report artifacts referenced by live tasks are never prunable', () => {
	const board = newLedger('/repo');
	const req = addRequest(board, 'prune obj', 'input:Q-1');
	addTasks(board, [{ id: 'W-1', title: 't', role: 'bridges', requestIds: [req.id], dependsOn: [], readPaths: [], writePaths: ['/repo/a.ts'], acceptance: ['a'] }], '/repo');
	const w = board.tasks.find(t => t.id === 'W-1')!;
	w.status = 'reported';
	w.structuredEvidence = { commands: [], artifacts: [], fullReportPath: '/x/team-reports/W-1-live.md', extractedAt: 'now' };
	const day = 24 * 60 * 60_000;
	const entries = [
		{ path: '/x/team-reports/W-1-live.md', mtimeMs: 1_000_000 },
		{ path: '/x/team-reports/W-9-orphan-old.md', mtimeMs: 1_000_000 },
		{ path: '/x/team-reports/W-9-orphan-fresh.md', mtimeMs: 1_000_000 + day },
	];
	const now = 1_000_000 + day + 1000;
	const prunable = prunableReportArtifacts(board, entries, { minAgeMs: day, nowMs: now });
	assert.deepEqual(prunable, ['/x/team-reports/W-9-orphan-old.md'], 'only unreferenced AND aged-out files prune');
	assert.ok(referencedReportArtifacts(board).has('/x/team-reports/W-1-live.md'));
	// terminal task releases its pin
	w.status = 'done';
	const prunable2 = prunableReportArtifacts(board, entries, { minAgeMs: day, nowMs: now });
	assert.ok(prunable2.includes('/x/team-reports/W-1-live.md'), 'settled chains release their evidence pin');
});

console.log(`\n${passed} assertions passed`);
