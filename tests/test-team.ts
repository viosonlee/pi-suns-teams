/**
 * 纯逻辑单测：不启动 Pi，不花任何模型费用。
 * 运行：node ~/.pi/agent/team-tests/test-team.ts
 */
import { strict as assert } from "node:assert";
import {
	agentDir,
	buildPolicy,
	decideCall,
	defaultConfig,
	estimateCallUSD,
	extractEscalation,
	formatUSD,
	goalContinuePrompt,
	newGoal,
	applyAudit,
	shouldContinue,
	buildGoalPolicy,
	isQuotaError,
	classifyAgentFailure,
	INTERRUPTED_NOTE,
	buildTaskContract,
	enforceBashTimeout,
	enforceWaitTimeout,
	handleQuotaFailure,
	applyQuotaFailure,
	effectiveMaxCalls,
	effectiveBudgetUSD,
	initialState,
	loadConfigFrom,
	loadPrices,
	mergeConfig,
	stateFromEntries,
	normalizeRole,
	priceFor,
	splitModelRef,
	type TeamState,
} from "../extensions/team.ts";

let pass = 0;
function test(name: string, fn: () => void): void {
	fn();
	pass += 1;
	console.log(`  ✓ ${name}`);
}

const cfg = defaultConfig();
const prices = loadPrices(`${agentDir()}/models.json`);
const baseState: TeamState = initialState(cfg);

console.log("纯逻辑测试");

test("模型引用按第一个 / 拆分（id 自身可含 /）", () => {
	assert.deepEqual(splitModelRef("magpie/codex/gpt-6.1-terra"), { provider: "magpie", id: "codex/gpt-6.1-terra" });
	assert.deepEqual(splitModelRef("codex/gpt-6.1-sol"), { provider: "codex", id: "gpt-6.1-sol" });
	assert.equal(splitModelRef("no-slash"), null);
});

test("角色模型单价按 models.json 配置读取；未定价模型显式跳过", () => {
	let pricedRoles = 0;
	for (const role of ["cp", "booker", "bridges", "ayton", "cameron"] as const) {
		const model = cfg.roles[role].model;
		const price = priceFor(prices, model);
		if (!price) {
			console.log(`  SKIP ${role}: ${model} 在 models.json 中没有单价`);
			continue;
		}
		pricedRoles += 1;
		assert.deepEqual(price, prices[model], `${role} 单价应来自其 models.json 模型条目`);
		assert.ok(Number.isFinite(price.input) && Number.isFinite(price.output), `${role} 单价必须是有限数字`);
	}
	console.log(`  ${pricedRoles} 个角色模型有单价`);
});

test("pricing fixture deterministically covers priced and unpriced estimation/reservation", () => {
	const pricedCfg = {
		...cfg,
		estimate: { inputTokens: 15_000, outputTokens: 3_000 },
		roles: { ...cfg.roles, cp: { ...cfg.roles.cp, model: "fixture/priced" } },
	};
	const unpricedCfg = {
		...pricedCfg,
		roles: { ...pricedCfg.roles, cp: { ...pricedCfg.roles.cp, model: "fixture/unpriced" } },
	};
	const fixturePrices = { "fixture/priced": { input: 2, output: 10 } };
	const pricedEstimate = estimateCallUSD("cp", pricedCfg, fixturePrices);
	const unpricedEstimate = estimateCallUSD("cp", unpricedCfg, fixturePrices);
	assert.equal(pricedEstimate, 0.06);
	assert.equal(unpricedEstimate, 0);

	const pricedDecision = decideCall({ role: "cp", prompt: "fixture reservation", state: initialState(pricedCfg), cfg: pricedCfg, prices: fixturePrices, activeCount: 0 });
	const unpricedDecision = decideCall({ role: "cp", prompt: "fixture reservation", state: initialState(unpricedCfg), cfg: unpricedCfg, prices: fixturePrices, activeCount: 0 });
	assert.equal(pricedDecision.reserveUSD, 0.06);
	assert.equal(unpricedDecision.reserveUSD, 0);
});


test("角色别名归一到五个档案名", () => {
	assert.equal(normalizeRole("Chris Paul"), "cp");
	assert.equal(normalizeRole("devin-booker"), "booker");
	assert.equal(normalizeRole("Cameron Johnson"), "cameron");
	assert.equal(normalizeRole("general-purpose"), null);
});

test("ESCALATION 证据长度校验", () => {
	assert.equal(extractEscalation("ESCALATION: 太短", 40), null);
	assert.equal(extractEscalation("前文\nESCALATION: bridges 两次失败，测试输出 ENOENT /a/b.ts:12 且 npm test 退出码 1", 40)?.length !== undefined, true);
	assert.equal(extractEscalation("升级理由：跨 3 个模块，接口字段冲突，无法局部修复，需要架构决策", 20)?.startsWith("跨 3 个模块"), true);
});

test("统一质量模式：调用 CP/Booker 不再受证据门槛或经济性审批拦截", () => {
	const d = decideCall({ role: "cp", prompt: "帮我看看这段代码", state: baseState, cfg, prices, activeCount: 0 });
	assert.equal(d.block, false);
	const ok = decideCall({
		role: "cp",
		prompt: "ESCALATION: bridges 两次失败，npm test 输出 3 个失败用例，涉及认证模块接口冲突",
		state: baseState,
		cfg,
		prices,
		activeCount: 0,
	});
	assert.equal(ok.block, false);
});

test("所有角色均不受证据门槛拦截", () => {
	const d = decideCall({ role: "bridges", prompt: "修一下按钮文案", state: baseState, cfg, prices, activeCount: 0 });
	assert.equal(d.block, false);
	assert.equal(d.reserveUSD, estimateCallUSD("bridges", cfg, prices));
});

test("调用次数不再形成上限，即使旧配置为 1 且旧状态 limitsOff=false", () => {
	const legacy = { ...cfg, roles: { ...cfg.roles, cp: { ...cfg.roles.cp, maxCalls: 1 } } };
	const state = { ...baseState, limitsOff: false, calls: { ...baseState.calls, cp: 1000000 } };
	const d = decideCall({ role: "cp", prompt: "DELEGATION_REASON: Need bounded technical review of verified test evidence and interface contracts.", state, cfg: legacy, prices, activeCount: 0 });
	assert.equal(d.block, false);
	assert.equal(effectiveMaxCalls(state, legacy, "cp"), Infinity);
});

test("并发不再形成上限，即使传入正数旧配置", () => {
	const d = decideCall({ role: "bridges", prompt: "x", state: { ...baseState, limitsOff: false }, cfg: { ...cfg, maxConcurrent: 1 }, prices, activeCount: 1000000 });
	assert.equal(d.block, false);
});

test("费用预留与已花金额只作统计，不触发会话预算拦截", () => {
	const state = { ...baseState, limitsOff: false, budgetOverrideUSD: 0.001, spendUSD: 1000000, reservedUSD: 1000000 };
	const d = decideCall({ role: "bridges", prompt: "x", state, cfg: { ...cfg, sessionBudgetUSD: 0.001 }, prices, activeCount: 0 });
	assert.equal(d.block, false);
	assert.equal(d.reserveUSD, estimateCallUSD("bridges", cfg, prices), "费用预留应等于可用的模型单价估算");
});

test("连续失败不再熔断，不依赖 limits off 或阈值为 0", () => {
	const state = { ...baseState, limitsOff: false, failures: { ...baseState.failures, booker: 1000000 } };
	const d = decideCall({ role: "booker", prompt: "DELEGATION_REASON: Need a bounded difficult implementation review based on verified test evidence.", state, cfg: { ...cfg, maxAutoRetries: 1 }, prices, activeCount: 100 });
	assert.equal(d.block, false);
});

test("严格模式无需理由且不再限制 CP 调用次数", () => {
	const state = { ...baseState, mode: "strict" as const, limitsOff: false, calls: { ...baseState.calls, cp: 1000000 } };
	const d = decideCall({ role: "cp", prompt: "规划这次重构", state, cfg: { ...cfg, roles: { ...cfg.roles, cp: { ...cfg.roles.cp, maxCalls: 1 } } }, prices, activeCount: 1000000 });
	assert.equal(d.block, false);
});

test("配置合并会忽略非法值并保留默认", () => {
	const merged = mergeConfig(defaultConfig(), { maxConcurrent: 0, sessionBudgetUSD: -1, defaultMode: "weird", roles: { cp: { maxCalls: 9 } } });
	assert.equal(merged.maxConcurrent, defaultConfig().maxConcurrent);
	assert.equal(merged.sessionBudgetUSD, defaultConfig().sessionBudgetUSD);
	assert.equal(merged.defaultMode, "standard");
	assert.equal(merged.roles.cp.maxCalls, 0, "旧次数字段不再生效");
});

test("本地 team.json 可读且包含五个角色", () => {
	const local = loadConfigFrom(`${agentDir()}/team.json`);
	for (const role of ["cp", "booker", "bridges", "ayton", "cameron"] as const) {
		assert.ok(local.roles[role].model.includes("/"), `${role} 缺少模型`);
	}
	assert.equal(local.defaultMode, "standard");
});

test("两种模式的政策文本都点明角色与成本纪律", () => {
	const economy = buildPolicy("economy", cfg);
	const strict = buildPolicy("strict", cfg);
	for (const role of ["bridges", "ayton", "cameron", "booker", "cp"]) {
		assert.ok(economy.includes(role), `economy 政策缺少 ${role}`);
	}
	assert.match(economy, /ESCALATION/);
	assert.match(strict, /resume/);
});

test("重启/重开会话后从 entry 恢复状态与任务记录", () => {
	const entries = [
		{ type: "custom", customType: "team-state", data: { enabled: true, mode: "strict", prevModel: "magpie/codex/gpt-6.1-sol", prevThinking: "high", calls: { cp: 1, booker: 2 }, failures: { booker: 1 }, spendUSD: 0.42, reservedUSD: 0, tasks: 3, startedAt: "2026-11-09T00:00:00.000Z" } },
		{ type: "custom", customType: "team-run", data: { taskId: "T-1", role: "bridges", description: "x", status: "ok", at: "2026-11-09T00:01:00.000Z" } },
		{ type: "message", message: { role: "assistant", content: [] } },
	];
	const restored = stateFromEntries(entries, cfg);
	assert.equal(restored.state.enabled, true);
	assert.equal(restored.state.mode, "strict");
	assert.equal(restored.state.calls.cp, 1);
	assert.equal(restored.state.calls.booker, 2);
	assert.equal(restored.state.calls.ayton, 0, "缺失角色应回落到 0");
	assert.equal(restored.state.failures.booker, 1);
	assert.equal(restored.state.spendUSD, 0.42);
	assert.equal(restored.runs.length, 1);
	assert.equal(restored.runs[0].taskId, "T-1");
});

test("空/损坏 entry 不会破坏默认状态", () => {
	const restored = stateFromEntries([], cfg);
	assert.equal(restored.state.enabled, false);
	assert.deepEqual(restored.state.calls, { cp: 0, booker: 0, bridges: 0, ayton: 0, cameron: 0 });
	assert.deepEqual(stateFromEntries(null, cfg).runs, []);
});

test("金额展示不会把小预算显示成 0.00", () => {
	assert.equal(formatUSD(0.001), "0.001");
	assert.equal(formatUSD(3), "3.00");
	assert.equal(formatUSD(0.009), "0.009");
});

test("目标循环：审核结论推进轮次与状态", () => {
	const g0 = newGoal("实现 slugify 并补测试与文档", ["npm test 通过", "README 说明用法"]);
	assert.equal(g0.status, "active");
	assert.equal(g0.rounds, 0);

	const g1 = applyAudit(g0, { verdict: "REWORK", summary: "截断边界用例失败", nextTasks: ["修复按单词截断", "补边界测试"] });
	assert.equal(g1.status, "active");
	assert.equal(g1.rounds, 1);
	assert.deepEqual(g1.nextTasks, ["修复按单词截断", "补边界测试"]);
	assert.equal(g1.audits.length, 1);

	const g2 = applyAudit(g1, { verdict: "GOAL_COMPLETE", summary: "全部验收条件有证据", acceptanceMet: ["npm test 通过", "README 说明用法"] });
	assert.equal(g2.status, "complete");
	assert.equal(g2.rounds, 2);
	assert.match(g2.stopReason ?? "", /GOAL_COMPLETE/);

	const blocked = applyAudit(g0, { verdict: "BLOCKED", summary: "缺少硬件授权" });
	assert.equal(blocked.status, "blocked");
});

test("目标循环：移除预算、轮次、无进展和无审核续跑计数停止条件", () => {
	const legacy = { ...cfg, sessionBudgetUSD: 1, goalMaxRounds: 6, goalMaxStalls: 2 };
	const withGoal = (patch: Partial<TeamState> = {}): TeamState => ({ ...initialState(cfg), enabled: true, goal: newGoal("x", []), ...patch });
	assert.equal(shouldContinue(initialState(cfg), legacy, 0).action, "none");
	assert.equal(shouldContinue(withGoal(), legacy, 0).action, "continue");
	assert.equal(shouldContinue(withGoal(), legacy, 100).action, "none", "仍应等待真实运行中的子会话，而非重复派发");
	const oldCounters = withGoal({ limitsOff: false, budgetOverrideUSD: 1, spendUSD: 1000000, reservedUSD: 1000000, continuationsSinceAudit: 1000000 });
	oldCounters.goal = { ...oldCounters.goal!, rounds: 1000000, stalls: 1000000 };
	assert.equal(shouldContinue(oldCounters, legacy, 0).action, "continue");
	for (const status of ["complete", "blocked", "stopped", "failed", "budget"] as const) {
		const terminal = withGoal();
		terminal.goal = { ...terminal.goal!, status };
		assert.equal(shouldContinue(terminal, legacy, 0).action, "none", `不得擅自复活显式/旧终态 ${status}`);
	}
});

test("目标循环：续跑提示含目标、验收、轮次与 team_goal 要求", () => {
	const state = { ...initialState(cfg), enabled: true, goal: applyAudit(newGoal("目标 A", ["条件 1"]), { verdict: "REWORK", summary: "不合格", nextTasks: ["任务 B"] }) };
	const prompt = goalContinuePrompt(state, cfg);
	assert.match(prompt, /目标 A/);
	assert.match(prompt, /条件 1/);
	assert.match(prompt, /任务 B/);
	assert.match(prompt, /team_goal/);
	assert.match(prompt, /当前轮次：1（无轮数上限）/);
	assert.match(buildGoalPolicy(cfg), /GOAL_COMPLETE/);
});

test("目标状态可跨重启恢复", () => {
	const state = { ...initialState(cfg), enabled: true, goal: applyAudit(newGoal("目标 B", ["a"]), { verdict: "REWORK", summary: "返工", nextTasks: ["修 x"] }), cpCallsSinceAudit: 1, continuationsSinceAudit: 1 };
	const restored = stateFromEntries([{ type: "custom", customType: "team-state", data: state }], cfg).state;
	assert.equal(restored.goal?.objective, "目标 B");
	assert.equal(restored.goal?.rounds, 1);
	assert.equal(restored.cpCallsSinceAudit, 1);
});

test("额度/限流错误识别（不是任务失败）", () => {
	assert.equal(isQuotaError('429: {"message":"rate limit reached"}'), true);
	assert.equal(isQuotaError("WorkBuddy: every usable account is cooling the upstream window"), true);
	assert.equal(isQuotaError("insufficient_quota: 余额不足"), true);
	assert.equal(isQuotaError("Error: TypeError: user is undefined"), false);
	assert.equal(isQuotaError(""), false);
});

test("额度不足先切备用模型，全用完才暂停角色", () => {
	const local = mergeConfig(defaultConfig(), { fallbacks: { cp: ["magpie/auto/gpt-6.1-sol", "magpie/agentrouter/gpt-6.1-sol"] } });
	const first = handleQuotaFailure("cp", local, 0, "429");
	assert.equal(first.nextModel, "magpie/auto/gpt-6.1-sol");
	assert.equal(first.unavailable, null);
	const second = handleQuotaFailure("cp", local, 1, "429");
	assert.equal(second.nextModel, "magpie/agentrouter/gpt-6.1-sol");
	const third = handleQuotaFailure("cp", local, 2, "429");
	assert.equal(third.nextModel, null);
	assert.match(third.unavailable ?? "", /429/);
});

test("暂停的角色会被闸门直接拦下，不再消耗调用次数", () => {
	const state: TeamState = { ...baseState, unavailable: { cp: "额度不足" } };
	const d = decideCall({
		role: "cp",
		prompt: "ESCALATION: 足够长的证据文本，说明为什么需要主管介入决策，且这是第二次尝试",
		state,
		cfg,
		prices,
		activeCount: 0,
	});
	assert.equal(d.block, true);
	assert.match(d.reason ?? "", /已暂停/);
});

test("面向用户的策略文本不再汇报花费", () => {
	const economy = buildPolicy("economy", cfg);
	const strict = buildPolicy("strict", cfg);
	const goalPolicy = buildGoalPolicy(cfg);
	const cont = goalContinuePrompt({ ...baseState, goal: newGoal("目标", ["条件"]) }, cfg);
	for (const text of [economy, strict, goalPolicy, cont]) {
		assert.equal(text.includes("$"), false, "策略/续跑提示中不应出现金额");
		assert.match(text, /不要在.*汇报花费|花费或成本|Do not report spend/i);
	}
});


test("额度失败：切备用模型并粘住，不再回退", () => {
	const local = mergeConfig(defaultConfig(), { fallbacks: { cp: ["magpie/auto/gpt-6.1-sol"] } });
	const r1 = applyQuotaFailure({ ...baseState }, "cp", local, "429");
	assert.equal(r1.nextModel, "magpie/auto/gpt-6.1-sol");
	assert.equal(r1.state.roleModel.cp, "magpie/auto/gpt-6.1-sol");
	assert.equal(r1.state.unavailable.cp, undefined);
	const r2 = applyQuotaFailure(r1.state, "cp", local, "429");
	assert.equal(r2.paused, true);
	assert.ok(r2.state.unavailable.cp);
	assert.equal(r2.state.roleModel.cp, "magpie/auto/gpt-6.1-sol", "已粘住的模型不应被清掉");
});

test("可选 CP 全部模型不可用时只暂停该角色，不停止进行中的目标", () => {
	const local = mergeConfig(defaultConfig(), { fallbacks: { cp: [] } });
	const state = { ...baseState, enabled: true, goal: newGoal("目标", ["条件"]) };
	const r = applyQuotaFailure(state, "cp", local, "429 rate limit");
	assert.equal(r.paused, true);
	assert.ok(r.state.unavailable.cp);
	assert.equal(r.state.goal?.status, "active");
	assert.equal(r.state.goal?.stopReason, undefined);
});

test("非 CP 角色额度失败只暂停该角色，不影响目标继续", () => {
	const local = mergeConfig(defaultConfig(), { fallbacks: { bridges: [] } });
	const state = { ...baseState, enabled: true, goal: newGoal("目标", ["条件"]) };
	const r = applyQuotaFailure(state, "bridges", local, "429");
	assert.equal(r.paused, true);
	assert.equal(r.state.goal?.status, "active");
});

test("额度不足的失败不计入任务失败熔断", () => {
	const local = mergeConfig(defaultConfig(), { fallbacks: { cp: ["magpie/auto/gpt-6.1-sol"] } });
	const state = { ...baseState, failures: { ...baseState.failures } };
	const r = applyQuotaFailure(state, "cp", local, "429");
	assert.equal(r.state.failures.cp, 0);
});


test("所有角色在无目标、进行中、已结束目标均无调用上限", () => {
	for (const goal of [null, newGoal("目标", []), { ...newGoal("目标", []), status: "complete" as const }]) {
		for (const role of ["cp", "booker", "bridges", "ayton", "cameron"] as const) {
			assert.equal(effectiveMaxCalls({ ...baseState, limitsOff: false, goal }, cfg, role), Infinity);
		}
	}
});

test("CP 高调用计数不被拦截或提示修改旧上限", () => {
	const state = { ...baseState, mode: "strict" as const, goal: newGoal("目标", []), calls: { ...baseState.calls, cp: 1000000 } };
	const d = decideCall({ role: "cp", prompt: "Bounded technical consultation.", state, cfg, prices, activeCount: 1000000 });
	assert.equal(d.block, false);
	assert.equal(d.kind, undefined);
	assert.equal(d.reason, undefined);
});

test("目标超过原轮次与 CP 次数时仍可咨询", () => {
	const state = { ...baseState, goal: { ...newGoal("目标", []), rounds: 100 }, calls: { ...baseState.calls, cp: 100 } };
	const d = decideCall({
		role: "cp",
		prompt: "ESCALATION: 最后一轮审核，证据包含 npm test 的 8 个用例输出、测试基线 sha256 校验结果与文件行号引用",
		state,
		cfg,
		prices,
		activeCount: 0,
	});
	assert.equal(d.block, false);
});


test("旧会话预算覆盖及 limits on 状态不能恢复金额限制", () => {
	for (const budgetOverrideUSD of [null, 0, 1, 100]) {
		const local = { ...baseState, limitsOff: false, spendUSD: 1000000, budgetOverrideUSD };
		assert.equal(effectiveBudgetUSD(local, { ...cfg, sessionBudgetUSD: 1 }), 0);
		assert.equal(decideCall({ role: "bridges", prompt: "x", state: local, cfg, prices, activeCount: 0 }).block, false);
		const restored = stateFromEntries([{ type: "custom", customType: "team-state", data: local }], cfg).state;
		assert.equal(restored.budgetOverrideUSD, 0);
		assert.equal(restored.limitsOff, true);
		assert.equal(restored.spendUSD, 1000000, "统计不能丢失");
	}
});

test("所有角色正数旧角色预算也不能拦截", () => {
	for (const role of ["cp", "booker", "bridges", "ayton", "cameron"] as const) {
		const legacy = { ...cfg, roles: { ...cfg.roles, [role]: { ...cfg.roles[role], budgetUSD: 0.001 } } };
		const state = { ...baseState, limitsOff: false, spendUSD: 1000000, budgetOverrideUSD: 0.001 };
		const d = decideCall({ role, prompt: "DELEGATION_REASON: Need bounded technical review of verified test evidence and interface contracts.", state, cfg: legacy, prices, activeCount: 100 });
		assert.equal(d.block, false, role);
	}
});


test("失败分类：额度 / 中断 / 真失败", () => {
	assert.equal(classifyAgentFailure('429: {"message":"rate limit"}'), "quota");
	assert.equal(classifyAgentFailure("余额不足，请充值"), "quota");
	assert.equal(classifyAgentFailure("This operation was aborted"), "interrupted");
	assert.equal(classifyAgentFailure("Subagent failed: Result wait aborted"), "interrupted");
	assert.equal(classifyAgentFailure("Model call timed out after 30000ms"), "interrupted");
	assert.equal(classifyAgentFailure("TypeError: user is undefined"), "error");
	assert.equal(classifyAgentFailure("tests failed: expected 1 got 2"), "error");
	assert.match(INTERRUPTED_NOTE, /不是任务失败/);
	assert.match(INTERRUPTED_NOTE, /get_subagent_result/);
});

test("中断不算失败：角色连续失败计数不变", () => {
	const state: TeamState = { ...baseState, failures: { ...baseState.failures, bridges: 1 } };
	// 中断分支在 handler 中不写 failures；这里验证分类不会落到 "error"
	const kind = classifyAgentFailure("This operation was aborted");
	assert.notEqual(kind, "error");
	assert.equal(state.failures.bridges, 1);
});

test("长任务策略要求后台运行与中断核实", () => {
	for (const mode of ["economy", "strict"] as const) {
		const text = buildPolicy(mode, cfg);
		assert.match(text, /run_in_background: true/);
		assert.match(text, /aborted/);
		assert.match(text, /get_subagent_result/);
	}
});


test("bash 调用未指定 timeout 时被注入默认值", () => {
	const a: Record<string, unknown> = { command: "find / -name x" };
	assert.equal(enforceBashTimeout(a, 180), 180);
	assert.equal(a.timeout, 180);
	const b: Record<string, unknown> = { command: "npm test", timeout: 60 };
	assert.equal(enforceBashTimeout(b, 180), null, "已有合法 timeout 时不覆盖");
	assert.equal(b.timeout, 60);
	const c: Record<string, unknown> = { command: "x", timeout: 0 };
	assert.equal(enforceBashTimeout(c, 180), 180, "0 视为未指定");
});

test("前台 Agent 调用未指定 wait_timeout 时被注入上限", () => {
	const a: Record<string, unknown> = { prompt: "x" };
	assert.equal(enforceWaitTimeout(a, 600), 600);
	assert.equal(a.wait_timeout, 600);
	const b: Record<string, unknown> = { prompt: "x", wait_timeout: 1800 };
	assert.equal(enforceWaitTimeout(b, 600), 600, "超过上限的等待会被夹紧");
	assert.equal(b.wait_timeout, 600);
});


test("bash 超时：未指定→注入；超硬上限→夹紧", () => {
	const a: Record<string, unknown> = { command: "x" };
	assert.equal(enforceBashTimeout(a, 120, 600), 120);
	assert.equal(a.timeout, 120);

	const b: Record<string, unknown> = { command: "x", timeout: 1800 };
	assert.equal(enforceBashTimeout(b, 120, 600), 600);
	assert.equal(b.timeout, 600, "显式超长 timeout 必须被夹住");

	const c: Record<string, unknown> = { command: "x", timeout: 300 };
	assert.equal(enforceBashTimeout(c, 120, 600), null, "上限内的合法值不动");
});

test("前台等待上限：超过配置即被夹紧", () => {
	const a: Record<string, unknown> = { prompt: "x", wait_timeout: 1800 };
	assert.equal(enforceWaitTimeout(a, 600), 600);
	assert.equal(a.wait_timeout, 600);
	const b: Record<string, unknown> = { prompt: "x", wait_timeout: 300 };
	assert.equal(enforceWaitTimeout(b, 600), null);
});


test("maxCalls = 0 表示不限次数", () => {
	const local = mergeConfig(defaultConfig(), { roles: { bridges: { maxCalls: 0 } } });
	const state: TeamState = { ...baseState, calls: { ...baseState.calls, bridges: 500 } };
	const d = decideCall({ role: "bridges", prompt: "x", state, cfg: local, prices, activeCount: 0 });
	assert.equal(d.block, false);
	assert.equal(effectiveMaxCalls(state, local, "bridges"), Number.POSITIVE_INFINITY);
});

test("无需 limits off：所有数值额度取消，证据规则与质量执行统一", () => {
	const state: TeamState = { ...baseState, limitsOff: false, spendUSD: 999, calls: { ...baseState.calls, cp: 99, bridges: 999 } };
	const bridges = decideCall({ role: "bridges", prompt: "x", state, cfg, prices, activeCount: 99 });
	assert.equal(bridges.block, false, "并发与次数、金额都应放开");

	const cpNoEvidence = decideCall({ role: "cp", prompt: "帮我看看", state, cfg, prices, activeCount: 99 });
	assert.equal(cpNoEvidence.block, false, "CP咨询不再受证据门槛拦截");

	const cpWithEvidence = decideCall({ role: "cp", prompt: "ESCALATION: 本轮证据包括 npm test 8/8 输出、基线 sha256 与 SPEC.md 一致、改动集中在 src/slugify.js:5-12，需要主管裁定验收", state, cfg, prices, activeCount: 99 });
	assert.equal(cpWithEvidence.block, false);
});


test("团队模式强制英文：派活/报告/审核英文，用户回复语言不限", () => {
	for (const mode of ["economy", "strict"] as const) {
		const text = buildPolicy(mode, cfg);
		assert.match(text, /English/, `${mode} 缺少英文要求`);
		assert.match(text, /task brief/);
		assert.match(text, /subagent report/);
		assert.match(text, /not restricted/, "不得限制面向用户的语言");
		assert.equal(/user in Chinese/.test(text), false);
	}
	const goal = buildGoalPolicy(cfg);
	assert.match(goal, /English/);
	assert.match(goal, /team_goal summar/);
	assert.match(goal, /not restricted/);
	const cont = goalContinuePrompt({ ...baseState, goal: newGoal("目标", ["条件"]) }, cfg);
	assert.match(cont, /English/);
	assert.match(cont, /not restricted/);
	assert.equal(/Chinese/.test(cont), false, "续跑提示不应限制用户语言");
});


test("任务契约本身是英文，且包含证据字段", () => {
	const c = buildTaskContract("T-abc123");
	assert.match(c, /TEAM CONTRACT T-abc123/);
	assert.match(c, /Write the report in English/);
	assert.match(c, /file:line/);
	assert.equal(/[\u4e00-\u9fa5]/.test(c), false, "契约不应含中文");
});

test("旧配置和自定义 base 中的七类正数限制一律归零，模型与超时保留", () => {
	const legacy = { ...cfg, maxConcurrent: 6, sessionBudgetUSD: 20, maxAutoRetries: 2, goalMaxRounds: 6, goalMaxStalls: 2,
		roles: Object.fromEntries(Object.entries(cfg.roles).map(([role, value]) => [role, { ...value, maxCalls: 1, budgetUSD: 1 }])) as typeof cfg.roles };
	for (const raw of [null, [], "bad", legacy]) {
		const merged = mergeConfig(legacy, raw);
		for (const key of ["sessionBudgetUSD", "maxAutoRetries", "goalMaxRounds", "goalMaxStalls"] as const) assert.equal(merged[key], 0, key);
		for (const role of ["cp", "booker", "bridges", "ayton", "cameron"] as const) {
			assert.equal(merged.roles[role].maxCalls, 0);
			assert.equal(merged.roles[role].budgetUSD, 0);
			assert.equal(merged.roles[role].model, legacy.roles[role].model);
		}
		assert.equal(merged.bashMaxTimeoutSeconds, 900);
		assert.equal(merged.escalationMinChars, 0);
	}
	assert.equal(legacy.maxConcurrent, 6, "不得修改输入配置对象");
	assert.equal(legacy.roles.cp.maxCalls, 1);
});

test("无进展超过原阈值仍持续审核，审核历史保留上限不等于总轮数上限", () => {
	let goal = newGoal("No numeric stop", ["verified completion"]);
	for (let i = 0; i < 40; i++) goal = applyAudit(goal, { verdict: "REWORK", summary: "Same evidence, revise implementation", nextTasks: ["Revise with evidence"] });
	assert.equal(goal.rounds, 40);
	goal = { ...goal, stalls: 40 }; // Legacy/restored no-progress counter is no longer a gate.
	assert.equal(goal.stalls, 40);
	assert.equal(goal.audits.length, 30, "只截取展示历史，不停止目标");
	assert.equal(shouldContinue({ ...baseState, enabled: true, goal, continuationsSinceAudit: 40 }, cfg, 0).action, "continue");
	goal = applyAudit(goal, { verdict: "GOAL_COMPLETE", summary: "Verified", acceptanceMet: ["verified completion"] });
	assert.equal(goal.status, "complete");
	assert.equal(goal.rounds, 41);
});

test("所有模式与目标提示只声明已移除数值上限，不要求通过旧命令提额", () => {
	for (const text of [buildPolicy("economy", cfg), buildPolicy("strict", cfg), buildGoalPolicy(cfg), goalContinuePrompt({ ...baseState, goal: newGoal("x", ["y"]) }, cfg)]) {
		assert.doesNotMatch(text, /budget\/call\/fuse gates apply|Round cap \d|预算\/轮次耗尽|预算与额度由代码强制校验|\/team budget set/);
	}
});

console.log(`\n全部通过：${pass} 项`);
