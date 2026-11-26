import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newLedger, addRequest, addTasks, updateTask } from "../team-ledger.ts";
import { auditWorktrees, cleanupSafeWorktrees, findMainGitWorktree, parseWorktreeListPorcelain } from "../team-worktree.ts";

function git(cwd: string, args: string[]): string {
	return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15_000 }).trim();
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-team-wt-test-")));
try {
	const repo = join(root, "repo");
	const wtBase = join(root, "repo-worktrees");
	mkdirSync(repo, { recursive: true });
	mkdirSync(wtBase, { recursive: true });

	git(repo, ["init", "-b", "main"]);
	git(repo, ["config", "user.name", "Test"]);
	git(repo, ["config", "user.email", "test@example.com"]);
	writeFileSync(join(repo, "README.md"), "# base\n");
	git(repo, ["add", "README.md"]);
	git(repo, ["commit", "-m", "init"]);

	// 1. Merged ancestor worktree -> reclaimable-merged (branch deleted safely)
	const wtMerged = join(wtBase, "wt-merged");
	git(repo, ["worktree", "add", "-b", "feat/merged", wtMerged, "main"]);
	writeFileSync(join(wtMerged, "merged.txt"), "merged work\n");
	git(wtMerged, ["add", "merged.txt"]);
	git(wtMerged, ["commit", "-m", "feat: merged"]);
	git(repo, ["merge", "--no-ff", "feat/merged", "-m", "merge feat/merged"]);

	// 2. Patch-equivalent (squash/cherry-picked) worktree -> reclaimable-merged, branch kept safe
	const wtCherry = join(wtBase, "wt-cherry");
	git(repo, ["worktree", "add", "-b", "feat/cherry", wtCherry, "main~1"]);
	writeFileSync(join(wtCherry, "cherry.txt"), "cherry work\n");
	git(wtCherry, ["add", "cherry.txt"]);
	const cherrySha = (git(wtCherry, ["commit", "-m", "feat: cherry"]), git(wtCherry, ["rev-parse", "HEAD"]));
	git(repo, ["cherry-pick", cherrySha]);

	// 3. Unmerged clean worktree with superseded ledger ref -> reclaimable-superseded (dir removed, branch kept)
	const wtSuperseded = join(wtBase, "wt-superseded");
	git(repo, ["worktree", "add", "-b", "feat/superseded", wtSuperseded, "main"]);
	writeFileSync(join(wtSuperseded, "sup.ts"), "export const s = 1;\n");
	git(wtSuperseded, ["add", "sup.ts"]);
	git(wtSuperseded, ["commit", "-m", "wip: superseded"]);

	// 4. Dirty unmerged worktree -> retained-dirty
	const wtDirty = join(wtBase, "wt-dirty");
	git(repo, ["worktree", "add", "-b", "feat/dirty", wtDirty, "main"]);
	writeFileSync(join(wtDirty, "dirty.txt"), "uncommitted change\n");

	// 5. Clean unmerged worktree with no supersede -> retained-unmerged
	const wtUnmerged = join(wtBase, "wt-unmerged");
	git(repo, ["worktree", "add", "-b", "feat/unmerged", wtUnmerged, "main"]);
	writeFileSync(join(wtUnmerged, "unmerged.ts"), "export const u = 1;\n");
	git(wtUnmerged, ["add", "unmerged.ts"]);
	git(wtUnmerged, ["commit", "-m", "feat: real work"]);

	// 6. Clean merged worktree still referenced by a LIVE task -> protected-active
	const wtLive = join(wtBase, "wt-live");
	git(repo, ["worktree", "add", "-b", "feat/live", wtLive, "main"]);

	// 7. Linked current worktree on main-like base -> must protect current cwd even if invoked from linked tree
	const wtLinkedCurrent = join(wtBase, "wt-current");
	git(repo, ["worktree", "add", "-b", "feat/current", wtLinkedCurrent, "main"]);

	const parsed = parseWorktreeListPorcelain(git(repo, ["worktree", "list", "--porcelain"]));
	assert.strictEqual(parsed.length, 8);
	assert.strictEqual(findMainGitWorktree(wtLinkedCurrent), repo);
	console.log("✓ parseWorktreeListPorcelain & findMainGitWorktree resolve primary repo from linked worktree");

	const b = newLedger();
	const q = addRequest(b, "wt lifecycle", "input:wt");
	addTasks(b, [
		{ id: "W-old", role: "bridges", title: "superseded work", requestIds: [q.id], dependsOn: [], readPaths: [], writePaths: ["sup.ts"], acceptance: ["ac1"], isolation: "worktree", worktreePath: wtSuperseded },
		{ id: "W-new", role: "bridges", title: "replacement", requestIds: [q.id], dependsOn: [], readPaths: [], writePaths: ["new.ts"], acceptance: ["ac1"] },
		{ id: "W-live", role: "bridges", title: "live wt task", requestIds: [q.id], dependsOn: [], readPaths: [], writePaths: ["live.ts"], acceptance: ["ac1"], isolation: "worktree", worktreePath: wtLive },
	], repo);
	updateTask(b, { id: "W-old", status: "superseded", reason: "replaced", evidence: ["superseded by W-new"], replacementIds: ["W-new"] });

	// Grace window protection test: future nowMs vs immediate nowMs
	const nearNow = Date.now() + 1000;
	const graceAudit = auditWorktrees(repo, { tasks: b.tasks, inactiveGraceMs: 60_000, nowMs: nearNow });
	assert.strictEqual(graceAudit.reclaimableMerged.length, 0, "Recent worktrees stay protected during grace window");
	console.log("✓ grace window protects recently created/committed worktrees from premature idle GC");

	// Invoke audit & dryRun FROM wtLinkedCurrent (itself a linked secondary worktree!)
	const dry = cleanupSafeWorktrees(wtLinkedCurrent, { tasks: b.tasks, dryRun: true });
	assert.strictEqual(dry.removed.length, 3, `Expected 3 reclaimable (merged, cherry, superseded), got ${dry.removed.map(r => `${r.path}:${r.status}`).join(", ")}`);
	assert.ok(dry.removed.some(r => r.path === wtMerged && r.status === "reclaimable-merged" && r.branchDeleteSafe));
	assert.ok(dry.removed.some(r => r.path === wtCherry && r.status === "reclaimable-merged" && !r.branchDeleteSafe));
	assert.ok(dry.removed.some(r => r.path === wtSuperseded && r.status === "reclaimable-superseded" && !r.branchDeleteSafe));
	assert.ok(dry.retainedDirty.some(r => r.path === wtDirty));
	assert.ok(dry.retainedUnmerged.some(r => r.path === wtUnmerged));
	assert.ok(existsSync(wtMerged) && existsSync(wtCherry) && existsSync(wtSuperseded), "dryRun must not delete directories");
	console.log("✓ dryRun from linked worktree classifies merged/cherry/superseded/dirty/unmerged/live/current cleanly");

	// Execute non-destructive cleanup
	const res = cleanupSafeWorktrees(wtLinkedCurrent, { tasks: b.tasks, dryRun: false });
	assert.strictEqual(res.errors.length, 0, `Unexpected cleanup errors: ${res.errors.join("; ")}`);
	assert.strictEqual(res.removed.length, 3);
	assert.ok(!existsSync(wtMerged), "Merged worktree removed");
	assert.ok(!existsSync(wtCherry), "Patch-merged cherry worktree removed");
	assert.ok(!existsSync(wtSuperseded), "Clean superseded worktree removed");
	assert.deepStrictEqual(res.deletedBranches, ["feat/merged"], "Only strictly ancestor-merged branch deleted with git branch -d");

	// Verify cherry, superseded, dirty, unmerged branches & dirty/unmerged/live/current trees ALL survive!
	const branches = git(repo, ["branch", "--list"]).split("\n").map(s => s.replace(/^[*+\s]+/, "").trim());
	assert.ok(!branches.includes("feat/merged"), "feat/merged deleted");
	for (const keepBr of ["feat/cherry", "feat/superseded", "feat/dirty", "feat/unmerged", "feat/live", "feat/current"]) {
		assert.ok(branches.includes(keepBr), `Branch must survive non-destructive GC: ${keepBr}`);
	}
	for (const keepDir of [wtDirty, wtUnmerged, wtLive, wtLinkedCurrent, repo]) {
		assert.ok(existsSync(keepDir), `Protected tree must remain on disk: ${keepDir}`);
	}
	console.log("✓ non-destructive cleanup removes merged+superseded trees and preserves dirty, unmerged, live, current, and cherry branches");
} finally {
	rmSync(root, { recursive: true, force: true });
}
