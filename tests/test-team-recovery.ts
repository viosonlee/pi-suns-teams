/**
 * Offline helper tests: synthetic JSONL only; all filesystem fixtures are
 * created under mkdtempSync(tmpdir()) and removed in finally, including failures.
 * Run: node ~/.pi/agent/team-tests/test-team-recovery.ts
 *
 * API basis: /tmp/team-recovery-api.txt and ../team-recovery.ts.
 * Session shape: Pi docs/session-format.md and docs/message-types.md.
 *
 * The helper returns "recovered", accepted:false, pending verification.
 * The extension maps that report to "reported", NOT accepted completion.
 * Extension hooks, receipt persistence/deduplication, calls/spend/limits, and
 * RPC smoke evidence belong to Main's separate test-team-recovery-hooks.ts.
 * This suite does not import the extension factory, open historical sessions,
 * run Pi, dispatch tools, poll, resume, or call a model.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	SUBAGENT_META_TYPE,
	SUBAGENT_RESULT_TYPE,
	SUBAGENT_STATUS_TYPE,
	buildActiveBranch,
	collectKnownChildSessionIds,
	defaultSessionsDir,
	deriveRecoveredReport,
	extractSessionIdFromText,
	extractSessionIdFromTextAll,
	inferNativeStatus,
	isRecoverableNativeStatus,
	isSafeSessionId,
	normalizeNativeStatus,
	parseSessionJsonl,
	recoverChildReport,
	recoveryKey,
	resolveChildSessionFile,
	type DeriveRecoveredReportOptions,
	type RecoveredReport,
	type RecoverChildOptions,
	type RecoveryDerivation,
	type RecoveryReadResult,
	type SessionEntryLike,
	type SessionHeaderLike,
} from "../team-recovery.ts";

const PARENT = "00000000-0000-4000-8000-000000000001";
const CHILD = "00000000-0000-4000-8000-000000000002";
const OTHER_CHILD = "00000000-0000-4000-8000-000000000003";
const RECORDED_CHILD = "00000000-0000-4000-8000-000000000005";
const FOREIGN_PARENT = "00000000-0000-4000-8000-000000000004";
const TIME = Date.parse("2026-01-01T00:00:00.000Z");
const REPORT = "## Report\nSynthetic fixture only; evidence verification is pending.";
const PURE_FILE = join(tmpdir(), "team-recovery-synthetic", `${CHILD}.jsonl`);
const TOOL_A = { type: "toolCall", id: "call-a", name: "bash", arguments: { command: "synthetic-only", timeout: 1 } };

function chain(drafts: SessionEntryLike[]): SessionEntryLike[] {
	return drafts.map((draft, index) => ({
		parentId: index === 0 ? null : drafts[index - 1].id,
		timestamp: new Date(TIME + (index + 1) * 1000).toISOString(),
		...draft,
	}));
}

function assistant(id: string, stopReason = "stop", content: unknown = [{ type: "text", text: REPORT }]): SessionEntryLike {
	return {
		type: "message", id,
		message: {
			role: "assistant", content, stopReason,
			api: "openai-completions", provider: "offline-fixture", model: "offline-fixture",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			timestamp: TIME,
		},
	};
}

function user(id: string): SessionEntryLike {
	return { type: "message", id, message: { role: "user", content: "Synthetic request", timestamp: TIME } };
}

function toolResult(id: string, toolCallId: string): SessionEntryLike {
	return {
		type: "message", id,
		message: { role: "toolResult", toolName: "bash", toolCallId, content: [{ type: "text", text: "Synthetic result" }], isError: false, timestamp: TIME },
	};
}

function marker(id: string, customType: string, status: string): SessionEntryLike {
	return { type: "custom", id, customType, data: { version: 1, status } };
}

function baseEntries(): SessionEntryLike[] {
	return chain([
		{ type: "custom", id: "meta", customType: SUBAGENT_META_TYPE,
			data: { version: 1, parentSessionId: PARENT, parentToolCallId: "parent-call", profile: "bridges", description: "Synthetic recovery fixture" } },
		marker("queued", SUBAGENT_STATUS_TYPE, "queued"),
		marker("running", SUBAGENT_STATUS_TYPE, "running"),
		user("request"),
		{ ...marker("interrupted", SUBAGENT_RESULT_TYPE, "interrupted"), data: { version: 1, status: "interrupted", error: "This operation was aborted" } },
		assistant("work", "toolUse", [TOOL_A]),
		toolResult("tool-result", "call-a"),
		assistant("report"),
	]);
}

function derive(entries = baseEntries(), options: Partial<DeriveRecoveredReportOptions> = {}): RecoveryDerivation {
	return deriveRecoveredReport(entries, { sessionId: CHILD, file: PURE_FILE, nativeStatus: "interrupted", ...options });
}

function jsonl(entries = baseEntries(), header: Partial<SessionHeaderLike> = {}): string {
	return [
		{ type: "session", version: 3, id: CHILD, timestamp: new Date(TIME).toISOString(), cwd: PURE_FILE, ...header },
		...entries,
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function requireReport(result: RecoveryDerivation | RecoveryReadResult): RecoveredReport {
	assert.equal(result.status, "recovered", result.reason);
	assert.ok(result.report, "a recovered derivation must contain the report envelope");
	assert.equal(result.report.kind, "recovered-report");
	assert.equal(result.report.status, "recovered");
	assert.equal(result.report.accepted, false, "retrieval must never accept the task");
	assert.equal(result.report.verification, "pending-evidence-verification");
	return result.report;
}

function requireNoReport(result: RecoveryDerivation | RecoveryReadResult, status?: string): void {
	if (status) assert.equal(result.status, status, result.reason);
	assert.notEqual(result.status, "recovered", result.reason);
	assert.equal(result.report, undefined, "unsafe evidence must not leak a recovered report");
}

function freezeDeep<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freezeDeep(child);
		Object.freeze(value);
	}
	return value;
}

interface Fixture { root: string; sessionsDir: string }
function withFixture(fn: (fixture: Fixture) => void): void {
	const root = mkdtempSync(join(tmpdir(), "team-recovery-test-"));
	try {
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir);
		fn({ root, sessionsDir });
	} finally {
		rmSync(root, { recursive: true, force: true });
		assert.equal(existsSync(root), false, "temporary fixture directory must be removed");
	}
}

function putSession(
	fixture: Fixture,
	entries = baseEntries(),
	options: { sessionId?: string; cwdDir?: string; filename?: string; header?: Partial<SessionHeaderLike> } = {},
): string {
	const sessionId = options.sessionId ?? CHILD;
	const dir = join(fixture.sessionsDir, options.cwdDir ?? "--fixture--");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, options.filename ?? `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
	writeFileSync(file, jsonl(entries, { id: sessionId, cwd: fixture.root, ...options.header }), "utf8");
	return file;
}

function readFixture(fixture: Fixture, options: Partial<RecoverChildOptions> = {}): RecoveryReadResult {
	return recoverChildReport(CHILD, { parentSessionId: PARENT, nativeStatus: "interrupted", sessionsDir: fixture.sessionsDir, ...options });
}

// Snapshot bytes, paths, symlink targets, modes, and modification times. Do not
// compare access times: reads may update atime without mutating session contents.
function snapshotTree(root: string): unknown[] {
	const snapshot: unknown[] = [];
	function visit(relative: string): void {
		const file = join(root, relative);
		const stat = lstatSync(file);
		const kind = stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
		snapshot.push({ relative, kind, mode: stat.mode, mtime: stat.mtimeMs,
			...(kind === "file" ? { sha256: createHash("sha256").update(readFileSync(file)).digest("hex") } : {}),
			...(kind === "symlink" ? { target: readlinkSync(file) } : {}) });
		if (kind === "directory") for (const name of readdirSync(file).sort()) visit(join(relative, name));
	}
	visit("");
	return snapshot;
}

// R01: collect the latest clean report, never accept task completion.
test("R01: clean assistant stop after an interrupted marker is recovered, not accepted", () => {
	const parsed = parseSessionJsonl(jsonl());
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	const report = requireReport(derive(parsed.value.entries, { lineById: parsed.value.lineById }));
	assert.equal(report.sessionId, CHILD);
	assert.equal(report.messageId, "report");
	assert.equal(report.entryId, "report");
	assert.equal(report.text, REPORT);
	assert.equal(report.reportAt, baseEntries().at(-1)?.timestamp);
	assert.equal(report.hostStatus, "interrupted", "the observed native status is preserved");
	assert.equal(report.assumedNativeStatus, false);
	assert.deepEqual(report.source, { file: PURE_FILE, line: 9, messageId: "report" });
});

test("R01: only the latest active-branch report is selected; thinking is not report text", () => {
	const entries = chain([...baseEntries(), assistant("new-report", "stop", [
		{ type: "thinking", thinking: "Do not expose this synthetic thought" },
		{ type: "text", text: "  Latest report" }, { type: "text", text: "second paragraph  " },
	])]);
	const report = requireReport(derive(entries, { lineById: { "new-report": 10 } }));
	assert.equal(report.messageId, "new-report");
	assert.equal(report.text, "Latest report\nsecond paragraph");
	assert.equal(report.source.line, 10);
});

test("R01: derivation does not mutate frozen entries, options, or source-line data", () => {
	const entries = freezeDeep(baseEntries());
	const options = freezeDeep({ sessionId: CHILD, file: PURE_FILE, nativeStatus: "interrupted", lineById: { report: 9 } });
	const beforeEntries = structuredClone(entries);
	const beforeOptions = structuredClone(options);
	requireReport(deriveRecoveredReport(entries, options));
	assert.deepEqual(entries, beforeEntries);
	assert.deepEqual(options, beforeOptions);
});

// R02/R03: native completion/live statuses win over report recovery.
for (const nativeStatus of ["completed", "complete"]) {
	test(`R02: observed native ${nativeStatus} is preferred`, () => {
		requireNoReport(derive(undefined, { nativeStatus, assumeStale: true }), "native-completed");
	});
}
test("R02: a native completed result marker newer than the report is preferred", () => {
	const entries = chain([...baseEntries(), marker("completed-later", SUBAGENT_RESULT_TYPE, "completed")]);
	requireNoReport(derive(entries), "native-completed");
});
for (const nativeStatus of ["running", "queued", "starting"]) {
	test(`R03: observed native ${nativeStatus} is not replaced without an explicit stale probe`, () => {
		requireNoReport(derive(undefined, { nativeStatus }), "native-running");
	});
	// The API hand-off permits explicit historical probes. Live tool-result
	// hooks must not pass assumeStale for a current running/queued observation.
	test(`R03: explicit historical ${nativeStatus} probe collects only an unaccepted report`, () => {
		const report = requireReport(derive(undefined, { nativeStatus, assumeStale: true }));
		assert.equal(report.hostStatus, nativeStatus);
		assert.equal(report.assumedNativeStatus, true);
	});
}
for (const nativeStatus of ["failed", "aborted", "interrupted"]) {
	test(`R03: stale observed ${nativeStatus} can yield a report without changing hostStatus`, () => {
		assert.equal(requireReport(derive(undefined, { nativeStatus })).hostStatus, nativeStatus);
	});
}
test("R03: unknown native status is not recoverable without an explicit stale probe", () => {
	requireNoReport(derive(undefined, { nativeStatus: null }), "not-recoverable");
});
for (const status of ["running", "queued"]) {
	test(`R03: explicit unknown-status probe can collect after stale ${status}, not prove live idle`, () => {
		const entries = chain([
			baseEntries()[0], marker("stale-status", SUBAGENT_STATUS_TYPE, status), assistant("report"),
		]);
		const report = requireReport(derive(entries, { nativeStatus: null, assumeStale: true }));
		assert.equal(report.hostStatus, "unknown");
		assert.equal(report.assumedNativeStatus, true);
	});
}

// R04/R05: never fall back to an old report when newer evidence invalidates it.
for (const status of ["running", "queued", "starting"]) {
	test(`R04: newer ${status} marker invalidates an earlier report`, () => {
		requireNoReport(derive(chain([...baseEntries(), marker("later-status", SUBAGENT_STATUS_TYPE, status)])), "no-final-report");
	});
}
for (const status of ["failed", "aborted", "interrupted", "unknown"]) {
	test(`R04: newer ${status} result marker invalidates a pre-interruption report`, () => {
		requireNoReport(derive(chain([...baseEntries(), marker("later-result", SUBAGENT_RESULT_TYPE, status)])), "no-final-report");
	});
}
test("R04: unrelated custom metadata after a clean report does not become report text", () => {
	const report = requireReport(derive(chain([...baseEntries(), marker("unrelated", "fixture:unrelated", "running")])));
	assert.equal(report.messageId, "report");
});
for (const newer of [user("new-user"), toolResult("new-result", "call-a")]) {
	test(`R05: a newer ${newer.message?.role} message invalidates the old report`, () => {
		requireNoReport(derive(chain([...baseEntries(), newer])), "no-final-report");
	});
}
for (const stopReason of ["error", "aborted", "length", "toolUse", "pending", "deferred"]) {
	test(`R05: newer assistant ${stopReason} is not a clean final report`, () => {
		const newer = assistant("new-assistant", stopReason);
		if (stopReason === "error") newer.message!.errorMessage = "Synthetic model error";
		requireNoReport(derive(chain([...baseEntries(), newer])), "no-final-report");
	});
}
test("R05: missing assistant stopReason is not treated as stop", () => {
	const newer = assistant("no-stop");
	delete newer.message!.stopReason;
	requireNoReport(derive(chain([...baseEntries(), newer])), "no-final-report");
});
test("R05: assistant stop containing text plus a toolCall is rejected", () => {
	const newer = assistant("mixed-stop", "stop", [{ type: "text", text: REPORT }, TOOL_A]);
	requireNoReport(derive(chain([...baseEntries(), newer])), "no-final-report");
});
for (const [name, content] of [
	["empty", []], ["whitespace", [{ type: "text", text: " \n\t " }]],
	["thinking-only", [{ type: "thinking", thinking: "Synthetic thought" }]],
	["non-text", [{ type: "image", data: "", mimeType: "image/png" }]],
] as const) {
	test(`R05: ${name} assistant stop is not a report`, () => {
		requireNoReport(derive(chain([...baseEntries(), assistant("no-report", "stop", content)])), "no-final-report");
	});
}

// R06: matching toolCallId, not proximity or duplicate results, settles calls.
test("R06: a mismatched toolCallId cannot settle the outstanding call", () => {
	const entries = baseEntries();
	entries[6].message!.toolCallId = "different-call";
	const result = derive(entries);
	requireNoReport(result, "no-final-report");
	assert.match(result.reason, /outstanding.*call-a/);
});
test("R06: an unidentified tool result cannot settle the outstanding call", () => {
	const entries = baseEntries();
	delete entries[6].message!.toolCallId;
	requireNoReport(derive(entries), "no-final-report");
});
test("R06: toolCallId takes precedence over an unrelated tool-result message id", () => {
	const entries = baseEntries();
	entries[6].message!.id = "unrelated-message-id";
	requireReport(derive(entries));
	entries[6].message!.id = "call-a";
	entries[6].message!.toolCallId = "wrong-call";
	requireNoReport(derive(entries), "no-final-report");
});
test("R06: duplicate receipts for one tool call do not settle a second outstanding call", () => {
	const entries = chain([
		...baseEntries().slice(0, 5),
		assistant("two-calls", "toolUse", [TOOL_A, { ...TOOL_A, id: "call-b" }]),
		toolResult("result-a", "call-a"), toolResult("duplicate-a", "call-a"), assistant("report"),
	]);
	requireNoReport(derive(entries), "no-final-report");
	entries[7].message!.toolCallId = "call-b";
	requireReport(derive(entries));
});
test("R06: a reused tool-call id becomes outstanding again after a new call", () => {
	const entries = chain([...baseEntries().slice(0, -1), assistant("new-call", "toolUse", [TOOL_A]), assistant("report")]);
	requireNoReport(derive(entries), "no-final-report");
});
test("R06: an earlier toolCall without an identity must fail closed, not silently disappear", () => {
	const entries = baseEntries();
	entries[5].message!.content = [{ type: "toolCall", name: "bash", arguments: {} }];
	requireNoReport(derive(entries));
});

// R07: active parentId chain, not abandoned branches or timestamps.
test("R07: a clean report on an abandoned branch is rejected", () => {
	const entries = [...baseEntries(), { ...user("active-user"), parentId: "interrupted", timestamp: new Date(TIME + 99_000).toISOString() }];
	const branch = buildActiveBranch(entries);
	assert.equal(branch.ok, true);
	if (branch.ok) assert.equal(branch.branch.some((entry) => entry.id === "report"), false);
	requireNoReport(derive(entries), "no-final-report");
});
test("R07: abandoned toolCalls and running markers do not invalidate the active report", () => {
	const entries = baseEntries();
	const report = entries.pop()!;
	entries.push(
		{ ...assistant("abandoned-call", "toolUse", [{ ...TOOL_A, id: "abandoned-call-id" }]), parentId: "interrupted" },
		{ ...marker("abandoned-running", SUBAGENT_STATUS_TYPE, "running"), parentId: "abandoned-call" },
		report,
	);
	assert.equal(requireReport(derive(entries)).messageId, "report");
});
for (const [name, change] of [
	["missing parent", (entries: SessionEntryLike[]) => { entries.at(-1)!.parentId = "missing"; }],
	["cycle", (entries: SessionEntryLike[]) => { entries.at(-1)!.parentId = "report"; }],
	["empty parent", (entries: SessionEntryLike[]) => { entries.at(-1)!.parentId = ""; }],
	["duplicate entry id", (entries: SessionEntryLike[]) => { entries[6].id = "report"; }],
] as const) {
	test(`R07: ${name} fails closed`, () => {
		const entries = baseEntries(); change(entries);
		assert.equal(buildActiveBranch(entries).ok, false);
		requireNoReport(derive(entries), "malformed");
	});
}
test("R07: an empty child has no recoverable branch", () => {
	assert.equal(buildActiveBranch([]).ok, false);
	requireNoReport(derive([]), "malformed");
});

// R08: malformed/truncated input must not fall back to a previous good line.
test("R08: BOM, CRLF, and blank lines preserve physical source line numbers", () => {
	const raw = "\uFEFF\r\n" + jsonl().replaceAll("\n", "\r\n");
	const parsed = parseSessionJsonl(raw);
	assert.equal(parsed.ok, true);
	if (!parsed.ok) return;
	assert.equal(parsed.value.header.id, CHILD);
	assert.equal(parsed.value.lineById.get("report"), 10);
	assert.equal(requireReport(derive(parsed.value.entries, { lineById: parsed.value.lineById })).source.line, 10);
});
test("R08: a complete final JSON object without a trailing newline is valid, not truncation", () => {
	assert.equal(parseSessionJsonl(jsonl().trimEnd()).ok, true);
});
for (const [name, raw] of [
	["empty", " \n"], ["missing header", JSON.stringify(user("user"))],
	["duplicate header", jsonl() + JSON.stringify({ type: "session", id: CHILD })],
	["non-object line", jsonl() + "[]\n"],
	["entry without id", jsonl() + JSON.stringify({ type: "custom", parentId: "report" })],
	["duplicate entry id", jsonl() + JSON.stringify({ type: "custom", id: "report", parentId: "report" })],
	["truncated final JSON", jsonl().slice(0, -8)],
	["malformed tail after good report", jsonl() + '{"type":"message",'],
] as const) {
	test(`R08: ${name} JSONL is rejected`, () => {
		const parsed = parseSessionJsonl(raw);
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.ok(parsed.error.length > 0);
	});
}

// R09/R10/R11: bounded exact-path discovery, ownership, fresh read, no writes.
test("R09: IO report has the actual temporary file/line and preserves all fixture bytes", () => {
	withFixture((fixture) => {
		const file = putSession(fixture);
		const before = snapshotTree(fixture.root);
		const report = requireReport(readFixture(fixture));
		assert.deepEqual(report.source, { file, line: 9, messageId: "report" });
		assert.equal(report.hostStatus, "interrupted");
		assert.deepEqual(snapshotTree(fixture.root), before);
	});
});
test("R09: exact plain-id filenames and timestamp_id filenames are supported", () => {
	withFixture((fixture) => {
		const plain = putSession(fixture, undefined, { filename: `${CHILD}.jsonl` });
		assert.deepEqual(resolveChildSessionFile(CHILD, fixture.sessionsDir), { status: "found", file: plain });
	});
});
test("R09: partial-id, direct-root, and deeper-than-one-cwd files are not selected", () => {
	withFixture((fixture) => {
		putSession(fixture, undefined, { filename: `2026-01-01_${CHILD}-extra.jsonl` });
		putSession(fixture, undefined, { filename: `${CHILD}.jsonl.backup` });
		writeFileSync(join(fixture.sessionsDir, `${CHILD}.jsonl`), jsonl());
		putSession(fixture, undefined, { cwdDir: "--fixture--/nested", filename: `${CHILD}.jsonl` });
		assert.equal(resolveChildSessionFile(CHILD, fixture.sessionsDir).status, "unknown");
		requireNoReport(readFixture(fixture), "unknown-session");
	});
});
for (const sameDir of [false, true]) {
	test(`R09: duplicate paths ${sameDir ? "inside one cwd" : "across cwd directories"} are ambiguous`, () => {
		withFixture((fixture) => {
			const first = putSession(fixture);
			const second = putSession(fixture, undefined, { cwdDir: sameDir ? "--fixture--" : "--other--", filename: `${CHILD}.jsonl` });
			const result = resolveChildSessionFile(CHILD, fixture.sessionsDir);
			assert.equal(result.status, "ambiguous");
			if (result.status === "ambiguous") assert.deepEqual(new Set(result.files), new Set([first, second]));
			requireNoReport(readFixture(fixture), "ambiguous");
		});
	});
}
test("R09: symlink files and symlink cwd directories cannot select an outside-root child", () => {
	withFixture((fixture) => {
		const outside = join(fixture.root, "outside-sessions");
		mkdirSync(outside);
		const target = join(outside, `${CHILD}.jsonl`);
		writeFileSync(target, jsonl());
		const cwd = join(fixture.sessionsDir, "--links--"); mkdirSync(cwd);
		symlinkSync(target, join(cwd, `${CHILD}.jsonl`));
		symlinkSync(outside, join(fixture.sessionsDir, "--linked-cwd--"), "dir");
		const before = snapshotTree(fixture.root);
		assert.equal(resolveChildSessionFile(CHILD, fixture.sessionsDir).status, "unknown");
		requireNoReport(readFixture(fixture), "unknown-session");
		assert.deepEqual(snapshotTree(fixture.root), before);
	});
});
test("R09: an ignored symlink is not a second receipt/path beside a unique real child", () => {
	withFixture((fixture) => {
		const file = putSession(fixture);
		const dir = join(fixture.sessionsDir, "--links--"); mkdirSync(dir);
		symlinkSync(file, join(dir, `${CHILD}.jsonl`));
		assert.deepEqual(resolveChildSessionFile(CHILD, fixture.sessionsDir), { status: "found", file });
	});
});
test("R09: missing directories and unsafe ids fail closed without filesystem mutations", () => {
	withFixture((fixture) => {
		const before = snapshotTree(fixture.root);
		assert.equal(resolveChildSessionFile(CHILD, join(fixture.root, "missing")).status, "unknown");
		assert.equal(resolveChildSessionFile("../escape", fixture.sessionsDir).status, "invalid");
		requireNoReport(recoverChildReport("../escape", { parentSessionId: PARENT, nativeStatus: "interrupted", sessionsDir: fixture.sessionsDir }), "file-error");
		assert.deepEqual(snapshotTree(fixture.root), before);
	});
});
test("R10: custom subagent metadata, not a claimed header parent, determines ownership", () => {
	withFixture((fixture) => {
		const entries = baseEntries();
		(entries[0].data as Record<string, unknown>).parentSessionId = FOREIGN_PARENT;
		putSession(fixture, entries, { header: { parentSession: PARENT } });
		const before = snapshotTree(fixture.root);
		requireNoReport(readFixture(fixture), "foreign-parent");
		assert.deepEqual(snapshotTree(fixture.root), before);
	});
});
test("R10: missing subagent metadata and unavailable current parent are rejected", () => {
	withFixture((fixture) => {
		const entries = baseEntries(); entries[0].customType = "fixture:not-a-subagent";
		putSession(fixture, entries);
		requireNoReport(readFixture(fixture), "foreign-parent");
		requireNoReport(readFixture(fixture, { parentSessionId: " " }), "foreign-parent");
	});
});
for (const [name, data] of [
	["non-object", null], ["wrong version", { version: 2, parentSessionId: PARENT }],
	["missing parent", { version: 1 }],
] as const) {
	test(`R10: ${name} subagent metadata is malformed`, () => {
		withFixture((fixture) => {
			const entries = baseEntries(); entries[0].data = data;
			putSession(fixture, entries);
			requireNoReport(readFixture(fixture), "malformed");
		});
	});
}
test("R10: conflicting foreign metadata is rejected even if off the active branch", () => {
	withFixture((fixture) => {
		const entries = baseEntries(); const report = entries.pop()!;
		entries.push({ type: "custom", id: "foreign-meta", parentId: null, customType: SUBAGENT_META_TYPE,
			data: { version: 1, parentSessionId: FOREIGN_PARENT } }, report);
		putSession(fixture, entries);
		requireNoReport(readFixture(fixture), "foreign-parent");
	});
});
test("R10: filename/header session-id mismatch is malformed, not another child's report", () => {
	withFixture((fixture) => {
		putSession(fixture, undefined, { header: { id: OTHER_CHILD } });
		requireNoReport(readFixture(fixture), "malformed");
	});
});
test("R10: a genuinely truncated tail cannot recover the previous clean report through IO", () => {
	withFixture((fixture) => {
		const file = putSession(fixture);
		writeFileSync(file, jsonl() + '{"type":"message","id":"incomplete"');
		const before = snapshotTree(fixture.root);
		requireNoReport(readFixture(fixture), "malformed");
		assert.deepEqual(snapshotTree(fixture.root), before);
	});
});
test("R11: repeated fresh reads are deterministic and do not append receipts or write fixtures", () => {
	withFixture((fixture) => {
		const file = putSession(fixture);
		const before = snapshotTree(fixture.root);
		const first = readFixture(fixture);
		const second = readFixture(fixture);
		assert.deepEqual(second, first);
		const report = requireReport(first);
		assert.equal(recoveryKey(report.sessionId, report.messageId), recoveryKey(CHILD, "report"));
		assert.deepEqual(snapshotTree(fixture.root), before);
		// This write is test-controlled and inside its temporary fixture only.
		writeFileSync(file, jsonl(chain([...baseEntries(), user("new-work")])));
		const changedByTest = snapshotTree(fixture.root);
		requireNoReport(readFixture(fixture), "no-final-report");
		assert.deepEqual(snapshotTree(fixture.root), changedByTest, "fresh read must not reuse a cached report or write a new receipt");
	});
});
test("R11: temporary fixtures are cleaned even when their callback throws", () => {
	let root = "";
	assert.throws(() => withFixture((fixture) => {
		root = fixture.root; putSession(fixture); throw new Error("Synthetic fixture failure");
	}), /Synthetic fixture failure/);
	assert.equal(existsSync(root), false);
});

// R12: identifier/status helpers used by orchestration; no production reads.
test("R12: session-id validation prevents path traversal and invalid candidates", () => {
	for (const valid of [CHILD, "custom-session_01", "session.v3"]) assert.equal(isSafeSessionId(valid), true);
	for (const invalid of ["", "../escape", "a/b", "a\\b", ".hidden", "a..b", "a\n", "x".repeat(161), null, 123, {}]) {
		assert.equal(isSafeSessionId(invalid), false, `must reject ${JSON.stringify(invalid)}`);
	}
});
test("R12: status normalization and recoverability distinguish native completion/live/unknown", () => {
	for (const [input, expected] of [[" complete ", "completed"], ["starting", "running"], ["queued", "queued"],
		["ERROR", "failed"], ["cancelled", "aborted"], ["interrupted", "interrupted"], ["unrecognized", "unknown"], [null, "unknown"]] as const) {
		assert.equal(normalizeNativeStatus(input), expected);
		assert.equal(isRecoverableNativeStatus(input), ["failed", "aborted", "interrupted"].includes(expected));
	}
});
test("R12: a non-error interrupted native result remains interrupted, not completed", () => {
	assert.equal(inferNativeStatus({ status: "interrupted" }, false, "Synthetic result"), "interrupted");
	assert.equal(inferNativeStatus({ status: "completed" }, true, "Result wait aborted"), "completed");
	assert.equal(inferNativeStatus({}, true, "Result wait aborted"), "aborted");
	assert.equal(inferNativeStatus(null, true, "Wait timed out"), "interrupted");
	assert.equal(inferNativeStatus(null, true, "Synthetic error"), "failed");
	assert.equal(inferNativeStatus(null, false, "completed"), "unknown", "success-looking prose is not a native completed status");
});
test("R12: known child ids come from subagent tool results/team-run, are safe, and are deduplicated", () => {
	const parentEntries = [
		{ type: "message", message: { role: "toolResult", toolName: "Agent", details: { sessionId: CHILD }, content: [] } },
		{ type: "message", message: { role: "toolResult", toolName: "get_subagent_result", details: { subagentSessionId: OTHER_CHILD }, content: [{ type: "text", text: `Subagent ${CHILD}; another ${OTHER_CHILD}` }] } },
		{ type: "message", message: { role: "toolResult", toolName: "STEER_SUBAGENT", details: { sessionId: CHILD }, content: [] } },
		{ type: "message", message: { role: "toolResult", toolName: "Agent", details: { sessionId: "../unsafe" }, content: [] } },
		{ type: "message", message: { role: "toolResult", toolName: "bash", details: { sessionId: FOREIGN_PARENT }, content: [{ type: "text", text: FOREIGN_PARENT }] } },
		{ type: "message", message: { role: "assistant", content: [{ type: "text", text: FOREIGN_PARENT }] } },
		{ type: "message", message: { role: "user", content: FOREIGN_PARENT } },
		{ type: "custom", customType: "team-run", data: { sessionId: RECORDED_CHILD, status: "interrupted" } },
		{ type: "custom", customType: "fixture:unrelated", data: { sessionId: FOREIGN_PARENT } },
	];
	const before = structuredClone(parentEntries);
	assert.deepEqual(collectKnownChildSessionIds(parentEntries), [CHILD, OTHER_CHILD, RECORDED_CHILD]);
	assert.deepEqual(parentEntries, before);
	const text = `Subagent ${CHILD}; again ${CHILD}; other ${OTHER_CHILD}`;
	assert.equal(extractSessionIdFromText(text), CHILD);
	assert.deepEqual(extractSessionIdFromTextAll(text), [CHILD, OTHER_CHILD]);
	assert.equal(extractSessionIdFromText("No child identifier"), undefined);
});
test("R12: recovery identity is stable per child/message, distinct for different reports", () => {
	assert.equal(recoveryKey(CHILD, "report"), `${CHILD}::report`);
	assert.equal(recoveryKey(CHILD, "report"), recoveryKey(CHILD, "report"));
	assert.notEqual(recoveryKey(CHILD, "report"), recoveryKey(CHILD, "new-report"));
	assert.notEqual(recoveryKey(CHILD, "report"), recoveryKey(OTHER_CHILD, "report"));
});
test("R02b: native-completed preserves nativeReportText without breaking report===undefined", () => {
	const entries = chain([...baseEntries(), marker("completed-later", SUBAGENT_RESULT_TYPE, "completed")]);
	const res = derive(entries);
	assert.equal(res.status, "native-completed");
	assert.equal(res.report, undefined);
	assert.ok(typeof res.nativeReportText === "string" && res.nativeReportText.trim().length > 0, "nativeReportText must retain the final assistant report for review/deterministic settling");
});
test("R12: default directory selection is a pure path operation with environment restored", () => {
	withFixture((fixture) => {
		const before = snapshotTree(fixture.root);
		const previous = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = fixture.root;
			assert.equal(defaultSessionsDir(), fixture.sessionsDir);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
		}
		assert.equal(process.env.PI_CODING_AGENT_DIR, previous);
		assert.deepEqual(snapshotTree(fixture.root), before);
	});
});
