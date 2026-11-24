/**
 * team-recovery.ts — read-only recovery of a child agent's final report.
 *
 * This helper never resumes, aborts, re-dispatches, or mutates a child session.
 * It only resolves a persisted child JSONL by exact session ID, reads it fresh
 * from disk, validates that it belongs to the current parent, and reconstructs
 * the latest clean assistant report on the active branch.
 *
 * A recovered report is evidence for orchestration/verification. It is NOT
 * task acceptance, proof that the child is idle, or a substitute for checking
 * artifacts and test output. Recovery never proves terminal process exit:
 * terminal claims are reported separately as attempt-bound provenance, a
 * report carries `accepted:false` / `terminalExitProof:false`, and unreadable,
 * oversized, ambiguous or truncated evidence is "uncertain" — never completed.
 */

import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	opendirSync,
	readSync,
	realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";

/**
 * Hard bound for one recovery read. A child JSONL larger than this cannot be
 * authenticated within bounded memory, so recovery degrades to "uncertain"
 * evidence instead of reading the whole file or claiming completion.
 */
export const RECOVERY_MAX_SESSION_BYTES = 16 * 1024 * 1024;
/** Hard bound for the number of parsed JSONL entries in one recovery read. */
export const RECOVERY_MAX_ENTRIES = 50_000;
/** Bounded retention for the resolved-path cache: at most this many roots/sessions. */
export const SESSION_PATH_CACHE_LIMIT = 256;
/** Roots with more child directories than this are never cached (fail closed to a rescan). */
export const SESSION_PATH_CACHE_MAX_DIRS = 64;
/** A cached path is revalidated before use and expires after this many milliseconds. */
export const SESSION_PATH_CACHE_TTL_MS = 20_000;

/**
 * Bounded discovery budgets. A resolution never materializes an unbounded
 * directory listing: every child directory, every directory entry and every
 * candidate inspection is charged to hard caps, and the directory cap is
 * exactly the cache-admission threshold so the 64-directory threshold bounds
 * the actual scan work too. A scan that cannot finish inside the budgets
 * proves nothing about uniqueness: it fails closed to "unknown" and is never
 * cached.
 */
export const SESSION_PATH_SCAN_MAX_DIRS = SESSION_PATH_CACHE_MAX_DIRS;
export const SESSION_PATH_SCAN_MAX_ENTRIES = 16_384;
export const SESSION_PATH_SCAN_MAX_WORK = 20_000;

export const SUBAGENT_META_TYPE = "pi-web:subagent";
export const SUBAGENT_STATUS_TYPE = "pi-web:subagent-status";
export const SUBAGENT_RESULT_TYPE = "pi-web:subagent-result";

export type NativeStatus =
	| "completed"
	| "failed"
	| "aborted"
	| "interrupted"
	| "running"
	| "queued"
	| "starting"
	| "unknown";

export interface SessionHeaderLike {
	type: "session";
	id: string;
	version?: number;
	timestamp?: string;
	cwd?: string;
	parentSession?: string;
	[key: string]: unknown;
}

export interface SessionEntryLike {
	type?: string;
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		content?: unknown;
		stopReason?: string;
		errorMessage?: string;
		timestamp?: number;
		toolCallId?: string;
		details?: unknown;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export interface ParsedSessionJsonl {
	header: SessionHeaderLike;
	entries: SessionEntryLike[];
	lineById: Map<string, number>;
}

export type ParseSessionResult =
	| { ok: true; value: ParsedSessionJsonl }
	| { ok: false; error: string };

export interface RecoverySource {
	file: string;
	line: number;
	messageId: string;
}

export interface RecoveredReport {
	kind: "recovered-report";
	/** A report was recovered. This is not accepted task completion. */
	status: "recovered";
	accepted: false;
	verification: "pending-evidence-verification";
	sessionId: string;
	messageId: string;
	entryId: string;
	reportAt: string;
	text: string;
	content?: string;
	/** Native status observed by the caller (host status remains untouched). */
	hostStatus: string;
	source: RecoverySource;
	/** True only for an explicit read-only probe with no known native status. */
	assumedNativeStatus: boolean;
	/** True only when the report message is provably part of the requested execution attempt. */
	attemptBound: boolean;
	/** A recovered report never proves that the child process exited. */
	terminalExitProof: false;
}

export type RecoveryDerivationStatus =
	| "recovered"
	| "native-completed"
	| "native-running"
	| "no-final-report"
	| "not-recoverable"
	| "malformed";

/**
 * Provenance for one terminal claim. `boundToAttempt` is true only when the
 * observed evidence can be attributed to the requested execution attempt
 * (a valid timestamp at/after the attempt cutoff, no conflicting run binding,
 * and no newer live activity). Nothing here is inferred from reason prose.
 */
export interface TerminalEvidence {
	kind: "result-marker" | "status-marker" | "assistant-stop" | "host-status";
	status: string;
	entryId?: string;
	at?: string;
	boundToAttempt: boolean;
	/** True only for a clean terminal completion; a failure/interruption is not a clean exit. */
	clean: boolean;
}

export interface RecoveryDerivation {
	status: RecoveryDerivationStatus;
	reason: string;
	hostStatus: string;
	report?: RecoveredReport;
	/** Final assistant report text observed on disk even when native completion wins over recovery. */
	nativeReportText?: string;
	/** Bash commands actually executed (with toolResult) in the child's active branch for this attempt. */
	observedCommands?: string[];
	/**
	 * Terminal evidence observed for this attempt. Present only when the derivation
	 * itself classified a terminal state; an unbound marker never becomes terminal
	 * evidence, and a recovered report never produces one.
	 */
	terminal?: TerminalEvidence;
	/** True only with attempt-bound clean terminal evidence (never from report recovery alone). */
	cleanExit?: boolean;
	/** Evidence is missing, unreadable, ambiguous or truncated: fail closed, claim nothing. */
	uncertain?: boolean;
	/** The session file exceeded the bounded read limit; only a prefix was inspected. */
	truncated?: boolean;
}

export interface DeriveRecoveredReportOptions {
	sessionId: string;
	file: string;
	nativeStatus?: string | null;
	/** Explicit /team reconcile probe: an unknown native status may be treated as stale. */
	assumeStale?: boolean;
	lineById?: Map<string, number> | Record<string, number>;
	/** Reject reports/markers that belong to an earlier execution attempt. */
	reportNotBefore?: string;
	/** Optional run identity used to reject markers that belong to a different run. */
	runId?: string;
	/** Optional attempt identity used to reject markers that belong to a different attempt. */
	attemptId?: string;
}

export type ResolveChildResult =
	| { status: "found"; file: string }
	| { status: "unknown" | "ambiguous" | "invalid"; reason: string; files?: string[] };

export type RecoveryReadStatus =
	| RecoveryDerivationStatus
	| "unknown-session"
	| "ambiguous"
	| "foreign-parent"
	| "file-error";

export interface RecoveryReadResult {
	status: RecoveryReadStatus;
	reason: string;
	sessionId: string;
	file?: string;
	hostStatus?: string;
	report?: RecoveredReport;
	nativeReportText?: string;
	observedCommands?: string[];
	terminal?: TerminalEvidence;
	cleanExit?: boolean;
	/** No decisive attempt evidence (unreadable/ambiguous/oversized/truncated/live): claim nothing. */
	uncertain?: boolean;
	/** The bounded read limit stopped the read; only a prefix of the file was inspected. */
	truncated?: boolean;
	/** Bytes inspected, when a bounded read was attempted. */
	byteLength?: number;
}

export interface RecoverChildOptions {
	parentSessionId: string;
	nativeStatus?: string | null;
	assumeStale?: boolean;
	sessionsDir?: string;
	reportNotBefore?: string;
	/** Optional run identity: markers bound to another run cannot prove this attempt ended. */
	runId?: string;
	/** Optional attempt identity: markers bound to another attempt cannot prove this attempt ended. */
	attemptId?: string;
	/** Override the bounded session read limit (bytes). */
	maxSessionBytes?: number;
	/** Override the bounded parsed-entry limit. */
	maxEntries?: number;
}

export interface KnownSessionStatus {
	sessionId: string;
	status: string;
	at: string;
	description?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function defaultSessionsDir(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "sessions");
}

export function recoveryKey(sessionId: string, messageId: string): string {
	return `${sessionId}::${messageId}`;
}

export function isSafeSessionId(sessionId: unknown): sessionId is string {
	return (
		typeof sessionId === "string" &&
		sessionId.length > 0 &&
		sessionId.length <= 160 &&
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) &&
		!sessionId.includes("..")
	);
}

export function normalizeNativeStatus(value: unknown): NativeStatus {
	const text = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (!text) return "unknown";
	if (text === "completed" || text === "complete") return "completed";
	if (text === "running" || text === "starting") return "running";
	if (text === "queued") return "queued";
	if (text === "interrupted" || text.includes("interrupt")) return "interrupted";
	if (text === "aborted" || text.includes("abort") || text.includes("cancel")) return "aborted";
	if (text === "failed" || text === "error" || text.includes("fail")) return "failed";
	return "unknown";
}

export function isRecoverableNativeStatus(value: unknown): boolean {
	const status = normalizeNativeStatus(value);
	return status === "interrupted" || status === "aborted" || status === "failed";
}

/** Infer host status without turning a non-error "interrupted" get_subagent_result into success. */
export function inferNativeStatus(details: unknown, isError: boolean, contentText: string): NativeStatus {
	if (isObject(details)) {
		const direct = asString(details.status);
		if (direct) return normalizeNativeStatus(direct);
	}
	if (!isError) return "unknown";
	const text = contentText ?? "";
	if (/interrupt/i.test(text)) return "interrupted";
	if (/abort|cancel/i.test(text)) return "aborted";
	if (/timed?\s*out|timeout/i.test(text)) return "interrupted";
	return "failed";
}

/** Extract UUID-shaped session IDs from host error/status text. */
export function extractSessionIdFromText(text: string): string | undefined {
	const match = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(text ?? "");
	return match?.[0];
}

export function extractSessionIdFromTextAll(text: string): string[] {
	const found = (text ?? "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
	return [...new Set(found)];
}

export interface ParseSessionLimits {
	/** Maximum number of parsed entries; exceeding it fails closed instead of growing unbounded. */
	maxEntries?: number;
	/** Maximum raw input length in characters. */
	maxChars?: number;
}

/**
 * Parse a session JSONL with bounded work. An over-limit input is rejected
 * ("truncated evidence") rather than partially accepted: a prefix of a session
 * must never be mistaken for a complete attempt.
 */
export function parseSessionJsonl(raw: string, limits: ParseSessionLimits = {}): ParseSessionResult {
	const text = String(raw ?? "").replace(/^\uFEFF/, "");
	const maxChars = typeof limits.maxChars === "number" && Number.isFinite(limits.maxChars) && limits.maxChars > 0
		? Math.floor(limits.maxChars)
		: RECOVERY_MAX_SESSION_BYTES;
	if (text.length > maxChars) return { ok: false, error: `session file exceeds bounded parse limit (${text.length} > ${maxChars} chars)` };
	const maxEntries = typeof limits.maxEntries === "number" && Number.isFinite(limits.maxEntries) && limits.maxEntries > 0
		? Math.floor(limits.maxEntries)
		: RECOVERY_MAX_ENTRIES;
	const lines = text.split(/\r?\n/);
	const entries: SessionEntryLike[] = [];
	const lineById = new Map<string, number>();
	let header: SessionHeaderLike | undefined;

	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			return { ok: false, error: `malformed JSONL at line ${i + 1}` };
		}
		if (!isObject(value)) return { ok: false, error: `non-object JSONL at line ${i + 1}` };
		const entry = value as SessionEntryLike;

		if (!header) {
			if (entry.type !== "session" || typeof entry.id !== "string" || !entry.id) {
				return { ok: false, error: `missing session header at line ${i + 1}` };
			}
			header = entry as SessionHeaderLike;
			continue;
		}

		if (entry.type === "session") return { ok: false, error: `duplicate session header at line ${i + 1}` };
		if (typeof entry.id !== "string" || !entry.id) {
			return { ok: false, error: `entry without id at line ${i + 1}` };
		}
		if (lineById.has(entry.id)) return { ok: false, error: `duplicate entry id ${entry.id}` };
		if (entries.length >= maxEntries) {
			return { ok: false, error: `session exceeds bounded entry limit (${maxEntries}) at line ${i + 1}` };
		}
		lineById.set(entry.id, i + 1);
		entries.push(entry);
	}

	if (!header) return { ok: false, error: "empty session file" };
	return { ok: true, value: { header, entries, lineById } };
}

type BranchResult = { ok: true; branch: SessionEntryLike[] } | { ok: false; error: string };

/** Reconstruct the active branch from the last entry, not from abandoned branches. */
export function buildActiveBranch(entries: SessionEntryLike[]): BranchResult {
	if (!Array.isArray(entries) || entries.length === 0) return { ok: false, error: "session has no entries" };
	const byId = new Map<string, SessionEntryLike>();
	for (const entry of entries) {
		if (typeof entry.id !== "string" || !entry.id) return { ok: false, error: "entry without id" };
		if (byId.has(entry.id)) return { ok: false, error: `duplicate entry id ${entry.id}` };
		byId.set(entry.id, entry);
	}

	let current: SessionEntryLike | undefined = entries[entries.length - 1];
	const path: SessionEntryLike[] = [];
	const seen = new Set<string>();
	while (current) {
		if (typeof current.id !== "string") return { ok: false, error: "active branch entry without id" };
		if (seen.has(current.id)) return { ok: false, error: `cycle in active branch at ${current.id}` };
		seen.add(current.id);
		path.push(current);
		const parentId = current.parentId;
		if (parentId === null || parentId === undefined) break;
		if (typeof parentId !== "string" || !parentId) return { ok: false, error: `invalid parentId at ${current.id}` };
		const parent = byId.get(parentId);
		if (!parent) return { ok: false, error: `active branch references missing parent ${parentId}` };
		current = parent;
	}
	path.reverse();
	return { ok: true, branch: path };
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isObject(block) || block.type !== "text") continue;
		if (typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}

function hasToolCall(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some((block) => isObject(block) && block.type === "toolCall");
}

function toolCallId(block: unknown): string | undefined {
	if (!isObject(block) || block.type !== "toolCall") return undefined;
	return asString(block.id) ?? asString(block.toolCallId);
}

function toolResultCallId(message: SessionEntryLike["message"]): string | undefined {
	return asString(message?.toolCallId) ?? asString(message?.id);
}

function lineFor(lineById: Map<string, number> | Record<string, number> | undefined, id: string): number {
	if (!lineById) return 0;
	if (lineById instanceof Map) return lineById.get(id) ?? 0;
	return typeof lineById[id] === "number" ? lineById[id] : 0;
}

/**
 * Attempt identity supplied by the caller. Only these values may bind observed
 * markers/messages to the current execution attempt; nothing is inferred from
 * prose, proximity or a missing timestamp.
 */
interface AttemptIdentity {
	/** Epoch-ms cutoff from `reportNotBefore`; undefined when no cutoff was requested. */
	cutoff?: number;
	/** A cutoff was requested but is not a finite timestamp: no entry can satisfy it. */
	cutoffInvalid: boolean;
	runIds: Set<string>;
	attemptIds: Set<string>;
}

function attemptIdentity(options: { reportNotBefore?: string; runId?: string; attemptId?: string }): AttemptIdentity {
	const cutoffText = asString(options.reportNotBefore);
	const parsedCutoff = cutoffText ? Date.parse(cutoffText) : Number.NaN;
	const runId = asString(options.runId);
	const attemptId = asString(options.attemptId);
	return {
		cutoff: Number.isFinite(parsedCutoff) ? parsedCutoff : undefined,
		cutoffInvalid: Boolean(cutoffText) && !Number.isFinite(parsedCutoff),
		runIds: new Set(runId ? [runId] : []),
		attemptIds: new Set(attemptId ? [attemptId] : []),
	};
}

function identityRequested(identity: AttemptIdentity): boolean {
	return identity.cutoff !== undefined || identity.cutoffInvalid || identity.runIds.size > 0 || identity.attemptIds.size > 0;
}

/** Epoch ms for an entry timestamp; undefined when missing or not a finite instant. */
function entryTimeMs(entry: SessionEntryLike | undefined): number | undefined {
	const text = asString(entry?.timestamp);
	if (!text) return undefined;
	const ms = Date.parse(text);
	return Number.isFinite(ms) ? ms : undefined;
}

function markerAttemptRefs(entry: SessionEntryLike): { runId?: string; attemptId?: string } {
	if (!isObject(entry.data)) return {};
	const runId = asString(entry.data.runId);
	const attemptId = asString(entry.data.attemptId);
	return {
		...(runId ? { runId } : {}),
		...(attemptId ? { attemptId } : {}),
	};
}

/**
 * Bind one observed entry to the requested attempt.
 * - `foreign`: the entry declares a different run/attempt id, so it cannot
 *   describe this attempt at all.
 * - `unbound`: a cutoff was requested and the entry has a missing/invalid
 *   timestamp or a timestamp before the cutoff. A missing or invalid timestamp
 *   never satisfies a cutoff.
 * - `bound`: the entry is attributable to the requested attempt. When the
 *   caller supplies no attempt identity at all there is nothing to bind against.
 * `context` is the nearest *declared* attempt context before this entry: an
 * entry that carries no run/attempt identity of its own cannot silently inherit
 * a conflicting context (for example an untagged report that follows a
 * foreign-run running marker).
 */
function bindEntryToAttempt(
	entry: SessionEntryLike,
	identity: AttemptIdentity,
	context: "bound" | "foreign" | "unknown" = "unknown",
): "bound" | "unbound" | "foreign" {
	const refs = markerAttemptRefs(entry);
	if (refs.runId && identity.runIds.size > 0 && !identity.runIds.has(refs.runId)) return "foreign";
	if (refs.attemptId && identity.attemptIds.size > 0 && !identity.attemptIds.has(refs.attemptId)) return "foreign";
	if (!refs.runId && !refs.attemptId && context === "foreign") return "foreign";
	if (identity.cutoffInvalid) return "unbound";
	if (identity.cutoff !== undefined) {
		const at = entryTimeMs(entry);
		if (at === undefined || at < identity.cutoff) return "unbound";
	}
	return "bound";
}

/**
 * Nearest declared run/attempt context *before* `index` in this branch.
 *
 * Only entries that explicitly declare a runId/attemptId can establish a
 * context. The result is used for entries that declare nothing: they may be
 * attributed to the requested attempt only when the closest declared context is
 * not a conflicting one (`unknown` = nothing declared, so only the cutoff applies).
 */
function declaredContextBefore(
	branch: SessionEntryLike[],
	index: number,
	identity: AttemptIdentity,
): "bound" | "foreign" | "unknown" {
	const limit = Math.min(index, branch.length);
	for (let i = limit - 1; i >= 0; i -= 1) {
		const refs = markerAttemptRefs(branch[i]);
		if (!refs.runId && !refs.attemptId) continue;
		// Every comparable declared identity must be validated before this context can
		// be attributed to the requested attempt: a matching run that carries a
		// conflicting attempt id (or vice versa) is a conflicting context, never
		// "bound" — an untagged successor must not inherit it.
		let compared = false;
		if (refs.runId && identity.runIds.size > 0) {
			compared = true;
			if (!identity.runIds.has(refs.runId)) return "foreign";
		}
		if (refs.attemptId && identity.attemptIds.size > 0) {
			compared = true;
			if (!identity.attemptIds.has(refs.attemptId)) return "foreign";
		}
		// A declared identity exists but the caller supplied nothing comparable.
		return compared ? "bound" : "unknown";
	}
	return "unknown";
}

/**
 * Exact terminal-failure marker statuses. The host marker vocabulary is
 * {completed, failed, aborted, interrupted}; only the canonical failure words
 * count as terminal failure evidence. Substring lookalikes ("failover-pending",
 * "not-failed-yet", "abort-request-pending", "interrupt-pending", ...) are
 * unrecognized and must stay uncertain, never terminal failure evidence.
 */
const TERMINAL_FAILURE_MARKER_STATUSES = new Set(["interrupted", "aborted", "failed"]);
function isTerminalFailureStatus(value: string): boolean {
	const status = typeof value === "string" ? value.trim().toLowerCase() : "";
	return TERMINAL_FAILURE_MARKER_STATUSES.has(status);
}

function collectObservedCommands(branch: SessionEntryLike[], reportIndex: number, identity: AttemptIdentity): string[] {
	const completedCallIds = new Set<string>();
	for (let i = 0; i <= reportIndex; i += 1) {
		const entry = branch[i];
		if (entry.type === "message" && isObject(entry.message) && entry.message.role === "toolResult") {
			const id = toolResultCallId(entry.message);
			if (id) completedCallIds.add(id);
		}
	}
	const commands: string[] = [];
	const seen = new Set<string>();
	for (let i = 0; i <= reportIndex; i += 1) {
		const entry = branch[i];
		if (entry.type !== "message" || !isObject(entry.message) || entry.message.role !== "assistant") continue;
		if (identityRequested(identity)) {
			const at = entryTimeMs(entry);
			// Command evidence outside the attempt window is not this attempt's evidence:
			// a missing or invalid timestamp never satisfies the cutoff.
			if (identity.cutoffInvalid || at === undefined) continue;
			if (identity.cutoff !== undefined && at < identity.cutoff) continue;
		}
		const content = Array.isArray(entry.message.content) ? entry.message.content : [];
		for (const block of content) {
			if (!isObject(block) || block.type !== "toolCall") continue;
			const name = asString(block.name)?.toLowerCase();
			if (name !== "bash") continue;
			const callId = asString(block.id);
			if (callId && !completedCallIds.has(callId)) continue;
			const args = isObject(block.arguments) ? block.arguments : undefined;
			const cmd = asString(args?.command) ?? asString(args?.cmd);
			if (cmd && cmd.trim() && !seen.has(cmd.trim())) {
				seen.add(cmd.trim());
				commands.push(cmd.trim());
			}
		}
	}
	return commands;
}

function markerStatus(entry: SessionEntryLike): string | undefined {
	if (!isObject(entry.data)) return undefined;
	return asString(entry.data.status);
}

/**
 * Pure derivation from parsed child entries. The caller supplies the native
 * host status observed for this child; this function never mutates state.
 */
export function deriveRecoveredReport(
	entries: SessionEntryLike[],
	options: DeriveRecoveredReportOptions,
): RecoveryDerivation {
	const cleanEntries = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.type !== "session");
	const active = buildActiveBranch(cleanEntries);
	if (!active.ok) return { status: "malformed", reason: active.error, hostStatus: "malformed", uncertain: true };

	const identity = attemptIdentity(options);
	const hostStatus = asString(options.nativeStatus) ?? "unknown";
	const normalized = normalizeNativeStatus(hostStatus);
	const assumedNativeStatus = options.assumeStale === true &&
		(normalized === "unknown" || normalized === "running" || normalized === "queued");
	const effective = assumedNativeStatus ? "interrupted" : normalized;

	if (effective === "completed" && !identityRequested(identity)) {
		// The caller's host status is the only evidence here and no attempt window was
		// supplied. A session-level "completed" may describe an older attempt of a
		// reused child (report -> completed -> running), so it is recorded strictly as
		// an unattributed host observation: it can carry a native result text, but it
		// never proves a terminal exit for the current attempt.
		return {
			status: "native-completed",
			reason: "native result is completed; native result is preferred (host status only, not attempt-bound)",
			hostStatus,
			terminal: { kind: "host-status", status: hostStatus, boundToAttempt: false, clean: false },
			uncertain: true,
		};
	}
	if (effective === "running" || effective === "queued") {
		return { status: "native-running", reason: `native result is ${effective}; a running/queued child is never replaced`, hostStatus, uncertain: true };
	}
	// A session-level completed observation may predate a resumed attempt.
	// With an attempt cutoff, validate the actual current child branch/report below.
	if (!isRecoverableNativeStatus(effective) && effective !== "completed") {
		return { status: "not-recoverable", reason: `native status ${hostStatus} is not interrupted/aborted/failed`, hostStatus, uncertain: true };
	}

	const branch = active.branch;
	let reportIndex = -1;
	let reportEntry: SessionEntryLike | undefined;
	for (let i = 0; i < branch.length; i += 1) {
		if (branch[i].type === "message") {
			reportIndex = i;
			reportEntry = branch[i];
		}
	}
	if (!reportEntry || reportIndex < 0) {
		return { status: "no-final-report", reason: "child has no messages", hostStatus, uncertain: true };
	}

	// Attempt context of the report: an untagged report may only be attributed to the
	// requested run/attempt when the closest declared context in this branch is not
	// a conflicting one (foreign-run running marker + untagged report is not proof).
	const reportBinding = bindEntryToAttempt(reportEntry, identity, declaredContextBefore(branch, reportIndex, identity));
	if (reportBinding !== "bound") {
		return {
			status: "no-final-report",
			reason: identity.cutoffInvalid
				? "attempt cutoff is not a valid timestamp; no report can satisfy it"
				: reportBinding === "foreign"
					? "report carries no attempt identity and is preceded by a conflicting run/attempt context"
					: "report predates the current execution attempt",
			hostStatus,
			uncertain: true,
		};
	}
	const message = reportEntry.message;
	if (!message || message.role !== "assistant") {
		return {
			status: "no-final-report",
			reason: `latest message is ${message?.role ?? "unknown"}, not a final assistant report`,
			hostStatus,
			uncertain: true,
		};
	}

	// Newer relevant activity after the report is inspected *before* any terminal
	// inference: an aborted/errored assistant message that was later resumed
	// (report -> aborted -> running) is a live attempt, not a terminal one.
	let latestMarkerIndex = -1;
	let latestMarker: SessionEntryLike | undefined;
	for (let i = branch.length - 1; i > reportIndex; i -= 1) {
		const entry = branch[i];
		if (entry.type !== "custom") continue;
		if (entry.customType !== SUBAGENT_RESULT_TYPE && entry.customType !== SUBAGENT_STATUS_TYPE) continue;
		if (!markerStatus(entry)) continue;
		latestMarkerIndex = i;
		latestMarker = entry;
		break;
	}
	let markerBinding: "bound" | "unbound" | "foreign" = "unbound";
	if (latestMarker) {
		markerBinding = bindEntryToAttempt(latestMarker, identity, declaredContextBefore(branch, latestMarkerIndex, identity));
	}

	if (message.stopReason !== "stop") {
		const stopStatus = message.stopReason === "error" || message.stopReason === "aborted" ? message.stopReason : undefined;
		// Terminal assistant-stop evidence requires a recognized stop status, a report
		// provably bound to this attempt, and no newer relevant activity at all.
		const stopTerminal = Boolean(stopStatus) && reportBinding === "bound" && !latestMarker;
		return {
			status: "no-final-report",
			reason: latestMarker
				? `latest assistant stopReason is ${message.stopReason ?? "missing"}, and newer ${markerStatus(latestMarker) ?? "unknown"} activity follows it; not a terminal end`
				: `latest assistant stopReason is ${message.stopReason ?? "missing"}, not stop`,
			hostStatus,
			uncertain: !stopTerminal,
			...(stopTerminal
				? { terminal: { kind: "assistant-stop" as const, status: stopStatus!, ...(asString(reportEntry.id) ? { entryId: asString(reportEntry.id)! } : {}), ...(asString(reportEntry.timestamp) ? { at: asString(reportEntry.timestamp)! } : {}), boundToAttempt: true, clean: false } }
				: {}),
		};
	}
	if (hasToolCall(message.content)) {
		return { status: "no-final-report", reason: "latest assistant message contains a toolCall", hostStatus, uncertain: true };
	}
	const text = contentText(message.content).trim();
	if (!text) return { status: "no-final-report", reason: "latest assistant report has no text", hostStatus, uncertain: true };

	const pendingCalls = new Set<string>();
	for (let i = 0; i <= reportIndex; i += 1) {
		const entry = branch[i];
		if (entry.type !== "message" || !entry.message) continue;
		if (entry.message.role === "assistant" && Array.isArray(entry.message.content)) {
			for (const block of entry.message.content) {
				if (!isObject(block) || block.type !== "toolCall") continue;
				const id = toolCallId(block);
				if (!id) {
					return {
						status: "no-final-report",
						reason: "toolCall without id/toolCallId before report; cannot prove it settled",
						hostStatus,
						uncertain: true,
					};
				}
				pendingCalls.add(id);
			}
		} else if (entry.message.role === "toolResult") {
			const id = toolResultCallId(entry.message);
			if (id) pendingCalls.delete(id);
		}
	}
	if (pendingCalls.size > 0) {
		return {
			status: "no-final-report",
			reason: `outstanding tool call(s) before report: ${[...pendingCalls].slice(0, 3).join(",")}`,
			hostStatus,
			uncertain: true,
		};
	}

	const observedCommands = collectObservedCommands(branch, reportIndex, identity);

	// Post-report activity was located above (before any terminal inference). Only
	// markers attributable to this attempt can be terminal evidence: an unbound or
	// foreign marker is uncertainty, never completion or failure, and an unrecognized
	// status is never promoted to terminal failure.
	if (latestMarker) {
		const rawMarkerStatus = markerStatus(latestMarker)!;
		const markerNormalized = normalizeNativeStatus(rawMarkerStatus);
		const isResultMarker = latestMarker.customType === SUBAGENT_RESULT_TYPE;
		const markerEntryId = asString(latestMarker.id);
		const markerAt = asString(latestMarker.timestamp);
		const markerBase = {
			kind: (isResultMarker ? "result-marker" : "status-marker") as "result-marker" | "status-marker",
			status: rawMarkerStatus,
			...(markerEntryId ? { entryId: markerEntryId } : {}),
			...(markerAt ? { at: markerAt } : {}),
		};
		const binding = markerBinding;
		if (binding === "foreign") {
			return {
				status: "no-final-report",
				reason: `latest activity marker (${rawMarkerStatus}) belongs to a different run/attempt; refusing unattributed terminal evidence`,
				hostStatus,
				uncertain: true,
			};
		}
		if (markerNormalized === "completed") {
			if (binding !== "bound") {
				return {
					status: "no-final-report",
					reason: "native completion marker cannot be bound to the current execution attempt (missing/invalid timestamp or run mismatch)",
					hostStatus,
					uncertain: true,
				};
			}
			return {
				status: "native-completed",
				reason: isResultMarker
					? "child native result marker is completed after the report; native completion is preferred"
					: "child native status marker is completed after the report; native completion is preferred",
				hostStatus,
				nativeReportText: text,
				terminal: { ...markerBase, boundToAttempt: true, clean: true },
				cleanExit: true,
				...(observedCommands.length ? { observedCommands } : {}),
			};
		}
		if (markerNormalized === "running" || markerNormalized === "queued") {
			return {
				status: "no-final-report",
				reason: `newer ${markerNormalized} marker appears after the report`,
				hostStatus,
				uncertain: true,
			};
		}
		const terminalFailure = isTerminalFailureStatus(rawMarkerStatus) && binding === "bound";
		return {
			status: "no-final-report",
			reason: terminalFailure
				? isResultMarker
					? `terminal result marker (${rawMarkerStatus}) is newer than the report; refusing the old pre-interruption report`
					: `newer terminal status marker (${rawMarkerStatus}) appears after the report; refusing the old report`
				: `marker (${rawMarkerStatus}) is newer than the report but is not a recognized terminal status; refusing the old report`,
			hostStatus,
			uncertain: true,
			...(terminalFailure ? { terminal: { ...markerBase, boundToAttempt: true, clean: false } } : {}),
		};
	}

	const messageId = asString(reportEntry.id) ?? "";
	if (!messageId) return { status: "malformed", reason: "report entry has no id", hostStatus };
	const reportAt = asString(reportEntry.timestamp) ?? "";
	const report: RecoveredReport = {
		kind: "recovered-report",
		status: "recovered",
		accepted: false,
		verification: "pending-evidence-verification",
		sessionId: options.sessionId,
		messageId,
		entryId: messageId,
		reportAt,
		text,
		content: text,
		hostStatus,
		source: {
			file: options.file,
			line: lineFor(options.lineById, messageId),
			messageId,
		},
		assumedNativeStatus,
		attemptBound: true,
		terminalExitProof: false,
	};
	return {
		status: "recovered",
		reason: assumedNativeStatus
			? "clean final assistant report found after stale markers; native status was unknown and assumed stale for a read-only probe"
			: `clean final assistant report found after stale ${normalized} native status`,
		hostStatus,
		report,
		...(observedCommands.length ? { observedCommands } : {}),
	};
}

function isInside(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function lstatSafe(path: string) {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

/**
 * Resolution cache. Keys are canonical sessions root + exact session id, so the
 * same child id under two different roots can never share a cached file.
 * Retention is bounded (LRU limit + TTL) and every hit is revalidated.
 */
interface SessionPathCacheEntry {
	/** Canonical (realpath) sessions root that produced this resolution. */
	root: string;
	/** Canonical child file path (already a realpath). */
	file: string;
	/** Canonical cwd directory that contains the file. */
	dir: string;
	dev: number;
	ino: number;
	rootMtimeMs: number;
	dirMtimeMs: number;
	/**
	 * Snapshot of every pre-existing child directory (name + mtime) under the
	 * sessions root. A duplicate written into an existing sibling directory bumps
	 * that directory's mtime, so the snapshot changes and the cache hit is rejected.
	 */
	siblingStamp: string;
	/** Number of child directories covered by `siblingStamp`. */
	dirCount: number;
	/** Insertion time; never refreshed, so the TTL still forces a periodic rescan. */
	at: number;
}

const sessionPathCache = new Map<string, SessionPathCacheEntry>();

function sessionPathCacheKey(root: string, sessionId: string): string {
	return `${root}\u0000${sessionId}`;
}

export function clearSessionPathCache(): void {
	sessionPathCache.clear();
}

/** Diagnostics for bounded-retention tests; never exposes session payloads. */
export function sessionPathCacheSize(): number {
	return sessionPathCache.size;
}

function cacheTouch(key: string, entry: SessionPathCacheEntry): void {
	sessionPathCache.delete(key);
	sessionPathCache.set(key, entry);
	while (sessionPathCache.size > SESSION_PATH_CACHE_LIMIT) {
		const oldest = sessionPathCache.keys().next();
		if (oldest.done) break;
		sessionPathCache.delete(oldest.value);
	}
}

interface PathFingerprint {
	dev: number;
	ino: number;
	mtimeMs: number;
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink: boolean;
}

function pathFingerprint(path: string): PathFingerprint | undefined {
	const stat = lstatSafe(path);
	if (!stat) return undefined;
	return {
		dev: stat.dev,
		ino: stat.ino,
		mtimeMs: stat.mtimeMs,
		isFile: stat.isFile(),
		isDirectory: stat.isDirectory(),
		isSymbolicLink: stat.isSymbolicLink(),
	};
}

interface DirEntryLike {
	readonly name: string;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

interface SessionPathScanBudget {
	dirs: number;
	entries: number;
	work: number;
}

function newSessionPathScanBudget(): SessionPathScanBudget {
	return { dirs: 0, entries: 0, work: 0 };
}

/** Charge one child directory whose contents may be examined. */
function chargeScanDir(budget: SessionPathScanBudget): boolean {
	budget.dirs += 1;
	budget.work += 1;
	return budget.dirs <= SESSION_PATH_SCAN_MAX_DIRS && budget.work <= SESSION_PATH_SCAN_MAX_WORK;
}

/** Charge one directory entry that is about to be inspected. */
function chargeScanEntry(budget: SessionPathScanBudget): boolean {
	budget.entries += 1;
	budget.work += 1;
	return budget.entries <= SESSION_PATH_SCAN_MAX_ENTRIES && budget.work <= SESSION_PATH_SCAN_MAX_WORK;
}

/** Charge one bounded file inspection (a candidate lstat/realpath pair). */
function chargeScanWork(budget: SessionPathScanBudget): boolean {
	budget.work += 1;
	return budget.work <= SESSION_PATH_SCAN_MAX_WORK;
}

function scanErrorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface ScanStepResult {
	ok: boolean;
	reason?: string;
}

/**
 * Stream one directory through opendirSync/readSync, charging every entry to
 * the shared scan budget before it is inspected. The listing is never
 * materialized: the stream is closed as soon as the budget is exhausted (or a
 * step fails) and the caller must treat the scan as failed, never as a
 * complete result.
 */
function streamBoundedDir(
	dirPath: string,
	budget: SessionPathScanBudget,
	onEntry: (entry: DirEntryLike) => ScanStepResult,
): ScanStepResult {
	let dir: ReturnType<typeof opendirSync>;
	try {
		dir = opendirSync(dirPath);
	} catch (error) {
		return { ok: false, reason: `cannot read directory ${dirPath}: ${scanErrorText(error)}` };
	}
	try {
		for (;;) {
			let entry: DirEntryLike | null;
			try {
				entry = dir.readSync();
			} catch (error) {
				return { ok: false, reason: `cannot read directory ${dirPath}: ${scanErrorText(error)}` };
			}
			if (entry === null) return { ok: true };
			if (!chargeScanEntry(budget)) {
				return { ok: false, reason: `scan entry budget exhausted under ${dirPath}` };
			}
			const step = onEntry(entry);
			if (!step.ok) return step;
		}
	} finally {
		try {
			dir.closeSync();
		} catch {
			// Closing a stream we are done with is best-effort; a failed scan is
			// reported through the returned reason, never as a throw.
		}
	}
}

/**
 * A cached path is trusted only after it is revalidated against the current
 * root: same canonical root, a regular non-symlink file with the same inode,
 * still inside the root, an unchanged snapshot of every pre-existing sibling
 * directory (so a duplicate written into an existing sibling is detected, not
 * only a newly created one), and inside the retention TTL. Anything else
 * triggers a rescan.
 */
function revalidateSessionPathCached(entry: SessionPathCacheEntry, root: string, now: number): boolean {
	if (entry.root !== root) return false;
	if (now - entry.at > SESSION_PATH_CACHE_TTL_MS) return false;
	if (!isInside(root, entry.file)) return false;
	const file = pathFingerprint(entry.file);
	if (!file || !file.isFile || file.isSymbolicLink) return false;
	if (file.dev !== entry.dev || file.ino !== entry.ino) return false;
	let real: string;
	try {
		real = realpathSync(entry.file);
	} catch {
		return false;
	}
	if (real !== entry.file || !isInside(root, real)) return false;
	const dir = pathFingerprint(entry.dir);
	if (!dir || !dir.isDirectory || dir.isSymbolicLink || dir.mtimeMs !== entry.dirMtimeMs) return false;
	const rootStat = pathFingerprint(root);
	if (!rootStat || !rootStat.isDirectory || rootStat.mtimeMs !== entry.rootMtimeMs) return false;
	const stamp = siblingDirStamp(root);
	if (!stamp || stamp.dirCount !== entry.dirCount || stamp.stamp !== entry.siblingStamp) return false;
	return true;
}

/**
 * Bounded snapshot of every pre-existing child directory (name + mtime) under
 * the sessions root. Used both when a resolution is cached and on every cache
 * hit, so a duplicate appearing in any existing sibling directory invalidates
 * the cached single-path answer.
 */
function siblingDirStamp(root: string): { stamp: string; dirCount: number } | undefined {
	// The snapshot runs under the same hard scan budgets as discovery: a root
	// that cannot be snapshotted inside them is never cached and never trusted
	// from the cache.
	const budget = newSessionPathScanBudget();
	const parts: string[] = [];
	const scan = streamBoundedDir(root, budget, (dirent) => {
		if (!dirent.isDirectory() || dirent.isSymbolicLink()) return { ok: true };
		if (!chargeScanDir(budget)) return { ok: false, reason: "snapshot directory budget exhausted" };
		const name = dirent.name;
		const stat = pathFingerprint(join(root, name));
		// A directory that vanished or resolved to something else mid-scan makes the
		// snapshot unstable: neither cache it nor trust a cached entry.
		if (!stat || !stat.isDirectory || stat.isSymbolicLink) return { ok: false, reason: "unstable session directory snapshot" };
		parts.push(`${name}:${stat.mtimeMs}`);
		return { ok: true };
	});
	if (!scan.ok) return undefined;
	parts.sort();
	return { stamp: parts.join("|"), dirCount: parts.length };
}

export function resolveChildSessionFile(
	sessionId: string,
	sessionsDir = defaultSessionsDir(),
): ResolveChildResult {
	if (!isSafeSessionId(sessionId)) return { status: "invalid", reason: "unsafe session id" };
	let root: string;
	try {
		root = realpathSync(sessionsDir);
	} catch {
		return { status: "unknown", reason: `sessions directory not found: ${sessionsDir}` };
	}
	const now = Date.now();
	const key = sessionPathCacheKey(root, sessionId);
	const cached = sessionPathCache.get(key);
	if (cached) {
		if (revalidateSessionPathCached(cached, root, now)) {
			cacheTouch(key, cached);
			return { status: "found", file: cached.file };
		}
		sessionPathCache.delete(key);
	}
	const scanBudget = newSessionPathScanBudget();
	const matches = new Set<string>();
	const dirFingerprints = new Map<string, PathFingerprint>();
	// Snapshot every pre-existing child directory, whether or not it holds this
	// session id: a duplicate for this session written later into any of them must
	// invalidate a cached single-path resolution.
	const dirStamps: string[] = [];
	const suffix = `_${sessionId}.jsonl`;
	// A scan that stops early (unreadable sibling directory, failing candidate
	// inspection or budget exhaustion) proves nothing about uniqueness. It must
	// fail closed to uncertainty instead of returning or caching a possibly
	// incomplete single-path answer.
	let discoveryFailure: { status: "unknown" | "invalid"; reason: string } | undefined;
	const failDiscovery = (status: "unknown" | "invalid", reason: string): ScanStepResult => {
		discoveryFailure = { status, reason };
		return { ok: false, reason };
	};
	const rootScan = streamBoundedDir(root, scanBudget, (dirent) => {
		if (!dirent.isDirectory() || dirent.isSymbolicLink()) return { ok: true };
		// The directory cap is charged before a child directory is opened, so the
		// 64-directory threshold bounds the actual scan work, not just caching.
		if (!chargeScanDir(scanBudget)) {
			return failDiscovery("unknown", `child directory scan budget exhausted under ${root}`);
		}
		const name = dirent.name;
		const dir = join(root, name);
		const dirStat = pathFingerprint(dir);
		if (!dirStat || !dirStat.isDirectory || dirStat.isSymbolicLink) {
			return failDiscovery("unknown", `cannot verify session directory ${dir}`);
		}
		dirStamps.push(`${name}:${dirStat.mtimeMs}`);
		let dirMatched = false;
		const childScan = streamBoundedDir(dir, scanBudget, (file) => {
			if (!file.isFile() || file.isSymbolicLink()) return { ok: true };
			const fileName = file.name;
			if (fileName !== `${sessionId}.jsonl` && !fileName.endsWith(suffix)) return { ok: true };
			if (!chargeScanWork(scanBudget)) {
				return failDiscovery("unknown", `scan work budget exhausted under ${dir}`);
			}
			const candidate = join(dir, fileName);
			const stat = lstatSafe(candidate);
			// A matching name we cannot inspect could hide a duplicate: fail closed.
			if (!stat) return failDiscovery("unknown", `cannot inspect session file candidate ${candidate}`);
			if (!stat.isFile() || stat.isSymbolicLink()) return { ok: true };
			let real: string;
			try {
				real = realpathSync(candidate);
			} catch {
				return failDiscovery("unknown", `cannot resolve session file candidate ${candidate}`);
			}
			if (!isInside(root, real)) return failDiscovery("invalid", `path escapes sessions root: ${candidate}`);
			matches.add(real);
			dirMatched = true;
			return { ok: true };
		});
		if (!childScan.ok) return childScan;
		// Directory had this session id: remember the mtime observed while reading it.
		if (dirMatched) dirFingerprints.set(dir, dirStat);
		return { ok: true };
	});
	if (!rootScan.ok) {
		return discoveryFailure ?? { status: "unknown", reason: rootScan.reason ?? `cannot scan sessions directory: ${root}` };
	}

	const files = [...matches];
	if (files.length === 0) return { status: "unknown", reason: `no session file for ${sessionId}` };
	if (files.length > 1) return { status: "ambiguous", reason: `ambiguous duplicate session files for ${sessionId}`, files };
	const file = files[0];
	const dir = dirname(file);
	const fileStat = pathFingerprint(file);
	const observedDir = dirFingerprints.get(dir);
	const dirNow = pathFingerprint(dir);
	const rootNow = pathFingerprint(root);
	dirStamps.sort();
	const observedStamp = dirStamps.join("|");
	// Recompute the sibling snapshot after the scan: if a directory mutated while it
	// was being read, the snapshot differs and the resolution must not be cached.
	const currentStamp = siblingDirStamp(root);
	// Cache only a resolution whose fingerprints stayed stable across the scan;
	// a directory mutated while being read could hide a duplicate, so it must not
	// be remembered as unambiguous. Wide roots are never cached so retention stays bounded.
	if (
		fileStat && fileStat.isFile && !fileStat.isSymbolicLink &&
		observedDir && dirNow && dirNow.isDirectory && !dirNow.isSymbolicLink && observedDir.mtimeMs === dirNow.mtimeMs &&
		rootNow && rootNow.isDirectory &&
		currentStamp && currentStamp.dirCount === dirStamps.length && currentStamp.stamp === observedStamp &&
		dirStamps.length <= SESSION_PATH_CACHE_MAX_DIRS
	) {
		cacheTouch(key, {
			root,
			file,
			dir,
			dev: fileStat.dev,
			ino: fileStat.ino,
			rootMtimeMs: rootNow.mtimeMs,
			dirMtimeMs: dirNow.mtimeMs,
			siblingStamp: observedStamp,
			dirCount: dirStamps.length,
			at: now,
		});
	}
	return { status: "found", file };
}

interface BoundedReadResult {
	ok: boolean;
	text?: string;
	byteLength: number;
	truncated: boolean;
	error?: string;
}

/**
 * Read a regular file with a hard byte cap instead of reading a long session
 * unbounded. Oversized input returns `truncated` so callers can fail closed
 * ("uncertain") rather than parse a prefix.
 */
function readBoundedNoFollow(file: string, maxBytes: number): BoundedReadResult {
	const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : RECOVERY_MAX_SESSION_BYTES;
	const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
	let fd: number;
	try {
		fd = openSync(file, fsConstants.O_RDONLY | noFollow);
	} catch (error) {
		return { ok: false, byteLength: 0, truncated: false, error: error instanceof Error ? error.message : String(error) };
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile()) {
			return { ok: false, byteLength: 0, truncated: false, error: `not a regular file: ${file}` };
		}
		if (stat.size > limit) {
			return { ok: false, byteLength: 0, truncated: true, error: `session file exceeds bounded read limit (${stat.size} > ${limit} bytes)` };
		}
		const chunk = Buffer.allocUnsafe(Math.min(limit, 64 * 1024));
		const chunks: Buffer[] = [];
		let total = 0;
		for (;;) {
			const remaining = limit - total;
			if (remaining <= 0) {
				return { ok: false, byteLength: total, truncated: true, error: `session file exceeds bounded read limit (${limit} bytes)` };
			}
			const read = readSync(fd, chunk, 0, Math.min(chunk.length, remaining), null);
			if (read <= 0) break;
			total += read;
			chunks.push(Buffer.from(chunk.subarray(0, read)));
		}
		return { ok: true, text: Buffer.concat(chunks, total).toString("utf8"), byteLength: total, truncated: false };
	} catch (error) {
		return { ok: false, byteLength: 0, truncated: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		closeSync(fd);
	}
}

function validateSubagentMetadata(
	entries: SessionEntryLike[],
	parentSessionId: string,
): { ok: true } | { ok: false; status: "foreign-parent" | "malformed"; reason: string } {
	const metas = entries.filter((entry) => entry.type === "custom" && entry.customType === SUBAGENT_META_TYPE);
	if (metas.length === 0) return { ok: false, status: "foreign-parent", reason: "not a pi-web subagent session" };
	for (const meta of metas) {
		if (!isObject(meta.data) || meta.data.version !== 1) {
			return { ok: false, status: "malformed", reason: "invalid pi-web:subagent metadata" };
		}
		const parent = asString(meta.data.parentSessionId);
		if (!parent) return { ok: false, status: "malformed", reason: "pi-web:subagent metadata has no parentSessionId" };
		if (parent !== parentSessionId) {
			return { ok: false, status: "foreign-parent", reason: `child belongs to another parent (${parent})` };
		}
	}
	return { ok: true };
}

/** Read and validate a child session by exact ID. Fresh read; bypasses host caches. */
export function recoverChildReport(sessionId: string, options: RecoverChildOptions): RecoveryReadResult {
	const parentSessionId = asString(options.parentSessionId);
	if (!parentSessionId) {
		return { status: "foreign-parent", reason: "current parent session id is unavailable", sessionId, uncertain: true };
	}
	const resolved = resolveChildSessionFile(sessionId, options.sessionsDir);
	if (resolved.status !== "found") {
		return {
			status: resolved.status === "ambiguous" ? "ambiguous" : resolved.status === "invalid" ? "file-error" : "unknown-session",
			reason: resolved.reason,
			sessionId,
			uncertain: true,
			...(resolved.files ? { file: resolved.files[0] } : {}),
		};
	}

	const read = readBoundedNoFollow(resolved.file, options.maxSessionBytes ?? RECOVERY_MAX_SESSION_BYTES);
	if (!read.ok || typeof read.text !== "string") {
		// Unreadable, non-regular or over-limit evidence is uncertain; it never becomes
		// a completion or failure claim.
		return {
			status: "file-error",
			reason: `cannot read child session within bounds: ${read.error ?? "unknown read failure"}`,
			sessionId,
			file: resolved.file,
			uncertain: true,
			byteLength: read.byteLength,
			...(read.truncated ? { truncated: true } : {}),
		};
	}

	const parsed = parseSessionJsonl(read.text, { maxEntries: options.maxEntries, maxChars: options.maxSessionBytes });
	if (!parsed.ok) {
		return { status: "malformed", reason: parsed.error, sessionId, file: resolved.file, uncertain: true, byteLength: read.byteLength };
	}
	const { header, entries, lineById } = parsed.value;
	if (header.id !== sessionId) {
		return {
			status: "malformed",
			reason: `session header id ${header.id} does not match ${sessionId}`,
			sessionId,
			file: resolved.file,
			uncertain: true,
			byteLength: read.byteLength,
		};
	}
	const metadata = validateSubagentMetadata(entries, parentSessionId);
	if (!metadata.ok) {
		return { status: metadata.status, reason: metadata.reason, sessionId, file: resolved.file, uncertain: true, byteLength: read.byteLength };
	}

	const derived = deriveRecoveredReport(entries, {
		sessionId,
		file: resolved.file,
		nativeStatus: options.nativeStatus,
		assumeStale: options.assumeStale,
		lineById,
		reportNotBefore: options.reportNotBefore,
		runId: options.runId,
		attemptId: options.attemptId,
	});
	return {
		status: derived.status,
		reason: derived.reason,
		sessionId,
		file: resolved.file,
		hostStatus: derived.hostStatus,
		...(derived.report ? { report: derived.report } : {}),
		...(derived.nativeReportText ? { nativeReportText: derived.nativeReportText } : {}),
		...(derived.observedCommands?.length ? { observedCommands: derived.observedCommands } : {}),
		...(derived.terminal ? { terminal: derived.terminal } : {}),
		...(derived.cleanExit !== undefined ? { cleanExit: derived.cleanExit } : {}),
		...(derived.uncertain ? { uncertain: true } : {}),
		...(derived.truncated ? { truncated: true } : {}),
		byteLength: read.byteLength,
	};
}

/** Collect child IDs from relevant parent tool results and recognized team-run entries. */
export function collectKnownChildSessionIds(parentEntries: unknown[]): string[] {
	const ids = new Set<string>();
	for (const raw of Array.isArray(parentEntries) ? parentEntries : []) {
		if (!isObject(raw)) continue;
		if (raw.type === "message" && isObject(raw.message) && raw.message.role === "toolResult") {
			const message = raw.message;
			const toolName = asString(message.toolName)?.toLowerCase();
			if (toolName !== "agent" && toolName !== "get_subagent_result" && toolName !== "steer_subagent") continue;
			if (isObject(message.details)) {
				const direct = asString(message.details.sessionId) ?? asString(message.details.subagentSessionId);
				if (direct && isSafeSessionId(direct)) ids.add(direct);
			}
			for (const id of extractSessionIdFromTextAll(contentText(message.content))) {
				if (isSafeSessionId(id)) ids.add(id);
			}
			continue;
		}
		if (raw.type === "custom" && raw.customType === "team-run" && isObject(raw.data)) {
			const direct = asString(raw.data.sessionId);
			if (direct && isSafeSessionId(direct)) ids.add(direct);
		}
	}
	return [...ids];
}

export interface ProbeChildResult {
	sessionId: string;
	/**
	 * Decisive attempt-level evidence was found (a clean report or an attempt-bound
	 * terminal marker). This is NOT proof that the child process exited and it is
	 * not authorization to release a live/queued reservation by itself.
	 */
	completed: boolean;
	/** True only for attempt-bound terminal FAILURE evidence, never for unreadable evidence. */
	failed: boolean;
	status: string;
	/** True only for attempt-bound clean terminal evidence; never inferred from prose. */
	cleanExit?: boolean;
	/** True only when an attempt-bound native completion marker proves a clean terminal exit. */
	terminalExitProof?: boolean;
	/** No decisive attempt evidence (live, unreadable, ambiguous, oversized or truncated). */
	uncertain?: boolean;
	/** Terminal provenance, when the derivation observed attempt-bound terminal evidence. */
	terminal?: TerminalEvidence;
	report?: RecoveredReport;
	/** Final assistant report text whether recovered or natively completed. */
	reportText?: string;
	/** Bash commands actually executed in the child's active branch for this attempt. */
	observedCommands?: string[];
	reason?: string;
	file?: string;
	fileMtimeMs?: number;
	probeLatencyMs: number;
}

export function probeLiveChildSession(
	sessionId: string,
	options: { parentSessionId: string; runId?: string; dispatchedAt?: string; sessionsDir?: string },
): ProbeChildResult {
	const start = performance.now();
	const res = recoverChildReport(sessionId, {
		parentSessionId: options.parentSessionId,
		nativeStatus: "running",
		assumeStale: true,
		reportNotBefore: options.dispatchedAt,
		// The probe's run identity is forwarded so a marker written by another run
		// of a reused session cannot claim this attempt's terminal state.
		runId: options.runId,
		sessionsDir: options.sessionsDir,
	});
	const probeLatencyMs = performance.now() - start;
	if (res.status === "recovered" && res.report) {
		// A recovered report is evidence for reporting only: accepted:false and no
		// terminal-exit proof. `cleanExit` keeps its historical caller contract.
		return { sessionId, completed: true, failed: false, cleanExit: true, terminalExitProof: false, status: "completed", report: res.report, reportText: res.report.text ?? res.report.content, observedCommands: res.observedCommands, file: res.file, probeLatencyMs };
	}
	if (res.status === "native-completed") {
		const terminal = res.terminal;
		const bound = terminal?.boundToAttempt === true && terminal.clean === true;
		if (!bound) {
			// An unbound native completion (for example a host status with no attempt
			// window) is an observation, not decisive attempt evidence.
			return { sessionId, completed: false, failed: false, cleanExit: false, terminalExitProof: false, uncertain: true, status: res.status, reason: res.reason, ...(terminal ? { terminal } : {}), reportText: res.nativeReportText, observedCommands: res.observedCommands, file: res.file, probeLatencyMs };
		}
		return { sessionId, completed: true, failed: false, cleanExit: true, terminalExitProof: true, status: "completed", ...(terminal ? { terminal } : {}), reportText: res.nativeReportText, observedCommands: res.observedCommands, file: res.file, probeLatencyMs };
	}
	// A terminal failure can settle the attempt only when it is bound to this
	// attempt. Reason prose is never parsed here.
	if (res.terminal && res.terminal.boundToAttempt === true && res.terminal.clean === false) {
		return { sessionId, completed: true, failed: true, cleanExit: false, terminalExitProof: false, status: "failed", terminal: res.terminal, reason: res.reason, file: res.file, probeLatencyMs };
	}
	let fileMtimeMs: number | undefined;
	if (res.file) {
		const st = lstatSafe(res.file);
		if (st) fileMtimeMs = st.mtimeMs;
	}
	// Everything else keeps the reservation: live/queued children, missing
	// evidence, foreign parents, ambiguous paths, unreadable/oversized/truncated
	// files and malformed JSONL are all uncertainty, never completion or failure.
	return { sessionId, completed: false, failed: false, cleanExit: false, terminalExitProof: false, uncertain: true, status: res.status, reason: res.reason, file: res.file, fileMtimeMs, probeLatencyMs, ...(res.terminal ? { terminal: res.terminal } : {}) };
}

/**
 * Hard cap on distinct sessions probed in one cycle. Sessions beyond the cap are
 * simply not probed (absent from the returned map), which fail-closed callers read
 * as "still reserved" instead of accepting unverified evidence.
 */
export const RECOVERY_MAX_PROBED_SESSIONS = 256;

export function probeAllLiveChildren(
	sessions: Array<{ taskId: string; sessionId: string; runId?: string; dispatchedAt?: string }>,
	options: { parentSessionId: string; sessionsDir?: string },
): Map<string, ProbeChildResult> {
	const results = new Map<string, ProbeChildResult>();
	let probed = 0;
	for (const item of sessions) {
		if (!item.sessionId) continue;
		const existing = results.get(item.sessionId);
		if (existing) {
			// Two ledger entries claim the same session in one cycle. The identity is
			// ambiguous, so neither probe may settle ownership.
			results.set(item.sessionId, {
				sessionId: item.sessionId,
				completed: false,
				failed: false,
				cleanExit: false,
				terminalExitProof: false,
				uncertain: true,
				status: "ambiguous-identity",
				reason: `duplicate sessionId ${item.sessionId} in one probe cycle`,
				file: existing.file,
				probeLatencyMs: existing.probeLatencyMs,
			});
			continue;
		}
		if (probed >= RECOVERY_MAX_PROBED_SESSIONS) continue;
		probed++;
		results.set(item.sessionId, probeLiveChildSession(item.sessionId, {
			parentSessionId: options.parentSessionId,
			runId: item.runId,
			dispatchedAt: item.dispatchedAt,
			sessionsDir: options.sessionsDir,
		}));
	}
	return results;
}
