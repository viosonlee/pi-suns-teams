"""Opt-in live pi-web/model E2E of main-CP REWORK -> GOAL_COMPLETE.
Creates a new disposable fixture and new sessions only; never touches old sessions.
Unlike unit/RPC fixtures, this uses real configured models and children.
Run explicitly: python3 .../run-team-cp-parent-live.py --run
"""
import argparse
import json
import pathlib
import tempfile
import time
import urllib.request

p = argparse.ArgumentParser()
p.add_argument('--run', action='store_true', help='Explicitly authorize live model requests.')
p.add_argument('--base-url', default='http://127.0.0.1:30141')
p.add_argument('--provider', default='magpie')
p.add_argument('--model', default='agentrouter/gpt-6.1-sol')
p.add_argument('--deadline', type=int, default=900)
p.add_argument('--worker-model', default=None, help='Optional per-call model override for disposable test children only.')
a = p.parse_args()
if not a.run:
    p.error('Live model E2E is opt-in: pass --run.')

def api(path, payload):
    req = urllib.request.Request(a.base_url + path, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read())

def text(message):
    content = message.get('content', [])
    return content if isinstance(content, str) else '\n'.join(b.get('text', '') for b in content if b.get('type') == 'text')

# Keep the fixture/evidence available for inspection rather than deleting an active child's cwd.
fixture = pathlib.Path(tempfile.mkdtemp(prefix='team-cp-parent-live-'))
(fixture / 'result.txt').write_text('alpha\n')
(fixture / 'SPEC.md').write_text('Acceptance: result.txt must contain exactly beta followed by a newline.\n')
(fixture / 'verify.py').write_text("from pathlib import Path\ns=Path(__file__).with_name('result.txt').read_text()\nassert s == 'beta\\n', repr(s)\nprint('PASS: result.txt contains beta exactly')\n")
created = api('/api/agent/new', {'cwd': str(fixture), 'provider': a.provider, 'modelId': a.model, 'thinkingLevel': 'high', 'type': 'ensure_session'})
assert created.get('success'), created
sid = created['sessionId']
endpoint = '/api/agent/' + sid
api(endpoint, {'type': 'prompt', 'message': '/team on'})
state_before = api(endpoint, {'type': 'get_state'})
state_before = state_before.get('data', state_before)
msg = (
    'Complete this disposable CP-parent workflow E2E. The main session itself is CP. Never delegate to the cp child. '
    'Acceptance: result.txt must contain exactly beta followed by newline, and python3 verify.py must pass. '
    'For the FIRST round only, dispatch Booker for bounded READ-ONLY review of SPEC.md/result.txt and Ayton for READ-ONLY execution of python3 verify.py in parallel. '
    'Do not change result.txt before collecting those initial reports: the seeded alpha is a deliberate failing baseline. '
    'Use DELEGATION_REASON with scope and evidence for Booker; no prior Bridges failure is required. '
    'Once initial evidence confirms the mismatch, record your own team_goal REWORK with evidence and actionable nextTasks. '
    'Then continue automatically without user input: dispatch Bridges to change only result.txt to beta, have Ayton verify it, '
    'and record your own team_goal GOAL_COMPLETE with the acceptanceMet entry and actual evidence. '
    'This fixture is NOT product work: do not edit verify.py or SPEC.md, do not execute Git commands, create worktrees, install anything, '
    'change configuration, write outside this fixture, or manipulate old sessions. Report WORKTREE_NOT_USED. '
    'Every Agent task brief, child report, nextTasks and audit summary must be English. User-facing language is unrestricted. '
    'Do not report spending. Run short commands with timeout. '
    'The objective includes executing exactly the initial failing-baseline round before the repair round so do not skip REWORK. '
)
if a.worker_model:
    msg += ' For this disposable test only, set every Agent model argument to ' + a.worker_model + '; this is a per-call override, not a profile/configuration change.'
# Goal command starts model work once. No manual continue messages thereafter.
objective = msg.replace('"', "'")
api(endpoint, {'type': 'prompt', 'message': '/team goal ' + objective + ' --accept "result.txt contains beta exactly and python3 verify.py passes"'})
started = time.monotonic()
session_file = None
latest_state = None
while time.monotonic() - started < a.deadline:
    time.sleep(5)
    response = api(endpoint, {'type': 'get_state'})
    current = response.get('data', response)
    session_file = current.get('sessionFile')
    if session_file and pathlib.Path(session_file).exists():
        entries = []
        for line in pathlib.Path(session_file).read_text().splitlines():
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        states = [e.get('data', {}) for e in entries if e.get('customType') == 'team-state']
        latest_state = states[-1] if states else None
        if latest_state and latest_state.get('goal', {}).get('status') != 'active':
            break
        failures = [e['message'].get('errorMessage', '') for e in entries if e.get('message', {}).get('role') == 'assistant' and e['message'].get('stopReason') == 'error']
        if failures and not current.get('isStreaming'):
            break
if not session_file:
    response = api(endpoint, {'type': 'get_state'})
    current = response.get('data', response)
    session_file = current.get('sessionFile')
entries = []
if session_file and pathlib.Path(session_file).exists():
    for line in pathlib.Path(session_file).read_text().splitlines():
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            pass
states = [e.get('data', {}) for e in entries if e.get('customType') == 'team-state']
latest_state = states[-1] if states else {}
audits = latest_state.get('goal', {}).get('audits', [])
calls = []
errors = []
for e in entries:
    m = e.get('message', {})
    if m.get('role') == 'assistant':
        if m.get('stopReason') == 'error':
            errors.append(m.get('errorMessage', '')[:500])
        for b in m.get('content', []):
            if b.get('type') == 'toolCall' and b.get('name') == 'Agent':
                calls.append({'at': e.get('timestamp'), 'role': b.get('arguments', {}).get('subagent_type'), 'background': b.get('arguments', {}).get('run_in_background')})
passed = latest_state.get('goal', {}).get('status') == 'complete' and len(audits) >= 2 and audits[0].get('verdict') == 'REWORK' and audits[-1].get('verdict') == 'GOAL_COMPLETE' and all(x.get('auditor') == 'main-cp' for x in audits) and not any(x['role'] == 'cp' for x in calls) and (fixture/'result.txt').read_text() == 'beta\n'
evidence = {'passed': passed, 'scope': 'live pi-web models and child sessions, no manual continue after goal start', 'parentSessionId': sid, 'sessionFile': session_file, 'fixture': str(fixture), 'goalStatus': latest_state.get('goal', {}).get('status'), 'audits': [{'verdict': x.get('verdict'), 'auditor': x.get('auditor'), 'evidence': x.get('evidence')} for x in audits], 'agentCalls': calls, 'errors': errors}
pathlib.Path('/tmp/team-cp-parent-live-evidence.json').write_text(json.dumps(evidence, indent=2))
print(json.dumps({k: evidence[k] for k in ['passed','parentSessionId','fixture','goalStatus','audits','agentCalls','errors']}, indent=2))
print('Evidence: /tmp/team-cp-parent-live-evidence.json')
if not passed:
    # Stop ONLY this test goal's automatic continuation; never touch production goals/children.
    try:
        api(endpoint, {'type':'prompt','message':'/team goal stop'})
    except Exception:
        pass
    raise SystemExit(1)
