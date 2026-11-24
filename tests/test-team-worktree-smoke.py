"""Exercise the documented Git worktree protocol, not an automatic merge controller.
Runs real Git in temporary repositories only; no models or production mutations.
"""
import concurrent.futures
import json
import pathlib
import subprocess
import tempfile
import threading
import time


def git(path, *args, check=True):
    return subprocess.run(["git", "-C", str(path), *args], text=True, capture_output=True, check=check, timeout=30)


def clean(path):
    return not git(path, "status", "--porcelain").stdout.strip()


with tempfile.TemporaryDirectory(prefix="team-worktree-smoke-") as temp:
    root = pathlib.Path(temp)
    target = root / "target"
    target.mkdir()
    git(target, "init", "-b", "main")
    git(target, "config", "user.name", "Team Fixture")
    git(target, "config", "user.email", "fixture@example.invalid")
    (target / "baseline.txt").write_text("baseline\n")
    (target / "shared.txt").write_text("initial\n")
    git(target, "add", "--", "baseline.txt", "shared.txt")
    git(target, "commit", "-m", "fixture baseline")
    base = git(target, "rev-parse", "HEAD").stdout.strip()
    barrier = threading.Barrier(3)
    timing = []
    lock = threading.Lock()
    def task(index):
        tree, branch = root / f"worker-{index}", f"team/fixture-{index}"
        git(target, "worktree", "add", "-b", branch, str(tree), base)
        barrier.wait(timeout=15)
        start = time.monotonic()
        time.sleep(0.1)  # Bounded overlap evidence, not a simulated scheduler.
        owned = f"owned-{index}.txt"
        (tree / owned).write_text(f"Task {index} result at pinned base {base}\n")
        git(tree, "add", "--", owned)
        git(tree, "commit", "-m", f"task {index} owned change")
        commit = git(tree, "rev-parse", "HEAD").stdout.strip()
        assert clean(tree)
        with lock:
            timing.append((start, time.monotonic()))
        return tree, branch, commit, owned
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
        work = list(executor.map(task, range(3)))
    assert max(start for start, end in timing) < min(end for start, end in timing), "Tasks did not overlap."
    assert git(target, "rev-parse", "HEAD").stdout.strip() == base
    assert all(not (target / owned).exists() for _, _, _, owned in work)

    # Dirty target means integration is pending, never a reason to discard user work.
    dirty = target / "baseline.txt"
    dirty.write_text("unrelated local fixture edit\n")
    head_before = git(target, "rev-parse", "HEAD").stdout
    assert not clean(target)
    assert dirty.read_text() == "unrelated local fixture edit\n"
    assert git(target, "rev-parse", "HEAD").stdout == head_before
    # The fixture owner explicitly restores only its own temporary edit.
    git(target, "restore", "--", "baseline.txt")
    assert clean(target)

    # A single integration owner merges serially and validates target artifacts.
    for tree, branch, commit, owned in work:
        assert clean(target) and clean(tree)
        git(target, "merge", "--no-ff", "--no-edit", branch)
        assert git(target, "merge-base", "--is-ancestor", commit, "HEAD", check=False).returncode == 0
        assert (target / owned).read_text().startswith("Task ")
    assert clean(target)
    integrated = git(target, "rev-parse", "HEAD").stdout.strip()
    assert integrated != base
    for tree, branch, commit, owned in work:
        assert clean(tree)
        git(target, "worktree", "remove", str(tree))  # Never --force.
        git(target, "branch", "-d", branch)           # Never -D.
        assert not tree.exists()
    assert len(git(target, "worktree", "list", "--porcelain").stdout.split("worktree ")) == 2
    assert git(target, "branch", "--format=%(refname:short)").stdout.strip() == "main"

    # Independent overlapping edits can conflict: preserve the unmerged tree/branch.
    conflicts = []
    for index in range(2):
        tree, branch = root / f"conflict-{index}", f"team/conflict-{index}"
        git(target, "worktree", "add", "-b", branch, str(tree), integrated)
        (tree / "shared.txt").write_text(f"conflicting result {index}\n")
        git(tree, "add", "--", "shared.txt")
        git(tree, "commit", "-m", f"conflicting task {index}")
        conflicts.append((tree, branch))
    git(target, "merge", "--no-ff", "--no-edit", conflicts[0][1])
    first_head = git(target, "rev-parse", "HEAD").stdout
    result = git(target, "merge", "--no-ff", "--no-edit", conflicts[1][1], check=False)
    assert result.returncode != 0
    assert conflicts[1][0].exists()
    assert git(target, "show-ref", "--verify", f"refs/heads/{conflicts[1][1]}", check=False).returncode == 0
    assert git(target, "branch", "-d", conflicts[1][1], check=False).returncode != 0
    git(target, "merge", "--abort")
    assert clean(target) and git(target, "rev-parse", "HEAD").stdout == first_head
    assert conflicts[1][0].exists()  # INTEGRATION_PENDING / CLEANUP_PENDING preserved.
    evidence = {
        "passed": True,
        "scope": "real Git temporary fixtures; manual protocol, not plugin automatic integration",
        "checks": ["three independent worker tasks actually overlap", "pinned base and per-task commits", "workers do not mutate target before integration", "unrelated dirty target is preserved", "serial target merges and ancestry/artifact verification", "owned clean merged worktrees/branches removed without force", "conflict preserves unmerged worker tree/branch and target restored by merge abort"],
    }
    pathlib.Path("/tmp/team-worktree-smoke-evidence.json").write_text(json.dumps(evidence, indent=2))
    print("Real Git worktree protocol passed: 7 checks; evidence /tmp/team-worktree-smoke-evidence.json")
