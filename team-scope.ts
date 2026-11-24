/**
 * Granular file-scope semantics for the team ledger.
 *
 * Three questions, deliberately kept apart:
 *  1. IDENTITY  — `overlap` / `scopeConflicts`: do two declarations name the SAME path/inode?
 *  2. COVERAGE  — `writeCoverage` / `writeConflicts`: does a DIRECTORY-WIDE WRITE (`dir/`) own the
 *     paths below it?
 *  3. PERMISSION — `scopeAllowsWrite`: may this task write one concrete target path?
 *
 * IDENTITY (exact path first, then physical identity):
 *  - `src/a.ts` vs `src/a.ts`            -> same claim (write/write or write/read)
 *  - `src/a.ts` vs `src/b.ts`            -> disjoint concrete files: no conflict
 *  - `src/`     vs `src/`                -> same path claimed twice: conflict
 *  - `src/`     vs `src/a.ts`            -> NOT the same path and NOT the same inode (a directory
 *    entry is not its child), so identity alone never reports this pair. That is why a directory
 *    declaration must not serialize independent writers of distinct files below it.
 *
 * COVERAGE (only when the first scope is a WRITE): an explicit directory marker (`dir/`) is a
 * directory-wide write: it authorizes the subtree, therefore it CONFLICTS with nested writes and
 * nested reads (fail-closed). A directory in READ paths is only a listing, not ownership: it never
 * gates a nested file writer, so independent file tasks sharing a parent-directory READ declaration
 * stay parallel. Coverage is alias-aware (symlinked parent, `/proc/self/root` bind aliases, case
 * aliases via physical identity of the ancestors) and never string-prefix based (`src/` never covers
 * `src2/a.ts`).
 *
 * A bare path (no trailing marker) is always ONE concrete file-level scope, for conflict AND
 * permission alike; directory intent is never inferred from the filesystem for conflict purposes.
 * `isExistingDirectory` only keeps already-dispatched legacy workers (registered before markers
 * existed) writable; that legacy branch never widens conflict/exclusivity.
 *
 * PHYSICAL IDENTITY: equal strings are not the only way two scopes name one file. `overlap` also
 * compares `physicalId`, so a lexical alias of the same physical file still conflicts:
 *  - `/proc/self/root/home/.../team-ledger.ts` vs `/home/.../team-ledger.ts` (bind/root aliases)
 *  - a symlinked file or symlinked parent directory vs its target
 *  - hard links to one inode
 *  - case aliases on case-insensitive filesystems (APFS/NTFS share the inode)
 * The ancestor-descendant policy is untouched: `dir` and `dir/file` stay DISTINCT physical inodes;
 * only COVERAGE (a marked write) relates them.
 */
import { isAbsolute, resolve, relative, sep, dirname, basename, join } from "node:path";
import { realpathSync, statSync } from "node:fs";

const DIR_MARKER = /[\\/]$/;
const PHYSICAL_TTL_MS = 5_000;
const PHYSICAL_CACHE_MAX = 4_096;
const physicalCache = new Map<string, { id: string; at: number }>();

/** True when the scope string carries an explicit directory marker (trailing `/`). */
export function isDirScope(scope: string): boolean {
	return DIR_MARKER.test(scope);
}

/** Scope without its directory marker and without trailing separators. Idempotent for file scopes. */
export function scopeBase(scope: string): string {
	const base = scope.replace(/[\\/]+$/, "");
	if (base === "") return isAbsolute(scope) ? scope : base;
	// Windows drive root (`C:\`) keeps its separator so it stays an absolute root.
	if (/^[A-Za-z]:$/.test(base)) return base + sep;
	return base;
}

/** Canonical storage form: absolute path, one trailing separator only for explicit directory scopes. */
export function normalizeScopePath(declared: string, cwd: string): string {
	const dir = isDirScope(declared);
	const absolute = resolve(cwd, scopeBase(declared));
	if (!dir) return absolute;
	return absolute.endsWith(sep) ? absolute : absolute + sep;
}

/**
 * Physical identity of one declared scope, memoized for PHYSICAL_TTL_MS.
 *
 * Existing paths are `dev:ino`, which collapses lexical aliases, symlinked files and parents, hard
 * links, and case aliases on case-insensitive filesystems. Missing paths use the real path of their
 * deepest existing ancestor plus the remaining components, so a not-yet-created file under a
 * symlinked parent still aliases its real location.
 *
 * BOUND (documented, not silently widened): a *missing* file behind a symlink whose parent does not
 * exist yet, and case aliases of a missing file on a case-insensitive filesystem, cannot be proven
 * identical until the path exists. Such pairs report no conflict — ancestor widening is NOT
 * reintroduced as a fallback.
 */
export function physicalId(scope: string): string {
	const abs = scopeBase(resolve(scope));
	const now = Date.now();
	const cached = physicalCache.get(abs);
	if (cached && now - cached.at < PHYSICAL_TTL_MS) return cached.id;
	const id = computePhysicalId(abs);
	if (physicalCache.size >= PHYSICAL_CACHE_MAX) {
		for (const [key, entry] of physicalCache) if (now - entry.at >= PHYSICAL_TTL_MS) physicalCache.delete(key);
		if (physicalCache.size >= PHYSICAL_CACHE_MAX) physicalCache.clear();
	}
	physicalCache.set(abs, { id, at: now });
	return id;
}

function computePhysicalId(abs: string): string {
	try {
		const st = statSync(abs);
		return `${st.dev}:${st.ino}`;
	} catch {
		return `pending:${canonicalPath(abs)}`;
	}
}

/** Real path of the deepest existing ancestor with the missing tail re-appended. */
function canonicalPath(abs: string): string {
	const rest: string[] = [];
	let current = abs;
	for (;;) {
		try {
			const real = realpathSync(current);
			return rest.length === 0 ? real : join(real, ...rest.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return abs;
			rest.push(basename(current));
			current = parent;
		}
	}
}

/** Drop memoized physical identities (tests, or after filesystem/symlink changes). */
export function clearScopeCache(): void {
	physicalCache.clear();
}

/**
 * Do two declared scopes claim the same path? Exact path first, then physical identity, so an alias
 * of one physical file (symlink, `/proc/self/root` prefix, hard link, case alias) still conflicts.
 * `dir` and `dir/file` are DISTINCT paths and DISTINCT inodes: no ancestor conflict.
 */
export function overlap(a: string, b: string): boolean {
	const baseA = scopeBase(a);
	const baseB = scopeBase(b);
	if (baseA === baseB) return true;
	return physicalId(baseA) === physicalId(baseB);
}

/** Symmetric conflict predicate (kept explicit for call sites that ask "do these collide?"). */
export function scopeConflicts(a: string, b: string): boolean {
	return overlap(a, b) || overlap(b, a);
}

/**
 * Alias-aware containment: is `target` the directory `container` itself or a path below it?
 *
 * Lexical descendants are checked first. When that misses (symlinked parent, `/proc/self/root` bind
 * alias, case alias), the target's ancestor chain is compared by `physicalId`, which collapses all
 * of those aliases through the real inode of the directory. A missing directory still matches a
 * missing child because both fall back to the canonical path of their deepest existing ancestor.
 *
 * Not a string-prefix test: `src/` never contains `src2/a.ts`.
 */
export function scopeCovers(container: string, target: string): boolean {
	const dir = scopeBase(container);
	const file = scopeBase(target);
	if (dir === file) return true;
	if (isDescendant(dir, file)) return true;
	const containerId = physicalId(dir);
	let current = dirname(file);
	for (;;) {
		if (current === dir) return true;
		if (physicalId(current) === containerId) return true;
		const parent = dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/**
 * Coverage of a DIRECTORY-WIDE WRITE over another declared scope (containment, not permission).
 * Only an explicitly marked directory (`dir/`) is directory-wide; a bare path is one concrete file.
 */
export function writeCoverage(writeScope: string, other: string): boolean {
	return isDirScope(writeScope) && scopeCovers(writeScope, other);
}

/**
 * Admission predicate: does the WRITE scope claim `other` (a write or read scope of another task)?
 * Identity or directory-wide coverage blocks; a directory READ is never passed here as `writeScope`,
 * so a shared parent-directory read declaration cannot serialize independent file tasks.
 */
export function writeConflicts(writeScope: string, other: string): boolean {
	return scopeConflicts(writeScope, other) || writeCoverage(writeScope, other);
}

type ScopePaths = { writePaths: string[]; readPaths: string[] };

/**
 * Policy-layer admission answer for two tasks' declared scopes.
 *
 * This is the predicate dispatch admission needs: write/write and write/read are checked in BOTH
 * orders, so a directory-wide write is fail-closed whichever side declares it, while a directory
 * READ (present only in `readPaths`, never as the writer side) can never gate a nested file writer.
 * `taskConflict` in team-ledger.ts should delegate here once its write-scope is widened; until then
 * that call site still uses symmetric `overlap`, which is identity-only.
 */
export function scopePathsConflict(a: ScopePaths, b: ScopePaths): boolean {
	const writeVs = (writes: string[], others: string[]) => writes.some(w => others.some(o => writeConflicts(w, o)));
	return writeVs(a.writePaths, b.writePaths) || writeVs(b.writePaths, a.writePaths)
		|| writeVs(a.writePaths, b.readPaths) || writeVs(b.writePaths, a.readPaths);
}

/**
 * Diagnostic path explaining a scope conflict. Only write/write and write/read intersections can
 * block admission, so read/read intersections are never reported. A directory-wide write reports the
 * COVERED nested path (the path that is actually mutated), not the directory claim itself.
 */
export function conflictPathBetweenScopes(a: ScopePaths, b: ScopePaths): string {
	const candidatePairs: Array<[string[], string[]]> = [
		[a.writePaths, b.writePaths],
		[b.writePaths, a.writePaths],
		[a.writePaths, b.readPaths],
		[b.writePaths, a.readPaths],
	];
	for (const [xs, ys] of candidatePairs) {
		for (const x of xs) {
			for (const y of ys) {
				if (scopeConflicts(x, y)) return x;
				if (writeCoverage(x, y)) return y;
			}
		}
	}
	return b.writePaths[0] || a.writePaths[0] || "(unspecified path)";
}

/**
 * True when the declared path is an existing directory on disk.
 * Used only for admission diagnostics and the transitional legacy permission below — never to
 * decide conflict/exclusivity, because disk state must not silently widen a scope.
 */export function isExistingDirectory(scope: string): boolean {
	try {
		return statSync(scopeBase(scope)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Write permission of one declared scope over one concrete target path (not a conflict test).
 *
 * Exact path and explicit directory subtrees are authorized. Scopes registered before explicit
 * markers existed keep working while their path is already a directory on disk; that branch is
 * transitional so already-dispatched workers are not hard-blocked mid-flight.
 */
export function scopeAllowsWrite(scope: string, target: string): boolean {
	const scopePath = scopeBase(scope);
	const targetPath = scopeBase(target);
	if (scopePath === targetPath) return true;
	if (isDirScope(scope) && isDescendant(scopePath, targetPath)) return true;
	if (!isExistingDirectory(scopePath)) return false;
	return isDescendant(scopePath, targetPath);
}

/** Lexical descendant check on already-normalized absolute paths. */
function isDescendant(dir: string, target: string): boolean {
	const rel = relative(dir, target);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}