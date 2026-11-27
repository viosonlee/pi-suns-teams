/**
 * Tracked pi-web transport. Only the parent supplies executeTool (normally a
 * closure over the CURRENT ctx.executeTool and its one-use ledger guard token).
 * Never dispatch independent sessions or retry a host failure through the CLI:
 * even an error/malformed response may follow an accepted launch.
 *
 * The host owns runtime registration, session.created/status/list events, links
 * and JSONL writers. This adapter only reads disk; it never appends markers.
 * spawn_subsession has no cwd/agentDir/tools/profile-discovery flags. cwd must
 * already be the parent's workspace. Profile bodies are forwarded in full as
 * user instructions, not installed as replacement system prompts; discovery
 * switches (MCP/skills/extensions/context files) cannot be reproduced here.
 * The parent must enforce profile.tools in hosted children using the initial
 * PI_TEAMS_HOST_ROLE marker, setActiveTools AND tool_call enforcement, and must
 * ensure its team extension is loaded. Prompt instructions alone are no sandbox.
 *
 * Resume cannot change model/thinking. Omit inherited override fields on resume;
 * role getters and profile defaults are deliberately applied only to NEW children.
 * Background calls do not poll. Foreground waits are bounded; scheduler/lifecycle
 * harvesting uses getHostedSubagentResult(..., false, currentOptions). Persist
 * role/taskId/runId/reportNotBefore in the parent ledger for recovery after restart.
 * A transport/check error is NOT proof the child stopped (no terminal callback).
 * Errors once spawn/resume was invoked return status "running" with
 * launchUncertain:true plus any details.sessionId, so the scheduler must reconcile
 * instead of retrying and duplicating the child.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getDefaultAgentDir, readAgentProfile, parseTeamTaskIdFromPrompt,
	type AgentCallParams, type ChildCompletion, type NativeRunnerOptions,
} from "./team-runner.ts";
import {
	resolveChildSessionFile, parseSessionJsonl, buildActiveBranch, completedCommandsForHostedReport,
	RECOVERY_MAX_SESSION_BYTES, type SessionEntryLike,
} from "./team-recovery.ts";

export type HostedExecuteTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export interface HostedRunnerOptions extends Pick<NativeRunnerOptions,
	"agentDir" | "cwd" | "parentSessionId" | "parentSessionFile" |
	"getModelOverride" | "getThinkingOverride" | "onChildComplete"> {
	executeTool: HostedExecuteTool;
	/** Optional parent-owned bookkeeping. Contains no callbacks, runtimes or writers. */
	state?: HostedRunnerState;
	waitTimeoutMs?: number;
	pollIntervalMs?: number;
}
export interface HostedResultOptions extends HostedRunnerOptions {
	role: string;
	taskId?: string;
	runId?: string;
	/** Persisted attempt start (ISO timestamp); required to fence recovery of resumed attempts. */
	reportNotBefore?: string;
}
export interface HostedLaunchResult {
	sessionId: string;
	status: "running" | "completed" | "failed" | "aborted";
	isError: boolean;
	/** Host spawn/resume was invoked but its outcome was not confirmed; never auto-retry. */
	launchUncertain?: boolean;
	error?: string;
	reportText?: string;
	completion?: ChildCompletion;
}
/** Structured host failure. Identity comes only from details.sessionId, never from text. */
export class HostCallError extends Error {
	readonly hostName: string;
	readonly sessionId?: string;
	readonly diagnostic?: string;
	constructor(message: string, hostName: string, sessionId?: string, diagnostic?: string) {
		super(message);
		this.name = "HostCallError";
		this.hostName = hostName;
		this.sessionId = sessionId;
		this.diagnostic = diagnostic;
	}
}
export interface HostedAttempt {
	role: string;
	taskId?: string;
	runId?: string;
	notBefore?: number;
	resumed?: boolean;
	baselineCount?: number;
	baselineText?: string;
	baselineAssistantId?: string;
	terminal?: ChildCompletion;
}
export interface HostedRunnerState { attempts: Map<string, HostedAttempt> }
export function createHostedRunnerState(): HostedRunnerState { return { attempts: new Map() }; }
// Survives extension reloads, scoped by parent/file/child. No callback is retained.
const registryKey = Symbol.for("pi-teams.hosted-runner.state");
const shared = globalThis as typeof globalThis & { [registryKey]?: HostedRunnerState };
const defaultState = shared[registryKey] ??= createHostedRunnerState();
const MAX_WAIT_MS = 300_000;
const SENTINEL_OVERRIDES = new Set(["inherit", "default", "auto", "none", "unset", "null", "undefined"]);
const optional = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined;
const optionalOverride = (value: unknown): string | undefined => {
	const v = optional(value);
	return v && !SENTINEL_OVERRIDES.has(v.toLowerCase()) ? v : undefined;
};
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const stateOf = (options: HostedRunnerOptions) => options.state ?? defaultState;
const keyOf = (id: string, options: HostedRunnerOptions) =>
	JSON.stringify([options.parentSessionId ?? "", options.parentSessionFile ?? "", id]);
const running = (sessionId: string, error?: string): HostedLaunchResult =>
	({ sessionId, status: "running", isError: !!error, ...(error ? { error } : {}) });

export interface NormalizedHostToolResult {
	details?: Record<string, unknown>;
	isError: boolean;
	errorText?: string;
}
/**
 * Accept the SDK nested-call wrapper `{toolCall,result,isError}` or a raw
 * AgentToolResult/mock. Outer isError is preserved because a wrapper failure can
 * hide a result; text content is never read as status.
 */
export function normalizeHostToolResult(raw: unknown): NormalizedHostToolResult {
	if (!record(raw)) throw new Error("Host tool returned a non-object result");
	const outer = "result" in raw ? raw : undefined;
	const value = outer && record(outer.result) ? outer.result : raw;
	const details = record(value.details) ? value.details : undefined;
	const isError = outer?.isError === true || value.isError === true;
	const errorText = optional(outer?.error) ?? optional(value.errorDetail) ?? optional(value.error)
		?? (typeof outer?.result === "string" ? optional(outer.result) : undefined);
	return { ...(details ? { details } : {}), isError, ...(errorText ? { errorText } : {}) };
}
/** Existing structured identity only; malformed/text results yield undefined. */
export function extractHostSessionId(raw: unknown): string | undefined {
	try { return optional(normalizeHostToolResult(raw).details?.sessionId); }
	catch { return undefined; }
}
/** Structured details ONLY: model-facing text is never an identity/status source. */
async function hostDetails(name: string, args: Record<string, unknown>, options: HostedRunnerOptions) {
	let raw: unknown;
	try { raw = await options.executeTool(name, args); }
	catch (error) { throw new HostCallError(`${name}: ${errorText(error)}`, name); }
	let normalized: NormalizedHostToolResult;
	try { normalized = normalizeHostToolResult(raw); }
	catch (error) { throw new HostCallError(`${name}: ${errorText(error)}`, name); }
	const sessionId = optional(normalized.details?.sessionId);
	if (normalized.isError) {
		throw new HostCallError(`${name}: ${normalized.errorText ?? "host tool failed"}. Never fall back to CLI.`, name, sessionId, normalized.errorText);
	}
	const details = normalized.details;
	if (!details) throw new HostCallError(`${name}: missing structured details; result is ambiguous. Never fall back to CLI.`, name, sessionId);
	if (!sessionId) throw new HostCallError(`${name}: details.sessionId is missing; identity is ambiguous. Never infer it from text.`, name);
	if (args.sessionId !== undefined && sessionId !== args.sessionId) throw new HostCallError(`${name}: details.sessionId mismatch`, name, sessionId);
	return { ...details, sessionId };
}
interface HostCheck { sessionId: string; status: "working" | "idle" | "error"; finalText: string; errorDetail?: string; messageCount?: number }
async function check(id: string, options: HostedRunnerOptions): Promise<HostCheck> {
	const d = await hostDetails("check_subsession", { sessionId: id }, options);
	if (!["working", "idle", "error"].includes(String(d.status)) || typeof d.finalText !== "string") throw new Error("check_subsession: invalid structured status/finalText");
	if (d.errorDetail !== undefined && typeof d.errorDetail !== "string") throw new Error("check_subsession: invalid errorDetail");
	return {
		sessionId: id, status: d.status as HostCheck["status"], finalText: d.finalText,
		errorDetail: optional(d.errorDetail),
		messageCount: typeof d.messageCount === "number" && Number.isSafeInteger(d.messageCount) && d.messageCount >= 0 ? d.messageCount : undefined,
	};
}

interface DiskSnapshot { kind: "found" | "unavailable" | "invalid"; entries?: SessionEntryLike[]; assistant?: SessionEntryLike; error?: string }
function diskSnapshot(id: string, options: Pick<HostedRunnerOptions, "agentDir" | "parentSessionId" | "parentSessionFile">): DiskSnapshot {
	const resolved = resolveChildSessionFile(id, path.join(options.agentDir || getDefaultAgentDir(), "sessions"));
	if (resolved.status !== "found") return { kind: resolved.status === "unknown" ? "unavailable" : "invalid", error: resolved.reason };
	let raw: string;
	let fd: number | undefined;
	try {
		fd = fs.openSync(resolved.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		const size = fs.fstatSync(fd).size;
		if (size > RECOVERY_MAX_SESSION_BYTES) throw new Error("hosted session exceeds bounded read limit");
		// Bound even if the live writer grows the file after fstat.
		const buffer = Buffer.alloc(size + 1);
		let bytes = 0;
		while (bytes < buffer.length) {
			const n = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
			if (n === 0) break;
			bytes += n;
		}
		if (bytes > size) throw new Error("hosted session changed during inspection");
		raw = buffer.subarray(0, bytes).toString("utf8");
	} catch (error) { return { kind: "unavailable", error: errorText(error) }; }
	finally { if (fd !== undefined) fs.closeSync(fd); }
	// A concurrent host writer may leave a partial trailing line: retry later.
	const parsed = parseSessionJsonl(raw);
	if (!parsed.ok) return { kind: "unavailable", error: parsed.error };
	try {
		if (parsed.value.header.id !== id) throw new Error("hosted session header identity mismatch");
		const entries = parsed.value.entries;
		if (entries.some(e => e.type === "custom" && e.customType === "pi-web:subagent")) throw new Error("legacy CLI child; use native transport");
		const marker = entries.find(e => e.type === "custom" && e.customType === "pi-web.subsession.spawned" && record(e.data) && e.data.spawnedSessionId === id);
		if (!marker || !record(marker.data)) throw new Error("missing hosted child provenance");
		if (options.parentSessionId && marker.data.spawnedBySessionId !== options.parentSessionId) throw new Error("foreign hosted parent");
		if (options.parentSessionFile && parsed.value.header.parentSession) {
			if (path.resolve(String(parsed.value.header.parentSession)) !== path.resolve(options.parentSessionFile)) throw new Error("foreign hosted parent file");
		}
		const branch = buildActiveBranch(entries);
		if (!branch.ok) throw new Error(branch.error);
		return { kind: "found", entries, assistant: [...branch.branch].reverse().find(e => e.type === "message" && e.message?.role === "assistant") };
	} catch (error) { return { kind: "invalid", error: errorText(error) }; }
}

/** Native files also carry the spawned marker: absence of pi-web:subagent is essential. */
export function isHostedSubagent(sessionId: string, options: Pick<HostedRunnerOptions, "agentDir" | "parentSessionId" | "parentSessionFile"> = {}): boolean {
	return diskSnapshot(sessionId, options).kind === "found";
}

/**
 * Pure disk check (zero host tool calls): returns true only when the child JSONL file shows a
 * fresh terminal assistant turn (non-toolUse) for the current attempt, or became structurally invalid.
 */
export function hasHostedTerminalSnapshotOnDisk(
	sessionId: string,
	options: Pick<HostedRunnerOptions, "agentDir" | "parentSessionId" | "parentSessionFile" | "state"> & { reportNotBefore?: string; runId?: string } = {},
): boolean {
	const disk = diskSnapshot(sessionId, options);
	if (disk.kind === "invalid") return true;
	if (disk.kind !== "found" || !disk.assistant) return false;
	const assistant = disk.assistant;
	const key = keyOf(sessionId, options);
	const attempt = options.state?.attempts.get(key);
	const notBefore = attempt?.notBefore ?? (options.reportNotBefore === undefined ? undefined : Date.parse(options.reportNotBefore));
	const at = typeof assistant.message?.timestamp === "number" ? assistant.message.timestamp : Date.parse(assistant.timestamp ?? "");
	if (notBefore !== undefined && (!Number.isFinite(at) || at < notBefore)) return false;
	if (attempt?.resumed && assistant.id === attempt.baselineAssistantId) return false;
	const stopReason = assistant.message?.stopReason;
	return stopReason !== "toolUse";
}
function assistantText(entry: SessionEntryLike): string {
	const content = entry.message?.content;
	if (typeof content === "string") return content;
	return Array.isArray(content) ? content.filter(record).filter(p => p.type === "text" && typeof p.text === "string").map(p => p.text).join("\n") : "";
}
function completionResult(info: ChildCompletion): HostedLaunchResult {
	return { sessionId: info.sessionId, status: info.status, isError: !info.success, reportText: info.reportText, error: info.error, completion: info };
}
function finish(id: string, attempt: HostedAttempt, snapshot: HostCheck, options: HostedRunnerOptions): HostedLaunchResult {
	if (snapshot.status === "working") return running(id); // Withhold ALL partial/stale output.
	const disk = diskSnapshot(id, options);
	let reportText = snapshot.finalText;
	let stopReason: string | undefined;
	let error = snapshot.errorDetail;
	// A resumed attempt's output must be provable from disk; host finalText alone
	// can still be the PREVIOUS turn before the new prompt is persisted.
	if (attempt.resumed && disk.kind !== "found") return running(id, `Cannot validate hosted resume output from disk: ${disk.error ?? "session file unavailable"}`);
	if (disk.kind === "invalid") error ??= disk.error;
	if (disk.assistant) {
		const assistant = disk.assistant;
		const at = typeof assistant.message?.timestamp === "number" ? assistant.message.timestamp : Date.parse(assistant.timestamp ?? "");
		if ((attempt.notBefore !== undefined && (!Number.isFinite(at) || at < attempt.notBefore)) ||
			(attempt.resumed && assistant.id === attempt.baselineAssistantId)) return running(id);
		stopReason = assistant.message?.stopReason;
		// Host finalAssistantText skips empty assistant content and may leak an OLD
		// success after a new quota error. The actual latest assistant wins on disk.
		// Only stopReason "stop" is a final delivery: toolUse/aborted/error/length and
		// a missing stopReason must never become a PASS from prefatory text.
		if (stopReason === "stop") {
			reportText = assistantText(assistant);
		} else {
			reportText = "";
			error = optional(assistant.message?.errorMessage) ?? error
				?? (stopReason ? `Hosted child ended with non-final stopReason=${stopReason}; no final report` : "Hosted assistant message has no final stopReason; no final report");
		}
	} else if (attempt.resumed) {
		// Host resume returns working before the new prompt is necessarily persisted.
		// messageCount includes user messages: advancing by just one is not a report.
		const countFresh = snapshot.messageCount !== undefined && attempt.baselineCount !== undefined && snapshot.messageCount >= attempt.baselineCount + 2;
		const textFresh = attempt.baselineText !== undefined && snapshot.finalText !== attempt.baselineText;
		if (!countFresh && !textFresh && !error && snapshot.finalText.trim()) return running(id);
		// No disk assistant and no known baseline (restart recovery): host text alone
		// cannot prove this attempt produced it. An empty idle still fails below.
		if (snapshot.finalText.trim() && attempt.baselineText === undefined) return running(id);
	}
	if (snapshot.status === "error") error ??= "Hosted child reported error";
	if (!reportText.trim()) error ??= "Hosted child became idle without a final assistant report (possible model/quota failure)";
	const status: ChildCompletion["status"] = stopReason === "aborted" ? "aborted" : error ? "failed" : "completed";
	const info: ChildCompletion = {
		sessionId: id, role: attempt.role, taskId: attempt.taskId, runId: attempt.runId,
		parentSessionId: options.parentSessionId ?? "", status, success: status === "completed",
		...(reportText.trim() ? { reportText } : {}), stopReason, code: null, signal: null, ...(error ? { error } : {}),
		observedCommands: disk.entries ? completedCommandsForHostedReport(disk.entries, attempt.notBefore === undefined ? undefined : new Date(attempt.notBefore).toISOString()) : [],
	};
	// Commit before calling back: concurrent checks and re-entrant callbacks dedupe.
	if (attempt.terminal) return completionResult(attempt.terminal);
	attempt.terminal = info;
	try { options.onChildComplete?.(info); } catch { /* orchestration callback cannot trigger a re-launch */ }
	return completionResult(info);
}

export async function launchHostedSubagent(params: AgentCallParams, options: HostedRunnerOptions, signal?: AbortSignal): Promise<HostedLaunchResult> {
	let id = optional(params.resume) ?? "";
	// Set immediately before spawn/manage: a later failure may hide acceptance.
	let hostInvoked = false;
	try {
		const role = (optional(params.subagent_type) ?? "bridges").toLowerCase();
		if (!/^[a-z][a-z0-9_-]*$/.test(role)) throw new Error("Invalid hosted role");
		if (id && (optionalOverride(params.model) || optionalOverride(params.thinking))) throw new Error("manage_subsession resume cannot override model/thinking; omit inherited override fields");
		if (signal?.aborted) return { sessionId: id, status: "failed", isError: true, error: "Launch canceled before host call" };
		const profile = readAgentProfile(role, options.agentDir || getDefaultAgentDir());
		if (!profile) throw new Error(`Missing agent profile for hosted role ${role}`);
		const brief = typeof params.prompt === "string" ? params.prompt : "";
		const prompt = `PI_TEAMS_HOST_ROLE: ${role}\n\n${profile.systemPrompt}\n\n${brief || "Continue your previous task from the current conversation and workspace state."}`;
		const attempt: HostedAttempt = { role, taskId: parseTeamTaskIdFromPrompt(brief), runId: optional(params.run_id), notBefore: Date.now() };
		if (id) {
			const baseline = await check(id, options);
			if (baseline.status === "working") return running(id, "Hosted child is still working; cannot resume");
			attempt.resumed = true;
			attempt.baselineCount = baseline.messageCount;
			attempt.baselineText = baseline.finalText;
			attempt.baselineAssistantId = diskSnapshot(id, options).assistant?.id;
			attempt.notBefore = Date.now();
			stateOf(options).attempts.set(keyOf(id, options), attempt);
			hostInvoked = true;
			const d = await hostDetails("manage_subsession", { action: "resume", sessionId: id, prompt }, options);
			if (d.status !== "working") throw new HostCallError("manage_subsession: resume did not return structured working status", "manage_subsession", id);
		} else {
			const model = optionalOverride(params.model) ?? optionalOverride(options.getModelOverride?.(role)) ?? optionalOverride(profile.model);
			const thinkingLevel = optionalOverride(params.thinking) ?? optionalOverride(options.getThinkingOverride?.(role)) ?? optionalOverride(profile.thinking);
			hostInvoked = true;
			const d = await hostDetails("spawn_subsession", { prompt, ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) }, options);
			id = String(d.sessionId);
			stateOf(options).attempts.set(keyOf(id, options), attempt);
		}
		if (params.run_in_background !== false) return running(id);
		const settled = await getHostedSubagentResult(id, true, { ...options, role, taskId: attempt.taskId, runId: attempt.runId,
			waitTimeoutMs: options.waitTimeoutMs ?? (typeof params.wait_timeout === "number" ? params.wait_timeout * 1000 : undefined) }, signal);
		// Transport error after acceptance: keep identity but never present it as a safe retry.
		return settled.isError && !settled.completion ? { ...settled, launchUncertain: true } : settled;
	} catch (error) {
		// Never invoke native launch here. The host might already have accepted work.
		const call = error instanceof HostCallError ? error : undefined;
		const identified = call?.sessionId ?? (id || undefined);
		const diagnostic = call?.diagnostic ?? errorText(error);
		if (hostInvoked) {
			return { sessionId: identified ?? "", status: "running", isError: true, launchUncertain: true,
				error: diagnostic };
		}
		// Safe pre-host rejection only: no spawn/manage was called.
		return { sessionId: identified ?? "", status: "failed", isError: true, error: diagnostic };
	}
}

/** Check/harvest a known ledger task. Terminal callbacks occur at most once per attempt.
 * Inspection errors return running+isError, not false terminal evidence. Caller must
 * persist a consumed runId if deduplication must survive a process restart.
 */
export async function getHostedSubagentResult(sessionId: string, wait: boolean, options: HostedResultOptions, signal?: AbortSignal): Promise<HostedLaunchResult> {
	const role = (optional(options.role) ?? "").toLowerCase();
	if (!/^[a-z][a-z0-9_-]*$/.test(role)) return running(sessionId, "A known lowercase hosted role is required");
	const key = keyOf(sessionId, options);
	const state = stateOf(options);
	let attempt = state.attempts.get(key);
	if (!attempt || attempt.runId !== optional(options.runId)) {
		const notBefore = options.reportNotBefore === undefined ? undefined : Date.parse(options.reportNotBefore);
		if (notBefore !== undefined && !Number.isFinite(notBefore)) return running(sessionId, "Invalid reportNotBefore timestamp");
		attempt = { role, taskId: optional(options.taskId), runId: optional(options.runId), notBefore,
			resumed: notBefore !== undefined };
		state.attempts.set(key, attempt);
	}
	if (attempt.role !== role) return running(sessionId, "Hosted role does not match the current attempt");
	if (attempt.terminal) return completionResult(attempt.terminal);
	try {
		const snapshot = await check(sessionId, options);
		if (state.attempts.get(key) !== attempt) return running(sessionId); // In-flight OLD check after resume.
		if (attempt.terminal) return completionResult(attempt.terminal);
		return finish(sessionId, attempt, snapshot, options);
	} catch (error) {
		return running(sessionId, errorText(error));
	}
}
