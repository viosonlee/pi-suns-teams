"""Real Pi RPC verification of main-CP auditing, mode model preservation and restart.
A temporary fixture extension calls the same registered team_goal execute function;
no model or Agent requests are made. Never writes production sessions or config.
"""
import json
import os
import pathlib
import select
import subprocess
import tempfile
import time
import uuid

SOURCE = pathlib.Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory(prefix='team-cp-parent-rpc-') as temp:
    root = pathlib.Path(temp)
    parent_id = str(uuid.uuid4())
    session_dir = root / 'sessions' / '--fixture--'
    session_dir.mkdir(parents=True)
    session = session_dir / f'2026-01-01T00-00-00-000Z_{parent_id}.jsonl'
    (root / 'team.json').write_text(json.dumps({'mainModelPolicy': 'preserve', 'sessionBudgetUSD': 0}))
    state = json.loads(subprocess.check_output(['node', '--input-type=module', '-e',
        f"import {{initialState,defaultConfig,newGoal}} from '{SOURCE / 'extensions/team.ts'}';let s=initialState(defaultConfig());s.enabled=true;s.startedAt='2026-01-01T00:00:00.000Z';s.goal=newGoal('Verify fixture integration and cleanup',['Regression verified','Owned worktrees cleaned']);console.log(JSON.stringify(s));"], text=True))
    header = {'type': 'session', 'version': 3, 'id': parent_id, 'timestamp': '2026-01-01T00:00:00.000Z', 'cwd': str(root)}
    state_entry = {'type': 'custom', 'id': 'state0', 'parentId': None, 'timestamp': '2026-01-01T00:00:01.000Z', 'customType': 'team-state', 'data': state}
    session.write_text(json.dumps(header) + '\n' + json.dumps(state_entry) + '\n')
    fixture = root / 'fixture-extension.ts'
    fixture.write_text(f"""import team from {json.dumps(str(SOURCE / 'extensions/team.ts'))};
export default function(pi: any) {{
  let audit: any, ledger: any;
  const proxy = new Proxy(pi, {{ get(target, key) {{
    if (key === 'registerTool') return (definition: any) => {{ if (definition.name === 'team_goal') audit=definition; if (definition.name === 'team_tasks') ledger=definition; return target.registerTool(definition); }};
    const value=target[key]; return typeof value==='function' ? value.bind(target) : value;
  }} }});
  team(proxy);
  pi.registerCommand('fixture-accept-backlog', {{ description:'Synthetic verified backlog acceptance; no model calls', handler:async(_: string, ctx: any) => {{
    const snapshot=await ledger.execute('fixture-list',{{action:'list'}},undefined,undefined,ctx);
    const pending=snapshot.details.ledger.tasks.filter((task: any)=>task.status==='planned');
    if (pending.length!==1) throw new Error('Expected one retained REWORK obligation');
    const result=await ledger.execute('fixture-accept',{{action:'update',updates:pending.map((task: any)=>({{id:task.id,status:'done',evidence:['Synthetic fixture verification: final target regression and cleanup checked'],reason:'Main CP explicitly accepts the retained fixture obligation; not a live product verification'}}))}},undefined,undefined,ctx);
    if (result.isError) throw new Error(JSON.stringify(result));
  }} }});
  pi.registerCommand('fixture-audit', {{ description:'Temporary main-CP test; no model calls', handler:async(args: string, ctx: any) => {{
    const verdict=args.trim();
    const params: any={{verdict,summary:'Main CP inspected fixture.txt:1 and final integration evidence before recording the decision.',evidence:['fixture.txt:1','npm test: exit 0, 1/1 at final target HEAD','git worktree list: owned temporary trees absent']}};
    if (verdict==='REWORK') params.nextTasks=['Bridges: fix fixture boundary, then Ayton verifies integrated regression.'];
    if (verdict==='GOAL_COMPLETE') params.acceptanceMet=['Regression verified: npm test exit 0','Owned worktrees cleaned: git worktree list'];
    const result=await audit.execute('fixture-audit',params,undefined,undefined,ctx);
    ctx.ui.notify(JSON.stringify({{fixtureAudit:true,verdict,result}}),result.isError?'error':'info');
    if (result.isError) throw new Error(JSON.stringify(result));
  }} }});
}}
""")
    command = ['pi', '--mode', 'rpc', '--session', str(session), '--provider', 'anthropic', '--model', 'claude-sonnet-4-5', '--api-key', 'fixture-not-used', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-mcp', '-e', str(fixture)]
    evidence = []
    class Client:
        def __init__(self):
            self.stderr = tempfile.TemporaryFile()
            self.p = subprocess.Popen(command, cwd=root, env=dict(os.environ, PI_CODING_AGENT_DIR=str(root)), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, bufsize=0)
            self.counter = 0
        def request(self, kind, **fields):
            self.counter += 1
            rid = str(self.counter)
            self.p.stdin.write((json.dumps({'id': rid, 'type': kind, **fields}) + '\n').encode())
            self.p.stdin.flush()
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                readable, _, _ = select.select([self.p.stdout], [], [], max(0, deadline-time.monotonic()))
                if not readable:
                    break
                raw = self.p.stdout.readline()
                if not raw:
                    self.stderr.seek(0)
                    raise RuntimeError(self.stderr.read().decode(errors='replace')[-2500:])
                event = json.loads(raw)
                evidence.append(event)
                assert event.get('type') not in ('agent_start', 'tool_execution_start'), 'Fixture must not start a model or child/tool execution.'
                if event.get('type') == 'response' and event.get('id') == rid:
                    assert event.get('success'), event
                    return event.get('data')
            raise TimeoutError(kind)
        def close(self):
            self.p.stdin.close()
            try:
                self.p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.p.terminate()
                self.p.wait(timeout=5)
            self.stderr.close()
    def latest_state(c):
        entries = c.request('get_entries')['entries']
        return [e['data'] for e in entries if e.get('customType') == 'team-state'][-1], entries
    c = Client()
    try:
        before = c.request('get_state')
        assert before['sessionId'] == parent_id
        c.request('prompt', message='/fixture-audit REWORK')
        first, _ = latest_state(c)
        assert first['goal']['status'] == 'active' and first['goal']['rounds'] == 1
        assert first['goal']['audits'][0]['auditor'] == 'main-cp'
        assert first['calls']['cp'] == 0
        assert len(first['ledger']['tasks']) == 1 and first['ledger']['tasks'][0]['status'] == 'planned'
        c.request('prompt', message='/team mode strict')
        c.request('prompt', message='/fixture-accept-backlog')
        c.request('prompt', message='/fixture-audit GOAL_COMPLETE')
        complete, entries = latest_state(c)
        assert complete['goal']['status'] == 'complete' and complete['goal']['rounds'] == 2
        assert all(a['auditor'] == 'main-cp' for a in complete['goal']['audits'])
        assert complete['calls']['cp'] == complete['tasks'] == complete['spendUSD'] == 0
        c.request('prompt', message='/team mode economy')
        c.request('prompt', message='/team off')
        c.request('prompt', message='/team on')
        after = c.request('get_state')
        assert before['model']['provider'] == after['model']['provider'] and before['model']['id'] == after['model']['id']
        assert before['thinkingLevel'] == after['thinkingLevel']
        assert not any(e.get('message', {}).get('toolName') == 'Agent' for e in entries)
    finally:
        c.close()
    c = Client()
    try:
        after_restart = c.request('get_state')
        resumed, _ = latest_state(c)
        assert resumed['goal']['status'] == 'complete' and resumed['goal']['rounds'] == 2
        assert resumed['calls']['cp'] == 0 and all(a['auditor'] == 'main-cp' for a in resumed['goal']['audits'])
        assert after_restart['model']['id'] == before['model']['id'] and after_restart['thinkingLevel'] == before['thinkingLevel']
    finally:
        c.close()
    result = {'passed': True, 'scope': 'real Pi RPC + temporary fixture direct registered audit; no live model-driven scheduling', 'checks': ['main CP records REWORK without CP child', 'main CP records GOAL_COMPLETE without CP child', 'two audit rounds persist auditor main-cp', 'mode/on/off preserve chosen model and thinking', 'no extra child calls/tasks/accounting', 'restart restores final goal/audit identity', 'no model/tool requests were started']}
    pathlib.Path('/tmp/team-cp-parent-rpc-evidence.json').write_text(json.dumps(result, indent=2))
    print('Real Pi CP-parent RPC passed: 7 checks; evidence /tmp/team-cp-parent-rpc-evidence.json')
