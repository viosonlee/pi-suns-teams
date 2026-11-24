/**
 * test-team-gc-safety.ts — W-119 regression suite for team-gc.ts fail-closed / collision-safe archival.
 *
 * Every case is a synthetic fixture under a fresh mkdtemp root: no real session directory is read,
 * no real session is moved, and no live pi process state is touched.
 *
 * Coverage:
 *  - pin state: malformed JSON, root not object, missing `sessions`, `sessions` wrong type,
 *    per-entry `pinnedAt` uncertainty (=> treated as pinned/preserved), the ENOENT baseline, and
 *    unreadable states (dangling symlink, directory) which must be UNKNOWN, never known-empty.
 *  - archive paths: existing archive entry is never overwritten (slot ~2), proven interrupted pairs
 *    (same-inode link / staged sidecar) are completed instead of duplicated, direct moveFileNoClobber
 *    EEXIST refusal, and an orphan sidecar with unknown provenance is preserved instead of adopted by
 *    filename coincidence.
 *  - pair movement: sidecar failure (nothing moved), jsonl failure after sidecar (rollback),
 *    rollback failure (truthful partial receipt + second-pass ambiguity deferral), EXDEV/copy fallback
 *    with byte-identical content, a post-copy/source-unlink failure whose created destination is
 *    discarded or named in the receipt, and a post-scan sidecar race (adopted when regular, partial
 *    receipt when anomalous), and a hardlink-then-fail sidecar move whose fragment is never deleted
 *    without proven ownership and is always named in a truthful partial receipt.
 *  - fail-closed stat probes: non-ENOENT stat errors are UNKNOWN, never "absent" — sidecar
 *    detection and the pre-move slot scan retain the candidate, an unverifiable slot is skipped,
 *    and the completion gate refuses to report a session archived while required state cannot be
 *    verified.
 *  - discovery: indexed single pass (`scannedFiles` + `scannedEntries`), enumeration budgets that
 *    bound the directory walk itself, foreign/root files counted as unverified, ledger ids with no
 *    file on disk, symlinked workspace dirs skipped, dry-run purity.
 *  - preservation: `uncertain` task status, non-regular sidecar kept in place, content + byte accounting.
 *
 * The DEFECT-* checks are mutation-verified: reverting the corresponding guard in team-gc.ts makes
 * them fail (see backups/team-bugfix-gc/W119-REWORK.md for the mutation matrix).
 *
 * Run: node --experimental-strip-types team-tests/test-team-gc-safety.ts
 */

import assert from "node:assert";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveStaleChildSessions, loadPinnedSessionIds, moveFileNoClobber } from "../team-gc.ts";
import type { ChildGcOptions, ChildGcResult, GcMoveOp } from "../team-gc.ts";
import type { WorkTask } from "../team-ledger.ts";

const TS_PREFIX = "2026-11-16T00-00-00-000Z";
const WS = "--tmp-workspace--";
const HOUR = 3600_000;

const now = Date.now();
const t2h = new Date(now - 2 * HOUR);
const t3h = new Date(now - 3 * HOUR);
const t26h = new Date(now - 26 * HOUR);
const t30h = new Date(now - 30 * HOUR);
/** Shared eligible fixture task for session `child-a` (26h old worker ⇒ past the 24h cooldown). */
const TASKS_A = [task({ id: "W-1", sessionId: "child-a", archivedAt: t26h.toISOString() })];

// ---------------------------------------------------------------- fixtures

function freshRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-team-gc-safety-"));
}

function sessionsDirOf(root: string, ws = WS): string {
	const dir = join(root, "sessions", ws);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function makeChildFile(
	dir: string,
	sid: string,
	parentId: string | null,
	mtime: Date,
	withAcp = true,
): string {
	const file = join(dir, `${TS_PREFIX}_${sid}.jsonl`);
	const lines = [JSON.stringify({ type: "session", version: 3, id: sid, cwd: "/tmp", timestamp: mtime.toISOString() })];
	if (parentId !== null) {
		lines.push(JSON.stringify({ type: "custom", id: "m0", parentId: null, customType: "pi-web:subagent", data: { version: 1, parentSessionId: parentId }, timestamp: mtime.toISOString() }));
	}
	lines.push(JSON.stringify({ type: "message", id: "m1", parentId: parentId ? "m0" : null, timestamp: mtime.toISOString(), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } }));
	writeFileSync(file, lines.join("\n") + "\n");
	utimesSync(file, mtime, mtime);
	if (withAcp) writeSidecar(file, mtime);
	return file;
}

function writeSidecar(jsonlPath: string, mtime: Date, body = JSON.stringify({ ok: true })): string {
	const p = `${jsonlPath}.acp.json`;
	writeFileSync(p, body);
	utimesSync(p, mtime, mtime);
	return p;
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

function writePinState(root: string, payload: unknown): void {
	writeFileSync(
		join(root, "pi-web-session-state.json"),
		typeof payload === "string" ? payload : JSON.stringify(payload),
	);
}

function runGc(root: string, extra: Partial<ChildGcOptions> = {}): ChildGcResult {
	return archiveStaleChildSessions({
		agentDir: root,
		parentSessionId: "parent-gc-001",
		tasks: [],
		activeLeaseSessionIds: new Set<string>(),
		nowMs: now,
		...extra,
	});
}

function archivePath(root: string, name: string, ws = WS): string {
	return join(root, "sessions-archive", ws, name);
}

function listArchive(root: string, ws = WS): string[] {
	const dir = join(root, "sessions-archive", ws);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).sort();
}

// ---------------------------------------------------------------- harness

const checks: { name: string; ok: boolean; detail?: string }[] = [];

function check(name: string, fn: () => void): void {
	try {
		fn();
		checks.push({ name, ok: true });
	} catch (err) {
		checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
	}
}

function withRoot(fn: (root: string) => void): void {
	const root = freshRoot();
	try {
		fn(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- 1. pin state fail-closed

check("pin state: malformed JSON ⇒ nothing archived, evidence preserved", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		writePinState(root, '{"version":1,"sessions":{"child-a":{"pinnedAt":');
		const res = runGc(root, { tasks: [task({ id: "W-1", sessionId: "child-a", archivedAt: t26h.toISOString() })] });
		assert.strictEqual(res.pinsUnknown, true, "pinsUnknown must be reported");
		assert.strictEqual(res.archived.length, 0, "must archive nothing");
		assert.strictEqual(res.partials.length, 0);
		assert.strictEqual(res.totalBytesFreed, 0);
		assert.ok(existsSync(jsonl) && existsSync(acp), "jsonl and sidecar must stay in sessions/");
		assert.ok(!existsSync(join(root, "sessions-archive")), "no archive tree may be created");
		assert.match(res.errors.join("\n"), /pin state unknown .*fail-closed/);
	});
});

check("pin state: root not an object / missing sessions / sessions wrong type ⇒ fail closed", () => {
	const bad: { label: string; payload: unknown }[] = [
		{ label: "array root", payload: [] },
		{ label: "string root", payload: '"nope"' },
		{ label: "missing sessions", payload: { version: 1, revision: 4 } },
		{ label: "sessions array", payload: { version: 1, sessions: [] } },
		{ label: "sessions null", payload: { version: 1, sessions: null } },
	];
	for (const c of bad) {
		withRoot((root) => {
			const dir = sessionsDirOf(root);
			const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
			writePinState(root, c.payload);
			const res = runGc(root, { tasks: [task({ id: "W-1", sessionId: "child-a", archivedAt: t26h.toISOString() })] });
			assert.strictEqual(res.pinsUnknown, true, `${c.label}: pinsUnknown`);
			assert.strictEqual(res.archived.length, 0, `${c.label}: nothing archived`);
			assert.ok(existsSync(jsonl), `${c.label}: jsonl retained`);
			assert.match(res.errors.join("\n"), /pin state unknown/, `${c.label}: error recorded`);
		});
	}
});

check("pin state: unreadable `pinnedAt` entries are treated as pinned (preserved)", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const a = makeChildFile(dir, "child-a", "parent-gc-001", t30h);
		const b = makeChildFile(dir, "child-b", "parent-gc-001", t30h);
		const c = makeChildFile(dir, "child-c", "parent-gc-001", t30h);
		writePinState(root, {
			version: 1,
			sessions: {
				"child-a": { pinnedAt: "not-a-number" },
				"child-b": { pinnedAt: null },
			},
		});
		const res = runGc(root, {
			tasks: ["a", "b", "c"].map(sid => task({ id: `W-${sid}`, sessionId: `child-${sid}`, archivedAt: t30h.toISOString() })),
		});
		assert.strictEqual(res.pinsUnknown, false);
		assert.strictEqual(res.skippedPinned, 2, "both uncertain entries must count as pinned");
		assert.deepStrictEqual(res.archived.map(x => x.sessionId), ["child-c"], "only the provably unpinned child is archived");
		assert.ok(existsSync(a) && existsSync(b), "uncertain/pinned sessions preserved");
		assert.strictEqual(existsSync(c), false, "unpinned child moved");
		assert.match(res.warnings.join("\n"), /treated as PINNED/);
	});
});

check("pin state: missing file is a known-empty state (GC still works)", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const res = runGc(root, { tasks: [task({ id: "W-1", sessionId: "child-a", archivedAt: t26h.toISOString() })] });
		assert.strictEqual(res.pinsUnknown, false);
		assert.strictEqual(res.archived.length, 1, "no pin state ⇒ nothing is pinned ⇒ archive proceeds");
		assert.strictEqual(existsSync(jsonl), false);
	});
});

check("pin state: loadPinnedSessionIds contract (ok / unknown / uncertain)", () => {
	withRoot((root) => {
		const missing = loadPinnedSessionIds(root);
		assert.deepStrictEqual(missing.ok, true);
		writePinState(root, "{oops");
		assert.strictEqual(loadPinnedSessionIds(root).ok, false);
		writePinState(root, { version: 1, sessions: { s1: { pinnedAt: 5 }, s2: { archivedAt: 5 }, s3: { pinnedAt: "x" } } });
		const st = loadPinnedSessionIds(root);
		assert.strictEqual(st.ok, true);
		if (!st.ok) throw new Error("unreachable");
		assert.ok(st.pinned.has("s1"));
		assert.ok(!st.pinned.has("s2"), "archived-only entry is not pinned");
		assert.ok(st.pinned.has("s3"), "uncertain entry treated as pinned");
		assert.deepStrictEqual(st.uncertain, ["s3"]);
		// A symlink to a VALID state file resolves normally (only unreadable links fail closed).
		const realState = join(root, "real-state.json");
		writeFileSync(realState, JSON.stringify({ version: 1, sessions: { s9: { pinnedAt: 7 } } }));
		rmSync(join(root, "pi-web-session-state.json"), { force: true });
		symlinkSync(realState, join(root, "pi-web-session-state.json"));
		const linked = loadPinnedSessionIds(root);
		assert.strictEqual(linked.ok, true);
		if (linked.ok) assert.ok(linked.pinned.has("s9"), "symlinked-but-readable pin state is honoured");
	});
});

check("DEFECT-1 pin state: dangling symlink is UNKNOWN, not known-empty (fail closed)", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		// lstat() sees the dangling link; a bare `existsSync` check would read it as "no pin state".
		symlinkSync(join(root, "missing-pin-state.json"), join(root, "pi-web-session-state.json"));
		const st = loadPinnedSessionIds(root);
		assert.strictEqual(st.ok, false, "unreadable pin state must never read as known-empty");
		const res = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(res.pinsUnknown, true, "GC must fail closed");
		assert.strictEqual(res.archived.length, 0);
		assert.strictEqual(res.totalBytesFreed, 0);
		assert.ok(existsSync(jsonl), "jsonl preserved");
		assert.ok(existsSync(`${jsonl}.acp.json`), "sidecar preserved");
		assert.ok(!existsSync(join(root, "sessions-archive")), "nothing archived");
		assert.match(res.errors.join("\n"), /pin state unreadable/);
	});
});

check("DEFECT-1 pin state: a state path that is a directory is UNKNOWN (fail closed)", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		mkdirSync(join(root, "pi-web-session-state.json"), { recursive: true });
		const st = loadPinnedSessionIds(root);
		assert.strictEqual(st.ok, false, "a directory in place of the state file is unreadable");
		const res = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(res.pinsUnknown, true);
		assert.strictEqual(res.archived.length, 0);
		assert.ok(existsSync(jsonl));
	});
});

check("collision: existing archive entry is preserved and the new pair lands in a ~2 slot", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const jsonlBody = readFileSync(jsonl);
		const acpBody = readFileSync(acp);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const archDir = join(root, "sessions-archive", WS);
		mkdirSync(archDir, { recursive: true });
		writeFileSync(join(archDir, base), "PRIOR-ARCHIVE-JSONL");
		writeFileSync(join(archDir, `${base}.acp.json`), "PRIOR-ARCHIVE-ACP");
		const res = runGc(root, { tasks: [task({ id: "W-1", sessionId: "child-a", archivedAt: t26h.toISOString() })] });
		const stem = `${TS_PREFIX}_child-a`;
		assert.deepStrictEqual(
			listArchive(root),
			[`${stem}~2.jsonl`, `${stem}~2.jsonl.acp.json`, `${stem}.jsonl`, `${stem}.jsonl.acp.json`].sort(),
			"new pair must use the ~2 slot and leave the prior entry untouched",
		);
		assert.deepStrictEqual(readFileSync(join(archDir, base)), Buffer.from("PRIOR-ARCHIVE-JSONL"), "prior archive jsonl unchanged");
		assert.deepStrictEqual(readFileSync(join(archDir, `${base}.acp.json`)), Buffer.from("PRIOR-ARCHIVE-ACP"), "prior archive sidecar unchanged");
		assert.deepStrictEqual(readFileSync(archivePath(root, `${stem}~2.jsonl`)), jsonlBody, "moved jsonl content identical");
		assert.deepStrictEqual(readFileSync(archivePath(root, `${stem}~2.jsonl.acp.json`)), acpBody, "moved sidecar content identical");
		assert.strictEqual(res.archived.length, 1);
		assert.strictEqual(res.archived[0]?.archiveFile, archivePath(root, `${stem}~2.jsonl`));
		assert.strictEqual(res.archived[0]?.acpArchiveFile, archivePath(root, `${stem}~2.jsonl.acp.json`));
		assert.strictEqual(existsSync(jsonl), false);
		assert.strictEqual(existsSync(acp), false);
	});
});

check("collision: occupied slot with only a main file is skipped (no overwrite, no sidecar duplication)", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const archDir = join(root, "sessions-archive", WS);
		mkdirSync(archDir, { recursive: true });
		writeFileSync(join(archDir, base), "PRIOR-MAIN-ONLY");
		const res = runGc(root, { tasks: [task({ id: "W-1", sessionId: "child-a", archivedAt: t26h.toISOString() })] });
		assert.strictEqual(res.archived.length, 1);
		assert.strictEqual(res.archived[0]?.archiveFile, archivePath(root, `${TS_PREFIX}_child-a~2.jsonl`));
		assert.strictEqual(readFileSync(join(archDir, base), "utf8"), "PRIOR-MAIN-ONLY", "prior main preserved");
		assert.ok(existsSync(archivePath(root, `${TS_PREFIX}_child-a~2.jsonl.acp.json`)), "sidecar moved into the same slot as its jsonl");
		assert.strictEqual(existsSync(jsonl), false);
	});
});

check("DEFECT-3 orphan sidecar without provenance: preserved untouched AND the pair is never split", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		// Source has NO sidecar: an earlier run may have moved it, but the filename alone does not
		// prove the archived remnant belongs to this session (an unrelated pair can derive the same
		// `<ts>_<sid>` name). It must NEVER be adopted — and because it may be this session's own
		// stranded sidecar, the jsonl must not be archived away from it either.
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h, false);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const archDir = join(root, "sessions-archive", WS);
		mkdirSync(archDir, { recursive: true });
		writeFileSync(join(archDir, `${base}.acp.json`), "UNRELATED-SIDECAR");
		const res = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(res.archived.length, 0, "an unproven same-stem sidecar must not be archived around");
		assert.strictEqual(res.partials.length, 1, "the ambiguous pair is reported, not silently skipped");
		const p = res.partials[0]!;
		assert.strictEqual(p.reason, "ambiguous-interrupted-pair");
		assert.deepStrictEqual(p.filesInArchive, [join(archDir, `${base}.acp.json`)], "receipt names the remnant actually on disk");
		assert.deepStrictEqual(p.filesRetainedInPlace, [jsonl], "pair retained in place, nothing moved");
		assert.strictEqual(res.skippedAmbiguousPair, 1);
		assert.deepStrictEqual(listArchive(root), [`${base}.acp.json`], "nothing added: the pair never moved");
		assert.strictEqual(readFileSync(join(archDir, `${base}.acp.json`), "utf8"), "UNRELATED-SIDECAR", "unrelated sidecar bytes untouched");
		assert.ok(existsSync(jsonl), "jsonl still under sessions/");
		assert.ok(!existsSync(archivePath(root, `${TS_PREFIX}_child-a~2.jsonl`)), "no ~2 entry was created");
		assert.match(res.errors.join("\n"), /ambiguous interrupted pair/);
		assert.match(res.warnings.join("\n"), /orphan sidecar without its jsonl \(provenance unknown/);
		// A second pass must reach the same verdict: no slow drift into completion.
		const second = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(second.archived.length, 0);
		assert.strictEqual(second.skippedAmbiguousPair, 1);
		assert.ok(existsSync(jsonl));
	});
});

check("DEFECT-3 own sidecar still archives next to an unrelated orphan (association kept)", () => {
	// Companion of the check above: with a sidecar of its own the pair is provably whole, so the session
	// archives into ~2 and the unrelated remnant stays untouched.
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const archDir = join(root, "sessions-archive", WS);
		mkdirSync(archDir, { recursive: true });
		writeFileSync(join(archDir, `${base}.acp.json`), "UNRELATED-SIDECAR");
		const res = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(res.archived.length, 1);
		assert.strictEqual(res.archived[0]?.archiveFile, archivePath(root, `${TS_PREFIX}_child-a~2.jsonl`));
		assert.strictEqual(res.archived[0]?.acpArchiveFile, archivePath(root, `${TS_PREFIX}_child-a~2.jsonl.acp.json`), "the session's OWN sidecar travels with its jsonl");
		assert.strictEqual(res.archived[0]?.sidecarStaged, false, "no coincidence-based adoption");
		assert.strictEqual(readFileSync(join(archDir, `${base}.acp.json`), "utf8"), "UNRELATED-SIDECAR", "unrelated remnant preserved");
		assert.strictEqual(existsSync(jsonl), false);
		assert.strictEqual(existsSync(`${jsonl}.acp.json`), false);
	});
});

check("interrupted pair: a source sidecar never overwrites a staged remnant (moves to ~2)", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const archDir = join(root, "sessions-archive", WS);
		mkdirSync(archDir, { recursive: true });
		writeFileSync(join(archDir, `${base}.acp.json`), "OLD-STAGED-ACP");
		const res = runGc(root, { tasks: [task({ id: "W-1", sessionId: "child-a", archivedAt: t26h.toISOString() })] });
		assert.strictEqual(res.archived.length, 1);
		assert.strictEqual(res.archived[0]?.archiveFile, archivePath(root, `${TS_PREFIX}_child-a~2.jsonl`));
		assert.strictEqual(readFileSync(join(archDir, `${base}.acp.json`), "utf8"), "OLD-STAGED-ACP", "remnant preserved");
		assert.strictEqual(res.archived[0]?.sidecarStaged, false);
		assert.strictEqual(existsSync(acp), false, "source sidecar moved into the ~2 slot");
	});
});

check("interrupted link-then-unlink (sidecar already staged): completing drops the duplicate source link", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h, false);
		const ino = lstatSync(jsonl).ino;
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const archDir = join(root, "sessions-archive", WS);
		mkdirSync(archDir, { recursive: true });
		linkSync(jsonl, join(archDir, base));
		writeFileSync(join(archDir, `${base}.acp.json`), "STAGED-ACP");
		const res = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(res.archived.length, 1);
		assert.strictEqual(res.archived[0]?.archiveFile, archivePath(root, base));
		assert.strictEqual(res.archived[0]?.sidecarStaged, true);
		assert.deepStrictEqual(listArchive(root), [`${base}.acp.json`, base].sort(), "no duplicate ~2 entry");
		assert.strictEqual(lstatSync(archivePath(root, base)).ino, ino, "same inode kept, no re-copy");
		assert.strictEqual(existsSync(jsonl), false, "the interrupted link is completed, not duplicated");
		assert.strictEqual(readFileSync(join(archDir, `${base}.acp.json`), "utf8"), "STAGED-ACP");
	});
});

check("interrupted link only (sidecar still at source): sidecar joins the linked slot", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const acpBody = readFileSync(acp);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const archDir = join(root, "sessions-archive", WS);
		mkdirSync(archDir, { recursive: true });
		linkSync(jsonl, join(archDir, base));
		const res = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(res.archived.length, 1);
		assert.strictEqual(res.partials.length, 0);
		assert.deepStrictEqual(listArchive(root), [`${base}.acp.json`, base].sort(), "sidecar joins the linked jsonl slot");
		assert.deepStrictEqual(readFileSync(join(archDir, `${base}.acp.json`)), acpBody);
		assert.strictEqual(existsSync(jsonl), false);
		assert.strictEqual(existsSync(acp), false);
	});
});

check("interrupted link + staged sidecar + source sidecar: ambiguous slot is never clobbered", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const archDir = join(root, "sessions-archive", WS);
		mkdirSync(archDir, { recursive: true });
		linkSync(jsonl, join(archDir, base));
		writeFileSync(join(archDir, `${base}.acp.json`), "STAGED-ACP");
		const res = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(res.archived.length, 1);
		assert.strictEqual(res.archived[0]?.archiveFile, archivePath(root, `${TS_PREFIX}_child-a~2.jsonl`), "ambiguous slot ⇒ next slot");
		assert.strictEqual(readFileSync(join(archDir, `${base}.acp.json`), "utf8"), "STAGED-ACP", "staged sidecar preserved");
		assert.ok(existsSync(archivePath(root, `${TS_PREFIX}_child-a~2.jsonl.acp.json`)), "source sidecar kept with its own entry");
		assert.strictEqual(existsSync(jsonl), false, "source jsonl consumed");
		assert.ok(existsSync(archivePath(root, base)), "linked entry preserved");
	});
});

check("moveFileNoClobber refuses to overwrite an existing destination (EEXIST)", () => {
	withRoot((root) => {
		const src = join(root, "src.jsonl");
		const dst = join(root, "dst.jsonl");
		writeFileSync(src, "NEW");
		writeFileSync(dst, "OLD");
		let code: string | undefined;
		try {
			moveFileNoClobber(src, dst, false);
		} catch (err) {
			code = (err as NodeJS.ErrnoException).code;
		}
		assert.strictEqual(code, "EEXIST", "link(2) must fail with EEXIST instead of clobbering");
		assert.strictEqual(readFileSync(dst, "utf8"), "OLD");
		assert.strictEqual(readFileSync(src, "utf8"), "NEW", "source untouched");
		// forceCopy path must refuse too (COPYFILE_EXCL)
		let copyCode: string | undefined;
		try {
			moveFileNoClobber(src, dst, true);
		} catch (err) {
			copyCode = (err as NodeJS.ErrnoException).code;
		}
		assert.strictEqual(copyCode, "EEXIST", "COPYFILE_EXCL must refuse an existing destination");
		assert.strictEqual(readFileSync(dst, "utf8"), "OLD");
	});
});

// ---------------------------------------------------------------- 3. pair movement recoverability

/**
 * Create something at `<jsonl>.acp.json` exactly once, immediately BEFORE the jsonl archive move,
 * i.e. after discovery already scanned the directory (the post-scan sidecar race).
 */
function lateSidecarInjector(make: (acpPath: string) => void): (op: GcMoveOp) => "fail" | "copy" | undefined {
	let fired = false;
	return (op: GcMoveOp) => {
		if (!fired && op.kind === "jsonl" && op.phase === "archive") {
			fired = true;
			make(`${op.src}.acp.json`);
		}
		return undefined;
	};
}

check("sidecar failure: nothing moves, the pair stays intact in sessions/", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const res = runGc(root, {
			tasks: TASKS_A,
			__moveFault: (op: GcMoveOp) => (op.kind === "acp" && op.phase === "archive" ? "fail" : undefined),
		});
		assert.strictEqual(res.archived.length, 0, "a failed sidecar must never be reported as archived");
		assert.strictEqual(res.partials.length, 0, "nothing was moved, so no partial receipt");
		assert.strictEqual(res.skippedMoveError, 1);
		assert.strictEqual(res.totalBytesFreed, 0);
		assert.ok(existsSync(jsonl), "jsonl retained");
		assert.ok(existsSync(acp), "sidecar retained");
		assert.match(res.errors.join("\n"), /child-a\.acp\.json: injected move failure \(acp\/archive\); pair intact/);
		assert.deepStrictEqual(listArchive(root), [], "archive stays empty");
	});
});

check("DEFECT-2 late regular sidecar (appears after discovery) is adopted ⇒ pair whole, nothing left", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h, false);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const res = runGc(root, {
			tasks: TASKS_A,
			__moveFault: lateSidecarInjector((p) => writeFileSync(p, "LATE-ACP")),
		});
		assert.strictEqual(res.partials.length, 0, "a whole pair is never a partial receipt");
		assert.strictEqual(res.archived.length, 1);
		assert.strictEqual(res.archived[0]?.acpArchiveFile, archivePath(root, `${base}.acp.json`));
		assert.strictEqual(existsSync(jsonl), false);
		assert.strictEqual(existsSync(`${jsonl}.acp.json`), false, "nothing remains under sessions/");
		assert.strictEqual(readFileSync(archivePath(root, `${base}.acp.json`), "utf8"), "LATE-ACP");
	});
});

check("DEFECT-2 late anomalous sidecar (directory) ⇒ partial receipt, never full completion", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h, false);
		const acpPath = `${jsonl}.acp.json`;
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const res = runGc(root, {
			tasks: TASKS_A,
			__moveFault: lateSidecarInjector((p) => {
				mkdirSync(p, { recursive: true });
				writeFileSync(join(p, "evidence.txt"), "user-evidence");
			}),
		});
		assert.strictEqual(res.archived.length, 0, "a split pair must never be reported as archived");
		assert.strictEqual(res.partials.length, 1);
		const partial = res.partials[0]!;
		assert.deepStrictEqual(partial.filesInArchive, [archivePath(root, base)]);
		assert.deepStrictEqual(partial.filesRetainedInPlace, [acpPath]);
		assert.ok(existsSync(join(acpPath, "evidence.txt")), "anomalous evidence retained");
		assert.match(res.errors.join("\n"), /session evidence still present under sessions\//);
	});
});

check("DEFECT-2 late recreated sidecar (symlink) ⇒ partial receipt, symlink retained", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h, false);
		const acpPath = `${jsonl}.acp.json`;
		const target = join(root, "target-acp.json");
		writeFileSync(target, "TARGET");
		const res = runGc(root, {
			tasks: TASKS_A,
			__moveFault: lateSidecarInjector((p) => symlinkSync(target, p)),
		});
		assert.strictEqual(res.archived.length, 0);
		assert.strictEqual(res.partials.length, 1);
		assert.deepStrictEqual(res.partials[0]?.filesRetainedInPlace, [acpPath]);
		assert.ok(lstatSync(acpPath).isSymbolicLink(), "the recreated symlink is left untouched");
		assert.strictEqual(readFileSync(target, "utf8"), "TARGET");
	});
});

check("jsonl failure after the sidecar moved: rollback restores the pair", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const acpBody = readFileSync(acp);
		const res = runGc(root, {
			tasks: TASKS_A,
			__moveFault: (op: GcMoveOp) => (op.kind === "jsonl" && op.phase === "archive" ? "fail" : undefined),
		});
		assert.strictEqual(res.archived.length, 0);
		assert.strictEqual(res.partials.length, 0, "successful rollback ⇒ no partial receipt");
		assert.strictEqual(res.skippedMoveError, 1);
		assert.ok(existsSync(jsonl), "jsonl retained");
		assert.ok(existsSync(acp), "sidecar rolled back to its original path");
		assert.deepStrictEqual(readFileSync(acp), acpBody, "rolled-back sidecar content intact");
		assert.deepStrictEqual(listArchive(root), [], "archive stays empty after rollback");
		assert.match(res.errors.join("\n"), /jsonl move failed/);
	});
});

check("rollback failure: truthful partial receipt, never counted as archived", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const acpBody = readFileSync(acp);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const res = runGc(root, {
			tasks: TASKS_A,
			__moveFault: (op: GcMoveOp) => {
				if (op.kind === "jsonl" && op.phase === "archive") return "fail";
				if (op.kind === "acp" && op.phase === "rollback") return "fail";
				return undefined;
			},
		});
		assert.strictEqual(res.archived.length, 0, "split pair must not be reported as archived");
		assert.strictEqual(res.partials.length, 1, "exactly one partial receipt");
		const p = res.partials[0];
		if (!p) throw new Error("missing partial receipt");
		assert.strictEqual(p.sessionId, "child-a");
		assert.deepStrictEqual(p.filesInArchive, [archivePath(root, `${base}.acp.json`)], "receipt names the archived sidecar");
		assert.deepStrictEqual(p.filesRetainedInPlace, [jsonl], "receipt names the retained jsonl");
		assert.strictEqual(p.rollback, "failed");
		assert.ok(existsSync(jsonl), "jsonl retained in place");
		assert.strictEqual(existsSync(acp), false, "sidecar is the one that stayed in the archive");
		assert.ok(existsSync(archivePath(root, `${base}.acp.json`)));
		assert.strictEqual(res.totalBytesFreed, 0);
		assert.match(res.errors.join("\n"), /rollback of .* failed/);

		// SECOND GC PASS over exactly the state a failed rollback leaves: the sidecar is in the archive
		// and the jsonl is still in sessions/. Nothing proves the archived sidecar is this session's
		// own, so the pair must stay incomplete — completing it would archive the jsonl away from its
		// only sidecar and record `acpArchiveFile: null` for a session that has one.
		const second = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(second.archived.length, 0, "an ambiguous interrupted pair must never complete");
		assert.strictEqual(second.partials.length, 1, "the second pass reports the ambiguity");
		const p2 = second.partials[0];
		if (!p2) throw new Error("missing second-pass receipt");
		assert.strictEqual(p2.reason, "ambiguous-interrupted-pair");
		assert.strictEqual(second.skippedAmbiguousPair, 1);
		assert.deepStrictEqual(p2.filesInArchive, [archivePath(root, `${base}.acp.json`)], "association to the archived sidecar is kept");
		assert.deepStrictEqual(p2.filesRetainedInPlace, [jsonl]);
		assert.strictEqual(second.totalBytesFreed, 0);
		assert.deepStrictEqual(listArchive(root), [`${base}.acp.json`], "no jsonl was archived and no ~2 duplicate appeared");
		assert.deepStrictEqual(readFileSync(archivePath(root, `${base}.acp.json`)), acpBody, "the stranded sidecar is byte-identical");
		assert.ok(existsSync(jsonl), "jsonl still in sessions/");
		assert.match(second.errors.join("\n"), /ambiguous interrupted pair/);

		// Third pass is stable: the deferral is idempotent, never a slow drift into completion.
		const third = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(third.archived.length, 0);
		assert.strictEqual(third.skippedAmbiguousPair, 1);
		assert.ok(existsSync(jsonl));
	});
});

/** All decisions the TEST-ONLY `__moveFault` seam can return (mirrors `ChildGcOptions`). */
type MoveFaultDecision = "fail" | "copy" | "copy-then-fail" | "link-then-fail" | undefined;

/**
 * Fault plan that reproduces a move whose copy completed and whose source unlink then failed, i.e.
 * the destination is fully written while the source is still in place (see the TEST-ONLY
 * `copy-then-fail` seam). Extra faults are layered on top per fixture.
 */
function postCopyJsonlFailure(
	extra: (op: GcMoveOp) => MoveFaultDecision = () => undefined,
): (op: GcMoveOp) => MoveFaultDecision {
	return (op: GcMoveOp) => {
		if (op.kind === "jsonl" && op.phase === "archive") return "copy-then-fail";
		return extra(op);
	};
}

check("DEFECT-5 post-copy/source-unlink failure + rollback success: the created destination is discarded", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const jsonlBody = readFileSync(jsonl);
		const acpBody = readFileSync(acp);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const res = runGc(root, { tasks: TASKS_A, __moveFault: postCopyJsonlFailure() });
		assert.strictEqual(res.archived.length, 0);
		assert.strictEqual(res.partials.length, 0, "rollback restored the pair and the half-move was discarded ⇒ archive is empty");
		assert.strictEqual(res.skippedMoveError, 1);
		assert.deepStrictEqual(listArchive(root), [], "the destination created by the failed move is gone, not orphaned");
		assert.deepStrictEqual(readFileSync(jsonl), jsonlBody, "jsonl intact in sessions/");
		assert.deepStrictEqual(readFileSync(acp), acpBody, "sidecar rolled back intact");
		assert.match(res.errors.join("\n"), /jsonl move failed/);
		// The next pass archives the pair normally: nothing was lost or duplicated.
		const second = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(second.archived.length, 1);
		assert.deepStrictEqual(readFileSync(archivePath(root, base)), jsonlBody);
		assert.deepStrictEqual(readFileSync(archivePath(root, `${base}.acp.json`)), acpBody);
		assert.deepStrictEqual(listArchive(root), [`${base}.acp.json`, base].sort(), "exactly one slot, no duplicate");
	});
});

check("DEFECT-5 post-copy/source-unlink failure + rollback failure: the receipt never omits an archived file", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const acpArchive = archivePath(root, `${base}.acp.json`);
		const jsonlArchive = archivePath(root, base);
		const res = runGc(root, {
			tasks: TASKS_A,
			__moveFault: postCopyJsonlFailure(op => (op.kind === "acp" && op.phase === "rollback" ? "fail" : undefined)),
		});
		assert.strictEqual(res.archived.length, 0, "a split pair is never archived");
		assert.strictEqual(res.partials.length, 1);
		const p = res.partials[0];
		if (!p) throw new Error("missing partial receipt");
		assert.strictEqual(p.rollback, "failed");
		assert.strictEqual(p.reason, "move-failed");
		assert.deepStrictEqual(p.filesInArchive, [acpArchive], "the stranded sidecar is named");
		assert.deepStrictEqual(p.filesRetainedInPlace, [jsonl], "the jsonl is named as retained");
		assert.deepStrictEqual(listArchive(root), [`${base}.acp.json`], "no half-move entry survives the discard");
		assert.strictEqual(res.totalBytesFreed, 0);
	});
});

check("DEFECT-5 undiscardable destination: receipt names BOTH archived files, and no later pass completes falsely", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const acpArchive = archivePath(root, `${base}.acp.json`);
		const jsonlArchive = archivePath(root, base);
		const res = runGc(root, {
			tasks: TASKS_A,
			__moveFault: postCopyJsonlFailure((op) => {
				if (op.kind === "acp" && op.phase === "rollback") return "fail";
				// The discard of the destination created by the failed move fails too: the entry stays.
				if (op.kind === "jsonl" && op.phase === "discard-failed-dest") return "fail";
				return undefined;
			}),
		});
		assert.strictEqual(res.archived.length, 0, "never archived while the pair is split");
		assert.strictEqual(res.partials.length, 1);
		const p = res.partials[0];
		if (!p) throw new Error("missing partial receipt");
		assert.deepStrictEqual(
			p.filesInArchive,
			[acpArchive, jsonlArchive],
			"receipt must name the archived JSONL created by the failed move, not just the sidecar",
		);
		assert.deepStrictEqual(p.filesRetainedInPlace, [jsonl]);
		assert.strictEqual(p.rollback, "failed");
		assert.ok(existsSync(jsonlArchive) && existsSync(acpArchive), "receipt matches what is really in the archive");
		assert.match(res.warnings.join("\n"), /could not be removed from the archive/);

		// Second pass: the archive already holds a same-stem sidecar of unprovable provenance ⇒ the pair
		// must stay incomplete, and the receipt must keep naming both archived files.
		const second = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(second.archived.length, 0, "no false completion on a later pass");
		assert.strictEqual(second.skippedAmbiguousPair, 1);
		assert.strictEqual(second.partials.length, 1);
		const p2 = second.partials[0];
		if (!p2) throw new Error("missing second-pass receipt");
		assert.strictEqual(p2.reason, "ambiguous-interrupted-pair");
		assert.deepStrictEqual(p2.filesInArchive, [acpArchive, jsonlArchive], "no lost association: both archived files stay named");
		assert.deepStrictEqual(p2.filesRetainedInPlace, [jsonl]);
		assert.deepStrictEqual(listArchive(root), [`${base}.acp.json`, base].sort(), "archive unchanged by the second pass");
		assert.ok(existsSync(jsonl), "jsonl still in sessions/");
	});
});

check("DEFECT-5 verified receipt: a claimed archive sidecar that is missing is a partial, not a completion", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const acpArchive = archivePath(root, `${base}.acp.json`);
		const res = runGc(root, {
			tasks: TASKS_A,
			// The source sidecar is moved first; here it vanishes from the archive before the jsonl move.
			__moveFault: (op: GcMoveOp) => {
				if (op.kind === "jsonl" && op.phase === "archive") rmSync(acpArchive, { force: true });
				return undefined;
			},
		});
		assert.strictEqual(res.archived.length, 0, "a receipt may never claim a sidecar that is not there");
		assert.strictEqual(res.partials.length, 1);
		const p = res.partials[0];
		if (!p) throw new Error("missing partial receipt");
		assert.strictEqual(p.reason, "split-pair");
		assert.deepStrictEqual(p.filesInArchive, [archivePath(root, base)], "only the file that really exists is claimed");
		assert.deepStrictEqual(p.filesRetainedInPlace, [], "nothing of the session is left under sessions/");
		assert.match(res.errors.join("\n"), /claimed archive sidecar .* is missing/);
	});
});

check("DEFECT-5 same-stem sidecar appearing DURING the move: post-move gate refuses to call it archived", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h, false);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const acpArchive = archivePath(root, `${base}.acp.json`);
		const jsonlArchive = archivePath(root, base);
		const res = runGc(root, {
			tasks: TASKS_A,
			// A same-stem sidecar lands in the archive AFTER the pre-flight gate saw nothing: the pair may
			// now be split, so the completion gate must refuse and name both archived files.
			__moveFault: (op: GcMoveOp) => {
				if (op.kind === "jsonl" && op.phase === "archive" && !existsSync(acpArchive)) {
					writeFileSync(acpArchive, "RACED-ACP");
				}
				return undefined;
			},
		});
		assert.strictEqual(res.archived.length, 0, "no completion while a same-stem sidecar is unaccounted for");
		assert.strictEqual(res.partials.length, 1);
		const p = res.partials[0];
		if (!p) throw new Error("missing partial receipt");
		assert.strictEqual(p.reason, "ambiguous-interrupted-pair");
		assert.deepStrictEqual(p.filesInArchive, [jsonlArchive, acpArchive], "receipt names both archived files");
		assert.deepStrictEqual(p.filesRetainedInPlace, [], "the jsonl did move; only the association is unproven");
		assert.strictEqual(readFileSync(acpArchive, "utf8"), "RACED-ACP", "the raced sidecar is untouched");
		assert.match(res.errors.join("\n"), /ambiguous interrupted pair/);
	});
});

check("EXDEV/copy fallback: pair archived byte-identically through the copy path", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const jsonlBody = readFileSync(jsonl);
		const acpBody = readFileSync(acp);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const res = runGc(root, { tasks: TASKS_A, __moveFault: () => "copy" });
		assert.strictEqual(res.archived.length, 1, "copy fallback must complete the pair");
		assert.strictEqual(res.partials.length, 0);
		assert.strictEqual(res.errors.length, 0);
		assert.deepStrictEqual(readFileSync(archivePath(root, base)), jsonlBody);
		assert.deepStrictEqual(readFileSync(archivePath(root, `${base}.acp.json`)), acpBody);
		assert.strictEqual(existsSync(jsonl), false, "source unlinked only after verified copy");
		assert.strictEqual(existsSync(acp), false);
	});
});

check("byte accounting: totalBytesFreed equals jsonl + sidecar sizes", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const expected = readFileSync(jsonl).length + readFileSync(acp).length;
		const res = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(res.archived.length, 1);
		assert.strictEqual(res.archived[0]?.bytes, expected);
		assert.strictEqual(res.totalBytesFreed, expected);
	});
});

// ---------------------------------------------------------------- 4. indexed bounded discovery

check("discovery: single indexed pass reports scannedFiles and finds all workspaces", () => {
	withRoot((root) => {
		const wsNames = ["ws-a", "ws-b", "ws-c", "ws-d"];
		for (const ws of wsNames) {
			const dir = sessionsDirOf(root, ws);
			for (let n = 0; n < 10; n++) {
				makeChildFile(dir, `child-${ws}-${n}`, n === 0 ? "other-parent" : "parent-gc-001", n % 2 === 0 ? t26h : t3h);
			}
		}
		// A symlinked workspace directory must be ignored (no traversal outside sessions/).
		const outside = join(root, "outside-ws");
		mkdirSync(outside, { recursive: true });
		makeChildFile(outside, "child-outside", "parent-gc-001", t26h);
		symlinkSync(outside, join(root, "sessions", "ws-symlink"), "dir");
		// 200 ledger ids that exist nowhere on disk: the indexed lookup must not rescan the tree.
		const ghostTasks = Array.from({ length: 200 }, (_, i) =>
			task({ id: `W-ghost-${i}`, status: "running", sessionId: `ghost-session-${i}` }));
		const res = runGc(root, { tasks: ghostTasks });
		assert.strictEqual(res.scannedFiles, 40, "exactly the 40 real .jsonl files indexed");
		assert.strictEqual(res.scannedEntries, 85, "every encountered entry counted once (5 root + 4 × (10 jsonl + 10 acp))");
		assert.strictEqual(res.discoveryTruncated, false);
		assert.strictEqual(res.totalMatched, 36, "36 children of parent-gc-001 (4 foreign-parent files + the symlinked workspace)");
		assert.strictEqual(res.archived.length, 16, "per workspace n=2,4,6,8 are 26h old ⇒ 4 × 4 = 16 eligible");
		assert.strictEqual(res.skippedCooldown, 20, "per workspace n=1..9 odd are only 3h old ⇒ 5 × 4 = 20 kept");
		assert.strictEqual(res.skippedUnverified, 0, "ghost ids have no file ⇒ not counted as unverified");
		assert.strictEqual(res.pinsUnknown, false);
	});
});

check("DEFECT-4 entry budget stops the walk while enumerating (not after filtering)", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const tasks = [];
		for (let i = 0; i < 10; i++) {
			makeChildFile(dir, `child-${i}`, "parent-gc-001", t26h);
			writeFileSync(join(dir, `filler-${i}.txt`), "junk");
			tasks.push(task({ id: `W-${i}`, sessionId: `child-${i}`, status: "running" }));
		}
		const before = readdirSync(dir).sort();
		assert.strictEqual(before.length, 30, "10 jsonl + 10 sidecars + 10 non-jsonl entries");
		const res = runGc(root, { tasks, __discoveryLimits: { maxEntries: 6 } });
		assert.strictEqual(res.scannedEntries, 6, "the directory walk stops at the entry budget (1 root + 5 workspace)");
		assert.strictEqual(res.discoveryTruncated, true);
		assert.ok(res.scannedFiles < 6, `jsonl files read stay strictly inside the entry budget (got ${res.scannedFiles})`);
		assert.deepStrictEqual(readdirSync(dir).sort(), before, "nothing moved: the run only read a bounded subset");
		assert.match(res.warnings.join("\n"), /discovery truncated at 6 directory entries \(budget 6\)/);
	});
});

check("DEFECT-4 budget of 2 stops before any workspace listing (nothing scanned)", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		makeChildFile(dir, "child-1", "parent-gc-001", t26h);
		writeFileSync(join(root, "sessions", "000-root-junk.txt"), "junk");
		const res = runGc(root, { tasks: [], __discoveryLimits: { maxEntries: 2 } });
		assert.strictEqual(res.scannedEntries, 2, "the root listing alone exhausts the budget");
		assert.strictEqual(res.scannedFiles, 0, "no workspace was enumerated ⇒ no jsonl read");
		assert.strictEqual(res.totalMatched, 0);
		assert.strictEqual(res.discoveryTruncated, true);
		assert.ok(existsSync(join(dir, `${TS_PREFIX}_child-1.jsonl`)), "candidate untouched");
	});
});

check("DEFECT-4 workspace budget truncates by subdirectory count", () => {
	withRoot((root) => {
		const tasks = [];
		for (const ws of ["a-ws", "b-ws", "c-ws"]) {
			const wsDir = sessionsDirOf(root, ws);
			makeChildFile(wsDir, `child-${ws}`, "parent-gc-001", t26h);
			tasks.push(task({ id: `W-${ws}`, sessionId: `child-${ws}`, status: "running" }));
		}
		const res = runGc(root, { tasks, __discoveryLimits: { maxSubdirs: 1 } });
		assert.strictEqual(res.discoveryTruncated, true);
		assert.strictEqual(res.totalMatched, 1, "only the first workspace is enumerated");
		assert.strictEqual(res.archived.length, 0);
		assert.ok(existsSync(join(sessionsDirOf(root, "b-ws"), `${TS_PREFIX}_child-b-ws.jsonl`)), "unscanned workspace untouched");
		assert.match(res.warnings.join("\n"), /discovery truncated/);
	});
});

check("discovery: foreign-parent and root files count as unverified via the index", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		makeChildFile(dir, "child-foreign", "other-parent-999", t30h);
		makeChildFile(dir, "root-session", null, t30h);
		const res = runGc(root, {
			tasks: [
				task({ id: "W-f", sessionId: "child-foreign", archivedAt: t30h.toISOString() }),
				task({ id: "W-r", sessionId: "root-session", archivedAt: t30h.toISOString() }),
			],
		});
		assert.strictEqual(res.skippedUnverified, 2);
		assert.strictEqual(res.archived.length, 0);
		assert.strictEqual(res.totalMatched, 0);
		assert.ok(existsSync(join(dir, `${TS_PREFIX}_child-foreign.jsonl`)));
		assert.ok(existsSync(join(dir, `${TS_PREFIX}_root-session.jsonl`)));
	});
});

check("discovery: ledger id with a missing file does not crash or archive", () => {
	withRoot((root) => {
		sessionsDirOf(root);
		const res = runGc(root, {
			tasks: [
				task({ id: "W-x", sessionId: "session-absent", archivedAt: t30h.toISOString() }),
				task({ id: "W-y", sessionId: "session-absent-2", archivedAt: t30h.toISOString() }),
			],
		});
		assert.strictEqual(res.totalMatched, 0);
		assert.strictEqual(res.archived.length, 0);
		assert.strictEqual(res.skippedUnverified, 0);
		assert.strictEqual(res.errors.length, 0);
	});
});

// ---------------------------------------------------------------- 5. preservation guards

check("preservation: uncertain status task keeps its session", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-u", "parent-gc-001", t30h);
		const res = runGc(root, { tasks: [task({ id: "W-u", status: "uncertain", sessionId: "child-u", dispatchedAt: t30h.toISOString() })] });
		assert.strictEqual(res.skippedActive, 1, "uncertain work is not terminal evidence");
		assert.strictEqual(res.archived.length, 0);
		assert.ok(existsSync(jsonl));
	});
});

check("historical reviewer lease: 2h-old reviewer child archived by the 1h reviewer cooldown", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-rev", "parent-gc-001", t2h);
		const recent = makeChildFile(dir, "child-rev-recent", "parent-gc-001", t3h);
		const res = runGc(root, {
			historicalLeases: [task({ id: "W-rev-old", parentTaskId: "W-old", sessionId: "child-rev", status: "done" })],
		});
		assert.deepStrictEqual(res.archived.map(a => [a.sessionId, a.kind]), [["child-rev", "reviewer"]], "historical W-rev lease ⇒ reviewer cooldown (1h)");
		assert.strictEqual(res.skippedCooldown, 1, "unreferenced child is held by the 24h worker cooldown");
		assert.strictEqual(existsSync(jsonl), false);
		assert.ok(existsSync(recent));
	});
});

check("preservation: non-regular sidecar is never moved (pair not split)", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h, false);
		mkdirSync(`${jsonl}.acp.json`, { recursive: true });
		writeFileSync(join(`${jsonl}.acp.json`, "keep.txt"), "user-evidence");
		const res = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(res.archived.length, 0);
		assert.strictEqual(res.skippedMoveError, 1);
		assert.ok(existsSync(jsonl), "jsonl retained");
		assert.ok(existsSync(join(`${jsonl}.acp.json`, "keep.txt")), "anomalous sidecar evidence retained");
		assert.match(res.warnings.join("\n"), /not a regular file/);
	});
});

check("dry-run: predicts names (incl. collision bump) and touches nothing", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const archDir = join(root, "sessions-archive", WS);
		mkdirSync(archDir, { recursive: true });
		writeFileSync(join(archDir, base), "PRIOR");
		const before = listArchive(root);
		const res = runGc(root, { tasks: TASKS_A, dryRun: true });
		assert.strictEqual(res.archived.length, 1);
		assert.strictEqual(res.archived[0]?.archiveFile, archivePath(root, `${TS_PREFIX}_child-a~2.jsonl`));
		assert.ok(existsSync(jsonl) && existsSync(acp), "dry-run must not move anything");
		assert.deepStrictEqual(listArchive(root), before, "dry-run must not create archive entries");
	});
});

check("repeated GC is idempotent and never re-archives a completed pair", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const first = runGc(root, { tasks: TASKS_A });
		const second = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(first.archived.length, 1);
		assert.strictEqual(second.archived.length, 0);
		assert.strictEqual(second.totalMatched, 0);
		assert.deepStrictEqual(listArchive(root), [`${TS_PREFIX}_child-a.jsonl`, `${TS_PREFIX}_child-a.jsonl.acp.json`].sort());
	});
});

// ---------------------------------------------------------------- 6. fail-closed stat probes & sidecar residue (D1/D2)

check("DEFECT-5 sidecar residue: a hardlink-then-fail sidecar move never deletes an unowned destination and names the fragment", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const acpArchive = archivePath(root, `${base}.acp.json`);
		const res = runGc(root, {
			tasks: TASKS_A,
			__moveFault: (op: GcMoveOp) => {
				if (op.kind === "acp" && op.phase === "archive") return "link-then-fail";
				if (op.kind === "acp" && op.phase === "discard-failed-dest") return "fail";
				return undefined;
			},
		});
		assert.strictEqual(res.archived.length, 0, "a split pair is never reported as archived");
		assert.strictEqual(res.partials.length, 1, "exactly one truthful partial receipt");
		const p = res.partials[0];
		if (!p) throw new Error("missing partial receipt");
		assert.strictEqual(p.reason, "move-failed");
		assert.strictEqual(p.rollback, "none-needed");
		assert.deepStrictEqual(p.filesInArchive, [acpArchive], "the fragment the failed move created is named, never omitted");
		assert.deepStrictEqual(p.filesRetainedInPlace, [jsonl, acp], "both original files are named as retained");
		assert.ok(existsSync(jsonl) && existsSync(acp), "the pair stays intact under sessions/");
		assert.ok(existsSync(acpArchive), "the fragment is still in the archive (never silently deleted)");
		assert.strictEqual(lstatSync(acpArchive).ino, lstatSync(acp).ino, "the fragment is the move's own link, not foreign data");
		assert.deepStrictEqual(readFileSync(acpArchive), readFileSync(acp), "the named fragment matches the sidecar byte-for-byte");
		assert.deepStrictEqual(listArchive(root), [`${base}.acp.json`], "nothing else was written to the archive");
		assert.strictEqual(res.totalBytesFreed, 0, "no bytes are claimed freed while the pair is split");
		assert.strictEqual(res.skippedMoveError, 0, "reported as a partial receipt, not a bare skip");
		assert.match(res.errors.join("\n"), /fragment remains in the archive/);
		assert.match(res.warnings.join("\n"), /could not be removed from the archive/);
	});
});

check("DEFECT-5 sidecar residue cleanup: a proven own fragment is removed, pair stays intact, the next pass archives cleanly", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const jsonlBody = readFileSync(jsonl);
		const acpBody = readFileSync(acp);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const acpArchive = archivePath(root, `${base}.acp.json`);
		const res = runGc(root, {
			tasks: TASKS_A,
			__moveFault: (op: GcMoveOp) => (op.kind === "acp" && op.phase === "archive" ? "link-then-fail" : undefined),
		});
		assert.strictEqual(res.archived.length, 0);
		assert.strictEqual(res.partials.length, 0, "a cleaned-up residue needs no partial receipt");
		assert.strictEqual(res.skippedMoveError, 1);
		assert.ok(existsSync(jsonl) && existsSync(acp), "the pair is fully intact under sessions/");
		assert.strictEqual(existsSync(acpArchive), false, "the fragment created by the failed move was removed; archive clean");
		assert.deepStrictEqual(listArchive(root), []);
		assert.strictEqual(res.totalBytesFreed, 0);
		assert.match(res.errors.join("\n"), /pair intact/);
		// Recovery: once the transient failure is over, the next pass archives the pair normally.
		const second = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(second.archived.length, 1);
		assert.deepStrictEqual(readFileSync(archivePath(root, base)), jsonlBody);
		assert.deepStrictEqual(readFileSync(acpArchive), acpBody);
		assert.deepStrictEqual(listArchive(root), [`${base}.acp.json`, base].sort(), "exactly one slot, no duplicate fragment");
	});
});

check("DEFECT-1 sidecar detection: a non-ENOENT stat error is UNKNOWN ⇒ candidate preserved, never moved", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h, false);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const res = runGc(root, {
			tasks: TASKS_A,
			// The sidecar does not exist, but its state is EIO-shaped: "absent" may only mean ENOENT.
			__statFault: (_p, phase) => (phase === "sidecar-detection" ? "fail" : undefined),
		});
		assert.strictEqual(res.archived.length, 0, "an unverifiable sidecar state must never be read as 'no sidecar'");
		assert.strictEqual(res.skippedMoveError, 1);
		assert.deepStrictEqual(listArchive(root), [], "the jsonl was not moved either");
		assert.ok(existsSync(jsonl), "the candidate is preserved in place");
		assert.strictEqual(res.totalBytesFreed, 0);
		assert.match(res.errors.join("\n"), /filesystem state could not be verified before the move/);
		// Once the path is stat-able again, the same session archives normally.
		const second = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(second.archived.length, 1);
		assert.ok(existsSync(archivePath(root, base)));
	});
});

check("DEFECT-1 completion gate: an unverifiable source state refuses completion (fail-closed partial receipt)", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const acpArchive = archivePath(root, `${base}.acp.json`);
		const jsonlArchive = archivePath(root, base);
		const res = runGc(root, {
			tasks: TASKS_A,
			__statFault: (p, phase) => (phase === "completion" && p === jsonl ? "fail" : undefined),
		});
		assert.strictEqual(res.archived.length, 0, "completion may not be claimed on unverifiable filesystem state");
		assert.strictEqual(res.partials.length, 1);
		const p = res.partials[0];
		if (!p) throw new Error("missing partial receipt");
		assert.strictEqual(p.reason, "split-pair");
		assert.deepStrictEqual(p.filesInArchive, [acpArchive, jsonlArchive], "verified archive evidence is still named");
		assert.deepStrictEqual(p.filesRetainedInPlace, [], "nothing of the session is verifiably left under sessions/");
		assert.match(res.errors.join("\n"), /could not be verified .*completion refused \(fail-closed\)/);
		assert.ok(existsSync(acpArchive) && existsSync(jsonlArchive), "the pair really is in the archive");
		assert.strictEqual(existsSync(jsonl), false);
		assert.strictEqual(res.totalBytesFreed, 0);
		// The state is readable again on the next pass, which now sees no candidate and mutates nothing.
		const second = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(second.archived.length, 0);
		assert.strictEqual(second.partials.length, 0);
		assert.strictEqual(second.totalMatched, 0);
		assert.deepStrictEqual(listArchive(root), [`${base}.acp.json`, base].sort(), "no duplicate slot on re-run");
	});
});

check("DEFECT-1 pre-move slot scan: an unverifiable same-stem state blocks the move (ambiguous deferral)", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h, false);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const slot0Jsonl = archivePath(root, base);
		const res = runGc(root, {
			tasks: TASKS_A,
			__statFault: (p, phase) => (phase === "stem-remnants" && p === slot0Jsonl ? "fail" : undefined),
		});
		assert.strictEqual(res.archived.length, 0, "an unverifiable same-stem state refuses the move (fail closed)");
		assert.strictEqual(res.skippedAmbiguousPair, 1);
		assert.strictEqual(res.partials.length, 1);
		const p = res.partials[0];
		if (!p) throw new Error("missing partial receipt");
		assert.strictEqual(p.reason, "ambiguous-interrupted-pair");
		assert.deepStrictEqual(p.filesInArchive, []);
		assert.deepStrictEqual(p.filesRetainedInPlace, [jsonl]);
		assert.match(res.errors.join("\n"), /same-stem archive state could not be verified/);
		assert.ok(existsSync(jsonl), "the candidate was preserved before any movement");
		assert.deepStrictEqual(listArchive(root), [], "nothing moved into the archive");
		assert.strictEqual(res.totalBytesFreed, 0);
	});
});

check("DEFECT-1 allocation: an unverifiable slot occupancy is skipped, never written into", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h, false);
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const bumped = `${TS_PREFIX}_child-a~2.jsonl`;
		const slot0Dest = archivePath(root, base);
		const res = runGc(root, {
			tasks: TASKS_A,
			__statFault: (p, phase) => (phase === "allocation" && p === slot0Dest ? "fail" : undefined),
		});
		assert.strictEqual(res.archived.length, 1);
		assert.strictEqual(res.archived[0]?.archiveFile, archivePath(root, bumped), "the unverifiable slot was skipped, not written into");
		assert.strictEqual(existsSync(slot0Dest), false, "nothing was created in the unverifiable slot");
		assert.strictEqual(existsSync(jsonl), false, "the move completed in the safe later slot");
		assert.deepStrictEqual(listArchive(root), [bumped], "exactly one archived file, in slot ~2");
		assert.strictEqual(res.partials.length, 0);
		assert.match(res.warnings.join("\n"), /slot occupancy could not be verified/);
	});
});

check("DEFECT-1 receipt accounting: an UNKNOWN receipt probe still yields a partial naming the fragment (never skippedMoveError)", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const jsonlArchive = archivePath(root, base);
		const res = runGc(root, {
			tasks: TASKS_A,
			// The jsonl move fails with a PROVEN same-inode link left in the archive: it is retained
			// (the next pass completes it) while the sidecar rollback succeeds.
			__moveFault: (op: GcMoveOp) => (op.kind === "jsonl" && op.phase === "archive" ? "link-then-fail" : undefined),
			// The receipt probe for the retained fragment is UNKNOWN: the path must be NAMED, not
			// filtered out — an empty archive list must still force a partial receipt.
			__statFault: (p, phase) => (phase === "receipt" && p === jsonlArchive ? "fail" : undefined),
		});
		assert.strictEqual(res.archived.length, 0, "never archived while a fragment is unresolved");
		assert.strictEqual(res.partials.length, 1, "the partial receipt must not vanish into skippedMoveError");
		const p = res.partials[0];
		if (!p) throw new Error("missing partial receipt");
		assert.strictEqual(p.reason, "move-failed");
		assert.strictEqual(p.rollback, "succeeded");
		assert.deepStrictEqual(p.filesInArchive, [], "an UNKNOWN state is never claimed as verified archive evidence");
		assert.deepStrictEqual(p.filesUnverified, [jsonlArchive], "the unresolved fragment is named explicitly");
		assert.deepStrictEqual(p.filesRetainedInPlace, [jsonl, acp], "the rolled-back pair is named as retained");
		assert.strictEqual(res.skippedMoveError, 0, "reported as a partial receipt, not a bare skip");
		assert.ok(existsSync(jsonlArchive), "the retained fragment is still on disk");
		assert.match(res.errors.join("\n"), /jsonl move failed/);
		// Recovery: once the transient stat failure is over, the next pass completes the pair.
		const second = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(second.archived.length, 1);
		assert.deepStrictEqual(listArchive(root), [`${base}.acp.json`, base].sort(), "exactly one slot; no duplicate");
	});
});

check("DEFECT-2 cleanup ownership: a foreign replacement of the failed move's fragment is never unlinked (receipt truthful)", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const acpArchive = archivePath(root, `${base}.acp.json`);
		const res = runGc(root, {
			tasks: TASKS_A,
			__moveFault: (op: GcMoveOp) => {
				if (op.kind === "acp" && op.phase === "archive") return "link-then-fail";
				if (op.kind === "acp" && op.phase === "discard-failed-dest") {
					// Simulate another process REPLACING the fragment between the failed move and the
					// cleanup retry: the historical destCreated flag no longer describes this entry.
					rmSync(acpArchive, { force: true });
					writeFileSync(acpArchive, "FOREIGN-REPLACEMENT");
				}
				return undefined;
			},
		});
		assert.strictEqual(readFileSync(acpArchive, "utf8"), "FOREIGN-REPLACEMENT", "cleanup must never unlink a foreign replacement");
		assert.strictEqual(res.archived.length, 0);
		assert.strictEqual(res.partials.length, 1, "the unresolved destination must be reported");
		const p = res.partials[0];
		if (!p) throw new Error("missing partial receipt");
		assert.strictEqual(p.reason, "move-failed");
		assert.deepStrictEqual(p.filesInArchive, [], "foreign data is never claimed as this run's fragment");
		assert.deepStrictEqual(p.filesUnverified, [acpArchive], "the unresolved path is named, not dropped");
		assert.deepStrictEqual(p.filesRetainedInPlace, [jsonl, acp], "the pair stays intact under sessions/");
		assert.strictEqual(res.skippedMoveError, 0);
		assert.match(res.warnings.join("\n"), /was not removed from the archive/);
		assert.match(res.errors.join("\n"), /unresolved archive entry remains at/);
		assert.ok(existsSync(jsonl) && existsSync(acp), "original pair untouched");
		// Recovery: the next pass leaves the foreign entry alone and archives the pair into the ~2 slot.
		const second = runGc(root, { tasks: TASKS_A });
		assert.strictEqual(second.archived.length, 1);
		assert.strictEqual(second.archived[0]?.archiveFile, archivePath(root, `${TS_PREFIX}_child-a~2.jsonl`));
		assert.strictEqual(readFileSync(acpArchive, "utf8"), "FOREIGN-REPLACEMENT", "foreign entry still preserved on the next pass");
	});
});

check("DEFECT-2 cleanup fail-closed: an UNKNOWN destination state skips the destructive cleanup (fragment preserved and named)", () => {
	withRoot((root) => {
		const dir = sessionsDirOf(root);
		const jsonl = makeChildFile(dir, "child-a", "parent-gc-001", t26h);
		const acp = `${jsonl}.acp.json`;
		const base = `${TS_PREFIX}_child-a.jsonl`;
		const jsonlArchive = archivePath(root, base);
		const res = runGc(root, {
			tasks: TASKS_A,
			// The jsonl move fails leaving a COPY in the archive; its CURRENT state at the cleanup
			// gate is UNKNOWN, so the cleanup retry must not run against it at all.
			__moveFault: (op: GcMoveOp) => (op.kind === "jsonl" && op.phase === "archive" ? "copy-then-fail" : undefined),
			__statFault: (p, phase) => (phase === "completion" && p === jsonlArchive ? "fail" : undefined),
		});
		assert.ok(existsSync(jsonlArchive), "the copy created by the failed move is preserved (never unlinked on an unverifiable state)");
		assert.deepStrictEqual(readFileSync(jsonlArchive), readFileSync(jsonl), "the preserved fragment matches the retained source");
		assert.strictEqual(res.archived.length, 0);
		assert.strictEqual(res.partials.length, 1, "the unresolved destination must be reported");
		const p = res.partials[0];
		if (!p) throw new Error("missing partial receipt");
		assert.strictEqual(p.reason, "move-failed");
		assert.deepStrictEqual(p.filesInArchive, []);
		assert.deepStrictEqual(p.filesUnverified, [jsonlArchive], "the unresolved fragment is named explicitly");
		assert.deepStrictEqual(p.filesRetainedInPlace, [jsonl, acp]);
		assert.strictEqual(res.skippedMoveError, 0);
		assert.match(res.warnings.join("\n"), /could not be verified after the failed move/);
		assert.match(res.errors.join("\n"), /jsonl move failed/);
		assert.ok(p.detail.includes(jsonlArchive), "the receipt detail names the unresolved fragment");
	});
});

// ---------------------------------------------------------------- report

const failed = checks.filter(c => !c.ok);
for (const c of checks) {
	console.log(`${c.ok ? "✓" : "✗"} ${c.name}`);
	if (!c.ok && c.detail) console.log(`    ${c.detail}`);
}
if (failed.length > 0) {
	console.error(`\n${failed.length}/${checks.length} team-gc safety checks FAILED`);
	process.exit(1);
}
console.log(`\nAll ${checks.length} team-gc safety checks passed!`);