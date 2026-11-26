import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveStaleChildSessions } from "../team-gc.ts";
import type { WorkTask } from "../team-ledger.ts";

function makeChildFile(dir: string, sid: string, parentId: string | null, mtime: Date, withAcp = true): string {
	const file = join(dir, `2026-11-16T00-00-00-000Z_${sid}.jsonl`);
	const lines = [JSON.stringify({ type: "session", version: 3, id: sid, cwd: "/tmp", timestamp: mtime.toISOString() })];
	if (parentId !== null) {
		lines.push(JSON.stringify({ type: "custom", id: "m0", parentId: null, customType: "pi-web:subagent", data: { version: 1, parentSessionId: parentId }, timestamp: mtime.toISOString() }));
	}
	lines.push(JSON.stringify({ type: "message", id: "m1", parentId: parentId ? "m0" : null, timestamp: mtime.toISOString(), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } }));
	writeFileSync(file, lines.join("\n") + "\n");
	utimesSync(file, mtime, mtime);
	if (withAcp) {
		writeFileSync(`${file}.acp.json`, JSON.stringify({ ok: true }));
		utimesSync(`${file}.acp.json`, mtime, mtime);
	}
	return file;
}

function task(overrides: Partial<WorkTask> & { id: string }): WorkTask {
	return {
		title: overrides.id,
		requestIds: ["Q-1"],
		role: "bridges",
		dependsOn: [],
		readPaths: [],
		writePaths: [],
		acceptance: ["AC1"],
		status: "done",
		evidence: ["ok"],
		...overrides,
	};
}

const root = mkdtempSync(join(tmpdir(), "pi-team-gc-test-"));
try {
	const wsName = "--tmp-workspace--";
	const sessionsDir = join(root, "sessions", wsName);
	mkdirSync(sessionsDir, { recursive: true });

	const now = Date.now();
	const parentId = "parent-gc-001";
	const t2hAgo = new Date(now - 2 * 3600_000);
	const t3hAgo = new Date(now - 3 * 3600_000);
	const t26hAgo = new Date(now - 26 * 3600_000);
	const t30hAgo = new Date(now - 30 * 3600_000);

	// 1. Eligible reviewer (2h old > 1h cooldown) -> ARCHIVE
	const fRev = makeChildFile(sessionsDir, "child-rev-done", parentId, t2hAgo);
	// 2. Eligible worker (26h old > 24h cooldown) -> ARCHIVE
	const fWorkerOld = makeChildFile(sessionsDir, "child-worker-old", parentId, t26hAgo);
	// 3. Recent done worker (3h old < 24h cooldown) -> KEEP
	const fWorkerRecent = makeChildFile(sessionsDir, "child-worker-recent", parentId, t3hAgo);
	// 4. Active running task (30h old, still running) -> KEEP
	const fRunning = makeChildFile(sessionsDir, "child-running", parentId, t30hAgo);
	// 5. Resumed session: old done task + new ready task share same sessionId -> KEEP
	const fResumed = makeChildFile(sessionsDir, "child-resumed", parentId, t30hAgo);
	// 6. Pinned session -> KEEP
	const fPinned = makeChildFile(sessionsDir, "child-pinned", parentId, t30hAgo);
	writeFileSync(join(root, "pi-web-session-state.json"), JSON.stringify({
		version: 1,
		sessions: { "child-pinned": { pinnedAt: now - 1000 } },
	}));
	// 7. Foreign parent child -> KEEP
	const fForeign = makeChildFile(sessionsDir, "child-foreign", "other-parent-999", t30hAgo);
	// 8. Root session (no pi-web:subagent meta) -> KEEP
	const fRoot = makeChildFile(sessionsDir, "root-not-child", null, t30hAgo);
	// 9. Active lease held -> KEEP
	const fLeased = makeChildFile(sessionsDir, "child-leased", parentId, t30hAgo);
	// 10. Unreferenced historical orphan (not in board.tasks, 26h old) -> ARCHIVE
	const fOrphanOld = makeChildFile(sessionsDir, "child-orphan-old", parentId, t26hAgo);
	// 11. Unreferenced historical orphan (not in board.tasks, only 3h old) -> KEEP
	const fOrphanRecent = makeChildFile(sessionsDir, "child-orphan-recent", parentId, t3hAgo);
	// 12. Unreferenced historical reviewer (not in board.tasks, in historicalLeases as W-rev-old, 2h old) -> ARCHIVE
	const fOrphanRev = makeChildFile(sessionsDir, "child-orphan-rev", parentId, t2hAgo);

	const tasks: WorkTask[] = [
		task({ id: "W-rev-1", parentTaskId: "W-1", role: "ayton", status: "done", sessionId: "child-rev-done", archivedAt: t2hAgo.toISOString() }),
		task({ id: "W-1", status: "done", sessionId: "child-worker-old", archivedAt: t26hAgo.toISOString() }),
		task({ id: "W-2", status: "done", sessionId: "child-worker-recent", archivedAt: t3hAgo.toISOString() }),
		task({ id: "W-3", status: "running", sessionId: "child-running", dispatchedAt: t30hAgo.toISOString() }),
		task({ id: "W-4-old", status: "done", sessionId: "child-resumed", archivedAt: t30hAgo.toISOString() }),
		task({ id: "W-4-rework", status: "ready", sessionId: "child-resumed" }),
		task({ id: "W-5", status: "done", sessionId: "child-pinned", archivedAt: t30hAgo.toISOString() }),
		task({ id: "W-6", status: "done", sessionId: "child-foreign", archivedAt: t30hAgo.toISOString() }),
		task({ id: "W-7", status: "done", sessionId: "root-not-child", archivedAt: t30hAgo.toISOString() }),
		task({ id: "W-8", status: "done", sessionId: "child-leased", archivedAt: t30hAgo.toISOString() }),
	];

	const activeLeases = new Set(["child-leased"]);
	const historicalLeases = [
		task({ id: "W-rev-old", parentTaskId: "W-old", role: "ayton", status: "done", sessionId: "child-orphan-rev" }),
	];

	// Dry-run first: must NOT move any files
	const dry = archiveStaleChildSessions({ agentDir: root, parentSessionId: parentId, tasks, activeLeaseSessionIds: activeLeases, historicalLeases, nowMs: now, dryRun: true });
	assert.strictEqual(dry.totalMatched, 10, `Dry-run expected 10 total matched children of parentId, got ${dry.totalMatched}`);
	assert.strictEqual(dry.archived.length, 4, `Dry-run expected 4 archivable, got ${dry.archived.length}`);
	assert.ok(existsSync(fRev) && existsSync(fWorkerOld) && existsSync(fOrphanOld) && existsSync(fOrphanRev), "Dry-run must not move files");
	console.log("✓ dry-run discovers all 10 disk children of parentId and identifies exact 4 eligible sessions");

	// Real archive run
	const res = archiveStaleChildSessions({ agentDir: root, parentSessionId: parentId, tasks, activeLeaseSessionIds: activeLeases, historicalLeases, nowMs: now, dryRun: false });
	assert.strictEqual(res.archived.length, 4, `Expected 4 archived, got ${res.archived.length}`);
	assert.strictEqual(res.errors.length, 0, `Unexpected errors: ${res.errors.join("; ")}`);
	assert.deepStrictEqual(res.archived.map(a => a.sessionId).sort(), ["child-orphan-old", "child-orphan-rev", "child-rev-done", "child-worker-old"]);

	// Archived files moved cleanly (both .jsonl and .acp.json)
	const archiveDir = join(root, "sessions-archive", wsName);
	assert.ok(!existsSync(fRev) && !existsSync(`${fRev}.acp.json`), "Reviewer moved out of sessions/");
	assert.ok(existsSync(join(archiveDir, "2026-11-16T00-00-00-000Z_child-rev-done.jsonl")), "Reviewer present in sessions-archive/");
	assert.ok(existsSync(join(archiveDir, "2026-11-16T00-00-00-000Z_child-rev-done.jsonl.acp.json")), "Reviewer .acp.json present in sessions-archive/");
	assert.ok(!existsSync(fWorkerOld) && !existsSync(`${fWorkerOld}.acp.json`), "Old worker moved out of sessions/");
	assert.ok(existsSync(join(archiveDir, "2026-11-16T00-00-00-000Z_child-worker-old.jsonl")), "Old worker present in sessions-archive/");
	assert.ok(!existsSync(fOrphanOld) && existsSync(join(archiveDir, "2026-11-16T00-00-00-000Z_child-orphan-old.jsonl")), "Old orphan archived");
	assert.ok(!existsSync(fOrphanRev) && existsSync(join(archiveDir, "2026-11-16T00-00-00-000Z_child-orphan-rev.jsonl")), "Old orphan reviewer archived");
	console.log("✓ eligible reviewer (2h), worker (26h), historical orphan (26h), and historical reviewer (2h) archived cleanly");

	// All 8 protected sessions MUST stay untouched
	for (const [label, fp] of [
		["recent worker", fWorkerRecent],
		["recent orphan", fOrphanRecent],
		["running task", fRunning],
		["resumed shared session", fResumed],
		["pinned session", fPinned],
		["foreign parent child", fForeign],
		["root session", fRoot],
		["leased session", fLeased],
	] as const) {
		assert.ok(existsSync(fp), `Protected session MUST stay in sessions/: ${label}`);
	}
	assert.strictEqual(res.skippedCooldown, 2);
	assert.strictEqual(res.skippedActive, 3);
	assert.strictEqual(res.skippedPinned, 1);
	assert.strictEqual(res.skippedUnverified, 2);
	console.log("✓ all 8 safety guards verified (cooldown, recent orphan, running, resumed, pinned, foreign-parent, root, live-lease)");

	// Second run is idempotent (0 archived)
	const res2 = archiveStaleChildSessions({ agentDir: root, parentSessionId: parentId, tasks, activeLeaseSessionIds: activeLeases, historicalLeases, nowMs: now, dryRun: false });
	assert.strictEqual(res2.archived.length, 0);
	console.log("✓ repeated GC run is idempotent (0 archived)");

	// -----------------------------------------------------------------
	// Hosted pi-web format (pi-web.subsession.spawned), ~/.pi-web/session-pins.json,
	// --all (includeInactiveParents), --delete, and orphan sidecar cleanup.
	const piWebDir = join(root, "pi-web-data");
	mkdirSync(piWebDir, { recursive: true });
	const inactiveParentId = "inactive-root-001";
	const activeParentId = parentId;

	const makeHostedChild = (sid: string, pId: string, mtime: Date, withAcp = true) => {
		const fp = join(sessionsDir, `2026-11-16T01-00-00-000Z_${sid}.jsonl`);
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: sid, cwd: "/tmp", timestamp: mtime.toISOString() }),
			JSON.stringify({ type: "model_change", id: "m0", parentId: null, timestamp: mtime.toISOString() }),
			JSON.stringify({ type: "custom", id: "m1", parentId: "m0", customType: "pi-web.subsession.spawned", data: { version: 1, spawnedBySessionId: pId, spawnedSessionId: sid }, timestamp: mtime.toISOString() }),
			JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: mtime.toISOString(), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] } }),
		];
		writeFileSync(fp, lines.join("\n") + "\n");
		utimesSync(fp, mtime, mtime);
		if (withAcp) {
			writeFileSync(`${fp}.acp.json`, JSON.stringify({ hosted: true }));
			utimesSync(`${fp}.acp.json`, mtime, mtime);
		}
		return fp;
	};

	// Inactive parent root itself (5h old) -> MUST NOT be deleted
	const fInactiveRoot = makeChildFile(sessionsDir, inactiveParentId, null, new Date(now - 5 * 3600_000), false);
	// Old hosted child of inactive parent (4h old > 2h idle) -> DELETE under --all --delete
	const fHostedOld = makeHostedChild("hosted-old-child", inactiveParentId, new Date(now - 4 * 3600_000));
	// Hosted child of inactive parent pinned in session-pins.json -> KEEP
	const fHostedPinned = makeHostedChild("hosted-pinned-child", inactiveParentId, new Date(now - 4 * 3600_000));
	// Recent hosted child (< 30m) -> KEEP even under --all --delete
	const fHostedFresh = makeHostedChild("hosted-fresh-child", inactiveParentId, new Date(now - 10 * 60_000));
	// Orphan .acp.json sidecar with missing .jsonl (3h old) -> PRUNE
	const fOrphanSidecar = join(sessionsDir, "2026-11-15T00-00-00-000Z_missing-session.jsonl.acp.json");
	writeFileSync(fOrphanSidecar, JSON.stringify({ orphan: true }));
	utimesSync(fOrphanSidecar, t3hAgo, t3hAgo);
	writeFileSync(join(piWebDir, "session-pins.json"), JSON.stringify({
		version: 1,
		entries: [{ scope: { kind: "session-pins", projectId: "proj-1", workspaceId: "ws-1" }, ids: ["hosted-pinned-child"], revision: 1 }],
	}));

	const delRes = archiveStaleChildSessions({
		agentDir: root,
		piWebDataDir: piWebDir,
		parentSessionId: activeParentId,
		tasks,
		activeLeaseSessionIds: activeLeases,
		historicalLeases,
		nowMs: now,
		includeInactiveParents: true,
		inactiveParentIdleMs: 2 * 3600_000,
		mode: "delete",
		pruneOrphanSidecars: true,
		dryRun: false,
	});
	assert.strictEqual(delRes.errors.length, 0, `Unexpected delete GC errors: ${delRes.errors.join("; ")}`);
	assert.ok(!existsSync(fHostedOld) && !existsSync(`${fHostedOld}.acp.json`), "Hosted child of inactive parent deleted cleanly");
	assert.ok(!existsSync(fOrphanSidecar), "Orphan .acp.json sidecar removed");
	assert.strictEqual(delRes.orphanSidecarsRemoved, 1);
	assert.ok(existsSync(fInactiveRoot), "Inactive root session MUST NEVER be deleted");
	assert.ok(existsSync(fHostedPinned), "session-pins.json pinned child MUST be kept");
	assert.ok(existsSync(fHostedFresh), "Recent <30m hosted child MUST be kept");
	console.log("✓ hosted pi-web.subsession.spawned, session-pins.json, --all --delete, and orphan sidecar pruning verified");

	console.log("\nAll team-gc tests passed!");
} finally {
	rmSync(root, { recursive: true, force: true });
}
