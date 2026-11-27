/** Batch 1 rework regression tests: R2 settlement/cancel bypass exactness, R3 provenance fail-closed,
 *  R4 artefact-missing escalation, H1/M1/M2 manualDispatch+dependsOn+scope guards, L3 steer injection. */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import team, { initialState, defaultConfig, newGoal } from '../extensions/team.ts';
import {
	newLedger, addRequest, addTasks, updateTask, amendTask, createReviewerTask, recordReview,
	deliveryVersionOf, classifyReviewCurrency, preserveManualDispatchOnReadyReturn,
} from '../team-ledger.ts';

let seq = 0, passed = 0;
const root = mkdtempSync(join(tmpdir(), 'team-batch1-rework-'));
process.env.PI_CODING_AGENT_DIR = root;
writeFileSync(join(root, 'team.json'), JSON.stringify({ autoWorktreeOnConflict: false, maxConcurrent: 2, sessionBudgetUSD: 0.001, maxAutoRetries: 1, goalMaxRounds: 1, goalMaxStalls: 1, roles: { bridges: { maxCalls: 99, budgetUSD: 0.001 } }, fallbacks: {} }));

function harness(seed?: any[], child = false) {
	const state = initialState(defaultConfig()); state.enabled = true; state.startedAt = '2026-01-01'; state.goal = newGoal('Original goal', ['Original acceptance']);
	let entries: any[] = seed ?? [{ type: 'custom', id: 'seed', customType: 'team-state', data: state }]; let branch = entries;
	if (child) entries.push({ type: 'custom', id: 'child', customType: 'pi-web:subagent', data: { version: 1, parentSessionId: 'parent' } });
	const hooks = new Map<string, Function[]>(), tools = new Map<string, any>(), commands = new Map<string, any>();
	const ctx: any = { cwd: root, hasUI: true, isIdle: () => true, sessionManager: { getEntries: () => entries, getBranch: () => branch, getSessionId: () => 'parent', getSessionFile: () => join(root, 'parent.jsonl') }, ui: { notify: () => {}, setStatus() {} }, model: { provider: 'fixture', id: 'unused' }, modelRegistry: { find: () => undefined } };
	const pi: any = { on: (n: string, f: Function) => hooks.set(n, [...(hooks.get(n) ?? []), f]), registerFlag() {}, getFlag: () => false, registerTool: (t: any) => tools.set(t.name, t), registerCommand: (n: string, c: any) => commands.set(n, c), appendEntry: (t: string, data: any) => { const e = { type: 'custom', id: `e${++seq}`, customType: t, data }; entries.push(e); if (branch !== entries) branch.push(e); }, getThinkingLevel: () => 'high', sendMessage() {}, sendUserMessage: async () => {} };
	team(pi);
	return {
		ctx, tools, entries: () => entries,
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

/** Forge a child session JSONL fixture inside PI_CODING_AGENT_DIR/sessions/<dir>/. */
function forgeSession(sessionId: string, entries: object[]): string {
	const dir = join(root, 'sessions', `forge-${sessionId}`);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
	const lines = [JSON.stringify({ type: 'session', id: sessionId, timestamp: '2026-01-01T00:00:00.000Z' }), ...entries.map(e => JSON.stringify(e))];
	writeFileSync(file, lines.join('\n') + '\n');
	return file;
}

try {
	// ── R2: cancel path — non-live target cancellation is not blocked by unrelated live readers ──
	await test('R2: cancel of a non-live unleased task succeeds while an unrelated live reader runs', async () => {
		const h = harness(); await h.start(); const q = await request(h);
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-x', { reviewTier: 'none' }), spec(q, 'W-y', { reviewTier: 'none' })] });
		// W-y is dispatched and live; W-x was never dispatched (no lease). Cancelling W-x must succeed.
		await dispatch(h, 'W-y'); await result(h, 'W-y', 'child-y', 'running');
		const res = await h.ledger({ action: 'cancel', updates: [{ id: 'W-x', reason: 'user says drop it', evidence: ['user authority: test fixture'] }] });
		assert.equal(res.isError, undefined, JSON.stringify(res.content?.[0]?.text ?? res).slice(0, 300));
		assert.equal(h.state().ledger.tasks.find((t: any) => t.id === 'W-x').status, 'cancelled');
		assert.equal(h.state().ledger.tasks.find((t: any) => t.id === 'W-y').status, 'running', 'live task untouched');
	});

	// ── R2: bulk update metadata settlement bypass (already covered in batch1-controls, assert live rejection again here) ──
	await test('R2: live target settlement in the SAME bulk call as a non-live settlement only blocks the live one', async () => {
		const h = harness(); await h.start(); const q = await request(h);
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-a', { reviewTier: 'none' }), spec(q, 'W-b', { reviewTier: 'none' })] });
		// W-b never dispatched → non-live; W-a dispatched & running → live.
		await dispatch(h, 'W-a'); await result(h, 'W-a', 'child-a', 'running');
		const res = await h.ledger({ action: 'update', updates: [
			{ id: 'W-b', status: 'cancelled', evidence: ['user authority'], reason: 'dropped' },
			{ id: 'W-a', status: 'done', evidence: ['x'], reason: 'silent settle attempt' },
		] });
		assert.equal(res.isError, true, 'live target silent settle must reject the call');
		// Atomic mutation: neither applied.
		assert.equal(h.state().ledger.tasks.find((t: any) => t.id === 'W-a').status, 'running');
		assert.notEqual(h.state().ledger.tasks.find((t: any) => t.id === 'W-b').status, 'cancelled');
	});

	// ── R3: cancel with foreign provenance fails closed ──
	await test('R3: cancel on a session with foreign provenance sends no stop and never releases the lease', async () => {
		const h = harness(); await h.start(); const q = await request(h);
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-a', { reviewTier: 'none' })] });
		const sid = `foreign-${randomUUID().slice(0, 8)}`;
		await dispatch(h, 'W-a'); await result(h, 'W-a', sid, 'running');
		// The harness marks the task 'running' with this sessionId. Complete the child so the ledger is
		// non-live but the lease remains in the ledger task (reported). Forge a FOREIGN session file.
		await result(h, 'other', sid, 'completed');
		const t = h.state().ledger.tasks.find((x: any) => x.id === 'W-a');
		assert.equal(t.status, 'reported');
		forgeSession(sid, [{ type: 'custom', id: 'x', customType: 'pi-web:subagent', data: { version: 1, parentSessionId: 'some-other-parent' } }]);
		const res = await h.ledger({ action: 'cancel', updates: [{ id: 'W-a', reason: 'cancel requested', evidence: ['user authority: test'] }] });
		assert.equal(res.isError, undefined, 'the cancel call itself succeeds; the task outcome is blocked');
		const after = h.state().ledger.tasks.find((x: any) => x.id === 'W-a');
		assert.equal(after.status, 'blocked', `foreign provenance must fail closed to blocked, got ${after.status}`);
		assert.ok((after.evidence ?? []).some((l: string) => l.includes('PROVENANCE')), 'provenance failure recorded in evidence');
		assert.ok((after.reason ?? '').includes('provenance'), 'reason names the provenance failure');
		assert.equal(after.sessionId, sid, 'lease/session identity retained — never released');
	});

	await test('R3: cancel succeeds for a session whose provenance binds THIS parent', async () => {
		const h = harness(); await h.start(); const q = await request(h);
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-a', { reviewTier: 'none' })] });
		const sid = `ours-${randomUUID().slice(0, 8)}`;
		await dispatch(h, 'W-a'); await result(h, 'W-a', sid, 'running');
		await result(h, 'other', sid, 'completed');
		forgeSession(sid, [{ type: 'custom', id: 'x', customType: 'pi-web:subagent', data: { version: 1, parentSessionId: 'parent' } }]);
		const res = await h.ledger({ action: 'cancel', updates: [{ id: 'W-a', reason: 'done with it', evidence: ['user authority: test'] }] });
		assert.equal(res.isError, undefined, JSON.stringify(res.content?.[0]?.text ?? res).slice(0, 300));
		assert.equal(h.state().ledger.tasks.find((x: any) => x.id === 'W-a').status, 'cancelled');
	});

	await test('R3: cancel with NO session file at all fails closed (unproven, never pretends)', async () => {
		const h = harness(); await h.start(); const q = await request(h);
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-a', { reviewTier: 'none' })] });
		const sid = `ghost-${randomUUID().slice(0, 8)}`;
		await dispatch(h, 'W-a'); await result(h, 'W-a', sid, 'running');
		await result(h, 'other', sid, 'completed');
		const res = await h.ledger({ action: 'cancel', updates: [{ id: 'W-a', reason: 'cancel requested', evidence: ['user authority: test'] }] });
		assert.equal(res.isError, undefined);
		const after = h.state().ledger.tasks.find((x: any) => x.id === 'W-a');
		assert.equal(after.status, 'blocked', `missing session file must fail closed to blocked, got ${after.status}`);
		assert.equal(after.sessionId, sid, 'lease retained');
	});

	// ── R4: currency classification unit tests ──
	await test('R4: classifyReviewCurrency — drifted vs artefact-missing vs unpinned vs current', async () => {
		assert.equal(classifyReviewCurrency('abc#2', 'abc#2').currency, 'current');
		assert.equal(classifyReviewCurrency('abc#2', 'def#2').currency, 'drifted');
		assert.equal(classifyReviewCurrency('abc#2', 'noartefact').currency, 'artefact-missing');
		assert.equal(classifyReviewCurrency('abc#2', undefined).currency, 'artefact-missing');
		assert.equal(classifyReviewCurrency('nopin', 'other').currency, 'drifted', 'pinned without suffix that simply differs = drifted');
		assert.equal(classifyReviewCurrency(undefined, 'abc#1').currency, 'unpinned');
	});

	// ── R4: recordReview behaviour — stale discard vs artefact-missing escalation ──
	function reviewBoard(fingerprint: string) {
		const dir = mkdtempSync(join(tmpdir(), 'r4-board-'));
		const board = newLedger();
		const req = addRequest(board, 'x', 'r4');
		addTasks(board, [{ title: 'w', role: 'bridges', requestIds: [req.id], dependsOn: [], readPaths: [], writePaths: [join(dir, 'src')], acceptance: ['a'] }], dir);
		const worker = board.tasks[0];
		worker.status = 'reported'; worker.runId = 'r'; worker.sessionId = 's'; worker.dispatchedAt = '2026-01-01T00:00:00.000Z';
		const rev = createReviewerTask(board, worker, 'cp', fingerprint);
		return { board, worker, rev };
	}
	await test('R4: fingerprint mismatch WITH artefact present discards verdict as STALE', async () => {
		const { board, worker, rev } = reviewBoard('aaa#2');
		const out = recordReview(board, {
			reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'PASS', checks: [], defects: [], nextActions: [],
			raw: 'VERDICT: PASS', parsed: false, reasons: [], deliveryVersion: deliveryVersionOf(worker),
			createdAt: new Date().toISOString(),
		}, { deliveryVersion: deliveryVersionOf(worker), fingerprint: 'bbb#2' });
		assert.equal(out.reviewTask.status, 'superseded', 'drifted verdict is discarded as STALE');
		assert.notEqual(out.workerTask.status, 'done', 'worker must NOT settle on a drifted PASS');
		const rec = board.reviewRecords!.at(-1)!;
		assert.equal(rec.verdict, 'STALE');
	});

	await test('R4: artefact missing/unreadable escalates to INCOMPLETE — never silently discarded as stale', async () => {
		const { board, worker, rev } = reviewBoard('aaa#2');
		const out = recordReview(board, {
			reviewTaskId: rev.id, workerTaskId: worker.id, verdict: 'PASS', checks: [], defects: [], nextActions: [],
			raw: 'VERDICT: PASS', parsed: false, reasons: [], deliveryVersion: deliveryVersionOf(worker),
			createdAt: new Date().toISOString(),
		}, { deliveryVersion: deliveryVersionOf(worker), fingerprint: 'noartefact' });
		const rec = board.reviewRecords!.at(-1)!;
		assert.equal(rec.verdict, 'INCOMPLETE', `artefact-missing must not become STALE, got ${rec.verdict}`);
		assert.ok(rec.reasons.some(r => r.startsWith('artefact_missing_or_unreadable')), `escalation reason recorded: ${rec.reasons.join(',')}`);
		assert.equal(out.reviewTask.status, 'blocked', 'INCOMPLETE blocks the reviewer for a parent decision');
		assert.notEqual(out.workerTask.status, 'done', 'worker never settles on an unverifiable verdict');
	});

	// ── H1: amend retryAsRework preserves manualDispatch origin ──
	await test('H1: amend retryAsRework preserves manualDispatch hold via durable origin evidence', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'h1-board-'));
		const board = newLedger();
		const req = addRequest(board, 'x', 'h1');
		addTasks(board, [{ title: 'w', role: 'bridges', requestIds: [req.id], dependsOn: [], readPaths: [], writePaths: ['src/h1'], acceptance: ['a'] }], dir);
		const worker = board.tasks[0];
		worker.manualDispatch = true;
		worker.status = 'failed';
		worker.evidence.push('[MANUAL DISPATCH HOLD] recorded at 2026-01-01T00:00:00.000Z origin=manual-dispatch');
		amendTask(board, { id: worker.id, retryAsRework: true, reason: 'retry', evidence: ['test'] });
		assert.equal(worker.status, 'ready');
		assert.equal(worker.manualDispatch, true, 'manualDispatch hold must survive retry-as-rework');
	});

	// ── M1: amend dependsOn rejects cycles and cancelled deps ──
	await test('M1: amend dependsOn rejects transitive cycles and cancelled dependencies', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'm1-board-'));
		const board = newLedger();
		const req = addRequest(board, 'x', 'm1');
		addTasks(board, [
			{ id: 'W-1', title: 'a', role: 'bridges', requestIds: [req.id], dependsOn: [], readPaths: [], writePaths: ['src/m1a'], acceptance: ['a'] },
			{ id: 'W-2', title: 'b', role: 'bridges', requestIds: [req.id], dependsOn: [], readPaths: [], writePaths: ['src/m1b'], acceptance: ['a'] },
		], dir);
		// Cancelled dependency.
		board.tasks[1].status = 'cancelled';
		assert.throws(() => amendTask(board, { id: 'W-1', dependsOn: ['W-2'], reason: 'r', evidence: ['e'] }), /cancelled\/superseded/);
		// Restore, create a transitive cycle: W-2 depends on W-1, then amend W-1 to depend on W-2.
		board.tasks[1].status = 'planned';
		board.tasks[1].dependsOn = ['W-1'];
		const priorDependsOn = board.tasks[0].dependsOn;
		assert.throws(() => amendTask(board, { id: 'W-1', dependsOn: ['W-2'], reason: 'r', evidence: ['e'] }), /cycle/);
		assert.deepEqual(board.tasks[0].dependsOn, priorDependsOn, 'dependsOn rolled back on cycle rejection');
	});

	// ── M2: amend readPaths/writePaths rejected on live leased task ──
	await test('M2: amend of read/write scope on a live leased task is refused', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'm2-board-'));
		const board = newLedger();
		const req = addRequest(board, 'x', 'm2');
		addTasks(board, [{ title: 'w', role: 'bridges', requestIds: [req.id], dependsOn: [], readPaths: [], writePaths: [join(dir, 'src/m2')], acceptance: ['a'] }], dir);
		const worker = board.tasks[0];
		worker.status = 'running'; worker.sessionId = 'sess'; worker.runId = 'run';
		assert.throws(() => amendTask(board, { id: worker.id, writePaths: [join(dir, 'src/other')], reason: 'r', evidence: ['e'] }), /in-flight child/);
		assert.deepEqual(worker.writePaths, [join(dir, 'src/m2')], 'scope unchanged');
		// Non-leased running state (uncertain reconcile edge) — still running but no lease: allowed.
		delete worker.sessionId; delete worker.runId;
		amendTask(board, { id: worker.id, writePaths: [join(dir, 'src/other')], reason: 'r', evidence: ['e'] });
		assert.deepEqual(worker.writePaths, [join(dir, 'src/other')]);
		// L5: the briefHistory entry records the PRIOR values of changed fields for forensic reconstruction.
		const hist = (worker as any).briefHistory?.at(-1);
		assert.deepEqual(hist?.prior?.writePaths, [join(dir, 'src/m2')], `prior writePaths must be recorded, got ${JSON.stringify(hist?.prior)}`);
		assert.deepEqual(hist?.fields, ['writePaths']);
	});

	// ── L3: pending steers are injected into the resume/dispatch prompt ──
	await test('L3: steer recorded after dispatch is injected into the next dispatch/resume prompt', async () => {
		const h = harness(); await h.start(); const q = await request(h);
		await h.ledger({ action: 'add', tasks: [spec(q, 'W-a', { reviewTier: 'none' })] });
		const sid = `steer-${randomUUID().slice(0, 8)}`;
		await dispatch(h, 'W-a'); await result(h, 'W-a', sid, 'running');
		await result(h, 'other', sid, 'completed');
		// Record a steer through the ledger (native, child not active → recorded for next dispatch).
		const steerRes = await h.ledger({ action: 'steer', steers: [{ id: 'W-a', message: 'use the narrow parser, not the broad one' }] });
		assert.equal(steerRes.isError, undefined, JSON.stringify(steerRes.content?.[0]?.text ?? steerRes).slice(0, 200));
		// Return the task to ready for a retry; the steer recorded AFTER the prior dispatch must then
		// be injected into the next dispatch prompt.
		const amendRes = await h.ledger({ action: 'amend', amendments: [{ id: 'W-a', retryAsRework: true, reason: 'rework needed', evidence: ['review verdict REWORK'] }] });
		assert.equal(amendRes.isError, undefined, JSON.stringify(amendRes.content?.[0]?.text ?? amendRes).slice(0, 200));
		// Re-dispatch: the tool_call interception must inject the pending steer into the prompt.
		const evt = await h.emit('tool_call', { toolName: 'Agent', toolCallId: 'W-a-redispatch', input: { subagent_type: 'bridges', prompt: 'TEAM_TASK: W-a\nGoal: bounded fixture work.\nRole: bridges.\n[MANUAL DISPATCH] The operator is dispatching this task manually.' } });
		assert.notEqual(evt?.block, true, `redispatch must not be blocked: ${evt?.reason ?? '(no reason)'}`);
		const prompt = evt?.input?.prompt ?? '';
		assert.ok(prompt.includes('Pending parent steering'), `steer block must be injected, prompt head: ${prompt.slice(0, 400)}`);
		assert.ok(prompt.includes('use the narrow parser'), 'steer message content is in the prompt');
	});

	console.log(`# ${passed} batch1 rework tests passed`);
	process.exit(0);
} catch (error) {
	console.error('✗ FAILED:', error);
	process.exit(1);
}
