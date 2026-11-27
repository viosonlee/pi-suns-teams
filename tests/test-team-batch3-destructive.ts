import { strict as assert } from 'node:assert';
import { newLedger, addRequest, addTasks, amendTask, markDispatched, detectDestructiveOperation, destructiveOpEvidenceProblem, DESTRUCTIVE_OP_OPTOUT_TOKEN } from '../team-ledger.ts';
let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };
function fixture() { const b = newLedger(); const q = addRequest(b, 'Batch 3 destructive-op gate objective', 'input:1'); return { b, q }; }
const spec = (q: string, id: string, changes: any = {}) => ({ id, title: id, role: 'bridges', requestIds: [q], dependsOn: [], readPaths: [], writePaths: [`src/${id}.ts`], acceptance: ['test evidence'], ...changes });

// ---- pure detection ----
test('detectDestructiveOperation flags destructive markers across title/brief/acceptance', () => {
	for (const [text, label] of [
		['run git branch -D feature-x', 'git branch -D'],
		['git worktree remove ../wt --force', 'git worktree remove --force'],
		['git push --force origin main', 'git push --force'],
		['git reset --hard HEAD~1', 'git reset --hard'],
		['rm -rf node_modules', 'rm -rf'],
		['force-overwrite the release artifact', 'force-overwrite'],
		['git clean -fdx', 'git clean -f'],
	] as const) {
		const hits = detectDestructiveOperation({ title: text, acceptance: [] });
		assert.ok(hits.some(h => h.label === label), `${text} → ${label} (got ${JSON.stringify(hits)})`);
	}
	// acceptance entries are surfaces too
	const hits = detectDestructiveOperation({ title: 'cleanup', acceptance: ['verify done', 'then git branch -D old'] });
	assert.ok(hits.some(h => h.surface.startsWith('acceptance[') && h.label === 'git branch -D'));
});

test('detectDestructiveOperation is silent on benign ops and prose', () => {
	assert.equal(detectDestructiveOperation({ title: 'git worktree remove clean tree', acceptance: [] }).length, 0, 'non-force worktree remove is safe');
	assert.equal(detectDestructiveOperation({ title: 'git branch -d merged-branch', acceptance: [] }).length, 0, 'lowercase -d is merged-only, safe');
	assert.equal(detectDestructiveOperation({ title: 'remove obsolete docs', acceptance: [] }).length, 0, 'prose "remove" is not a destructive op');
	assert.equal(detectDestructiveOperation({ title: 'git push origin main', acceptance: [] }).length, 0);
});

test('opt-out token suppresses detection entirely', () => {
	assert.equal(detectDestructiveOperation({ title: `rm -rf dist ${DESTRUCTIVE_OP_OPTOUT_TOKEN}`, acceptance: [] }).length, 0);
	assert.equal(detectDestructiveOperation({ title: 'rm -rf dist', acceptance: [`regenerable artifacts ${DESTRUCTIVE_OP_OPTOUT_TOKEN}`] }).length, 0, 'token anywhere opts out');
});

// ---- validation ----
test('destructiveOpEvidenceProblem requires read-only verification acceptance', () => {
	const bad = { id: 'W-x', title: 'delete branch with git branch -D feature', acceptance: ['branch deleted'] };
	assert.match(destructiveOpEvidenceProblem(bad)!, /NO read-only verification step/);
	assert.match(destructiveOpEvidenceProblem(bad)!, /rev-list --left-right --count/);
	const good = { id: 'W-x', title: 'delete branch with git branch -D feature', acceptance: ['FIRST capture `git rev-list --left-right --count main...feature` output (must show 0 left-only) and attach as evidence before deleting', 'then git branch -D feature'] };
	assert.equal(destructiveOpEvidenceProblem(good), null);
	const good2 = { id: 'W-x', title: 'force overwrite', acceptance: ['verify with git status --porcelain first'] };
	assert.equal(destructiveOpEvidenceProblem(good2), null);
	assert.equal(destructiveOpEvidenceProblem({ title: 'normal feature work', acceptance: ['tests pass'] }), null, 'non-destructive tasks unaffected');
});

// ---- add-time gate ----
test('addTasks rejects destructive tasks without verification evidence atomically', () => {
	const { b, q } = fixture();
	const before = structuredClone(b);
	assert.throws(() => addTasks(b, [spec(q.id, 'W-destruct', { title: 'cleanup: git branch -D old-feature' })], '/repo'), /destructive operation\(s\) detected/);
	assert.deepEqual(b, before, 'rejection is atomic — no partial rows');
	// accepted when verification acceptance present
	addTasks(b, [spec(q.id, 'W-destruct-ok', {
		title: 'cleanup merged branch via git branch -D old-feature',
		acceptance: ['capture `git rev-list --left-right --count main...old-feature` output showing 0 left-only commits BEFORE any deletion', 'then delete'],
	})], '/repo');
	assert.equal(b.tasks.at(-1)!.id, 'W-destruct-ok');
	// benign lowercase -d passes untouched
	addTasks(b, [spec(q.id, 'W-benign', { title: 'remove merged branch with git branch -d x' })], '/repo');
});

// ---- amend-time gate ----
test('amendTask cannot smuggle destructive ops post-registration', () => {
	const { b, q } = fixture();
	addTasks(b, [spec(q.id, 'W-a')], '/repo');
	assert.throws(() => amendTask(b, {
		id: 'W-a', acceptance: ['run git reset --hard HEAD~1 then force push'],
		reason: 'rewrite acceptance', evidence: ['user: m0001'],
	}), /destructive operation\(s\) detected/);
	const ok = amendTask(b, {
		id: 'W-a', acceptance: ['capture git rev-list --left-right --count output first', 'then git reset --hard'],
		reason: 'rewrite acceptance with verification', evidence: ['user: m0001'],
	});
	assert.equal(ok.id, 'W-a');
});

// ---- dispatch-time fail-closed re-check ----
test('markDispatched fail-closed on destructive tasks lacking verification', () => {
	const { b, q } = fixture();
	addTasks(b, [spec(q.id, 'W-a')], '/repo');
	// Simulate a legacy/pre-gate task by direct mutation (as could exist from before the gate landed).
	const task = b.tasks[0];
	task.title = 'delete branch: git branch -D old';
	task.acceptance = ['branch deleted'];
	assert.throws(() => markDispatched(b, 'W-a', 'bridges', 'run-1'), /destructive operation\(s\) detected/);
	assert.equal(task.status, 'ready', 'failed dispatch leaves the task un-dispatched');
	// Fixed acceptance dispatches fine.
	task.acceptance = ['FIRST run git branch --merged to prove merge state, attach output as evidence', 'then delete'];
	markDispatched(b, 'W-a', 'bridges', 'run-1');
	assert.equal(task.status, 'running');
});

// ---- 1b: holder-rejection fanout guidance ----
import { formatHolderRejection } from '../team-ledger.ts';
test('formatHolderRejection proposes worktree fanout + serial integration for write contention', () => {
	const out = formatHolderRejection({ kind: 'write-write', path: 'src/x.ts', holderIds: ['W-1'] });
	assert.match(out, /Fanout alternative/);
	assert.match(out, /isolation:"worktree"/);
	assert.match(out, /serial integration task/i);
	assert.match(out, /hosted spawn_subsession cannot set cwd/);
	assert.match(out, /dependsOn/);
	assert.match(formatHolderRejection({ kind: 'write-read', path: 'x', holderIds: ['W-1'] }), /Fanout alternative/);
	assert.doesNotMatch(formatHolderRejection({ kind: 'same-task', path: 'x', holderIds: ['W-1'] }), /Fanout alternative/, 'same-task conflicts are not a fanout matter');
	assert.doesNotMatch(formatHolderRejection({ kind: 'strict-reader', path: 'x', holderIds: ['W-1'] }), /Fanout alternative/);
});

console.log(`\n${passed} tests passed`);
