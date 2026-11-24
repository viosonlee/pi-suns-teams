/**
 * Parallel dispatch, lifecycle policy, contract, and profile regression asset.
 * Run: node ~/.pi/agent/team-tests/test-team-parallel.ts
 * Uses only Node built-ins and existing team exports; no new dependencies.
 * No model calls, Git commands, config writes, or historical session reads.
 * This does not verify native host worktree retention, live profile loading,
 * actual parallel execution, real merges, or real worktree cleanup.
 */
import { strict as assert } from "node:assert";
import {
	applyTeamDispatchDefaults,
	buildGoalPolicy,
	buildParallelWorktreePolicy,
	buildPolicy,
	buildTaskContract,
	defaultConfig,
	goalContinuePrompt,
	initialState,
	newGoal,
} from "../extensions/team.ts";

let pass = 0;
function test(name: string, fn: () => void): void {
	fn();
	pass += 1;
	console.log(`  ✓ ${name}`);
}

console.log("Parallel dispatch and worktree lifecycle regression tests");

const dispatchArgs = () => ({
	subagent_type: "bridges",
	description: "Independent authorized fixture task",
	prompt: "Change only fixture/docs.md; preserve unrelated work.",
	isolation: "worktree",
	model: "fixture/provider/explicit-model-override",
	thinking: "high",
	wait_timeout: 47,
	custom: { resources: ["fixture-port"], target: "fixture-main" },
});

test("omitted background defaults to true and changes no other arguments", () => {
	const input: Record<string, unknown> = dispatchArgs();
	const before = structuredClone(input);
	const custom = input.custom;
	assert.equal(applyTeamDispatchDefaults(input), true);
	assert.deepEqual(input, { ...before, run_in_background: true });
	assert.equal(input.custom, custom, "Nested argument identity must be preserved.");
});

test("explicit false preserves foreground resume and every other argument without adding isolation", () => {
	// A resume fixture intentionally omits isolation; the host rejects the pair.
	const input: Record<string, unknown> = { ...dispatchArgs(), resume: "22222222-2222-7222-8222-222222222222", run_in_background: false };
	delete input.isolation;
	const before = structuredClone(input);
	assert.equal(applyTeamDispatchDefaults(input), false);
	assert.equal(input.run_in_background, false);
	assert.deepEqual(input, before);
	assert.equal(Object.hasOwn(input, "isolation"), false);
});

test("explicit true is retained without another default injection", () => {
	const input = { ...dispatchArgs(), run_in_background: true };
	const before = structuredClone(input);
	assert.equal(applyTeamDispatchDefaults(input), false);
	assert.deepEqual(input, before);
});

test("undefined optional background gets the default and repeated application is idempotent", () => {
	const input: Record<string, unknown> = { ...dispatchArgs(), run_in_background: undefined };
	assert.equal(applyTeamDispatchDefaults(input), true);
	const after = structuredClone(input);
	assert.equal(applyTeamDispatchDefaults(input), false);
	assert.equal(input.run_in_background, true);
	assert.deepEqual(input, after);
});

test("present non-boolean values are not silently coerced by the default helper", () => {
	for (const value of [null, 0, "false"]) {
		const input = { ...dispatchArgs(), run_in_background: value };
		const before = structuredClone(input);
		assert.equal(applyTeamDispatchDefaults(input), false);
		assert.deepEqual(input, before);
	}
});

test("defaulting does not inject isolation, model selection, or execution limits", () => {
	for (const subagent_type of ["cp", "bridges", "booker", "ayton", "cameron"]) {
		const input: Record<string, unknown> = { subagent_type, prompt: "Read-only, trivial, or non-Git fixture task." };
		const before = structuredClone(input);
		assert.equal(applyTeamDispatchDefaults(input), true);
		assert.deepEqual(input, { ...before, run_in_background: true });
		assert.equal(Object.hasOwn(input, "isolation"), false);
		assert.equal(Object.hasOwn(input, "model"), false);
	}
});

const cfg = defaultConfig();
const parallel = buildParallelWorktreePolicy();

test("the exported parallel/worktree policy is English", () => {
	assert.ok(parallel.length > 0);
	assert.equal(/\p{Script=Han}/u.test(parallel), false);
	assert.match(parallel, /Parallel.*worktree/i);
});

test("the policy calls for meaningful DAG decomposition and every ready independent task", () => {
	for (const requirement of [
		/DAG/,
		/dependenc/i,
		/write[- ]set/i,
		/ownership/i,
		/meaningful deliverable/i,
		/ready independent task/i,
		/run_in_background: true/,
		/do not serialize work that has no real dependency/i,
		/multiple workers of the same role/i,
		/do not start all five roles by default/i,
	]) assert.match(parallel, requirement);
});

test("policy ownership covers separate files/indexes and non-isolated shared resources", () => {
	assert.match(parallel, /same shared files, git index, or branch concurrently/i);
	assert.match(parallel, /NOT.*devices.*databases.*ports/i);
	assert.match(parallel, /unique resources.*serialize/i);
	assert.match(parallel, /same-file independent.*isolated worktrees/i);
	assert.match(parallel, /dependent tasks wait/i);
});

test("worktrees are intentional, uniquely owned, base-pinned, and not mandatory for every task", () => {
	assert.match(parallel, /read-only.*trivial.*non-git/i);
	assert.match(parallel, /do not inject isolation unconditionally/i);
	assert.match(parallel, /child workers may create.*temporary worktree/i);
	assert.match(parallel, /unique-branch/);
	assert.match(parallel, /task id, path, branch, base SHA/i);
});

test("native policy records non-forced clean-tree cleanup, surviving commits, and retained dirty trees", () => {
	assert.match(parallel, /native host isolation/i);
	assert.match(parallel, /may (?:auto-)?remove a clean worktree.*before integration/i);
	assert.match(parallel, /without force/i);
	assert.match(parallel, /branch and commits survive/i);
	assert.match(parallel, /dirty\/untracked worktrees are retained with worktreeCleanupError/i);
	assert.match(parallel, /report CLEANUP_PENDING, never force-delete/i);
	assert.match(parallel, /parent-managed\/manual worktree/i);
	assert.match(parallel, /commit authorized task-owned changes.*SHAs/i);
});

test("native isolation is new-session-only and must not be combined with resume", () => {
	assert.match(parallel, /native isolation applies only to new Agent sessions, not resume/i);
	assert.match(parallel, /do not combine resume with isolation/i);
	assert.match(parallel, /resume requires the original child cwd still to exist/i);
	assert.match(parallel, /does not recreate an auto-removed worktree/i);
	assert.match(parallel, /manually owned worktrees.*retention until integration\/resume/i);
});

test("the policy verifies actual baseSHA against the agreed base", () => {
	assert.match(parallel, /verify the actual baseSHA matches the agreed base/i);
});

test("integration is serial, has one owner per repository, and respects read-only/non-Git tasks", () => {
	assert.match(parallel, /one integration owner per repository/i);
	assert.match(parallel, /CP only reviews/i);
	assert.match(parallel, /ayton.*does not merge product code/i);
	assert.match(parallel, /merge serially.*target branch\/worktree/i);
	assert.match(parallel, /run integrated regression/i);
	assert.match(parallel, /authorized writing tasks in Git/i);
	assert.match(parallel, /read-only roles do not edit\/commit\/merge product code/i);
	assert.match(parallel, /non-git tasks require no commits/i);
});

test("children hand off branch/SHAs promptly instead of waiting for parent integration", () => {
	assert.match(parallel, /return IMPLEMENTATION_READY \/ INTEGRATION_PENDING promptly with branch\/commit SHAs/i);
	assert.match(parallel, /children must not wait for parent integration before reporting/i);
});

test("cleanup is a positive delivery duty after verified integration, with absence checks", () => {
	assert.match(parallel, /after verified integration and evidence preservation.*integration owner promptly/i);
	assert.match(parallel, /task branch is merged into the designated target.*task-owned worktree is clean/i);
	assert.match(parallel, /removes it with `git worktree remove`/);
	assert.match(parallel, /deletes only the merged task-owned branch with `git branch -d`/);
	assert.match(parallel, /verifies absence via worktree\/branch listings/i);
	assert.match(parallel, /if native cleanup already removed the tree, verify absence and still clean the merged task branch/i);
	assert.match(parallel, /cleanup is part of delivery, not a later optional chore/i);
	assert.equal(/`git (?:worktree remove|branch)\b[^`]*(?:--force\b|\s-(?:f|D)\b)/.test(parallel), false);
});

test("policy preserves dirty user data and refuses force or automatic merge/delete", () => {
	assert.match(parallel, /commit only task-owned paths/i);
	assert.match(parallel, /never `git add \.`/);
	assert.match(parallel, /preserve unrelated dirty files/i);
	assert.match(parallel, /user-owned.*unmerged\/uncommitted/i);
	assert.match(parallel, /never force cleanup/i);
	assert.match(parallel, /no automatic git merge or delete/i);
	assert.match(parallel, /never automatically resume or redo/i);
});

test("unresolved integration/cleanup statuses cannot masquerade as completion", () => {
	assert.match(parallel, /INTEGRATION_PENDING/);
	assert.match(parallel, /CLEANUP_PENDING/);
	assert.match(parallel, /never claim complete\/GOAL_COMPLETE.*pending/i);
});

for (const mode of ["economy", "strict"] as const) {
	test(`${mode} includes the complete exported parallel/worktree policy`, () => {
		const before = structuredClone(cfg);
		const policy = buildPolicy(mode, cfg);
		assert.ok(policy.includes(parallel));
		assert.match(policy, /English/);
		assert.match(policy, /user-facing reply language is not restricted/i);
		assert.deepEqual(cfg, before, "Policy construction must not change configuration or model overrides.");
	});
}

test("goal mode includes the complete parallel/worktree policy", () => {
	assert.ok(buildGoalPolicy(cfg).includes(parallel));
	assert.match(buildGoalPolicy(cfg), /English/);
	assert.match(buildGoalPolicy(cfg), /user-facing reply language is not restricted/i);
});

test("continuation includes the policy and retains its goal, acceptance, and next tasks", () => {
	const state = { ...initialState(cfg), enabled: true, goal: newGoal("Integrate independent fixture changes", ["Final target regression and owned cleanup evidence"]) };
	state.goal.nextTasks = ["Integrate fixture task commits", "Verify final target HEAD"];
	const before = structuredClone(state);
	const prompt = goalContinuePrompt(state, cfg);
	assert.ok(prompt.includes(parallel));
	assert.ok(prompt.includes(state.goal.objective));
	assert.ok(prompt.includes(state.goal.acceptance[0]));
	for (const nextTask of state.goal.nextTasks) assert.ok(prompt.includes(nextTask));
	assert.match(prompt, /English/);
	assert.match(prompt, /user-facing reply language is not restricted/i);
	assert.deepEqual(state, before);
});

test("no-goal continuation remains empty", () => {
	assert.equal(goalContinuePrompt(initialState(cfg), cfg), "");
});

const contract = buildTaskContract("T-parallel-fixture");

test("the English contract retains its task identifier and original evidence/report fields", () => {
	assert.match(contract, /TEAM CONTRACT T-parallel-fixture/);
	assert.equal(/\p{Script=Han}/u.test(contract), false);
	for (const requirement of [
		/task goal and scope/i,
		/actual changes.*file:line/i,
		/evidence.*command output or file:line/i,
		/test results/i,
		/unresolved issues and risks/i,
		/lead decision/i,
		/write the report in English/i,
		/conclusions without evidence are invalid/i,
	]) assert.match(contract, requirement);
});

test("the contract reports dependencies, ownership, isolated worktree/base/target, and commits", () => {
	for (const requirement of [
		/dependencies/i,
		/owned paths/i,
		/shared resources/i,
		/WORKTREE_NOT_USED/,
		/worktree path, branch/i,
		/baseSHA.*base commit SHA/i,
		/target path and target branch/i,
		/task-owned commit SHA/i,
		/integration owner and integration status/i,
		/cleanup status/i,
	]) assert.match(contract, requirement);
});

test("the contract limits commit duties to authorized Git writes and requires integrated regression", () => {
	assert.match(contract, /for authorized writing tasks in Git, commit only your task-owned paths/i);
	assert.match(contract, /read-only roles must not edit or commit product code/i);
	assert.match(contract, /non-git tasks do not need commits/i);
	assert.match(contract, /test on your own branch first/i);
	assert.match(contract, /single integration owner/i);
	assert.match(contract, /integration serially.*target branch\/worktree/i);
	assert.match(contract, /integrated regression evidence/i);
	assert.match(contract, /never `git add \.`/);
});

test("the contract requires prompt IMPLEMENTATION_READY/INTEGRATION_PENDING handoff, not a waiting child", () => {
	assert.match(contract, /hand the branch and commit SHAs promptly to the single integration owner/i);
	assert.match(contract, /do not keep the child waiting for parent integration/i);
	assert.match(contract, /return IMPLEMENTATION_READY \/ INTEGRATION_PENDING/i);
});

test("the contract requires timely non-forced owned cleanup and verifies native-already-removed trees", () => {
	assert.match(contract, /after verified integration and evidence preservation.*integration owner must promptly remove/i);
	assert.match(contract, /clean task-owned temporary worktree with `git worktree remove`/);
	assert.match(contract, /merged task-owned branch with `git branch -d`, then verify absence/);
	assert.match(contract, /if native cleanup already removed the worktree, verify that and clean only the merged task-owned branch/i);
	assert.equal(/`git (?:worktree remove|branch)\b[^`]*(?:--force\b|\s-(?:f|D)\b)/.test(contract), false);
});

test("the contract includes pending statuses, safe cleanup, and failure recovery without pretending done", () => {
	assert.match(contract, /INTEGRATION_PENDING/);
	assert.match(contract, /CLEANUP_PENDING/);
	assert.match(contract, /never claim complete\/GOAL_COMPLETE.*pending/i);
	assert.match(contract, /dirty target, conflicts, or unsafe cleanup/i);
	assert.match(contract, /user-owned.*unmerged\/uncommitted/i);
	assert.match(contract, /never force cleanup/i);
	assert.match(contract, /abort\/failure.*commits and recovery information/i);
	assert.match(contract, /do not automatically resume or redo/i);
});

// Test-owned inputs are serialized independently from the immutable header goldens below.
// They never read user-owned agent profiles.
interface ProfileFixtureInput {
	role: string;
	description: string;
	display_name: string;
	tools: string;
	model: string;
	thinking: string;
}

const profileInputs: ProfileFixtureInput[] = [
	{ role: "cp", description: "技术主管：主会话负责全局分析、决策、DAG/调度与最终审核；可选 CP 子会话仅作第二意见（只决策，不写码）", display_name: "Chris Paul", tools: "read, grep, find, ls", model: "fixture/provider/cp", thinking: "max" },
	{ role: "bridges", description: "常规开发执行者：明确的功能实现、Bug 修复、批量修改、简单问题调查（默认承担大多数改码）", display_name: "Mikal Bridges", tools: "read, bash, edit, write, grep, find, ls", model: "fixture/provider/bridges", thinking: "high" },
	{ role: "booker", description: "高级执行者：复杂实现与困难问题攻坚；可直接承担复杂执行，也可按简报做有界本地分析与复核（无强制失败次数/模块数门槛）", display_name: "Devin Booker", tools: "read, bash, edit, write, grep, find, ls", model: "fixture/provider/booker", thinking: "high" },
	{ role: "ayton", description: "测试执行者：自动化测试、单测/集成/回归、LogicQA/UIQA、Bug 复现与证据记录（无写码权限）", display_name: "Deandre Ayton", tools: "read, bash, grep, find, ls", model: "fixture/provider/ayton", thinking: "high" },
	{ role: "cameron", description: "文档与测试资产协调者：文档更新、测试清单、JSONL 记录、交付材料、一致性核对", display_name: "Cameron Johnson", tools: "read, bash, edit, write, grep, find, ls", model: "fixture/provider/cameron", thinking: "high" },
];

const PROFILE_HEADER_GOLDENS: Record<string, string> = {
	cp: "---\ndescription: 技术主管：主会话负责全局分析、决策、DAG/调度与最终审核；可选 CP 子会话仅作第二意见（只决策，不写码）\ndisplay_name: Chris Paul\ntools: read, grep, find, ls\nload_skills: false\nload_extensions: true\ncodemode: 'off'\nmcp: 'off'\nenabled: true\ninherit_context: false\nrun_in_background: false\nprompt_mode: append\nskills: false\nextensions: true\nmodel: fixture/provider/cp\nthinking: max\n---\n",
	bridges: "---\ndescription: 常规开发执行者：明确的功能实现、Bug 修复、批量修改、简单问题调查（默认承担大多数改码）\ndisplay_name: Mikal Bridges\ntools: read, bash, edit, write, grep, find, ls\nload_skills: false\nload_extensions: true\ncodemode: 'off'\nmcp: 'off'\nenabled: true\ninherit_context: false\nrun_in_background: false\nprompt_mode: append\nskills: false\nextensions: true\nmodel: fixture/provider/bridges\nthinking: high\n---\n",
	booker: "---\ndescription: 高级执行者：复杂实现与困难问题攻坚；可直接承担复杂执行，也可按简报做有界本地分析与复核（无强制失败次数/模块数门槛）\ndisplay_name: Devin Booker\ntools: read, bash, edit, write, grep, find, ls\nload_skills: false\nload_extensions: true\ncodemode: 'off'\nmcp: 'off'\nenabled: true\ninherit_context: false\nrun_in_background: false\nprompt_mode: append\nskills: false\nextensions: true\nmodel: fixture/provider/booker\nthinking: high\n---\n",
	ayton: "---\ndescription: 测试执行者：自动化测试、单测/集成/回归、LogicQA/UIQA、Bug 复现与证据记录（无写码权限）\ndisplay_name: Deandre Ayton\ntools: read, bash, grep, find, ls\nload_skills: false\nload_extensions: true\ncodemode: 'off'\nmcp: 'off'\nenabled: true\ninherit_context: false\nrun_in_background: false\nprompt_mode: append\nskills: false\nextensions: true\nmodel: fixture/provider/ayton\nthinking: high\n---\n",
	cameron: "---\ndescription: 文档与测试资产协调者：文档更新、测试清单、JSONL 记录、交付材料、一致性核对\ndisplay_name: Cameron Johnson\ntools: read, bash, edit, write, grep, find, ls\nload_skills: false\nload_extensions: true\ncodemode: 'off'\nmcp: 'off'\nenabled: true\ninherit_context: false\nrun_in_background: false\nprompt_mode: append\nskills: false\nextensions: true\nmodel: fixture/provider/cameron\nthinking: high\n---\n",
};

function headerFromInput(profile: ProfileFixtureInput): string {
	return [
		"---",
		`description: ${profile.description}`,
		`display_name: ${profile.display_name}`,
		`tools: ${profile.tools}`,
		"load_skills: false",
		"load_extensions: true",
		"codemode: 'off'",
		"mcp: 'off'",
		"enabled: true",
		"inherit_context: false",
		"run_in_background: false",
		"prompt_mode: append",
		"skills: false",
		"extensions: true",
		`model: ${profile.model}`,
		`thinking: ${profile.thinking}`,
		"---",
		"",
	].join("\n");
}

const PROFILE_BODY_INPUTS: Record<string, string> = {
	cp: "Optional independent second opinion/consultant; never required per round. Do not claim global responsibility, final authority, or veto. The 400-character cap applies to this consult reply only, not to the parent's global DAG or planning. No `bash` or Git execution tool; do not create worktrees, commit, merge, or remove them yourself. Children must never dispatch `Agent`; orchestration stays with the parent.\n",
	bridges: "Fixture role introduction.\n",
	booker: "Analysis/review mode and Implementation mode. Complex execution with bounded local analysis; no prerequisite failed-attempt count and no module-count threshold. Use a fresh reviewer that is not the implementer. Review-by-instruction is not a hard read-only guarantee. Global decisions, scheduling, DAG ownership stay with the main-session CP parent.\n",
	ayton: "Under explicit task scope, Git metadata commands and a test-only worktree; owned clean test-only worktree does not authorize product edits, product commits or merges, bypass existing write bans. Collect regression evidence after all merges, not only workers' isolated trees.\n",
	cameron: "Request regression evidence from Ayton at the final integrated target HEAD rather than rerunning an already completed test yourself. Mark unsupported claims `NOT VERIFIED`.\n",
};

// Golden expectations are separate constants from fixture input and assertion helpers.
const PROFILE_BODY_GOLDENS: Record<string, string> = {
	cp: "Optional independent second opinion/consultant; never required per round. Do not claim global responsibility, final authority, or veto. The 400-character cap applies to this consult reply only, not to the parent's global DAG or planning. No `bash` or Git execution tool; do not create worktrees, commit, merge, or remove them yourself. Children must never dispatch `Agent`; orchestration stays with the parent.\n",
	bridges: "Fixture role introduction.\n",
	booker: "Analysis/review mode and Implementation mode. Complex execution with bounded local analysis; no prerequisite failed-attempt count and no module-count threshold. Use a fresh reviewer that is not the implementer. Review-by-instruction is not a hard read-only guarantee. Global decisions, scheduling, DAG ownership stay with the main-session CP parent.\n",
	ayton: "Under explicit task scope, Git metadata commands and a test-only worktree; owned clean test-only worktree does not authorize product edits, product commits or merges, bypass existing write bans. Collect regression evidence after all merges, not only workers' isolated trees.\n",
	cameron: "Request regression evidence from Ayton at the final integrated target HEAD rather than rerunning an already completed test yourself. Mark unsupported claims `NOT VERIFIED`.\n",
};

function assertGoldenHeader(source: string, expected: string): void {
	assert.equal(profileParts(source).header, expected);
}

function assertGoldenBody(source: string, expected: string): void {
	assert.equal(profileParts(source).body.split("## Parallel execution and worktree lifecycle")[0], expected);
}


// These headers contain only flat scalar entries. This narrow structural parser,
// plus the byte snapshot, guards their existing format; it is not the host loader.
function profileParts(source: string) {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
	assert.ok(match, "Expected the existing delimited profile frontmatter.");
	const fields: Record<string, string | boolean> = {};
	for (const line of match[1].split("\n")) {
		const entry = /^([a-z_]+): (.+)$/.exec(line);
		assert.ok(entry, `Unexpected non-scalar frontmatter line: ${line}`);
		const [, key, raw] = entry;
		assert.equal(Object.hasOwn(fields, key), false, `Duplicate frontmatter key: ${key}`);
		fields[key] = raw === "true" ? true : raw === "false" ? false : /^'[^']*'$/.test(raw) ? raw.slice(1, -1) : raw;
	}
	return { header: match[0], fields, body: source.slice(match[0].length) };
}

const profileSources = new Map<string, string>();
const LEGACY_DESCRIPTIONS: Record<string, string> = {
	cp: "技术主管：复杂需求分析、架构决策、任务拆分、最终审核（只决策，不写码）",
	booker: "高级执行者：复杂实现、跨模块修改、困难问题攻坚（仅在普通执行失败后升级启用）",
};

function assertPinnedHeader(source: string, expected: string): void {
	assert.equal(profileParts(source).header, expected);
}

function assertPinnedRoleBody(source: string, expected: string): void {
	assert.equal(profileParts(source).body.split("## Parallel execution and worktree lifecycle")[0], expected);
}

for (const profile of profileInputs) {
	const source = `${headerFromInput(profile)}${PROFILE_BODY_INPUTS[profile.role]}## Parallel execution and worktree lifecycle\n${parallel}`;
	profileSources.set(profile.role, source);
	test(`${profile.role} fixture header matches its independent golden`, () => {
		assertPinnedHeader(source, PROFILE_HEADER_GOLDENS[profile.role]);
		const { fields } = profileParts(source);
		const expected = profileParts(PROFILE_HEADER_GOLDENS[profile.role]).fields;
		assert.deepEqual(fields, expected);
		assert.equal(fields.run_in_background, false, "Profile metadata is not the parent dispatch default.");
		assert.equal(fields.inherit_context, false);
		assert.equal(fields.codemode, "off");
		assert.equal(fields.mcp, "off");
		assert.equal(fields.enabled, true);
		assert.equal(fields.load_extensions, true);
		if (profile.role in LEGACY_DESCRIPTIONS) {
			assert.notEqual(fields.description, LEGACY_DESCRIPTIONS[profile.role]);
			assert.match(String(fields.description), profile.role === "cp"
				? /主会话.*全局分析.*决策.*DAG.*调度.*最终审核.*第二意见/
				: /复杂执行.*有界本地分析.*无强制失败次数/);
		}
	});

	test(`${profile.role} fixture uses the exported English lifecycle policy`, () => {
		const { body } = profileParts(source);
		const heading = "## Parallel execution and worktree lifecycle";
		assert.equal(body.split(heading).length, 2, "Exactly one appended lifecycle block is required.");
		const block = body.slice(body.indexOf(heading));
		assert.equal(block, `${heading}\n${parallel}`);
		assert.equal(/\p{Script=Han}/u.test(block), false);
	});

	test(`${profile.role} role text matches its independent golden`, () => {
		assertPinnedRoleBody(source, PROFILE_BODY_GOLDENS[profile.role]);
	});
}

test("negative header fixtures reject forbidden field changes and malformed headers", () => {
	const cp = profileInputs.find(profile => profile.role === "cp")!;
	const booker = profileInputs.find(profile => profile.role === "booker")!;
	for (const profile of [cp, booker]) {
		assert.doesNotThrow(() => assertPinnedHeader(headerFromInput(profile), PROFILE_HEADER_GOLDENS[profile.role]));
	}
	const mutatedFixtures = [
		{ profile: cp, source: headerFromInput({ ...cp, model: "fixture/provider/forbidden-model" }) },
		{ profile: booker, source: headerFromInput({ ...booker, thinking: "off" }) },
		{ profile: cp, source: headerFromInput({ ...cp, tools: "read, bash" }) },
		{ profile: booker, source: headerFromInput(booker).replace("---\n", "--- broken\n") },
	];
	for (const fixture of mutatedFixtures) {
		assert.throws(() => assertPinnedHeader(fixture.source, PROFILE_HEADER_GOLDENS[fixture.profile.role]));
	}
});

test("negative policy fixture mutation is rejected by its independent golden", () => {
	const source = profileSources.get("booker")!;
	const changedExpectation = PROFILE_BODY_GOLDENS.booker.replace("Implementation mode", "Different mode");
	assert.throws(() => assertPinnedRoleBody(source, changedExpectation));
});

test("CP remains read-only without bash/Git execution", () => {
	const { fields } = profileParts(profileSources.get("cp")!);
	const body = PROFILE_BODY_GOLDENS.cp;
	assert.deepEqual(String(fields.tools).split(", "), ["read", "grep", "find", "ls"]);
	assert.match(body, /no `bash` or Git execution tool/i);
	assert.match(body, /do not create worktrees, commit, merge, or remove them yourself/i);
	assert.match(body, /children must never dispatch `Agent`; orchestration stays with the parent/i);
});

test("Ayton's explicit test-only Git exception does not grant product writes, commits, or merges", () => {
	const { fields } = profileParts(profileSources.get("ayton")!);
	const body = PROFILE_BODY_GOLDENS.ayton;
	assert.deepEqual(String(fields.tools).split(", "), ["read", "bash", "grep", "find", "ls"]);
	assert.match(body, /under explicit task scope.*Git metadata commands/i);
	assert.match(body, /test-only worktree/i);
	assert.match(body, /owned clean test-only worktree/i);
	assert.match(body, /does not authorize product edits, product commits or merges/i);
	assert.match(body, /bypass existing write bans/i);
	assert.match(body, /after all merges, not only workers' isolated trees/i);
});

test("Cameron requests Ayton's final-target evidence rather than duplicating completed tests", () => {
	const body = PROFILE_BODY_GOLDENS.cameron;
	assert.match(body, /regression evidence from Ayton at the final integrated target HEAD/i);
	assert.match(body, /rather than.*rerunning an already completed test yourself/i);
	assert.match(body, /mark unsupported claims `NOT VERIFIED`/i);
});

console.log(`\nParallel/profile tests passed: ${pass}`);
