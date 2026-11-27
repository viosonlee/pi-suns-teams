/**
 * Structured review protocol for the Pi Team workflow.
 *
 * Pure module: no host imports, no side effects, deterministic.
 * The reviewer agent must emit a line-anchored `VERDICT: <state>` header plus one
 * `CRITERION: ... => PASS|FAIL|UNVERIFIED | evidence: ...` line per acceptance
 * criterion, each bound to a distinct criterion. Anything else is INCOMPLETE and
 * must never be read as PASS. Evidence must be machine-checkable (file:line,
 * path, diff, or an observed command); free prose is not evidence.
 */
import { hasCheckableEvidence } from "./team-review-evidence.ts";

export type ReviewVerdict = "PASS" | "REWORK" | "ESCALATE" | "INCOMPLETE";
export type ReviewCheckStatus = "pass" | "fail" | "unverified";

export interface ReviewCheck {
	criterion: string;
	status: ReviewCheckStatus;
	evidence: string;
	/** Acceptance criterion index (0-based) this check was bound to, when matched uniquely. */
	acceptanceIndex?: number;
}

export interface ReviewOutcome {
	verdict: ReviewVerdict;
	checks: ReviewCheck[];
	/** Acceptance criteria with no uniquely bound check. */
	unmatched: string[];
	/** Checks that could not be bound to a distinct acceptance criterion. */
	duplicateChecks: string[];
	defects: string[];
	nextActions: string[];
	/** Verbatim report text. Never truncated, never sliced. */
	raw: string;
	/** True only when a well-formed line-anchored verdict header was found. */
	parsed: boolean;
	reasons: string[];
}

export interface ReviewBrief {
	taskId: string;
	title: string;
	acceptance: string[];
	workerReport: string;
	deliveryPaths: string[];
	deliveryVersion: string;
	baseVersion?: string;
	/** Hash/sha of the artefacts as they were when this review was opened. */
	fingerprint?: string;
}

const VERDICT_WORDS: ReviewVerdict[] = ["PASS", "REWORK", "ESCALATE", "INCOMPLETE"];
const CHECK_WORDS: ReviewCheckStatus[] = ["pass", "fail", "unverified"];

/**
 * Strip markdown bullets, inline code backticks, double-tilde strikethrough and delimiter
 * emphasis without corrupting snake_case file paths (`docs/01_spec/...`), globs (`*.py`),
 * or home paths (`~/foo`).
 */
function normalizeLine(line: string): string {
	let cleaned = line.replace(/^\s*(?:[-*+](?=\s)|\d+[.)](?=\s)|[>#])+\s*/, "");
	cleaned = cleaned.replace(/[`]|~~/g, "");
	for (let pass = 0; pass < 3; pass++) {
		const next = cleaned.replace(
			/(^|[\s(\["'>=:])(\*\*|__|\*|_)([^\s*_\n](?:[^\n]*?[^\s*_\n])?)\2(?=$|[\s)\]"',:;!?<]|\.(?![\p{L}\p{N}_]))/gu,
			(full, lead: string, delim: string, inner: string) => {
				if (delim.length === 1 && delim === "_" && (/[\/\\]/.test(inner) || /[\p{L}\p{N}_]\.[\p{L}\p{N}]+$/u.test(inner))) {
					return full;
				}
				if (delim === "*" && /\/\*|\*\//.test(full)) {
					return full;
				}
				return `${lead}${inner}`;
			},
		);
		if (next === cleaned) break;
		cleaned = next;
	}
	return cleaned.replace(/\s+/g, " ").trim();
}

function isBullet(line: string): boolean {
	return /^\s*(?:[-*+>]|\d+[.)])\s+/.test(line);
}

function bulletText(line: string): string {
	return normalizeLine(line).replace(/^[-–—:]\s*/, "").trim();
}

function asCheckStatus(word: string): ReviewCheckStatus | undefined {
	const lowered = word.toLowerCase();
	if (lowered === "pass" || lowered === "passed" || lowered === "ok" || lowered === "verified") return "pass";
	if (lowered === "fail" || lowered === "failed" || lowered === "failing") return "fail";
	if (lowered === "unverified" || lowered === "unchecked" || lowered === "unknown" || lowered === "incomplete") return "unverified";
	return undefined;
}

function parseVerdict(normalized: string): ReviewVerdict | undefined {
	// `VERDICT: PASS`, `Verdict -> rework`, `VERDICT:: \`ESCALATE\`` all collapse to the same shape after normalization.
	const match = /^VERDICT\b[^A-Za-z0-9]{0,4}([A-Za-z]+)/i.exec(normalized);
	if (!match) return undefined;
	const word = match[1].toUpperCase();
	if (word === "FAIL" || word === "FAILED" || word === "REJECT" || word === "REJECTED") return "REWORK";
	return (VERDICT_WORDS as string[]).includes(word) ? (word as ReviewVerdict) : undefined;
}

function parseCheck(normalized: string): { index?: number; check: ReviewCheck } | undefined {
	const head = /^(CRITERION|CRITERIA|AC|ACCEPTANCE)(?:\s*\[?\s*(\d+)\s*\]?)?(?:\s*([:\u2014\u2013\-.)]))?\s+(.*)$/i.exec(normalized);
	if (!head) return undefined;
	const kind = head[1].toUpperCase();
	let index = head[2] ? Number(head[2]) : undefined;
	const sep = head[3] ?? "";
	let rest = (head[4] ?? "").trim();
	if (kind === "AC" || kind === "ACCEPTANCE") {
		// Require an explicit separator after AC/ACn/ACCEPTANCE (e.g. `AC1:`, `AC1 —`, `AC1 -`, `ACCEPTANCE:`)
		// so plain prose like "AC power failed" or "Acceptance tests passed" is never parsed as a check.
		if (!sep) return undefined;
	}
	// Also accept `CRITERION: 3 <text>`, `CRITERION: AC1 <text>`, or `CRITERION: AC1 — <text>` as an explicit AC index.
	if (!index) {
		const acLead = /^AC\s*\[?\s*(\d{1,2})\s*\]?\s*[:\u2014\u2013\-.)]?\s+(?=\S)/i.exec(rest);
		if (acLead) {
			index = Number(acLead[1]);
			rest = rest.slice(acLead[0].length);
		} else {
			const bare = /^(\d{1,2})\s+(?=\S)/.exec(rest);
			if (bare) { index = Number(bare[1]); rest = rest.slice(bare[0].length); }
		}
	}
	rest = rest.replace(/^[:\u2014\u2013\-]+\s*/, "").trim();
	if (!rest) return undefined;

	let criterion = rest;
	let verdictPart = "";
	// Match `=>` / `->` / `→` ONLY when followed by a recognized check status word, so arrows inside
	// code/specs like `val < min -> min` never hijack the verdict separator.
	const statusArrow = /(?:=>|->|\u2192)\s*(?=(?:PASS(?:ED)?|OK|VERIFIED|FAIL(?:ED|ING)?|UNVERIFIED|UNCHECKED|UNKNOWN|INCOMPLETE)\b)/i.exec(rest);
	const arrow = statusArrow ?? /=>|->|\u2192/.exec(rest);
	const leadingStatus = /^(PASS(?:ED)?|OK|VERIFIED|FAIL(?:ED|ING)?|UNVERIFIED|UNCHECKED|UNKNOWN|INCOMPLETE)\b/i.exec(rest);
	if (leadingStatus && index !== undefined) {
		// Compact form: `CRITERION AC1: PASS — src/calc.mjs:5-9 ...`
		criterion = `AC${index}`;
		verdictPart = rest;
	} else if (statusArrow) {
		criterion = rest.slice(0, statusArrow.index).trim();
		verdictPart = rest.slice(statusArrow.index + statusArrow[0].length).trim();
	} else {
		const wordMatch = /\b(PASS(?:ED)?|OK|VERIFIED|FAIL(?:ED|ING)?|UNVERIFIED|UNCHECKED|UNKNOWN|INCOMPLETE)\b/i.exec(rest);
		if (wordMatch) {
			criterion = rest.slice(0, wordMatch.index).replace(/[:\u2014\u2013\-\s]+$/, "").trim();
			verdictPart = rest.slice(wordMatch.index).trim();
		} else if (arrow) {
			criterion = rest.slice(0, arrow.index).trim();
			verdictPart = rest.slice(arrow.index + arrow[0].length).trim();
		}
	}
	if (!criterion && index !== undefined) criterion = `AC${index}`;
	if (!criterion) return undefined;

	let statusWord = verdictPart.match(/^([A-Za-z]+)/)?.[1] ?? "";
	let evidence = "";
	const evidenceMatch = /EVIDENCE\s*[::]\s*(.*)$/i.exec(verdictPart || rest);
	if (evidenceMatch) evidence = evidenceMatch[1].trim();
	if (!statusWord && evidenceMatch) {
		statusWord = rest.slice(0, rest.indexOf(evidenceMatch[0])).match(/([A-Za-z]+)/)?.[1] ?? "";
	}
	const status = asCheckStatus(statusWord);
	if (!status) {
		// A criterion line without a recognisable status is not a verified check.
		return { index, check: { criterion, status: "unverified", evidence } };
	}
	if (!evidence && verdictPart) {
		evidence = verdictPart.replace(/^[A-Za-z]+\b/, "").replace(/^[\s:\u2014\u2013\-|]+/, "").trim();
	}
	return { index, check: { criterion, status, evidence } };
}

type Section = "defects" | "next" | "other";

function parseSectionHeader(normalized: string): Section | undefined {
	if (/^DEFECTS?\b\s*[::]?$/i.test(normalized) || /^DEFECTS?\b\s*[::]\s*$/i.test(normalized)) return "defects";
	if (/^(NEXT(?: STEPS| ACTIONS?)?|REWORK(?: INSTRUCTIONS?| REQUIRED)?|ACTIONS?|INSTRUCTIONS?)\b\s*[::]?\s*$/i.test(normalized)) return "next";
	if (/^[A-Z][A-Z0-9 ()/_-]{2,}\s*[::]?$/.test(normalized)) return "other";
	return undefined;
}

const STOPWORDS = new Set(["the", "and", "for", "with", "that", "this", "must", "should", "have", "has", "are", "was", "were", "will", "from", "into", "all", "any", "each", "not", "can", "its", "their", "when", "then", "than", "there", "which", "been", "being", "only", "also"]);

/** Light suffix folding so "releases"/"released"/"release" and "slots"/"slot" agree. */
function fold(token: string): string {
	if (token.length <= 4) return token;
	for (const suffix of ["ations", "ation", "ings", "ing", "ies", "ed", "es", "s"]) {
		if (token.length - suffix.length >= 4 && token.endsWith(suffix)) return token.slice(0, -suffix.length);
	}
	return token;
}

function tokens(text: string): Set<string> {
	const words = (text.toLowerCase().match(/[a-z0-9_.\-/]{3,}/g) ?? []).filter(w => !STOPWORDS.has(w));
	return new Set(words.map(fold));
}

/** Overlap score in [0,1]: shared tokens over the smaller token set, so paraphrase still matches. */
function overlapScore(a: string, b: string): number {
	const left = tokens(a), right = tokens(b);
	if (!left.size || !right.size) return 0;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared++;
	return shared / Math.min(left.size, right.size);
}

const MATCH_THRESHOLD = 0.34;
// A last-resort binding still needs *some* lexical link; a single free slot is not evidence.
const MATCH_FLOOR = 0.2;

/**
 * Bind each check to a DISTINCT acceptance criterion.
 * Slot count alone is not enough: two checks about AC1 must never satisfy AC2.
 */
function bindChecks(hits: Array<{ index?: number; check: ReviewCheck }>, criteria: string[]): {
	ordered: ReviewCheck[]; unmatched: string[]; duplicateChecks: string[];
} {
	const duplicateChecks: string[] = [];
	if (!criteria.length) {
		return { ordered: hits.map(h => h.check), unmatched: [], duplicateChecks };
	}
	const slots: Array<ReviewCheck | null> = criteria.map(() => null);
	const leftover: ReviewCheck[] = [];

	// Pass 1: explicit `ACn` / `CRITERION n` indices claim their own slot.
	for (const hit of hits) {
		if (hit.index && hit.index >= 1 && hit.index <= criteria.length && !slots[hit.index - 1]) {
			hit.check.acceptanceIndex = hit.index - 1;
			slots[hit.index - 1] = hit.check;
		} else if (hit.index && hit.index >= 1 && hit.index <= criteria.length) {
			duplicateChecks.push(`${hit.check.criterion} (index AC${hit.index} already claimed)`);
		} else {
			leftover.push(hit.check);
		}
	}

	// Pass 2: bind the rest by best text overlap, one criterion each, best score first.
	const scored: Array<{ check: ReviewCheck; slot: number; score: number }> = [];
	for (const check of leftover) {
		for (let i = 0; i < criteria.length; i++) {
			if (slots[i]) continue;
			scored.push({ check, slot: i, score: overlapScore(check.criterion, criteria[i]) });
		}
	}
	scored.sort((a, b) => b.score - a.score);
	const bound = new Set<ReviewCheck>();
	for (const candidate of scored) {
		if (bound.has(candidate.check) || slots[candidate.slot]) continue;
		if (candidate.score < MATCH_THRESHOLD) continue;
		candidate.check.acceptanceIndex = candidate.slot;
		slots[candidate.slot] = candidate.check;
		bound.add(candidate.check);
	}

	// Pass 3: a leftover check may take the only free slot only if it still shares
	// meaningful wording with it; otherwise it is a duplicate report of another criterion.
	for (const check of leftover) {
		if (bound.has(check)) continue;
		const free = slots.map((s, i) => (s ? -1 : i)).filter(i => i >= 0);
		if (free.length === 1 && overlapScore(check.criterion, criteria[free[0]]) >= MATCH_FLOOR) {
			check.acceptanceIndex = free[0];
			slots[free[0]] = check;
			bound.add(check);
		} else {
			duplicateChecks.push(`${check.criterion} (no distinct acceptance criterion left)`);
		}
	}

	const unmatched = criteria.filter((_, i) => !slots[i]);
	const ordered = slots.filter((s): s is ReviewCheck => !!s);
	return { ordered, unmatched, duplicateChecks };
}

/**
 * Parse a reviewer report. Fail-closed: a missing or unsupported verdict header,
 * an incomplete or ambiguously bound checklist, machine-unverifiable evidence, or a
 * PASS contradicting its own checks yields INCOMPLETE.
 */
export function parseReviewReport(text: string, acceptance: string[] = []): ReviewOutcome {
	const raw = typeof text === "string" ? text : text == null ? "" : String(text);
	const criteria = Array.isArray(acceptance) ? acceptance.filter(a => typeof a === "string" && a.trim()) : [];
	const lines = raw.split(/\r?\n/);

	const verdicts: ReviewVerdict[] = [];
	const checkHits: Array<{ index?: number; check: ReviewCheck }> = [];
	const defects: string[] = [];
	const nextActions: string[] = [];
	let section: Section = "other";
	let expectEvidenceFor = -1;

	for (const line of lines) {
		const normalized = normalizeLine(line);
		if (!normalized) { expectEvidenceFor = -1; continue; }

		const verdict = parseVerdict(normalized);
		if (verdict) { verdicts.push(verdict); expectEvidenceFor = -1; continue; }

		const check = parseCheck(normalized);
		if (check) {
			checkHits.push(check);
			expectEvidenceFor = checkHits.length - 1;
			section = "other";
			continue;
		}

		const header = parseSectionHeader(normalized);
		if (header) { section = header; expectEvidenceFor = -1; continue; }

		if (isBullet(line)) {
			const content = bulletText(line);
			if (!content) continue;
			if (section === "defects") defects.push(content);
			else if (section === "next") nextActions.push(content);
			else if (expectEvidenceFor >= 0 && checkHits[expectEvidenceFor]) {
				const hit = checkHits[expectEvidenceFor];
				hit.check.evidence = hit.check.evidence ? `${hit.check.evidence} ${content}` : content;
			}
			continue;
		}

		// Continuation line for the previous criterion's evidence block.
		if (expectEvidenceFor >= 0 && checkHits[expectEvidenceFor]) {
			const hit = checkHits[expectEvidenceFor];
			hit.check.evidence = hit.check.evidence ? `${hit.check.evidence} ${normalized}` : normalized;
		}
	}

	const reasons: string[] = [];
	if (verdicts.length === 0) {
		return { verdict: "INCOMPLETE", checks: checkHits.map(h => h.check), unmatched: [...criteria], duplicateChecks: [], defects, nextActions, raw, parsed: false, reasons: ["missing_verdict"] };
	}
	if (new Set(verdicts).size > 1) reasons.push("multiple_conflicting_verdicts");

	let verdict: ReviewVerdict = verdicts[0];
	const { ordered, unmatched, duplicateChecks } = bindChecks(checkHits, criteria);

	if (verdict === "PASS") {
		if (ordered.length === 0) {
			verdict = "INCOMPLETE";
			reasons.push("no_criteria_checked");
		}
		if (unmatched.length) {
			verdict = "INCOMPLETE";
			reasons.push(`unmatched_criteria:${criteria.map((c, i) => (unmatched.includes(c) ? `AC${i + 1}` : "")).filter(Boolean).join(",")}`);
		}
		if (duplicateChecks.length) {
			verdict = "INCOMPLETE";
			reasons.push(`duplicate_criterion_checks:${duplicateChecks.length}`);
		}
		if (ordered.some(c => c.status !== "pass")) {
			verdict = "INCOMPLETE";
			reasons.push("pass_without_verified_evidence");
		}
		const prose = ordered.filter(c => c.status === "pass" && !hasCheckableEvidence(c.evidence));
		if (prose.length) {
			verdict = "INCOMPLETE";
			reasons.push(`evidence_not_machine_checkable:${prose.map(c => (c.acceptanceIndex !== undefined ? `AC${c.acceptanceIndex + 1}` : c.criterion)).join(",")}`);
		}
	}
	if (verdict === "REWORK" && defects.length === 0 && nextActions.length === 0) reasons.push("no_defects_listed");
	if (verdict === "ESCALATE" && defects.length === 0 && nextActions.length === 0) reasons.push("no_escalation_reason");

	return { verdict, checks: ordered, unmatched, duplicateChecks, defects, nextActions, raw, parsed: true, reasons };
}

/** Short human summary for the ledger. The full report stays in `raw` / the review record. */
export function reviewSummary(outcome: ReviewOutcome): string {
	const counts = { pass: 0, fail: 0, unverified: 0 };
	for (const check of outcome.checks) counts[check.status]++;
	const parts = [
		`VERDICT: ${outcome.verdict}`,
		`checks=${outcome.checks.length} (pass ${counts.pass}/fail ${counts.fail}/unverified ${counts.unverified})`,
	];
	if (outcome.reasons.length) parts.push(`reasons: ${outcome.reasons.join(", ")}`);
	if (outcome.defects.length) parts.push(`defects: ${outcome.defects.slice(0, 3).join(" | ")}`);
	if (outcome.nextActions.length) parts.push(`next: ${outcome.nextActions.slice(0, 3).join(" | ")}`);
	return parts.join("; ");
}

/** Review brief handed to the reviewer agent. Worker self-report is input, never verdict evidence. */
export function buildReviewerPrompt(brief: ReviewBrief): string {
	const criteria = brief.acceptance.map((a, i) => `AC${i + 1}. ${a}`).join("\n") || "AC1. (no acceptance criteria recorded)";
	return [
		`REVIEW TASK for ${brief.taskId}: ${brief.title}`,
		"",
		"Acceptance criteria that must each be verified independently:",
		criteria,
		"",
		`Delivery version: ${brief.deliveryVersion}${brief.baseVersion ? ` (base ${brief.baseVersion})` : ""}`,
		`Review fingerprint: ${brief.fingerprint ?? "unavailable"} (re-checked when your result returns; if the artefacts changed, your verdict is discarded as stale)`,
		`Delivery paths: ${brief.deliveryPaths.length ? brief.deliveryPaths.join(", ") : "none recorded"}`,
		"",
		"Worker self-report (INPUT ONLY — it is a claim, not evidence):",
		"<<<WORKER_REPORT",
		brief.workerReport,
		"WORKER_REPORT>>>",
		"",
		"You must inspect the actual artefacts yourself before judging. Non-negotiable procedure:",
		"1. Open every delivered file and read the changed lines. Do not trust the report text.",
		"2. Run `git diff` (or an equivalent) to see exactly what changed against the base.",
		"3. Re-run the relevant tests/checks yourself and read their output and exit code.",
		"4. Bind each CRITERION line to a DIFFERENT acceptance criterion. Two checks about AC1 do not",
		"   satisfy AC2; an unbound criterion makes the whole review INCOMPLETE.",
		"5. Cite machine-checkable evidence per criterion: `path:line`, an existing `path`, a diff hunk,",
		"   or a command you actually ran. Free prose ('looks correct', 'tests pass') is NOT evidence and",
		"   forces INCOMPLETE. The harness re-resolves your citations on disk and discards unresolvable ones.",
		"",
		"Never modify the reviewed deliverable. Never accept the worker's word. Never approve a criterion",
		"you did not personally verify — write UNVERIFIED and verdict INCOMPLETE instead.",
		"",
		"Reply with exactly this structure:",
		"VERDICT: PASS | REWORK | ESCALATE | INCOMPLETE",
		"CRITERION: <ACn text> => PASS | FAIL | UNVERIFIED | evidence: <path:line, path, diff hunk, or `$ command`>",
		"(exactly one CRITERION line per acceptance criterion above, each for a different AC)",
		"DEFECTS:",
		"- <concrete defect with path:line evidence> (required for REWORK and ESCALATE)",
		"NEXT:",
		"- <actionable instruction naming the file and the required change> (required for REWORK and ESCALATE)",
		"",
		"Rules: PASS requires every criterion verified with cited, resolvable evidence AND every defect",
		"absent. Missing or unobtainable evidence means INCOMPLETE, never PASS. Do not stack another",
		"reviewer; record your own checks in the report.",
	].join("\n");
}
