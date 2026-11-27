import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	newLedger, addRequest, addTasks, autoAcceptTask, isReviewExempt, isDeterministic, isMachineAssertion as isMachineAssertionCrit,
	createReviewerTask, deliveryVersionOf, readyTasks, updateTask, recordReview, ledgerPrompt,
	type WorkTask,
} from "../team-ledger.ts";
import { buildPolicy, buildTaskContract, defaultConfig } from "../extensions/team.ts";

let passed = 0;
const test = (name: string, fn: () => void) => { fn(); passed++; console.log(`✓ ${name}`); };
const cwd = mkdtempSync(join(tmpdir(), "pi-teams-role-review-"));
const artifact = join(cwd, "receipt.txt");
writeFileSync(artifact, "delivered\nverified\n");
const report = `Status: complete\nChanges: ${artifact}:1\nVerification: exit code 0; 10 tests passed\nRemaining issues: none.`;

/** W-1 delivers; W-2 depends on it; acceptance is semantic unless fields override it. */
const setup = (role = "ayton", fields: Record<string, unknown> = {}) => {
	const board = newLedger();
	const request = addRequest(board, "bounded role delivery", "role-review-test");
	const [task, successor] = addTasks(board, [
		{ id: "W-1", title: "Small scoped delivery", role, requestIds: [request.id], dependsOn: [],
			readPaths: [artifact], writePaths: role === "cp" || role === "parent" ? [] : [artifact],
			acceptance: ["The scoped change satisfies the requested behavior"], ...fields },
		{ id: "W-2", title: "Use delivered output", role: "bridges", requestIds: [request.id], dependsOn: ["W-1"],
			readPaths: [artifact], writePaths: [], acceptance: ["Verify successor"] },
	], cwd);
	task.status = "reported"; task.runId = "run-1"; task.sessionId = "session-1"; task.dispatchedAt = "2026-01-01T00:00:00.000Z";
	return { board, task, successor };
};
/** Deterministic fixture: every acceptance criterion is a machine assertion. */
const deterministicSetup = (fields: Record<string, unknown> = {}, role = "booker") =>
	setup(role, { reviewTier: "deterministic", autoAccept: true, acceptance: [`file:${artifact}`, "exit code 0"], ...fields });
const accept = (fixture: ReturnType<typeof setup>, text = report, cleanExit = true, extra = {}) =>
	autoAcceptTask(fixture.board, fixture.task.id, [text], { cwd, cleanExit, ...extra });
const acceptParent = (fixture: ReturnType<typeof setup>) =>
	updateTask(fixture.board, { id: fixture.task.id, status: "done", evidence: [report], reason: "Parent checked the report evidence" });

try {
	test("Ayton and Cameron default review-exempt: no reviewer, stays reported until the parent accepts; Ayton supports test/artifact writes", () => {
		for (const role of ["ayton", "cameron"]) {
			for (const writePaths of [[], [artifact]]) {
				const f = setup(role, { writePaths });
				assert.equal(isReviewExempt(f.task), true);
				assert.equal(isDeterministic(f.task), false);
				assert.ok(!readyTasks(f.board).includes(f.successor));
				// Exemption never settles a delivery by itself, whatever the prose says.
				assert.equal(accept(f), false);
				assert.equal(f.task.status, "reported");
				assert.equal(f.board.tasks.length, 2, "no reviewer ceremony");
				assert.ok(!readyTasks(f.board).includes(f.successor), "successor waits for acceptance");
				acceptParent(f);
				assert.equal(f.task.status, "done");
				assert.ok(readyTasks(f.board).includes(f.successor));
			}
		}
	});

	test("exemption does not infer completion from prose: pending/future/failed phrasing is irrelevant", () => {
		const cases = [
			"Once the implementation is complete, I will run tests and integrate it.",
			"Complete the remaining integration tomorrow.",
			"Implementation complete; integration is still pending.",
			"## Status: pending\nVERDICT: PASS\n" + artifact,
			`Status: complete\nTests: 10 passed, 1 failed\n${artifact}:1`,
			"Status: complete\nRemaining risks: legacy consumers may retain cached data; outside this task scope, nonblocking.",
		];
		for (const text of cases) {
			const f = setup();
			assert.equal(accept(f, text), false, text);
			assert.equal(f.task.status, "reported", text);
			assert.deepEqual(f.task.evidence, [], "no mutation from an automatic attempt");
		}
	});

	test("llm, autoAccept:false and explicit reviewerRole opt into independent review", () => {
		for (const fields of [{ reviewTier: "llm" }, { autoAccept: false }, { reviewerRole: "cp" }, { reviewTier: "none", reviewerRole: "cp" }]) {
			const f = setup("booker", fields);
			assert.equal(isReviewExempt(f.task), false);
			assert.equal(accept(f), false);
			const reviewer = createReviewerTask(f.board, f.task, f.task.reviewerRole);
			assert.equal(reviewer.role, "cp");
			assert.equal(f.task.status, "reported");
			assert.ok(!readyTasks(f.board).includes(f.successor));
		}
		// Batch 1 §1.4 intentional semantic change: reviewTier "none" takes precedence over autoAccept:false
		// for NOT spawning a reviewer; autoAccept:false merely keeps the delivery `reported` until explicit
		// parent settlement. An explicit reviewerRole still forces independent review (verified above).
		const waived = setup("booker", { reviewTier: "none", autoAccept: false });
		assert.equal(isReviewExempt(waived.task), true, "none beats autoAccept:false for reviewer spawn");
		assert.equal(accept(waived), false, "exemption never auto-settles; delivery stays reported");
		assert.equal(waived.task.status, "reported");
		assert.equal(waived.board.tasks.length, 2, "no reviewer spawned for reviewTier none + autoAccept false");
	});

	test("product-writer default CP review (booker, bridges) vs explicit none for small read/write work", () => {
		for (const role of ["booker", "bridges"]) {
			const defaultTask = setup(role);
			assert.equal(isReviewExempt(defaultTask.task), false);
			assert.equal(accept(defaultTask), false);
			assert.equal(createReviewerTask(defaultTask.board, defaultTask.task).role, "cp");
			for (const writePaths of [[], [artifact]]) {
				const waived = setup(role, { reviewTier: "none", writePaths });
				assert.equal(waived.task.autoAccept, undefined, "none needs no extra flag");
				assert.equal(isReviewExempt(waived.task), true);
				assert.equal(accept(waived), false, "waiver skips the reviewer, not the parent acceptance");
				assert.equal(waived.board.tasks.length, 2);
				acceptParent(waived);
				assert.ok(readyTasks(waived.board).includes(waived.successor));
			}
		}
	});

	test("deterministic ALL-assertions gate is the only automatic route", () => {
		for (const role of ["booker", "bridges", "ayton", "cameron"]) {
			const f = deterministicSetup({}, role);
			assert.equal(isReviewExempt(f.task), false);
			assert.equal(isDeterministic(f.task), true);
			assert.equal(accept(f), true);
			assert.equal(f.task.reason, "Deterministic auto-acceptance verified by machine assertions");
			assert.ok(readyTasks(f.board).includes(f.successor));
			assert.equal(isDeterministic(setup(role, { reviewTier: "deterministic", acceptance: ["exit 0"] }).task), false);
			const hybrid = setup(role, { reviewTier: "deterministic", autoAccept: true, acceptance: ["exit 0", "Semantic behavior is correct"] });
			assert.equal(isDeterministic(hybrid.task), false);
			assert.equal(accept(hybrid), false);
		}
	});

	test("explicit review request blocks the deterministic route too", () => {
		for (const fields of [{ reviewerRole: "cp" }, { autoAccept: false }, { reviewTier: "llm" }]) {
			const f = deterministicSetup(fields);
			assert.equal(accept(f), false, JSON.stringify(fields));
			assert.equal(f.task.status, "reported");
		}
	});

	test("unfinished dependencies block automatic settlement, like an explicit done update", () => {
		const f = newLedger();
		const request = addRequest(f, "dependency invariant", "role-review-test");
		const [dep, task, successor] = addTasks(f, [
			{ id: "W-dep", title: "Prerequisite", role: "bridges", requestIds: [request.id], dependsOn: [], readPaths: [], writePaths: [artifact], acceptance: ["deliver"] },
			{ id: "W-use", title: "Dependent", role: "booker", requestIds: [request.id], dependsOn: ["W-dep"], readPaths: [], writePaths: [artifact], reviewTier: "deterministic", autoAccept: true, acceptance: [`file:${artifact}`, "exit 0"] },
			{ id: "W-next", title: "Successor", role: "bridges", requestIds: [request.id], dependsOn: ["W-use"], readPaths: [], writePaths: [], acceptance: ["verify"] },
		], cwd);
		task.status = "reported"; task.runId = "r"; task.sessionId = "s"; task.dispatchedAt = "2026-01-01T00:00:00.000Z";
		dep.status = "reported";
		assert.equal(autoAcceptTask(f, "W-use", ["Status: complete\n$ ok\nexit code 0"], { cwd, cleanExit: true }), false);
		assert.equal(task.status, "reported");
		// The explicit route enforces the same invariant.
		assert.throws(() => updateTask(f, { id: "W-use", status: "done", evidence: ["x"], reason: "y" }), /unfinished dependencies/);
		dep.status = "done";
		assert.equal(autoAcceptTask(f, "W-use", ["Status: complete\n$ ok\nexit code 0"], { cwd, cleanExit: true }), true);
		assert.ok(readyTasks(f).includes(successor));
	});

	test("report prose is never parsed for pass/fail: test counts are not auto-verifiable", () => {
		// Every prose summary below used to be classified; none can settle a task now, in either direction.
		for (const text of [
			`Status: complete\nfile:${artifact}\n  10 passing (2s)\n  1 failing\nexit code 0`,
			`Status: complete\nfile:${artifact}\n10 passed, 0 failed\nexit code 0`,
			`Status: complete\nfile:${artifact}\nFAILED tests/test_a.py::test_b - AssertionError\nexit code 0`,
			`Status: complete\nfile:${artifact}\neslint: 0 errors\n10 passed\nexit code 0`,
		]) assert.equal(accept(deterministicSetup(), text), true, text);
		// A test-count criterion is no longer machine-checkable, so it cannot ride the automatic route.
		for (const acceptance of [["tests passed: 10"], [`file:${artifact}`, "tests passed: 10"], ["tests 10"], ["test: 10"]]) {
			const f = deterministicSetup({ acceptance });
			assert.equal(isDeterministic(f.task), false, JSON.stringify(acceptance));
			assert.equal(accept(f), false, JSON.stringify(acceptance));
			assert.equal(f.task.status, "reported");
		}
		// Hard execution failures still refuse settlement.
		for (const text of [`Status: complete\nfile:${artifact}\nFATAL ERROR: out of memory`, `Status: complete\nfile:${artifact}\nexit code 2`]) {
			assert.equal(accept(deterministicSetup(), text), false, text);
		}
	});

	test("objective signals fail closed: directories, empty files, and non-zero exits", () => {
		// A directory satisfies size>0 on Linux but is not a delivered artifact.
		const dirShaped = join(cwd, "artifact-dir");
		mkdirSync(dirShaped, { recursive: true });
		const dirCase = deterministicSetup({ acceptance: [`file:${dirShaped}`] });
		assert.equal(accept(dirCase), false);
		assert.equal(dirCase.task.status, "reported");
		const empty = join(cwd, "empty.txt"); writeFileSync(empty, "");
		const emptyCase = deterministicSetup({ acceptance: [`artifact:${empty}`] });
		assert.equal(accept(emptyCase), false);
		// A real non-zero exit in the evidence is fatal even when no exit criterion is declared.
		for (const text of [`Status: complete\nfile:${artifact}\nnpm test exited with code 1`, `Status: complete\nfile:${artifact}\nexit status 2`, `Status: complete\nfile:${artifact}\nexit 3`]) {
			const f = deterministicSetup({ acceptance: [`file:${artifact}`] });
			assert.equal(accept(f, text), false, text);
		}
	});

	test("cleanExit must be affirmative and no non-reported state settles", () => {
		for (const cleanExit of [undefined, false]) {
			const f = deterministicSetup();
			assert.equal(autoAcceptTask(f.board, f.task.id, [report], { cwd, cleanExit }), false);
			assert.equal(f.task.status, "reported");
		}
		for (const status of ["planned", "ready", "queued", "running", "uncertain", "failed", "blocked", "reviewing", "cancelled", "superseded"] as WorkTask["status"][]) {
			const f = deterministicSetup(); f.task.status = status;
			assert.equal(accept(f), false, status);
			assert.equal(f.task.status, status);
		}
	});

	test("late stale report cannot settle or mutate a newer delivery", () => {
		const f = deterministicSetup(); const deliveryVersion = deliveryVersionOf(f.task);
		f.task.runId = "new-run"; f.task.dispatchedAt = "2026-01-02T00:00:00.000Z";
		const before = structuredClone(f.board);
		assert.equal(accept(f, report, true, { deliveryVersion }), false);
		assert.deepEqual(f.board, before);
		assert.equal(accept(f, report, true, { deliveryVersion: deliveryVersionOf(f.task) }), true);
	});

	test("review tasks and CP/parent orchestration never autoaccept", () => {
		for (const role of ["cp", "parent"]) {
			assert.equal(accept(deterministicSetup({}, role)), false);
		}
		for (const fields of [{ id: "W-rev-custom" }, { parentTaskId: "W-2" }]) {
			const f = deterministicSetup(); Object.assign(f.task, fields);
			assert.equal(isReviewExempt(f.task), false);
			assert.equal(accept(f), false);
		}
	});

	test("already-created current-delivery CP holds remain immutable", () => {
		for (const status of ["ready", "running", "blocked", "failed", "cancelled"] as WorkTask["status"][]) {
			const f = deterministicSetup(); const rev = createReviewerTask(f.board, f.task);
			rev.status = status; rev.runId = "old-review-run"; rev.sessionId = "old-review-session";
			const before = structuredClone(f.board);
			assert.equal(accept(f), false, status);
			assert.deepEqual(f.board, before, "no reviewer cancellation, rewrite or history loss");
		}
		const unbound = deterministicSetup(); const rev = createReviewerTask(unbound.board, unbound.task); delete rev.reviewedDeliveryVersion;
		assert.equal(accept(unbound), false, "legacy unbound hold remains binding");
	});

	test("a stale report from the reviewed delivery cannot settle after REWORK/INCOMPLETE", () => {
		for (const verdict of ["REWORK", "INCOMPLETE"] as const) {
			const f = deterministicSetup(); const rev = createReviewerTask(f.board, f.task);
			rev.runId = "review-run"; rev.sessionId = "review-session"; rev.status = "running";
			const reviewedDelivery = deliveryVersionOf(f.task);
			recordReview(f.board, { reviewTaskId: rev.id, workerTaskId: f.task.id, verdict, checks: [], defects: ["fix acceptance"], nextActions: ["worker must fix"], raw: `VERDICT: ${verdict}`, parsed: true, reasons: [], deliveryVersion: reviewedDelivery, reviewerRunId: rev.runId, reviewerSessionId: rev.sessionId, attemptId: rev.reviewAttemptId, createdAt: "2026-01-02T00:00:00.000Z" });
			f.task.status = "reported";
			const before = structuredClone(f.board);
			// The verdict's own delivery is fenced; a NEW attempt needs a new run identity.
			assert.equal(accept(f, report, true, { deliveryVersion: reviewedDelivery }), false, verdict);
			assert.deepEqual(f.board, before);
			assert.equal(f.task.status, "reported");
		}
	});

	test("policy/contract/ledger describe exemption as routing, not automatic completion", () => {
		const f = setup();
		for (const policy of [buildPolicy("economy", defaultConfig()), buildPolicy("strict", defaultConfig()), buildTaskContract(f.task.id, f.task), ledgerPrompt(f.board)]) {
			assert.match(policy, /Booker.*bounded local technical decisions/i);
			assert.match(policy, /CP retains global architecture, user-scope changes/i);
			assert.match(policy, /reviewTier:none/);
			assert.match(policy, /ALL[^.]*objective assertions/);
			assert.doesNotMatch(policy, /every non-deterministic code\/implementation deliverable is reviewed/);
		}
		const contract = buildTaskContract(f.task.id, f.task);
		assert.match(contract, /exempt delivery stays reported and the main CP accepts it/i);
		assert.match(contract, /WORKTREE_NOT_USED/);
		assert.doesNotMatch(contract, /git worktree remove/);
	});

	test("only file/artifact/exit criteria are machine assertions; prose and test counts are not", () => {
		for (const crit of ["test 2 endpoints manually", "verify the endpoint behaves correctly", "请验证行为正确"]) assert.equal(isMachineAssertionCrit(crit), false, crit);
		for (const crit of [`file:${artifact}`, "artifact:dist/bundle.js", "exit 0", "exit code 0"]) assert.equal(isMachineAssertionCrit(crit), true, crit);
		for (const crit of ["tests passed 10", "tests: 10", "tests 10", "test: 10"]) assert.equal(isMachineAssertionCrit(crit), false, crit);
	});

	test("invalid raw reviewTier or autoAccept inputs fail atomically", () => {
		for (const fields of [{ reviewTier: "invalid" }, { reviewTier: null }, { reviewTier: ["none"] }, { autoAccept: "false" }, { autoAccept: null }]) {
			const f = setup(); const before = structuredClone(f.board);
			assert.throws(() => addTasks(f.board, [{ id: "W-bad", title: "invalid", role: "booker", requestIds: [f.board.requests[0].id], dependsOn: [], readPaths: [], writePaths: [], acceptance: ["deliver"], ...fields }], cwd), /reviewTier|autoAccept/);
			assert.deepEqual(f.board, before);
		}
	});
	console.log(`\n${passed} role-review tests passed`);
} finally {
	rmSync(cwd, { recursive: true, force: true });
}