import { strict as assert } from 'node:assert';
import { extractStructuredEvidence, mergeStructuredEvidence, structuredCommandRefs, REPORT_INLINE_CLIP, newLedger, addRequest, addTasks, updateTask, autoAcceptTask } from '../team-ledger.ts';
import { collectEvidenceRefs } from '../team-review-evidence.ts';
let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };

test('extractStructuredEvidence normalizes commands, counts, artifacts and sha from free report text', () => {
	const text = [
		'Implemented the feature in src/foo.ts:12 and src/bar.ts.',
		'Ran `npx tsx --test tests/test-foo.ts` — 15 passed, 0 failed.',
		'committed as commit abc1234def.',
		'Also ran `npm test` exit code 0.',
	].join('\n');
	const refs = collectEvidenceRefs(text, '/repo');
	const out = extractStructuredEvidence(text, refs, { now: 'T' });
	assert.ok(out.commands.length >= 1, `expected commands, got ${JSON.stringify(out)}`);
	const testCmd = out.commands.find(c => c.command.includes('tsx'));
	assert.ok(testCmd, 'tsx command row exists');
	// rework-L2: report-global counts are NOT per-command facts — with TWO command rows present,
	// no row may carry them (ambiguous attribution). The single-command case is asserted below.
	assert.equal(testCmd!.counts, undefined, 'multi-command reports never attach global counts per row');
	assert.equal(out.gitSha, 'abc1234def');
	assert.ok(out.artifacts.some(a => a.includes('src/foo.ts')), `artifacts: ${out.artifacts.join(',')}`);
	assert.equal(out.sourceLength, text.length);
});

test('rework-L2: global counts attach only to a single unambiguous command row', () => {
	const text = 'Ran `npx tsx --test tests/test-foo.ts` — 15 passed, 0 failed.';
	const refs = collectEvidenceRefs(text, '/repo');
	const out = extractStructuredEvidence(text, refs, { now: 'T' });
	assert.equal(out.commands.length, 1, `exactly one row: ${JSON.stringify(out.commands.map(c => c.command))}`);
	assert.equal(out.commands[0].counts?.pass, 15);
	assert.equal(out.commands[0].counts?.fail, 0);
});

test('exit code is only set when the command was harness-observed', () => {
	const text = 'Ran `npm test` — exit 0. All green.';
	const refs = collectEvidenceRefs(text, '/repo');
	const unobserved = extractStructuredEvidence(text, refs);
	assert.equal(unobserved.commands[0]?.exitCode, undefined, 'unobserved command never gains a trusted exit code');
	const observed = extractStructuredEvidence(text, refs, { observedCommands: ['cd /repo && npm test'] });
	assert.equal(observed.commands[0]?.exitCode, 0, 'observed clean command recorded as exit 0');
	const failed = extractStructuredEvidence(text, refs, { observedCommands: ['npm test'], observedFailures: ['npm test'] });
	assert.equal(failed.commands[0]?.exitCode, 1);
});

test('fullReportPath is carried in the structured record', () => {
	const refs = collectEvidenceRefs('ran `npm test`', '/repo');
	const out = extractStructuredEvidence('x'.repeat(REPORT_INLINE_CLIP + 50) + '\nran `npm test`', refs, { fullReportPath: '/tmp/report.md' });
	assert.equal(out.fullReportPath, '/tmp/report.md');
	assert.ok(out.sourceLength > REPORT_INLINE_CLIP);
});

test('mergeStructuredEvidence keeps older rows and prefers newer exit codes, never drops artifacts', () => {
	const a = extractStructuredEvidence('ran `npm test`\nwrote src/a.ts', collectEvidenceRefs('ran `npm test`\nwrote src/a.ts', '/repo'));
	const b = extractStructuredEvidence('ran `npm test` again\nwrote src/b.ts', collectEvidenceRefs('ran `npm test` again\nwrote src/b.ts', '/repo'), { observedCommands: ['npm test'] });
	const merged = mergeStructuredEvidence(a, b);
	const row = merged.commands.find(c => c.command === 'npm test');
	assert.equal(row?.exitCode, 0, 'incoming observed exit code wins');
	assert.ok(merged.artifacts.some(p => p.includes('src/a.ts')) && merged.artifacts.some(p => p.includes('src/b.ts')));
});

test('structuredCommandRefs yields verifyEvidenceRefs-compatible rows preferring first-class records', () => {
	const out = extractStructuredEvidence('ran `npm test` exit 0', collectEvidenceRefs('ran `npm test` exit 0', '/repo'));
	const rows = structuredCommandRefs(out);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].kind, 'command');
	assert.equal(rows[0].command, 'npm test');
	assert.deepEqual(structuredCommandRefs(undefined), []);
});

test('autoAcceptTask prefers structured observed exit codes over prose', () => {
	const fixture = () => {
		const b = newLedger();
		const q = addRequest(b, 'build the thing', 'input:1');
		addTasks(b, [{
			id: 'W-1', title: 'run tests', role: 'ayton', requestIds: [q.id], dependsOn: [],
			readPaths: [], writePaths: ['tests/x.ts'], acceptance: ['exit code 0'],
			reviewTier: 'deterministic', autoAccept: true,
		}], '/repo');
		const task = b.tasks.find(t => t.id === 'W-1')!;
		task.status = 'reported';
		return { b, task };
	};
	// No structured rows: prose fallback still applies (legacy behavior).
	{
		const { b } = fixture();
		assert.equal(autoAcceptTask(b, 'W-1', ['npm test exit 0'], { cleanExit: true, cwd: '/repo' }), true);
	}
	// An observed NONZERO exit code vetoes even when prose claims exit 0.
	{
		const { b, task } = fixture();
		task.structuredEvidence = { commands: [{ command: 'npm test', exitCode: 2 }], artifacts: [], sourceLength: 10, extractedAt: 'T' };
		assert.equal(autoAcceptTask(b, 'W-1', ['npm test exit 0'], { cleanExit: true, cwd: '/repo' }), false, 'observed nonzero exit vetoes prose exit-0 claim');
	}
	// An observed clean exit accepts even when prose never mentions exit 0.
	{
		const { b, task } = fixture();
		task.structuredEvidence = { commands: [{ command: 'npm test', exitCode: 0 }], artifacts: [], sourceLength: 10, extractedAt: 'T' };
		assert.equal(autoAcceptTask(b, 'W-1', ['tests completed'], { cleanExit: true, cwd: '/repo' }), true, 'observed exit 0 accepts without prose exit-0 mention');
	}
});

console.log(`\n${passed} assertions passed`);
