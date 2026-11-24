/** Real extension factory tests for CP-parent authority, without model calls.
 * All mutations use temporary fixtures. Run: node ~/.pi/agent/team-tests/test-team-cp-parent-hooks.ts
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import teamExtension, { defaultConfig, initialState, newGoal } from '../extensions/team.ts';

const root = mkdtempSync(join(tmpdir(), 'team-cp-parent-hooks-'));
const originalDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
let pass = 0;
let sequence = 0;
function harness(options: {mode?: 'economy'|'strict'; enabled?: boolean; legacyCpCalls?: number; modelPolicy?: 'preserve'|'mode'; child?: boolean; flagOn?: boolean; seed?: any[]} = {}) {
  const cfg = defaultConfig();
  const state = initialState(cfg);
  state.enabled = options.enabled ?? true;
  state.mode = options.mode ?? 'economy';
  state.startedAt = '2026-01-01T00:00:00.000Z';
  state.goal = newGoal('Verify final integrated artifacts and owned cleanup', ['Integrated regression verified', 'Owned worktrees cleaned']);
  state.cpCallsSinceAudit = options.legacyCpCalls ?? 0;
  state.prevModel = 'fixture/original';
  state.prevThinking = 'high';
  const localCfg = { mainModelPolicy: options.modelPolicy ?? 'preserve', maxConcurrent: 1, sessionBudgetUSD: 0.001, maxAutoRetries: 1, goalMaxRounds: 1, goalMaxStalls: 1, roles: { cp: { maxCalls: 1, budgetUSD: 0.001 }, booker: { maxCalls: 1, budgetUSD: 0.001 } }, fallbacks: { cp: [] } };
  writeFileSync(join(root, 'team.json'), JSON.stringify(localCfg));
  let entries: any[] = [{ type: 'custom', id: 'state0', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', customType: 'team-state', data: state }, ...structuredClone(options.seed ?? [])];
  if (options.child) entries.push({ type: 'custom', id: 'child-meta', parentId: entries.at(-1)?.id, customType: 'pi-web:subagent', data: { parentSessionId: 'parent' } });
  const hooks = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const notes: string[] = [];
  const modelChanges: string[] = [];
  const thinkingChanges: string[] = [];
  const prompts: any[] = [];
  const append = (value: any) => entries.push({ id: `p${++sequence}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), ...structuredClone(value) });
  let thinking = 'max';
  const ctx: any = {
    cwd: root, hasUI: true, model: { provider: 'fixture', id: 'selected' }, isIdle() { return true; },
    sessionManager: { getEntries() { return entries; }, getBranch() { return entries; }, getSessionId() { return 'parent'; }, getSessionFile() { return join(root, 'parent.jsonl'); } },
    modelRegistry: { find(provider: string, id: string) { return { provider, id }; } },
    ui: { setStatus() {}, notify(message: string) { notes.push(message); } },
  };
  const pi: any = {
    on(name: string, fn: Function) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    registerFlag() {}, getFlag() { return options.flagOn === true; },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, spec: any) { commands.set(name, spec); },
    appendEntry(customType: string, data: any) { append({ type: 'custom', customType, data }); },
    getThinkingLevel() { return thinking; },
    setThinkingLevel(value: string) { thinking = value; thinkingChanges.push(value); },
    async setModel(model: any) { modelChanges.push(`${model.provider}/${model.id}`); ctx.model = model; return true; },
    sendMessage(message: any) { append({ type: 'custom_message', ...message }); },
    async sendUserMessage(message: any) { prompts.push(message); },
  };
  teamExtension(pi);
  return {
    ctx, tools, notes, modelChanges, thinkingChanges, prompts,
    entries() { return entries; },
    state() { return [...entries].reverse().find(e => e.customType === 'team-state').data; },
    async start() { await this.emit('session_start', { reason: 'startup' }); },
    async emit(name: string, event: any) { let current = event; for (const handler of hooks.get(name) ?? []) { const patch = await handler(current, ctx); if (patch) current = { ...current, ...patch }; } return current; },
    async command(args: string) { await commands.get('team').handler(args, ctx); },
    async audit(params: any) { return tools.get('team_goal').execute(`audit${++sequence}`, params, undefined, undefined, ctx); },
  };
}
const audit = (verdict: string) => ({
  verdict,
  summary: 'Main CP verified fixture.txt:1 and final test/cleanup evidence before recording this verdict.',
  evidence: ['fixture.txt:1', 'npm test: exit 0, 1/1 passed at final target HEAD', 'git worktree list: owned temporary worktrees absent'],
  ...(['REWORK', 'REPLAN', 'ESCALATE'].includes(verdict) ? { nextTasks: ['Bridges: fix fixture.txt:1, rerun regression, and report evidence.'] } : {}),
  ...(verdict === 'GOAL_COMPLETE' ? { acceptanceMet: ['Integrated regression verified: npm test exit 0', 'Owned worktrees cleaned: git worktree list evidence'] } : {}),
});
async function test(name: string, fn: () => Promise<void>) { await fn(); pass++; console.log(`  ✓ ${name}`); }
try {
  for (const mode of ['economy', 'strict'] as const) {
    for (const verdict of ['PASS', 'REWORK', 'REPLAN', 'ESCALATE', 'BLOCKED', 'GOAL_COMPLETE']) {
      await test(`${mode}: main CP records ${verdict} without any CP-child dispatch`, async () => {
        const h = harness({ mode }); await h.start(); const before = structuredClone(h.state());
        const result = await h.audit(audit(verdict)); assert.notEqual(result.isError, true, JSON.stringify(result));
        assert.equal(h.state().goal.rounds, 1); assert.equal(h.state().goal.audits[0].auditor, 'main-cp');
        assert.equal(h.state().calls.cp, 0); assert.equal(h.state().tasks, before.tasks); assert.equal(h.state().spendUSD, before.spendUSD);
        assert.equal(h.state().goal.status, verdict === 'GOAL_COMPLETE' ? 'complete' : verdict === 'BLOCKED' ? 'blocked' : 'active');
      });
    }
  }
  await test('rework then completion is a two-round main-owned loop with zero CP-child calls', async () => {
    const h = harness(); await h.start();
    await h.audit(audit('REWORK'));
    const continuation = await h.emit('agent_before_settle', { entries: [] }); assert.equal(continuation.continue, true);
    const text = continuation.entries.map((e: any) => e.content ?? '').join('\n'); assert.match(text, /CP/);
    const premature = await h.audit(audit('GOAL_COMPLETE')); assert.equal(premature.isError, true, 'new ledger must retain the unfinished rework obligation');
    const pending = h.state().ledger.tasks.filter((t: any) => t.status === 'planned');
    assert.equal(pending.length, 1);
    const accepted = await h.tools.get('team_tasks').execute('accept-rework', { action: 'update', updates: pending.map((t: any) => ({ id: t.id, status: 'done', evidence: audit('GOAL_COMPLETE').evidence, reason: 'Main CP verified the fixture rework, final integrated regression, and owned cleanup.' })) }, undefined, undefined, h.ctx);
    assert.notEqual(accepted.isError, true);
    await h.audit(audit('GOAL_COMPLETE')); assert.equal(h.state().goal.rounds, 2); assert.equal(h.state().goal.status, 'complete'); assert.equal(h.state().calls.cp, 0);
    const stopped = await h.emit('agent_before_settle', { entries: [] }); assert.notEqual(stopped.continue, true);
  });
  await test('forty same-summary rework audits continue past all old round/stall caps and still require accepted work to complete', async () => {
    const h = harness(); await h.start();
    for (let round=1; round<=40; round++) {
      const recorded=await h.audit(audit('REWORK')); assert.notEqual(recorded.isError,true);
      const continuation=await h.emit('agent_before_settle',{entries:[]}); assert.equal(continuation.continue,true);
      assert.equal(h.state().goal.status,'active'); assert.equal(h.state().goal.rounds,round);
      const pending=h.state().ledger.tasks.filter((t:any)=>t.status==='planned');
      const accepted=await h.tools.get('team_tasks').execute(`round-${round}`,{action:'update',updates:pending.map((t:any)=>({id:t.id,status:'done',evidence:audit('GOAL_COMPLETE').evidence,reason:'Main verified each fixture deliverable.'}))},undefined,undefined,h.ctx);
      assert.notEqual(accepted.isError,true);
    }
    assert.equal(h.state().goal.audits.length,30);
    for(let i=0;i<10;i++)assert.equal((await h.emit('agent_before_settle',{entries:[]})).continue,true);
    assert.ok(h.state().goal.stalls>2);assert.ok(h.state().continuationsSinceAudit>3);assert.equal(h.state().goal.status,'active');
    const before=structuredClone(h.state()); const noEvidence=await h.audit({...audit('GOAL_COMPLETE'),evidence:[]}); assert.equal(noEvidence.isError,true); assert.deepEqual(h.state(),before);
    const complete=await h.audit(audit('GOAL_COMPLETE')); assert.notEqual(complete.isError,true); assert.equal(h.state().goal.status,'complete'); assert.equal(h.state().goal.rounds,41);
    assert.notEqual((await h.emit('agent_before_settle',{entries:[]})).continue,true);
  });
  await test('legacy budget-stopped goal is not silently restarted, but explicit goal command resumes without numeric gates or losing queued work', async () => {
    const legacy=initialState(defaultConfig());legacy.enabled=true;legacy.limitsOff=false;legacy.budgetOverrideUSD=1;legacy.spendUSD=1000000;
    legacy.goal={...newGoal('Legacy budget stopped goal',['Original acceptance retained']),status:'budget',rounds:100,stalls:100,stopReason:'Legacy automatic budget cap stop'};
    const h=harness({seed:[{type:'custom',customType:'team-state',data:legacy}]});await h.start();const originalGoalId=h.state().goal.id;
    await h.emit('input',{source:'interactive',text:'Preserve existing legacy queued work'});
    const requestId=h.state().ledger.requests.find((r:any)=>r.status==='open').id;
    const added=await h.tools.get('team_tasks').execute('legacy-add',{action:'add',tasks:[{id:'W-legacy',title:'Existing queued deliverable',role:'bridges',requestIds:[requestId],dependsOn:[],readPaths:[],writePaths:['src/legacy.ts'],acceptance:['Legacy deliverable verified']}]},undefined,undefined,h.ctx);assert.notEqual(added.isError,true);
    assert.equal(h.state().goal.status,'budget');assert.notEqual((await h.emit('agent_before_settle',{entries:[]})).continue,true);
    await h.command('goal resume');
    assert.equal(h.state().goal.id,originalGoalId);assert.equal(h.state().goal.status,'active');assert.equal(h.state().goal.rounds,100);assert.equal(h.state().goal.stopReason,undefined);
    assert.ok(h.state().goal.acceptance.includes('Original acceptance retained'));
    assert.equal(h.state().ledger.tasks.find((t:any)=>t.id==='W-legacy').status,'ready');assert.equal(h.state().spendUSD,1000000);
    assert.equal((await h.emit('agent_before_settle',{entries:[]})).continue,true);
  });
  await test('empty evidence is rejected without state mutation, even with old CP dispatch credits', async () => {
    const h = harness({ legacyCpCalls: 99 }); await h.start(); const before = structuredClone(h.state());
    const result = await h.audit({ ...audit('GOAL_COMPLETE'), evidence: ['  '] }); assert.equal(result.isError, true); assert.deepEqual(h.state(), before);
  });
  await test('missing actionable nextTasks fails REWORK/REPLAN/ESCALATE without mutating state', async () => {
    const h = harness(); await h.start();
    for (const verdict of ['REWORK', 'REPLAN', 'ESCALATE']) {
      const before = structuredClone(h.state()); const params: any = audit(verdict); delete params.nextTasks;
      const result = await h.audit(params); assert.equal(result.isError, true); assert.deepEqual(h.state(), before);
    }
  });
  await test('completion still requires acceptanceMet and unknown verdicts cannot mutate state', async () => {
    const h = harness(); await h.start();
    for (const params of [{ ...audit('GOAL_COMPLETE'), acceptanceMet: [] }, { ...audit('GOAL_COMPLETE'), acceptanceMet: ['  '] }, { ...audit('INVALID') }]) {
      const before = structuredClone(h.state()); const result = await h.audit(params); assert.equal(result.isError, true); assert.deepEqual(h.state(), before);
    }
  });
  await test('completion covers every registered acceptance condition, with numbered explanations allowed', async () => {
    const h = harness(); await h.start(); const before = structuredClone(h.state());
    const partial = await h.audit({ ...audit('GOAL_COMPLETE'), acceptanceMet: ['Integrated regression verified: npm test exit 0'] });
    assert.equal(partial.isError, true); assert.deepEqual(h.state(), before);
    const numbered = await h.audit({ ...audit('GOAL_COMPLETE'), acceptanceMet: ['1) 最终目标版本测试通过，命令证据已核实。', '2) 临时工作树及已合并分支已清理，列表证据已核实。'] });
    assert.notEqual(numbered.isError, true); assert.equal(h.state().goal.status, 'complete'); assert.equal(numbered.details.validation.acceptanceStructure, 'provided');
    assert.match(numbered.details.validation.note, /结构|structur/i);
  });
  await test('malformed direct-call audit fields reject without exception or state mutation', async () => {
    const h = harness(); await h.start();
    for (const params of [{ ...audit('GOAL_COMPLETE'), summary: {} }, { ...audit('GOAL_COMPLETE'), evidence: 'fixture.txt:1' }, { ...audit('GOAL_COMPLETE'), evidence: ['fixture.txt:1', 9] }, { ...audit('GOAL_COMPLETE'), acceptanceMet: ['Integrated regression verified: npm test', 9] }, { ...audit('REWORK'), nextTasks: ['Bridges: inspect fixture.txt:1', 9] }]) {
      const before = structuredClone(h.state()); const result = await h.audit(params); assert.equal(result.isError, true); assert.deepEqual(h.state(), before);
    }
  });
  await test('zero and restored CP-call counts are not authorization for an audit', async () => {
    for (const legacyCpCalls of [0, 8]) { const h = harness({ legacyCpCalls }); await h.start(); const result = await h.audit(audit('GOAL_COMPLETE')); assert.notEqual(result.isError, true); }
  });
  await test('optional CP quota exhaustion pauses consultant only; main CP can still complete', async () => {
    const h = harness(); await h.start();
    await h.emit('tool_call', { toolName: 'Agent', toolCallId: 'optional-cp', input: { subagent_type: 'cp', prompt: 'ESCALATION: Request a second opinion on fixture.txt:1 risk with test evidence; the main CP retains final authority.' } });
    await h.emit('tool_result', { toolName: 'Agent', toolCallId: 'optional-cp', isError: true, details: { status: 'failed' }, content: [{ type: 'text', text: '429 quota exhausted' }] });
    assert.ok(h.state().unavailable.cp); assert.equal(h.state().goal.status, 'active');
    const result = await h.audit(audit('GOAL_COMPLETE')); assert.notEqual(result.isError, true); assert.equal(h.state().goal.status, 'complete');
  });
  await test('optional CP consultation is not capped by legacy cp.calls=1', async () => {
    const h = harness(); await h.start();
    const prompt = 'ESCALATION: An independent second opinion is useful for fixture.txt:1 uncertainty with evidence; main CP owns the decision.';
    await h.emit('tool_call', { toolName: 'Agent', toolCallId: 'cp-first', input: { subagent_type: 'cp', prompt } });
    await h.emit('tool_result', { toolName: 'Agent', toolCallId: 'cp-first', isError: false, details: { status: 'completed' }, content: [{ type: 'text', text: 'Second opinion report.' }] });
    const blocked = await h.emit('tool_call', { toolName: 'Agent', toolCallId: 'cp-second', input: { subagent_type: 'cp', prompt } });
    assert.notEqual(blocked.block, true); assert.equal(h.state().calls.cp, 2); assert.equal(h.state().goal.status, 'active');
    await h.emit('tool_result', { toolName: 'Agent', toolCallId: 'cp-second', isError: false, details: { status: 'completed' }, content: [{ type: 'text', text: 'Second bounded opinion.' }] });
    const result = await h.audit(audit('GOAL_COMPLETE')); assert.notEqual(result.isError, true);
  });
  await test('Booker directly receives bounded local analysis without prior Bridges failures', async () => {
    const h = harness(); await h.start();
    const result = await h.emit('tool_call', { toolName: 'Agent', toolCallId: 'booker-local', input: { subagent_type: 'booker', prompt: 'ESCALATION: Review fixture.txt:1 boundary behavior using the existing tests; bounded local analysis needed before implementation, no prior failure.' } });
    assert.notEqual(result.block, true); assert.equal(h.state().calls.booker, 1); assert.equal(h.state().failures.bridges, 0);
  });
  await test('preserve default retains current main model/thinking across on, modes, and off', async () => {
    const h = harness({ enabled: false }); await h.start();
    await h.command('on'); await h.command('mode strict'); await h.command('mode economy');
    h.ctx.model = { provider: 'fixture', id: 'manually-chosen' };
    await h.command('off'); assert.deepEqual(h.modelChanges, []); assert.deepEqual(h.thinkingChanges, []); assert.equal(h.ctx.model.id, 'manually-chosen');
  });
  await test('goal start and --team startup preserve chosen CP model and thinking', async () => {
    const h = harness({ enabled: false, flagOn: true }); await h.start();
    assert.equal(h.state().enabled, true); assert.deepEqual(h.modelChanges, []); assert.deepEqual(h.thinkingChanges, []);
    await h.command('goal Verify preserved model --accept "Evidence verified;Owned cleanup verified"');
    assert.deepEqual(h.modelChanges, []); assert.deepEqual(h.thinkingChanges, []); assert.equal(h.state().calls.cp, 0);
    assert.ok(h.prompts.length <= 1);
    const before = await h.emit('before_agent_start', { systemPrompt: 'Base fixture prompt' });
    assert.match(before.systemPrompt, /creation-time role snapshot/);
    assert.match(before.systemPrompt, /confirm it has stopped.*fresh child/);
  });
  await test('new-session pending marker preserves chosen CP model and thinking', async () => {
    writeFileSync(join(root, 'team-pending.json'), JSON.stringify({ on: true, mode: 'strict' }));
    const h = harness({ enabled: false }); await h.start();
    assert.equal(h.state().enabled, true); assert.equal(h.state().mode, 'strict'); assert.deepEqual(h.modelChanges, []); assert.deepEqual(h.thinkingChanges, []);
  });
  await test('opt-in mode routing remains available and restores entered model/thinking on exit', async () => {
    const h = harness({ enabled: false, modelPolicy: 'mode' }); await h.start();
    await h.command('on'); await h.command('mode strict'); await h.command('off');
    assert.ok(h.modelChanges.includes('magpie/codex/gpt-6.1-sol')); assert.equal(h.modelChanges.at(-1), 'fixture/selected');
    assert.equal(h.thinkingChanges.at(-1), 'max');
  });
  await test('team status identifies main CP and optional consultant without amounts', async () => {
    const h = harness(); await h.start(); await h.command('status');
    const status = h.notes.at(-1); assert.match(status!, /CP/); assert.match(status!, /main|主会话/i); assert.equal(/\$\d/.test(status!), false);
  });
  await test('a child session or disabled team cannot execute the parent final audit', async () => {
    for (const options of [{ enabled: false }, { child: true }]) {
      const h = harness(options); await h.start(); const before = structuredClone(h.state()); const result = await h.audit(audit('GOAL_COMPLETE'));
      assert.equal(result.isError, true); assert.deepEqual(h.state(), before);
    }
  });
  console.log(`\nCP parent hooks passed: ${pass}`);
} finally {
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalDir;
  rmSync(root, { recursive: true, force: true });
}
