/**
 * CP-parent architecture pure-logic regression asset.
 * Run: node ~/.pi/agent/team-tests/test-team-cp-parent.ts
 * Uses only Node built-ins and existing team exports; no new dependencies.
 * No model calls, config/history writes, Git commands, or subagent execution.
 * It verifies structure and policy text only: it does not prove that evidence is
 * true, that tests actually passed, or that the live host loaded the profiles.
 */
import { strict as assert } from "node:assert";
import {
	applyAudit,
	applyQuotaFailure,
	buildGoalPolicy,
	buildPolicy,
	decideCall,
	defaultConfig,
	effectiveMaxCalls,
	extractEscalation,
	goalContinuePrompt,
	initialState,
	loadConfigFrom,
	mergeConfig,
	newGoal,
	normalizeRole,
	shouldContinue,
	stateFromEntries,
	validateGoalAudit,
	agentDir,
	type GoalState,
	type TeamState,
} from "../extensions/team.ts";

let pass = 0;
function test(name: string, fn: () => void): void {
	fn();
	pass += 1;
	console.log(`  ✓ ${name}`);
}

const cfg = defaultConfig();
const prices = {}; // cap checks run before budget estimation; no real prices needed.

function activeState(patch: Partial<TeamState> = {}): TeamState {
	return {
		...initialState(cfg),
		enabled: true,
		goal: newGoal("Ship the fixture feature", ["All tests pass", "README documents usage"]),
		...patch,
	};
}

function reviewedGoal(): GoalState {
	return applyAudit(newGoal("Ship the fixture feature", ["All tests pass"]), {
		verdict: "REWORK",
		summary: "Audited artifacts and command output at tmp/run.log:12.",
		nextTasks: ["Fix the failing fixture test"],
		evidence: ["tmp/run.log:12"],
	});
}

console.log("CP-parent architecture pure tests");

// ── main model policy ──────────────────────────────────────────────────────

test("main model policy defaults to preserve and no switch is claimed", () => {
	assert.equal(defaultConfig().mainModelPolicy, "preserve");
	assert.equal(initialState(defaultConfig()).modeModelApplied, false);
});

test("mergeConfig accepts only preserve|mode and keeps preserve as the fallback", () => {
	for (const value of ["preserve", "mode"] as const) {
		assert.equal(mergeConfig(defaultConfig(), { mainModelPolicy: value }).mainModelPolicy, value);
	}
	for (const value of [undefined, null, "auto", 1, true]) {
		assert.equal(mergeConfig(defaultConfig(), { mainModelPolicy: value }).mainModelPolicy, "preserve");
	}
});

test("legacy config without mainModelPolicy stays preserve", () => {
	const merged = mergeConfig(defaultConfig(), { defaultMode: "strict", roles: { cp: { maxCalls: 9 } } });
	assert.equal(merged.mainModelPolicy, "preserve");
	assert.equal(merged.defaultMode, "strict");
	assert.equal(merged.roles.cp.maxCalls, 0, "legacy caps are ignored");
});

test("committed team.json adds preserve without changing the mode models", () => {
	const local = loadConfigFrom(`${agentDir()}/team.json`);
	assert.equal(local.mainModelPolicy, "preserve");
	assert.equal(local.economyModel, "magpie/codex/gpt-6.1-sol");
	assert.equal(local.strictModel, "magpie/codex/gpt-6.1-sol");
	for (const role of ["cp", "booker", "bridges", "ayton", "cameron"] as const) {
		assert.ok(local.roles[role].model.includes("/"), `${role} model must remain a provider/model ref`);
	}
});

test("legacy sessions infer a prior model switch only when the flag is absent", () => {
	const entries = (data: Record<string, unknown>) => [{ type: "custom", customType: "team-state", data }];
	const legacy = stateFromEntries(entries({ prevModel: "fixture/model", prevThinking: "high" }), cfg).state;
	assert.equal(legacy.modeModelApplied, true, "Old sessions without the flag may still need /team off restore.");
	const explicitOff = stateFromEntries(entries({ prevModel: "fixture/model", modeModelApplied: false }), cfg).state;
	assert.equal(explicitOff.modeModelApplied, false);
	const current = stateFromEntries(entries({ prevModel: null, modeModelApplied: false }), cfg).state;
	assert.equal(current.modeModelApplied, false);
});

// ── both workload modes share CP-parent authority ──────────────────────────

test("both modes keep Head-Coach orchestration and Point-God CP sole reviewer", () => {
	for (const mode of ["economy", "strict"] as const) {
		const policy = buildPolicy(mode, cfg);
		assert.match(policy, /Head Coach \(orchestrator parent\)/);
		assert.match(policy, /dependency\/write-set DAG.*dispatch.*team_goal/s);
		assert.equal(/低成本调度层/.test(policy), false, "Economy is a legacy label, not a different authority.");
		assert.equal(/你是 CP 主导的调度与审核层/.test(policy), false, "Legacy strict-only authority wording must be gone.");
	}
});

test("the cp child is the sole default independent reviewer in read-only bwrap sandbox", () => {
	for (const mode of ["economy", "strict"] as const) {
		const policy = buildPolicy(mode, cfg);
		assert.match(policy, /SOLE default independent reviewer \(W-rev-\*\)/);
		assert.match(policy, /bwrap read-only bash/);
		assert.match(policy, /Multiple cp instances may review independent tasks in parallel/);
	}
	const goal = buildGoalPolicy(cfg);
	assert.match(goal, /Legacy cpCallsSinceAudit values are deprecated/);
	assert.match(goal, /never authorize an audit/);
	assert.match(goal, /does not stop the goal/);
});

test("Booker is directly eligible for difficult implementation and local decisions without failure thresholds", () => {
	for (const mode of ["economy", "strict"] as const) {
		const policy = buildPolicy(mode, cfg);
		assert.match(policy, /booker \(Devin Booker — Scorer\): High-difficulty\/high-risk implementation/);
		assert.match(policy, /no prerequisite failure count or module-count threshold/);
	}
	assert.match(buildPolicy("economy", cfg), /does not require bridges to fail first/);
	assert.match(buildPolicy("economy", cfg), /DELEGATION_REASON/);
	assert.match(buildPolicy("strict", cfg), /adds no marker gate/);
	assert.match(buildPolicy("strict", cfg), /economy decision gate remains economy-only/);
});

test("delegation reason aliases are accepted without weakening the length check", () => {
	const reason = "bounded local review with tests and evidence in fixture.ts:12";
	for (const marker of ["ESCALATION", "DELEGATION_REASON", "DELEGATION REASON", "升级理由", "升级证据"]) {
		assert.equal(extractEscalation(`${marker}: ${reason}`, 20), reason);
	}
	assert.equal(extractEscalation("DELEGATION_REASON: too short", 20), null);
	assert.equal(extractEscalation("no marker here", 0), null);
});

test("optional consultation aliases resolve to cp without moving parent authority", () => {
	for (const alias of ["second-opinion", "second opinion", "consultant", "cp consultant", "第二意见", "顾问"]) {
		assert.equal(normalizeRole(alias), "cp");
	}
	assert.equal(normalizeRole("general-purpose"), null);
});

// ── no numeric caps; legacy counters are not authority ─────────────────────

test("all role calls are unlimited regardless of goal and legacy limit flags", () => {
	for (const state of [initialState(cfg), activeState({ limitsOff: false }), activeState({ limitsOff: true })]) {
		for (const role of ["cp", "booker", "bridges", "ayton", "cameron"] as const) assert.equal(effectiveMaxCalls(state, cfg, role), Infinity);
	}
});

test("legacy goal/call counters neither impose a cap nor authorize an audit", () => {
	const state = activeState({ mode: "strict", limitsOff: false, cpCallsSinceAudit: 99, calls: { ...initialState(cfg).calls, cp: 1000000 } });
	const allowed = decideCall({ role: "cp", prompt: "audit", state, cfg, prices, activeCount: 1000000 });
	assert.equal(allowed.block, false);
	assert.equal(allowed.kind, undefined);
	assert.equal(/subagent_type="cp"/.test(goalContinuePrompt(state, cfg)), false);
	assert.match(buildGoalPolicy(cfg), /never authorize an audit/);
});

// ── real provider unavailability does not stop the main goal ─────────────

test("cp quota exhaustion pauses only the optional role, not the active goal", () => {
	const noFallback = mergeConfig(defaultConfig(), { fallbacks: { cp: [] } });
	const state = activeState();
	const exhausted = applyQuotaFailure(state, "cp", noFallback, "429 rate limit");
	assert.equal(exhausted.paused, true);
	assert.ok(exhausted.state.unavailable.cp);
	assert.equal(exhausted.state.goal?.status, "active");
	assert.equal(exhausted.state.goal?.stopReason, undefined);
	assert.equal(shouldContinue(exhausted.state, noFallback, 0).action, "continue");

	const withFallback = mergeConfig(defaultConfig(), { fallbacks: { cp: ["magpie/auto/gpt-6.1-sol"] } });
	const switched = applyQuotaFailure(state, "cp", withFallback, "429");
	assert.equal(switched.paused, false);
	assert.equal(switched.state.roleModel.cp, "magpie/auto/gpt-6.1-sol");
	assert.equal(switched.state.goal?.status, "active");

	const capped = { ...exhausted.state, calls: { ...exhausted.state.calls, cp: cfg.roles.cp.maxCalls } };
	assert.equal(shouldContinue(capped, noFallback, 0).action, "continue", "Legacy call counters are statistics, not a goal stop condition.");
});

// ── audit validation: structure only, any-language numbered acceptance ────

const auditGoal = newGoal("Ship feature", ["All tests pass", "README documents usage"]);
const auditBase = {
	summary: "Audited artifacts and command output at tmp/run.log:12; no completion claim beyond structure.",
	evidence: ["tmp/run.log:12"],
};

test("audit validation requires the advertised evidence/nextTasks structure", () => {
	const missingNext = validateGoalAudit(auditGoal, { ...auditBase, verdict: "REWORK" });
	assert.equal(missingNext.ok, false);
	assert.equal(missingNext.evidenceStructure, "provided");
	assert.ok(missingNext.errors.some((error) => /nextTasks/.test(error)));

	const valid = validateGoalAudit(auditGoal, { ...auditBase, verdict: "REWORK", nextTasks: ["Fix the failing test"] });
	assert.equal(valid.ok, true);
	assert.equal(valid.acceptanceStructure, "not-applicable");

	for (const verdict of ["REWORK", "REPLAN", "ESCALATE"] as const) {
		assert.equal(validateGoalAudit(auditGoal, { ...auditBase, verdict, nextTasks: ["Next action"] }).ok, true);
	}

	const missingEvidence = validateGoalAudit(auditGoal, { summary: auditBase.summary, verdict: "PASS" });
	assert.equal(missingEvidence.ok, false);
	assert.equal(missingEvidence.evidenceStructure, "missing");
	assert.ok(missingEvidence.errors.some((error) => /evidence/.test(error)));
	assert.equal(validateGoalAudit(auditGoal, { ...auditBase, verdict: "PASS" }).ok, true);

	// Malformed lists are rejected, not silently filtered, so a direct call cannot mutate state.
	const malformedEvidence = validateGoalAudit(auditGoal, { ...auditBase, verdict: "PASS", evidence: ["ok", 1] as unknown as string[] });
	assert.equal(malformedEvidence.ok, false);
	assert.ok(malformedEvidence.errors.some((error) => /非字符串/.test(error)));
	const malformedNext = validateGoalAudit(auditGoal, { ...auditBase, verdict: "REWORK", nextTasks: [null] as unknown as string[] });
	assert.equal(malformedNext.ok, false);
	const malformedAcceptance = validateGoalAudit(auditGoal, { ...auditBase, verdict: "GOAL_COMPLETE", acceptanceMet: ["All tests pass", 2] as unknown as string[] });
	assert.equal(malformedAcceptance.ok, false);
});

test("GOAL_COMPLETE rejects partial or reordered coverage and accepts numbered entries", () => {
	const partial = validateGoalAudit(auditGoal, {
		...auditBase,
		verdict: "GOAL_COMPLETE",
		acceptanceMet: ["All tests pass — tmp/run.log:12"],
	});
	assert.equal(partial.ok, false);
	assert.equal(partial.acceptanceStructure, "incomplete");
	assert.ok(partial.errors.some((error) => /未覆盖全部|missing|cover/i.test(error)));

	// Reordered wording is not a fuzzy match: no arbitrary similarity threshold.
	const reordered = validateGoalAudit(auditGoal, {
		...auditBase,
		verdict: "GOAL_COMPLETE",
		acceptanceMet: ["tests all pass — tmp/run.log:12", "README documents usage — README.md:20"],
	});
	assert.equal(reordered.ok, false, "Only a full normalized reference or an explicit ordinal may map an acceptance item.");

	// Indexed explanations work in any language; no English-only phrase matching.
	const numbered = validateGoalAudit(auditGoal, {
		...auditBase,
		verdict: "GOAL_COMPLETE",
		acceptanceMet: ["1) 全部测试通过，证据 tmp/run.log:12", "2) README 已写明用法，证据 README.md:20"],
	});
	assert.equal(numbered.ok, true);
	assert.equal(numbered.acceptanceStructure, "provided");

	const explicit = validateGoalAudit(auditGoal, {
		...auditBase,
		verdict: "GOAL_COMPLETE",
		acceptanceMet: ["All tests pass — tmp/run.log:12", "README documents usage — README.md:20"],
	});
	assert.equal(explicit.ok, true);
	assert.equal(explicit.acceptanceStructure, "provided");

	const emptyOrdinal = validateGoalAudit(auditGoal, {
		...auditBase,
		verdict: "GOAL_COMPLETE",
		acceptanceMet: ["1)", "2)"],
	});
	assert.equal(emptyOrdinal.ok, false, "An ordinal with no explanation is not acceptance evidence.");
});

test("structural validation explicitly does not verify evidence reality", () => {
	const validation = validateGoalAudit(auditGoal, { ...auditBase, verdict: "PASS" });
	assert.match(validation.note, /不验证证据真实性/);
	assert.match(validation.note, /结构/);
	assert.equal(/相似度|similarity threshold|0\.6/.test(validation.note), false);
});

test("new audits are stamped main-cp and legacy audits restore without the field", () => {
	const goal = applyAudit(newGoal("Ship feature", ["Condition A"]), {
		verdict: "REWORK",
		summary: "  evidence at fixture.ts:12  ",
		nextTasks: [" t "],
		evidence: [" e:1 "],
		acceptanceMet: [" a "],
	});
	assert.equal(goal.audits[0].auditor, "main-cp");
	assert.deepEqual(goal.audits[0].nextTasks, ["t"]);
	assert.deepEqual(goal.audits[0].evidence, ["e:1"]);
	assert.deepEqual(goal.audits[0].acceptanceMet, ["a"]);
	assert.equal(goal.audits[0].summary, "evidence at fixture.ts:12");

	const legacyAudit = {
		round: 1,
		verdict: "REWORK",
		summary: "old audit",
		nextTasks: [],
		evidence: [],
		acceptanceMet: [],
		at: "2026-01-01T00:00:00.000Z",
	};
	const legacyGoal = { ...newGoal("Ship feature", []), rounds: 1, audits: [legacyAudit] };
	const restored = stateFromEntries(
		[{ type: "custom", customType: "team-state", data: { enabled: true, goal: legacyGoal } }],
		cfg,
	).state;
	assert.equal(restored.goal?.audits[0].auditor, undefined);
	assert.equal(restored.goal?.audits[0].verdict, "REWORK");
});

test("legacy cpCallsSinceAudit is restored for bookkeeping but cannot authorize or cap audits", () => {
	const restored = stateFromEntries(
		[{ type: "custom", customType: "team-state", data: { enabled: true, cpCallsSinceAudit: 7 } }],
		cfg,
	).state;
	assert.equal(restored.cpCallsSinceAudit, 7);
	const state = { ...activeState(), mode: "strict" as const, cpCallsSinceAudit: 7 };
	const decision = decideCall({ role: "cp", prompt: "audit", state, cfg, prices, activeCount: 0 });
	assert.equal(decision.block, false, "The legacy counter must not act as a cap or an audit prerequisite.");
});

console.log(`\nCP-parent pure tests passed: ${pass}`);
