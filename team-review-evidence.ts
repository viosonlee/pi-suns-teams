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
	/** Home directory used to expand `~/...` citations. */
	home?: string;
	exists?: (absolutePath: string) => boolean;
	readFile?: (absolutePath: string) => string | null;
	/** Commands the harness actually observed the reviewer running. */
	observedCommands?: string[];
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
const PATH_CHARS = "[\\w@./~+-]";

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
	const fileLine = new RegExp(`(${PATH_CHARS}*\\.${FILE_EXT}):(\\d+)`, "g");
	for (const match of source.matchAll(fileLine)) {
		const path = match[1].replace(/^[("'`<[]+/, "");
		if (!path) continue;
		push({ kind: "file_line", raw: `${cleanPath(path)}:${match[2]}`, path: cleanPath(path), line: Number(match[2]) });
	}

	// Bare paths with a known extension (skip ones already captured with a line,
	// and skip quoted relative import specifiers like `from '../src/foo.mjs'` or `require('../x.js')`).
	const barePath = new RegExp(`(?:^|[\\s("'\`\\[=])((?:~/?)?${PATH_CHARS}*\\.${FILE_EXT})(?![\\w.])`, "g");
	for (const match of source.matchAll(barePath)) {
		const path = match[1];
		if (!path || refs.some(r => r.kind === "file_line" && r.raw.startsWith(`${path}:`))) continue;
		if (/^\.\.?\//.test(path) && typeof match.index === "number") {
			const before = source.slice(Math.max(0, match.index - 24), match.index + 1);
			if (/\b(?:from|import|require|include)\s*[("'`\s]*$/i.test(before)) continue;
		}
		push({ kind: "path", raw: cleanPath(path), path: cleanPath(path) });
	}

	// Diff hunks
	const hunk = /@@\s*-\d+(?:,\d+)?\s*\+\d+(?:,\d+)?\s*@@?/g;
	for (const match of source.matchAll(hunk)) push({ kind: "diff", raw: match[0].trim(), hunk: match[0].trim() });
	if (/\bgit\s+diff\b/.test(source)) push({ kind: "diff", raw: "git diff" });

	// Commands: `$ cmd`, `ran: cmd`, `command: cmd`, fenced shell lines.
	for (const match of source.matchAll(/(?:^|[\s(`])\$\s+([^\n]+)/g)) push({ kind: "command", raw: match[1].trim(), command: match[1].trim() });
	for (const match of source.matchAll(/\b(?:ran|run|command|cmd|executed)\s*[::]\s*`?([^`\n]{3,200})/gi)) {
		push({ kind: "command", raw: match[1].trim(), command: match[1].trim() });
	}

	return refs;
}

function sameCommand(a: string, b: string): boolean {
	const norm = (s: string) => s.replace(/\s+/g, " ").trim();
	const left = norm(a), right = norm(b);
	if (!left || !right) return false;
	if (left === right) return true;
	// Observed commands are often wrapped in sandbox prefixes; accept containment both ways.
	return left.includes(right) || right.includes(left);
}

/** Verify extracted refs against real artefacts. `ok` is true only with at least one verified ref and zero failures. */
export function verifyEvidenceRefs(refs: EvidenceRef[], io: EvidenceIo): EvidenceAudit {
	const exists = io.exists ?? (() => false);
	const readFile = io.readFile ?? (() => null);
	const observed = io.observedCommands ?? [];
	const audit: EvidenceAudit = { verified: [], failed: [], unverifiable: [], ok: false };

	for (const ref of refs) {
		if (ref.kind === "command") {
			const cmd = ref.command ?? ref.raw;
			if (observed.length && observed.some(o => sameCommand(o, cmd))) audit.verified.push(`command: ${cmd}`);
			else audit.unverifiable.push(`command not observed in reviewer session: ${cmd}`);
			continue;
		}
		if (ref.kind === "diff") {
			if (observed.some(o => /git\s+diff/.test(o))) audit.verified.push(`diff: ${ref.raw}`);
			else audit.unverifiable.push(`diff claim without an observed git diff: ${ref.raw}`);
			continue;
		}
		const path = absoluteEvidencePath(ref.path ?? ref.raw, io);
		if (!exists(path)) {
			audit.failed.push(`missing file: ${ref.raw}`);
			continue;
		}
		if (ref.kind === "file_line") {
			const content = readFile(path);
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
			audit.verified.push(`file:line ${ref.raw}`);
			continue;
		}
		audit.verified.push(`file ${ref.raw}`);
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
