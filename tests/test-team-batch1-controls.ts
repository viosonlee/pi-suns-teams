/** Batch 1 (P0) regression tests: settlement decoupling, reviewer snapshot, cancel/steer, amend/retry, manualDispatch, review policy. */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import team, { initialState, defaultConfig, newGoal } from '../extensions/team.ts';
import {
	newLedger, addRequest, addTasks, updateTask, isMetadataSettlementTransition, decideCancelAction,
	validateSteerTarget, amendTask, createReviewerTask, isReviewExempt, decideReviewPolicy, liveWork,
	preserveManualDispatchOnReadyReturn, recordManualDispatchOrigin, reviewerTaskId, terminalWork,
} from '../team-ledger.ts';

let seq = 0, passed = 0;
const root = mkdtempSync(join(tmpdir(), 'team-batch1-'));
process.env.PI_CODING_AGENT_DIR = root;
writeFileSync(join(root, 'team.json'), JSON.stringify({ autoWorktreeOnConflict: false, maxConcurrent: 2, sessionBudgetUSD: 0.001, maxAutoRetries: 1, goalMaxRounds: 1, goalMaxStalls: 1, roles: { bridges: { maxCalls: 1, budgetUSD: 0.001 } }, fallbacks: {} }));

function harness(seed?: any[], child = false) {
	const state = initialState(defaultConfig()); state.enabled = true; state.startedAt = '2026-01-01'; state.goal = newGoal('Original goal', ['Original acceptance']);
	let entries: any[] = seed ?? [{ type: 'custom', id: 'seed', customType: 'team-state', data: state }]; let branch = entries;
	if (child) entries.push({ type: 'custom', id: 'child', customType: 'pi-web:subagent', data: { parentSessionId: 'parent' } });
	const hooks = new Map<string, Function[]>(), tools = new Map<string, any>(), commands = new Map<string, any>(), notes: string[] = [];
	const ctx: any = { cwd: root, hasUI: true, isIdle: () => true, sessionManager: { getEntries: () => entries, getBranch: () => branch, getSessionId: () => 'parent', getSessionFile: () => join(root, 'parent.jsonl') }, ui: { notify: () => {}, setStatus() {} }, model: { provider: 'fixture', id: 'unused' }, modelRegistry: { find: () => undefined } };
	const pi: any = { on: (n: string, f: Function) => hooks.set(n, [...(hooks.get(n) ?? []), f]), registerFlag() {}, getFlag: () => false, registerTool: (t: any) => tools.set(t.name, t), registerCommand: (n: string, c: any) => commands.set(n, c), appendEntry: (t: string, data: any) => { const e = { type: 'custom', id: `e${++seq}`, customType: t, data }; entries.push(e); if (branch !== entries) branch.push(e); }, getThinkingLevel: () => 'high', sendMessage() {}, sendUserMessage: async () => {} };
	team(pi);
	return {
		ctx, tools, notes, entries: () => entries,
		state: () => [...branch].reverse().find(e => e.customType === 'team-state').data,
		async emit(name: string, event: any = {}) { let e = event; for (const f of hooks.get(name) ?? []) { const p = await f(e, ctx); if (p) e = { ...e, ...p }; } return e; },
		async start() { await this.emit('session_start', { reason: 'startup' }); },
		async ledger(p: any) { return tools.get('team_tasks').execute(`ledger${++seq}`, p, undefined, undefined, ctx); },
	};
}
async function test(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log(`✓ ${name}`); }
async function request(h: any, text = 'Additional task') { await h.emit('input', { text, source: 'rpc' }); return h.state().ledger.requests.at(-1).id; }
const spec = (q: string, id: string, extra: any = {}) => ({ id, title: id, role: 'bridges', requestIds: [q], dependsOn: [], readPaths: [], writePaths: [`src/${id}`], acceptance: ['verified output'], ...extra });
async function dispatch(h: any, id: string, call = id, extra: any = {}) { return h.emit('tool_call', { toolName: 'Agent', toolCallId: call, input: { subagent_type: 'bridges', prompt: `TEAM_TASK: ${id}\nGoal: bounded fixture work.`, ...extra } }); }
async function result(h: any, call: string, sessionId: string, status = 'completed') { return h.emit('tool_result', { toolName: 'Agent', toolCallId: call, input: {}, isError: false, details: { sessionId, status }, content: [{ type: 'text', text: status === 'completed' ? 'Verified report body' : 'Task accepted' }] }); }

try {
	await test('pure: isMetadataSettlementTransition — non-live to terminal true, live target never silently settles', async () => {
		assert.equal(isMetadataSettlementTransition('reported', 'done'), true);
		assert.equal(isMetadataSettlementTransition('reported', 'cancelled'), true);
		assert.equal(isMetadataSettlementTransition('failed', 'superseded'), true);
		assert.equal(isMetadataSettlementTransition('blocked', 'done'), true);
		for (const live of ['running', 'uncertain', 'reviewing'] as const) {
			assert.equal(isMetadataSettlementTransition(live, 'done'), false, `${live} target must never silently settle`);
			assert.equal(isMetadataSettlementTransition(live, 'cancelled'), false);
		}
		assert.equal(isMetadataSettlementTransition('reported', 'ready'), false);
		assert.equal(isMetadataSettlementTransition('ready', 'reported'), false);
		assert.equal(isMetadataSettlementTransition(undefined, 'done'), true);
	});

	await test('1.1 settlement bypass: reported target settles done despite unrelated live strict reader holding its scope', async () => {
		const h = harness(); await h.start(); const q = await request(h);
		// W-a (writer) shares scope with W-cp (strict reader). W-cp stays live; W-a reports.
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-a', { reviewTier: 'none' }), spec(q, 'W-cp', { role: 'cp', writePaths: [], readPaths: ['src/W-a'], readMode: 'strict', reviewTier: 'none' })] });
		await dispatch(h, 'W-a'); await result(h, 'W-a', 'child-a', 'running');
		await dispatch(h, 'W-cp'); await result(h, 'W-cp', 'child-cp', 'running');
		// W-a completes → reported (bridges requires review, but exempt paths irrelevant here).
		await result(h, 'other', 'child-a', 'completed');
		assert.equal(h.state().ledger.tasks[0].status, 'reported', `reviewTier none delivery must stay reported, got ${h.state().ledger.tasks[0].status}`);
		// W-cp still running (live strict reader on W-a's write scope). Settling W-a must NOT be blocked by it.
		const settle = await h.ledger({ action: 'update', updates: [{ id: 'W-a', status: 'done', evidence: ['test: exit 0'], reason: 'Parent verified' }] });
		assert.equal(settle.isError, undefined, JSON.stringify(settle.content?.[0]?.text ?? settle).slice(0, 300));
		assert.equal(h.state().ledger.tasks.find((t: any) => t.id === 'W-a').status, 'done');
	});

	await test('1.1 settlement bypass does NOT apply to a live target itself', async () => {
		const h = harness(); await h.start(); const q = await request(h);
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-a')] });
		await dispatch(h, 'W-a'); await result(h, 'W-a', 'child-a', 'running');
		// Running child: silent settlement is forbidden.
		assert.equal((await h.ledger({ action: 'update', updates: [{ id: 'W-a', status: 'done', evidence: ['x'], reason: 'x' }] })).isError, true);
		assert.equal((await h.ledger({ action: 'update', updates: [{ id: 'W-a', status: 'cancelled', evidence: ['x'], reason: 'x' }] })).isError, true);
		assert.equal(h.state().ledger.tasks[0].status, 'running');
	});

	await test('1.1 reviewer task creation uses readMode snapshot and inherits manualDispatch', async () => {
		const board = newLedger();
		const req = addRequest(board, 'x', 'test');
		const [worker] = addTasks(board, [{ id: 'W-1', title: 'worker', role: 'booker', requestIds: [req.id], dependsOn: [], readPaths: [], writePaths: ['src/x'], acceptance: ['ac1'] }], root);
		worker.status = 'reported'; worker.runId = 'r'; worker.sessionId = 's'; worker.dispatchedAt = '2026-01-01T00:00:00.000Z';
		const rev = createReviewerTask(board, worker, 'cp', 'fp');
		assert.equal(rev.readMode, 'snapshot', 'reviewers must use snapshot reads');
		assert.equal(rev.writePaths.length, 0);
		assert.equal(rev.manualDispatch, undefined, 'no manualDispatch on an auto worker');
		// manualDispatch inheritance.
		const board2 = newLedger();
		const req2 = addRequest(board2, 'x', 'test');
		const [w2] = addTasks(board2, [{ id: 'W-1', title: 'worker', role: 'booker', requestIds: [req2.id], dependsOn: [], readPaths: [], writePaths: ['src/x'], acceptance: ['ac1'] }], root, { manualDispatch: true, manualDispatchReason: 'operator controlled' });
		assert.equal(w2.manualDispatch, true, 'addTasks manualDispatch option applies the hold');
		w2.status = 'reported'; w2.runId = 'r'; w2.sessionId = 's'; w2.dispatchedAt = '2026-01-01T00:00:00.000Z';
		const rev2 = createReviewerTask(board2, w2, 'cp', 'fp');
		assert.equal(rev2.manualDispatch, true, 'reviewer inherits manualDispatch');
	});

	await test('1.4 reviewTier none + autoAccept:false spawns no reviewer; explicit reviewerRole forces one', async () => {
		assert.equal(decideReviewPolicy('booker', { reviewTier: 'none', autoAccept: false }).spawnReviewerOnDelivery, false);
		assert.equal(decideReviewPolicy('booker', { reviewerRole: 'cp', reviewTier: 'none' }).spawnReviewerOnDelivery, true);
		assert.equal(decideReviewPolicy('booker', { reviewTier: 'llm' }).spawnReviewerOnDelivery, true);
		assert.equal(decideReviewPolicy('booker', { reviewTier: 'deterministic', autoAccept: true }).automaticSettlement, true);
		assert.equal(decideReviewPolicy('ayton', {}).exemptByDefault, true);
		assert.equal(decideReviewPolicy('cameron', {}).exemptByDefault, true);
		assert.equal(decideReviewPolicy('booker', {}).spawnReviewerOnDelivery, true);
		assert.equal(decideReviewPolicy('bridges', {}).spawnReviewerOnDelivery, true);
		assert.equal(decideReviewPolicy('cp', {}).exemptByDefault, true, 'cp consult default exempt via unified policy');
		// autoAccept:false on unset tier explicitly requests review (for writer roles):
		assert.equal(decideReviewPolicy('booker', { autoAccept: false }).spawnReviewerOnDelivery, true);
		// isReviewExempt mirrors the spawn decision for writer roles:
		const board = newLedger();
		const req = addRequest(board, 'x', 't');
		const mk = (fields: any) => {
			const b = newLedger();
			const r = addRequest(b, 'x', 't');
			return addTasks(b, [{ id: 'W-1', title: 't', role: 'booker', requestIds: [r.id], dependsOn: [], readPaths: [], writePaths: ['src/x'], acceptance: ['a'], ...fields }], root)[0];
		};
		assert.equal(isReviewExempt(mk({ reviewTier: 'none', autoAccept: false })), true);
		assert.equal(isReviewExempt(mk({ reviewerRole: 'cp' })), false);
		assert.equal(isReviewExempt(mk({ reviewTier: 'llm' })), false);
		assert.equal(isReviewExempt(mk({})), false);
	});

	await test('1.4 manualDispatch preserved on rework return to ready (evidence origin survives consumption)', async () => {
		const board = newLedger();
		const req = addRequest(board, 'x', 't');
		const [worker] = addTasks(board, [{ id: 'W-1', title: 'w', role: 'bridges', requestIds: [req.id], dependsOn: [], readPaths: [], writePaths: ['src/x'], acceptance: ['a'] }], root, { manualDispatch: true, manualDispatchReason: 'operator controlled' });
		assert.equal(worker.manualDispatch, true);
		// Simulate dispatch consuming the hold (origin recorded first).
		recordManualDispatchOrigin(worker);
		worker.manualDispatch = undefined as any; delete (worker as any).manualDispatch; delete (worker as any).manualDispatchReason; delete (worker as any).manualDispatchAt;
		worker.status = 'reported'; worker.runId = 'r1'; worker.sessionId = 's1'; worker.dispatchedAt = '2026-01-01T00:00:00.000Z';
		preserveManualDispatchOnReadyReturn(worker);
		assert.equal(worker.manualDispatch, true, 'rework return to ready preserves manualDispatch');
	});

	await test('1.3 brief registration, amendment history, terminal guard', async () => {
		const board = newLedger();
		const req = addRequest(board, 'x', 't');
		const [task] = addTasks(board, [{ id: 'W-1', title: 'w', role: 'bridges', requestIds: [req.id], dependsOn: [], readPaths: [], writePaths: ['src/x'], acceptance: ['a'], brief: 'initial brief' } as any], root);
		assert.equal(task.brief, 'initial brief');
		amendTask(board, { id: 'W-1', brief: 'amended brief v2', reason: 'operator clarification', evidence: ['user said so'], by: 'parent' });
		assert.equal(task.brief, 'amended brief v2');
		assert.equal(task.briefHistory.length, 1);
		assert.deepEqual(task.briefHistory[0].fields, ['brief']);
		assert.equal(task.briefHistory[0].reason, 'operator clarification');
		// Amend acceptance and paths.
		amendTask(board, { id: 'W-1', acceptance: ['a1', 'a2'], writePaths: ['src/x', 'src/y'], title: 'renamed', dependsOn: [], reason: 'scope adjustment', evidence: ['approved'], by: 'parent' });
		assert.deepEqual(task.acceptance, ['a1', 'a2']);
		assert.deepEqual(task.writePaths, ['src/x', 'src/y']);
		assert.equal(task.title, 'renamed');
		assert.equal(task.briefHistory.length, 2);
		// Terminal tasks are immutable.
		task.status = 'done'; task.archivedAt = new Date().toISOString();
		assert.throws(() => amendTask(board, { id: 'W-1', brief: 'sneaky', reason: 'x', evidence: ['x'], by: 'parent' }), /terminal|immutable/i, 'done tasks cannot be weakened');
	});

	await test('1.3 retryAsRework preserves same W-id and history', async () => {
		const board = newLedger();
		const req = addRequest(board, 'x', 't');
		const [task] = addTasks(board, [{ id: 'W-1', title: 'w', role: 'bridges', requestIds: [req.id], dependsOn: [], readPaths: [], writePaths: ['src/x'], acceptance: ['a'] }], root);
		task.status = 'reported'; task.runId = 'r1'; task.sessionId = 's1'; task.dispatchedAt = '2026-01-01T00:00:00.000Z'; task.evidence = ['attempt 1 report'];
		amendTask(board, { id: 'W-1', retryAsRework: true, reason: 'reviewer requested rework', evidence: ['VERDICT: REWORK in review'], by: 'parent' });
		assert.equal(task.status, 'ready');
		assert.equal(task.id, 'W-1', 'same W-id preserved');
		assert.equal(task.retryCount, 1);
		assert.ok(task.evidence.some((e: string) => e.includes('[RETRY-AS-REWORK]')), 'prior attempt recorded');
		assert.ok(task.evidence.includes('attempt 1 report'), 'prior evidence preserved');
		assert.equal(task.runId, undefined, 'finished lease identity released');
		assert.equal(task.sessionId, undefined);
	});

	await test('1.2 pure cancel decision matrix', async () => {
		assert.equal(decideCancelAction({ status: 'done' }, true).action, 'cancel', 'terminal tasks record cancellation only');
		assert.equal(decideCancelAction({ status: 'ready' }, true).action, 'cancel', 'never-dispatched task is safe to cancel');
		assert.equal(decideCancelAction({ status: 'running', sessionId: 's1', runId: 'r1' }, false).action, 'cancel', 'confirmed-not-live child cancels cleanly');
		const needsStop = decideCancelAction({ status: 'running', sessionId: 's1', runId: 'r1' }, true);
		assert.equal(needsStop.action, 'stop_required');
		assert.equal(needsStop.sessionId, 's1');
		const noSid = decideCancelAction({ status: 'running', runId: 'r1' }, true);
		assert.equal(noSid.action, 'blocked', 'no sessionId to target fails closed');
	});

	await test('1.2 cancel action: non-live task cancels; unconfirmed stop marks blocked not cancelled', async () => {
		// Non-live task (ready, never dispatched).
		const h = harness(); await h.start(); const q = await request(h);
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-a')] });
		const res = await h.ledger({ action: 'cancel', updates: [{ id: 'W-a', reason: 'user cancelled', evidence: ['user typed /cancel W-a'] }] });
		assert.equal(res.isError, undefined, JSON.stringify(res.content?.[0]?.text ?? '').slice(0, 200));
		assert.equal(h.state().ledger.tasks[0].status, 'cancelled');
		assert.ok(h.state().ledger.tasks[0].evidence.some((e: string) => e.includes('[CANCELLED]')));
		// Cancel requires evidence/authority.
		const h2 = harness(); await h2.start(); const q2 = await request(h2);
		await h2.ledger({ action: 'add', tasks: [spec(q2, 'W-a')] });
		assert.equal((await h2.ledger({ action: 'cancel', updates: [{ id: 'W-a', reason: 'x', evidence: [] }] })).isError, true, 'cancel without evidence refused');
		// Live native child, stop cannot be confirmed (fixture child not tracked as a real process):
		// ledger treats it as live → stop path attempted → unconfirmed → blocked, lease retained.
		const h3 = harness(); await h3.start(); const q3 = await request(h3);
		await h3.ledger({ action: 'add', tasks: [spec(q3, 'W-a')] });
		// Genuinely dispatch: the fixture child is not a real tracked process, so its stop can never be confirmed.
		await dispatch(h3, 'W-a'); await result(h3, 'W-a', 'nonexistent-child', 'running');
		assert.equal(h3.state().ledger.tasks[0].status, 'running');
		const res3 = await h3.ledger({ action: 'cancel', updates: [{ id: 'W-a', reason: 'operator cancel', evidence: ['user authority ref'] }] });
		const task3 = h3.state().ledger.tasks.find((t: any) => t.id === 'W-a');
		// The fixture child is not tracked anywhere: stop is unconfirmed → fail closed, never cancelled.
		assert.notEqual(task3.status, 'cancelled', 'unconfirmed stop must never claim cancelled');
		assert.ok(['blocked', 'uncertain'].includes(task3.status), `expected blocked/uncertain, got ${task3.status}`);
		assert.ok((task3.reason ?? '').includes('stop') || (task3.reason ?? '').includes('UNCONFIRMED'), 'reason explains the unconfirmed stop and retry route');
	});

	await test('1.2 steer validation: ledger-owned, non-terminal, bound child required', async () => {
		// Pure validation.
		assert.equal(validateSteerTarget(undefined, 'parent').ok, false);
		const base: any = { id: 'W-1', status: 'running', sessionId: 's1', parentSessionId: 'parent' };
		assert.equal(validateSteerTarget(base, 'parent').ok, true);
		assert.equal(validateSteerTarget({ ...base, status: 'done' }, 'parent').ok, false, 'terminal cannot steer');
		assert.equal(validateSteerTarget({ ...base, sessionId: undefined }, 'parent').ok, false, 'no child bound');
		assert.equal(validateSteerTarget({ ...base, parentSessionId: 'other-parent' }, 'parent').ok, false, 'foreign parent rejected');
		// Through the tool: unknown id and terminal task are rejected atomically.
		const h = harness(); await h.start(); const q = await request(h);
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-a')] });
		assert.equal((await h.ledger({ action: 'steer', steers: [{ id: 'W-missing', message: 'hello' }] })).isError, true);
		// Ready task with no bound child cannot be steered.
		assert.equal((await h.ledger({ action: 'steer', steers: [{ id: 'W-a', message: 'hello' }] })).isError, true);
		// Bind a child and steer: audit evidence is recorded even when native delivery is impossible.
		await dispatch(h, 'W-a'); await result(h, 'W-a', 'child-a', 'running');
		const steer = await h.ledger({ action: 'steer', steers: [{ id: 'W-a', message: 'please focus on error handling first' }] });
		assert.equal(steer.isError, undefined, JSON.stringify(steer.content?.[0]?.text ?? '').slice(0, 200));
		const ev = h.state().ledger.tasks[0].evidence;
		assert.ok(ev.some((e: string) => e.includes('[STEER]') && e.includes('focus on error handling')), 'steer audit evidence recorded');
	});

	await test('1.3 amend scope conflict validation via tool: write-write conflicts with live task refused', async () => {
		const h = harness(); await h.start(); const q = await request(h);
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-a'), spec(q, 'W-b', { writePaths: ['src/shared/'] })] });
		await dispatch(h, 'W-b'); await result(h, 'W-b', 'child-b', 'running');
		// Amending W-a to write into W-b's live directory write scope must be refused.
		const bad = await h.ledger({ action: 'amend', amendments: [{ id: 'W-a', writePaths: ['src/shared/core.ts'], reason: 'expand scope', evidence: ['operator decision'] }] });
		assert.equal(bad.isError, true, 'amend into live write scope must be refused');
		assert.ok((bad.content?.[0]?.text ?? '').includes('W-b'), 'error names the conflicting holder');
		// Non-conflicting amend succeeds.
		const good = await h.ledger({ action: 'amend', amendments: [{ id: 'W-a', writePaths: ['src/other.ts'], brief: 'narrower scope', reason: 'de-conflicting', evidence: ['operator decision'] }] });
		assert.equal(good.isError, undefined, JSON.stringify(good.content?.[0]?.text ?? '').slice(0, 200));
		assert.deepEqual(h.state().ledger.tasks.find((t: any) => t.id === 'W-a').writePaths, [join(root, 'src/other.ts')]);
		assert.equal(h.state().ledger.tasks.find((t: any) => t.id === 'W-a').brief, 'narrower scope');
	});

	await test('1.3 retryAsRework via tool returns failed task to ready with same id and releases finished lease', async () => {
		const h = harness(); await h.start(); const q = await request(h);
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-a')] });
		await h.ledger({ action: 'update', updates: [{ id: 'W-a', status: 'failed', evidence: ['first attempt failed'], reason: 'child error' }] });
		const res = await h.ledger({ action: 'amend', amendments: [{ id: 'W-a', retryAsRework: true, reason: 'flaky infra failure, retrying', evidence: ['parent verified failure cause'] }] });
		assert.equal(res.isError, undefined, JSON.stringify(res.content?.[0]?.text ?? '').slice(0, 200));
		const after = h.state().ledger.tasks.find((x: any) => x.id === 'W-a');
		assert.equal(after.status, 'ready');
		assert.equal(after.retryCount, 1);
		assert.ok(after.evidence.some((e: string) => e.includes('[RETRY-AS-REWORK]')));
	});

	await test('1.3 latest brief is injected into manual dispatch prompt', async () => {
		const h = harness(); await h.start(); const q = await request(h);
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-a', { brief: 'first brief' })] });
		await h.ledger({ action: 'amend', amendments: [{ id: 'W-a', brief: 'amended latest brief', reason: 'operator update', evidence: ['parent decision'] }] });
		const input: any = { subagent_type: 'bridges', prompt: 'TEAM_TASK: W-a\nGoal: bounded fixture work.' };
		await h.emit('tool_call', { toolName: 'Agent', toolCallId: 'call-x', input });
		assert.ok(input.prompt.includes('amended latest brief'), `latest amended brief injected, got: ${input.prompt.slice(0, 300)}`);
		assert.ok(!input.prompt.includes('first brief'), 'stale brief must not leak through');
	});

	await test('1.1 strict reader/writer invariants unchanged: live writer still blocks dependent writer', async () => {
		// Dispatch-level write-vs-write exclusion is unchanged: W-b overlapping W-a's live write scope is blocked.
		const h = harness(); await h.start(); const q = await request(h);
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-a'), spec(q, 'W-b', { writePaths: ['src/W-a'] })] });
		await dispatch(h, 'W-a'); await result(h, 'W-a', 'child-a', 'running');
		assert.equal((await dispatch(h, 'W-b')).block, true, 'write-vs-write mutual exclusion unchanged');
	});

	await test('1.1 lock rejection messages identify the holder and an executable next step', async () => {
		const h = harness(); await h.start(); const q = await request(h);
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-a'), spec(q, 'W-b', { writePaths: ['src/W-a'] })] });
		await dispatch(h, 'W-a'); await result(h, 'W-a', 'child-a', 'running');
		const blocked = await dispatch(h, 'W-b');
		const reason = blocked.reason ?? '';
		assert.ok(reason.includes('W-a'), `rejection names holder: ${reason.slice(0, 200)}`);
		assert.ok(/Next:|Fix:|wait|reconcile|cancel/i.test(reason), `rejection gives an executable next step: ${reason.slice(0, 200)}`);
	});

	console.log(`\n${passed} batch1 control tests passed`);
} catch (err) {
	console.error(err);
	process.exit(1);
}
