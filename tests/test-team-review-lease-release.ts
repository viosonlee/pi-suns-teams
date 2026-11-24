/**
 * W-63 — a settled review must release the dead attempt's write scope.
 *
 * Live deadlock being reproduced:
 *   W-57 is dispatched, its child reports, a reviewer W-rev-57 is queued, and the review settles
 *   as INCOMPLETE. From then on every update/dispatch that touches the same writePaths fails with
 *       A still-live child owns this task/scope on another branch. Reconcile that execution before updating.
 *   The worker attempt is dead (the reviewer already settled it), yet its child lease stays live, so
 *   heldConflict() keeps rejecting the worker and every successor in the same write scope.
 *
 * The two properties asserted here:
 *   (a) the worker is NOT promoted to done — INCOMPLETE keeps it reported/reviewing;
 *   (b) a successor in the SAME writePaths is still updatable and dispatchable, i.e. no live lease
 *       conflict remains.
 *
 * The safety property is asserted too: while a review is still PENDING (no verdict) the lease must
 * stay live and the successor must still conflict — only a settled verdict releases the scope.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import team, { initialState, defaultConfig, newGoal } from '../extensions/team.ts';

const root = mkdtempSync(join(tmpdir(), 'team-review-lease-'));
process.env.PI_CODING_AGENT_DIR = root;
writeFileSync(join(root, 'team.json'), JSON.stringify({ maxConcurrent: 8 }));

const WRITE_SCOPE = 'src/w63.ts';
const CHILD = '77777777-7777-7777-8777-777777777777';
const REVIEWER = '88888888-8888-8888-8888-888888888888';

let seq = 0;
let passed = 0;

function harness() {
	const state = initialState(defaultConfig());
	state.enabled = true;
	state.startedAt = '2026-01-01';
	state.goal = newGoal('W-63 lease release', ['successor stays dispatchable']);
	let entries: any[] = [{ type: 'custom', id: 'seed', customType: 'team-state', data: state }];
	const branch = entries;
	const hooks = new Map<string, Function[]>();
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const notes: string[] = [];
	const ctx: any = {
		cwd: root, hasUI: true, isIdle: () => true,
		sessionManager: {
			getEntries: () => entries, getBranch: () => branch, getSessionId: () => 'parent',
			getSessionFile: () => join(root, 'parent.jsonl'),
		},
		ui: { notify: (m: string) => notes.push(m), setStatus() {} },
		model: { provider: 'fixture', id: 'unused' },
		modelRegistry: { find: () => undefined },
	};
	const pi: any = {
		on: (n: string, f: Function) => hooks.set(n, [...(hooks.get(n) ?? []), f]),
		registerFlag() {}, getFlag: () => false,
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: (n: string, c: any) => commands.set(n, c),
		appendEntry: (t: string, data: any) => { entries.push({ type: 'custom', id: `e${++seq}`, customType: t, data }); },
		getThinkingLevel: () => 'high',
		sendMessage() {}, sendUserMessage: async () => {},
	};
	team(pi);
	return {
		ctx, notes, entries: () => entries,
		state: () => [...branch].reverse().find(e => e.customType === 'team-state').data,
		task: (id: string) => [...branch].reverse().find(e => e.customType === 'team-state').data.ledger.tasks.find((t: any) => t.id === id),
		async emit(name: string, event: any = {}) {
			let e = event;
			for (const f of hooks.get(name) ?? []) { const p = await f(e, ctx); if (p) e = { ...e, ...p }; }
			return e;
		},
		async start() { await this.emit('session_start', { reason: 'startup' }); },
		async ledger(payload: any) { return tools.get('team_tasks').execute(`ledger${++seq}`, payload, undefined, undefined, ctx); },
	};
}

async function test(name: string, fn: () => Promise<void>) {
	await fn();
	passed++;
	console.log(`✓ ${name}`);
}

const spec = (requestId: string, id: string) => ({
	id, title: `${id} deliverable`, role: 'bridges', requestIds: [requestId], dependsOn: [],
	readPaths: [], writePaths: [WRITE_SCOPE], acceptance: ['deliverable verified by an independent reviewer'],
});

const dispatch = (h: any, workId: string, role: string, call = workId) =>
	h.emit('tool_call', { toolName: 'Agent', toolCallId: call, input: { subagent_type: role, prompt: `TEAM_TASK: ${workId}\nGoal: bounded fixture work.` } });

const childResult = (h: any, call: string, sessionId: string, status = 'completed') =>
	h.emit('tool_result', { toolName: 'Agent', toolCallId: call, input: {}, isError: false, details: { sessionId, status }, content: [{ type: 'text', text: 'Fixture child body' }] });

/** Write a signed child session file so the parent can authenticate the reviewer's final report. */
function childSessionFile(sessionId: string, reportText: string) {
	const dir = join(root, 'sessions', '--fixture--');
	mkdirSync(dir, { recursive: true });
	const reportAt = new Date(Date.now() + 500).toISOString();
	writeFileSync(join(dir, `${reportAt.replace(/[:.]/g, '-')}_${sessionId}.jsonl`), [
		{ type: 'session', id: sessionId, version: 3, cwd: root, timestamp: reportAt },
		{ type: 'custom', id: 'meta', parentId: null, timestamp: reportAt, customType: 'pi-web:subagent', data: { version: 1, parentSessionId: 'parent' } },
		{ type: 'message', id: 'report', parentId: 'meta', timestamp: reportAt, message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: reportText }], timestamp: Date.parse(reportAt) } },
		{ type: 'custom', id: 'result', parentId: 'report', timestamp: reportAt, customType: 'pi-web:subagent-result', data: { status: 'completed' } },
	].map(e => JSON.stringify(e)).join('\n') + '\n');
	return reportAt;
}

/** Drive the fixture up to the point where W-rev-57 is the only thing left to settle. */
async function workerUnderReview() {
	const h = harness();
	await h.start();
	await h.emit('input', { text: 'W-63 reproduction request', source: 'rpc' });
	const requestId = h.state().ledger.requests.at(-1).id;
	const added = await h.ledger({ action: 'add', tasks: [spec(requestId, 'W-57'), spec(requestId, 'W-58')] });
	assert.equal(added.isError, undefined);

	// W-57 runs, reports, and gets an independent reviewer.
	assert.notEqual((await dispatch(h, 'W-57', 'bridges')).block, true);
	await childResult(h, 'W-57', CHILD);
	assert.equal(h.task('W-57').status, 'reported');

	// While the review is PENDING (worker reported, reviewer not yet dispatched) the reviewed
	// deliverable still holds its write scope: only a settled verdict may release it.
	const pending = await dispatch(h, 'W-58', 'bridges');
	assert.equal(pending.block, true, `a pending review must still pin the write scope: ${pending.reason ?? ''}`);

	// The reviewer runs and reports an INCOMPLETE verdict.
	assert.notEqual((await dispatch(h, 'W-rev-57', 'cp')).block, true);
	assert.equal(h.task('W-57').status, 'reviewing');
	assert.equal(h.task('W-rev-57').status, 'running');
	await childResult(h, 'W-rev-57', REVIEWER);
	childSessionFile(REVIEWER, 'VERDICT: INCOMPLETE\nDEFECTS:\n- AC1 evidence missing: no artefact citation for the deliverable');
	return h;
}

try {
	const h = await workerUnderReview();

	// Settle the review: the probe re-reads the reviewer's session file and applies INCOMPLETE.
	await h.ledger({ action: 'list' });

	const worker = h.task('W-57');
	const review = h.task('W-rev-57');

	await test('settled INCOMPLETE never promotes the worker to done', () => {
		console.log(`    worker=${worker.status} review=${review.status} retryCount=${worker.retryCount ?? 0}`);
		assert.notEqual(worker.status, 'done');
		assert.ok(['reported', 'reviewing'].includes(worker.status), `worker must stay reported/reviewing, got ${worker.status}`);
		assert.match(String(worker.reason), /INCOMPLETE/);
	});

	await test('settled INCOMPLETE blocks automatic reviewer retry pending parent action', async () => {
		assert.equal(worker.status, 'reported');
		assert.match(String(worker.reason), /INCOMPLETE/);
		assert.equal(review.status, 'blocked', `review must be held for parent action, got ${review.status}`);
		assert.match(String(review.reason), /Parent decision required/i);
		assert.match(String(review.reason), /explicitly requeue/i);
		assert.equal(review.runId, undefined, 'settlement releases the reviewer run lease');
		const retry = await dispatch(h, 'W-rev-57', 'cp', 'W-rev-57-no-auto-retry');
		assert.equal(retry.block, true, `blocked INCOMPLETE review must not auto-retry: ${retry.reason ?? ''}`);
		assert.equal(review.status, 'blocked');
	});

	await test('a successor in the SAME writePaths stays updatable', async () => {
		const updated = await h.ledger({ action: 'update', updates: [{ id: 'W-58', status: 'blocked', evidence: ['fixture: successor parked'], reason: 'Successor must remain mutable while nobody writes this scope' }] });
		const text = updated.content.map((c: any) => c.text).join('\n');
		console.log(`    update isError=${updated.isError === true} :: ${text.split('\n')[0]}`);
		assert.notEqual(updated.isError, true, `successor update must not be rejected: ${text.split('\n')[0]}`);
		assert.equal(h.task('W-58').status, 'blocked');
		// Restore it so the dispatch assertion below exercises the ready path.
		await h.ledger({ action: 'update', updates: [{ id: 'W-58', status: 'ready', evidence: ['fixture: successor released'], reason: 'Successor owns the scope again' }] });
		assert.equal(h.task('W-58').status, 'ready');
	});

	await test('the dead attempt no longer reports a live lease conflict', () => {
		// loadLeases() replays the append-only log into a Map keyed by runId, so the last entry per
		// runId is the attempt's effective ownership record; earlier entries are history only.
		const byRun = new Map<string, any>();
		for (const e of h.entries()) if (e.customType === 'team-child-lease' && e.data?.runId) byRun.set(e.data.runId, e.data);
		const live = [...byRun.values()].filter((lease: any) => ['running', 'uncertain', 'reviewing'].includes(lease.status) && (lease.id === 'W-57' || lease.parentTaskId === 'W-57'));
		console.log(`    live leases after settle: ${JSON.stringify(live.map((l: any) => ({ id: l.id, runId: l.runId, status: l.status })))} `);
		assert.deepEqual(live, [], 'the settled attempt must not keep a live child lease');
	});

	await test('a successor in the SAME writePaths stays dispatchable', async () => {
		const res = await dispatch(h, 'W-58', 'bridges');
		console.log(`    dispatch block=${res.block === true} reason=${res.block === true ? res.reason : 'none'}`);
		assert.notEqual(res.block, true, `successor dispatch must not be blocked by a dead attempt: ${res.reason ?? ''}`);
	});

	await test('the safety property survives: a genuinely live child still blocks the same scope', async () => {
		const h2 = harness();
		await h2.start();
		await h2.emit('input', { text: 'live child guard', source: 'rpc' });
		const requestId = h2.state().ledger.requests.at(-1).id;
		await h2.ledger({ action: 'add', tasks: [spec(requestId, 'W-57'), spec(requestId, 'W-58')] });
		assert.notEqual((await dispatch(h2, 'W-57', 'bridges')).block, true);
		await childResult(h2, 'W-57', CHILD, 'running'); // still executing: no report, no review
		assert.equal((await dispatch(h2, 'W-58', 'bridges')).block, true, 'a still-running child must keep blocking its write scope');
		const updated = await h2.ledger({ action: 'update', updates: [{ id: 'W-58', status: 'blocked', evidence: ['fixture'], reason: 'must be rejected' }] });
		const text = updated.content.map((c: any) => c.text).join('\n');
		assert.equal(updated.isError, true);
		assert.match(text, /A still-live child owns this task\/scope on another branch\. Reconcile that execution before updating\./);
	});

	console.log(`\n${passed} passed — review settle releases the finished attempt's write scope.`);
} catch (error) {
	console.error('\nFAILED:', error instanceof Error ? error.message : error);
	throw error;
}
