/**
 * Independent-review regression suite (review independence, evidence verification,
 * delivery↔artefact binding, and parent-role separation).
 *
 * These tests are deliberately about BEHAVIOUR that a mock verdict cannot fake:
 * - a criterion may only be satisfied by a DISTINCT check bound to it;
 * - a PASS must cite artefacts that really resolve on disk;
 * - a verdict arriving after the delivery changed is discarded, never applied;
 * - the parent session cannot mutate workspace files in delegated mode.
 */
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReviewReport, buildReviewerPrompt } from '../team-review.ts';
import { collectEvidenceRefs, verifyEvidenceRefs, hasCheckableEvidence } from '../team-review-evidence.ts';
import {
	newLedger, addRequest, addTasks, createReviewerTask, recordReview, deliveryVersionOf,
	hasValidReview, ledgerPrompt, readyTasks, publishTasks, type WorkLedger,
} from '../team-ledger.ts';
import { defaultConfig, mergeConfig, parentWriteBlocked, artefactFingerprint, PARENT_WRITE_TOOLS } from '../extensions/team.ts';

const require_exists = (p: string): boolean => { try { statSync(p); return true; } catch { return false; } };
const require_read = (p: string): string | null => { try { return readFileSync(p, 'utf8'); } catch { return null; } };

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };

const ACC = ['scheduler releases review slots', 'full report retained'];

// ───────────────────────── criterion ↔ check binding ─────────────────────────

test('two checks about AC1 do not satisfy AC2', () => {
	const out = parseReviewReport([
		'VERDICT: PASS',
		'CRITERION: scheduler releases review slots => PASS | evidence: team-ledger.ts:26',
		'CRITERION: scheduler releases review slots again => PASS | evidence: team-ledger.ts:26',
	].join('\n'), ACC);
	assert.equal(out.verdict, 'INCOMPLETE');
	assert.equal(out.unmatched.length, 1);
	assert.ok(out.reasons.some(r => r.startsWith('unmatched_criteria:AC2')), out.reasons.join(','));
});

test('duplicate explicit AC index is rejected instead of double-counted', () => {
	const out = parseReviewReport([
		'VERDICT: PASS',
		'CRITERION: 1 scheduler releases review slots => PASS | evidence: team-ledger.ts:26',
		'CRITERION: 1 full report retained => PASS | evidence: team.ts:1250',
	].join('\n'), ACC);
	assert.equal(out.verdict, 'INCOMPLETE');
	assert.ok(out.reasons.some(r => r.startsWith('duplicate_criterion_checks')), out.reasons.join(','));
});

test('paraphrased criterion still binds to its own slot', () => {
	const out = parseReviewReport([
		'VERDICT: PASS',
		'CRITERION: review slot release for reviewing tasks => PASS | evidence: team-ledger.ts:26',
		'CRITERION: report stored verbatim without truncation => PASS | evidence: team.ts:1250',
	].join('\n'), ACC);
	assert.equal(out.verdict, 'PASS');
});

test('checks are bound to distinct criterion indices', () => {
	const out = parseReviewReport([
		'VERDICT: PASS',
		'CRITERION: scheduler releases review slots => PASS | evidence: team-ledger.ts:26',
		'CRITERION: full report retained => PASS | evidence: team.ts:1250',
	].join('\n'), ACC);
	assert.deepEqual(out.checks.map(c => c.acceptanceIndex), [0, 1]);
});

test('prose evidence cannot produce a PASS', () => {
	const out = parseReviewReport([
		'VERDICT: PASS',
		'CRITERION: scheduler releases review slots => PASS | evidence: I checked it and it looks fine',
		'CRITERION: full report retained => PASS | evidence: tests pass',
	].join('\n'), ACC);
	assert.equal(out.verdict, 'INCOMPLETE');
	assert.ok(out.reasons.some(r => r.startsWith('evidence_not_machine_checkable')), out.reasons.join(','));
});

// ───────────────────────── evidence re-resolution ─────────────────────────

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'team-evidence-'));
	mkdirSync(join(root, 'src'), { recursive: true });
	writeFileSync(join(root, 'src', 'mod.ts'), ['line one', 'line two', 'line three'].join('\n') + '\n');
	return root;
}

test('file:line citations resolve against real files', () => {
	const root = fixture();
	const refs = collectEvidenceRefs('verified at src/mod.ts:2 and src/mod.ts:3', root);
	const audit = verifyEvidenceRefs(refs, { cwd: root, exists: p => require_exists(p), readFile: p => require_read(p) });
	assert.equal(refs.length, 2);
	assert.equal(audit.ok, true, JSON.stringify(audit));
	assert.equal(audit.failed.length, 0);
});

test('missing file and out-of-range line are failures, not silent passes', () => {
	const root = fixture();
	const missing = verifyEvidenceRefs(collectEvidenceRefs('see src/nope.ts:4', root), { cwd: root, exists: p => require_exists(p), readFile: p => require_read(p) });
	assert.equal(missing.ok, false);
	assert.ok(missing.failed[0].includes('missing file'));
	const outOfRange = verifyEvidenceRefs(collectEvidenceRefs('see src/mod.ts:99', root), { cwd: root, exists: p => require_exists(p), readFile: p => require_read(p) });
	assert.equal(outOfRange.ok, false);
	assert.ok(outOfRange.failed[0].includes('line out of range'), JSON.stringify(outOfRange));
});

test('command evidence must be an observed command', () => {
	const root = fixture();
	const refs = collectEvidenceRefs('ran: node test.ts --all', root);
	const unobserved = verifyEvidenceRefs(refs, { cwd: root });
	assert.equal(unobserved.verified.length, 0);
	assert.equal(unobserved.unverifiable.length, 1);
	const observed = verifyEvidenceRefs(refs, { cwd: root, observedCommands: ['/usr/bin/bash -lc "node test.ts --all"'] });
	assert.equal(observed.verified.length, 1);
});

test('hasCheckableEvidence rejects pure prose', () => {
	assert.equal(hasCheckableEvidence('looks correct to me'), false);
	assert.equal(hasCheckableEvidence('see team.ts:12'), true);
});

// ───────────────────────── delivery ↔ artefact binding ─────────────────────────

function boardWithWorker(): { board: WorkLedger; workerId: string } {
	const board = newLedger();
	const req = addRequest(board, 'ship the review gate', 'test');
	addTasks(board, [
		{ title: 'implement gate', requestIds: [req.id], role: 'bridges', dependsOn: [], readPaths: [], writePaths: ['src/'], acceptance: ACC },
		{ title: 'downstream', requestIds: [req.id], role: 'cameron', dependsOn: ['W-1'], readPaths: [], writePaths: [], acceptance: ['docs updated'] },
	], process.cwd());
	const worker = board.tasks[0];
	worker.status = 'reported';
	worker.runId = 'run-1';
	worker.sessionId = 'sess-1';
	worker.dispatchedAt = '2026-01-01T00:00:00.000Z';
	return { board, workerId: worker.id };
}

test('PASS applies when the pinned delivery is still the live one', () => {
	const { board } = boardWithWorker();
	const worker = board.tasks[0];
	const rev = createReviewerTask(board, worker, 'ayton', 'fp-1');
	const version = deliveryVersionOf(worker);
	const applied = recordReview(board, {
		reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'PASS', checks: [], defects: [], nextActions: [],
		raw: 'VERDICT: PASS', parsed: true, reasons: [], deliveryVersion: version, createdAt: new Date().toISOString(),
	}, { deliveryVersion: version, fingerprint: 'fp-1' });
	assert.equal(applied.workerTask.status, 'done');
	assert.equal(hasValidReview(board, worker), true);
});

test('a verdict that arrives after the worker was re-dispatched is discarded as STALE', () => {
	const { board } = boardWithWorker();
	const worker = board.tasks[0];
	const rev = createReviewerTask(board, worker, 'ayton', 'fp-1');
	const pinned = deliveryVersionOf(worker);
	// Worker was re-dispatched while the reviewer was still running.
	worker.runId = 'run-2';
	worker.retryCount = 1;
	const live = deliveryVersionOf(worker);
	assert.notEqual(pinned, live);
	const applied = recordReview(board, {
		reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'PASS', checks: [], defects: [], nextActions: [],
		raw: 'VERDICT: PASS', parsed: true, reasons: [], deliveryVersion: pinned, createdAt: new Date().toISOString(),
	}, { deliveryVersion: live, fingerprint: 'fp-1' });
	assert.equal(applied.workerTask.status, 'reported');
	assert.equal(board.reviewRecords?.at(-1)?.verdict, 'STALE');
	assert.ok(board.reviewRecords?.at(-1)?.reasons.some(r => r.startsWith('delivery_version_drift')));
	assert.equal(hasValidReview(board, worker), false);
	assert.equal(applied.reviewTask.status, 'superseded');
});

test('a verdict is discarded when the artefacts changed during review', () => {
	const { board } = boardWithWorker();
	const worker = board.tasks[0];
	const rev = createReviewerTask(board, worker, 'ayton', 'fp-1');
	const version = deliveryVersionOf(worker);
	const applied = recordReview(board, {
		reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'PASS', checks: [], defects: [], nextActions: [],
		raw: 'VERDICT: PASS', parsed: true, reasons: [], deliveryVersion: version, createdAt: new Date().toISOString(),
	}, { deliveryVersion: version, fingerprint: 'fp-2' });
	assert.equal(applied.workerTask.status, 'reported');
	assert.equal(board.reviewRecords?.at(-1)?.verdict, 'STALE');
	assert.ok(board.reviewRecords?.at(-1)?.reasons.some(r => r.startsWith('artefact_fingerprint_drift')));
});

test('artefact fingerprint changes when the delivered file changes', () => {
	const root = fixture();
	const before = artefactFingerprint(root, ['src']);
	writeFileSync(join(root, 'src', 'mod.ts'), 'changed\n');
	const after = artefactFingerprint(root, ['src']);
	assert.notEqual(before, after);
});

test('reviewer task ids stay unique across rework rounds', () => {
	const { board } = boardWithWorker();
	const worker = board.tasks[0];
	const first = createReviewerTask(board, worker, 'ayton', 'fp-1');
	recordReview(board, {
		reviewTaskId: first.id, workerTaskId: worker.id, verdict: 'REWORK', checks: [], defects: ['missing edge case'],
		nextActions: ['handle empty array'], raw: 'VERDICT: REWORK', parsed: true, reasons: [],
		deliveryVersion: deliveryVersionOf(worker), createdAt: new Date().toISOString(),
	});
	worker.runId = 'run-2';
	const second = createReviewerTask(board, worker, 'ayton', 'fp-2');
	assert.equal(second.id, first.id);
	assert.equal(board.tasks.filter(t => t.id === first.id).length, 1);
	assert.equal(second.reviewedDeliveryVersion, deliveryVersionOf(worker));
	assert.equal(second.reviewFingerprint, 'fp-2');
});

// ───────────────────────── parent role separation ─────────────────────────

test('delegated parent policy is the default and survives config merge', () => {
	assert.equal(defaultConfig().parentSoloWork, 'delegated');
	assert.equal(mergeConfig(defaultConfig(), {}).parentSoloWork, 'delegated');
	assert.equal(mergeConfig(defaultConfig(), { parentSoloWork: 'allow' }).parentSoloWork, 'allow');
	assert.equal(mergeConfig(defaultConfig(), { parentSoloWork: 'nonsense' }).parentSoloWork, 'delegated');
});

test('parent writes are blocked in delegated mode and allowed for children/allow mode', () => {
	for (const tool of PARENT_WRITE_TOOLS) {
		assert.equal(parentWriteBlocked({ enabled: true, parentSoloWork: 'delegated', isSubagent: false, toolName: tool }), true, tool);
	}
	assert.equal(parentWriteBlocked({ enabled: false, parentSoloWork: 'delegated', isSubagent: false, toolName: 'edit' }), false);
	assert.equal(parentWriteBlocked({ enabled: true, parentSoloWork: 'allow', isSubagent: false, toolName: 'edit' }), false);
	assert.equal(parentWriteBlocked({ enabled: true, parentSoloWork: 'delegated', isSubagent: true, toolName: 'edit' }), false);
	assert.equal(parentWriteBlocked({ enabled: true, parentSoloWork: 'delegated', isSubagent: false, toolName: 'read' }), false);
});

test('ledger prompt states the orchestrator role and refuses inline solving', () => {
	const board = newLedger();
	addRequest(board, 'fix the parser bug', 'test');
	const prompt = ledgerPrompt(board);
	assert.ok(/PARENT ROLE/.test(prompt));
	assert.ok(/does NOT implement features/.test(prompt));
	assert.ok(/NOTHING IS DISPATCHABLE/.test(prompt), 'empty ledger with an open request must demand registration, not inline work');
});

test('reviewer prompt demands independent artefact inspection and unique binding', () => {
	const prompt = buildReviewerPrompt({
		taskId: 'W-rev-1', title: 'review W-1', acceptance: ACC, workerReport: 'all good', deliveryPaths: ['src/'],
		deliveryVersion: 'v1', fingerprint: 'fp-1',
	});
	assert.ok(/Open every delivered file/.test(prompt));
	assert.ok(/git diff/.test(prompt));
	assert.ok(/different AC/.test(prompt));
	assert.ok(/fp-1/.test(prompt));
});

// ───────────────────────── end-to-end wiring (no mocked verdicts) ─────────────────────────

test('a real on-disk defect must be caught before downstream unlocks', () => {
	const root = fixture();
	const board = newLedger();
	const req = addRequest(board, 'implement boundary-safe sum', 'test');
	addTasks(board, [
		{ title: 'implement sum', requestIds: [req.id], role: 'bridges', dependsOn: [], readPaths: ['src/'], writePaths: ['src/'], acceptance: ['sum handles empty input', 'sum validates non-numeric input'] },
		{ title: 'consume sum', requestIds: [req.id], role: 'cameron', dependsOn: ['W-1'], readPaths: ['src/'], writePaths: [], acceptance: ['docs updated'] },
	], root);
	const worker = board.tasks[0];
	worker.status = 'reported';
	worker.runId = 'run-1';
	// The worker delivered a version that silently ignores the validation criterion.
	writeFileSync(join(root, 'src', 'sum.ts'), ['export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);'].join('\n') + '\n');
	const rev = createReviewerTask(board, worker, 'ayton', artefactFingerprint(root, ['src']));

	// The reviewer cites the real file and reports the unmet criterion.
	const report = [
		'VERDICT: REWORK',
		'CRITERION: sum handles empty input => PASS | evidence: src/sum.ts:1 reduce starts at 0',
		'CRITERION: sum validates non-numeric input => FAIL | evidence: src/sum.ts:1 no validation of element types',
		'DEFECTS:',
		'- src/sum.ts:1 accepts non-numeric elements without validation',
		'NEXT:',
		'- add element type validation in src/sum.ts before reduce',
	].join('\n');
	const parsed = parseReviewReport(report, worker.acceptance);
	assert.equal(parsed.verdict, 'REWORK');
	const refs = collectEvidenceRefs(parsed.checks.map(c => c.evidence).join('\n'), root);
	const audit = verifyEvidenceRefs(refs, { cwd: root, exists: p => require_exists(p), readFile: p => require_read(p) });
	assert.equal(audit.ok, true, JSON.stringify(audit));

	const rework = recordReview(board, {
		reviewTaskId: rev.id, workerTaskId: worker.id, verdict: parsed.verdict, checks: parsed.checks,
		defects: parsed.defects, nextActions: parsed.nextActions, raw: report, parsed: true, reasons: parsed.reasons,
		deliveryVersion: deliveryVersionOf(worker), evidenceAudit: audit, createdAt: new Date().toISOString(),
	}, { deliveryVersion: deliveryVersionOf(worker), fingerprint: rev.reviewFingerprint });
	assert.equal(rework.workerTask.status, 'ready');
	assert.ok(!readyTasks(board).some(t => t.id === 'W-2'), 'downstream stays locked while rework is pending');

	// The worker fixes the defect; a fresh review round is opened for the new delivery.
	writeFileSync(join(root, 'src', 'sum.ts'), [
		'export const sum = (xs: number[]) => {',
		'\tfor (const x of xs) if (typeof x !== "number" || Number.isNaN(x)) throw new TypeError("non-numeric input");',
		'\treturn xs.reduce((a, b) => a + b, 0);',
		'};',
	].join('\n') + '\n');
	worker.runId = 'run-2';
	worker.status = 'reviewing';
	const rev2 = createReviewerTask(board, worker, 'ayton', artefactFingerprint(root, ['src']));
	const passReport = [
		'VERDICT: PASS',
		'CRITERION: sum handles empty input => PASS | evidence: src/sum.ts:3 reduce over empty array returns 0',
		'CRITERION: sum validates non-numeric input => PASS | evidence: src/sum.ts:2 throws TypeError for non-numeric',
	].join('\n');
	const parsedPass = parseReviewReport(passReport, worker.acceptance);
	assert.equal(parsedPass.verdict, 'PASS', parsedPass.reasons.join(','));
	const passRefs = collectEvidenceRefs(parsedPass.checks.map(c => c.evidence).join('\n'), root);
	const passAudit = verifyEvidenceRefs(passRefs, { cwd: root, exists: p => require_exists(p), readFile: p => require_read(p) });
	assert.equal(passAudit.ok, true, JSON.stringify(passAudit));
	const accepted = recordReview(board, {
		reviewTaskId: rev2.id, workerTaskId: worker.id, verdict: parsedPass.verdict, checks: parsedPass.checks,
		defects: parsedPass.defects, nextActions: parsedPass.nextActions, raw: passReport, parsed: true,
		reasons: parsedPass.reasons, deliveryVersion: deliveryVersionOf(worker), evidenceAudit: passAudit,
		attemptId: rev2.reviewAttemptId,
		createdAt: new Date().toISOString(),
	}, { deliveryVersion: deliveryVersionOf(worker), fingerprint: rev2.reviewFingerprint });
	assert.equal(accepted.workerTask.status, 'done');
	publishTasks(board, ['W-2']);
	assert.ok(readyTasks(board).some(t => t.id === 'W-2'), 'downstream unlocks only after the real defect is fixed');
});

test('quoted relative import specifiers in evidence do not trigger false missing-file failures', () => {
	const root = fixture();
	writeFileSync(join(root, 'src', 'app.ts'), 'export const foo = 1;\n');
	const refs = collectEvidenceRefs("Verified at src/app.ts:1 (`import { foo } from '../src/app.ts'`).", root);
	const audit = verifyEvidenceRefs(refs, { cwd: root, exists: p => require_exists(p), readFile: p => require_read(p) });
	assert.equal(audit.ok, true, JSON.stringify(audit));
	assert.deepEqual(audit.failed, []);
});

test('artefactFingerprint stays stable when an unrelated file is committed in parallel', () => {
	const root = fixture();
	writeFileSync(join(root, 'src', 'app.ts'), 'export const foo = 1;\n');
	execFileSync('git', ['init', '-q'], { cwd: root });
	execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: root });
	execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
	execFileSync('git', ['add', '.'], { cwd: root });
	execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
	const before = artefactFingerprint(root, ['src/app.ts']);
	writeFileSync(join(root, 'UNRELATED.md'), 'parallel worker commit\n');
	execFileSync('git', ['add', 'UNRELATED.md'], { cwd: root });
	execFileSync('git', ['commit', '-q', '-m', 'unrelated parallel commit'], { cwd: root });
	const after = artefactFingerprint(root, ['src/app.ts']);
	assert.equal(before, after, 'unrelated commit on another file must not invalidate scope-pinned review fingerprint');
});

console.log(`\n${passed} independent-review tests passed`);
