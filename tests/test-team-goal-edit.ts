/**
 * W-67 — precise goal editing without interrupting in-flight work.
 *
 * The user could only append to a goal before this change:
 *   `/team goal <objective>` merged with `objectives.join("\n+ ")`, unioned acceptance conditions
 *   (impossible to remove one), forced status back to "active", and appended another open
 *   `goal:Q-n` ledger request. `/team goal clear` also refused any goal that was not "complete",
 *   so a goal stopped with `/team goal stop` could never be cleared at all.
 *
 * The new surface under test:
 *   `/team goal edit <objective> [--accept "a;b;c" | --add-accept "d"]` — REPLACE semantics,
 *   `/team goal resume` — reactivate a stopped goal, `/team goal clear [--force]`.
 *
 * The hard requirement is the non-interruption invariant: editing/resuming/clearing a goal must not
 * touch task statuses, child leases, calls/spend/round counters, the scheduler daemon, the pending
 * internal (kickoff) prompt queue, or the ledger's open request list.
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import team, { initialState, defaultConfig, newGoal, parseGoalFlags } from '../extensions/team.ts';

const root = mkdtempSync(join(tmpdir(), 'team-goal-edit-'));
process.env.PI_CODING_AGENT_DIR = root;
writeFileSync(join(root, 'team.json'), JSON.stringify({ maxConcurrent: 8 }));

let seq = 0;
let passed = 0;

function harness(seed?: (state: any) => void) {
	const state: any = initialState(defaultConfig());
	state.enabled = true;
	state.startedAt = '2026-01-01';
	seed?.(state);
	const entries: any[] = [{ type: 'custom', id: 'seed', customType: 'team-state', data: state }];
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
	const h = {
		ctx, notes, entries: () => entries,
		state: () => [...branch].reverse().find(e => e.customType === 'team-state').data,
		task: (id: string) => [...branch].reverse().find(e => e.customType === 'team-state').data.ledger.tasks.find((t: any) => t.id === id),
		leaseEntries: () => entries.filter(e => e.customType === 'team-child-lease').map(e => JSON.stringify(e.data)),
		async emit(name: string, event: any = {}) {
			let e = event;
			for (const f of hooks.get(name) ?? []) { const p = await f(e, ctx); if (p) e = { ...e, ...p }; }
			return e;
		},
		async start() { await this.emit('session_start', { reason: 'startup' }); },
		async ledger(payload: any) { return tools.get('team_tasks').execute(`ledger${++seq}`, payload, undefined, undefined, ctx); },
		async cmd(args: string) { await commands.get('team').handler(args, ctx); return h.state(); },
		completions(prefix: string) { return (commands.get('team').getArgumentCompletions(prefix) ?? []).map((i: any) => i.value); },
	};
	return h;
}

async function test(name: string, fn: () => Promise<void>) {
	await fn();
	passed++;
	console.log(`✓ ${name}`);
}

const goalOf = (h: any) => h.state().goal;
const spec = (requestId: string, id: string) => ({
	id, title: `${id} deliverable`, role: 'bridges', requestIds: [requestId], dependsOn: [],
	readPaths: [], writePaths: [`src/${id}.ts`], acceptance: ['deliverable verified by an independent reviewer'],
});

const dispatch = (h: any, workId: string, role: string, call = workId) =>
	h.emit('tool_call', { toolName: 'Agent', toolCallId: call, input: { subagent_type: role, prompt: `TEAM_TASK: ${workId}\nGoal: bounded fixture work.` } });

/** Board with one running task (live lease), one ready task, and no kickoff prompts. */
async function boardWithLiveWork() {
	const h = harness(state => {
		state.spendUSD = 1.25;
		state.rounds = 2;
		state.calls.booker = 3;
		state.goal = { ...newGoal('W-67 original objective', ['accept one', 'accept two']), rounds: 2, stalls: 1 };
	});
	await h.start();
	await h.emit('input', { text: 'W-67 fixture request', source: 'rpc' });
	const requestId = h.state().ledger.requests.at(-1).id;
	const added = await h.ledger({ action: 'add', tasks: [spec(requestId, 'W-67-run'), spec(requestId, 'W-67-ready')] });
	assert.equal(added.isError, undefined);
	const res = await dispatch(h, 'W-67-run', 'bridges');
	assert.notEqual(res.block, true, `fixture dispatch must not be blocked: ${res.reason ?? ''}`);
	assert.equal(h.task('W-67-run').status, 'running');
	assert.equal(h.task('W-67-ready').status, 'ready');
	assert.ok(h.leaseEntries().length > 0, 'fixture must own a live child lease');
	return h;
}

function snapshot(h: any) {
	const state = h.state();
	return {
		taskStatuses: Object.fromEntries((state.ledger?.tasks ?? []).map((t: any) => [t.id, t.status])),
		leases: h.leaseEntries(),
		calls: JSON.stringify(state.calls),
		spendUSD: state.spendUSD,
		goalRounds: state.goal?.rounds ?? null,
		pendingInternalPrompts: (state.ledger?.pendingInternalPrompts ?? []).length,
		requests: (state.ledger?.requests ?? []).length,
		enabled: state.enabled,
	};
}

try {
	await test('edit replaces the objective verbatim across two edits, keeping previousObjective', async () => {
		const h = harness(state => { state.goal = newGoal('W-67 original objective', ['accept one']); });
		await h.start();
		await h.cmd('goal edit First replacement objective');
		let g = goalOf(h);
		console.log(`    after edit 1: ${JSON.stringify({ objective: g.objective, objectives: g.objectives })}`);
		assert.equal(g.objective, 'First replacement objective');
		assert.deepEqual(g.objectives, ['First replacement objective']);
		assert.deepEqual(g.acceptance, ['accept one'], 'edit without flags keeps the acceptance list');

		await h.cmd('goal edit Second replacement objective');
		g = goalOf(h);
		console.log(`    after edit 2: ${JSON.stringify({ objective: g.objective, objectives: g.objectives, editHistory: g.editHistory })}`);
		assert.equal(g.objective, 'Second replacement objective');
		assert.equal(g.objective.includes('\n+ '), false, 'edit must never accumulate the "\n+ " merge separator');
		assert.deepEqual(g.objectives, ['Second replacement objective']);
		assert.equal(g.editHistory.length, 2);
		assert.equal(g.editHistory[0].previousObjective, 'W-67 original objective');
		assert.deepEqual(g.editHistory[0].previousAcceptance, ['accept one']);
		assert.equal(g.editHistory[1].previousObjective, 'First replacement objective');
		assert.equal(typeof g.editHistory[1].at, 'string');
	});

	await test('--accept replaces, --add-accept appends, no flag keeps', async () => {
		const h = harness(state => { state.goal = newGoal('W-67 acceptance objective', ['a', 'b', 'c']); });
		await h.start();
		await h.cmd('goal edit W-67 acceptance objective --accept "x;y"');
		assert.deepEqual(goalOf(h).acceptance, ['x', 'y']);
		assert.equal(goalOf(h).objective, 'W-67 acceptance objective', 'flags must not leak into the objective text');

		await h.cmd('goal edit W-67 acceptance objective --add-accept "z"');
		assert.deepEqual(goalOf(h).acceptance, ['x', 'y', 'z']);

		await h.cmd('goal edit W-67 acceptance objective');
		console.log(`    acceptance after three edits: ${JSON.stringify(goalOf(h).acceptance)}`);
		assert.deepEqual(goalOf(h).acceptance, ['x', 'y', 'z'], 'no flag keeps the current list');
		assert.equal(goalOf(h).editHistory.length, 3);
	});

	await test('edit does not interrupt in-flight work', async () => {
		const h = await boardWithLiveWork();
		const before = snapshot(h);
		console.log(`    before: ${JSON.stringify(before)}`);
		await h.cmd('goal edit W-67 replaced objective --accept "only acceptance"');
		const after = snapshot(h);
		console.log(`    after:  ${JSON.stringify(after)}`);
		assert.equal(goalOf(h).objective, 'W-67 replaced objective');
		assert.deepEqual(goalOf(h).acceptance, ['only acceptance']);
		assert.deepEqual(after.taskStatuses, before.taskStatuses, 'task statuses must be untouched');
		assert.deepEqual(after.leases, before.leases, 'child leases must not be released or bound');
		assert.equal(after.calls, before.calls, 'calls counters must be untouched');
		assert.equal(after.spendUSD, before.spendUSD, 'spend must be untouched');
		assert.equal(after.goalRounds, before.goalRounds, 'goal rounds must be untouched');
		assert.equal(after.pendingInternalPrompts, 0, 'edit must not enqueue a kickoff/internal prompt');
		assert.equal(after.pendingInternalPrompts, before.pendingInternalPrompts);
		assert.equal(after.requests, before.requests, 'edit must not add a goal:Q-n request');
		assert.equal(after.enabled, before.enabled);
		assert.equal(goalOf(h).stalls, 1, 'stalls preserved by edit');
	});

	await test('stop + resume + clear do not interrupt in-flight work', async () => {
		const h = await boardWithLiveWork();
		const before = snapshot(h);
		await h.cmd('goal stop');
		assert.equal(goalOf(h).status, 'stopped');
		await h.cmd('goal resume');
		assert.equal(goalOf(h).status, 'active');
		assert.equal(goalOf(h).stopReason, undefined);
		assert.equal(goalOf(h).stalls, 0);
		const after = snapshot(h);
		console.log(`    before: ${JSON.stringify(before)}`);
		console.log(`    after:  ${JSON.stringify(after)}`);
		assert.deepEqual(after.taskStatuses, before.taskStatuses);
		assert.deepEqual(after.leases, before.leases);
		assert.equal(after.calls, before.calls);
		assert.equal(after.spendUSD, before.spendUSD);
		assert.equal(after.goalRounds, before.goalRounds);
		assert.equal(after.pendingInternalPrompts, 0);
		assert.equal(after.requests, before.requests);
		assert.equal(after.enabled, before.enabled);

		await h.cmd('goal clear --force');
		const cleared = snapshot(h);
		assert.equal(goalOf(h), null);
		assert.deepEqual(cleared.taskStatuses, before.taskStatuses, 'clear must not touch tasks');
		assert.deepEqual(cleared.leases, before.leases, 'clear must not touch leases');
		assert.equal(cleared.calls, before.calls);
		assert.equal(cleared.spendUSD, before.spendUSD);
		assert.equal(cleared.pendingInternalPrompts, 0);
		assert.equal(cleared.requests, before.requests);
		assert.equal(cleared.enabled, before.enabled);
	});

	await test('clear accepts a stopped goal (regression for the old complete-only gate)', async () => {
		const h = harness(state => { state.goal = newGoal('W-67 stopped objective', ['accept one']); });
		await h.start();
		await h.cmd('goal stop');
		assert.equal(goalOf(h).status, 'stopped');
		assert.equal(h.state().cpCallsSinceAudit, 0);
		await h.cmd('goal clear');
		assert.equal(goalOf(h), null, 'a stopped goal must be clearable');
		assert.equal(h.state().cpCallsSinceAudit, 0);
		assert.equal(h.state().continuationsSinceAudit, 0);
		console.log(`    notify: ${h.notes.at(-1)?.split('\n')[0]}`);
	});

	await test('plain clear refuses an active goal; --force clears it', async () => {
		const h = harness(state => { state.goal = newGoal('W-67 active objective', ['accept one']); });
		await h.start();
		await h.cmd('goal clear');
		assert.ok(goalOf(h), 'an active goal must survive a plain clear');
		assert.equal(goalOf(h).status, 'active');
		assert.match(String(h.notes.at(-1)), /进行中的目标不能被 clear 隐式删除/);
		await h.cmd('goal clear --force');
		assert.equal(goalOf(h), null, '--force must clear an active goal');
	});

	await test('resume reactivates a stopped goal without duplicating objective text', async () => {
		const h = harness(state => { state.goal = { ...newGoal('W-67 resumed objective', ['accept one']), objectives: ['W-67 resumed objective'], stalls: 2 }; });
		await h.start();
		await h.cmd('goal stop');
		const stopped = goalOf(h);
		assert.equal(stopped.status, 'stopped');
		const requestsBefore = h.state().ledger ? h.state().ledger.requests.length : 0;
		await h.cmd('goal resume');
		const resumed = goalOf(h);
		console.log(`    resumed: ${JSON.stringify({ status: resumed.status, objective: resumed.objective, objectives: resumed.objectives, stalls: resumed.stalls })}`);
		assert.equal(resumed.status, 'active');
		assert.equal(resumed.stopReason, undefined);
		assert.equal(resumed.stalls, 0);
		assert.equal(resumed.objective, 'W-67 resumed objective');
		assert.deepEqual(resumed.objectives, ['W-67 resumed objective']);
		assert.equal(resumed.objective.includes('\n+ '), false);
		assert.equal(resumed.acceptance.length, 1);
		assert.equal(h.state().ledger ? h.state().ledger.requests.length : 0, requestsBefore, 'resume must not add a goal request');
		assert.equal((h.state().ledger?.pendingInternalPrompts ?? []).length, 0, 'resume must not enqueue a kickoff');
		// resume on an already active goal is a no-op, not an error state.
		await h.cmd('goal resume');
		assert.equal(goalOf(h).status, 'active');
	});

	await test('completions list the five goal subcommands', async () => {
		const h = harness();
		await h.start();
		const values = h.completions('goal');
		console.log(`    completions: ${JSON.stringify(values)}`);
		for (const v of ['goal edit', 'goal clear', 'goal resume', 'goal stop', 'goal status']) {
			assert.ok(values.includes(v), `completions must offer "${v}"`);
		}
	});

	// W-72: malformed goal subcommands must never fall through to the start path.
	await test('malformed goal subcommands are rejected instead of silently merging into start', async () => {
		const h = harness(state => { state.goal = newGoal('F base objective', ['F accept one']); });
		await h.start();
		await h.emit('input', { text: 'F fixture request', source: 'rpc' });
		for (const probe of ['goal edit', 'goal clear --dry-run', 'goal resume now', 'goal stop now']) {
			const before = h.state();
			const beforeRequests = before.ledger.requests.length;
			const beforePrompts = (before.ledger.pendingInternalPrompts ?? []).length;
			await h.cmd(probe);
			const after = h.state();
			const note = String(h.notes.at(-1)).split('\n')[0];
			console.log(`    ${probe} → requests ${beforeRequests}→${after.ledger.requests.length}, status ${after.goal.status}, note: ${note}`);
			assert.equal(after.ledger.requests.length, beforeRequests, `${probe} must not append a goal:Q-n request`);
			assert.equal(after.goal.objective, 'F base objective', `${probe} must not merge text into the objective`);
			assert.equal(after.goal.status, 'active', `${probe} must not change the goal status`);
			assert.equal((after.ledger.pendingInternalPrompts ?? []).length, beforePrompts, `${probe} must not enqueue a kickoff prompt`);
			assert.match(note, /用法：\/team goal/, `${probe} must answer with a usage notify`);
			assert.match(note, new RegExp(probe.split(' ')[1]), 'the usage notify names the rejected verb');
		}
	});

	await test('Option B: "resume <objective> --accept" is rejected on non-active goals (legacy merge removed)', async () => {
		const h = harness(state => { state.goal = { ...newGoal('F legacy objective', ['F original acceptance']), status: 'budget', rounds: 4 }; });
		await h.start();
		await h.cmd('goal Resume added scope --accept "F added acceptance"');
		const g = goalOf(h);
		assert.equal(g.status, 'budget', 'resume with extra args must not activate the goal');
		assert.equal(g.objective, 'F legacy objective', 'objective text must remain untouched');
		const note = String(h.notes.at(-1)).split('\n')[0];
		assert.match(note, /用法：\/team goal/, 'must notify usage rejection');
	});

	await test('edit notify offers only a reachable next step for the current status', async () => {
		const complete = harness(state => { state.goal = { ...newGoal('F complete objective', ['F accept one']), status: 'complete' }; });
		await complete.start();
		await complete.cmd('goal edit F complete objective edited');
		const completeNote = String(complete.notes.at(-1)).split('\n')[0];
		console.log(`    complete: ${completeNote}`);
		assert.equal(goalOf(complete).objective, 'F complete objective edited');
		assert.equal(goalOf(complete).status, 'complete', 'edit preserves the status');
		assert.match(completeNote, /\/team goal clear/, 'a complete goal can only be revivified through clear');
		assert.doesNotMatch(completeNote, /resume/, 'resume does not accept a complete goal');

		const stopped = harness(state => { state.goal = { ...newGoal('F stopped objective', ['F accept one']), status: 'stopped', stopReason: 'USER_STOPPED' }; });
		await stopped.start();
		await stopped.cmd('goal edit F stopped objective edited');
		const stoppedNote = String(stopped.notes.at(-1)).split('\n')[0];
		console.log(`    stopped: ${stoppedNote}`);
		assert.equal(goalOf(stopped).status, 'stopped');
		assert.match(stoppedNote, /\/team goal resume/);
		assert.doesNotMatch(stoppedNote, /\/team goal clear/);

		const active = harness(state => { state.goal = newGoal('F active objective', ['F accept one']); });
		await active.start();
		await active.cmd('goal edit F active objective edited');
		const activeNote = String(active.notes.at(-1)).split('\n')[0];
		console.log(`    active: ${activeNote}`);
		assert.equal(goalOf(active).objective, 'F active objective edited');
		assert.doesNotMatch(activeNote, /resume|clear/, 'an active goal needs no recovery advice');
	});

	await test('--accept that parses to zero values is rejected instead of wiping the list', async () => {
		const h = harness(state => { state.goal = newGoal('F acceptance objective', ['F accept one', 'F accept two']); });
		await h.start();
		await h.cmd('goal edit F acceptance objective --accept ";|"');
		const note = String(h.notes.at(-1)).split('\n')[0];
		console.log(`    note: ${note}`);
		assert.deepEqual(goalOf(h).acceptance, ['F accept one', 'F accept two'], 'acceptance list must survive');
		assert.equal(goalOf(h).objective, 'F acceptance objective', 'a rejected edit changes nothing');
		assert.equal(goalOf(h).editHistory, undefined, 'a rejected edit must not record history');
		assert.equal(goalOf(h).status, 'active');
		assert.match(note, /解析后为空|拒绝/, 'the notify must explain the rejection');

		await h.cmd('goal edit F acceptance objective --add-accept " ; "');
		assert.deepEqual(goalOf(h).acceptance, ['F accept one', 'F accept two'], '--add-accept has the same guard');

		await h.cmd('goal edit F acceptance objective --accept "only one;  ;"');
		assert.deepEqual(goalOf(h).acceptance, ['only one'], 'a non-empty list still replaces');
	});

	await test('parseGoalFlags never swallows a literal --accept or the next flag', async () => {
		const literal = parseGoalFlags('fix the -- --accept literal flag in docs');
		console.log(`    literal: ${JSON.stringify(literal)}`);
		assert.equal(literal.objective, 'fix the --accept literal flag in docs', '-- terminates flag parsing');
		assert.equal(literal.hasAccept, false);
		assert.deepEqual(literal.acceptance, []);

		const mixed = parseGoalFlags('rewrite docs --accept "a;b" -- --accept stays literal');
		console.log(`    mixed: ${JSON.stringify(mixed)}`);
		assert.equal(mixed.objective, 'rewrite docs --accept stays literal');
		assert.deepEqual(mixed.acceptance, ['a', 'b']);

		const swallow = parseGoalFlags('fix the --accept --add-accept x');
		console.log(`    swallow: ${JSON.stringify(swallow)}`);
		assert.ok(swallow.error, 'a flag followed by another flag is a usage error');
		assert.equal(swallow.hasAccept, false);
		assert.equal(swallow.hasAddAccept, false, '--accept must never swallow --add-accept');

		const missing = parseGoalFlags('fix the --accept');
		console.log(`    missing: ${JSON.stringify(missing)}`);
		assert.ok(missing.error, 'a flag with no value is a usage error');

		const h = harness(state => { state.goal = newGoal('F flag objective', ['F accept one']); });
		await h.start();
		await h.cmd('goal edit F flag objective --accept --add-accept x');
		assert.equal(goalOf(h).objective, 'F flag objective', 'a usage error leaves the goal untouched');
		assert.deepEqual(goalOf(h).acceptance, ['F accept one']);
		assert.match(String(h.notes.at(-1)).split('\n')[0], /缺少取值/);
	});

	await test('editHistory cap of 30 counts dropped records instead of losing them silently', async () => {
		const h = harness(state => { state.goal = newGoal('F history objective', ['F accept one']); });
		await h.start();
		for (let i = 1; i <= 33; i++) await h.cmd(`goal edit F history objective round-${i}`);
		const g = goalOf(h);
		console.log(`    length=${g.editHistory.length} dropped=${g.editHistoryDropped} first=${g.editHistory[0].previousObjective} last=${g.editHistory.at(-1).previousObjective}`);
		assert.equal(g.objective, 'F history objective round-33');
		assert.equal(g.editHistory.length, 30, 'the cap is kept');
		assert.equal(g.editHistoryDropped, 3, 'every dropped record is counted');
		assert.equal(g.editHistory[0].previousObjective, 'F history objective round-3', 'only the three oldest records were dropped');
		assert.equal(g.editHistory.at(-1).previousObjective, 'F history objective round-32');
	});

	console.log(`\n${passed} passed — goal editing replaces precisely, never interrupts in-flight work, and rejects malformed subcommands.`);
} catch (error) {
	console.error('\nFAILED:', error instanceof Error ? error.message : error);
	throw error;
}