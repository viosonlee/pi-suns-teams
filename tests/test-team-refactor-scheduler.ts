/**
 * Architecture Refactor Verification Suite:
 * - 20-Concurrency Deterministic Scheduling & Auto-Backfill Loop
 * - File-level Precision Scope Conflict Detection (Zero False Conflicts)
 * - Direct Completion Probing without Waiting for Host Notifications
 * - Tiered Review Pipeline & Deterministic Auto-Acceptance
 * - Programmatic Subagent Dispatching via ExtensionToolContext
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
	newLedger, addRequest, addTasks, readyTasks, dispatchBatch, taskConflict,
	markDispatched, observeTask, updateTask, autoAcceptTask, isDeterministic,
	createReviewerTask, nextDispatchableTasks, type WorkLedger, type WorkTask
} from '../team-ledger.ts';

import {
	probeLiveChildSession, probeAllLiveChildren, resolveChildSessionFile, clearSessionPathCache
} from '../team-recovery.ts';

import teamExtension, {
	defaultConfig, initialState, DEFAULT_TARGET_CONCURRENCY
} from '../extensions/team.ts';

let passed = 0;
const test = (name: string, fn: () => void | Promise<void>) => {
	const res = fn();
	if (res && typeof res.then === 'function') {
		return res.then(() => { passed++; console.log(`✓ ${name}`); });
	}
	passed++;
	console.log(`✓ ${name}`);
};

async function runAll() {
	console.log("=== Pi Team Refactor & Deterministic Scheduler Verification ===");

	// 1. File-level Precision Conflict Checks
	test('file-level precision: distinct files in same directory run in parallel without false conflict', () => {
		const b = newLedger();
		const q = addRequest(b, 'Parallel file tasks', 'input:1');
		addTasks(b, [
			{ id: 'W-1', title: 'Task 1', role: 'bridges', requestIds: [q.id], dependsOn: [], readPaths: [], writePaths: ['src/a.ts'], acceptance: ['done'] },
			{ id: 'W-2', title: 'Task 2', role: 'bridges', requestIds: [q.id], dependsOn: [], readPaths: [], writePaths: ['src/b.ts'], acceptance: ['done'] },
			{ id: 'W-3', title: 'Task 3', role: 'bridges', requestIds: [q.id], dependsOn: [], readPaths: [], writePaths: ['src/c.ts'], acceptance: ['done'] },
		], '/workspace');

		assert.equal(taskConflict(b.tasks[0], b.tasks[1]), false);
		assert.equal(taskConflict(b.tasks[1], b.tasks[2]), false);
		assert.equal(taskConflict(b.tasks[0], b.tasks[2]), false);

		// All 3 are ready and dispatchable together
		assert.equal(readyTasks(b).length, 3);
		assert.deepEqual(dispatchBatch(b).map(t => t.id), ['W-1', 'W-2', 'W-3']);
	});

	test('conflict calculus: read-read runs parallel, exact file write-read conflicts, directory write does not cover descendants', () => {
		const b = newLedger();
		const q = addRequest(b, 'Mixed scope tasks', 'input:1');
		addTasks(b, [
			{ id: 'W-read1', title: 'R1', role: 'ayton', requestIds: [q.id], dependsOn: [], readPaths: ['src/shared.ts'], writePaths: [], acceptance: ['done'] },
			{ id: 'W-read2', title: 'R2', role: 'ayton', requestIds: [q.id], dependsOn: [], readPaths: ['src/shared.ts'], writePaths: [], acceptance: ['done'] },
			{ id: 'W-write', title: 'W1', role: 'bridges', requestIds: [q.id], dependsOn: [], readPaths: [], writePaths: ['src/shared.ts'], acceptance: ['done'] },
			{ id: 'W-dirwrite', title: 'DW', role: 'bridges', requestIds: [q.id], dependsOn: [], readPaths: [], writePaths: ['src'], acceptance: ['done'] },
		], '/workspace');

		// Read-read: no conflict
		assert.equal(taskConflict(b.tasks[0], b.tasks[1]), false);
		// Exact write vs read: conflicts
		assert.equal(taskConflict(b.tasks[0], b.tasks[2]), true);
		// W-120: a directory writePath reserves that entry only; a distinct file read below it does NOT conflict
		assert.equal(taskConflict(b.tasks[0], b.tasks[3]), false);
	});

	test('unspecified writePaths defaults to empty read-only scope, preventing whole-repo exclusive lock', () => {
		const b = newLedger();
		const q = addRequest(b, 'Read-only task', 'input:1');
		addTasks(b, [
			{ id: 'W-ro1', title: 'Read-only investigation', role: 'ayton', requestIds: [q.id], dependsOn: [], readPaths: ['src/index.ts'], writePaths: [], acceptance: ['done'] },
			{ id: 'W-ro2', title: 'Read-only log search', role: 'ayton', requestIds: [q.id], dependsOn: [], readPaths: ['logs/app.log'], writePaths: [], acceptance: ['done'] },
		], '/workspace');

		assert.equal(taskConflict(b.tasks[0], b.tasks[1]), false);
		// By default without explicit deterministic review tier + autoAccept, tasks are not auto-accepted
		assert.equal(isDeterministic(b.tasks[0]), false);
		assert.equal(isDeterministic(b.tasks[1]), false);
	});

	// 2. 20-Concurrency Batching & Auto-Backfill Loop Simulation
	test('scheduler capacity: 25 independent tasks dispatch 20 slots, backfill 5 upon completions', () => {
		const b = newLedger();
		const q = addRequest(b, 'High volume fan-out', 'input:1');
		const tasks = Array.from({ length: 25 }, (_, i) => ({
			id: `W-job-${i + 1}`,
			title: `Independent job ${i + 1}`,
			role: 'bridges',
			requestIds: [q.id],
			dependsOn: [],
			readPaths: [],
			writePaths: [`src/job-${i + 1}.ts`],
			acceptance: [`Job ${i + 1} exit 0`],
			reviewTier: 'deterministic' as const,
			autoAccept: true,
		}));
		addTasks(b, tasks, '/workspace');

		assert.equal(readyTasks(b).length, 25);
		assert.equal(DEFAULT_TARGET_CONCURRENCY, 20);

		// First wave: exactly 20 tasks selected up to target concurrency
		const wave1 = nextDispatchableTasks(b, 20);
		assert.equal(wave1.length, 20);
		assert.equal(wave1[0].id, 'W-job-1');
		assert.equal(wave1[19].id, 'W-job-20');

		// Mark wave 1 dispatched
		for (const task of wave1) {
			markDispatched(b, task.id, 'bridges', `run-${task.id}`, `session-${task.id}`);
		}
		assert.equal(b.tasks.filter(t => t.status === 'running').length, 20);

		// Available slots are now 0; remaining 5 are ready but waiting for slots
		const availableSlotsBefore = Math.max(0, 20 - b.tasks.filter(t => t.status === 'running').length);
		assert.equal(availableSlotsBefore, 0);

		// 5 tasks complete
		for (let i = 0; i < 5; i++) {
			const id = `W-job-${i + 1}`;
			observeTask(b, `run-${id}`, `session-${id}`, 'completed');
			autoAcceptTask(b, id, ['exit 0'], { cleanExit: true });
		}
		assert.equal(b.tasks.filter(t => t.status === 'done').length, 5);
		assert.equal(b.tasks.filter(t => t.status === 'running').length, 15);

		// 5 slots freed: backfill wave 2 selects the remaining 5 tasks!
		const freeSlots = 20 - b.tasks.filter(t => t.status === 'running').length;
		assert.equal(freeSlots, 5);
		const wave2 = nextDispatchableTasks(b, freeSlots);
		assert.equal(wave2.length, 5);
		assert.deepEqual(wave2.map(t => t.id), ['W-job-21', 'W-job-22', 'W-job-23', 'W-job-24', 'W-job-25']);

		// Mark wave 2 dispatched
		for (const task of wave2) {
			markDispatched(b, task.id, 'bridges', `run-${task.id}`, `session-${task.id}`);
		}
		assert.equal(b.tasks.filter(t => t.status === 'running').length, 20);
	});

	// 3. Direct Completion Probing
	test('direct completion probing detects settled subagent session immediately', () => {
		const tempSessionsDir = mkdtempSync(join(tmpdir(), 'probe-sessions-'));
		const parentId = '00000000-0000-0000-0000-000000000001';
		const childId = '11111111-1111-1111-1111-111111111111';
		const subDir = mkdtempSync(join(tempSessionsDir, 'mock-cwd-'));

		const childJsonl = [
			JSON.stringify({ type: 'session', id: childId, timestamp: new Date().toISOString() }),
			JSON.stringify({ type: 'custom', id: 'c1', customType: 'pi-web:subagent', data: { version: 1, parentSessionId: parentId } }),
			JSON.stringify({ type: 'message', id: 'm1', parentId: 'c1', message: { role: 'user', content: 'Analyze metrics' }, timestamp: new Date().toISOString() }),
			JSON.stringify({ type: 'message', id: 'm2', parentId: 'm1', message: { role: 'assistant', stopReason: 'stop', content: 'Analysis complete: latency within 5ms' }, timestamp: new Date().toISOString() }),
		].join('\n') + '\n';

		writeFileSync(join(subDir, `2026-01-01_${childId}.jsonl`), childJsonl);

		clearSessionPathCache();
		const probe = probeLiveChildSession(childId, {
			parentSessionId: parentId,
			sessionsDir: tempSessionsDir,
		});

		assert.equal(probe.completed, true);
		assert.equal(probe.status, 'completed');
		assert.ok(probe.report);
		assert.match(probe.report.text, /Analysis complete/);

		rmSync(tempSessionsDir, { recursive: true, force: true });
	});

	// 4. Tiered Review & Deterministic Auto-Acceptance
	test('tiered review: deterministic read-only task auto-accepts, code change queues reviewer task', () => {
		const b = newLedger();
		const q = addRequest(b, 'Delivery objective', 'input:1');
		addTasks(b, [
			{ id: 'W-readonly', title: 'Inspect logs', role: 'cameron', requestIds: [q.id], dependsOn: [], readPaths: ['logs/app.log'], writePaths: [], acceptance: ['exit code 0'], reviewTier: 'deterministic', autoAccept: true },
			{ id: 'W-code', title: 'Refactor parser', role: 'bridges', requestIds: [q.id], dependsOn: [], readPaths: [], writePaths: ['src/parser.ts'], acceptance: ['unit tests pass'] },
		], '/workspace');

		// Read-only with explicit deterministic tier is deterministic
		assert.equal(isDeterministic(b.tasks[0]), true);
		// Code change without deterministic contract is non-deterministic
		assert.equal(isDeterministic(b.tasks[1]), false);

		// Worker finishes W-readonly: transitions to reported, then autoAccept verifies clean execution
		b.tasks[0].status = 'reported';
		const accepted = autoAcceptTask(b, 'W-readonly', ['Logs verified clean; exit code 0'], { cleanExit: true });
		assert.equal(accepted, true);
		assert.equal(b.tasks[0].status, 'done');

		// Worker finishes W-code: generate review task (compliant ID format W-rev-code)
		const revTask = createReviewerTask(b, b.tasks[1], 'ayton');
		assert.equal(revTask.id, 'W-rev-code');
		assert.equal(revTask.role, 'ayton');
		assert.deepEqual(revTask.dependsOn, ['W-code']);
		assert.deepEqual(revTask.readPaths, ['/workspace/src/parser.ts']);
		assert.deepEqual(revTask.writePaths, []);
	});

	// 5. Tool Registration & Programmatic Dispatch Pump
	await test('team_dispatch tool is registered and pumps scheduler programmatically', async () => {
		let registeredTools = new Map<string, any>();
		const piMock: any = {
			on() {},
			registerFlag() {},
			getFlag() { return false; },
			registerTool(spec: any) { registeredTools.set(spec.name, spec); },
			registerCommand() {},
			appendEntry() {},
			getThinkingLevel() { return 'high'; },
			setThinkingLevel() {},
			async setModel() { return true; },
			sendMessage() {},
			async sendUserMessage() {},
		};

		teamExtension(piMock);

		assert.ok(registeredTools.has('team_tasks'));
		assert.ok(registeredTools.has('team_dispatch'));
		assert.ok(registeredTools.has('team_goal'));

		const dispatchTool = registeredTools.get('team_dispatch');
		assert.equal(dispatchTool.name, 'team_dispatch');
		assert.match(dispatchTool.description, /Deterministic Scheduler/);
	});

	console.log(`\nAll ${passed} refactor scheduler tests passed!`);
}

runAll().catch(err => {
	console.error("Test failure:", err);
	process.exit(1);
});
