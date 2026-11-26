/**
 * team-worktree.ts — Safe Git worktree lifecycle auditing & non-destructive reclamation.
 *
 * Design guarantees:
 * - Never runs `git worktree remove --force` or `git branch -D`.
 * - Never touches the primary repository worktree, the current session cwd, locked worktrees,
 *   or any worktree referenced by a live / non-terminal ledger task.
 * - Dirty worktrees (any uncommitted or untracked non-ignored changes) are ALWAYS preserved
 *   and surfaced so nothing uncommitted can ever be lost.
 * - Only removes clean secondary worktrees that are either:
 *   1) already merged (by git ancestry or patch-equivalent cherry) into the target branch, or
 *   2) explicitly superseded/cancelled on the ledger with no remaining live/done task refs
 *      (directory removed cleanly while branch history stays intact unless merged).
 */

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, opendirSync } from "node:fs";
import { join, resolve } from "node:path";
import { terminalWork, type WorkTask } from "./team-ledger.ts";

export const DEFAULT_WORKTREE_GRACE_MS = 30 * 60_000;

export interface GitWorktreeEntry {
	path: string;
	head: string;
	branch?: string;
	detached?: boolean;
	locked?: boolean;
	prunable?: boolean;
	bare?: boolean;
}

export interface WorktreeAuditItem {
	path: string;
	branch?: string;
	head: string;
	status:
		| "reclaimable-merged"
		| "reclaimable-superseded"
		| "retained-dirty"
		| "retained-unmerged"
		| "protected-active"
		| "prunable-missing";
	reason: string;
	bytes: number;
	branchDeleteSafe: boolean;
	taskIds: string[];
	hasTerminalRef: boolean;
}

export interface WorktreeAuditReport {
	repoRoot: string | null;
	targetRef: string;
	reclaimableMerged: WorktreeAuditItem[];
	reclaimableSuperseded: WorktreeAuditItem[];
	retainedDirty: WorktreeAuditItem[];
	retainedUnmerged: WorktreeAuditItem[];
	protectedActive: WorktreeAuditItem[];
	prunableMissing: WorktreeAuditItem[];
	errors: string[];
}

export interface WorktreeCleanupResult {
	repoRoot: string | null;
	dryRun: boolean;
	removed: WorktreeAuditItem[];
	deletedBranches: string[];
	prunedMetadata: boolean;
	retainedDirty: WorktreeAuditItem[];
	retainedUnmerged: WorktreeAuditItem[];
	bytesFreed: number;
	errors: string[];
}

export interface WorktreeAuditOptions {
	tasks?: readonly WorkTask[];
	targetRef?: string;
	extraProtectedPaths?: readonly string[];
	inactiveGraceMs?: number;
	nowMs?: number;
}

export interface WorktreeCleanupOptions extends WorktreeAuditOptions {
	dryRun?: boolean;
	includeMerged?: boolean;
	includeSuperseded?: boolean;
	deleteMergedBranches?: boolean;
	pruneMetadata?: boolean;
}

function gitExec(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, stdout: stdout ?? "", stderr: "" };
	} catch (err: any) {
		return {
			ok: false,
			stdout: String(err?.stdout ?? ""),
			stderr: String(err?.stderr ?? err?.message ?? err),
		};
	}
}

export function parseWorktreeListPorcelain(output: string): GitWorktreeEntry[] {
	const entries: GitWorktreeEntry[] = [];
	let cur: Partial<GitWorktreeEntry> | null = null;
	for (const rawLine of `${output}\n`.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) {
			if (cur?.path) {
				entries.push({
					path: cur.path,
					head: cur.head ?? "",
					...(cur.branch ? { branch: cur.branch } : {}),
					...(cur.detached ? { detached: true } : {}),
					...(cur.locked ? { locked: true } : {}),
					...(cur.prunable ? { prunable: true } : {}),
					...(cur.bare ? { bare: true } : {}),
				});
			}
			cur = null;
			continue;
		}
		if (line.startsWith("worktree ")) {
			cur = { path: line.slice("worktree ".length).trim() };
		} else if (cur) {
			if (line.startsWith("HEAD ")) cur.head = line.slice("HEAD ".length).trim();
			else if (line.startsWith("branch ")) {
				const ref = line.slice("branch ".length).trim();
				cur.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
			} else if (line === "detached") cur.detached = true;
			else if (line === "locked" || line.startsWith("locked ")) cur.locked = true;
			else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
			else if (line === "bare") cur.bare = true;
		}
	}
	return entries;
}

export function findMainGitWorktree(cwd: string): string | null {
	const listed = gitExec(cwd, ["worktree", "list", "--porcelain"]);
	if (!listed.ok) return null;
	const entries = parseWorktreeListPorcelain(listed.stdout);
	return entries[0]?.path ? resolve(entries[0].path) : null;
}

function pathMatchesRoot(candidatePath: string, rootPath: string): boolean {
	const a = resolve(candidatePath);
	const b = resolve(rootPath);
	return a === b || a.startsWith(`${b}/`);
}

export function extractTaskWorktreeRoots(
	task: Pick<WorkTask, "worktreePath" | "writePaths" | "readPaths">,
	registeredPaths: readonly string[],
): string[] {
	const out = new Set<string>();
	const candidates = [
		...(task.worktreePath ? [task.worktreePath] : []),
		...(task.writePaths ?? []),
		...(task.readPaths ?? []),
	];
	for (const raw of candidates) {
		if (!raw || typeof raw !== "string") continue;
		const resolved = resolve(raw);
		for (const reg of registeredPaths) {
			const regRes = resolve(reg);
			if (resolved === regRes || resolved.startsWith(`${regRes}/`) || regRes.startsWith(`${resolved}/`)) {
				out.add(regRes);
			}
		}
	}
	return [...out];
}

function boundedDirSize(dirPath: string, maxEntries = 20_000): number {
	let total = 0;
	let count = 0;
	const stack = [dirPath];
	while (stack.length > 0 && count < maxEntries) {
		const cur = stack.pop()!;
		let dir: ReturnType<typeof opendirSync>;
		try {
			dir = opendirSync(cur);
		} catch {
			continue;
		}
		try {
			for (;;) {
				if (count >= maxEntries) break;
				const ent = dir.readSync();
				if (!ent) break;
				count++;
				const full = join(cur, ent.name);
				let st;
				try {
					st = lstatSync(full);
				} catch {
					continue;
				}
				if (st.isSymbolicLink()) continue;
				if (st.isDirectory()) stack.push(full);
				else if (st.isFile()) total += st.size;
			}
		} finally {
			try { dir.closeSync(); } catch { /* ignore */ }
		}
	}
	return total;
}

function latestWorktreeActivityMs(wtPath: string, repoRoot: string, headSha: string): number {
	let latest = 0;
	for (const probePath of [wtPath, join(wtPath, ".git")]) {
		try {
			const st = lstatSync(probePath);
			if (st.mtimeMs > latest) latest = st.mtimeMs;
		} catch {
			// ignore
		}
	}
	if (headSha) {
		const log = gitExec(repoRoot, ["log", "-1", "--format=%ct", headSha]);
		if (log.ok) {
			const sec = Number.parseInt(log.stdout.trim(), 10);
			if (Number.isFinite(sec) && sec * 1000 > latest) latest = sec * 1000;
		}
	}
	return latest;
}

export function auditWorktrees(repoCwd: string, options: WorktreeAuditOptions = {}): WorktreeAuditReport {
	const report: WorktreeAuditReport = {
		repoRoot: null,
		targetRef: options.targetRef || "HEAD",
		reclaimableMerged: [],
		reclaimableSuperseded: [],
		retainedDirty: [],
		retainedUnmerged: [],
		protectedActive: [],
		prunableMissing: [],
		errors: [],
	};
	if (!repoCwd || !existsSync(repoCwd)) return report;

	const listed = gitExec(repoCwd, ["worktree", "list", "--porcelain"]);
	if (!listed.ok) return report;

	const entries = parseWorktreeListPorcelain(listed.stdout);
	if (entries.length === 0) return report;

	const repoRoot = resolve(entries[0].path);
	report.repoRoot = repoRoot;
	const currentRes = resolve(repoCwd);
	const nowMs = options.nowMs ?? Date.now();
	const graceMs = Math.max(0, options.inactiveGraceMs ?? 0);
	const tasks = options.tasks ?? [];
	const secondaryPaths = entries.slice(1).map((e) => resolve(e.path));

	const protectedSet = new Set<string>([repoRoot, currentRes]);
	for (const extra of options.extraProtectedPaths ?? []) {
		if (extra && typeof extra === "string") protectedSet.add(resolve(extra));
	}

	const liveTasksByWt = new Map<string, WorkTask[]>();
	const terminalTasksByWt = new Map<string, WorkTask[]>();
	for (const t of tasks) {
		const matched = extractTaskWorktreeRoots(t, secondaryPaths);
		for (const wt of matched) {
			const map = terminalWork(t.status) ? terminalTasksByWt : liveTasksByWt;
			const arr = map.get(wt) ?? [];
			arr.push(t);
			map.set(wt, arr);
		}
	}

	for (const entry of entries.slice(1)) {
		const wtPath = resolve(entry.path);
		const liveRefs = liveTasksByWt.get(wtPath) ?? [];
		const termRefs = terminalTasksByWt.get(wtPath) ?? [];
		const taskIds = [...liveRefs, ...termRefs].map((t) => t.id);

		if (!existsSync(wtPath) || entry.prunable) {
			report.prunableMissing.push({
				path: wtPath,
				branch: entry.branch,
				head: entry.head,
				status: "prunable-missing",
				reason: "worktree directory missing on disk (prunable metadata)",
				bytes: 0,
				branchDeleteSafe: false,
				taskIds,
				hasTerminalRef: termRefs.length > 0,
			});
			continue;
		}

		if (entry.bare || entry.locked || protectedSet.has(wtPath) || pathMatchesRoot(currentRes, wtPath)) {
			report.protectedActive.push({
				path: wtPath,
				branch: entry.branch,
				head: entry.head,
				status: "protected-active",
				reason: entry.locked ? "locked worktree" : "current or protected worktree",
				bytes: 0,
				branchDeleteSafe: false,
				taskIds,
				hasTerminalRef: termRefs.length > 0,
			});
			continue;
		}

		if (liveRefs.length > 0) {
			report.protectedActive.push({
				path: wtPath,
				branch: entry.branch,
				head: entry.head,
				status: "protected-active",
				reason: `referenced by active task(s): ${liveRefs.slice(0, 3).map((t) => `${t.id}[${t.status}]`).join(", ")}`,
				bytes: 0,
				branchDeleteSafe: false,
				taskIds,
				hasTerminalRef: termRefs.length > 0,
			});
			continue;
		}

		const statusRes = gitExec(wtPath, ["status", "--porcelain"]);
		if (!statusRes.ok) {
			report.errors.push(`${wtPath}: git status failed (${statusRes.stderr.trim()})`);
			continue;
		}
		if (statusRes.stdout.trim().length > 0) {
			report.retainedDirty.push({
				path: wtPath,
				branch: entry.branch,
				head: entry.head,
				status: "retained-dirty",
				reason: "uncommitted or untracked files present",
				bytes: 0,
				branchDeleteSafe: false,
				taskIds,
				hasTerminalRef: termRefs.length > 0,
			});
			continue;
		}

		if (graceMs > 0) {
			const lastActiveMs = latestWorktreeActivityMs(wtPath, repoRoot, entry.head);
			if (lastActiveMs > 0 && (nowMs - lastActiveMs) < graceMs) {
				report.protectedActive.push({
					path: wtPath,
					branch: entry.branch,
					head: entry.head,
					status: "protected-active",
					reason: "within worktree activity grace window",
					bytes: 0,
					branchDeleteSafe: false,
					taskIds,
					hasTerminalRef: termRefs.length > 0,
				});
				continue;
			}
		}

		const isAncestor = Boolean(
			entry.head && gitExec(repoCwd, ["merge-base", "--is-ancestor", entry.head, report.targetRef]).ok,
		);
		let isPatchMerged = false;
		if (!isAncestor && entry.head) {
			const cherry = gitExec(repoCwd, ["cherry", report.targetRef, entry.head]);
			if (cherry.ok) {
				const lines = cherry.stdout.trim().split(/\r?\n/).filter(Boolean);
				isPatchMerged = lines.length > 0 && lines.every((l) => l.startsWith("- "));
			}
		}

		const onlySupersededOrCancelled = termRefs.length > 0
			&& termRefs.every((t) => t.status === "superseded" || t.status === "cancelled");

		if (isAncestor || isPatchMerged) {
			report.reclaimableMerged.push({
				path: wtPath,
				branch: entry.branch,
				head: entry.head,
				status: "reclaimable-merged",
				reason: isAncestor ? `merged into ${report.targetRef}` : `patch-equivalent commits already in ${report.targetRef}`,
				bytes: boundedDirSize(wtPath),
				branchDeleteSafe: isAncestor,
				taskIds,
				hasTerminalRef: termRefs.length > 0,
			});
			continue;
		}

		if (onlySupersededOrCancelled) {
			report.reclaimableSuperseded.push({
				path: wtPath,
				branch: entry.branch,
				head: entry.head,
				status: "reclaimable-superseded",
				reason: `clean tree owned only by ${termRefs.map((t) => `${t.id}[${t.status}]`).slice(0, 3).join(", ")}`,
				bytes: boundedDirSize(wtPath),
				branchDeleteSafe: false,
				taskIds,
				hasTerminalRef: true,
			});
			continue;
		}

		report.retainedUnmerged.push({
			path: wtPath,
			branch: entry.branch,
			head: entry.head,
			status: "retained-unmerged",
			reason: "clean tree with unmerged commits (retained safely)",
			bytes: 0,
			branchDeleteSafe: false,
			taskIds,
			hasTerminalRef: termRefs.length > 0,
		});
	}

	return report;
}

export function cleanupSafeWorktrees(repoCwd: string, options: WorktreeCleanupOptions = {}): WorktreeCleanupResult {
	const dryRun = options.dryRun === true;
	const includeMerged = options.includeMerged !== false;
	const includeSuperseded = options.includeSuperseded !== false;
	const deleteMergedBranches = options.deleteMergedBranches !== false;
	const pruneMetadata = options.pruneMetadata !== false;

	const audit = auditWorktrees(repoCwd, options);
	const res: WorktreeCleanupResult = {
		repoRoot: audit.repoRoot,
		dryRun,
		removed: [],
		deletedBranches: [],
		prunedMetadata: false,
		retainedDirty: audit.retainedDirty,
		retainedUnmerged: audit.retainedUnmerged,
		bytesFreed: 0,
		errors: [...audit.errors],
	};
	if (!audit.repoRoot) return res;

	const targets: WorktreeAuditItem[] = [
		...(includeMerged ? audit.reclaimableMerged : []),
		...(includeSuperseded ? audit.reclaimableSuperseded : []),
	];

	for (const item of targets) {
		if (dryRun) {
			res.removed.push(item);
			res.bytesFreed += item.bytes;
			if (deleteMergedBranches && item.branchDeleteSafe && item.branch) {
				res.deletedBranches.push(item.branch);
			}
			continue;
		}
		// Never use --force: git worktree remove itself guarantees zero dirty/untracked loss.
		const rm = gitExec(audit.repoRoot, ["worktree", "remove", item.path]);
		if (!rm.ok) {
			res.errors.push(`${item.path}: git worktree remove refused (${rm.stderr.trim()})`);
			res.retainedDirty.push({
				...item,
				status: "retained-dirty",
				reason: `worktree remove refused cleanly: ${rm.stderr.trim().slice(0, 120)}`,
			});
			continue;
		}
		res.removed.push(item);
		res.bytesFreed += item.bytes;

		if (deleteMergedBranches && item.branchDeleteSafe && item.branch) {
			// Never use -D: git branch -d only deletes strictly merged branches.
			const br = gitExec(audit.repoRoot, ["branch", "-d", item.branch]);
			if (br.ok) res.deletedBranches.push(item.branch);
		}
	}

	if (!dryRun && pruneMetadata && (res.removed.length > 0 || audit.prunableMissing.length > 0)) {
		const pruned = gitExec(audit.repoRoot, ["worktree", "prune"]);
		if (pruned.ok) res.prunedMetadata = true;
	}

	return res;
}
