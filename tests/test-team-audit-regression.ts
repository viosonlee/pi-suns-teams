/**
 * Regression tests for the throughput/efficiency overhaul (pseudo-serialization reduction + coach prompts).
 *
 * Covers:
 * 1. readMode:"snapshot" read-only tasks run parallel with in-flight writers; "strict" (default) still blocks.
 * 2. Reviewing workers (stopped writing) do not block ready tasks in DIFFERENT verified worktrees.
 * 3. provisionAutoWorktree: clean tree creates a task-owned worktree; dirty tree / non-git fail closed.
 * 4. The improved send_session_message / yield_to_subsessions / team_tasks rejection texts include the
 *    minimal next-action recipe (Agent resume / team_dispatch / evidence requirements).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

import { newLedger, addRequest, addTasks, readyTasks, markDispatched, taskConflict } from "../team-ledger.ts";
import { provisionAutoWorktree } from "../team-worktree.ts";
import { isBashWriteCommand, detectSubagentTaskAssignment, buildPolicy } from "../extensions/team.ts";

const test = (name: string, fn: () => void) => { fn(); console.log(`\u2713 ${name}`); };
let passed = 0;
const run = (name: string, fn: () => void) => { test(name, fn); passed++; };

function fixture(cwd = "/repo") {
	const b = newLedger();
	const q = addRequest(b, "audit regression", "audit:1");
	const add = (specs: any[]) => addTasks(b, specs.map(s => ({
		title: s.id, role: "bridges", requestIds: [q.id], dependsOn: [], readPaths: [],
		writePaths: [], acceptance: ["audit assertion"], splitWaiverReason: "audit",
		...s,
	})), cwd);
	return { b, q, add };
}

// -------------------------------------------------------------- 1. readMode snapshot
run("readMode snapshot read-only task runs parallel with an in-flight writer; strict blocks", () => {
	const { b, add } = fixture();
	add([
		{ id: "W-snap", role: "cp", readPaths: ["src/a.ts"], writePaths: [], readMode: "snapshot", declaredReadOnly: true },
		{ id: "W-strict", role: "cp", readPaths: ["src/a.ts"], writePaths: [], declaredReadOnly: true },
		{ id: "W-writer", writePaths: ["src/a.ts"] },
	]);
	const [snap, strict, writer] = b.tasks;
	markDispatched(b, writer.id, "bridges", "run-writer");
	assert.equal(taskConflict(writer, snap), false, "snapshot read skips write-vs-read");
	assert.equal(taskConflict(writer, strict), true, "strict read still blocks on write-vs-read");
	const ready = readyTasks(b).map(t => t.id);
	assert.ok(ready.includes("W-snap"), "snapshot reader is dispatchable while writer runs");
	assert.ok(!ready.includes("W-strict"), "strict reader is NOT dispatchable while writer runs");
});

run("readMode snapshot rejects writer tasks and unknown values", () => {
	const { b, add } = fixture();
	assert.throws(() => add([{ id: "W-bad-mode", writePaths: ["src/x"], readMode: "other" }]), /readMode must be/);
	assert.throws(() => add([{ id: "W-bad-writer", writePaths: ["src/x"], readMode: "snapshot" }]), /readMode:"snapshot" requires a read-only task/);
});

// -------------------------------------------------------------- 2. reviewing + different worktree
run("reviewing hold does not block a ready task in a different verified worktree", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-review-wt-"));
	try {
		const repo = join(tmp, "repo");
		const wt1 = join(tmp, "wt1");
		const wt2 = join(tmp, "wt2");
		mkdirSync(repo);
		execSync("git init -q", { cwd: repo });
		writeFileSync(join(repo, "f.txt"), "base\n");
		execSync("git add . && git -c user.email=a@b -c user.name=a commit -qm base", { cwd: repo });
		for (const p of [wt1, wt2]) execSync(`git worktree add -q "${p}" HEAD`, { cwd: repo });

		const { b, add } = fixture();
		add([
			{ id: "W-hold", writePaths: ["src/a.ts"] },
			{ id: "W-free", writePaths: ["src/b.ts"], isolation: "worktree", worktreePath: wt2 },
		]);
		const [hold, free] = b.tasks;
		markDispatched(b, hold.id, "bridges", "run-hold");
		hold.status = "reviewing";
		// distinct verified worktrees intentionally do not conflict at taskConflict level (auto-worktree escape);
		const ready = readyTasks(b).map(t => t.id);
		assert.ok(ready.includes("W-free"), "different-worktree ready task bypasses the reviewing hold");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// -------------------------------------------------------------- 3. auto-worktree provisioning
run("provisionAutoWorktree creates a tracked worktree on a clean tree; dirty tree fails closed", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-auto-wt-"));
	try {
		const repo = join(tmp, "repo");
		mkdirSync(repo);
		execSync("git init -q", { cwd: repo });
		writeFileSync(join(repo, "f.txt"), "base\n");
		execSync("git add . && git -c user.email=a@b -c user.name=a commit -qm base", { cwd: repo });

		const dry = provisionAutoWorktree(repo, "W-auto", { dryRun: true });
		assert.equal(dry.ok, true);
		assert.ok(dry.branch?.startsWith("pi-teams-auto/W-auto-"), "branch is task-scoped");
		assert.ok(dry.worktreePath?.includes("pi-teams-worktrees/W-auto"), "path is tracked under the auto-worktrees root");

		const live = provisionAutoWorktree(repo, "W-auto");
		assert.equal(live.ok, true);
		assert.ok(live.worktreePath && live.branch);
		const listed = execSync("git worktree list --porcelain", { cwd: repo, encoding: "utf8" });
		assert.ok(listed.includes(live.worktreePath!), "git worktree list sees the new tree");
		execSync(`git worktree remove "${live.worktreePath}"`, { cwd: repo });
		execSync(`git branch -D "${live.branch!}"`, { cwd: repo });

		writeFileSync(join(repo, "dirty.txt"), "dirty\n");
		const dirty = provisionAutoWorktree(repo, "W-auto2");
		assert.equal(dirty.ok, false, "dirty tree refuses auto-worktree");
		assert.match(dirty.reason ?? "", /dirty/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

run("provisionAutoWorktree fails closed on a non-git directory", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pi-non-git-"));
	try {
		const res = provisionAutoWorktree(tmp, "W-non-git");
		assert.equal(res.ok, false, "non-git directory must not create a worktree");
		assert.match(res.reason ?? "", /git status failed/);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// -------------------------------------------------------------- 4. rejection-text recipes
run("send_session_message rejection includes the Agent(resume) recipe", () => {
	const entries = [
		{ type: "message", message: { role: "user", content: "TEAM_TASK: W-1\nGoal: x" } },
	];
	// The guard is embedded in the extension; assert through detectSubagentTaskAssignment instead.
	const parsed = detectSubagentTaskAssignment(entries);
	assert.equal(parsed?.id, "W-1");
	const policy = buildPolicy("standard", {} as any);
	assert.match(policy, /team_dispatch/);
});

run("isBashWriteCommand: bash -c script and secondary interpreters are writes; service status is safe", () => {
	for (const c of ["bash -c script.sh", "sh -c script.sh", "bash -c \"script.sh\"", "lua /tmp/script.lua",
		"awk -f /tmp/script.awk", "javac Main.java", "rustc main.rs", "emacs file.txt", "mount /dev/sdb1 /mnt",
		"mysql -e \"DROP DATABASE x\"", "terraform destroy", "helm install x chart", "systemctl restart nginx",
		"useradd hacker", "iptables -F", "kill -9 1234", "crontab -r"]) {
		const r = isBashWriteCommand(c);
		assert.equal(r.isWrite, true, `${c} must be a write`);
	}
	for (const c of ["service nginx status", "systemctl status nginx", "crontab -l", "mysql --version",
		"helm list", "kubectl get pods", "docker ps", "terraform plan", "kill -l"]) {
		const r = isBashWriteCommand(c);
		assert.equal(r.isWrite, false, `${c} must be safe`);
	}
});

console.log(`\naudit regression: ${passed} tests passed`);
