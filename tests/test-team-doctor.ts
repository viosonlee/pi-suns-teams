/**
 * Comprehensive proactive regression suite for v1.2.5 bug fixes and Team Doctor self-diagnostics.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newLedger, addRequest, addTasks, updateTask, createReviewerTask, taskConflict, ledgerPrompt } from "../team-ledger.ts";
import { parseReviewReport } from "../team-review.ts";
import { collectEvidenceRefs, verifyEvidenceRefs } from "../team-review-evidence.ts";
import { completedCommandsForHostedReport } from "../team-recovery.ts";
import { auditWorktrees } from "../team-worktree.ts";
import { diagnoseTeamHealth, formatDoctorReport } from "../team-doctor.ts";
import { launchNativeSubagent, sanitizeModelOverride } from "../team-runner.ts";
import { launchHostedSubagent } from "../team-host.ts";
import teamExtension, { defaultConfig, initialState } from "../extensions/team.ts";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
	await fn();
	console.log(`✓ ${name}`);
	passed++;
}

await test("1. parseReviewReport preserves snake_case, CJK filenames, globs, and ~/ paths", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "doc-cjk-")));
	try {
		mkdirSync(join(root, "docs", "01_spec"), { recursive: true });
		mkdirSync(join(root, "ProductFlavors", "KANOMAX"), { recursive: true });
		const cjkFile = join(root, "docs", "01_spec", "新100L本体ファームウェア仕様書_20260910.md");
		const jsonFile = join(root, "ProductFlavors", "KANOMAX", "Model3921_Language_Con.json");
		writeFileSync(cjkFile, Array.from({ length: 1200 }, (_, i) => `line ${i + 1}`).join("\n"));
		writeFileSync(jsonFile, Array.from({ length: 1800 }, (_, i) => `key_${i + 1}`).join("\n"));

		const report = [
			"VERDICT: PASS",
			"- **AC1 — CJK spec path verified: PASS.**",
			"  Evidence: `docs/01_spec/新100L本体ファームウェア仕様書_20260910.md:1056` and **ProductFlavors/KANOMAX/Model3921_Language_Con.json:1464** match.",
			"- **AC2 — wildcard prose and glob do not hallucinate .py or .md: PASS.**",
			"  Checked scripts under `tools/checklist/*.py` and docs (`docs/01_spec/新100L本体ファームウェア仕様書_20260910.md`); Model3921_Language_Con.json confirmed.",
		].join("\n");

		const parsed = parseReviewReport(report, ["CJK spec verified", "No bogus wildcard paths"]);
		assert.equal(parsed.verdict, "PASS");
		assert.equal(parsed.checks.length, 2);
		assert.ok(parsed.checks[0].evidence.includes("docs/01_spec/新100L本体ファームウェア仕様書_20260910.md:1056"));
		assert.ok(parsed.checks[0].evidence.includes("ProductFlavors/KANOMAX/Model3921_Language_Con.json:1464"));
		assert.ok(parsed.checks[1].evidence.includes("tools/checklist/*.py"), `Expected glob preserved, got: ${parsed.checks[1].evidence}`);

		const refs = collectEvidenceRefs(parsed.checks.map(c => c.evidence).join("\n"), root);
		assert.ok(!refs.some(r => r.raw === ".py" || r.raw === ".md"), `Must not extract bare extension ref: ${JSON.stringify(refs)}`);
		const audit = verifyEvidenceRefs(refs, {
			cwd: root,
			exists: p => existsSync(p),
			readFile: p => { try { return execFileSync("cat", [p], { encoding: "utf8" }); } catch { return null; } },
		});
		assert.equal(audit.ok, true, JSON.stringify(audit));
		assert.deepEqual(audit.failed, []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await test("2. verifyEvidenceRefs checks worker worktree fallback cwds + compound/codemode commands", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "doc-wt-ev-")));
	const wt = realpathSync(mkdtempSync(join(tmpdir(), "doc-wt-sub-")));
	try {
		mkdirSync(join(root, ".pi"), { recursive: true });
		mkdirSync(join(wt, "docs", "03_operations"), { recursive: true });
		writeFileSync(join(root, ".pi", "todo.md"), "a\nb\nc\n");
		writeFileSync(join(wt, "docs", "03_operations", "pw_log.md"), "1\n2\n3\n4\n");

		const cmdText = [
			"CRITERION AC1: PASS — `$ git -C " + wt + " status --short` exited 0 and confirmed clean worktree; see docs/03_operations/pw_log.md:3 and .pi/todo.md:2",
		].join("\n");
		const parsed = parseReviewReport(`VERDICT: PASS\n${cmdText}`, ["verify worktree and command"]);
		const refs = collectEvidenceRefs(parsed.checks.map(c => c.evidence).join("\n"), wt);
		const entries = [
			{
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: "2026-11-27T01:00:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "cm1", name: "codemode", arguments: { code: `await tools.bash({ command: "cd ${wt} && git log -1 && git status --short | head -20" })` } }],
				},
			},
			{ type: "message", id: "e2", parentId: "e1", timestamp: "2026-11-27T01:00:01.000Z", message: { role: "toolResult", toolCallId: "cm1", isError: false, content: [] } },
			{ type: "message", id: "e3", parentId: "e2", timestamp: "2026-11-27T01:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "VERDICT: PASS" }] } },
		];
		const observed = completedCommandsForHostedReport(entries as any);
		assert.ok(observed.some(c => c.includes("git status --short")), "codemode tools.bash call must be captured");

		const audit = verifyEvidenceRefs(refs, {
			cwd: wt,
			fallbackCwds: [root],
			observedCommands: observed,
			exists: p => existsSync(p),
			readFile: p => { try { return execFileSync("cat", [p], { encoding: "utf8" }); } catch { return null; } },
		});
		assert.equal(audit.ok, true, JSON.stringify(audit));
		assert.ok(audit.verified.some(v => v.startsWith("command:")), JSON.stringify(audit));
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(wt, { recursive: true, force: true });
	}
});

await test("3. Model sentinel sanitization prevents Unknown model 'inherit'/'' across Agent, spawn_subsession, hosted & native", async () => {
	assert.equal(sanitizeModelOverride("inherit"), undefined);
	assert.equal(sanitizeModelOverride(""), undefined);
	assert.equal(sanitizeModelOverride("default"), undefined);
	assert.equal(sanitizeModelOverride("auto"), undefined);
	assert.equal(sanitizeModelOverride("openai/gpt-5"), "openai/gpt-5");

	const root = realpathSync(mkdtempSync(join(tmpdir(), "doc-model-")));
	try {
		mkdirSync(join(root, "agents"), { recursive: true });
		writeFileSync(join(root, "agents", "bridges.md"), "---\ntools: [read]\nmodel: inherit\nthinking: \"\"\n---\nWorker");
		const calls: Array<{ name: string; args: any }> = [];
		const res = await launchHostedSubagent({ subagent_type: "bridges", prompt: "TEAM_TASK: W-m1\nCheck", model: "inherit", thinking: "" }, {
			agentDir: root,
			cwd: root,
			parentSessionId: "p-1",
			getModelOverride: () => "default",
			executeTool: async (name, args) => {
				calls.push({ name, args });
				return { isError: false, details: { sessionId: "child-m1" }, content: [] };
			},
		});
		assert.equal(res.isError, false);
		const spawnCall = calls.find(c => c.name === "spawn_subsession");
		assert.ok(spawnCall);
		assert.equal("model" in spawnCall.args, false, `spawn_subsession must omit sentinel model, got ${JSON.stringify(spawnCall.args)}`);
		assert.equal("thinkingLevel" in spawnCall.args, false);

		// Native dry failure when disabled still validates sanitization helper cleanly
		const prev = process.env.PI_TEAMS_DISABLE_NATIVE_SPAWN;
		process.env.PI_TEAMS_DISABLE_NATIVE_SPAWN = "1";
		const nat = await launchNativeSubagent({ subagent_type: "bridges", prompt: "hi", model: "inherit" }, { agentDir: root, cwd: root });
		if (prev === undefined) delete process.env.PI_TEAMS_DISABLE_NATIVE_SPAWN; else process.env.PI_TEAMS_DISABLE_NATIVE_SPAWN = prev;
		assert.equal(nat.isError, true);

		// Parent extension hook strips sentinel model on direct spawn_subsession even when team is disabled
		const handlers = new Map<string, any[]>();
		const tools = new Map<string, any>();
		const cmds: Record<string, any> = {};
		const entries: any[] = [];
		teamExtension({
			on(ev: string, fn: any) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
			registerTool(t: any) { tools.set(t.name, t); },
			registerCommand(name: string, cmd: any) { cmds[name] = cmd; },
			registerFlag() {},
			getFlag() { return false; },
			appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
			sendUserMessage() {},
		} as any);
		const ctx: any = { cwd: root, hasUI: false, ui: { notify() {}, setStatus() {} }, sessionManager: { getSessionId: () => "p-hooks", getEntries: () => entries, getBranch: () => entries } };
		for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);
		const directInput: any = { prompt: "explore", model: "inherit", thinkingLevel: "" };
		for (const fn of handlers.get("tool_call") ?? []) await fn({ toolName: "spawn_subsession", toolCallId: "tc-raw", input: directInput }, ctx);
		assert.equal("model" in directInput, false, "spawn_subsession model:'inherit' must be stripped");
		assert.equal("thinkingLevel" in directInput, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await test("4. schedulerPump injects buildReviewContract when auto-dispatching W-rev-* tasks & team_tasks caps byte bloat", async () => {
	const handlers = new Map<string, any[]>();
	const tools = new Map<string, any>();
	const cmds: Record<string, any> = {};
	const entries: any[] = [];
	const launchedPrompts: string[] = [];
	const root = realpathSync(mkdtempSync(join(tmpdir(), "doc-pump-")));
	try {
		teamExtension({
			on(ev: string, fn: any) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
			registerTool(t: any) { tools.set(t.name, t); },
			registerCommand(name: string, cmd: any) { cmds[name] = cmd; },
			registerFlag() {},
			getFlag() { return false; },
			appendEntry(customType: string, data: any) { entries.push({ type: "custom", customType, data }); },
			sendUserMessage() {},
		} as any);
		const ctx: any = {
			cwd: root,
			hasUI: false,
			ui: { notify() {}, setStatus() {} },
			sessionManager: { getSessionId: () => "p-pump", getEntries: () => entries, getBranch: () => entries },
			async executeTool(name: string, args: any) {
				if (name === "Agent") {
					launchedPrompts.push(String(args.prompt || ""));
					return { isError: false, details: { sessionId: `child-${launchedPrompts.length}`, status: "running" }, content: [] };
				}
				return { isError: false, details: {}, content: [] };
			},
		};
		for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);
		await cmds.team.handler("on", ctx);
		for (const fn of handlers.get("input") ?? []) await fn({ text: "audit feature", source: "rpc" }, ctx);
		const qid = [...entries].reverse().find(e => e.customType === "team-state").data.ledger.requests[0].id;

		// Add worker with large evidence (exceeds 16KB compact byte cap even with 2 tasks) + create review
		const ledgerTool = tools.get("team_tasks");
		const bigText = "verified line\n".repeat(1500);
		await ledgerTool.execute("a1", {
			action: "add",
			autoDispatch: false,
			tasks: [
				{ id: "W-w1", title: "Write feature", requestIds: [qid], role: "bridges", dependsOn: [], readPaths: ["README.md"], writePaths: ["src/feat.ts"], acceptance: ["feat works end to end", "tests pass"] },
			],
		}, null, null, ctx);
		const smallListRes = await ledgerTool.execute("l0", { action: "list" }, null, null, ctx);
		assert.ok(smallListRes.details.ledger, "tiny board (<4KB) list still exposes details.ledger");
		const stateNow = [...entries].reverse().find(e => e.customType === "team-state").data;
		const worker = stateNow.ledger.tasks[0];
		worker.status = "reported";
		worker.evidence = [bigText];
		createReviewerTask(stateNow.ledger, worker);
		for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);

		// Trigger dispatch pump
		const listRes = await ledgerTool.execute("l1", { action: "list" }, null, null, ctx);
		const addSecond = await ledgerTool.execute("d1", { action: "dispatch" }, null, null, ctx);
		assert.equal(listRes.details.ledger, undefined, "list must compact oversized board even with <60 tasks");
		assert.ok(listRes.details.ledgerSummary);
		assert.equal(addSecond.details.ledger, undefined, "dispatch must compact oversized board even with <60 tasks");

		assert.equal(launchedPrompts.length, 1);
		assert.ok(launchedPrompts[0].includes("[CANONICAL REVIEW CONTRACT — AUTO-INJECTED FROM LEDGER for W-rev-w1]"));
		assert.ok(launchedPrompts[0].includes("AC1. feat works end to end"));
		assert.ok(launchedPrompts[0].includes("verified line"), "schedulerPump must embed worker evidence excerpt");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await test("5. Nested worktrees are not falsely locked by parent task scopes", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "doc-nested-wt-")));
	try {
		const repo = join(root, "repo");
		const wtParent = join(root, "wt", "feature");
		const wtChild = join(wtParent, "feature-sub");
		mkdirSync(repo, { recursive: true });
		mkdirSync(join(root, "wt"), { recursive: true });
		execFileSync("git", ["-C", repo, "init", "-b", "main"]);
		execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
		execFileSync("git", ["-C", repo, "config", "user.email", "t@e.com"]);
		writeFileSync(join(repo, "a.txt"), "1\n");
		execFileSync("git", ["-C", repo, "add", "."]);
		execFileSync("git", ["-C", repo, "commit", "-m", "init"]);
		execFileSync("git", ["-C", repo, "worktree", "add", "-b", "feat/parent", wtParent, "main"]);
		execFileSync("git", ["-C", repo, "worktree", "add", "-b", "feat/child-merged", wtChild, "main"]);

		const board = newLedger();
		const q = addRequest(board, "parent work", "test");
		addTasks(board, [{
			id: "W-p", title: "parent task", role: "bridges", requestIds: [q.id], dependsOn: [],
			readPaths: [wtParent], writePaths: [join(wtParent, "a.txt")], acceptance: ["ok"],
		}], wtParent);
		board.tasks[0].status = "running";
		const audit = auditWorktrees(wtParent, { tasks: board.tasks });
		assert.ok(audit.reclaimableMerged.some(w => w.path === wtChild), `nested merged child worktree ${wtChild} must be reclaimable, not protected by parent dir ${wtParent}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

await test("6. diagnoseTeamHealth & /team doctor --fix proactively catch and self-heal hidden issues", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "doc-doctor-")));
	try {
		const cfg = defaultConfig();
		cfg.roles.booker.model = "inherit";
		cfg.roles.ayton.model = "bad/missing-model";
		cfg.fallbacks.cp = ["bad/missing-fallback"];
		const s = initialState(cfg);
		s.enabled = true;
		s.roleModel.cp = "auto";
		const now = Date.now();
		s.unavailable = { bridges: "429" };
		s.unavailableAt = { bridges: now - 20 * 60_000 };
		s.unavailableModel = { bridges: "m1" };
		const b = newLedger();
		const q = addRequest(b, "r1", "test");
		addTasks(b, [{
			id: "W-1", title: "t1", role: "bridges", requestIds: [q.id], dependsOn: [],
			readPaths: [], writePaths: ["x.ts"], acceptance: ["ok"],
		}], root);
		b.tasks[0].status = "done";
		b.tasks.push({ id: "W-rev-orphan", parentTaskId: "W-missing", title: "orphan", role: "cp", requestIds: [q.id], dependsOn: [], readPaths: [], writePaths: [], acceptance: ["x"], status: "ready", evidence: [] });
		s.ledger = b;

		const report = diagnoseTeamHealth({
			enabled: true,
			cwd: root,
			ledger: b,
			roles: cfg.roles,
			fallbacks: cfg.fallbacks,
			roleModel: s.roleModel,
			unavailable: s.unavailable,
			unavailableAt: s.unavailableAt,
			unavailableModel: s.unavailableModel,
			availableModelRefs: new Set(["openai/gpt-5"]),
			worktreeAudit: null,
			childGcPreview: null,
			nowMs: now,
		});
		assert.equal(report.healthy, false);
		assert.ok(report.findings.some(f => f.code === "sentinel_model_override"));
		assert.ok(report.findings.some(f => f.code === "unknown_configured_model" && f.summary.includes("cp.fallback=bad/missing-fallback")));
		assert.ok(report.findings.some(f => f.code === "expired_quota_lock"));
		assert.ok(report.findings.some(f => f.code === "prunable_stale_reviews"));
		const formatted = formatDoctorReport(report);
		assert.ok(formatted.includes("/team doctor --fix"));

		// End-to-end `/team doctor --fix` command handler clears sentinel overrides, expired locks, and orphan reviews
		const handlers = new Map<string, any[]>();
		const cmds: Record<string, any> = {};
		const notifications: Array<{ msg: string; level: string }> = [];
		const persistedEntries: any[] = [];
		writeFileSync(join(root, "team.json"), JSON.stringify({ roles: { booker: { model: "inherit" } } }));
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = root;
		try {
			teamExtension({
				on(ev: string, fn: any) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); },
				registerTool() {},
				registerCommand(name: string, cmd: any) { cmds[name] = cmd; },
				registerFlag() {},
				getFlag() { return false; },
				appendEntry(customType: string, data: any) { persistedEntries.push({ type: "custom", customType, data }); },
				sendUserMessage() {},
			} as any);
			const stateInit = initialState(defaultConfig());
			stateInit.enabled = true;
			stateInit.roleModel.cp = "inherit";
			stateInit.unavailable = { bridges: "429" };
			stateInit.unavailableAt = { bridges: Date.now() - 20 * 60_000 };
			const b2 = newLedger();
			const q2 = addRequest(b2, "doc fix", "test");
			b2.tasks.push({ id: "W-rev-ghost", parentTaskId: "W-ghost", title: "ghost", requestIds: [q2.id], role: "cp", dependsOn: [], readPaths: [], writePaths: [], acceptance: ["x"], status: "ready", evidence: [] });
			stateInit.ledger = b2;
			persistedEntries.push({ type: "custom", customType: "team-state", data: stateInit });
			const ctx: any = {
				cwd: root,
				hasUI: true,
				ui: { notify(msg: string, level: string) { notifications.push({ msg, level }); }, setStatus() {} },
				sessionManager: { getSessionId: () => "doc-cmd-sid", getEntries: () => persistedEntries, getBranch: () => persistedEntries },
			};
			for (const fn of handlers.get("session_start") ?? []) await fn({ reason: "startup" }, ctx);
			await cmds.team.handler("doctor --fix", ctx);
			const lastNotify = notifications.at(-1)!;
			assert.ok(lastNotify.msg.includes("已自动安全修复"), `Expected auto-fix summary, got: ${lastNotify.msg}`);
			assert.ok(lastNotify.msg.includes("未发现阻塞或告警级问题"), `Expected healthy after --fix, got: ${lastNotify.msg}`);
		} finally {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

console.log(`\nAll ${passed} team-doctor & v1.2.5 regression tests passed!`);
