/** Recovery integration tests using the real extension factory and chained hooks.
 * No model requests; all writes are to isolated temporary fixtures.
 * Run: node ~/.pi/agent/team-tests/test-team-recovery-hooks.ts
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import teamExtension, { defaultConfig, initialState } from '../extensions/team.ts';

const root = mkdtempSync(join(tmpdir(), 'team-recovery-hooks-'));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
const parentId = '11111111-1111-7111-8111-111111111111';
const childId = '22222222-2222-7222-8222-222222222222';
const childDir = join(root, 'sessions', '--fixture-child--');
mkdirSync(childDir, { recursive: true });
const childPath = join(childDir, `2026-01-01T00-00-00-000Z_${childId}.jsonl`);
writeFileSync(join(root, 'team.json'), JSON.stringify({ sessionBudgetUSD: 0, roles: { bridges: { maxCalls: 0 } } }));
let pass = 0;
let seq = 0;
// Synthetic reports must be after fresh dispatch, not dated before the current attempt.
const fixtureEpoch = Date.now() + 1000;
const stamp = (n: number) => new Date(fixtureEpoch + n * 1000).toISOString();
function childFixture(final = true, newerRunning = false) {
  const entries: any[] = [
    { type: 'session', version: 3, id: childId, cwd: '/fixture', timestamp: stamp(0) },
    { type: 'custom', id: 'meta', parentId: null, timestamp: stamp(1), customType: 'pi-web:subagent', data: { version: 1, parentSessionId: parentId, profile: 'bridges' } },
    { type: 'custom', id: 'running', parentId: 'meta', timestamp: stamp(2), customType: 'pi-web:subagent-status', data: { version: 1, status: 'running' } },
    { type: 'message', id: 'u1', parentId: 'running', timestamp: stamp(3), message: { role: 'user', content: 'Complete the fixture task.', timestamp: Date.parse(stamp(3)) } },
    { type: 'message', id: 'abort', parentId: 'u1', timestamp: stamp(4), message: { role: 'assistant', stopReason: 'aborted', content: [], timestamp: Date.parse(stamp(4)) } },
    { type: 'custom', id: 'stale', parentId: 'abort', timestamp: stamp(5), customType: 'pi-web:subagent-result', data: { version: 1, status: 'aborted', error: 'Manually stopped', completedAt: stamp(5) } },
  ];
  if (final) entries.push(
    { type: 'message', id: 'u2', parentId: 'stale', timestamp: stamp(6), message: { role: 'user', content: 'Continue and report.', timestamp: Date.parse(stamp(6)) } },
    { type: 'message', id: 'report', parentId: 'u2', timestamp: stamp(7), message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Final report: fixture.txt:1 verified. Tests: 1/1 passed. Review the evidence before acceptance.' }], timestamp: Date.parse(stamp(7)) } },
  );
  if (newerRunning) entries.push({ type: 'custom', id: 'new-running', parentId: final ? 'report' : 'stale', timestamp: stamp(8), customType: 'pi-web:subagent-status', data: { version: 1, status: 'running' } });
  writeFileSync(childPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return readFileSync(childPath, 'utf8');
}
function harness(seed: any[] = [], enabled = true, child = false) {
  const state = initialState(defaultConfig());
  state.enabled = enabled;
  state.startedAt = stamp(0);
  state.failures.bridges = 1;
  let entries: any[] = [{ type: 'custom', id: 'state0', parentId: null, customType: 'team-state', data: state, timestamp: stamp(0) }, ...structuredClone(seed)];
  if (child) entries.push({ type: 'custom', customType: 'pi-web:subagent', data: { parentSessionId: parentId } });
  const hooks = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  const sent: any[] = [];
  const notes: string[] = [];
  const append = (value: any) => {
    const entry = { id: `p${++seq}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), ...structuredClone(value) };
    entries.push(entry);
    return entry;
  };
  const pi: any = {
    on(name: string, fn: Function) { hooks.set(name, [...(hooks.get(name) ?? []), fn]); },
    registerFlag() {}, getFlag() { return false; }, registerTool() {},
    registerCommand(name: string, spec: any) { commands.set(name, spec); },
    appendEntry(customType: string, data: any) { append({ type: 'custom', customType, data }); },
    sendMessage(message: any, options: any) { sent.push({ message: structuredClone(message), options: structuredClone(options) }); append({ type: 'custom_message', ...message }); },
    getThinkingLevel() { return 'medium'; }, setThinkingLevel() {}, async setModel() { return true; },
  };
  const ctx: any = {
    cwd: '/fixture', hasUI: true, isIdle() { return true; }, model: null,
    sessionManager: { getSessionId() { return parentId; }, getEntries() { return entries; }, getBranch() { return entries; } },
    ui: { notify(text: string) { notes.push(text); }, setStatus() {} },
    modelRegistry: { find() { return undefined; } },
  };
  teamExtension(pi);
  return {
    ctx, commands, sent, notes,
    async emit(name: string, event: any) {
      let current = event;
      for (const hook of hooks.get(name) ?? []) {
        const patch = await hook(current, ctx);
        if (patch) current = { ...current, ...patch };
      }
      return current;
    },
    entries() { return entries; },
    state() { return [...entries].reverse().find(e => e.customType === 'team-state').data; },
    reported() { return entries.filter(e => e.customType === 'team-run' && e.data.status === 'reported'); },
    async start() { await this.emit('session_start', { reason: 'startup' }); },
  };
}
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  pass++;
  console.log(`  ✓ ${name}`);
}
const interruptedResult = () => ({ toolName: 'get_subagent_result', toolCallId: `get-${++seq}`, input: { agent_id: childId }, isError: false, details: { sessionId: childId, status: 'interrupted' }, content: [{ type: 'text', text: `Subagent ${childId} was interrupted before completion.` }] });
const interruptedSeed = () => [{ type: 'message', id: 'parent-old-get', parentId: 'state0', timestamp: stamp(10), message: { role: 'toolResult', toolName: 'get_subagent_result', toolCallId: 'old-get', isError: false, details: { sessionId: childId, status: 'interrupted' }, content: [{ type: 'text', text: 'Interrupted.' }] } }];
try {
  await test('get_subagent_result recovers report, preserves host status, and does not add task/cost/failure', async () => {
    const bytes = childFixture(); const h = harness(); await h.start(); const before = structuredClone(h.state());
    const result = await h.emit('tool_result', interruptedResult());
    assert.equal(result.isError, false); assert.equal(result.details.hostStatus, 'interrupted');
    assert.equal(result.details.recovery.accepted, false); assert.equal(result.details.recovery.status, 'reported');
    assert.match(result.content[0].text, /fixture.txt:1/); assert.match(result.content[0].text, /verification/i);
    assert.equal(h.reported().length, 1); assert.deepEqual(h.state(), before); assert.equal(readFileSync(childPath, 'utf8'), bytes);
  });
  await test('repeat result fetch keeps recovery metadata and is idempotent', async () => {
    childFixture(); const h = harness(); await h.start(); await h.emit('tool_result', interruptedResult());
    const result = await h.emit('tool_result', interruptedResult());
    assert.equal(h.reported().length, 1); assert.equal(result.details.hostStatus, 'interrupted'); assert.equal(result.details.recovery.accepted, false);
  });
  await test('unknown outcome is not promoted to success; native running/completed are never overridden', async () => {
    childFixture(false); const h = harness(); await h.start(); const result = await h.emit('tool_result', interruptedResult());
    assert.equal(h.reported().length, 0); assert.match(result.content.map((c: any) => c.text).join('\n'), /not treated as success/);
    childFixture(); for (const status of ['running', 'queued', 'completed']) {
      const native = { ...interruptedResult(), details: { sessionId: childId, status } };
      const result = await h.emit('tool_result', native); assert.equal(result.details.status, status); assert.equal(h.reported().length, 0);
    }
  });
  await test('actual Agent call recovers transport once without incrementing failures', async () => {
    childFixture(); const h = harness(); await h.start();
    await h.emit('tool_call', { toolName: 'Agent', toolCallId: 'agent1', input: { subagent_type: 'bridges', description: 'Fixture', prompt: 'Verify the fixture.' } });
    const result = await h.emit('tool_result', { ...interruptedResult(), toolName: 'Agent', toolCallId: 'agent1', isError: true });
    assert.equal(result.isError, false); assert.equal(h.state().calls.bridges, 1); assert.equal(h.state().tasks, 1);
    assert.equal(h.state().failures.bridges, 1); assert.equal(h.reported().length, 1); assert.equal(h.reported()[0].data.role, 'bridges');
  });
  await test('non-error interrupted Agent outcome is interrupted, not ok', async () => {
    childFixture(false); const h = harness(); await h.start();
    await h.emit('tool_call', { toolName: 'Agent', toolCallId: 'agent2', input: { subagent_type: 'bridges', prompt: 'Fixture task.' } });
    await h.emit('tool_result', { ...interruptedResult(), toolName: 'Agent', toolCallId: 'agent2', isError: false });
    const run = h.entries().filter(e => e.customType === 'team-run').at(-1).data;
    assert.equal(run.status, 'interrupted'); assert.equal(h.state().failures.bridges, 1);
  });
  await test('background acceptance is running, not completed; later clean report is automatically collected', async () => {
    childFixture(false); const h = harness(); await h.start();
    await h.emit('tool_call', { toolName: 'Agent', toolCallId: 'bg1', input: { subagent_type: 'bridges', run_in_background: true, prompt: 'Fixture task.' } });
    await h.emit('tool_result', { toolName: 'Agent', toolCallId: 'bg1', input: {}, isError: false, details: { sessionId: childId, status: 'running' }, content: [{ type: 'text', text: `Subagent started: ${childId}` }] });
    assert.equal(h.entries().filter(e => e.customType === 'team-run').at(-1).data.status, 'running');
    assert.equal(h.state().failures.bridges, 1);
    childFixture(); const before = await h.emit('before_agent_start', { systemPrompt: 'Base prompt' });
    assert.ok(before.message, 'The current next prompt must receive the recovered report.'); assert.match(before.message.content, /fixture.txt:1/);
    assert.equal(h.reported().length, 1); assert.equal(h.state().calls.bridges, 1);
  });
  await test('next parent prompt gets one durable recovery message; retry and restart do not duplicate', async () => {
    childFixture(); const h = harness(interruptedSeed()); await h.start();
    const before = await h.emit('before_agent_start', { systemPrompt: 'Base prompt' }); assert.ok(before.message);
    // Mimic Pi persistence of before_agent_start.message, then its context event.
    h.ctx.sessionManager.getEntries().push({ type: 'custom_message', id: `durable${++seq}`, parentId: h.entries().at(-1)?.id, timestamp: stamp(20), ...before.message });
    const ctxResult = await h.emit('context', { messages: [{ role: 'custom', ...before.message }] });
    assert.equal(ctxResult.messages.length, 2); // One durable recovery report plus the refreshed additive work ledger.
    assert.equal(ctxResult.messages.filter((m: any) => m.customType === before.message.customType).length, 1);
    assert.equal(ctxResult.messages.filter((m: any) => m.customType === 'team-work-ledger').length, 1);
    const retry = await h.emit('before_agent_start', { systemPrompt: 'Base prompt' }); assert.equal(retry.message, undefined);
    const restored = harness(h.entries().filter(e => e.id !== 'state0')); await restored.start();
    const afterReload = await restored.emit('before_agent_start', { systemPrompt: 'Base prompt' }); assert.equal(afterReload.message, undefined);
  });
  await test('/team reconcile persists report without model turn and is idempotent', async () => {
    childFixture(); const h = harness(interruptedSeed()); await h.start(); const before = structuredClone(h.state());
    await h.commands.get('team').handler('reconcile', h.ctx);
    assert.equal(h.sent.length, 1); assert.equal(h.sent[0].options.triggerTurn, false); assert.notEqual(h.sent[0].options.deliverAs, 'nextTurn');
    assert.equal(h.reported().length, 1); assert.deepEqual(h.state(), before);
    await h.commands.get('team').handler(`reconcile ${childId}`, h.ctx); assert.equal(h.sent.length, 1); assert.equal(h.reported().length, 1);
    assert.ok(h.notes.some(x => /REPORTED/.test(x)));
  });
  await test('legacy background ok receipt cannot hide native running observation', async () => {
    childFixture();
    const seed = [
      { type: 'message', id: 'legacy-bg', parentId: 'state0', timestamp: stamp(10), message: { role: 'toolResult', toolName: 'Agent', details: { sessionId: childId, status: 'running' }, content: [] } },
      { type: 'custom', id: 'legacy-ok', parentId: 'legacy-bg', timestamp: stamp(11), customType: 'team-run', data: { taskId: 'old-bg', role: 'bridges', sessionId: childId, status: 'ok', at: stamp(11), description: 'Old background launch' } },
    ];
    const h = harness(seed); await h.start();
    const result = await h.emit('before_agent_start', { systemPrompt: 'Base' });
    assert.ok(result.message, 'An old background launch marked ok is not native completed.'); assert.equal(h.reported().length, 1);
  });
  await test('abandoned parent branch child references do not trigger recovery', async () => {
    childFixture();
    const seed = [
      { ...interruptedSeed()[0], id: 'abandoned-get' },
      { type: 'custom', id: 'abandoned-run', parentId: 'abandoned-get', timestamp: stamp(11), customType: 'team-run', data: { taskId: 'old-branch', role: 'bridges', sessionId: childId, status: 'interrupted', at: stamp(11) } },
    ];
    const h = harness(seed);
    h.ctx.sessionManager.getBranch = () => h.entries().filter(e => !e.id?.startsWith('abandoned'));
    await h.start(); const result = await h.emit('before_agent_start', { systemPrompt: 'Base' });
    assert.equal(result.message, undefined); assert.equal(h.reported().length, 0);
  });
  await test('duplicate Agent report never increments failures or creates duplicate recovery receipt', async () => {
    childFixture(); const h = harness(); await h.start(); await h.emit('tool_result', interruptedResult());
    await h.emit('tool_call', { toolName: 'Agent', toolCallId: 'repeat-agent', input: { subagent_type: 'bridges', prompt: 'Verify the existing report.' } });
    const result = await h.emit('tool_result', { ...interruptedResult(), toolName: 'Agent', toolCallId: 'repeat-agent', isError: true });
    assert.equal(result.isError, false); assert.equal(h.state().failures.bridges, 1); assert.equal(h.reported().length, 1);
    assert.equal(h.state().calls.bridges, 1); assert.equal(h.state().tasks, 1);
  });
  await test('team Agent dispatch defaults to background and does not force worktree isolation', async () => {
    const h = harness(); await h.start();
    const input: any = { subagent_type: 'bridges', prompt: 'Independently verify fixture.' };
    await h.emit('tool_call', { toolName: 'Agent', toolCallId: 'default-bg', input });
    assert.equal(input.run_in_background, true); assert.equal(input.isolation, undefined); assert.equal(input.wait_timeout, undefined);
    assert.equal(h.notes.some(text => text.includes('等待上限')), false, 'Background dispatch must not announce a foreground wait limit.');
  });
  await test('explicit foreground known-child resume and isolation arguments are preserved', async () => {
    const h = harness([{ type: 'custom', customType: 'team-run', data: { taskId: 'known-resume', role: 'bridges', sessionId: childId, status: 'ok', at: stamp(6) } }, { type: 'message', message: { role: 'toolResult', toolName: 'Agent', details: { sessionId: childId, status: 'completed' } } }]); await h.start();
    const input: any = { subagent_type: 'bridges', prompt: 'Verify existing branch.', run_in_background: false, isolation: 'worktree', resume: childId, model: 'fixture/model' };
    await h.emit('tool_call', { toolName: 'Agent', toolCallId: 'explicit-fg', input });
    assert.equal(input.run_in_background, false); assert.equal(input.isolation, 'worktree'); assert.equal(input.resume, childId); assert.equal(input.model, 'fixture/model');
    assert.equal(input.wait_timeout, 600, 'The existing foreground wait guard remains unchanged.');
  });
  await test('dispatch defaults are not injected outside an enabled parent team', async () => {
    for (const h of [harness([], false), harness([], true, true)]) {
      await h.start(); const input: any = { subagent_type: 'bridges', prompt: 'Fixture.' };
      await h.emit('tool_call', { toolName: 'Agent', toolCallId: `outside-${++seq}`, input });
      assert.equal(input.run_in_background, undefined);
    }
  });
  await test('disabled team or child session never runs parent recovery', async () => {
    childFixture(); for (const h of [harness(interruptedSeed(), false), harness(interruptedSeed(), true, true)]) {
      await h.start(); await h.emit('tool_result', interruptedResult()); await h.emit('before_agent_start', { systemPrompt: 'Base' }); assert.equal(h.reported().length, 0);
    }
  });
  console.log(`\nRecovery hooks passed: ${pass}`);
} finally {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(root, { recursive: true, force: true });
}
