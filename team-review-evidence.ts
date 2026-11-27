/**
 * Machine-checkable review evidence.
 *
 * A reviewer that only fills a form is not a reviewer. This module extracts the
 * concrete artefact references a reviewer cites (`path:line`, `path`, `git diff`,
 * executed command) and verifies them against the real filesystem / the commands
 * that were actually observed in the reviewer session.
 *
 * Pure by construction: all IO is injected, so unit tests need no host and no files.
 * A citation that cannot be resolved is never silently accepted.
 */

export type EvidenceKind = "file_line" | "path" | "diff" | "command";

export interface EvidenceRef {
	kind: EvidenceKind;
	raw: string;
	/** Absolute or repo-relative path as written by the reviewer. */
	path?: string;
	line?: number;
	/** Command text for `command` refs. */
	command?: string;
	/** Diff hunk header, e.g. `@@ -12,7 +12,9 @@`. */
	hunk?: string;
}

export interface EvidenceIo {
	/** Absolute cwd used to resolve relative paths. */
	cwd: string;
	/** Optional secondary cwds (e.g. worker worktreePath vs parent cwd) searched for relative citations. */
	fallbackCwds?: string[];
	/** Home directory used to expand `~/...` citations. */
	home?: string;
	exists?: (absolutePath: string) => boolean;
	readFile?: (absolutePath: string) => string | null;
	/** Commands the harness actually observed the reviewer running. */
	observedCommands?: string[];
	/**
	 * rework-M1: commands the harness observed the WORKER running during delivery, carried in
	 * `structuredEvidence.commands` on the worker task. Review-side re-observation is weaker than
	 * worker-side observation (the reviewer legitimately re-runs nothing sometimes), so citations
	 * matching these rows verify as `command: <cmd> [worker-observed]`.
	 */
	workerObservedCommands?: string[];
}

export interface EvidenceAudit {
	/** Human readable `raw` of each ref that resolved. */
	verified: string[];
	/** Refs that could not be resolved (missing file, line out of range, unobserved command). */
	failed: string[];
	/** Refs that are structurally fine but not machine-checkable (free text). */
	unverifiable: string[];
	/** True only when at least one ref verified and none failed. */
	ok: boolean;
}

const FILE_EXT = "(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|sh|bash|zsh|json|jsonl|ya?ml|toml|ini|md|txt|sql|css|scss|html|vue|svelte|lock|cfg|conf|env)";
const PATH_CHARS = "[\\p{L}\\p{N}@./~+_-]";
const STEM_CHARS = "[\\p{L}\\p{N}_+-]";

/** Collapse wrapper characters the reviewer may have added; keep the path as written. */
function cleanPath(p: string): string {
	return p.replace(/^file:\/\//, "").replace(/[),;]+$/, "").trim();
}

/** Resolve a written path against the session cwd; `~` expands against io.home when provided. */
export function absoluteEvidencePath(written: string, io: { cwd: string; home?: string }): string {
	const clean = cleanPath(written);
	if (clean.startsWith("~/")) return `${(io.home ?? io.cwd).replace(/\/+$/, "")}/${clean.slice(2)}`;
	if (clean.startsWith("/")) return clean;
	return `${io.cwd.replace(/\/+$/, "")}/${clean.replace(/^\.\//, "")}`;
}

function cleanCitedCommand(raw: string): string {
	let text = raw.trim();
	// Strip trailing prose explanations after an exit/status report while preserving commands like `node test.ts exit 0` when short.
	text = text
		.replace(/\s+\(exit(?:ed)?(?:\s+code)?(?:\s*[:=]\s*|\s+)\d+\)[\s\S]*$/i, "")
		.replace(/\s+(?:exited\s+(?:with\s+(?:code\s+)?)?\d+|returned\s+exit(?:\s+code)?\s+\d+)(?:\s*(?:[.,;—–\-]|and\b|confirm\w*\b|show\w*\b|verif\w*\b|report\w*\b|list\w*\b)[\s\S]*)?$/i, "")
		.replace(/\s+=>\s+(?:PASS|FAIL|OK|UNVERIFIED)[\s\S]*$/i, "")
		.replace(/[;,.]+$/, "")
		.trim();
	return text;
}

/**
 * Extract every machine-checkable reference from a free-text evidence string.
 * Order is stable and duplicates are removed by `kind + raw`.
 */
export function collectEvidenceRefs(text: string, cwd = ""): EvidenceRef[] {
	const source = typeof text === "string" ? text : "";
	const refs: EvidenceRef[] = [];
	const seen = new Set<string>();
	const push = (ref: EvidenceRef) => {
		const key = `${ref.kind}:${ref.raw}`;
		if (seen.has(key)) return;
		seen.add(key);
		refs.push(ref);
	};

	// `path:line` and `path:line-range`
	const fileLine = new RegExp(`(${PATH_CHARS}*${STEM_CHARS}\\.${FILE_EXT}):(\\d+)`, "gu");
	for (const match of source.matchAll(fileLine)) {
		const path = match[1].replace(/^[("'`<[]+/, "");
		if (!path) continue;
		push({ kind: "file_line", raw: `${cleanPath(path)}:${match[2]}`, path: cleanPath(path), line: Number(match[2]) });
	}

	// Bare paths with a known extension (skip ones already captured with a line,
	// and skip quoted relative import specifiers like `from '../src/foo.mjs'` or `require('../x.js')`).
	const barePath = new RegExp(`(?:^|[\\s("'\`\\[=])((?:~/?)?${PATH_CHARS}*${STEM_CHARS}\\.${FILE_EXT})(?![\\p{L}\\p{N}._-])`, "gu");
	for (const match of source.matchAll(barePath)) {
		const path = cleanPath(match[1]);
		if (!path || refs.some(r => r.kind === "file_line" && r.raw.startsWith(`${path}:`))) continue;
		if (/^\.\.?\//.test(path) && typeof match.index === "number") {
			const before = source.slice(Math.max(0, match.index - 24), match.index + 1);
			if (/\b(?:from|import|require|include)\s*[("'`\s]*$/i.test(before)) continue;
		}
		push({ kind: "path", raw: path, path });
	}

	// Diff hunks
	const hunk = /@@\s*-\d+(?:,\d+)?\s*\+\d+(?:,\d+)?\s*@@?/g;
	for (const match of source.matchAll(hunk)) push({ kind: "diff", raw: match[0].trim(), hunk: match[0].trim() });
	if (/\bgit\s+diff\b/.test(source)) push({ kind: "diff", raw: "git diff" });

	// Commands: backticked `$ cmd` / `ran: cmd`, or inline `$ cmd` (including multiple `$ ...; $ ...` segments).
	for (const match of source.matchAll(/`\$\s*([^`\n]+)`/g)) {
		const cmd = cleanCitedCommand(match[1]);
		if (cmd) push({ kind: "command", raw: cmd, command: cmd });
	}
	for (const match of source.matchAll(/(?:^|[\s(`])\$\s+([^\n]+)/g)) {
		const segments = match[1].split(/\s*(?:;|,|and)\s+\$\s+/i);
		for (const seg of segments) {
			const cmd = cleanCitedCommand(seg);
			if (cmd) push({ kind: "command", raw: cmd, command: cmd });
		}
	}
	for (const match of source.matchAll(/\b(?:ran|run|command|cmd|executed)\s*[::]\s*`([^`\n]{3,200})`/gi)) {
		const cmd = cleanCitedCommand(match[1]);
		if (cmd) push({ kind: "command", raw: cmd, command: cmd });
	}
	for (const match of source.matchAll(/\b(?:ran|run|command|cmd|executed)\s*[::]\s*([^\n]{3,200})/gi)) {
		const cmd = cleanCitedCommand(match[1].replace(/^`|`$/g, ""));
		if (cmd && !refs.some(r => r.kind === "command" && r.raw === cmd)) {
			push({ kind: "command", raw: cmd, command: cmd });
		}
	}

	return refs;
}

function splitShellClauses(cmd: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i];
		if (quote) {
			cur += ch;
			if (ch === "\\" && quote === '"' && i + 1 < cmd.length) {
				cur += cmd[++i];
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			cur += ch;
			continue;
		}
		if ((ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) {
			if (cur.trim()) out.push(cur.trim());
			cur = "";
			i++;
			continue;
		}
		if (ch === ";" || ch === "\n") {
			if (cur.trim()) out.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) out.push(cur.trim());
	return out;
}

function expandObservedVariants(raw: string): string[] {
	const norm = (s: string) => s.replace(/\s+/g, " ").trim();
	const base = norm(raw);
	if (!base) return [];
	const variants = new Set<string>([base]);
	for (const clause of splitShellClauses(base)) {
		const c = norm(clause);
		if (!c || /^cd\s+\S+$/.test(c)) continue;
		variants.add(c);
		// Strip trailing head/tail/redirection display noise when matching cited git/test commands.
		const noPipeNoise = norm(c.replace(/\s*\|\s*(?:head|tail)\b[^|]*$/i, "").replace(/\s+2>\s*(?:&1|\/dev\/null)\s*$/i, ""));
		if (noPipeNoise) variants.add(noPipeNoise);
		// Normalize `git -C <dir> ...` to `git ...` as an additional candidate alongside exact form.
		const noGitC = norm(c.replace(/\bgit\s+-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+/g, "git "));
		if (noGitC) variants.add(noGitC);
	}
	return [...variants];
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsTokenBounded(haystack: string, needle: string): boolean {
	if (!haystack || !needle) return false;
	if (haystack === needle) return true;
	if (needle.length < 4) return false;
	const re = new RegExp(`(?:^|[\\s"'\`;(&|])${escapeRegExp(needle)}(?:$|[\\s"'\`;)&|])`);
	return re.test(haystack);
}

function sameCommand(observedRaw: string, citedRaw: string): boolean {
	const norm = (s: string) => s.replace(/\s+/g, " ").trim();
	const cited = norm(citedRaw);
	const citedClean = norm(cleanCitedCommand(citedRaw));
	const citedNoGitC = norm(citedClean.replace(/\bgit\s+-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+/g, "git "));
	const citedCandidates = [...new Set([cited, citedClean, citedNoGitC].filter(Boolean))];
	const observedVariants = expandObservedVariants(observedRaw);
	for (const obs of observedVariants) {
		for (const c of citedCandidates) {
			if (obs === c || containsTokenBounded(obs, c) || containsTokenBounded(c, obs)) return true;
		}
	}
	return false;
}

/** Verify extracted refs against real artefacts. `ok` is true only with at least one verified ref and zero failures. */
export function verifyEvidenceRefs(refs: EvidenceRef[], io: EvidenceIo): EvidenceAudit {
	const exists = io.exists ?? (() => false);
	const readFile = io.readFile ?? (() => null);
	const observed = io.observedCommands ?? [];
	const audit: EvidenceAudit = { verified: [], failed: [], unverifiable: [], ok: false };
	const cwds = [io.cwd, ...(io.fallbackCwds ?? [])].filter((c, i, all) => Boolean(c) && all.indexOf(c) === i);
	const verifiedPaths: string[] = [];

	const resolveExistingPath = (written: string): string | null => {
		const clean = cleanPath(written);
		if (clean.startsWith("/") || clean.startsWith("~/")) {
			const abs = absoluteEvidencePath(written, io);
			return exists(abs) ? abs : null;
		}
		for (const cwd of cwds) {
			const abs = absoluteEvidencePath(written, { cwd, home: io.home });
			if (exists(abs)) return abs;
		}
		return null;
	};

	const pendingBareBasenames: EvidenceRef[] = [];
	for (const ref of refs) {
		if (ref.kind === "command") {
			const cmd = ref.command ?? ref.raw;
			// rework-M1: prefer harness-verified sources over plain prose. A command observed in the
			// reviewer's own session verifies; failing that, worker-side harness observation (carried
			// in the worker task's structured evidence) verifies with explicit attribution.
			if (observed.length && observed.some(o => sameCommand(o, cmd))) audit.verified.push(`command: ${cmd}`);
			else if ((io.workerObservedCommands ?? []).some(o => sameCommand(o, cmd))) audit.verified.push(`command: ${cmd} [worker-observed]`);
			else audit.unverifiable.push(`command not observed in reviewer session: ${cmd}`);
			continue;
		}
		if (ref.kind === "diff") {
			if (observed.some(o => /\bgit\s+(?:-C\s+\S+\s+)?diff\b/.test(o))) audit.verified.push(`diff: ${ref.raw}`);
			else audit.unverifiable.push(`diff claim without an observed git diff: ${ref.raw}`);
			continue;
		}
		const written = ref.path ?? ref.raw;
		const resolved = resolveExistingPath(written);
		if (!resolved) {
			if (ref.kind === "path" && !cleanPath(written).includes("/")) {
				pendingBareBasenames.push(ref);
			} else {
				audit.failed.push(`missing file: ${ref.raw}`);
			}
			continue;
		}
		if (ref.kind === "file_line") {
			const content = readFile(resolved);
			if (content === null) {
				audit.failed.push(`unreadable file: ${ref.raw}`);
				continue;
			}
			const lineCount = content.length ? content.split(/\r?\n/).length : 0;
			const line = ref.line ?? 0;
			if (line < 1 || line > Math.max(lineCount, 1)) {
				audit.failed.push(`line out of range: ${ref.raw} (file has ${lineCount} lines)`);
				continue;
			}
			verifiedPaths.push(resolved);
			audit.verified.push(`file:line ${ref.raw}`);
			continue;
		}
		verifiedPaths.push(resolved);
		audit.verified.push(`file ${ref.raw}`);
	}

	for (const bare of pendingBareBasenames) {
		const name = cleanPath(bare.path ?? bare.raw);
		if (verifiedPaths.some(vp => vp.endsWith(`/${name}`))) {
			audit.verified.push(`file ${bare.raw}`);
		} else {
			audit.failed.push(`missing file: ${bare.raw}`);
		}
	}

	audit.ok = audit.verified.length > 0 && audit.failed.length === 0;
	return audit;
}

/** Merge per-check audits for a whole report. */
export function mergeAudits(audits: EvidenceAudit[]): EvidenceAudit {
	const merged: EvidenceAudit = { verified: [], failed: [], unverifiable: [], ok: false };
	for (const audit of audits) {
		merged.verified.push(...audit.verified);
		merged.failed.push(...audit.failed);
		merged.unverifiable.push(...audit.unverifiable);
	}
	merged.ok = merged.verified.length > 0 && merged.failed.length === 0;
	return merged;
}

/** Structural gate: does this evidence string contain any machine-checkable reference at all? */
export function hasCheckableEvidence(text: string): boolean {
	return collectEvidenceRefs(typeof text === "string" ? text : "").some(ref => ref.kind !== "command" || !!ref.command);
}
