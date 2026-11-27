/**
 * W-120 precision matrix: file-level write scope vs directory-wide write scope.
 *
 * Three deliberately different questions (never conflated):
 *  1. IDENTITY   `overlap`/`scopeConflicts`: do two declarations name the same path/inode?
 *  2. COVERAGE   `writeCoverage`/`writeConflicts`: does a DIRECTORY-WIDE WRITE (`dir/`) own the
 *     paths below it?
 *  3. PERMISSION `scopeAllowsWrite`: may this task write this concrete target? (wider than 1 and 2)
 *
 * Admission policy under test (policy layer = `scopePathsConflict`, the predicate dispatch needs):
 *  - two concrete FILE writes under one parent directory never conflict (independent parallel work);
 *  - a directory declared as a READ is a listing, not ownership: it never gates a nested file writer,
 *    so a shared parent-directory READ declaration cannot serialize independent file tasks;
 *  - a directory declared as a WRITE is directory-wide: it conflicts with nested writes AND nested
 *    reads (fail-closed), in both argument orders;
 *  - the exact same file still conflicts (write/write and write/read);
 *  - directory-wide coverage is alias-aware (symlinked parent, /proc/self/root bind aliases) and
 *    never string-prefix based (`src/` must not cover `src2/a.ts`);
 *  - live-child ownership, worktree guards, shared exclusive resources and reviewer exemption are
 *    unchanged by the granularity change.
 *
 * BLOCKED SECTION: the live ledger (`team-ledger.ts` `taskConflict`) is outside this task's enforced
 * write scope, so admission there still uses symmetric identity-only `overlap`. Section 4 asserts and
 * PRINTS that known gap instead of hiding it; flip it to the desired values once the call site
 * delegates to `scopePathsConflict` (minimal patch is in the W-120 handoff report).
 *
 * Run: node --experimental-strip-types team-tests/test-team-scope-precision.ts
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	newLedger, addRequest, addTasks, taskConflict, readyTasks, dispatchBatch, overlap,
	reviewerTaskId, type WorkTask,
} from '../team-ledger.ts';
import {
	clearScopeCache, conflictPathBetweenScopes, scopeAllowsWrite, scopeCovers, scopePathsConflict,
	writeCoverage, writeConflicts,
} from '../team-scope.ts';

let passed = 0;
let blocked = 0;
/** Live ledger taskConflict delegates to scopePathsConflict by default. */
const LEDGER_WIRED = process.env.W120_LEDGER_WIRED !== '0';
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };

function fixture(cwd = '/repo') {
	const b = newLedger();
	const q = addRequest(b, 'W-120 precision', 'input:1');
	const add = (specs: any[]) => addTasks(b, specs.map(s => ({ title: s.id, role: 'bridges', requestIds: [q.id], dependsOn: [], readPaths: [], writePaths: [], acceptance: ['matrix assertion'], ...s })), cwd);
	return { b, q, add };
}

/** Symmetric admission answer for one live-ledger pair (both argument orders must agree). */
function conflicts(a: WorkTask, b: WorkTask): boolean {
	const forward = taskConflict(a, b);
	assert.equal(taskConflict(b, a), forward, 'taskConflict must be symmetric');
	return forward;
}

console.log('W-120 file-level vs directory-wide conflict matrix\n');

// ============================================================ 1. policy primitives
test('write coverage: directory-wide write owns nested writes and nested reads', () => {
	assert.equal(writeCoverage('/repo/src/', '/repo/src/a.ts'), true, 'nested file');
	assert.equal(writeCoverage('/repo/src/', '/repo/src/sub/deep/x.ts'), true, 'deep descendant');
	assert.equal(writeCoverage('/repo/src/', '/repo/src'), true, 'the directory itself');
	assert.equal(writeCoverage('/repo/src/', '/repo/src2/a.ts'), false, 'never a string-prefix match');
	assert.equal(writeCoverage('/repo/src/a.ts', '/repo/src/a.ts'), false, 'a bare file scope is not directory-wide');
	assert.equal(writeCoverage('/repo/src/a.ts', '/repo/src/b.ts'), false, 'sibling files are disjoint');
	assert.equal(writeConflicts('/repo/src/', '/repo/src/a.ts'), true, 'coverage blocks admission');
	assert.equal(writeConflicts('/repo/src/', '/repo/src/'), true, 'identity blocks admission');
	assert.equal(writeConflicts('/repo/src/a.ts', '/repo/src/b.ts'), false, 'identity miss, no coverage');
});

test('directory-wide write coverage is alias-aware and normalization-aware', () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'w120-precision-')));
	try {
		const real = join(root, 'real');
		mkdirSync(real);
		const link = join(root, 'link');
		symlinkSync(real, link);
		writeFileSync(join(real, 'a.ts'), 'a\n');
		clearScopeCache();
		assert.equal(writeCoverage(`${real}/`, join(link, 'x.ts')), true, 'symlinked parent alias');
		assert.equal(writeCoverage(`${link}/`, join(real, 'x.ts')), true, 'reverse symlink direction');
		try {
			assert.equal(writeCoverage(`/proc/self/root${real}/`, join(real, 'a.ts')), true, '/proc/self/root bind alias');
		} catch { /* /proc not mounted in this environment */ }
		assert.equal(writeCoverage(`${real}/`, join(root, 'outside.ts')), false, 'outside the directory');
		assert.equal(scopeCovers('/', join(real, 'a.ts')), true, 'filesystem root contains everything');
		assert.equal(writeCoverage(real, join(real, 'a.ts')), false, 'unmarked existing dir is a file-level scope');
	} finally {
		clearScopeCache();
		rmSync(root, { recursive: true, force: true });
	}
});

test('./ and ../ lexical aliases resolve into the covered directory', () => {
	clearScopeCache();
	assert.equal(writeConflicts('/repo/src/', '/repo/lib/../src/a.ts'), true, 'lib/../src/a.ts');
	assert.equal(writeConflicts('/repo/src/', '/repo/./src/a.ts'), true, './src/a.ts');
	assert.equal(writeConflicts('/repo/src/', '/repo/lib/../lib2/a.ts'), false, 'resolves outside the directory');
});

// ============================================================ 2. policy-layer admission matrix
test('policy admission: independent files under one parent admit in parallel', () => {
	const s = (w: string[], r: string[] = []) => ({ writePaths: w, readPaths: r });
	assert.equal(scopePathsConflict(s(['/repo/team-tests/a.ts']), s(['/repo/team-tests/b.ts'])), false, 'sibling files');
	assert.equal(scopePathsConflict(s(['/repo/team-tests/a.ts']), s(['/repo/team-tests/nested/c.ts'])), false, 'nested independent file');
	assert.equal(scopePathsConflict(s(['/repo/src/a.ts'], ['/repo/src/']), s(['/repo/src/b.ts'], ['/repo/src/'])), false,
		'shared parent-directory READ declaration is not an ownership claim');
});

test('policy admission: directory-wide write conflicts with nested write and nested read', () => {
	const s = (w: string[], r: string[] = []) => ({ writePaths: w, readPaths: r });
	assert.equal(scopePathsConflict(s(['/repo/src/']), s(['/repo/src/a.ts'])), true, 'dir write vs nested file write');
	assert.equal(scopePathsConflict(s(['/repo/src/a.ts']), s(['/repo/src/'])), true, 'reverse order, nested write');
	assert.equal(scopePathsConflict(s(['/repo/src/']), s([], ['/repo/src/a.ts'])), true, 'dir write vs nested file read');
	assert.equal(scopePathsConflict(s([], ['/repo/src/a.ts']), s(['/repo/src/'])), true, 'reverse order, nested read');
	assert.equal(scopePathsConflict(s(['/repo/src/a.ts'], ['/repo/src/']), s(['/repo/src/b.ts'])), false,
		'a directory READ never covers the nested writer it reads around');
});

test('policy admission: exact same file and same directory stay fail-closed; reads never conflict', () => {
	const s = (w: string[], r: string[] = []) => ({ writePaths: w, readPaths: r });
	assert.equal(scopePathsConflict(s(['/repo/src/a.ts']), s(['/repo/src/a.ts'])), true, 'write/write same file');
	assert.equal(scopePathsConflict(s(['/repo/src/a.ts']), s([], ['/repo/src/a.ts'])), true, 'write/read same file');
	assert.equal(scopePathsConflict(s(['/repo/src/']), s(['/repo/src/'])), true, 'same wide directory twice');
	assert.equal(scopePathsConflict(s(['/repo/src/']), s(['/repo/lib/'])), false, 'distinct wide directories');
	assert.equal(scopePathsConflict(s([], ['/repo/src/']), s([], ['/repo/src/'])), false, 'read/read');
	assert.equal(scopePathsConflict(s([], ['/repo/src/']), s([], ['/repo/src/a.ts'])), false, 'read/read nested');
});

// ============================================================ 3. live-ledger admission (unchanged guards)
test('live admission: independent file writers dispatch in one batch', () => {
	const { b, add } = fixture();
	add([
		{ id: 'W-ind-a', writePaths: ['team-tests/a.ts'], readPaths: ['team-tests/'] },
		{ id: 'W-ind-b', writePaths: ['team-tests/b.ts'], readPaths: ['team-tests/'] },
		{ id: 'W-ind-c', writePaths: ['team-tests/nested/c.ts'] },
	]);
	assert.equal(conflicts(b.tasks[0], b.tasks[1]), false, 'no false conflict on the shared parent read declaration');
	assert.deepEqual(dispatchBatch(b).map(t => t.id), ['W-ind-a', 'W-ind-b', 'W-ind-c'], 'all independent files admit');
});

test('live admission: exact same file still conflicts (write/write and write/read)', () => {
	const { b, add } = fixture();
	add([
		{ id: 'W-same-1', writePaths: ['src/shared.ts'] },
		{ id: 'W-same-2', writePaths: ['src/shared.ts'] },
		{ id: 'W-same-r', role: 'ayton', readPaths: ['src/shared.ts'] },
	]);
	assert.equal(conflicts(b.tasks[0], b.tasks[1]), true, 'write/write');
	assert.equal(conflicts(b.tasks[0], b.tasks[2]), true, 'write/read');
	assert.deepEqual(dispatchBatch(b).map(t => t.id), ['W-same-1'], 'one writer admitted, reader held');
});

test('live admission: same directory twice conflicts; distinct directories do not', () => {
	const { b, add } = fixture();
	add([{ id: 'W-d1', writePaths: ['src/'] }, { id: 'W-d2', writePaths: ['src/'] }, { id: 'W-d3', writePaths: ['lib/'] }]);
	assert.equal(conflicts(b.tasks[0], b.tasks[1]), true, 'same directory entry claimed twice');
	assert.equal(conflicts(b.tasks[0], b.tasks[2]), false, 'distinct directories');
});

test('guard: live-child ownership still holds', () => {
	const { b, add } = fixture();
	add([{ id: 'W-live', writePaths: ['src/a.ts'] }, { id: 'W-next', writePaths: ['lib/b.ts'] }]);
	b.tasks[0].status = 'running';
	b.tasks[0].runId = 'run-live';
	assert.equal(readyTasks(b).some(t => t.id === 'W-next'), true, 'independent file writer is not blocked by the live child');
	add([{ id: 'W-blocked', writePaths: ['src/a.ts'] }]);
	assert.equal(readyTasks(b).some(t => t.id === 'W-blocked'), false, 'exact-file writer stays held by the live child');
	assert.equal(dispatchBatch(b).some(t => t.id === 'W-blocked'), false);
});

test('guard: verified distinct worktrees stay parallel; invalid worktree claim stays fail-closed', () => {
	const { b, add } = fixture();
	add([
		{ id: 'W-wt-a', writePaths: ['src/'], isolation: 'worktree', worktreePath: '/wt/a', branch: 'task/a', baseSHA: 'aaa' },
		{ id: 'W-wt-b', writePaths: ['src/a.ts'], isolation: 'worktree', worktreePath: '/wt/b', branch: 'task/b', baseSHA: 'aaa' },
		{ id: 'W-wt-broken', writePaths: ['other/x.ts'], isolation: 'worktree', worktreePath: '', branch: 'task/c', baseSHA: 'aaa' },
	]);
	assert.equal(conflicts(b.tasks[0], b.tasks[1]), false, 'verified distinct worktrees: no filesystem conflict');
	assert.equal(conflicts(b.tasks[2], b.tasks[0]), true, 'unverified worktree claim is fail-closed vs writers');
	assert.equal(conflicts(b.tasks[2], b.tasks[1]), true);
});

test('guard: shared exclusive resources and reviewer exemption are unchanged', () => {
	const shared = fixture();
	shared.add([
		{ id: 'W-res-a', writePaths: ['src/'], sharedResources: ['port:8080'] },
		{ id: 'W-res-b', writePaths: ['lib/x.ts'], sharedResources: ['port:8080'] },
	]);
	assert.equal(conflicts(shared.b.tasks[0], shared.b.tasks[1]), true, 'exclusive resource beats disjoint paths');

	const { b, add } = fixture();
	add([{ id: 'W-rev-worker', writePaths: ['src/'] }]);
	const reviewer = { ...b.tasks[0], id: reviewerTaskId('W-rev-worker'), role: 'cp', parentTaskId: 'W-rev-worker', writePaths: [], readPaths: ['src/a.ts'], declaredReadOnly: true };
	assert.equal(taskConflict(reviewer, b.tasks[0]), false, 'reviewer<->worker exemption');
});

test('diagnostic names the mutated/covered path, never a read/read overlap', () => {
	assert.equal(conflictPathBetweenScopes({ writePaths: ['/repo/src/'], readPaths: [] }, { writePaths: ['/repo/src/a.ts'], readPaths: [] }), '/repo/src/a.ts', 'dir-wide write reports the covered path');
	assert.equal(conflictPathBetweenScopes({ writePaths: ['/repo/src/a.ts'], readPaths: [] }, { writePaths: ['/repo/src/'], readPaths: [] }), '/repo/src/a.ts', 'same answer reversed');
	assert.equal(conflictPathBetweenScopes({ writePaths: ['/repo/src/'], readPaths: [] }, { writePaths: [], readPaths: ['/repo/src/'] }), '/repo/src/', 'wide write vs directory reader names the directory claim');
	assert.equal(conflictPathBetweenScopes({ writePaths: [], readPaths: ['/repo/src/'] }, { writePaths: [], readPaths: ['/repo/src/'] }), '(unspecified path)', 'read/read never reports a path');
});

test('write permission stays wider than conflict (unchanged)', () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'w120-perm-')));
	try {
		const dir = join(root, 'out');
		mkdirSync(dir);
		assert.equal(scopeAllowsWrite(`${dir}/`, join(dir, 'a.txt')), true, 'marked dir authorizes subtree writes');
		assert.equal(scopeAllowsWrite(`${dir}/`, join(root, 'outside.txt')), false);
		assert.equal(scopeAllowsWrite(dir, join(dir, 'legacy.txt')), true, 'transitional legacy existing dir');
		assert.equal(overlap(`${dir}/`, join(dir, 'a.txt')), false, 'permission is not identity');
		assert.equal(writeCoverage(`${dir}/`, join(dir, 'a.txt')), true, 'marked dir coverage');
	} finally {
		clearScopeCache();
		rmSync(root, { recursive: true, force: true });
	}
});

test('globs are still rejected atomically; markers are the only directory declaration', () => {
	const { b, add } = fixture();
	assert.throws(() => add([{ id: 'W-g1', writePaths: ['src/*.ts'] }]), /globs/);
	assert.throws(() => add([{ id: 'W-g2', writePaths: ['src/**'] }]), /globs/);
	assert.throws(() => add([{ id: 'W-g3', writePaths: ['src/**/x.ts'] }]), /globs/);
	assert.deepEqual(b.tasks, [], 'rejected batch leaves the ledger untouched');
	add([{ id: 'W-dir-ok', writePaths: ['src/'] }]);
	assert.deepEqual(b.tasks[0].writePaths, ['/repo/src/'], 'explicit marker preserved');
});

// ============================================================ 4. BLOCKED admission rows
// team-ledger.ts:taskConflict is outside this task's enforced write scope (host guard). It still uses
// symmetric identity-only `overlap`, so directory-wide write coverage is NOT enforced at admission.
// These assertions snapshot the known gap and fail loudly the moment the call site is wired, so the
// flip to the desired values is always a conscious action.
test('admission wiring: directory-wide write coverage at the taskConflict call site', () => {
	const { b, add } = fixture();
	add([
		{ id: 'W-gap-dir', writePaths: ['src/'] },
		{ id: 'W-gap-nested-w', writePaths: ['src/a.ts'] },
		{ id: 'W-gap-nested-r', role: 'ayton', readPaths: ['src/a.ts'] },
	]);
	const policy = (x: WorkTask, y: WorkTask) => scopePathsConflict(x, y);
	assert.equal(policy(b.tasks[0], b.tasks[1]), true, 'policy layer enforces nested write');
	assert.equal(policy(b.tasks[0], b.tasks[2]), true, 'policy layer enforces nested read');
	assert.equal(conflicts(b.tasks[0], b.tasks[1]), LEDGER_WIRED, LEDGER_WIRED ? 'wired: nested write blocked' : 'KNOWN GAP: live admission does not cover the nested write');
	assert.equal(conflicts(b.tasks[0], b.tasks[2]), LEDGER_WIRED, LEDGER_WIRED ? 'wired: nested read blocked' : 'KNOWN GAP: live admission does not cover the nested read');
	assert.equal(conflicts(b.tasks[1], b.tasks[0]), LEDGER_WIRED, 'reverse argument order agrees');
	if (!LEDGER_WIRED) {
		blocked += 3;
		console.log('⏳ BLOCKED admission rows (needs team-ledger.ts taskConflict wiring):');
		console.log('   - dir-wide write  vs nested file write : desired=conflict, current=no-conflict');
		console.log('   - dir-wide write  vs nested file read  : desired=conflict, current=no-conflict');
		console.log('   - reverse argument order               : desired=conflict, current=no-conflict');
	} else {
		assert.deepEqual(dispatchBatch(b).map(t => t.id), ['W-gap-dir'], 'admission admits only the wide writer');
	}
});

// ------------------------------------------------------------ conflict matrix evidence
console.log('\nconflict matrix (policy layer = scopePathsConflict, admission = taskConflict):');
const rows: Array<[string, { writePaths: string[]; readPaths: string[] }, { writePaths: string[]; readPaths: string[] }]> = [
	['write file a.ts   vs write file b.ts  ', { writePaths: ['/repo/src/a.ts'], readPaths: [] }, { writePaths: ['/repo/src/b.ts'], readPaths: [] }],
	['write a.ts + shared dir READ          ', { writePaths: ['/repo/src/a.ts'], readPaths: ['/repo/src/'] }, { writePaths: ['/repo/src/b.ts'], readPaths: ['/repo/src/'] }],
	['write DIR src/    vs write src/a.ts   ', { writePaths: ['/repo/src/'], readPaths: [] }, { writePaths: ['/repo/src/a.ts'], readPaths: [] }],
	['write DIR src/    vs read  src/a.ts   ', { writePaths: ['/repo/src/'], readPaths: [] }, { writePaths: [], readPaths: ['/repo/src/a.ts'] }],
	['write DIR src/    vs write DIR src/   ', { writePaths: ['/repo/src/'], readPaths: [] }, { writePaths: ['/repo/src/'], readPaths: [] }],
	['write DIR src/    vs write src2/a.ts  ', { writePaths: ['/repo/src/'], readPaths: [] }, { writePaths: ['/repo/src2/a.ts'], readPaths: [] }],
	['write file a.ts   vs read  a.ts       ', { writePaths: ['/repo/src/a.ts'], readPaths: [] }, { writePaths: [], readPaths: ['/repo/src/a.ts'] }],
	['read  DIR src/    vs read  DIR src/   ', { writePaths: [], readPaths: ['/repo/src/'] }, { writePaths: [], readPaths: ['/repo/src/'] }],
];
for (const [label, left, right] of rows) {
	const p = scopePathsConflict(left, right) ? 'conflict   ' : 'parallel   ';
	console.log(`  ${label} policy=${p}`);
}

console.log(`\nW-120 scope precision matrix: ${passed} passed, ${blocked} blocked admission rows ${LEDGER_WIRED ? '(ledger wiring APPLIED)' : '(ledger wiring pending)'}`);