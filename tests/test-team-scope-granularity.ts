/**
 * W-120 conflict matrix: file-granular dispatch admission.
 *
 * Policy under test (exact-path conflicts):
 *  - a DIRECTORY declaration (`dir/`, `dir/**`, or a bare directory-looking path) reserves that one
 *    path entry and never its descendants; a distinct file below it does NOT conflict;
 *  - the SAME concrete path always conflicts (write/write and write/read);
 *  - disjoint files in one directory dispatch concurrently;
 *  - a reviewer's directory READ does not gate a writer of a distinct file in that directory;
 *    reviewers stay exempt for the delivery they review (existing parentTaskId/W-rev-* rule);
 *  - write PERMISSION stays wider than conflict: a marked directory scope authorizes subtree writes.
 *
 * Run: node --experimental-strip-types team-tests/test-team-scope-granularity.ts
 */
import { strict as assert } from 'node:assert';
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	newLedger, addRequest, addTasks, taskConflict, readyTasks, dispatchBatch, overlap, reviewerTaskId,
} from '../team-ledger.ts';
import { isPathInWriteScope, defaultConfig } from '../extensions/team.ts';
import { clearScopeCache, conflictPathBetweenScopes, scopeAllowsWrite } from '../team-scope.ts';

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };

function fixture(cwd = '/repo') {
	const b = newLedger();
	const q = addRequest(b, 'W-120 scope granularity', 'input:1');
	const add = (specs: any[]) => addTasks(b, specs.map(s => ({ title: s.id, role: 'bridges', requestIds: [q.id], dependsOn: [], readPaths: [], writePaths: [], acceptance: ['matrix assertion'], ...s })), cwd);
	return { b, q, add };
}

console.log('W-120 file-granularity conflict matrix');

// ---------------------------------------------------------------- 1. directory vs descendant file
test('BEFORE-bug: directory writePath no longer conflicts with a distinct descendant file', () => {
	assert.equal(overlap('/repo/team-tests/', '/repo/team-tests/foo.ts'), false);
	assert.equal(overlap('/repo/team-tests', '/repo/team-tests/foo.ts'), false, 'bare directory-looking path is not an ancestor scope');
	const { b, add } = fixture();
	add([{ id: 'W-120-dir', writePaths: ['team-tests/'] }, { id: 'W-120-file', writePaths: ['team-tests/foo.ts'] }]);
	assert.equal(taskConflict(b.tasks[0], b.tasks[1]), false);
	assert.equal(taskConflict(b.tasks[1], b.tasks[0]), false);
	assert.deepEqual(dispatchBatch(b).map(t => t.id), ['W-120-dir', 'W-120-file'], 'dir writer and descendant-file writer dispatch together');
});

// ---------------------------------------------------------------- 2. same concrete file
test('same concrete file still conflicts: write/write and write/read', () => {
	const { b, add } = fixture();
	add([
		{ id: 'W-ww-a', writePaths: ['src/shared.ts'] },
		{ id: 'W-ww-b', writePaths: ['src/shared.ts'] },
		{ id: 'W-wr', role: 'ayton', readPaths: ['src/shared.ts'] },
	]);
	assert.equal(taskConflict(b.tasks[0], b.tasks[1]), true, 'write/write same file');
	assert.equal(taskConflict(b.tasks[0], b.tasks[2]), true, 'write vs read of the same file');
	assert.equal(taskConflict(b.tasks[2], b.tasks[0]), true, 'symmetric');
	const sameFileDispatch = dispatchBatch(b).filter(t => t.writePaths[0] === '/repo/src/shared.ts');
	assert.deepEqual(sameFileDispatch.map(t => t.id), ['W-ww-a'], 'only one writer of the same file is admitted in a batch');
	assert.equal(readyTasks(b).filter(t => t.id === 'W-wr').length, 1, 'the reader stays queued behind the live write');
});

// ---------------------------------------------------------------- 3. disjoint files in one dir
test('disjoint concrete files in the same directory never conflict', () => {
	const { b, add } = fixture();
	add([{ id: 'W-f1', writePaths: ['team-tests/a.ts'] }, { id: 'W-f2', writePaths: ['team-tests/b.ts'] }, { id: 'W-f3', writePaths: ['team-tests/c.ts'] }]);
	assert.equal(taskConflict(b.tasks[0], b.tasks[1]), false);
	assert.equal(taskConflict(b.tasks[1], b.tasks[2]), false);
	assert.equal(taskConflict(b.tasks[0], b.tasks[2]), false);
	assert.deepEqual(dispatchBatch(b).map(t => t.id), ['W-f1', 'W-f2', 'W-f3']);
});

// ---------------------------------------------------------------- 4. dir scope vs dir scope
test('the same directory claimed twice still conflicts; distinct directories do not', () => {
	const { b, add } = fixture();
	add([
		{ id: 'W-d1', writePaths: ['team-tests/'] },
		{ id: 'W-d2', writePaths: ['team-tests/'] },
		{ id: 'W-d3', writePaths: ['other-dir/'] },
	]);
	assert.equal(taskConflict(b.tasks[0], b.tasks[1]), true, 'same directory entry claimed twice');
	assert.equal(taskConflict(b.tasks[0], b.tasks[2]), false, 'distinct directories');
});

// ---------------------------------------------------------------- 5. reviewer policy
test('reviewer directory read does not block a writer of a distinct file in that directory', () => {
	const { b, add } = fixture();
	add([
		{ id: 'W-ctxreader', role: 'cp', readPaths: ['team-tests/'], declaredReadOnly: true },
		{ id: 'W-writer', writePaths: ['team-tests/foo.ts'] },
	]);
	assert.equal(taskConflict(b.tasks[0], b.tasks[1]), false, 'documented policy: directory reads are not exclusive gates over descendants');
	assert.deepEqual(dispatchBatch(b).map(t => t.id), ['W-ctxreader', 'W-writer']);
});

test('reviewer of a delivery stays exempt even on the exact same file', () => {
	const { b, add } = fixture();
	add([{ id: 'W-worker', writePaths: ['src/foo.ts'] }]);
	const reviewer = { ...b.tasks[0], id: reviewerTaskId('W-worker'), role: 'cp', parentTaskId: 'W-worker', writePaths: [], readPaths: ['src/foo.ts'], declaredReadOnly: true };
	assert.equal(taskConflict(reviewer, b.tasks[0]), false, 'reviewer<->worker exemption preserved');
	assert.equal(overlap('src/foo.ts', 'src/foo.ts'), true, 'the exemption is the relationship, not the path');
});

// ---------------------------------------------------------------- 6. shared exclusives unchanged
test('shared exclusive resources still conflict regardless of path granularity', () => {
	const { b, add } = fixture();
	add([{ id: 'W-port-a', writePaths: ['a/x.ts'], sharedResources: ['port:8080'] }, { id: 'W-port-b', writePaths: ['a/y.ts'], sharedResources: ['port:8080'] }]);
	assert.equal(taskConflict(b.tasks[0], b.tasks[1]), true);
});

// ---------------------------------------------------------------- 7. admission normalization
test('admission preserves an explicit directory marker and never invents one', () => {
	const { b, add } = fixture();
	add([{ id: 'W-marker-slash', writePaths: ['team-tests/'] }, { id: 'W-marker-bare', writePaths: ['team-tests'] }]);
	assert.deepEqual(b.tasks[0].writePaths, ['/repo/team-tests/'], 'explicit marker is preserved');
	assert.deepEqual(b.tasks[1].writePaths, ['/repo/team-tests'], 'bare path is stored as one concrete path');
	assert.equal(taskConflict(b.tasks[1], b.tasks[0]), true, 'same path with/without marker is the same claim');
});

test('globs are still rejected atomically; only a trailing / marks a directory', () => {
	const { b, add } = fixture();
	assert.throws(() => add([{ id: 'W-glob', writePaths: ['team-tests/*.ts'] }]), /globs/);
	assert.throws(() => add([{ id: 'W-glob2', writePaths: ['team-tests/**/x.ts'] }]), /globs/);
	assert.throws(() => add([{ id: 'W-glob3', writePaths: ['team-tests/**'] }]), /globs/);
	assert.deepEqual(b.tasks, [], 'rejected batches leave the ledger untouched');
	add([{ id: 'W-plain', writePaths: ['team-tests/a.ts'] }]);
});

// ---------------------------------------------------------------- 8. write permission vs conflict
test('write permission stays wider than conflict: marked directory scope authorizes subtree writes', () => {
	const root = mkdtempSync(join(tmpdir(), 'w120-scope-'));
	try {
		const dir = join(root, 'out');
		mkdirSync(dir);
		assert.equal(scopeAllowsWrite(`${dir}/`, join(dir, 'a.txt')), true, 'explicit dir scope authorizes descendants');
		assert.equal(scopeAllowsWrite(`${dir}/`, join(root, 'sibling.txt')), false);
		assert.equal(scopeAllowsWrite(join(root, 'a.ts'), join(root, 'a.ts')), true, 'exact file permission');
		assert.equal(scopeAllowsWrite(join(root, 'a.ts'), join(root, 'a.ts/x')), false);
		// Transitional legacy branch: a bare path that is already a directory stays writable so
		// workers registered before markers existed are not hard-blocked mid-flight.
		assert.equal(scopeAllowsWrite(dir, join(dir, 'legacy.txt')), true);
		// isPathInWriteScope (runtime write gate) uses the same permission rule.
		assert.equal(isPathInWriteScope(join(dir, 'tool.ts'), [`${dir}/`], root), true);
		assert.equal(isPathInWriteScope(join(dir, 'tool.ts'), [dir], root), true, 'legacy existing directory');
		assert.equal(isPathInWriteScope(join(root, 'outside.ts'), [`${dir}/`], root), false);
		// Conflict stays exact even though permission is wide.
		assert.equal(overlap(`${dir}/`, join(dir, 'tool.ts')), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------- 8b. physical alias exclusion (CP defect 1)
test('physical aliases of one file still conflict: symlinked file, symlinked parent, hard link, /proc root', () => {
	const root = mkdtempSync(join(tmpdir(), 'w120-alias-'));
	try {
		clearScopeCache();
		mkdirSync(join(root, 'real'));
		const real = join(root, 'real', 'shared.ts');
		writeFileSync(real, 'export const x = 1;\n');
		symlinkSync(join(root, 'real'), join(root, 'linkdir'));
		symlinkSync(real, join(root, 'alias.ts'));
		linkSync(real, join(root, 'hard.ts'));
		assert.equal(realpathSync(join(root, 'alias.ts')), realpathSync(real), 'fixture: symlinked file has the same realpath');
		assert.equal(realpathSync(join(root, 'linkdir', 'shared.ts')), realpathSync(real), 'fixture: symlinked parent resolves to the same file');
		const { b, add } = fixture(root);
		add([
			{ id: 'W-ali-real', writePaths: ['real/shared.ts'] },
			{ id: 'W-ali-file', writePaths: ['alias.ts'] },
			{ id: 'W-ali-dir', writePaths: ['linkdir/shared.ts'] },
			{ id: 'W-ali-hard', writePaths: ['hard.ts'] },
			{ id: 'W-ali-other', writePaths: ['real/other.ts'] },
		]);
		for (const i of [1, 2, 3]) {
			assert.equal(taskConflict(b.tasks[0], b.tasks[i]), true, `alias ${b.tasks[i].id} write/write conflicts with the real file`);
			assert.equal(taskConflict(b.tasks[i], b.tasks[0]), true, 'alias conflict is symmetric');
		}
		assert.equal(taskConflict(b.tasks[0], b.tasks[4]), false, 'a distinct file in the same real directory still runs parallel');
		// Same file through the /proc self-root alias (present on Linux; the CP reproduction literal).
		const viaProc = `/proc/self/root${real}`;
		if (existsSync(viaProc)) {
			assert.equal(overlap(real, viaProc), true, '/proc/self/root alias of the same file conflicts');
			console.log(`  policy: /proc/self/root alias ${viaProc} conflicts with ${real}`);
		}
	} finally {
		clearScopeCache();
		rmSync(root, { recursive: true, force: true });
	}
});

test('case alias follows the filesystem: same inode conflicts, case-sensitive distinct files do not', () => {
	const root = mkdtempSync(join(tmpdir(), 'w120-case-'));
	try {
		clearScopeCache();
		const upper = join(root, 'Case.ts');
		const lower = join(root, 'case.ts');
		writeFileSync(upper, 'x\n');
		let sameInode = false;
		try {
			sameInode = realpathSync(upper) === realpathSync(lower);
		} catch {
			sameInode = false;
		}
		// Case-insensitive (APFS/NTFS) -> the second spelling is the same inode -> conflict.
		// Case-sensitive (ext4) -> distinct files -> no conflict, and `sameInode` is false.
		assert.equal(overlap(upper, lower), sameInode, `case alias must match the filesystem (sameInode=${sameInode})`);
		console.log(`  policy: case-sensitivity on this filesystem -> ${sameInode ? 'alias conflicts' : 'distinct files, no conflict'}`);
	} finally {
		clearScopeCache();
		rmSync(root, { recursive: true, force: true });
	}
});

test('batch admission and live leases use the same physical alias exclusion', () => {
	const root = mkdtempSync(join(tmpdir(), 'w120-lease-'));
	try {
		clearScopeCache();
		mkdirSync(join(root, 'real'));
		writeFileSync(join(root, 'real', 'foo.ts'), 'x\n');
		symlinkSync(join(root, 'real'), join(root, 'linkdir'));
		symlinkSync(join(root, 'real', 'foo.ts'), join(root, 'alias.ts'));
		const { b, add } = fixture(root);
		add([
			{ id: 'W-lease-a', writePaths: ['real/foo.ts'] },
			{ id: 'W-lease-b', writePaths: ['alias.ts'] },
			{ id: 'W-lease-reader', role: 'ayton', readPaths: ['linkdir/foo.ts'] },
		]);
		assert.deepEqual(dispatchBatch(b).map(t => t.id), ['W-lease-a'], 'only one physical writer is admitted in the batch');
		assert.equal(readyTasks(b).some(t => t.id === 'W-lease-b'), true, 'alias writer stays queued behind the admitted writer');
		assert.equal(readyTasks(b).some(t => t.id === 'W-lease-reader'), true, 'alias reader stays queued behind the admitted writer');
	} finally {
		clearScopeCache();
		rmSync(root, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------- 8c. diagnostic path (CP defect 2)
test('conflict diagnostic names a write/write or write/read path, never a read/read overlap', () => {
	assert.equal(
		conflictPathBetweenScopes({ writePaths: ['/repo/shared.ts'], readPaths: ['/repo/common.ts'] }, { writePaths: [], readPaths: ['/repo/common.ts', '/repo/shared.ts'] }),
		'/repo/shared.ts',
		'reproduced case: the reported cause is the written file, not the shared read',
	);
	assert.equal(
		conflictPathBetweenScopes({ writePaths: ['/repo/x.ts'], readPaths: [] }, { writePaths: ['/repo/x.ts'], readPaths: [] }),
		'/repo/x.ts',
		'write/write still names the conflicting file',
	);
	assert.equal(
		conflictPathBetweenScopes({ writePaths: [], readPaths: ['/repo/common.ts'] }, { writePaths: [], readPaths: ['/repo/common.ts'] }),
		'(unspecified path)',
		'read/read never contributes a diagnostic path',
	);
	assert.equal(
		conflictPathBetweenScopes({ writePaths: ['/repo/a.ts'], readPaths: ['/repo/common.ts'] }, { writePaths: [], readPaths: ['/repo/common.ts'] }),
		'/repo/a.ts',
		'a read/read overlap cannot win over the only real writer',
	);
});

// ---------------------------------------------------------------- 9. launch cap untouched
test('maxConcurrent launch cap is unchanged and independent work is not serialized', () => {
	assert.equal(defaultConfig().maxConcurrent, 20);
	const { b, add } = fixture();
	add(Array.from({ length: 5 }, (_, i) => ({ id: `W-par-${i}`, writePaths: [`team-tests/par-${i}.ts`] })));
	assert.equal(dispatchBatch(b).length, 5, 'all independent tasks are selected by the ledger; the host cap still bounds launches');
});

console.log(`\nW-120 scope granularity matrix: ${passed} passed`);
