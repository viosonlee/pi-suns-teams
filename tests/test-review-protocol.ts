import { strict as assert } from 'node:assert';
import { parseReviewReport, reviewSummary, buildReviewerPrompt } from '../team-review.ts';

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };

const ACC = ['scheduler releases review slots', 'full report retained'];

test('missing verdict header is INCOMPLETE, never PASS', () => {
	const out = parseReviewReport('I looked at the code and everything seems fine. All tests pass. Nothing to report.', ACC);
	assert.equal(out.verdict, 'INCOMPLETE');
	assert.equal(out.parsed, false);
	assert.ok(out.reasons.includes('missing_verdict'));
});

test('prose mentioning PASS without a line-anchored header is not a verdict', () => {
	const out = parseReviewReport('The worker wrote VERDICT: PASS in its own report, but I did not verify anything.', ACC);
	assert.equal(out.verdict, 'INCOMPLETE');
	assert.equal(out.parsed, false);
});

test('PASS with a failing criterion is downgraded to INCOMPLETE', () => {
	const out = parseReviewReport([
		'VERDICT: PASS',
		'CRITERION: scheduler releases review slots => FAIL | evidence: team.ts:3814 still counts reviewing',
		'CRITERION: full report retained => PASS | evidence: team.ts:1256',
	].join('\n'), ACC);
	assert.equal(out.verdict, 'INCOMPLETE');
	assert.ok(out.reasons.includes('pass_without_verified_evidence'));
	assert.equal(out.checks[0].status, 'fail');
});

test('PASS with a complete verified checklist stays PASS', () => {
	const out = parseReviewReport([
		'VERDICT: PASS',
		'CRITERION: scheduler releases review slots => PASS | evidence: team-ledger.ts:26 occupiesSlot',
		'CRITERION: full report retained => PASS | evidence: team.ts:1250 stores raw',
		'no failures were observed in the diff',
	].join('\n'), ACC);
	assert.equal(out.verdict, 'PASS');
	assert.equal(out.checks.length, 2);
});

test('report containing "no failures" is not misread as REWORK', () => {
	const out = parseReviewReport([
		'VERDICT: PASS',
		'CRITERION: scheduler releases review slots => PASS | evidence: node team-tests/test-team-ledger.ts exit 0',
		'CRITERION: full report retained => PASS | evidence: raw field preserved in team-review.ts',
		'DEFECTS:',
		'- none, no failures found',
	].join('\n'), ACC);
	assert.equal(out.verdict, 'PASS');
	assert.ok(!out.reasons.includes('no_defects_listed'));
});

test('plain REWORK carries defects and next actions', () => {
	const out = parseReviewReport([
		'VERDICT: REWORK',
		'CRITERION: scheduler releases review slots => FAIL | evidence: team.ts:1279 counts liveWork',
		'CRITERION: full report retained => UNVERIFIED | evidence: no persistence test',
		'DEFECTS:',
		'- reviewing tasks still occupy a slot',
		'NEXT:',
		'- count only running tasks in runningCount()',
	].join('\n'), ACC);
	assert.equal(out.verdict, 'REWORK');
	assert.deepEqual(out.defects, ['reviewing tasks still occupy a slot']);
	assert.deepEqual(out.nextActions, ['count only running tasks in runningCount()']);
});

test('REWORK without defects is flagged', () => {
	const out = parseReviewReport('VERDICT: REWORK\nCRITERION: x => FAIL | evidence: none', ACC);
	assert.equal(out.verdict, 'REWORK');
	assert.ok(out.reasons.includes('no_defects_listed'));
});

test('ESCALATE is recognised and needs a reason', () => {
	const ok = parseReviewReport('VERDICT: ESCALATE\nDEFECTS:\n- acceptance criteria contradict each other', ACC);
	assert.equal(ok.verdict, 'ESCALATE');
	assert.ok(!ok.reasons.includes('no_escalation_reason'));
	const bare = parseReviewReport('VERDICT: ESCALATE', ACC);
	assert.ok(bare.reasons.includes('no_escalation_reason'));
});

test('explicit INCOMPLETE is preserved', () => {
	const out = parseReviewReport('VERDICT: INCOMPLETE\nCRITERION: scheduler releases review slots => UNVERIFIED | evidence: could not run tests', ACC);
	assert.equal(out.verdict, 'INCOMPLETE');
	assert.equal(out.reasons.includes('missing_verdict'), false);
});

test('markdown-bolded and backticked verdict headers still parse', () => {
	for (const text of ['**VERDICT:** PASS', 'VERDICT: `PASS`', '> VERDICT: PASS', '- VERDICT: PASS', '  verdict:   pass  ']) {
		const out = parseReviewReport(`${text}\nCRITERION: scheduler releases review slots => PASS | evidence: team-ledger.ts:26\nCRITERION: full report retained => PASS | evidence: team.ts:1250`, ACC);
		assert.equal(out.parsed, true, text);
		assert.equal(out.verdict, 'PASS', text);
	}
});

test('checklist shorter than acceptance is INCOMPLETE even when it says PASS', () => {
	const out = parseReviewReport('VERDICT: PASS\nCRITERION: scheduler releases review slots => PASS | evidence: team-ledger.ts:26', ACC);
	assert.equal(out.verdict, 'INCOMPLETE');
	assert.ok(out.reasons.some(r => r.startsWith('unmatched_criteria:AC2')), out.reasons.join(','));
});

test('PASS with zero checks is INCOMPLETE', () => {
	const out = parseReviewReport('VERDICT: PASS\nLooks good to me, everything works.', ACC);
	assert.equal(out.verdict, 'INCOMPLETE');
	assert.ok(out.reasons.includes('no_criteria_checked'));
});

test('conflicting verdict lines are flagged and the first one wins', () => {
	const out = parseReviewReport('VERDICT: PASS\nVERDICT: REWORK\nCRITERION: scheduler releases review slots => PASS | evidence: team-ledger.ts:26\nCRITERION: full report retained => PASS | evidence: team.ts:1250', ACC);
	assert.ok(out.reasons.includes('multiple_conflicting_verdicts'));
	assert.equal(out.verdict, 'PASS');
});

test('raw report is preserved verbatim and never truncated', () => {
	const long = `${'x'.repeat(5000)}\nVERDICT: PASS\nCRITERION: scheduler releases review slots => PASS | evidence: team-ledger.ts:26\nCRITERION: full report retained => PASS | evidence: team.ts:1250`;
	const out = parseReviewReport(long, ACC);
	assert.equal(out.raw.length, long.length);
	assert.equal(out.raw, long);
});

test('reviewSummary mentions the verdict and check counts', () => {
	const out = parseReviewReport('VERDICT: REWORK\nCRITERION: scheduler releases review slots => FAIL | evidence: team.ts:3814 counts reviewing\nCRITERION: full report retained => PASS | evidence: team.ts:1250\nDEFECTS:\n- broken', ACC);
	const summary = reviewSummary(out);
	assert.ok(summary.includes('VERDICT: REWORK'));
	assert.ok(summary.includes('checks=2'));
	assert.ok(summary.includes('broken'));
});

test('buildReviewerPrompt demands structured output and treats worker report as a claim', () => {
	const prompt = buildReviewerPrompt({
		taskId: 'W-46', title: 'integration', acceptance: ACC,
		workerReport: 'done, all tests pass', deliveryPaths: ['extensions/team.ts'],
		deliveryVersion: 'v1', baseVersion: 'v0',
	});
	assert.ok(prompt.includes('VERDICT: PASS | REWORK | ESCALATE | INCOMPLETE'));
	assert.ok(prompt.includes('AC1. scheduler releases review slots'));
	assert.ok(prompt.includes('not evidence'));
	assert.ok(prompt.includes('done, all tests pass'));
});

test('AC1: / AC1 — markdown checklist with continuation evidence line parses cleanly as PASS', () => {
	const report = [
		'VERDICT: PASS',
		'',
		'- **AC1 — scheduler releases review slots: PASS.**',
		'  `team-ledger.ts:26` releases the slot when status is reviewing.',
		'',
		'- **AC2 — full report retained: PASS.**',
		'  `team.ts:1250` stores verbatim raw text without slicing.',
	].join('\n');
	const out = parseReviewReport(report, ACC);
	assert.equal(out.verdict, 'PASS');
	assert.equal(out.checks.length, 2);
	assert.equal(out.unmatched.length, 0);
	assert.equal(out.checks[0].acceptanceIndex, 0);
	assert.equal(out.checks[1].acceptanceIndex, 1);
	assert.ok(out.checks[0].evidence.includes('team-ledger.ts:26'));
	assert.ok(out.checks[1].evidence.includes('team.ts:1250'));
});

test('CRITERION: AC1 prefix binds explicit index while prose starting with AC is ignored', () => {
	const report = [
		'VERDICT: PASS',
		'AC power stayed online during test.',
		'Acceptance tests ran cleanly.',
		'CRITERION: AC1 scheduler releases review slots => PASS | evidence: team-ledger.ts:26',
		'CRITERION: AC2 full report retained => PASS | evidence: team.ts:1250',
	].join('\n');
	const out = parseReviewReport(report, ACC);
	assert.equal(out.verdict, 'PASS');
	assert.equal(out.checks.length, 2);
	assert.equal(out.checks[0].acceptanceIndex, 0);
	assert.equal(out.checks[1].acceptanceIndex, 1);
});

test('compact CRITERION ACn: PASS — evidence with embedded arrows parses cleanly', () => {
	const report = [
		'VERDICT: PASS',
		'CRITERION AC1: PASS — team-ledger.ts:26 releases slot when reviewing',
		'CRITERION AC2: PASS — team.ts:1250 implements val < min -> min and retains raw text',
	].join('\n');
	const out = parseReviewReport(report, ACC);
	assert.equal(out.verdict, 'PASS');
	assert.equal(out.checks.length, 2);
	assert.equal(out.unmatched.length, 0);
	assert.equal(out.checks[0].acceptanceIndex, 0);
	assert.equal(out.checks[1].acceptanceIndex, 1);
	assert.equal(out.checks[1].status, 'pass');
	assert.ok(out.checks[1].evidence.includes('team.ts:1250'));
});

test('VERDICT: FAIL / REJECT maps safely to REWORK instead of missing_verdict', () => {
	const out = parseReviewReport('VERDICT: FAIL\nCRITERION AC1: FAIL — docs/API.md:10 missing edge case\nDEFECTS:\n- docs/API.md:10 incomplete', ACC);
	assert.equal(out.verdict, 'REWORK');
	assert.equal(out.parsed, true);
});

console.log(`\n${passed} review-protocol tests passed`);
