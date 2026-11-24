/**
 * team-gc.ts — Safe, lossless automatic archiver for terminal & orphaned subagent sessions.
 *
 * Design guarantees:
 * - Disk-first discovery scoped strictly to `parentSessionId`: finds ALL child sessions belonging
 *   to this parent (including historical children from before `/team new`, retries, or branch switches),
 *   never relying solely on `board.tasks` which only holds the current ledger window.
 *   Discovery is ONE bounded pass that builds a `sessionId -> files` index; ledger-only lookups
 *   ("does an unverified file for this id exist?") are O(1) map hits, never per-id directory rescans.
 * - Never hard-deletes sessions: moves eligible files into <agentDir>/sessions-archive/<workspace>/
 *   so pi-web's active sessions/ directory stays fast while full audit history stays recoverable.
 * - Never overwrites an archive entry: destination names are allocated collision-free (`name~2`,
 *   `name~3`, …) and every move is no-clobber (link-first, copy fallback with COPYFILE_EXCL).
 * - Moves the `.acp.json` sidecar BEFORE the `.jsonl` so a sidecar failure leaves the pair intact,
 *   and rolls the sidecar back if the jsonl move fails. A pair that is split across both trees is
 *   reported as a truthful partial receipt — never as an archived session. Interrupted runs are
 *   self-healing ONLY on proven provenance: an archive entry that is the same inode as the source
 *   (killed between `link` and `unlink`) is completed instead of duplicated, and its lone archived
 *   sidecar is re-paired in place. A same-stem archived sidecar whose provenance cannot be proven
 *   (no same-inode jsonl) is never adopted and never archived around: the pair stays in place and is
 *   reported as an ambiguous interrupted pair, because the jsonl must never be moved away from a
 *   sidecar that may be its own. A destination created by a move that then failed is tracked: it is
 *   only discarded after a CURRENT-state/ownership verification (never blindly unlinked), and
 *   otherwise named in the receipt — including paths whose state is UNKNOWN (`filesUnverified`) —
 *   so it never goes unaccounted.
 * - FAIL CLOSED on unverifiable filesystem state: an existence probe is "absent" ONLY for a true
 *   ENOENT; any other stat error (EIO, EACCES, …) is UNKNOWN. The completion gate refuses to report
 *   a session archived while any required path's state cannot be verified, and the pre-move checks
 *   retain the candidate in place when the sidecar's or the slot's state cannot be verified.
 * - A failed SIDECAR move tracks its own residue the same way a failed jsonl move does: a destination
 *   THIS move created is either safely discarded (proven ours) or named in a truthful partial
 *   receipt; an unowned destination is never deleted and a split pair is never reported as archived.
 * - FAIL CLOSED on unknown pin state: if `pi-web-session-state.json` exists but cannot be read or
 *   parsed, or declares no `sessions` object, NOTHING is archived (pinned sessions are user-owned
 *   evidence and must never be collected on a guess). Per-entry uncertainty (`pinnedAt` not a
 *   finite number) is treated as PINNED, i.e. preserved.
 * - Never touches root/parent sessions, pinned sessions, another parent's children, or any session
 *   referenced by a non-terminal task or live lease.
 * - Requires file mtime (and ledger timestamp if referenced) past cooldown (default 1h reviewers /
 *   24h workers & unreferenced historical children), well beyond pi-web's 10m idleTimeoutMs.
 */

import {
	closeSync,
	constants as fsConstants,
	copyFileSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	opendirSync,
	readFileSync,
	readSync,
	unlinkSync,
} from "node:fs";
import { basename, join } from "node:path";
import { terminalWork, type WorkTask } from "./team-ledger.ts";

export const DEFAULT_REVIEWER_GC_COOLDOWN_MS = 60 * 60_000; // 1 hour
export const DEFAULT_WORKER_GC_COOLDOWN_MS = 24 * 60 * 60_000; // 24 hours
export const MIN_SAFE_GC_COOLDOWN_MS = 30 * 60_000; // 30 min (> 3x pi-web 10m idleTimeoutMs)

const SUBAGENT_META_TYPE = "pi-web:subagent";
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** pi-web writes the `pi-web:subagent` custom entry near the top of every child session. */
const HEAD_SCAN_BYTES = 32 * 1024;
const PIN_STATE_FILE = "pi-web-session-state.json";
/**
 * Bounded discovery: a pathological `sessions/` tree must never turn a GC pass into an unbounded
 * scan. The budget is enforced while ENUMERATING (`opendirSync` streaming, so a single huge
 * directory is never materialized), and EVERY encountered directory entry counts — including
 * entries the scan later filters out. Truncation only ever HIDES candidates (never fabricates
 * one), so it is reported and the pass continues; it cannot make an unsafe archive decision.
 */
const MAX_DISCOVERY_ENTRIES = 20_000;
const MAX_DISCOVERY_SUBDIRS = 4096;
/** `name.jsonl` … `name~100.jsonl` before we refuse to archive (and keep the original). */
const MAX_COLLISION_SLOTS = 100;
/** `link(2)` errno values that mean "use the copy fallback" (EXDEV, permissions, no hardlinks). */
const LINK_FALLBACK_CODES = new Set(["EXDEV", "EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EMLINK", "EINVAL"]);

export interface GcMoveOp {
	kind: "jsonl" | "acp";
	src: string;
	dst: string;
	phase: "archive" | "rollback" | "adopt-late-sidecar" | "discard-failed-dest";
}

/** Semantic call site of a fail-closed existence probe (`__statFault` key; TEST-ONLY seam). */
export type StatProbePhase =
	| "sidecar-detection"
	| "allocation"
	| "stem-remnants"
	| "completion-remnants"
	| "completion"
	| "receipt";

export interface ChildGcOptions {
	agentDir: string;
	parentSessionId: string;
	tasks: WorkTask[];
	activeLeaseSessionIds: ReadonlySet<string>;
	/** Optional historical leases (settled or old) used only to recognize historical reviewer children. */
	historicalLeases?: Iterable<WorkTask>;
	nowMs?: number;
	reviewerCooldownMs?: number;
	workerCooldownMs?: number;
	dryRun?: boolean;
	/**
	 * TEST-ONLY fault seam (never set by production callers). `"fail"` simulates an I/O failure of
	 * that single move, `"copy"` forces the EXDEV/copy fallback, `"copy-then-fail"` reproduces the
	 * residue of a copy that completed and then could not unlink its source, `"link-then-fail"`
	 * reproduces the residue of a hardlink whose source unlink AND destination cleanup both failed,
	 * `undefined` is normal. The callback runs immediately BEFORE the move it describes, so a
	 * fixture may also use it to create the post-scan sidecar race (e.g. a sidecar that appears
	 * after discovery).
	 */
	__moveFault?: (op: GcMoveOp) => "fail" | "copy" | "copy-then-fail" | "link-then-fail" | undefined;
	/**
	 * TEST-ONLY fault seam for the fail-closed existence probes (never set by production callers).
	 * `"fail"` simulates a non-ENOENT stat error (state UNKNOWN) at that single probe so fixtures can
	 * exercise the EIO window deterministically; `undefined` is a normal probe.
	 */
	__statFault?: (path: string, phase: StatProbePhase) => "fail" | undefined;
	/** TEST-ONLY discovery-budget override (enumeration bounds are constants in production). */
	__discoveryLimits?: { maxEntries?: number; maxSubdirs?: number };
}

export interface ChildGcItem {
	sessionId: string;
	taskIds: string[];
	kind: "reviewer" | "worker" | "orphaned";
	sourceFile: string;
	archiveFile: string;
	bytes: number;
	/** Archive path of the `.acp.json` sidecar, `null` when the session had no sidecar. */
	acpArchiveFile?: string | null;
	/** True when the sidecar slot already held an interrupted-pair remnant that this run completed. */
	sidecarStaged?: boolean;
}

/**
 * Truthful receipt for a pair that could NOT be fully archived: at least one file is in the
 * archive and at least one original is still under `sessions/` (or a rollback failed). Never
 * counted in `archived`, so a caller can never believe a split pair was completed.
 */
export interface ChildGcPartialReceipt {
	sessionId: string;
	filesInArchive: string[];
	filesRetainedInPlace: string[];
	/**
	 * Paths that could not be verified when the receipt was assembled — the probe returned UNKNOWN
	 * (non-ENOENT stat error) or the entry's provenance could not be proven (e.g. a failed-move
	 * destination that no longer matches the fragment the move created). They are named explicitly
	 * so structured recovery accounting never loses an unresolved path; they are never claimed as
	 * verified archive evidence. Absent when every candidate was verifiable.
	 */
	filesUnverified?: string[];
	rollback: "none-needed" | "succeeded" | "failed";
	/**
	 * Why the pair could not be reported as archived. `ambiguous-interrupted-pair` means the archive
	 * already holds a same-stem `.acp.json` this run cannot prove is (or is not) this session's own
	 * sidecar, so the pair is kept in place untouched instead of being split by a jsonl move.
	 */
	reason?: "move-failed" | "split-pair" | "ambiguous-interrupted-pair";
	detail: string;
}

export interface ChildGcResult {
	totalMatched: number;
	archived: ChildGcItem[];
	partials: ChildGcPartialReceipt[];
	skippedActive: number;
	skippedCooldown: number;
	skippedPinned: number;
	skippedUnverified: number;
	/** Sessions left untouched because a filesystem step failed (pair preserved in place). */
	skippedMoveError: number;
	/**
	 * Sessions left untouched because the archive already holds a same-stem sidecar of unprovable
	 * provenance: the pair may be an interrupted pair, so completing it would strand the association.
	 */
	skippedAmbiguousPair: number;
	totalBytesFreed: number;
	errors: string[];
	warnings: string[];
	/** True when pin ownership could not be determined ⇒ the whole pass archived nothing. */
	pinsUnknown: boolean;
	discoveryTruncated: boolean;
	scannedFiles: number;
	/** All directory entries encountered while enumerating (bounded; includes filtered-out names). */
	scannedEntries: number;
}

/** Result of reading pi-web's pin/archive UI state. `ok:false` means ownership is UNKNOWN. */
export type PinnedSessionIds =
	| { ok: true; pinned: Set<string>; uncertain: string[] }
	| { ok: false; reason: string };

function isSafeId(id: string): boolean {
	return SAFE_SESSION_ID_RE.test(id) && !id.includes("..");
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function errCode(err: unknown): string | undefined {
	return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Fail-closed existence probe. `"absent"` is returned ONLY for a true ENOENT; every other stat
 * failure (EIO, EACCES, ENOTDIR, …) is `"unknown"`, which callers must treat as "cannot be
 * verified" — never as "absent". A dangling symlink still lstat-succeeds and is `"present"`
 * (OCCUPIED: never clobber it).
 */
export type EntryProbeState = "present" | "absent" | "unknown";

/** Bound probe passed into helpers (slot allocator, stem-remnant scanner). */
type EntryProbe = (path: string) => EntryProbeState;

/**
 * Map a stat failure to a probe state: ONLY a true ENOENT proves absence; every other failure
 * (EIO, EACCES, ENOTDIR, …) is UNKNOWN and must be treated as "cannot be verified".
 */
function classifyStatFailure(err: unknown): EntryProbeState {
	return errCode(err) === "ENOENT" ? "absent" : "unknown";
}

function probeEntryState(path: string): EntryProbeState {
	try {
		lstatSync(path);
		return "present";
	} catch (err) {
		return classifyStatFailure(err);
	}
}

function isRegularNonSymlink(path: string): boolean {
	try {
		const st = lstatSync(path);
		return st.isFile() && !st.isSymbolicLink();
	} catch {
		return false;
	}
}

/** True when both paths are the same inode (i.e. a completed hardlink, not a copy). */
function sameInode(a: string, b: string): boolean {
	try {
		const sa = lstatSync(a);
		const sb = lstatSync(b);
		return sa.ino !== 0 && sa.dev === sb.dev && sa.ino === sb.ino;
	} catch {
		return false;
	}
}

/**
 * Read pi-web's session UI state to learn which sessions the user pinned.
 *
 * FAIL-CLOSED contract: pinned sessions are user-owned evidence, so an unreadable/unparsable state
 * file (or one whose structure cannot prove "what is pinned") must yield `ok:false` — the caller
 * then archives nothing. A MISSING file is a known-empty state (no pins were ever recorded) and is
 * therefore `ok:true`. Per-entry uncertainty is resolved conservatively: the session is reported as
 * BOTH pinned and uncertain, i.e. preserved.
 */
export function loadPinnedSessionIds(agentDir: string): PinnedSessionIds {
	const uiStatePath = join(agentDir, PIN_STATE_FILE);
	// Distinguish "no pin state was ever written" from "a pin state exists but cannot be read".
	// A dangling/looping symlink at this path has a real directory entry, so an ENOENT raised by
	// readFileSync must NOT be reported as a known-empty pin set (that would un-pin every session).
	try {
		lstatSync(uiStatePath);
	} catch (err) {
		if (errCode(err) === "ENOENT") return { ok: true, pinned: new Set(), uncertain: [] };
		return { ok: false, reason: `pin state not stat-able (${errCode(err) ?? "unknown"}): ${errMessage(err)}` };
	}
	let raw: string;
	try {
		raw = readFileSync(uiStatePath, "utf8");
	} catch (err) {
		// The path exists (lstat succeeded) yet is unreadable: dangling symlink, directory,
		// permissions, or a delete race. Pin ownership is UNKNOWN ⇒ fail closed.
		return { ok: false, reason: `pin state unreadable (${errCode(err) ?? "unknown"}): ${errMessage(err)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		return { ok: false, reason: `pin state malformed JSON: ${errMessage(err)}` };
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { ok: false, reason: "pin state root is not an object" };
	}
	const sessionsRaw = (parsed as { sessions?: unknown }).sessions;
	if (sessionsRaw === undefined || sessionsRaw === null) {
		return { ok: false, reason: "pin state has no `sessions` object: pin ownership unknown" };
	}
	if (typeof sessionsRaw !== "object" || Array.isArray(sessionsRaw)) {
		return { ok: false, reason: "pin state `sessions` is not an object: pin ownership unknown" };
	}
	const pinned = new Set<string>();
	const uncertain: string[] = [];
	for (const [sid, meta] of Object.entries(sessionsRaw as Record<string, unknown>)) {
		if (!sid) continue;
		if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
			// Cannot read this entry's metadata at all ⇒ assume the user owns it.
			pinned.add(sid);
			uncertain.push(sid);
			continue;
		}
		const rec = meta as { pinnedAt?: unknown };
		if (!("pinnedAt" in rec)) continue;
		if (typeof rec.pinnedAt === "number" && Number.isFinite(rec.pinnedAt)) {
			pinned.add(sid);
			continue;
		}
		pinned.add(sid);
		uncertain.push(sid);
	}
	return { ok: true, pinned, uncertain };
}

function isVerifiedChildOfParent(filePath: string, expectedParentId: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const buf = Buffer.allocUnsafe(HEAD_SCAN_BYTES);
		const bytesRead = readSync(fd, buf, 0, buf.length, 0);
		if (bytesRead <= 0) return false;
		const head = buf.subarray(0, bytesRead).toString("utf8");
		if (!head.includes(SUBAGENT_META_TYPE) || !head.includes(expectedParentId)) return false;
		for (const line of head.split("\n")) {
			if (!line.includes(SUBAGENT_META_TYPE)) continue;
			try {
				const entry = JSON.parse(line) as {
					type?: string;
					customType?: string;
					data?: { version?: unknown; parentSessionId?: unknown };
				};
				if (
					entry?.type === "custom"
					&& entry.customType === SUBAGENT_META_TYPE
					&& entry.data?.version === 1
					&& entry.data?.parentSessionId === expectedParentId
				) {
					return true;
				}
			} catch {
				// Partial trailing line in the head window; ignore
			}
		}
		return false;
	} catch {
		return false;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// ignore
			}
		}
	}
}

/**
 * Error shape of a failed move. `destCreated:true` means the destination path still holds a file THAT
 * failed move created (the link/copy succeeded and the source could not be unlinked, or the
 * destination cleanup failed too). It is never set for a no-clobber refusal (EEXIST): a path this
 * move refused to write is not ours and must never be removed or reported as archived evidence.
 * `destIdentity` records the identity of that fragment at failure time so a later cleanup retry can
 * verify that the CURRENT directory entry is still the same fragment before unlinking it.
 */
export interface MoveFailure extends NodeJS.ErrnoException {
	destCreated?: boolean;
	/** Identity captured at failure time; `null` when it could not be captured (cleanup must refuse). */
	destIdentity?: DestFragmentIdentity | null;
}

/**
 * Identity of the destination entry a failed move created. Compared field-by-field before a cleanup
 * retry unlinks the path: `destCreated` alone is historical and cannot prove that the current
 * directory entry is still the move's fragment rather than a foreign replacement.
 */
export interface DestFragmentIdentity {
	/** Which move primitive left the fragment: a hardlink (same inode as the source) or a copy. */
	kind: "link" | "copy";
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
}

/** Capture the current identity of a failed move's destination, or `null` when it cannot be read. */
function captureFragmentIdentity(path: string, kind: "link" | "copy"): DestFragmentIdentity | null {
	try {
		const st = lstatSync(path);
		if (!st.isFile() || st.isSymbolicLink()) return null;
		return { kind, dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs };
	} catch {
		return null;
	}
}

/** True when the CURRENT entry at `path` is still exactly the fragment recorded at failure time. */
function fragmentIdentityMatches(path: string, recorded: DestFragmentIdentity | null | undefined): boolean {
	if (!recorded) return false;
	try {
		const st = lstatSync(path);
		return st.isFile()
			&& !st.isSymbolicLink()
			&& st.dev === recorded.dev
			&& st.ino === recorded.ino
			&& st.size === recorded.size
			&& st.mtimeMs === recorded.mtimeMs;
	} catch {
		return false;
	}
}

/**
 * Remove a destination that THIS run created and then failed to hand over.
 * FAIL CLOSED on state: the unlink is only attempted while the destination's state is verifiably
 * PRESENT; an UNKNOWN state is never unlinked and is reported through `MoveFailure.destCreated`, so
 * the residue stays tracked. Returns true when the path still exists afterwards — or when its state
 * cannot be verified, because an unverifiable destination must be tracked, never written off.
 */
function discardCreatedDestination(dst: string): boolean {
	const state = probeEntryState(dst);
	if (state === "unknown") return true;
	if (state === "present") {
		try {
			unlinkSync(dst);
		} catch {
			// Reported through `MoveFailure.destCreated`: nothing is lost, the source was never removed.
		}
	}
	return probeEntryState(dst) !== "absent";
}

function failedMove(err: unknown, destCreated: boolean, destPath?: string, destKind?: "link" | "copy"): MoveFailure {
	const out = (err instanceof Error ? err : new Error(String(err))) as MoveFailure;
	if (destCreated) {
		out.destCreated = true;
		out.destIdentity = destPath === undefined || destKind === undefined ? null : captureFragmentIdentity(destPath, destKind);
	}
	return out;
}

/**
 * No-clobber move. `link(2)` first (atomic, fails EEXIST instead of overwriting, keeps the inode),
 * then `unlink(src)`. Filesystems without hardlinks / cross-device moves fall back to
 * `copyFileSync(..., COPYFILE_EXCL)` + size verification + `unlink(src)`; a failed copy removes its
 * partial destination so a retry cannot mistake it for a completed archive entry.
 *
 * A move that throws NEVER unlinks its source, so every failure leaves the source intact. When the
 * destination cannot be discarded after such a failure, the thrown error carries
 * `destCreated:true` so the caller can track (and report) the residue instead of assuming that
 * nothing reached the archive.
 */
export function moveFileNoClobber(src: string, dst: string, forceCopy: boolean): void {
	if (!forceCopy) {
		let linked = false;
		try {
			linkSync(src, dst);
			linked = true;
		} catch (err) {
			const code = errCode(err);
			if (!code || !LINK_FALLBACK_CODES.has(code)) throw err;
		}
		if (linked) {
			try {
				unlinkSync(src);
				return;
			} catch (unlinkErr) {
				throw failedMove(unlinkErr, discardCreatedDestination(dst), dst, "link");
			}
		}
	}
	copyFileSync(src, dst, fsConstants.COPYFILE_EXCL);
	try {
		const srcSt = lstatSync(src);
		const dstSt = lstatSync(dst);
		if (!dstSt.isFile() || dstSt.size !== srcSt.size) {
			throw new Error(`copy verification failed: ${srcSt.size} -> ${dstSt.size} bytes`);
		}
	} catch (verifyErr) {
		throw failedMove(verifyErr, discardCreatedDestination(dst), dst, "copy");
	}
	try {
		unlinkSync(src);
	} catch (unlinkErr) {
		// Copy is complete but the source is still in sessions/: discard the destination so a later
		// pass cannot archive the same jsonl twice, and report the residue when that also fails.
		throw failedMove(unlinkErr, discardCreatedDestination(dst), dst, "copy");
	}
}

interface IndexedSessionFile {
	sessionId: string;
	subdir: string;
	filePath: string;
	size: number;
	mtimeMs: number;
}

interface SessionIndex {
	verified: IndexedSessionFile[];
	/** EVERY `.jsonl` under sessions/ (verified child or not), keyed by parsed session id. */
	bySessionId: Map<string, IndexedSessionFile[]>;
	truncated: boolean;
	scannedFiles: number;
	/** All directory entries encountered while enumerating (including filtered-out ones). */
	scannedEntries: number;
	unreadableDirs: number;
}

interface EnumerationBudget {
	entries: number;
	maxEntries: number;
	truncated: boolean;
}

/**
 * Enumerate one directory WITHOUT materializing it: `opendirSync` + `readSync` streams entries and
 * stops the moment the global entry budget is exhausted, so one pathological directory cannot blow
 * up memory or wall time. Returns `null` when the directory cannot be opened at all.
 */
function listDirectoryBounded(dirPath: string, budget: EnumerationBudget): string[] | null {
	let dir: ReturnType<typeof opendirSync>;
	try {
		dir = opendirSync(dirPath);
	} catch {
		return null;
	}
	const names: string[] = [];
	try {
		for (;;) {
			if (budget.entries >= budget.maxEntries) {
				budget.truncated = true;
				break;
			}
			const ent = dir.readSync();
			if (!ent) break;
			budget.entries++;
			names.push(ent.name);
		}
	} catch {
		// Partial listing on a read error: still bounded, still safe (it only hides candidates).
		return names.sort();
	} finally {
		try {
			dir.closeSync();
		} catch {
			// ignore
		}
	}
	return names.sort();
}

/**
 * Single bounded pass over `<sessionsRoot>/<workspace>/<ts>_<sid>.jsonl`.
 *
 * Enumeration itself is budgeted (per-entry, across the whole scan) and one pass builds the index
 * used by BOTH the candidate list and the "ledger id with no verified file" accounting, so that
 * accounting never rescans the tree per id (it used to be O(#ledgerSessionIds × #files)).
 */
function indexSessionTree(
	sessionsRoot: string,
	parentSessionId: string,
	limits: { maxEntries: number; maxSubdirs: number },
): SessionIndex {
	const index: SessionIndex = {
		verified: [],
		bySessionId: new Map(),
		truncated: false,
		scannedFiles: 0,
		scannedEntries: 0,
		unreadableDirs: 0,
	};
	const budget: EnumerationBudget = { entries: 0, maxEntries: limits.maxEntries, truncated: false };
	const subdirs = listDirectoryBounded(sessionsRoot, budget);
	if (!subdirs) {
		index.scannedEntries = budget.entries;
		return index;
	}
	let visitedSubdirs = 0;
	for (const subdir of subdirs) {
		if (budget.truncated) break;
		if (visitedSubdirs >= limits.maxSubdirs) {
			index.truncated = true;
			break;
		}
		const dirPath = join(sessionsRoot, subdir);
		try {
			const dirSt = lstatSync(dirPath);
			if (!dirSt.isDirectory() || dirSt.isSymbolicLink()) continue;
		} catch {
			continue;
		}
		visitedSubdirs++;
		const files = listDirectoryBounded(dirPath, budget);
		if (!files) {
			index.unreadableDirs++;
			continue;
		}
		for (const fn of files) {
			if (!fn.endsWith(".jsonl")) continue;
			const underscore = fn.lastIndexOf("_");
			if (underscore < 0) continue;
			const sid = fn.slice(underscore + 1, -".jsonl".length);
			if (!sid || sid === parentSessionId || !isSafeId(sid)) continue;
			const filePath = join(dirPath, fn);
			let st;
			try {
				st = lstatSync(filePath);
			} catch {
				continue;
			}
			if (!st.isFile() || st.isSymbolicLink()) continue;
			index.scannedFiles++;
			const info: IndexedSessionFile = {
				sessionId: sid,
				subdir,
				filePath,
				size: st.size,
				mtimeMs: st.mtimeMs,
			};
			const known = index.bySessionId.get(sid);
			if (known) known.push(info);
			else index.bySessionId.set(sid, [info]);
			if (isVerifiedChildOfParent(filePath, parentSessionId)) index.verified.push(info);
		}
	}
	index.truncated = index.truncated || budget.truncated;
	index.scannedEntries = budget.entries;
	return index;
}

interface ArchiveSlot {
	destFile: string;
	acpDest: string;
	/** `<ts>_<sid>` shared by every collision slot of this source file. */
	stem: string;
	/** The sidecar is already in the archive from an interrupted earlier pair move. */
	sidecarStaged: boolean;
	/**
	 * `<destFile>` already IS this jsonl inode: an earlier run hardlinked it but was interrupted
	 * before `unlink(src)`. Completing means dropping the source link, not copying again.
	 */
	alreadyLinked: boolean;
	slot: number;
}

/**
 * Allocate a collision-free archive slot for `sourceFileName` (`<ts>_<sid>.jsonl`).
 *
 * Never returns an occupied `destFile` that holds different data: an existing archived jsonl is
 * always preserved and the candidate moves to `<stem>~N.jsonl`.
 *
 * The only self-healing case accepted is PROVEN provenance — `<destFile>` is the SAME INODE as the
 * source, i.e. an earlier run of ours hardlinked it and died before `unlink(src)`. In that case the
 * slot is provably ours, so a sidecar sitting there was written by that same interrupted run and
 * may be adopted when the source no longer has one.
 *
 * An orphan `<destFile>.acp.json` (sidecar without its jsonl) at a slot whose jsonl is NOT ours is
 * NOT adopted: a filename match alone does not prove the sidecar belongs to this session (two
 * archives can derive the same `<ts>_<sid>` name). Such a remnant is preserved untouched and the
 * candidate moves on; the situation is reported through `notes`.
 */
function allocateArchiveSlot(
	destDir: string,
	sourcePath: string,
	sourceFileName: string,
	hasAcp: boolean,
	notes: string[],
	probe: EntryProbe,
): ArchiveSlot | null {
	const stem = sourceFileName.endsWith(".jsonl")
		? sourceFileName.slice(0, -".jsonl".length)
		: sourceFileName;
	for (let slot = 0; slot < MAX_COLLISION_SLOTS; slot++) {
		const destFile = join(destDir, slot === 0 ? `${stem}.jsonl` : `${stem}~${slot + 1}.jsonl`);
		const acpDest = `${destFile}.acp.json`;
		const destState = probe(destFile);
		const acpState = probe(acpDest);
		if (destState === "unknown" || acpState === "unknown") {
			// Occupancy cannot be verified ⇒ never move into this slot (fail closed, candidate retained).
			notes.push(`${destFile}: slot occupancy could not be verified (non-ENOENT stat error); slot skipped`);
			continue;
		}
		if (destState === "present") {
			const provablyOurs = sameInode(sourcePath, destFile) && isRegularNonSymlink(destFile);
			if (!provablyOurs) continue; // occupied by unrelated data: never touch it
			if (acpState === "absent") return { destFile, acpDest, stem, sidecarStaged: false, alreadyLinked: true, slot };
			if (!hasAcp && isRegularNonSymlink(acpDest)) {
				return { destFile, acpDest, stem, sidecarStaged: true, alreadyLinked: true, slot };
			}
			notes.push(
				`${acpDest}: sidecar already present in this session's own (same-inode) slot; preserved, candidate moved to a later slot`,
			);
			continue;
		}
		if (acpState === "absent") return { destFile, acpDest, stem, sidecarStaged: false, alreadyLinked: false, slot };
		notes.push(
			`${acpDest}: orphan sidecar without its jsonl (provenance unknown, not this session's slot); preserved untouched, candidate moved to a later slot`,
		);
	}
	return null;
}

/**
 * Same-stem remnants already in the archive for this source's `<ts>_<sid>` stem (`<stem>.jsonl` and its
 * collision siblings `<stem>~N.jsonl` plus their `.acp.json` sidecars).
 *
 * A same-stem sidecar is the only on-disk trace an interrupted pair leaves behind (the sidecar is
 * moved first, and its rollback can fail). Filename equality cannot prove whether such a remnant is
 * this session's staged sidecar or an unrelated archive that derived the same name, so a sidecar the
 * run does not own is AMBIGUOUS: the pair may be split, and the jsonl must not be moved away from it.
 * A same-stem jsonl that is not the source inode is likewise unproven — it is evidence that part of
 * this pair may already be in the archive, and is reported even when it does not block completion.
 * The scan is bounded by `MAX_COLLISION_SLOTS`, the same bound the allocator uses.
 */
interface StemRemnants {
	/** Same-stem sidecars (provenance not established). */
	sidecars: string[];
	/** Same-stem jsonl entries that are NOT the source inode (a copy or an unrelated entry). */
	unprovenJsonl: string[];
	/** Every remnant above, in slot order (sidecar before jsonl inside a slot). */
	all: string[];
	/** Probe candidates whose state is UNKNOWN (non-ENOENT stat error): never claimed, never moved over. */
	unknown: string[];
}

function findSameStemArchiveRemnants(destDir: string, stem: string, sourcePath: string, probe: EntryProbe): StemRemnants {
	const out: StemRemnants = { sidecars: [], unprovenJsonl: [], all: [], unknown: [] };
	for (let slot = 0; slot < MAX_COLLISION_SLOTS; slot++) {
		const destFile = join(destDir, slot === 0 ? `${stem}.jsonl` : `${stem}~${slot + 1}.jsonl`);
		const acpDest = `${destFile}.acp.json`;
		const acpState = probe(acpDest);
		if (acpState === "unknown") out.unknown.push(acpDest);
		else if (acpState === "present") {
			out.sidecars.push(acpDest);
			out.all.push(acpDest);
		}
		const destState = probe(destFile);
		if (destState === "unknown") out.unknown.push(destFile);
		else if (destState === "present" && !sameInode(sourcePath, destFile)) {
			out.unprovenJsonl.push(destFile);
			out.all.push(destFile);
		}
	}
	return out;
}

function isTaskTerminalForGc(task: WorkTask): boolean {
	return terminalWork(task.status) || task.status === "failed";
}

function isReviewerTask(task: WorkTask): boolean {
	return task.id.startsWith("W-rev-") || !!task.parentTaskId;
}

export function archiveStaleChildSessions(opts: ChildGcOptions): ChildGcResult {
	const result: ChildGcResult = {
		totalMatched: 0,
		archived: [],
		partials: [],
		skippedActive: 0,
		skippedCooldown: 0,
		skippedPinned: 0,
		skippedUnverified: 0,
		skippedMoveError: 0,
		skippedAmbiguousPair: 0,
		totalBytesFreed: 0,
		errors: [],
		warnings: [],
		pinsUnknown: false,
		discoveryTruncated: false,
		scannedFiles: 0,
		scannedEntries: 0,
	};

	const { agentDir, parentSessionId, tasks, activeLeaseSessionIds, historicalLeases, dryRun = false } = opts;
	if (!agentDir || !parentSessionId || !isSafeId(parentSessionId)) {
		return result;
	}

	const nowMs = opts.nowMs ?? Date.now();
	const reviewerCooldownMs = Math.max(MIN_SAFE_GC_COOLDOWN_MS, opts.reviewerCooldownMs ?? DEFAULT_REVIEWER_GC_COOLDOWN_MS);
	const workerCooldownMs = Math.max(MIN_SAFE_GC_COOLDOWN_MS, opts.workerCooldownMs ?? DEFAULT_WORKER_GC_COOLDOWN_MS);
	const fault = opts.__moveFault;
	const statFault = opts.__statFault;
	/** Fail-closed probe bound to this run's TEST-ONLY stat seam: `"fail"` ⇒ a simulated non-ENOENT stat error. */
	const probe = (path: string, phase: StatProbePhase): EntryProbeState => {
		if (statFault?.(path, phase) === "fail") return classifyStatFailure({ code: "EIO" });
		return probeEntryState(path);
	};

	const attemptMove = (op: GcMoveOp): void => {
		const decision = fault?.(op);
		if (decision === "fail") {
			const err = new Error(`injected move failure (${op.kind}/${op.phase})`) as MoveFailure;
			err.code = "EIO";
			throw err;
		}
		if (decision === "copy-then-fail") {
			// TEST-ONLY: reproduce the exact residue of a real move whose copy completed and whose
			// source unlink then failed — destination fully written, source untouched.
			copyFileSync(op.src, op.dst, fsConstants.COPYFILE_EXCL);
			const err = new Error(`injected post-copy source-unlink failure (${op.kind}/${op.phase})`) as MoveFailure;
			err.code = "EIO";
			err.destCreated = true;
			err.destIdentity = captureFragmentIdentity(op.dst, "copy");
			throw err;
		}
		if (decision === "link-then-fail") {
			// TEST-ONLY: reproduce the exact residue of a real hardlink move whose source unlink AND
			// its own destination cleanup both failed — destination is a same-inode link, source
			// untouched.
			linkSync(op.src, op.dst);
			const err = new Error(`injected post-link source-unlink failure (${op.kind}/${op.phase})`) as MoveFailure;
			err.code = "EIO";
			err.destCreated = true;
			err.destIdentity = captureFragmentIdentity(op.dst, "link");
			throw err;
		}
		moveFileNoClobber(op.src, op.dst, decision === "copy");
	};

	/** One candidate path for a failure receipt with the provenance claim recorded for it. */
	type ReceiptClaim = "own" | "unproven" | "unknown";

	/** Verdict of the fail-closed cleanup retry for a destination that a failed move created. */
	type FragmentCleanupOutcome =
		| { removed: true }
		| { removed: false; claim: ReceiptClaim };

	/**
	 * Classify failure-receipt candidates by CURRENT filesystem state (fail closed): only a path
	 * that is verifiably PRESENT AND whose provenance is `own` is claimed in `verified`; everything
	 * else that is not proven ABSENT (UNKNOWN state, unproven provenance) is named in `unverified`,
	 * so an unresolved path is never dropped from the structured accounting.
	 */
	const classifyReceiptPaths = (
		paths: string[],
		claims: Map<string, ReceiptClaim> | null,
	): { verified: string[]; unverified: string[] } => {
		const verified: string[] = [];
		const unverified: string[] = [];
		for (const p of [...new Set(paths)]) {
			const state = probe(p, "receipt");
			if (state === "absent") continue;
			const claim = claims?.get(p) ?? "own";
			if (state === "present" && claim === "own") verified.push(p);
			else unverified.push(p);
		}
		return { verified, unverified };
	};

	/**
	 * Cleanup retry for an archive destination that a FAILED move (`kind`) created and could not
	 * clean up itself. Only safe because a thrown move never unlinks its source, so the original
	 * file is still in place.
	 *
	 * FAIL CLOSED on state and ownership — the unlink only runs when the CURRENT entry is verifiably
	 * PRESENT and provably still the fragment the failed move created: a same-inode link to the
	 * retained source (hardlink residue), or a copy whose identity still matches the one captured
	 * when the move failed while the retained source is verifiably present (copy residue). An
	 * UNKNOWN state, a missing identity or a non-matching entry (a foreign replacement) is preserved
	 * and reported; `removed:false` makes the caller name the path in the receipt, so nothing goes
	 * unaccounted. The fault seam lets a fixture force this discard to fail or replace the entry
	 * right before the cleanup checks run.
	 */
	const discardFailedDestination = (
		dst: string,
		sourceRetained: string,
		kind: "jsonl" | "acp",
		recorded: DestFragmentIdentity | null | undefined,
	): FragmentCleanupOutcome => {
		const decision = fault?.({ kind, src: dst, dst: sourceRetained, phase: "discard-failed-dest" });
		// The seam callback above may have replaced the entry; every check below sees the CURRENT state.
		const state = probeEntryState(dst);
		if (state === "absent") return { removed: true };
		if (state === "unknown") return { removed: false, claim: "unknown" };
		const ownsFragment = sameInode(sourceRetained, dst)
			|| (probeEntryState(sourceRetained) === "present"
				&& recorded?.kind === "copy"
				&& fragmentIdentityMatches(dst, recorded));
		if (!ownsFragment) return { removed: false, claim: "unproven" };
		if (decision === "fail") return { removed: false, claim: "own" };
		try {
			unlinkSync(dst);
		} catch {
			// Re-checked below: the receipt must name what actually remains.
		}
		return probeEntryState(dst) === "absent" ? { removed: true } : { removed: false, claim: "own" };
	};

	// Group current ledger tasks by child sessionId
	const bySession = new Map<string, WorkTask[]>();
	for (const task of Array.isArray(tasks) ? tasks : []) {
		if (!task.sessionId || !isSafeId(task.sessionId) || task.sessionId === parentSessionId) continue;
		let list = bySession.get(task.sessionId);
		if (!list) {
			list = [];
			bySession.set(task.sessionId, list);
		}
		list.push(task);
	}

	// Optional historical lease lookup to identify unreferenced reviewer children (W-rev-*)
	const histBySession = new Map<string, WorkTask[]>();
	if (historicalLeases) {
		for (const lease of historicalLeases) {
			if (!lease.sessionId || !isSafeId(lease.sessionId)) continue;
			let list = histBySession.get(lease.sessionId);
			if (!list) {
				list = [];
				histBySession.set(lease.sessionId, list);
			}
			list.push(lease);
		}
	}

	const sessionsRoot = join(agentDir, "sessions");
	const archiveRoot = join(agentDir, "sessions-archive");
	const discoveryLimits = {
		maxEntries: Math.max(1, opts.__discoveryLimits?.maxEntries ?? MAX_DISCOVERY_ENTRIES),
		maxSubdirs: Math.max(1, opts.__discoveryLimits?.maxSubdirs ?? MAX_DISCOVERY_SUBDIRS),
	};
	const index = indexSessionTree(sessionsRoot, parentSessionId, discoveryLimits);
	result.scannedFiles = index.scannedFiles;
	result.scannedEntries = index.scannedEntries;
	result.discoveryTruncated = index.truncated;
	if (index.truncated) {
		result.warnings.push(
			`discovery truncated at ${index.scannedEntries} directory entries (budget ${discoveryLimits.maxEntries}) / ${discoveryLimits.maxSubdirs} workspaces: results are a bounded subset`,
		);
	}
	if (index.unreadableDirs > 0) {
		result.warnings.push(`${index.unreadableDirs} workspace directory/ies could not be listed during discovery`);
	}
	const discovered = index.verified;
	const discoveredIds = new Set(discovered.map(d => d.sessionId));
	result.totalMatched = discovered.length;

	// Ledger-referenced sessionIds with a file on disk that did NOT verify as this parent's child
	// (foreign parent, root session, unreadable head). Indexed lookup — no per-id tree rescan.
	for (const sid of bySession.keys()) {
		if (discoveredIds.has(sid)) continue;
		if (index.bySessionId.has(sid)) result.skippedUnverified++;
	}

	// FAIL CLOSED: unknown pin ownership means we cannot prove any candidate is unpinned.
	const pinState = loadPinnedSessionIds(agentDir);
	if (!pinState.ok) {
		result.pinsUnknown = true;
		result.errors.push(`pin state unknown (${pinState.reason}); archived nothing (fail-closed)`);
		return result;
	}
	const pinnedIds = pinState.pinned;
	if (pinState.uncertain.length > 0) {
		result.warnings.push(
			`${pinState.uncertain.length} pin-state entry/entries had unreadable metadata and were treated as PINNED (preserved)`,
		);
	}

	if (discovered.length === 0) return result;

	for (const child of discovered) {
		const sid = child.sessionId;

		if (pinnedIds.has(sid)) {
			result.skippedPinned++;
			continue;
		}

		const sidTasks = bySession.get(sid) ?? [];
		if (activeLeaseSessionIds.has(sid) || sidTasks.some(t => !isTaskTerminalForGc(t))) {
			result.skippedActive++;
			continue;
		}

		let kind: "reviewer" | "worker" | "orphaned";
		let cooldownMs: number;
		let taskIds: string[];

		if (sidTasks.length > 0) {
			kind = sidTasks.every(isReviewerTask) ? "reviewer" : "worker";
			cooldownMs = kind === "reviewer" ? reviewerCooldownMs : workerCooldownMs;
			taskIds = sidTasks.map(t => t.id);

			let latestTaskTs = 0;
			for (const t of sidTasks) {
				for (const raw of [t.archivedAt, t.dispatchedAt]) {
					if (!raw) continue;
					const ms = Date.parse(raw);
					if (Number.isFinite(ms) && ms > latestTaskTs) latestTaskTs = ms;
				}
			}
			if (latestTaskTs > 0 && (nowMs - latestTaskTs) < cooldownMs) {
				result.skippedCooldown++;
				continue;
			}
		} else {
			const hist = histBySession.get(sid) ?? [];
			const isHistReviewer = hist.length > 0 && hist.every(isReviewerTask);
			kind = isHistReviewer ? "reviewer" : "orphaned";
			cooldownMs = isHistReviewer ? reviewerCooldownMs : workerCooldownMs;
			taskIds = hist.map(h => h.id);
		}

		if ((nowMs - child.mtimeMs) < cooldownMs) {
			result.skippedCooldown++;
			continue;
		}

		// Sidecar (`.acp.json`) must be a regular non-symlink file: anything else is anomalous
		// evidence we refuse to move, and archiving only the jsonl would split the pair. If its very
		// existence cannot be verified (non-ENOENT stat error), the candidate is preserved in place:
		// moving the jsonl while a possible sidecar's state is unknown could split the pair.
		const acpSrc = `${child.filePath}.acp.json`;
		const acpDetectionState = probe(acpSrc, "sidecar-detection");
		if (acpDetectionState === "unknown") {
			result.errors.push(
				`${sid}.acp.json: filesystem state could not be verified before the move (non-ENOENT stat error); session preserved, nothing moved`,
			);
			result.skippedMoveError++;
			continue;
		}
		let sidecarBytes = 0;
		let hasAcp = false;
		if (acpDetectionState === "present") {
			if (!isRegularNonSymlink(acpSrc)) {
				result.warnings.push(`${sid}.acp.json is not a regular file; session preserved (evidence not split)`);
				result.skippedMoveError++;
				continue;
			}
			try {
				sidecarBytes = lstatSync(acpSrc).size;
			} catch {
				result.warnings.push(`${sid}.acp.json vanished during allocation; session preserved`);
				result.skippedMoveError++;
				continue;
			}
			hasAcp = true;
		}

		const destDir = join(archiveRoot, child.subdir);
		const slotNotes: string[] = [];
		const slot = allocateArchiveSlot(destDir, child.filePath, basename(child.filePath), hasAcp, slotNotes, (p) => probe(p, "allocation"));
		for (const note of slotNotes) result.warnings.push(`${sid}: ${note}`);
		if (!slot) {
			result.errors.push(
				`${sid}: no free archive slot after ${MAX_COLLISION_SLOTS} candidates in ${destDir}; original retained`,
			);
			result.skippedMoveError++;
			continue;
		}
		const totalBytes = child.size + sidecarBytes;

		// PRE-FLIGHT AMBIGUITY GATE (runs before anything moves). The sidecar is moved first, so a
		// same-stem `.acp.json` already sitting in the archive may BE this session's sidecar, left
		// there by an interrupted pair whose rollback failed. A session can only prove ownership of a
		// sidecar it still holds (`hasAcp`) or of one staged in its own same-inode slot
		// (`sidecarStaged`). Without that proof the pair stays in place untouched and is reported —
		// moving the jsonl now would separate it from its only sidecar for good.
		if (!hasAcp && !slot.sidecarStaged) {
			const remnants = findSameStemArchiveRemnants(destDir, slot.stem, child.filePath, (p) => probe(p, "stem-remnants"));
			if (remnants.sidecars.length > 0 || remnants.unknown.length > 0) {
				result.skippedAmbiguousPair++;
				const detail = remnants.sidecars.length > 0
					? `ambiguous interrupted pair: same-stem sidecar(s) with unprovable provenance in the archive (${remnants.sidecars.join(", ")}); pair retained intact at ${child.filePath}, nothing moved`
					: `ambiguous interrupted pair: same-stem archive state could not be verified (${remnants.unknown.join(", ")}); pair retained intact at ${child.filePath}, nothing moved`;
				result.errors.push(`${sid}: ${detail}`);
				result.partials.push({
					sessionId: sid,
					filesInArchive: remnants.all,
					filesRetainedInPlace: [child.filePath],
					rollback: "none-needed",
					reason: "ambiguous-interrupted-pair",
					detail,
				});
				continue;
			}
		}

		if (dryRun) {
			result.archived.push({
				sessionId: sid,
				taskIds,
				kind,
				sourceFile: child.filePath,
				archiveFile: slot.destFile,
				bytes: totalBytes,
				acpArchiveFile: hasAcp ? slot.acpDest : (slot.sidecarStaged ? slot.acpDest : null),
				sidecarStaged: slot.sidecarStaged,
			});
			result.totalBytesFreed += totalBytes;
			continue;
		}

		try {
			mkdirSync(destDir, { recursive: true });
		} catch (err) {
			result.errors.push(`${sid}: cannot create archive dir ${destDir}: ${errMessage(err)}; original retained`);
			result.skippedMoveError++;
			continue;
		}

		const filesInArchive: string[] = [];
		let sidecarMovedNow = false;

		// Sidecar FIRST: the riskier step. If it fails, nothing has moved and the pair is intact.
		if (hasAcp && !slot.sidecarStaged) {
			try {
				attemptMove({ kind: "acp", src: acpSrc, dst: slot.acpDest, phase: "archive" });
				sidecarMovedNow = true;
				filesInArchive.push(slot.acpDest);
			} catch (err) {
				// A failed sidecar move can still have CREATED its destination: the no-clobber hardlink
				// path leaves its link when the source unlink AND its own cleanup both fail, and the
				// copy path leaves the copy when the same happens. `destCreated` is set only for a path
				// THIS move created, so an EEXIST refusal is never treated as ours and never removed.
				const moveErr = err as MoveFailure;
				let residue: string | null = null;
				let residueClaim: ReceiptClaim = "own";
				if (moveErr.destCreated === true) {
					const acpDestState = probe(slot.acpDest, "completion");
					if (acpDestState === "unknown") {
						// FAIL CLOSED: the destination's CURRENT state cannot be verified, so the destructive
						// cleanup retry must not run against it; keep it tracked so the receipt always names it.
						residue = slot.acpDest;
						residueClaim = "unknown";
						result.warnings.push(
							`${sid}: archive destination ${slot.acpDest} could not be verified after the failed sidecar move (non-ENOENT stat error); not touched (tracked as unverified in the receipt)`,
						);
					} else if (acpDestState === "present") {
						// Verified cleanup retry: a thrown move never unlinks its source, so discarding the
						// destination it created only removes a duplicate of the retained sidecar — but only
						// when the CURRENT entry is still provably that fragment (never a replacement).
						const cleanup = discardFailedDestination(slot.acpDest, acpSrc, "acp", moveErr.destIdentity);
						if (!cleanup.removed) {
							residue = slot.acpDest;
							residueClaim = cleanup.claim;
							result.warnings.push(
								cleanup.claim === "own"
									? `${sid}: a sidecar fragment created by the failed move could not be removed from the archive: ${slot.acpDest} (source sidecar retained at ${acpSrc})`
									: `${sid}: an archive destination created by the failed sidecar move was not removed from the archive: ${slot.acpDest} (safe removal could not be established; preserved untouched, source sidecar retained at ${acpSrc})`,
							);
						}
					}
					// acpDestState "absent": nothing reached or remained in the archive; no residue.
				} else if (probe(slot.acpDest, "completion") === "present") {
					// Appeared between allocation and the move without destCreated: not ours, never touch.
					result.warnings.push(
						`${sid}: archive destination ${slot.acpDest} appeared during the failed sidecar move (not created by it); preserved untouched`,
					);
				}
				if (residue) {
					// Never write the residue off as "nothing moved": name it in a truthful partial receipt.
					// A path whose state or provenance cannot be verified is named via `filesUnverified`,
					// never dropped from the structured accounting (fail closed).
					const residueEvidence = classifyReceiptPaths([residue], new Map([[residue, residueClaim]]));
					const retainedEvidence = classifyReceiptPaths([child.filePath, acpSrc], null);
					const filesUnverified = [...new Set([...residueEvidence.unverified, ...retainedEvidence.unverified])];
					const residueVerified = residueEvidence.verified.length > 0;
					result.errors.push(
						residueVerified
							? `${sid}.acp.json: ${errMessage(err)}; sidecar retained at ${acpSrc}; fragment remains in the archive at ${residue}; completion refused`
							: `${sid}.acp.json: ${errMessage(err)}; sidecar retained at ${acpSrc}; an unresolved archive entry remains at ${residue} (state or provenance could not be verified); completion refused`,
					);
					result.partials.push({
						sessionId: sid,
						filesInArchive: residueEvidence.verified,
						filesRetainedInPlace: retainedEvidence.verified,
						filesUnverified: filesUnverified.length > 0 ? filesUnverified : undefined,
						rollback: "none-needed",
						reason: "move-failed",
						detail: residueVerified
							? `sidecar move failed and left a fragment in the archive at ${residue}; pair retained under sessions/ (jsonl at ${child.filePath}, sidecar at ${acpSrc})`
							: `sidecar move failed; the archive entry at ${residue} could not be verified as this move's fragment; pair retained under sessions/`,
					});
				} else {
					result.errors.push(
						`${sid}.acp.json: ${errMessage(err)}; pair intact (jsonl retained at ${child.filePath})`,
					);
					result.skippedMoveError++;
				}
				continue;
			}
		} else if (slot.sidecarStaged) {
			filesInArchive.push(slot.acpDest);
		}

		try {
			if (slot.alreadyLinked) {
				// The archive entry already holds this inode (interrupted link-then-unlink):
				// completing the move is just dropping the source link.
				filesInArchive.push(slot.destFile);
				unlinkSync(child.filePath);
			} else {
				attemptMove({ kind: "jsonl", src: child.filePath, dst: slot.destFile, phase: "archive" });
				filesInArchive.push(slot.destFile);
			}
		} catch (err) {
			// A FAILED move can still have created its destination: the copy path writes the whole file
			// and only then fails to unlink the source, and the no-clobber link path leaves its link when
			// the same unlink fails. `destCreated` is set only for a path THIS move created, so an EEXIST
			// refusal (a pre-existing archive entry) is never treated as ours and never removed.
			const moveErr = err as MoveFailure;
			let retainedDest: string | null = null;
			let retainedDestClaim: ReceiptClaim = "own";
			const destState = probe(slot.destFile, "completion");
			if (moveErr.destCreated === true && destState === "unknown") {
				// FAIL CLOSED: the destination's CURRENT state cannot be verified, so the destructive
				// cleanup retry must not run against it; keep it tracked so the receipt always names it.
				retainedDest = slot.destFile;
				retainedDestClaim = "unknown";
				result.warnings.push(
					`${sid}: archive destination ${slot.destFile} could not be verified after the failed move (non-ENOENT stat error); not touched (tracked as unverified in the receipt)`,
				);
			} else if (moveErr.destCreated === true && destState === "present") {
				if (sameInode(child.filePath, slot.destFile)) {
					// Same inode as the retained source ⇒ provenance IS proven: keep it, the next pass completes
					// this pair by dropping the duplicate source link.
					retainedDest = slot.destFile;
					result.warnings.push(
						`${sid}: failed move left a same-inode archive link at ${slot.destFile}; retained (provenance proven, the next pass completes it)`,
					);
				} else {
					const cleanup = discardFailedDestination(slot.destFile, child.filePath, "jsonl", moveErr.destIdentity);
					if (!cleanup.removed) {
						retainedDest = slot.destFile;
						retainedDestClaim = cleanup.claim;
						result.warnings.push(
							cleanup.claim === "own"
								? `${sid}: a copy created by the failed move could not be removed from the archive: ${slot.destFile} (source intact at ${child.filePath})`
								: `${sid}: an archive destination created by the failed move was not removed from the archive: ${slot.destFile} (safe removal could not be established; preserved untouched, source intact at ${child.filePath})`,
						);
					}
				}
			} else if (!slot.alreadyLinked && destState === "present") {
				// Appeared between allocation and the move: not created by this move, never touch it.
				result.warnings.push(
					`${sid}: archive destination ${slot.destFile} appeared during the failed move (not created by it); preserved untouched`,
				);
			} else if (!slot.alreadyLinked && destState === "unknown") {
				// The destination's state cannot be verified after the failed move: never touch it.
				result.warnings.push(
					`${sid}: archive destination ${slot.destFile} could not be verified after the failed move (non-ENOENT stat error); not touched`,
				);
			}
			let rollback: "none-needed" | "succeeded" | "failed" = sidecarMovedNow ? "failed" : "none-needed";
			if (sidecarMovedNow) {
				try {
					attemptMove({ kind: "acp", src: slot.acpDest, dst: acpSrc, phase: "rollback" });
					rollback = "succeeded";
					const idx = filesInArchive.indexOf(slot.acpDest);
					if (idx >= 0) filesInArchive.splice(idx, 1);
				} catch (rbErr) {
					result.errors.push(`${sid}: rollback of ${slot.acpDest} failed: ${errMessage(rbErr)}`);
				}
			}
			result.errors.push(`${sid}: jsonl move failed: ${errMessage(err)}`);
			// Receipts are built from the FILESYSTEM, never from intent: every candidate is probed
			// again, and a path whose state or provenance cannot be verified is NEVER dropped — it is
			// named via `filesUnverified`, so the structured recovery accounting always records it and
			// the receipt cannot silently vanish into `skippedMoveError` (fail closed).
			const archiveClaims = new Map<string, ReceiptClaim>();
			for (const p of filesInArchive) if (!archiveClaims.has(p)) archiveClaims.set(p, "own");
			if (retainedDest !== null && !archiveClaims.has(retainedDest)) archiveClaims.set(retainedDest, retainedDestClaim);
			const archiveEvidence = classifyReceiptPaths([...archiveClaims.keys()], archiveClaims);
			const retainedEvidence = classifyReceiptPaths([child.filePath, acpSrc], null);
			const filesUnverified = [...new Set([...archiveEvidence.unverified, ...retainedEvidence.unverified])];
			if (archiveEvidence.verified.length > 0 || filesUnverified.length > 0 || rollback === "failed") {
				// Something of this pair is in the archive, still unresolved, or stranded there:
				// truthful partial receipt (fail closed).
				const verifiedNote = archiveEvidence.verified.length > 0
					? `${archiveEvidence.verified.join(", ")} remains in the archive from an interrupted pair or a failed move`
					: "";
				const unverifiedNote = filesUnverified.length > 0
					? `${filesUnverified.join(", ")} could not be verified (state or provenance unknown) and ${filesUnverified.length === 1 ? "is" : "are"} named so the unresolved path is never lost`
					: "";
				const detail = rollback === "failed"
					? `jsonl retained in place; .acp.json left in the archive because rollback failed${retainedDest ? `; a destination created by the failed move also remains at ${retainedDest}` : ""}${unverifiedNote ? `; ${unverifiedNote}` : ""}`
					: `jsonl retained in place; ${[verifiedNote, unverifiedNote].filter(Boolean).join("; ") || "nothing was left behind in the archive"}`;
				result.partials.push({
					sessionId: sid,
					filesInArchive: archiveEvidence.verified,
					filesRetainedInPlace: retainedEvidence.verified,
					filesUnverified: filesUnverified.length > 0 ? filesUnverified : undefined,
					rollback,
					reason: "move-failed",
					detail,
				});
			} else {
				// Rollback restored the pair (or nothing moved and nothing was left behind).
				result.skippedMoveError++;
			}
			continue;
		}

		// A sidecar may have been (re)created between discovery and the move. Adopt it only when it is
		// a regular non-symlink file and its slot is VERIFIED free (an unknown state never adopts);
		// otherwise the completion gate below reports a partial receipt instead of claiming the pair
		// was archived.
		if (!hasAcp && !slot.sidecarStaged && isRegularNonSymlink(acpSrc) && probe(slot.acpDest, "completion") === "absent") {
			try {
				attemptMove({ kind: "acp", src: acpSrc, dst: slot.acpDest, phase: "adopt-late-sidecar" });
				filesInArchive.push(slot.acpDest);
			} catch (err) {
				result.warnings.push(`${sid}.acp.json: late sidecar adoption failed: ${errMessage(err)}`);
			}
		}

		// COMPLETION GATE — verify BOTH sides before calling anything archived, FAIL CLOSED on
		// UNVERIFIABLE state: only ENOENT proves a path absent, so an `"unknown"` probe anywhere below
		// means the completion cannot be substantiated and the session is reported as a partial
		// receipt instead.
		//  (a) the jsonl is present at its archive path and gone from sessions/;
		//  (b) NOTHING of this session remains under sessions/ — a recreated, anomalous (dir/
		//      symlink) or un-moveable `.acp.json` still sitting next to a live path means the pair
		//      is split, which must be reported as a partial receipt, never as a completed archive;
		//  (c) every sidecar the receipt will CLAIM is really there, and — when this session has no
		//      sidecar of its own — that no other same-stem sidecar is left in the archive, because
		//      such a remnant may be this session's own sidecar from an interrupted pair and archiving
		//      the jsonl away from it would silently lose the association.
		const jsonlSourceState = probe(child.filePath, "completion");
		const acpSourceState = probe(acpSrc, "completion");
		const jsonlDestState = probe(slot.destFile, "completion");
		const leftovers: string[] = [];
		if (jsonlSourceState === "present") leftovers.push(child.filePath);
		if (acpSourceState === "present") leftovers.push(acpSrc);
		const unverifiable: string[] = [];
		if (jsonlSourceState === "unknown") unverifiable.push(child.filePath);
		if (acpSourceState === "unknown") unverifiable.push(acpSrc);
		if (jsonlDestState === "unknown") unverifiable.push(slot.destFile);
		const mainLanded = jsonlDestState === "present" && jsonlSourceState === "absent";
		const claimedAcpArchive = (hasAcp || slot.sidecarStaged || filesInArchive.includes(slot.acpDest))
			? slot.acpDest
			: null;
		const claimedAcpState = claimedAcpArchive === null ? null : probe(claimedAcpArchive, "completion");
		if (claimedAcpArchive !== null && claimedAcpState === "unknown") unverifiable.push(claimedAcpArchive);
		const claimedAcpLanded = claimedAcpState === null || claimedAcpState === "present";
		const remnants = claimedAcpArchive === null
			? findSameStemArchiveRemnants(destDir, slot.stem, child.filePath, (p) => probe(p, "completion-remnants"))
			: { sidecars: [], unprovenJsonl: [], all: [], unknown: [] };
		const strandedSidecars = remnants.sidecars;
		for (const u of remnants.unknown) unverifiable.push(u);
		if (!mainLanded || leftovers.length > 0 || unverifiable.length > 0 || !claimedAcpLanded || strandedSidecars.length > 0) {
			const detail = leftovers.length > 0
				? `session evidence still present under sessions/: ${leftovers.join(", ")} (anomalous or recreated sidecar; pair not whole)`
				: unverifiable.length > 0
					? `required filesystem state could not be verified (${unverifiable.join(", ")}); completion refused (fail-closed)`
					: !mainLanded
						? `jsonl not verified at its archive path ${slot.destFile}; sources retained: ${leftovers.join(", ") || "none"}`
						: !claimedAcpLanded
							? `claimed archive sidecar ${claimedAcpArchive ?? ""} is missing; receipt cannot be substantiated`
							: `ambiguous interrupted pair: same-stem sidecar(s) with unprovable provenance remain in the archive (${strandedSidecars.join(", ")}); jsonl archived at ${slot.destFile} but the association is not proven`;
			result.errors.push(`${sid}: ${detail}`);
			const archivedEvidence = [...new Set([
				...(claimedAcpState === "present" && claimedAcpArchive !== null ? [claimedAcpArchive] : []),
				...(jsonlDestState === "present" ? [slot.destFile] : []),
				...remnants.all,
			])];
			result.partials.push({
				sessionId: sid,
				filesInArchive: archivedEvidence,
				filesRetainedInPlace: leftovers,
				rollback: "none-needed",
				reason: remnants.unknown.length > 0 || strandedSidecars.length > 0 ? "ambiguous-interrupted-pair" : "split-pair",
				detail,
			});
			continue;
		}

		result.archived.push({
			sessionId: sid,
			taskIds,
			kind,
			sourceFile: child.filePath,
			archiveFile: slot.destFile,
			bytes: totalBytes,
			acpArchiveFile: claimedAcpArchive,
			sidecarStaged: slot.sidecarStaged,
		});
		result.totalBytesFreed += totalBytes;
	}

	return result;
}