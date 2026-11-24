/**
 * W-118 recovery safety suite: fail-closed terminal provenance, bounded reads,
 * bounded path-cache retention.
 *
 * Offline only: every fixture lives under mkdtempSync(tmpdir()) and is removed in
 * finally, including on failure. This suite never reads a live session directory,
 * never opens the host session store, never runs Pi, never stops a child, never
 * reloads the extension and never triggers GC.
 * Run: node ~/.pi/agent/team-tests/test-team-recovery-safety.ts
 */
import assert from "node:assert/strict";
import fs, {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
	readFileSync,
	chmodSync,
	realpathSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import {
	RECOVERY_MAX_PROBED_SESSIONS,
	RECOVERY_MAX_SESSION_BYTES,
	SESSION_PATH_CACHE_LIMIT,
	SESSION_PATH_CACHE_MAX_DIRS,
	SESSION_PATH_SCAN_MAX_DIRS,
	SESSION_PATH_SCAN_MAX_ENTRIES,
	SUBAGENT_META_TYPE,
	SUBAGENT_RESULT_TYPE,
	SUBAGENT_STATUS_TYPE,
	clearSessionPathCache,
	deriveRecoveredReport,
	probeAllLiveChildren,
	probeLiveChildSession,
	recoverChildReport,
	resolveChildSessionFile,
	sessionPathCacheSize,
	type RecoverChildOptions,
	type RecoveryReadResult,
	type SessionEntryLike,
	type SessionHeaderLike,
} from "../team-recovery.ts";

const PARENT = "00000000-0000-4000-8000-0000000000a1";
const CHILD = "00000000-0000-4000-8000-0000000000b2";
const FOREIGN_PARENT = "00000000-0000-4000-8000-0000000000d4";
const TIME = Date.parse("2026-01-01T00:00:00.000Z");
const REPORT = "## Report\nSynthetic fixture only; evidence verification is pending.";
const RUN = "run-mine";
const ATTEMPT = "attempt-1";

function iso(offsetSeconds: number): string {
	return new Date(TIME + offsetSeconds * 1000).toISOString();
}

function chain(drafts: SessionEntryLike[], startSeconds = 1): SessionEntryLike[] {
	return drafts.map((draft, index) => ({
		parentId: index === 0 ? null : drafts[index - 1].id,
		timestamp: iso(startSeconds + index),
		...draft,
	}));
}

function assistant(id: string, stopReason = "stop", content: unknown = [{ type: "text", text: REPORT }]): SessionEntryLike {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content,
			stopReason,
			api: "offline-fixture",
			provider: "offline-fixture",
			model: "offline-fixture",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			timestamp: TIME,
		},
	};
}

function user(id: string): SessionEntryLike {
	return { type: "message", id, message: { role: "user", content: "Synthetic request", timestamp: TIME } };
}

function marker(id: string, customType: string, status: string, data: Record<string, unknown> = {}): SessionEntryLike {
	return { type: "custom", id, customType, data: { version: 1, status, ...data } };
}

function meta(parent = PARENT): SessionEntryLike {
	return {
		type: "custom",
		id: "meta",
		customType: SUBAGENT_META_TYPE,
		data: { version: 1, parentSessionId: parent, parentToolCallId: "parent-call", profile: "bridges", description: "W-118 synthetic fixture" },
	};
}

/** Attempt that reported, was marked completed, then resumed (running again). */
function reportThenCompletedThenRunning(): SessionEntryLike[] {
	return chain([
		meta(),
		marker("running-1", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }),
		user("request"),
		assistant("report-1"),
		marker("completed-1", SUBAGENT_RESULT_TYPE, "completed", { runId: RUN }),
		marker("resumed-running", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }),
	]);
}

/** Clean reported attempt bound to this run, no newer activity. */
function reportedAttempt(runId = RUN): SessionEntryLike[] {
	return chain([
		meta(),
		marker("running-1", SUBAGENT_STATUS_TYPE, "running", { runId }),
		user("request"),
		assistant("report-1"),
	]);
}

interface Fixture {
	root: string;
	sessionsDir: string;
}

function withFixture(fn: (fixture: Fixture) => void): void {
	const root = mkdtempSync(join(tmpdir(), "team-recovery-safety-"));
	try {
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir);
		fn({ root, sessionsDir });
	} finally {
		rmSync(root, { recursive: true, force: true });
		assert.equal(existsSync(root), false, "temporary fixture directory must be removed");
	}
}

function jsonl(entries: SessionEntryLike[], header: Partial<SessionHeaderLike> = {}, sessionId = CHILD): string {
	return [
		{ type: "session", version: 3, id: sessionId, timestamp: iso(0), cwd: "/tmp/team-recovery-safety", ...header },
		...entries,
	]
		.map((entry) => JSON.stringify(entry))
		.join("\n") + "\n";
}

function putSession(
	fixture: Fixture,
	entries: SessionEntryLike[],
	options: { sessionId?: string; cwdDir?: string; filename?: string; header?: Partial<SessionHeaderLike> } = {},
): string {
	const sessionId = options.sessionId ?? CHILD;
	const dir = join(fixture.sessionsDir, options.cwdDir ?? "--fixture-cwd--");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, options.filename ?? `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
	writeFileSync(file, jsonl(entries, options.header ?? {}, sessionId), "utf8");
	return file;
}

function recover(fixture: Fixture, options: Partial<RecoverChildOptions> = {}, sessionId = CHILD): RecoveryReadResult {
	return recoverChildReport(sessionId, { parentSessionId: PARENT, nativeStatus: "interrupted", sessionsDir: fixture.sessionsDir, ...options });
}

function assertUncertain(r: { uncertain?: boolean; status: string; reason?: string }, label: string): void {
	assert.equal(r.uncertain, true, `${label}: uncertain evidence must be flagged (${r.status}: ${r.reason})`);
}

function assertNoTerminalProof(value: { terminalExitProof?: boolean; terminal?: { boundToAttempt?: boolean } }, label: string): void {
	assert.notEqual(value.terminalExitProof, true, `${label}: must not claim a terminal exit`);
	if (value.terminal && value.terminal.boundToAttempt !== true) {
		assert.equal(value.terminal.boundToAttempt, false, `${label}: unbound terminal evidence must stay unbound`);
	}
}

// ---------------------------------------------------------------------------
// A. Terminal provenance: report -> completed -> running, live, stale host
// ---------------------------------------------------------------------------

test("S01: report -> completed marker -> running marker never settles the attempt", () => {
	withFixture((fixture) => {
		putSession(fixture, reportThenCompletedThenRunning());
		const before = readFileSync(join(fixture.sessionsDir, "--fixture-cwd--", `2026-01-01T00-00-00-000Z_${CHILD}.jsonl`), "utf8");
		const probe = probeLiveChildSession(CHILD, {
			parentSessionId: PARENT,
			runId: RUN,
			dispatchedAt: iso(0),
			sessionsDir: fixture.sessionsDir,
		});
		assert.equal(probe.completed, false, `resumed child must stay reserved (${probe.status}: ${probe.reason})`);
		assert.equal(probe.failed, false);
		assert.equal(probe.cleanExit, false);
		assertUncertain(probe, "S01 probe");
		assertNoTerminalProof(probe, "S01 probe");
		assert.equal(probe.report, undefined, "no report may leak from a resumed attempt");
		const read = recover(fixture, { nativeStatus: "running", assumeStale: true, runId: RUN, reportNotBefore: iso(0) });
		assert.notEqual(read.status, "recovered");
		assert.equal(read.report, undefined);
		assertUncertain(read, "S01 read");
		assert.equal(
			readFileSync(join(fixture.sessionsDir, "--fixture-cwd--", `2026-01-01T00-00-00-000Z_${CHILD}.jsonl`), "utf8"),
			before,
			"probing must never rewrite the child session",
		);
	});
});

test("S02: a live/queued child (no terminal activity) is uncertainty, never completion", () => {
	withFixture((fixture) => {
		putSession(fixture, chain([meta(), marker("running-1", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }), user("request")]));
		const probe = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(probe.completed, false);
		assert.equal(probe.failed, false);
		assert.equal(probe.status, "no-final-report");
		assertUncertain(probe, "S02 probe");
		const read = recover(fixture, { nativeStatus: "running", runId: RUN, reportNotBefore: iso(0) });
		assert.equal(read.status, "native-running");
		assert.equal(read.report, undefined);
		assertUncertain(read, "S02 read");
	});
});

test("S03: a stale host 'completed' with no attempt window is attributable to the host, never terminal proof", () => {
	const entries = reportedAttempt();
	const derived = deriveRecoveredReport(entries, { sessionId: CHILD, file: "/tmp/offline-fixture.jsonl", nativeStatus: "completed" });
	assert.equal(derived.status, "native-completed");
	assert.equal(derived.terminal?.kind, "host-status");
	assert.equal(derived.terminal?.boundToAttempt, false, "no attempt window was supplied; a host status cannot bind an attempt");
	assert.equal(derived.terminal?.clean, false);
	assert.notEqual(derived.cleanExit, true, "a lone host status must not claim a clean exit");
	assertUncertain(derived, "S03 derivation");
	assert.equal(derived.report, undefined);
});

test("S04: session-level 'completed' plus a cutoff cannot accept an older attempt's report", () => {
	withFixture((fixture) => {
		putSession(fixture, reportedAttempt());
		// Cutoff after the only report: the session-level completion describes a later
		// attempt that produced no report yet.
		const read = recover(fixture, { nativeStatus: "completed", runId: RUN, reportNotBefore: iso(30) });
		assert.notEqual(read.status, "recovered", read.reason);
		assert.notEqual(read.status, "native-completed", "a completed host status with a cutoff must be re-proven from the session");
		assert.equal(read.report, undefined);
		assertUncertain(read, "S04 read");
	});
});

test("S05: invalid or missing timestamps can never satisfy an attempt cutoff", () => {
	const entries = reportedAttempt();
	const invalid = deriveRecoveredReport(entries, {
		sessionId: CHILD,
		file: "/tmp/offline-fixture.jsonl",
		nativeStatus: "completed",
		reportNotBefore: "not-a-timestamp",
	});
	assert.equal(invalid.report, undefined);
	assert.equal(invalid.status, "no-final-report");
	assertUncertain(invalid, "S05 invalid cutoff");
	assert.equal(invalid.terminal, undefined, "an invalid cutoff must not yield terminal evidence");

	const noTimestamp = entries.map((entry) => (entry.id === "report-1" ? { ...entry, timestamp: undefined } : entry));
	const missing = deriveRecoveredReport(noTimestamp, {
		sessionId: CHILD,
		file: "/tmp/offline-fixture.jsonl",
		nativeStatus: "completed",
		reportNotBefore: iso(0),
		runId: RUN,
	});
	assert.equal(missing.report, undefined, "a report without a valid timestamp cannot satisfy the cutoff");
	assertUncertain(missing, "S05 missing timestamp");

	withFixture((fixture) => {
		putSession(fixture, entries);
		const probe = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: "garbage", sessionsDir: fixture.sessionsDir });
		assert.equal(probe.completed, false, probe.reason);
		assertUncertain(probe, "S05 probe");
	});
});

test("S06: terminal markers bind run and attempt; foreign markers are never terminal evidence", () => {
	withFixture((fixture) => {
		putSession(fixture, chain([meta(), marker("running-1", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }), user("request"), assistant("report-1"), marker("done-other-run", SUBAGENT_RESULT_TYPE, "completed", { runId: "run-other" })]));
		const foreignRun = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(foreignRun.completed, false, foreignRun.reason);
		assert.equal(foreignRun.failed, false);
		assertUncertain(foreignRun, "S06 foreign run");

		const foreignAttempt = deriveRecoveredReport(
			chain([meta(), marker("running-1", SUBAGENT_STATUS_TYPE, "running", { attemptId: "attempt-other" }), user("request"), assistant("report-1"), marker("done-other-attempt", SUBAGENT_RESULT_TYPE, "completed", { attemptId: "attempt-other" })]),
			{ sessionId: CHILD, file: "/tmp/offline-fixture.jsonl", nativeStatus: "running", assumeStale: true, attemptId: ATTEMPT },
		);
		assert.equal(foreignAttempt.report, undefined);
		assert.equal(foreignAttempt.status, "no-final-report");
		assertUncertain(foreignAttempt, "S06 foreign attempt");
	});
});

test("S07: a bound failure marker is reported as failed; an unbound one keeps the reservation", () => {
	withFixture((fixture) => {
		putSession(fixture, chain([meta(), marker("running-1", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }), user("request"), assistant("report-1"), marker("failed-1", SUBAGENT_RESULT_TYPE, "failed", { runId: RUN })]));
		const bound = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(bound.completed, true, bound.reason);
		assert.equal(bound.failed, true, "an attempt-bound failure marker settles the attempt as failed");
		assert.equal(bound.cleanExit, false);
		assert.equal(bound.terminal?.boundToAttempt, true);
		assert.equal(bound.terminal?.clean, false);
	});
	withFixture((fixture) => {
		putSession(fixture, chain([meta(), marker("running-1", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }), user("request"), assistant("report-1"), marker("failed-other", SUBAGENT_RESULT_TYPE, "failed", { runId: "run-other" })]));
		const unbound = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(unbound.completed, false, unbound.reason);
		assert.equal(unbound.failed, false, "a failure belonging to another run must not fail this attempt");
		assertUncertain(unbound, "S07 unbound failure");
	});
});

test("S08: a bound completed marker after the report is the only clean terminal proof", () => {
	withFixture((fixture) => {
		putSession(fixture, chain([meta(), marker("running-1", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }), user("request"), assistant("report-1"), marker("completed-1", SUBAGENT_RESULT_TYPE, "completed", { runId: RUN })]));
		const probe = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(probe.completed, true, probe.reason);
		assert.equal(probe.failed, false);
		assert.equal(probe.cleanExit, true);
		assert.equal(probe.terminalExitProof, true, "a bound completion marker is allowed to prove terminal exit");
		assert.equal(probe.terminal?.kind, "result-marker");
		assert.equal(probe.terminal?.boundToAttempt, true);
		assert.equal(probe.terminal?.clean, true);
	});
});

// ---------------------------------------------------------------------------
// B. Report recovery stays reporting-only and compatible
// ---------------------------------------------------------------------------

test("S09: a recovered report never claims acceptance or terminal exit, and keeps the compatible probe contract", () => {
	withFixture((fixture) => {
		putSession(fixture, reportedAttempt());
		const read = recover(fixture, { nativeStatus: "running", assumeStale: true, runId: RUN, reportNotBefore: iso(0) });
		assert.equal(read.status, "recovered", read.reason);
		assert.ok(read.report);
		assert.equal(read.report.accepted, false);
		assert.equal(read.report.terminalExitProof, false);
		assert.equal(read.report.verification, "pending-evidence-verification");
		assert.equal(read.terminal, undefined, "a report is not terminal evidence");

		const probe = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(probe.completed, true);
		assert.equal(probe.status, "completed");
		assert.equal(probe.cleanExit, true, "historical caller contract preserved for a recovered report");
		assert.equal(probe.terminalExitProof, false, "a report is not proof that the process exited");
		assert.equal(probe.report?.accepted, false);
		assert.equal(probe.reportText, REPORT);
	});
});

test("S10: unreadable, foreign-parent, malformed and ambiguous evidence are uncertain, never completed", () => {
	withFixture((fixture) => {
		putSession(fixture, chain([meta(FOREIGN_PARENT), marker("running-1", SUBAGENT_STATUS_TYPE, "running"), user("request"), assistant("report-1")]));
		const foreign = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(foreign.completed, false);
		assert.equal(foreign.failed, false, "a foreign parent is not this attempt's failure");
		assertUncertain(foreign, "S10 foreign parent");
	});

	withFixture((fixture) => {
		const dir = join(fixture.sessionsDir, "--dup-a--");
		mkdirSync(dir, { recursive: true });
		const other = join(fixture.sessionsDir, "--dup-b--");
		mkdirSync(other, { recursive: true });
		writeFileSync(join(dir, `${CHILD}.jsonl`), jsonl(reportedAttempt()), "utf8");
		writeFileSync(join(other, `${CHILD}.jsonl`), jsonl(reportedAttempt()), "utf8");
		const ambiguous = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(ambiguous.status, "ambiguous");
		assert.equal(ambiguous.completed, false);
		assertUncertain(ambiguous, "S10 ambiguous");
	});

	withFixture((fixture) => {
		const file = putSession(fixture, reportedAttempt());
		writeFileSync(file, jsonl(reportedAttempt()) + '{"type":"message","id":"broken"', "utf8");
		const malformed = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(malformed.status, "malformed");
		assert.equal(malformed.completed, false);
		assertUncertain(malformed, "S10 malformed");
	});
});

// ---------------------------------------------------------------------------
// C. Bounded long-session I/O
// ---------------------------------------------------------------------------

test("S11: an oversized session is truncated uncertainty, never completed", () => {
	withFixture((fixture) => {
		putSession(fixture, reportedAttempt());
		const small = recover(fixture, { nativeStatus: "running", assumeStale: true, runId: RUN, reportNotBefore: iso(0), maxSessionBytes: 64 });
		assert.equal(small.status, "file-error");
		assert.equal(small.truncated, true);
		assert.equal(small.report, undefined);
		assertUncertain(small, "S11 small bound");
		assert.ok((small.byteLength ?? 0) <= 64, "the bounded read must not exceed the byte cap");
	});
});

test("S12: a session above the default byte bound is rejected before parsing, by read and by probe", () => {
	withFixture((fixture) => {
		const file = putSession(fixture, reportedAttempt());
		const payload = jsonl(reportedAttempt());
		writeFileSync(file, payload + "x".repeat(RECOVERY_MAX_SESSION_BYTES + 1), "utf8");
		const res = recover(fixture, { nativeStatus: "running", assumeStale: true, runId: RUN, reportNotBefore: iso(0) });
		assert.equal(res.status, "file-error");
		assert.equal(res.truncated, true);
		assert.equal(res.report, undefined);
		assertUncertain(res, "S12 default bound");

		const probe = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(probe.status, "file-error");
		assert.equal(probe.completed, false, "an oversized session must never be completed evidence");
		assert.equal(probe.failed, false);
		assertUncertain(probe, "S12 probe");
	});
});

test("S13: the parsed-entry bound turns a long session into uncertain, not completed evidence", () => {
	withFixture((fixture) => {
		putSession(fixture, reportedAttempt());
		const bounded = recover(fixture, { nativeStatus: "running", assumeStale: true, runId: RUN, reportNotBefore: iso(0), maxEntries: 3 });
		assert.equal(bounded.status, "malformed");
		assert.match(bounded.reason, /bounded entry limit/);
		assert.equal(bounded.report, undefined);
		assertUncertain(bounded, "S13 entry bound");
	});
});

// ---------------------------------------------------------------------------
// D. Path cache: canonical root+id key, revalidation, bounded retention
// ---------------------------------------------------------------------------

test("S14: cache keys are canonical root + session id, so two roots never share a resolution", () => {
	clearSessionPathCache();
	withFixture((first) => {
		withFixture((second) => {
			const firstFile = putSession(first, reportedAttempt());
			const secondFile = putSession(second, reportedAttempt());
			const a = resolveChildSessionFile(CHILD, first.sessionsDir);
			const b = resolveChildSessionFile(CHILD, second.sessionsDir);
			assert.equal(a.status, "found");
			assert.equal(b.status, "found");
			assert.equal(a.status === "found" ? a.file : "", firstFile);
			assert.equal(b.status === "found" ? b.file : "", secondFile);
			assert.notEqual(a.status === "found" ? a.file : "", b.status === "found" ? b.file : "");
			const again = resolveChildSessionFile(CHILD, first.sessionsDir);
			assert.equal(again.status === "found" ? again.file : "", firstFile, "returning to the first root must not accept the second root's cache entry");
			assert.ok(sessionPathCacheSize() <= SESSION_PATH_CACHE_LIMIT);
		});
	});
});

test("S15: a cached resolution is revalidated; a later duplicate becomes ambiguous, a deleted file becomes unknown", () => {
	clearSessionPathCache();
	withFixture((fixture) => {
		const firstFile = putSession(fixture, reportedAttempt(), { cwdDir: "--cwd-a--" });
		const resolved = resolveChildSessionFile(CHILD, fixture.sessionsDir);
		assert.equal(resolved.status, "found");
		assert.ok(sessionPathCacheSize() >= 1, "a stable resolution may be cached");

		const dupDir = join(fixture.sessionsDir, "--cwd-b--");
		mkdirSync(dupDir, { recursive: true });
		writeFileSync(join(dupDir, `${CHILD}.jsonl`), jsonl(reportedAttempt()), "utf8");
		const ambiguous = resolveChildSessionFile(CHILD, fixture.sessionsDir);
		assert.equal(ambiguous.status, "ambiguous", "a stale cached path must never hide a new duplicate");

		unlinkSync(firstFile);
		unlinkSync(join(dupDir, `${CHILD}.jsonl`));
		const afterDelete = resolveChildSessionFile(CHILD, fixture.sessionsDir);
		assert.equal(afterDelete.status, "unknown", "a cached path must not survive the file being removed");
	});
});

test("S16: path-cache retention is bounded by SESSION_PATH_CACHE_LIMIT", () => {
	clearSessionPathCache();
	withFixture((fixture) => {
		putSession(fixture, reportedAttempt(), { sessionId: CHILD });
		const dir = join(fixture.sessionsDir, "--many--");
		mkdirSync(dir, { recursive: true });
		const total = SESSION_PATH_CACHE_LIMIT + 8;
		for (let index = 0; index < total; index += 1) {
			const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
			writeFileSync(join(dir, `${id}.jsonl`), jsonl(reportedAttempt(), {}, id), "utf8");
			const res = resolveChildSessionFile(id, fixture.sessionsDir);
			assert.equal(res.status, "found");
		}
		assert.ok(sessionPathCacheSize() <= SESSION_PATH_CACHE_LIMIT, `cache must stay bounded, saw ${sessionPathCacheSize()}`);
	});
	clearSessionPathCache();
});

// ---------------------------------------------------------------------------
// E. Bulk probing: identity ambiguity and bounded fan-out
// ---------------------------------------------------------------------------

test("S17: two ledger entries claiming one session are ambiguous, not last-writer-wins", () => {
	withFixture((fixture) => {
		putSession(fixture, reportedAttempt());
		const results = probeAllLiveChildren(
			[
				{ taskId: "W-one", sessionId: CHILD, runId: RUN, dispatchedAt: iso(0) },
				{ taskId: "W-two", sessionId: CHILD, runId: "run-other", dispatchedAt: iso(0) },
			],
			{ parentSessionId: PARENT, sessionsDir: fixture.sessionsDir },
		);
		const result = results.get(CHILD);
		assert.ok(result);
		assert.equal(result.status, "ambiguous-identity");
		assert.equal(result.completed, false);
		assert.equal(result.failed, false);
		assertUncertain(result, "S17 duplicate identity");
	});
});

test("S18: bulk probing fan-out is capped and unprobed children stay reserved", () => {
	withFixture((fixture) => {
		putSession(fixture, reportedAttempt());
		const sessions = [{ taskId: "W-known", sessionId: CHILD, runId: RUN, dispatchedAt: iso(0) }];
		for (let index = 0; index < RECOVERY_MAX_PROBED_SESSIONS + 5; index += 1) {
			sessions.push({ taskId: `W-extra-${index}`, sessionId: `00000000-0000-4000-8000-${String(900000 + index).padStart(12, "0")}`, runId: RUN, dispatchedAt: iso(0) });
		}
		const results = probeAllLiveChildren(sessions, { parentSessionId: PARENT, sessionsDir: fixture.sessionsDir });
		assert.ok(results.size <= RECOVERY_MAX_PROBED_SESSIONS, `fan-out must be capped, saw ${results.size}`);
		assert.equal(results.get(CHILD)?.completed, true, "the known child is still probed");
		assert.equal(results.has(sessions[sessions.length - 1].sessionId), false, "children beyond the cap are not probed and therefore stay reserved");
	});
});

test("S19: probing never reads or rewrites a live session root", () => {
	clearSessionPathCache();
	withFixture((fixture) => {
		const file = putSession(fixture, reportedAttempt());
		const before = readFileSync(file, "utf8");
		probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		probeAllLiveChildren([{ taskId: "W-x", sessionId: CHILD, runId: RUN, dispatchedAt: iso(0) }], { parentSessionId: PARENT, sessionsDir: fixture.sessionsDir });
		recover(fixture, { nativeStatus: "running", assumeStale: true, runId: RUN, reportNotBefore: iso(0) });
		assert.equal(readFileSync(file, "utf8"), before, "recovery must be read-only");
		const unknown = recover(fixture, {}, "00000000-0000-4000-8000-00000000ffff");
		assert.equal(unknown.status, "unknown-session");
		assertUncertain(unknown, "S19 unknown session");
	});
	clearSessionPathCache();
});

test("S20: probes and resolvers remain module exports with stable shapes", async () => {
	const mod = await import("../team-recovery.ts");
	for (const name of ["recoverChildReport", "probeLiveChildSession", "probeAllLiveChildren", "resolveChildSessionFile", "deriveRecoveredReport", "clearSessionPathCache", "sessionPathCacheSize", "RECOVERY_MAX_SESSION_BYTES", "RECOVERY_MAX_ENTRIES", "SESSION_PATH_CACHE_LIMIT", "SESSION_PATH_CACHE_TTL_MS", "RECOVERY_MAX_PROBED_SESSIONS"]) {
		assert.ok(name in mod, `public export ${name} must be preserved`);
	}
	assert.equal(typeof mod.probeAllLiveChildren, "function");
});
// ---------------------------------------------------------------------------
// F. W-rev-118 REWORK regressions (four CP defects)
// ---------------------------------------------------------------------------

test("S21: an aborted assistant message followed by resumed running/queued activity is not terminal", () => {
	// Defect 1: assistant-stop terminal evidence was emitted before inspecting newer
	// relevant activity, so probe promoted aborted -> resumed as a terminal failure.
	for (const resumed of ["running", "queued", "starting"]) {
		withFixture((fixture) => {
			putSession(fixture, chain([
				meta(),
				marker("running-1", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }),
				user("request"),
				assistant("aborted-1", "aborted"),
				marker("resumed", SUBAGENT_STATUS_TYPE, resumed, { runId: RUN }),
			]));
			const derived = deriveRecoveredReport(
				chain([
					meta(),
					marker("running-1", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }),
					user("request"),
					assistant("aborted-1", "aborted"),
					marker("resumed", SUBAGENT_STATUS_TYPE, resumed, { runId: RUN }),
				]),
				{ sessionId: CHILD, file: "/tmp/offline-fixture.jsonl", nativeStatus: "interrupted", runId: RUN, reportNotBefore: iso(0) },
			);
			assert.equal(derived.status, "no-final-report");
			assert.equal(derived.terminal, undefined, `resumed ${resumed} activity must not leave terminal evidence`);
			assertUncertain(derived, `S21 ${resumed} derivation`);

			const probe = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
			assert.equal(probe.completed, false, probe.reason);
			assert.equal(probe.failed, false, `resumed ${resumed} activity must not be promoted to terminal failure`);
			assert.equal(probe.cleanExit, false);
			assert.equal(probe.terminal, undefined);
			assertUncertain(probe, `S21 ${resumed} probe`);
		});
	}
	// Control: the same aborted message with no newer activity is still terminal failure.
	withFixture((fixture) => {
		putSession(fixture, chain([meta(), marker("running-1", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }), user("request"), assistant("aborted-1", "aborted")]));
		const probe = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(probe.completed, true, probe.reason);
		assert.equal(probe.failed, true);
		assert.equal(probe.terminal?.kind, "assistant-stop");
		assert.equal(probe.terminal?.boundToAttempt, true);
	});
});

test("S22: an unrecognized marker status is never promoted to terminal failure", () => {
	// Defect 2: the terminal fall-through treated any non-completed, non-live marker
	// status (including 'unknown') as a terminal failure.
	withFixture((fixture) => {
		putSession(fixture, chain([meta(), marker("running-1", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }), user("request"), assistant("report-1"), marker("mystery", SUBAGENT_RESULT_TYPE, "mystery-state", { runId: RUN })]));
		const derived = deriveRecoveredReport(
			chain([meta(), marker("running-1", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }), user("request"), assistant("report-1"), marker("mystery", SUBAGENT_RESULT_TYPE, "mystery-state", { runId: RUN })]),
			{ sessionId: CHILD, file: "/tmp/offline-fixture.jsonl", nativeStatus: "interrupted", runId: RUN, reportNotBefore: iso(0) },
		);
		assert.equal(derived.status, "no-final-report");
		assert.equal(derived.terminal, undefined, "an unrecognized status must not become terminal failure evidence");
		assertUncertain(derived, "S22 derivation");

		const probe = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(probe.completed, false, probe.reason);
		assert.equal(probe.failed, false, "unknown status must stay uncertain, not failed");
		assert.equal(probe.terminal, undefined);
		assertUncertain(probe, "S22 probe");
	});
	// Control: a recognized failure status stays terminal failure when bound.
	withFixture((fixture) => {
		putSession(fixture, chain([meta(), marker("running-1", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }), user("request"), assistant("report-1"), marker("interrupted-1", SUBAGENT_RESULT_TYPE, "interrupted", { runId: RUN })]));
		const probe = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(probe.completed, true, probe.reason);
		assert.equal(probe.failed, true);
		assert.equal(probe.terminal?.clean, false);
	});
});

test("S23: a foreign-run marker before an untagged report/completion cannot prove this run's clean exit", () => {
	// Defect 3: untagged entries inherited 'bound' from the cutoff alone even when the
	// relevant pre-report context declared a different run.
	withFixture((fixture) => {
		putSession(fixture, chain([
			meta(),
			marker("running-other", SUBAGENT_STATUS_TYPE, "running", { runId: "run-other" }),
			user("request"),
			assistant("report-1"),
			marker("completed-untagged", SUBAGENT_RESULT_TYPE, "completed"),
		]));
		const probe = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(probe.completed, false, probe.reason);
		assert.equal(probe.cleanExit, false);
		assert.equal(probe.terminalExitProof, false);
		assert.equal(probe.failed, false);
		assert.equal(probe.terminal, undefined);
		assert.equal(probe.report, undefined, "an untagged report under a foreign run context is not this run's report");
		assertUncertain(probe, "S23 probe");

		const read = recover(fixture, { nativeStatus: "running", assumeStale: true, runId: RUN, reportNotBefore: iso(0) });
		assert.equal(read.report, undefined);
		assert.equal(read.cleanExit, undefined);
		assert.equal(read.terminal, undefined);
		assertUncertain(read, "S23 read");
	});
	// Control: the same untagged report/completion with a matching declared context is bound.
	withFixture((fixture) => {
		putSession(fixture, chain([
			meta(),
			marker("running-mine", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }),
			user("request"),
			assistant("report-1"),
			marker("completed-untagged", SUBAGENT_RESULT_TYPE, "completed"),
		]));
		const probe = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
		assert.equal(probe.completed, true, probe.reason);
		assert.equal(probe.terminalExitProof, true);
		assert.equal(probe.terminal?.boundToAttempt, true);
	});
});

test("S24: cache revalidation detects a duplicate written into a pre-existing sibling directory", () => {
	clearSessionPathCache();
	withFixture((fixture) => {
		const firstFile = putSession(fixture, reportedAttempt(), { cwdDir: "--pre-a--" });
		const sibling = join(fixture.sessionsDir, "--pre-b--");
		mkdirSync(sibling, { recursive: true });
		// Deterministic directory mtimes so the assertions never depend on clock resolution.
		utimesSync(join(fixture.sessionsDir, "--pre-a--"), new Date(1_000_000_000_000), new Date(1_000_000_000_000));
		utimesSync(sibling, new Date(1_000_000_001_000), new Date(1_000_000_001_000));

		const resolved = resolveChildSessionFile(CHILD, fixture.sessionsDir);
		assert.equal(resolved.status, "found");
		assert.equal(resolved.status === "found" ? resolved.file : "", firstFile);
		assert.equal(sessionPathCacheSize(), 1, "a stable narrow root is cached");

		// Duplicate in a directory that existed before the resolution; the root mtime and
		// the cached directory are untouched, so only the sibling snapshot can catch it.
		writeFileSync(join(sibling, `${CHILD}.jsonl`), jsonl(reportedAttempt()), "utf8");
		utimesSync(sibling, new Date(1_000_000_002_000), new Date(1_000_000_002_000));
		const afterDuplicate = resolveChildSessionFile(CHILD, fixture.sessionsDir);
		assert.equal(afterDuplicate.status, "ambiguous", "a duplicate in a pre-existing sibling directory must invalidate the cached path");
		assert.equal(sessionPathCacheSize(), 0);
	});
	clearSessionPathCache();
});

test("S25: wide session roots above the scan budget fail closed and are never cached", () => {
	clearSessionPathCache();
	withFixture((fixture) => {
		for (let index = 0; index < SESSION_PATH_CACHE_MAX_DIRS + 2; index += 1) {
			mkdirSync(join(fixture.sessionsDir, `--wide-${String(index).padStart(3, "0")}--`), { recursive: true });
		}
		putSession(fixture, reportedAttempt(), { cwdDir: "--wide-000--" });
		// Round-4 R2: a root wider than the directory scan budget (exactly the cache
		// threshold) can never be fully scanned, so uniqueness stays unproven and the
		// resolution must fail closed instead of returning or caching a possibly
		// incomplete single-path answer.
		const resolved = resolveChildSessionFile(CHILD, fixture.sessionsDir);
		assert.equal(resolved.status, "unknown", "a root above the directory scan budget cannot prove a unique path");
		assert.equal(sessionPathCacheSize(), 0, "a root above the scan budget is never cached");
		const again = resolveChildSessionFile(CHILD, fixture.sessionsDir);
		assert.equal(again.status, "unknown", "each resolution retries inside the same hard scan budgets");
		assert.equal(sessionPathCacheSize(), 0);
	});
	clearSessionPathCache();
});

// ---------------------------------------------------------------------------
// G. W-rev-118 round-2 REWORK close-out: D2 substring lookalikes, D3 mixed identity
// ---------------------------------------------------------------------------

const LOOKALIKE_MARKER_STATUSES = ["failover-pending", "not-failed-yet", "abort-request-pending", "interrupt-pending", "cancel-pending"];

/** Bound attempt whose latest marker carries a substring lookalike failure status. */
function lookalikeMarkerAttempt(status: string): SessionEntryLike[] {
	return chain([
		meta(),
		marker("running-1", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }),
		user("request"),
		assistant("report-1"),
		marker("lookalike", SUBAGENT_RESULT_TYPE, status, { runId: RUN }),
	]);
}

test("S26: substring lookalike marker statuses are never terminal failures (D2)", () => {
	// CP W-rev-118 (round 2) evidence: permissive normalization promoted
	// "failover-pending", "not-failed-yet" and "abort-request-pending" to bound
	// terminal failures. Only exact canonical words may classify a terminal failure.
	for (const status of LOOKALIKE_MARKER_STATUSES) {
		withFixture((fixture) => {
			putSession(fixture, lookalikeMarkerAttempt(status));
			const probe = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
			assert.equal(probe.completed, false, `${status}: ${probe.reason}`);
			assert.equal(probe.failed, false, `${status} must not be terminal failure evidence`);
			assert.equal(probe.cleanExit, false);
			assert.equal(probe.terminalExitProof, false);
			assert.equal(probe.terminal, undefined, `${status} must not yield terminal evidence`);
			assertUncertain(probe, `S26 ${status} probe`);
		});
		const derived = deriveRecoveredReport(lookalikeMarkerAttempt(status), {
			sessionId: CHILD,
			file: "/tmp/offline-fixture.jsonl",
			nativeStatus: "interrupted",
			runId: RUN,
			reportNotBefore: iso(0),
		});
		assert.equal(derived.status, "no-final-report", `${status} derivation status`);
		assert.equal(derived.terminal, undefined, `${status} must not become terminal evidence`);
		assertUncertain(derived, `S26 ${status} derivation`);
	}
	// Control: exact canonical failure words remain terminal failure evidence when bound.
	for (const status of ["failed", "aborted", "interrupted"]) {
		const derived = deriveRecoveredReport(lookalikeMarkerAttempt(status), {
			sessionId: CHILD,
			file: "/tmp/offline-fixture.jsonl",
			nativeStatus: "interrupted",
			runId: RUN,
			reportNotBefore: iso(0),
		});
		assert.equal(derived.status, "no-final-report", `${status} control status`);
		assert.equal(derived.terminal?.kind, "result-marker", status);
		assert.equal(derived.terminal?.boundToAttempt, true, status);
		assert.equal(derived.terminal?.clean, false, status);
		assertUncertain(derived, `S26 ${status} control`);
	}
});

/** Attempt whose nearest declared context matches the run but conflicts on attempt. */
function mixedIdentityAttempt(): SessionEntryLike[] {
	return chain([
		meta(),
		marker("running-mixed", SUBAGENT_STATUS_TYPE, "running", { runId: RUN, attemptId: "attempt-other" }),
		user("request"),
		assistant("report-1"),
		marker("completed-untagged", SUBAGENT_RESULT_TYPE, "completed"),
	]);
}

/** Conflict declared directly on the terminal marker, report itself bound. */
function mixedIdentityMarkerAttempt(): SessionEntryLike[] {
	return chain([
		meta(),
		marker("running-mine", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }),
		user("request"),
		assistant("report-1"),
		marker("completed-mixed", SUBAGENT_RESULT_TYPE, "completed", { runId: RUN, attemptId: "attempt-other" }),
	]);
}

/** Bound report, then a conflicting context entry, then an untagged failure marker. */
function mixedIdentityBeforeFailureAttempt(): SessionEntryLike[] {
	return chain([
		meta(),
		marker("running-mine", SUBAGENT_STATUS_TYPE, "running", { runId: RUN }),
		user("request"),
		assistant("report-1"),
		marker("running-mixed", SUBAGENT_STATUS_TYPE, "running", { runId: RUN, attemptId: "attempt-other" }),
		marker("failed-untagged", SUBAGENT_RESULT_TYPE, "failed"),
	]);
}

/** Control: run and attempt both match on the context before an untagged completion. */
function bothIdentityAttempt(): SessionEntryLike[] {
	return chain([
		meta(),
		marker("running-both", SUBAGENT_STATUS_TYPE, "running", { runId: RUN, attemptId: ATTEMPT }),
		user("request"),
		assistant("report-1"),
		marker("completed-untagged", SUBAGENT_RESULT_TYPE, "completed"),
	]);
}

test("S27: a matching run with a conflicting attempt context cannot prove a clean exit (D3)", () => {
	// CP W-rev-118 (round 2) evidence: declaredContextBefore returned "bound" on a
	// matching run before checking a conflicting attemptId on the same entry, so
	// untagged successors inherited "bound" and produced cleanExit/terminalExitProof.
	const derived = deriveRecoveredReport(mixedIdentityAttempt(), {
		sessionId: CHILD,
		file: "/tmp/offline-fixture.jsonl",
		nativeStatus: "running",
		assumeStale: true,
		runId: RUN,
		attemptId: ATTEMPT,
		reportNotBefore: iso(0),
	});
	assert.equal(derived.status, "no-final-report");
	assert.equal(derived.report, undefined, "an untagged report under a mixed run/attempt context is not this attempt's report");
	assert.equal(derived.cleanExit, undefined);
	assert.equal(derived.terminal, undefined, "a conflicting attempt context must not yield terminal evidence");
	assertUncertain(derived, "S27 mixed-context derivation");

	// The same conflict declared directly on the terminal marker stays foreign as well.
	const onMarker = deriveRecoveredReport(mixedIdentityMarkerAttempt(), {
		sessionId: CHILD,
		file: "/tmp/offline-fixture.jsonl",
		nativeStatus: "running",
		assumeStale: true,
		runId: RUN,
		attemptId: ATTEMPT,
		reportNotBefore: iso(0),
	});
	assert.equal(onMarker.report, undefined);
	assert.equal(onMarker.cleanExit, undefined);
	assert.equal(onMarker.terminal, undefined);
	assertUncertain(onMarker, "S27 mixed-marker derivation");

	// A conflicting context directly before an untagged failure marker is not terminal either.
	const beforeFailure = deriveRecoveredReport(mixedIdentityBeforeFailureAttempt(), {
		sessionId: CHILD,
		file: "/tmp/offline-fixture.jsonl",
		nativeStatus: "running",
		assumeStale: true,
		runId: RUN,
		attemptId: ATTEMPT,
		reportNotBefore: iso(0),
	});
	assert.equal(beforeFailure.report, undefined);
	assert.equal(beforeFailure.terminal, undefined, "an untagged failure marker behind a conflicting context must not fail this attempt");
	assertUncertain(beforeFailure, "S27 mixed-context failure marker derivation");

	// Control: matching run + matching attempt context still binds untagged successors.
	const control = deriveRecoveredReport(bothIdentityAttempt(), {
		sessionId: CHILD,
		file: "/tmp/offline-fixture.jsonl",
		nativeStatus: "running",
		assumeStale: true,
		runId: RUN,
		attemptId: ATTEMPT,
		reportNotBefore: iso(0),
	});
	assert.equal(control.status, "native-completed");
	assert.equal(control.nativeReportText, REPORT);
	assert.equal(control.cleanExit, true);
	assert.equal(control.terminal?.boundToAttempt, true);
	assert.equal(control.terminal?.clean, true);
});

// ---------------------------------------------------------------------------
// H. W-rev-118 round-4 residual rework: R1 unreadable siblings, R2 scan budgets
// ---------------------------------------------------------------------------

interface ScanCounters {
	childDirReads: number;
	nameReads: number;
	readdirSyncCalls: number;
}

interface FakeDirStream {
	readSync(): unknown;
	closeSync(): void;
}

/**
 * Test instrumentation for the R2 scan bounds: wraps `opendirSync` so child
 * directory opens and filename-property reads under the fixture root are
 * counted, and `readdirSync` so any unbounded materialization becomes visible.
 * Only fixture paths are wrapped; everything else delegates to the real fs. The
 * wrappers are installed for the duration of `fn` only.
 */
function withScanInstrumentation<T>(
	sessionsDir: string,
	fakeDir: ((dirPath: string, root: string) => FakeDirStream | undefined) | undefined,
	fn: (counters: ScanCounters) => T,
): T {
	const counters: ScanCounters = { childDirReads: 0, nameReads: 0, readdirSyncCalls: 0 };
	const root = realpathSync(sessionsDir);
	const originalOpenDir = fs.opendirSync;
	const originalReaddir = fs.readdirSync;
	const wrapEntry = (entry: unknown): unknown => {
		if (entry === null || entry === undefined) return entry;
		const dirent = entry as { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean };
		return {
			get name() {
				counters.nameReads += 1;
				return dirent.name;
			},
			isDirectory: () => dirent.isDirectory(),
			isFile: () => dirent.isFile(),
			isSymbolicLink: () => dirent.isSymbolicLink(),
		};
	};
	const wrapDir = (dir: { readSync(): unknown; closeSync(): void }): FakeDirStream => ({
		readSync: () => wrapEntry(dir.readSync()),
		closeSync: () => dir.closeSync(),
	});
	const callRealOpenDir = (dirPath: string, rest: unknown[]): { readSync(): unknown; closeSync(): void } =>
		(originalOpenDir as unknown as (path: string, ...args: unknown[]) => { readSync(): unknown; closeSync(): void })(dirPath, ...rest);
	const patchedOpenDir = (dirPath: string, ...rest: unknown[]): unknown => {
		if (dirPath === root) return wrapDir(callRealOpenDir(dirPath, rest));
		if (dirPath.startsWith(`${root}${sep}`)) {
			counters.childDirReads += 1;
			const fake = fakeDir?.(dirPath, root);
			if (fake) return wrapDir(fake);
			return wrapDir(callRealOpenDir(dirPath, rest));
		}
		return originalOpenDir(dirPath, ...rest);
	};
	fs.opendirSync = patchedOpenDir as unknown as typeof fs.opendirSync;
	fs.readdirSync = ((...args: unknown[]) => {
		counters.readdirSyncCalls += 1;
		return (originalReaddir as unknown as (...inner: unknown[]) => unknown)(...args);
	}) as unknown as typeof fs.readdirSync;
	syncBuiltinESMExports();
	try {
		return fn(counters);
	} finally {
		fs.opendirSync = originalOpenDir;
		fs.readdirSync = originalReaddir;
		syncBuiltinESMExports();
	}
}

test("S28: an unreadable sibling directory fails closed: uncertain, no report, no terminal evidence, no cache (R1)", () => {
	clearSessionPathCache();
	withFixture((fixture) => {
		const file = putSession(fixture, reportedAttempt(), { cwdDir: "--readable--" });
		const blocked = join(fixture.sessionsDir, "--blocked--");
		mkdirSync(blocked);
		chmodSync(blocked, 0o000);
		try {
			const resolved = resolveChildSessionFile(CHILD, fixture.sessionsDir);
			assert.equal(resolved.status, "unknown", `an unreadable sibling must fail closed (${JSON.stringify(resolved)})`);
			assert.equal(sessionPathCacheSize(), 0, "no cache admission without a proven unique path");

			const probe = probeLiveChildSession(CHILD, { parentSessionId: PARENT, runId: RUN, dispatchedAt: iso(0), sessionsDir: fixture.sessionsDir });
			assert.equal(probe.completed, false, "incomplete discovery is never completion");
			assert.equal(probe.failed, false, "incomplete discovery is never failure evidence");
			assert.equal(probe.cleanExit, false);
			assert.equal(probe.terminalExitProof, false);
			assert.equal(probe.terminal, undefined, "no terminal evidence from an incomplete scan");
			assert.equal(probe.report, undefined, "no report from an incomplete scan");
			assertUncertain(probe, "S28 unreadable sibling probe");

			const second = resolveChildSessionFile(CHILD, fixture.sessionsDir);
			assert.equal(second.status, "unknown", "the second resolution must retry the scan, never serve a cached found");
			assert.equal(sessionPathCacheSize(), 0);

			chmodSync(blocked, 0o755);
			const recovered = resolveChildSessionFile(CHILD, fixture.sessionsDir);
			assert.equal(recovered.status, "found", "control: the same root resolves once the sibling is readable again");
			assert.equal(recovered.status === "found" ? recovered.file : "", file);
		} finally {
			chmodSync(blocked, 0o755);
		}
	});
	clearSessionPathCache();
});

test("S29: repeated discovery scans stay within explicit directory/entry budgets (R2)", () => {
	clearSessionPathCache();
	// A. More child directories than the directory budget: the scan must stop at the
	// threshold instead of reading every directory, and an existing match may not be
	// returned from a scan that could not finish.
	withFixture((fixture) => {
		for (let index = 0; index < SESSION_PATH_SCAN_MAX_DIRS + 1; index += 1) {
			mkdirSync(join(fixture.sessionsDir, `--budget-${String(index).padStart(3, "0")}--`), { recursive: true });
		}
		putSession(fixture, reportedAttempt(), { cwdDir: "--budget-000--" });
		withScanInstrumentation(fixture.sessionsDir, undefined, (counters) => {
			const first = resolveChildSessionFile(CHILD, fixture.sessionsDir);
			const second = resolveChildSessionFile(CHILD, fixture.sessionsDir);
			assert.equal(first.status, "unknown", "an over-wide root cannot prove uniqueness");
			assert.match(first.reason, /budget/);
			assert.equal(second.status, "unknown", "no cached answer may bypass the budgets");
			assert.equal(sessionPathCacheSize(), 0);
			assert.ok(counters.childDirReads > 0, "instrumentation must actually observe child directory reads");
			assert.ok(
				counters.childDirReads <= 2 * SESSION_PATH_SCAN_MAX_DIRS,
				`child directory reads ${counters.childDirReads} must stay within 2x${SESSION_PATH_SCAN_MAX_DIRS}`,
			);
			assert.equal(counters.readdirSyncCalls, 0, "discovery must stream, not materialize with readdirSync");
		});
	});
	// B. More entries in one directory than the entry budget: two repeated resolutions
	// must stay far below the unbounded baseline (130 child-directory reads and
	// 260,000 filename-property reads for a 65x2000 fixture).
	withFixture((fixture) => {
		const manyDir = join(realpathSync(fixture.sessionsDir), "--many--");
		mkdirSync(manyDir);
		const fakeEntries = SESSION_PATH_SCAN_MAX_ENTRIES + 1;
		withScanInstrumentation(fixture.sessionsDir, (dirPath) => {
			if (dirPath !== manyDir) return undefined;
			let index = 0;
			return {
				readSync: () =>
					index < fakeEntries
						? { name: `entry-${String(index++).padStart(6, "0")}.jsonl`, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }
						: null,
				closeSync: () => {},
			};
		}, (counters) => {
			const first = resolveChildSessionFile(CHILD, fixture.sessionsDir);
			const second = resolveChildSessionFile(CHILD, fixture.sessionsDir);
			assert.equal(first.status, "unknown", "entry budget exhaustion yields uncertainty");
			assert.match(first.reason, /budget/);
			assert.equal(second.status, "unknown", "no cached answer may bypass the budgets");
			assert.equal(sessionPathCacheSize(), 0);
			assert.ok(
				counters.childDirReads <= 2 * SESSION_PATH_SCAN_MAX_DIRS,
				`child directory reads ${counters.childDirReads} must stay within 2x${SESSION_PATH_SCAN_MAX_DIRS}`,
			);
			assert.ok(
				counters.nameReads <= 2 * SESSION_PATH_SCAN_MAX_ENTRIES,
				`filename-property reads ${counters.nameReads} must stay within 2x${SESSION_PATH_SCAN_MAX_ENTRIES} (unbounded baseline: 260,000)`,
			);
			assert.ok(counters.nameReads < 260_000, "two resolutions must stay far below the unbounded baseline");
			assert.equal(counters.readdirSyncCalls, 0, "discovery must stream, not materialize with readdirSync");
		});
	});
	clearSessionPathCache();
});
