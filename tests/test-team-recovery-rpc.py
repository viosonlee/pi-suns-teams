"""Real Pi RPC smoke test of read-only report reconciliation and persistence.
All session mutations occur in temporary fixtures. No model calls or production changes.
Run: python3 ~/.pi/agent/team-tests/test-team-recovery-rpc.py
"""
import hashlib
import json
import os
import pathlib
import select
import subprocess
import tempfile
import time
import uuid

SOURCE = pathlib.Path(__file__).resolve().parents[1]

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

with tempfile.TemporaryDirectory(prefix="team-recovery-rpc-") as temp:
    root = pathlib.Path(temp)
    parent_id, child_id = str(uuid.uuid4()), str(uuid.uuid4())
    parent_dir, child_dir = root / "sessions" / "--parent--", root / "sessions" / "--child--"
    parent_dir.mkdir(parents=True)
    child_dir.mkdir(parents=True)
    parent = parent_dir / f"2026-01-01T00-00-00-000Z_{parent_id}.jsonl"
    child = child_dir / f"2026-01-01T00-00-00-000Z_{child_id}.jsonl"
    state = json.loads(subprocess.check_output([
        "node", "--input-type=module", "-e",
        f"import {{initialState,defaultConfig}} from '{SOURCE / 'extensions/team.ts'}'; let s=initialState(defaultConfig());s.enabled=true;s.startedAt='2026-01-01T00:00:00.000Z';console.log(JSON.stringify(s));",
    ], text=True))
    state["calls"]["bridges"] = 20  # Existing long-running session; recovery must not add a call.
    (root / "team.json").write_text(json.dumps({"sessionBudgetUSD": 0, "roles": {"bridges": {"maxCalls": 0}}}))
    def record(kind, entry_id, previous, second, **fields):
        return {"type": kind, "id": entry_id, "parentId": previous, "timestamp": f"2026-01-01T00:00:{second:02d}.000Z", **fields}
    parent_rows = [
        {"type": "session", "version": 3, "id": parent_id, "timestamp": "2026-01-01T00:00:00.000Z", "cwd": str(root)},
        record("custom", "state", None, 1, customType="team-state", data=state),
        record("message", "old-get", "state", 2, message={"role": "toolResult", "toolName": "get_subagent_result", "toolCallId": "previous-get", "content": [{"type": "text", "text": "The previous run was interrupted."}], "isError": False, "details": {"sessionId": child_id, "status": "interrupted"}, "timestamp": 1767225602000}),
    ]
    child_rows = [
        {"type": "session", "version": 3, "id": child_id, "timestamp": "2026-01-01T00:00:00.000Z", "cwd": str(root)},
        record("custom", "meta", None, 1, customType="pi-web:subagent", data={"version": 1, "parentSessionId": parent_id, "parentSessionPath": str(parent), "profile": "bridges"}),
        record("custom", "running", "meta", 2, customType="pi-web:subagent-status", data={"version": 1, "status": "running"}),
        record("message", "abort", "running", 3, message={"role": "assistant", "content": [], "stopReason": "aborted", "timestamp": 1767225603000}),
        record("custom", "interrupted", "abort", 4, customType="pi-web:subagent-result", data={"version": 1, "status": "aborted", "completedAt": "2026-01-01T00:00:04.000Z"}),
        record("message", "continue", "interrupted", 5, message={"role": "user", "content": "Continue and report.", "timestamp": 1767225605000}),
        record("message", "final-report", "continue", 6, message={"role": "assistant", "content": [{"type": "text", "text": "Recovered fixture report. Evidence: fixture.txt:1; tests 1/1 passed. Acceptance still requires lead verification."}], "stopReason": "stop", "timestamp": 1767225606000}),
    ]
    for path, rows in [(parent, parent_rows), (child, child_rows)]:
        path.write_text("\n".join(json.dumps(row) for row in rows) + "\n")
    original_child_hash = digest(child)
    env = dict(os.environ, PI_CODING_AGENT_DIR=str(root))
    command = ["pi", "--mode", "rpc", "--session", str(parent), "--provider", "anthropic", "--model", "claude-sonnet-4-5", "--api-key", "fixture-not-used", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "-e", str(SOURCE / "extensions/team.ts")]
    evidence = []
    class Client:
        def __init__(self):
            self.stderr_file = tempfile.TemporaryFile()
            self.proc = subprocess.Popen(command, cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr_file, bufsize=0)
            self.counter = 0
        def request(self, kind, **fields):
            self.counter += 1
            request_id = str(self.counter)
            self.proc.stdin.write((json.dumps({"id": request_id, "type": kind, **fields}) + "\n").encode())
            self.proc.stdin.flush()
            deadline = time.monotonic() + 25
            while time.monotonic() < deadline:
                readable, _, _ = select.select([self.proc.stdout], [], [], max(0, deadline - time.monotonic()))
                if not readable:
                    break
                raw = self.proc.stdout.readline()
                if not raw:
                    self.stderr_file.seek(0)
                    raise RuntimeError("Pi exited: " + self.stderr_file.read().decode(errors="replace")[-2000:])
                event = json.loads(raw)
                evidence.append(event)
                assert event.get("type") not in ("agent_start", "tool_execution_start"), "A reconciliation command must not trigger model/tool work."
                if event.get("type") == "response" and event.get("id") == request_id:
                    assert event.get("success"), event
                    return event.get("data")
            raise TimeoutError(kind)
        def close(self):
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.terminate()
                self.proc.wait(timeout=5)
            self.stderr_file.close()
    def checks(client):
        state = client.request("get_state")
        assert state["sessionId"] == parent_id and not state["isStreaming"]
        entries = client.request("get_entries")["entries"]
        reports = [e for e in entries if e.get("customType") == "team-recovered-report"]
        receipts = [e for e in entries if e.get("customType") == "team-run" and e.get("data", {}).get("status") == "reported"]
        assert len(reports) == len(receipts) == 1, (len(reports), len(receipts))
        assert "fixture.txt:1" in reports[0]["content"]
        assert reports[0]["details"]["accepted"] is False
        assert receipts[0]["data"]["sessionId"] == child_id
        assert receipts[0]["data"]["hostStatus"] == "interrupted"
        saved_state = [e["data"] for e in entries if e.get("customType") == "team-state"][-1]
        assert saved_state["calls"]["bridges"] == 20
        assert saved_state["tasks"] == 0 and saved_state["spendUSD"] == 0
        assert digest(child) == original_child_hash
    first = Client()
    try:
        first.request("prompt", message="/team reconcile")
        checks(first)
        first.request("prompt", message=f"/team reconcile {child_id}")
        checks(first)
    finally:
        first.close()
    second = Client()
    try:
        checks(second)
        second.request("prompt", message="/team reconcile")
        checks(second)
    finally:
        second.close()
    summary = {"test": "real Pi RPC reconciliation", "passed": True, "checks": ["existing parent session opened", "one recovered report persisted", "repeated reconciliation idempotent", "restart preserves report without duplicate", "no model/tool calls started", "no extra task/call/accounting", "child file hash unchanged"], "notifications": [e.get("message") for e in evidence if e.get("type") == "extension_ui_request" and e.get("method") == "notify"]}
    pathlib.Path("/tmp/team-recovery-rpc-evidence.json").write_text(json.dumps(summary, indent=2))
    print("Real Pi RPC smoke passed: 7 checks; evidence /tmp/team-recovery-rpc-evidence.json")
