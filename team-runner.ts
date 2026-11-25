/**
 * team-runner.ts
 *
 * Native Pi process-level subagent runner for multi-agent workflows.
 *
 * Each subagent is an isolated `pi -p --session <file>` child process. The child session
 * file lives in the standard Pi sessions directory and carries the subagent metadata
 * (`pi-web:subagent*` custom entries, kept for on-disk compatibility with team-recovery).
 *
 * Design invariants:
 * - Every marker appended by the runner is chained (`parentId` = last entry id). Pi rebuilds the
 *   active branch from the last entry, so an unchained marker would hide the whole conversation
 *   from a resumed child and from recovery probes.
 * - Success is decided from the child session file (last assistant `stopReason`) plus the exit
 *   code, never from the exit code alone.
 * - Children are detached and write their stdout/stderr to a log file (no pipes), so they survive
 *   `/reload`, session switches, and parent exit. Completion is reported through process-wide
 *   listeners so a reloaded extension instance still receives it; if the parent process is gone,
 *   the session file is the durable record and recovery probes pick it up later.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { recoverChildReport, resolveChildSessionFile } from "./team-recovery.ts";

export interface AgentProfile {
	role: string;
	displayName?: string;
	tools: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	/** "append" (default) appends the profile body; "replace" replaces Pi's system prompt. */
	promptMode: "append" | "replace";
	loadMcp: boolean;
	loadSkills: boolean;
	loadExtensions: boolean;
	loadContextFiles: boolean;
}

export interface ChildCompletion {
	sessionId: string;
	role: string;
	taskId?: string;
	runId?: string;
	parentSessionId: string;
	status: "completed" | "failed" | "aborted";
	success: boolean;
	reportText?: string;
	stopReason?: string;
	code: number | null;
	signal: NodeJS.Signals | null;
	error?: string;
	logFile?: string;
}

export interface NativeRunnerOptions {
	agentDir?: string;
	cwd?: string;
	parentSessionId?: string;
	parentSessionFile?: string;
	/** Absolute path of the team extension; force-loaded into children whose profile disables extension discovery. */
	teamExtensionPath?: string;
	getModelOverride?: (role: string) => string | undefined;
	getThinkingOverride?: (role: string) => string | undefined;
	/** Per-launch completion callback (in addition to process-wide listeners). */
	onChildComplete?: (info: ChildCompletion) => void;
	/**
	 * Called once the child session file exists (fresh or resumed, before the process starts). The parent
	 * uses it to append the reciprocal pi-web link entry to its own session through pi.appendEntry.
	 */
	onChildSpawned?: (info: ChildSpawnInfo) => void;
}

export interface ChildSpawnInfo {
	sessionId: string;
	sessionFile: string;
	cwd: string;
	parentSessionId: string;
	parentSessionFile?: string;
	role: string;
	taskId?: string;
	resumed: boolean;
}

/**
 * pi-web nests a child under its parent (collapsible "agent subsession") only when the child header's
 * parentSession points at the parent file, the child carries this marker, and the parent carries the
 * reciprocal PI_WEB_PARENT_LINK_TYPE entry naming the child file (pi-web sessionSummaryScanner).
 */
export const PI_WEB_CHILD_LINK_TYPE = "pi-web.subsession.spawned";
export const PI_WEB_PARENT_LINK_TYPE = "pi-web.subsession.link";

export interface AgentCallParams {
	subagent_type?: string;
	prompt?: string;
	description?: string;
	run_in_background?: boolean;
	resume?: string;
	model?: string;
	thinking?: string;
	wait_timeout?: number;
	/** Ledger run id; recorded on markers so recovery can bind terminal evidence to this attempt. */
	run_id?: string;
}

export interface ActiveChild {
	sessionId: string;
	role: string;
	taskId?: string;
	runId?: string;
	parentSessionId: string;
	proc: ChildProcess;
	pid?: number;
	sessionFile: string;
	logFile: string;
	tmpFiles: string[];
	startedAt: number;
	completed: boolean;
	exitCode: number | null;
	outcome?: ChildCompletion;
	closePromise: Promise<ChildCompletion>;
}

export type ChildCompletionListener = (info: ChildCompletion) => void;

/** Prompts longer than this are passed as an attached file instead of argv (argv limit ~128 KiB). */
export const PROMPT_ARGV_LIMIT = 64 * 1024;
const LOG_TAIL_BYTES = 4096;
const FAILED_STOP_REASONS = new Set(["error", "aborted", "length"]);

// Process-wide registry: survives extension reloads (module re-evaluation) inside one host process.
interface RunnerRegistry {
	children: Map<string, ActiveChild>;
	listeners: Set<ChildCompletionListener>;
}
const REGISTRY_KEY = Symbol.for("pi-teams.native-runner.registry");
const registry: RunnerRegistry = ((globalThis as any)[REGISTRY_KEY] ??= {
	children: new Map<string, ActiveChild>(),
	listeners: new Set<ChildCompletionListener>(),
});
const activeChildren = registry.children;

/** Subscribe to completion of any child launched in this process. Returns an unsubscribe function. */
export function onSubagentComplete(listener: ChildCompletionListener): () => void {
	registry.listeners.add(listener);
	return () => { registry.listeners.delete(listener); };
}

export function getDefaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function isExecutable(file: string): boolean {
	try {
		fs.accessSync(file, fs.constants.X_OK);
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

/**
 * Locate the `pi` CLI: $PI_BIN, then $PATH, then next to the running node binary,
 * then the nvm bin of the running node version. Falls back to plain "pi".
 */
export function findPiExecutable(): string {
	const explicit = process.env.PI_BIN;
	if (explicit && isExecutable(explicit)) return explicit;
	const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi"];
	for (const dir of (process.env.PATH || "").split(path.delimiter)) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = path.join(dir, name);
			if (isExecutable(candidate)) return candidate;
		}
	}
	const candidates = [
		path.join(path.dirname(process.execPath), "pi"),
		path.join(os.homedir(), ".nvm", "versions", "node", process.version, "bin", "pi"),
		path.join(os.homedir(), ".local", "bin", "pi"),
		"/usr/local/bin/pi",
		"/opt/homebrew/bin/pi",
		"/usr/bin/pi",
	];
	for (const candidate of candidates) {
		if (isExecutable(candidate)) return candidate;
	}
	return "pi";
}

/**
 * Parses frontmatter YAML and markdown body from <agentDir>/agents/<role>.md.
 */
export function readAgentProfile(role: string, agentDir = getDefaultAgentDir()): AgentProfile | null {
	const filePath = path.join(agentDir, "agents", `${role}.md`);
	if (!fs.existsSync(filePath)) return null;

	let content = "";
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const base = {
		role,
		promptMode: "append" as const,
		loadMcp: true,
		loadSkills: true,
		loadExtensions: true,
		loadContextFiles: true,
	};

	const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!frontmatterMatch) {
		return { ...base, tools: defaultToolsForRole(role), systemPrompt: content.trim() };
	}

	const rawYaml = frontmatterMatch[1];
	const systemPrompt = frontmatterMatch[2].trim();
	const promptMode = parseScalarField(rawYaml, "prompt_mode") === "replace" ? "replace" : "append";
	// Enabled unless any of the spellings is explicitly off/false.
	const enabled = (...fields: string[]): boolean => fields.every((field) => parseBooleanField(rawYaml, field) !== false);

	return {
		...base,
		displayName: parseScalarField(rawYaml, "display_name"),
		tools: parseToolsField(rawYaml) ?? defaultToolsForRole(role),
		model: parseScalarField(rawYaml, "model"),
		thinking: parseScalarField(rawYaml, "thinking"),
		systemPrompt,
		promptMode,
		loadMcp: enabled("mcp", "load_mcp"),
		loadSkills: enabled("skills", "load_skills"),
		loadExtensions: enabled("extensions", "load_extensions"),
		loadContextFiles: enabled("context_files", "load_context_files"),
	};
}

function parseScalarField(yaml: string, field: string): string | undefined {
	const regex = new RegExp(`^${field}\\s*:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, "m");
	const m = yaml.match(regex);
	return m ? m[1].trim() : undefined;
}

function parseBooleanField(yaml: string, field: string): boolean | undefined {
	const raw = parseScalarField(yaml, field)?.toLowerCase();
	if (raw === undefined) return undefined;
	if (["false", "off", "no", "0", "disabled"].includes(raw)) return false;
	if (["true", "on", "yes", "1", "enabled"].includes(raw)) return true;
	return undefined;
}

function parseToolsField(yaml: string): string[] | undefined {
	const m = yaml.match(/^tools\s*:\s*([^#\r\n]+)/m);
	if (!m) return undefined;
	const raw = m[1].trim();
	const list = raw
		.replace(/^\[/, "")
		.replace(/\]$/, "")
		.split(",")
		.map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
		.filter(Boolean);
	return list.length > 0 ? list : undefined;
}

function defaultToolsForRole(role: string): string[] {
	switch (role.toLowerCase()) {
		case "cp":
		case "ayton":
			return ["read", "bash", "grep", "find", "ls"];
		default:
			return ["read", "bash", "edit", "write", "grep", "find", "ls"];
	}
}

export function getSessionDirPath(cwd: string, agentDir = getDefaultAgentDir()): string {
	const resolvedCwd = path.resolve(cwd);
	const safePath = "--" + resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
	return path.join(agentDir, "sessions", safePath);
}

export function parseTeamTaskIdFromPrompt(prompt: string): string | undefined {
	const match = prompt.match(/(?:^|\n)\s*TEAM_TASK:\s*([A-Za-z0-9_-]+)/);
	return match ? match[1] : undefined;
}

function newEntryId(): string {
	return crypto.randomBytes(4).toString("hex");
}

/** Id of the last non-header entry in a session JSONL file (the active leaf), or null. */
export function lastSessionEntryId(sessionFile: string): string | null {
	let raw = "";
	try {
		raw = fs.readFileSync(sessionFile, "utf-8");
	} catch {
		return null;
	}
	const lines = raw.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i].trim();
		if (!line) continue;
		try {
			const entry = JSON.parse(line);
			if (entry && entry.type !== "session" && typeof entry.id === "string" && entry.id) return entry.id;
		} catch {
			// skip a torn trailing line
		}
	}
	return null;
}

/**
 * Initializes a session JSONL file with header and subagent metadata so recovery probes,
 * direct probing, and session tree projections recognize it.
 */
function createChildSessionFile(
	sessionFile: string,
	childSessionId: string,
	cwd: string,
	parentSessionId: string,
	parentSessionFile: string | undefined,
	role: string,
	description: string,
	prompt: string,
	runId: string | undefined,
): void {
	const now = new Date().toISOString();
	const header = {
		type: "session",
		version: 3,
		id: childSessionId,
		timestamp: now,
		cwd,
		...(parentSessionFile ? { parentSession: parentSessionFile } : {}),
	};
	const meta = {
		type: "custom",
		id: newEntryId(),
		parentId: null,
		timestamp: now,
		customType: "pi-web:subagent",
		data: {
			version: 1,
			parentSessionId,
			...(parentSessionFile ? { parentSessionPath: parentSessionFile } : {}),
			profile: role,
			description,
			task: prompt,
		},
	};
	const statusEntry = {
		type: "custom",
		id: newEntryId(),
		parentId: meta.id,
		timestamp: now,
		customType: "pi-web:subagent-status",
		data: { version: 1, status: "running", ...(runId ? { runId } : {}) },
	};

	const entries: Array<Record<string, unknown>> = [header, meta, statusEntry];
	if (parentSessionId && parentSessionFile) {
		entries.push({
			type: "custom",
			id: newEntryId(),
			parentId: statusEntry.id,
			timestamp: now,
			customType: PI_WEB_CHILD_LINK_TYPE,
			data: { version: 1, spawnedBySessionId: parentSessionId, spawnedSessionId: childSessionId },
		});
	}
	const lines = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
	fs.writeFileSync(sessionFile, lines, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Backfill the pi-web child marker on resumed children created before linking existed. Only when the
 * child header already names this parent file; otherwise pi-web would reject the link anyway.
 */
export function ensureChildLinkMarker(sessionFile: string, childSessionId: string, parentSessionId: string, parentSessionFile: string | undefined): void {
	if (!parentSessionId || !parentSessionFile) return;
	try {
		const raw = fs.readFileSync(sessionFile, "utf-8");
		const header = JSON.parse(raw.slice(0, raw.indexOf("\n") >= 0 ? raw.indexOf("\n") : raw.length)) as { type?: string; id?: string; parentSession?: string };
		if (header.type !== "session" || header.id !== childSessionId || header.parentSession !== parentSessionFile) return;
		if (raw.includes(`"customType":"${PI_WEB_CHILD_LINK_TYPE}"`)) return;
		appendSessionMarker(sessionFile, PI_WEB_CHILD_LINK_TYPE, { version: 1, spawnedBySessionId: parentSessionId, spawnedSessionId: childSessionId });
	} catch {
		// Linking is cosmetic (pi-web sidebar nesting); never fail a launch over it.
	}
}

/** Append a custom marker chained to the current leaf so the active branch stays intact. */
export function appendSessionMarker(sessionFile: string, customType: string, data: Record<string, unknown>): void {
	try {
		const entry = {
			type: "custom",
			id: newEntryId(),
			parentId: lastSessionEntryId(sessionFile),
			timestamp: new Date().toISOString(),
			customType,
			data: { version: 1, ...data },
		};
		fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`, { encoding: "utf-8" });
	} catch {
		// best effort write
	}
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c: any) => c && c.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("\n");
}

/**
 * Reads the final assistant message of the child's active branch: its text (the report),
 * stopReason, and errorMessage. Tolerant of torn lines.
 */
export function readSessionOutcome(sessionFile: string): { found: boolean; text: string; stopReason?: string; errorMessage?: string } {
	let raw = "";
	try {
		raw = fs.readFileSync(sessionFile, "utf-8");
	} catch {
		return { found: false, text: "" };
	}
	const byId = new Map<string, any>();
	let leaf: any;
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (!entry || entry.type === "session" || typeof entry.id !== "string") continue;
			byId.set(entry.id, entry);
			leaf = entry;
		} catch {
			// ignore torn line
		}
	}
	let current = leaf;
	let lastText = "";
	const seen = new Set<string>();
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		if (current.type === "message" && current.message?.role === "assistant") {
			const text = textOf(current.message.content).trim();
			return {
				found: true,
				text: text || lastText,
				stopReason: typeof current.message.stopReason === "string" ? current.message.stopReason : undefined,
				errorMessage: typeof current.message.errorMessage === "string" ? current.message.errorMessage : undefined,
			};
		}
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return { found: false, text: "" };
}

function readLogTail(logFile: string): string {
	try {
		const fd = fs.openSync(logFile, "r");
		try {
			const size = fs.fstatSync(fd).size;
			const length = Math.min(size, LOG_TAIL_BYTES);
			const buffer = Buffer.alloc(length);
			fs.readSync(fd, buffer, 0, length, size - length);
			return buffer.toString("utf-8").trim();
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return "";
	}
}

const LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
let tmpDirSwept = false;

function runnerTmpDir(): string {
	const dir = path.join(os.tmpdir(), "pi-teams-subagents");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (!tmpDirSwept) {
		// Failure logs are kept for diagnosis; drop stale ones once per process.
		tmpDirSwept = true;
		try {
			const cutoff = Date.now() - LOG_RETENTION_MS;
			for (const name of fs.readdirSync(dir)) {
				const file = path.join(dir, name);
				try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch {}
			}
		} catch {}
	}
	return dir;
}

function safeUnlink(file: string | undefined): void {
	if (!file) return;
	try { fs.unlinkSync(file); } catch {}
}

/** Build the `pi` CLI argument list for one child run (exported for tests). */
export function buildChildArgs(input: {
	sessionFile: string;
	prompt: string;
	model?: string;
	thinking?: string;
	tools: string[];
	profile: AgentProfile | null;
	systemPromptFile?: string;
	promptFile?: string;
	teamExtensionPath?: string;
}): string[] {
	const args: string[] = ["-p", "--session", input.sessionFile];
	if (input.model) args.push("--model", input.model);
	if (input.thinking) args.push("--thinking", input.thinking);
	if (input.tools.length > 0) args.push("--tools", input.tools.join(","));
	const profile = input.profile;
	if (profile) {
		if (!profile.loadMcp) args.push("--no-mcp");
		if (!profile.loadSkills) args.push("--no-skills");
		if (!profile.loadContextFiles) args.push("--no-context-files");
		if (!profile.loadExtensions) {
			args.push("--no-extensions");
			// The team extension enforces child-side guards (bash timeouts, write scope): always keep it.
			if (input.teamExtensionPath) args.push("-e", input.teamExtensionPath);
		}
	}
	if (input.systemPromptFile) {
		args.push(profile?.promptMode === "replace" ? "--system-prompt" : "--append-system-prompt", input.systemPromptFile);
	}
	// "--" ends option parsing so a prompt starting with "-" is never read as a flag.
	args.push("--");
	if (input.promptFile) {
		args.push(`@${input.promptFile}`, "Carry out the task described in the attached file exactly as written.");
	} else {
		args.push(input.prompt);
	}
	return args;
}

function notifyCompletion(child: ActiveChild, info: ChildCompletion, perLaunch?: (info: ChildCompletion) => void): void {
	try { perLaunch?.(info); } catch {}
	for (const listener of [...registry.listeners]) {
		try { listener(info); } catch {}
	}
}

/**
 * Spawns a subagent process using the native Pi CLI.
 */
export async function launchNativeSubagent(
	params: AgentCallParams,
	options: NativeRunnerOptions,
	signal?: AbortSignal,
): Promise<{
	sessionId: string;
	reportText?: string;
	isError: boolean;
	error?: string;
	status: "running" | "completed" | "failed" | "aborted";
}> {
	const role = String(params.subagent_type || "bridges").toLowerCase();
	const prompt = typeof params.prompt === "string" ? params.prompt : "";
	const description = typeof params.description === "string" && params.description.trim()
		? params.description.trim()
		: prompt.split("\n")[0].slice(0, 80);
	const runInBackground = params.run_in_background !== false;
	const agentDir = options.agentDir || getDefaultAgentDir();
	const cwd = options.cwd || process.cwd();
	const parentSessionId = options.parentSessionId || "";
	const parentSessionFile = options.parentSessionFile;
	const taskId = parseTeamTaskIdFromPrompt(prompt);
	const runId = typeof params.run_id === "string" && params.run_id ? params.run_id : undefined;

	if (process.env.PI_TEAMS_DISABLE_NATIVE_SPAWN === "1") {
		return { sessionId: params.resume || "", isError: true, status: "failed", error: "Native subagent spawning is disabled (PI_TEAMS_DISABLE_NATIVE_SPAWN=1)." };
	}

	const profile = readAgentProfile(role, agentDir);
	const effectiveModel = params.model || options.getModelOverride?.(role) || profile?.model;
	const effectiveThinking = params.thinking || options.getThinkingOverride?.(role) || profile?.thinking;
	const effectiveTools = profile?.tools || defaultToolsForRole(role);

	// New child files go into the project directory; lookups scan the sessions root (team-recovery contract).
	const sessionsDir = getSessionDirPath(cwd, agentDir);
	const sessionsRoot = path.join(agentDir, "sessions");
	fs.mkdirSync(sessionsDir, { recursive: true });

	let childSessionId: string;
	let sessionFile: string;

	if (params.resume) {
		childSessionId = params.resume;
		const live = activeChildren.get(childSessionId);
		if (live && !live.completed) {
			return { sessionId: childSessionId, isError: true, status: "running", error: `Subagent ${childSessionId} is still running; wait for it (get_subagent_result) before resuming.` };
		}
		const resolved = resolveChildSessionFile(childSessionId, sessionsRoot);
		if (resolved.status === "found" && resolved.file) {
			sessionFile = resolved.file;
			ensureChildLinkMarker(sessionFile, childSessionId, parentSessionId, parentSessionFile);
			appendSessionMarker(sessionFile, "pi-web:subagent-status", { status: "running", ...(runId ? { runId } : {}) });
		} else {
			sessionFile = path.join(sessionsDir, `${new Date().toISOString().replace(/:/g, "-")}_${childSessionId}.jsonl`);
			createChildSessionFile(sessionFile, childSessionId, cwd, parentSessionId, parentSessionFile, role, description, prompt, runId);
		}
	} else {
		childSessionId = crypto.randomUUID();
		sessionFile = path.join(sessionsDir, `${new Date().toISOString().replace(/:/g, "-")}_${childSessionId}.jsonl`);
		createChildSessionFile(sessionFile, childSessionId, cwd, parentSessionId, parentSessionFile, role, description, prompt, runId);
	}

	try {
		options.onChildSpawned?.({ sessionId: childSessionId, sessionFile, cwd, parentSessionId, parentSessionFile, role, taskId, resumed: Boolean(params.resume) });
	} catch {
		// cosmetic linking must never break a launch
	}

	const tmpDir = runnerTmpDir();
	const stamp = `${role}-${childSessionId.slice(0, 8)}-${Date.now().toString(36)}`;
	const tmpFiles: string[] = [];
	let systemPromptFile: string | undefined;
	if (profile?.systemPrompt) {
		systemPromptFile = path.join(tmpDir, `system-${stamp}.md`);
		fs.writeFileSync(systemPromptFile, profile.systemPrompt, { encoding: "utf-8", mode: 0o600 });
		tmpFiles.push(systemPromptFile);
	}
	let promptFile: string | undefined;
	if (Buffer.byteLength(prompt, "utf-8") > PROMPT_ARGV_LIMIT) {
		promptFile = path.join(tmpDir, `prompt-${stamp}.md`);
		fs.writeFileSync(promptFile, prompt, { encoding: "utf-8", mode: 0o600 });
		tmpFiles.push(promptFile);
	}
	const logFile = path.join(tmpDir, `run-${stamp}.log`);

	const piBin = findPiExecutable();
	const args = buildChildArgs({
		sessionFile,
		prompt,
		model: effectiveModel,
		thinking: effectiveThinking,
		tools: effectiveTools,
		profile,
		systemPromptFile,
		promptFile,
		teamExtensionPath: options.teamExtensionPath,
	});

	const markFailed = (error: string) => {
		for (const file of tmpFiles) safeUnlink(file);
		appendSessionMarker(sessionFile, "pi-web:subagent-result", {
			status: "failed",
			error,
			completedAt: new Date().toISOString(),
			...(runId ? { runId } : {}),
		});
		return { sessionId: childSessionId, isError: true, error, status: "failed" as const };
	};

	let proc: ChildProcess;
	let logFd: number | undefined;
	try {
		logFd = fs.openSync(logFile, "a", 0o600);
		const pathPrefix = path.isAbsolute(piBin) ? `${path.dirname(piBin)}${path.delimiter}` : "";
		proc = spawn(piBin, args, {
			cwd,
			env: { ...process.env, PATH: `${pathPrefix}${process.env.PATH || ""}` },
			// No pipes: a log file keeps the child alive and quiet if the parent goes away.
			stdio: ["ignore", logFd, logFd],
			detached: process.platform !== "win32",
		});
	} catch (spawnError) {
		if (logFd !== undefined) try { fs.closeSync(logFd); } catch {}
		return markFailed(`Failed to spawn pi subagent (${piBin}): ${spawnError instanceof Error ? spawnError.message : String(spawnError)}`);
	} finally {
		// The child holds its own copy of the descriptor.
		if (logFd !== undefined) try { fs.closeSync(logFd); } catch {}
	}

	let resolveClose!: (info: ChildCompletion) => void;
	const closePromise = new Promise<ChildCompletion>((res) => { resolveClose = res; });

	const activeChild: ActiveChild = {
		sessionId: childSessionId,
		role,
		taskId,
		runId,
		parentSessionId,
		proc,
		pid: proc.pid,
		sessionFile,
		logFile,
		tmpFiles,
		startedAt: Date.now(),
		completed: false,
		exitCode: null,
		closePromise,
	};
	activeChildren.set(childSessionId, activeChild);
	// Do not keep the host alive just for a background child.
	if (runInBackground) proc.unref();

	let settled = false;
	const finish = (code: number | null, sig: NodeJS.Signals | null, spawnError?: Error) => {
		if (settled) return;
		settled = true;
		activeChild.completed = true;
		activeChild.exitCode = code;
		for (const file of tmpFiles) safeUnlink(file);

		const outcome = readSessionOutcome(sessionFile);
		const killed = Boolean(sig) || code === 130 || code === 143 || code === 129;
		const modelFailed = outcome.found && outcome.stopReason !== undefined && FAILED_STOP_REASONS.has(outcome.stopReason);
		let status: ChildCompletion["status"];
		if (spawnError) status = "failed";
		else if (killed) status = "aborted";
		else if (code === 0 && outcome.found && !modelFailed) status = "completed";
		else status = "failed";

		let error: string | undefined;
		if (status !== "completed") {
			const tail = readLogTail(logFile);
			const lastLine = tail.split(/\r?\n/).filter(Boolean).pop();
			error = spawnError?.message
				|| (modelFailed ? (outcome.errorMessage || `model stopped with stopReason=${outcome.stopReason}`) : undefined)
				|| (killed ? `terminated by ${sig ?? `exit code ${code}`}` : undefined)
				|| (!outcome.found && code === 0 ? "child exited without producing an assistant message" : undefined)
				|| lastLine
				|| `pi exited with code ${code}`;
			error = error.slice(0, 1000);
		} else {
			safeUnlink(logFile);
		}

		appendSessionMarker(sessionFile, "pi-web:subagent-result", {
			status,
			completedAt: new Date().toISOString(),
			exitCode: code,
			...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
			...(error ? { error, logFile } : {}),
			...(runId ? { runId } : {}),
		});

		const info: ChildCompletion = {
			sessionId: childSessionId,
			role,
			taskId,
			runId,
			parentSessionId,
			status,
			success: status === "completed",
			reportText: outcome.text,
			stopReason: outcome.stopReason,
			code,
			signal: sig,
			error,
			...(status !== "completed" ? { logFile } : {}),
		};
		activeChild.outcome = info;
		resolveClose(info);
		notifyCompletion(activeChild, info, options.onChildComplete);

		// Retain briefly for in-memory retrieval, then rely on the session file.
		const evict = setTimeout(() => {
			if (activeChildren.get(childSessionId) === activeChild) activeChildren.delete(childSessionId);
		}, 30_000);
		evict.unref?.();
	};

	proc.on("error", (err) => finish(null, null, err));
	proc.on("close", (code, sig) => finish(code, sig));

	const onAbort = () => {
		if (!activeChild.completed) terminateChild(activeChild);
	};
	// Only a foreground wait is tied to the caller's abort signal; background children outlive the call.
	if (!runInBackground) signal?.addEventListener("abort", onAbort, { once: true });

	if (runInBackground) {
		return { sessionId: childSessionId, isError: false, status: "running" };
	}

	const info = await closePromise;
	signal?.removeEventListener("abort", onAbort);

	let reportText = info.reportText;
	if (!reportText) {
		const recovered = recoverChildReport(childSessionId, { parentSessionId, sessionsDir: sessionsRoot, assumeStale: true });
		if (recovered.status === "recovered" && recovered.report) {
			reportText = recovered.report.content || recovered.report.text || "";
		}
	}

	return {
		sessionId: childSessionId,
		reportText,
		isError: !info.success,
		status: info.status === "completed" ? "completed" : info.status,
		error: info.error,
	};
}

function terminateChild(child: ActiveChild): void {
	const pid = child.proc.pid;
	const kill = (sig: NodeJS.Signals) => {
		try {
			// Detached children lead their own process group: signal the whole group (bash tools etc.).
			if (pid && process.platform !== "win32") process.kill(-pid, sig);
			else child.proc.kill(sig);
		} catch {
			try { child.proc.kill(sig); } catch {}
		}
	};
	kill("SIGTERM");
	const timer = setTimeout(() => { if (!child.completed) kill("SIGKILL"); }, 4000);
	timer.unref?.();
}

export function isSubagentActive(sessionId: string): boolean {
	const child = activeChildren.get(sessionId);
	return Boolean(child && !child.completed);
}

export function listActiveSubagents(): Array<{ sessionId: string; role: string; taskId?: string; pid?: number; startedAt: number }> {
	return [...activeChildren.values()]
		.filter((child) => !child.completed)
		.map(({ sessionId, role, taskId, pid, startedAt }) => ({ sessionId, role, taskId, pid, startedAt }));
}

/** Stop one running child (process group). Returns false when it is not tracked or already finished. */
export function stopSubagent(sessionId: string): boolean {
	const child = activeChildren.get(sessionId);
	if (!child || child.completed) return false;
	terminateChild(child);
	return true;
}

/**
 * Explicitly terminate every running child (e.g. `/team off`). Not used on session shutdown:
 * children are detached on purpose so reloads and session switches never destroy work.
 */
export function killAllActiveSubagents(): void {
	for (const child of activeChildren.values()) {
		if (!child.completed) terminateChild(child);
	}
}

/**
 * Retrieves the result of a subagent session.
 */
export async function getSubagentResult(
	sessionId: string,
	wait: boolean,
	options: NativeRunnerOptions & { waitTimeoutMs?: number },
): Promise<{ status: string; reportText?: string; error?: string }> {
	const active = activeChildren.get(sessionId);
	if (active && !active.completed) {
		if (!wait) return { status: "running" };
		const timeoutMs = options.waitTimeoutMs ?? 300_000;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			active.closePromise,
			new Promise((res) => { timer = setTimeout(res, timeoutMs); }),
		]);
		if (timer) clearTimeout(timer);
		if (!active.completed) return { status: "running" };
	}
	if (active?.outcome) {
		const outcome = active.outcome;
		return outcome.success
			? { status: "completed", reportText: outcome.reportText }
			: { status: outcome.status, reportText: outcome.reportText, error: outcome.error };
	}

	const agentDir = options.agentDir || getDefaultAgentDir();

	const recovered = recoverChildReport(sessionId, {
		parentSessionId: options.parentSessionId || "",
		sessionsDir: path.join(agentDir, "sessions"),
		assumeStale: true,
	});

	if (recovered.status === "recovered" && recovered.report) {
		return { status: "completed", reportText: recovered.report.content || recovered.report.text || "" };
	}
	if (recovered.status === "native-completed") {
		return { status: "completed", reportText: recovered.nativeReportText };
	}
	if (recovered.status === "native-running") {
		return { status: "running" };
	}
	return { status: recovered.status, error: recovered.reason };
}
