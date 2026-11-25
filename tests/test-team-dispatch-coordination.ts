/**
 * Dispatch coordination regression suite (offline; no model calls, no real child processes).
 * Covers:
 * - team_tasks add/update autoDispatch:false persists a per-task manual-dispatch hold
 * - daemon tick / completion pump / reload cannot steal a held task, unrelated automatic work stays live
 * - requeue/ready of a task owning a prior child defaults to a hold; only autoDispatch:true releases it
 * - team_dispatch / team_tasks action dispatch explicitly release holds to the scheduler
 * - explicit Agent resume is atomic and keeps the full brief; mismatching resume is rejected
 * - same-task/same-role duplicate without resume succeeds with the existing sessionId and costs nothing
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "team-dispatch-coordination-"));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_TEAMS_DISABLE_NATIVE_SPAWN = "1";
writeFileSync(join(root, "team.json"), JSON.stringify({ maxConcurrent: 4, fallbacks: {} }));

const {
	newLedger, addRequest, addTasks, updateTask, readyTasks, dispatchBatch, markDispatched,
	setManualDispatchHold,
} = await import("../team-ledger.ts");
const { default: team, initialState, defaultConfig } = await import("../extensions/team.ts");

// Capture the scheduler daemon interval so tests can drive ticks deterministically instead of sleeping 5s.
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const intervalCallbacks: Array<() => unknown> = [];
(globalThis as any).setInterval = (fn: () => unknown) => {
	intervalCallbacks.push(fn);
	return { unref() {} } as any;
};
(globalThis as any).clearInterval = () => {};

let seq = 0;
let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
	await fn();
	passed++;
	console.log(`✓ ${name}`);
}
async function tick() {
	const cb = intervalCallbacks.at(-1);
	assert.ok(cb, "scheduler daemon interval must be registered");
	await cb!();
}
function harness(seed?: any[], launchOverride?: (name: string, args: any) => Promise<any>) {
	const seedState = seed ? undefined : initialState(defaultConfig());
	if (seedState) {
		seedState.enabled = true;
		seedState.startedAt = "2026-01-01";
	}
	const entries: any[] = seed ?? [{ type: "custom", id: "seed", customType: "team-state", data: seedState }];
	const hooks = new Map<string, Function[]>();
	const tools = new Map<string, any>();
	const launches: Array<{ name: string; args: any }> = [];
	const notes: string[] = [];
	const ctx: any = {
		cwd: root, hasUI: false,
		sessionManager: {
			getEntries: () => entries,
			getBranch: () => entries,
			getSessionId: () => "parent",
			getSessionFile: () => join(root, "parent.jsonl"),
		},
		ui: { notify: (m: string) => notes.push(m), setStatus() {} },
		model: { provider: "fixture", id: "unused" },
		modelRegistry: { find: () => undefined },
		executeTool: async (name: string, args: any) => {
			launches.push({ name, args });
			if (launchOverride) return launchOverride(name, args);
			const sessionId = `fake-child-${++seq}`;
			return {
				isError: false,
				content: [{ type: "text" as const, text: "started" }],
				details: { sessionId, subagentSessionId: sessionId, status: "running" },
			};
		},
	};
	const pi: any = {
		on: (name: string, fn: Function) => hooks.set(name, [...(hooks.get(name) ?? []), fn]),
		registerFlag() {},
		getFlag: () => false,
		registerTool: (spec: any) => tools.set(spec.name, spec),
		registerCommand() {},
		appendEntry: (customType: string, data: any) => entries.push({ type: "custom", id: `e${++seq}`, customType, data }),
		getThinkingLevel: () => "high",
		sendMessage() {},
		sendUserMessage: async () => {},
	};
	team(pi);
	const state = () => [...entries].reverse().find(e => e.customType === "team-state")?.data;
	return {
		ctx, tools, launches, notes, entries,
		state,
		task: (id: string) => state()?.ledger?.tasks.find((t: any) => t.id === id),
		async emit(name: string, event: any = {}) {
			let e = event;
			for (const fn of hooks.get(name) ?? []) {
				const patch = await fn(e, ctx);
				if (patch) e = { ...e, ...patch };
			}
			return e;
		},
		async start() { await this.emit("session_start", { reason: "startup" }); },
		async request(text = "fixture request") {
			await this.emit("input", { text, source: "rpc" });
			return state().ledger.requests.at(-1).id;
		},
		ledger(params: any) {
			return tools.get("team_tasks").execute(`ledger-${++seq}`, params, undefined, undefined, ctx);
		},
	};
}
const spec = (q: string, id: string) => ({
	id, title: id, role: "bridges", requestIds: [q], dependsOn: [],
	readPaths: [], writePaths: [`src/${id}`], acceptance: ["verified output"],
});

try {
	// ── Ledger-level contract ──
	await test("per-task manual hold: readyTasks still admits it for explicit Agent, dispatchBatch never does; markDispatched consumes it", async () => {
		const b = newLedger();
		const q = addRequest(b, "hold", "fixture");
		addTasks(b, [spec(q.id, "W-auto")], root);
		addTasks(b, [spec(q.id, "W-held")], root, {
			manualDispatch: true,
			manualDispatchReason: "autoDispatch:false",
		});
		const held = b.tasks.find(t => t.id === "W-held")!;
		const auto = b.tasks.find(t => t.id === "W-auto")!;
		assert.equal(held.manualDispatch, true, "hold persists on the task");
		assert.match(held.manualDispatchReason ?? "", /autoDispatch:false/);
		assert.ok(readyTasks(b).includes(held), "explicit Agent can still validate/dispatch a held task");
		assert.ok(!dispatchBatch(b).some(t => t.id === "W-held"), "automatic selection skips the held task");
		assert.ok(dispatchBatch(b).some(t => t.id === "W-auto"), "unrelated automatic task is not paused");
		markDispatched(b, "W-held", "bridges", "run-held", undefined);
		assert.equal(held.status, "running");
		assert.equal(held.manualDispatch, undefined, "explicit reservation clears the hold atomically");
	});

	await test("requeue/ready with a prior child defaults to a hold; autoDispatch:false also holds; only autoDispatch:true releases", async () => {
		const b = newLedger();
		const q = addRequest(b, "requeue", "fixture");
		addTasks(b, [spec(q.id, "W-prior")], root);
		markDispatched(b, "W-prior", "bridges", "run-1", "prior-child");
		const task = b.tasks[0];
		updateTask(b, { id: "W-prior", status: "blocked", childStopped: true, evidence: ["verified stopped"], reason: "parent verified stop" });
		updateTask(b, { id: "W-prior", status: "ready", evidence: ["requeue evidence only"], reason: "retry requested" });
		assert.equal(task.sessionId, "prior-child", "prior child ownership is preserved for resume");
		assert.equal(task.manualDispatch, true, "prior-child requeue must not silently authorize a fresh child");
		assert.match(task.manualDispatchReason ?? "", /prior child prior-child/);
		assert.ok(!dispatchBatch(b).some(t => t.id === "W-prior"), "reason/evidence alone never release the hold");
		updateTask(b, { id: "W-prior", status: "ready", autoDispatch: false, evidence: ["still manual"], reason: "manual" });
		assert.equal(task.manualDispatch, true, "autoDispatch:false persists the hold on update");
		updateTask(b, { id: "W-prior", status: "ready", autoDispatch: true, evidence: ["explicit release"], reason: "scheduler may take it" });
		assert.equal(task.manualDispatch, undefined, "autoDispatch:true is the explicit release");
		assert.ok(dispatchBatch(b).some(t => t.id === "W-prior"));
		// A requeued task with no prior session keeps its automatic eligibility.
		addTasks(b, [spec(q.id, "W-fresh")], root);
		const fresh = b.tasks.find(t => t.id === "W-fresh")!;
		updateTask(b, { id: "W-fresh", status: "queued", evidence: ["requeue"], reason: "no prior child" });
		assert.equal(fresh.manualDispatch, undefined, "no prior child means no default hold");
	});

	// ── Extension-level daemon / reload / explicit release ──
	await test("autoDispatch:false persists across reload; daemon tick cannot steal it while an unrelated automatic task still launches", async () => {
		const h = harness();
		await h.start();
		const q = await h.request();
		await h.ledger({ action: "add", tasks: [spec(q, "W-auto")] });
		assert.equal(h.launches.length, 1, "unrelated automatic task launches at registration");
		assert.equal(h.task("W-auto").status, "running");

		await h.ledger({ action: "add", autoDispatch: false, tasks: [spec(q, "W-held")] });
		assert.equal(h.task("W-held").manualDispatch, true, "hold is persisted on the task");
		assert.equal(h.launches.length, 1, "autoDispatch:false does not pump");
		await tick();
		assert.equal(h.task("W-held").status, "ready");
		assert.equal(h.launches.length, 1, "daemon tick must not steal the held task");

		const reloaded = harness(h.entries);
		await reloaded.start();
		assert.equal(reloaded.task("W-held").manualDispatch, true, "hold survives persistence/reload");
		await tick();
		assert.equal(reloaded.task("W-held").status, "ready");
		assert.equal(reloaded.launches.length, 0, "reloaded daemon must not steal the held task");
		assert.equal(reloaded.task("W-auto").status, "running", "the unrelated automatic child is untouched");
	});

	await test("team_dispatch and team_tasks action=dispatch are explicit releases that do not pause unrelated work", async () => {
		const h = harness();
		await h.start();
		const q = await h.request();
		await h.ledger({ action: "add", autoDispatch: false, tasks: [spec(q, "W-d1")] });
		const dispatched = await h.tools.get("team_dispatch").execute("d1", {}, undefined, undefined, h.ctx);
		assert.equal(dispatched.details.launched.includes("W-d1"), true, "team_dispatch releases and launches the held task");
		assert.equal(h.task("W-d1").manualDispatch, undefined);
		assert.equal(h.task("W-d1").status, "running");

		await h.ledger({ action: "add", autoDispatch: false, tasks: [spec(q, "W-d2")] });
		const released = await h.ledger({ action: "dispatch" });
		assert.equal(released.details.autoDispatched.includes("W-d2"), true, "team_tasks dispatch releases and launches");
		assert.equal(h.task("W-d2").status, "running");
	});

	await test("explicit resume is atomic with the full brief; mismatching resume and cross-role duplicates are rejected", async () => {
		const state = initialState(defaultConfig());
		state.enabled = true;
		state.startedAt = "2026-01-01";
		const ledger = newLedger();
		const q = addRequest(ledger, "resume fixture", "fixture");
		addTasks(ledger, [
			spec(q.id, "W-resume"),
			spec(q.id, "W-other"),
		], root);
		const resumeTask = ledger.tasks.find(t => t.id === "W-resume")!;
		resumeTask.sessionId = "prior-child-1";
		setManualDispatchHold(resumeTask, "prior child intent");
		const other = ledger.tasks.find(t => t.id === "W-other")!;
		other.sessionId = "other-child";
		state.ledger = ledger;
		const h = harness([{ type: "custom", id: "seed", customType: "team-state", data: state }]);
		await h.start();

		const mismatched = await h.emit("tool_call", {
			toolName: "Agent", toolCallId: "tc-mismatch",
			input: { subagent_type: "bridges", resume: "other-child", prompt: "TEAM_TASK: W-resume\nGoal: work" },
		});
		assert.equal(mismatched.block, true, "explicit resume of a different known child must be rejected");
		assert.match(mismatched.reason, /does not match existing task ownership|Unknown resume/);
		assert.equal(h.task("W-resume").status, "ready");

		const brief = "TEAM_TASK: W-resume\nGoal: finish the full bounded brief.\nImportant: preserve every acceptance criterion.";
		const resumed = await h.emit("tool_call", {
			toolName: "Agent", toolCallId: "tc-resume",
			input: { subagent_type: "bridges", resume: "prior-child-1", run_in_background: true, prompt: brief },
		});
		assert.notEqual(resumed.block, true, resumed.reason);
		assert.match(resumed.input.prompt, /finish the full bounded brief\./, "the full brief reaches the child");
		assert.match(resumed.input.prompt, /Important: preserve every acceptance criterion\./);
		assert.match(resumed.input.prompt, new RegExp(`Read Paths:`), "ledger scope contract is injected");
		assert.equal(h.task("W-resume").status, "running");
		assert.equal(h.task("W-resume").sessionId, "prior-child-1", "explicit resume binds atomically");
		assert.equal(h.task("W-resume").manualDispatch, undefined, "the hold was consumed by the explicit dispatch");

		const crossRole = await h.emit("tool_call", {
			toolName: "Agent", toolCallId: "tc-role",
			input: { subagent_type: "ayton", prompt: "TEAM_TASK: W-resume\nGoal: wrong role" },
		});
		assert.equal(crossRole.block, true, "same task with another role is not a duplicate success");
	});

	await test("same-task/same-role duplicate without resume returns success with the existing sessionId and adds no call/cost/lease/history/spawn", async () => {
		const state = initialState(defaultConfig());
		state.enabled = true;
		state.startedAt = "2026-01-01";
		const ledger = newLedger();
		const q = addRequest(ledger, "duplicate fixture", "fixture");
		addTasks(ledger, [spec(q.id, "W-dup")], root);
		const task = ledger.tasks[0];
		task.sessionId = "live-child";
		state.ledger = ledger;
		const h = harness([{ type: "custom", id: "seed", customType: "team-state", data: state }]);
		await h.start();
		// Establish the running owner exactly as an explicit Agent dispatch would.
		const firstInput = { subagent_type: "bridges", resume: "live-child", prompt: "TEAM_TASK: W-dup\nGoal: original brief" };
		const first = await h.emit("tool_call", { toolName: "Agent", toolCallId: "tc-first", input: firstInput });
		assert.notEqual(first.block, true, first.reason);
		assert.equal(h.task("W-dup").status, "running");

		const baseline = structuredClone(h.state());
		const leaseEntries = h.entries.filter(e => e.customType === "team-child-lease").length;
		const runEntries = h.entries.filter(e => e.customType === "team-run").length;

		const dupInput = { subagent_type: "bridges", prompt: "TEAM_TASK: W-dup\nGoal: duplicate launch" };
		const dupCall = await h.emit("tool_call", { toolName: "Agent", toolCallId: "tc-dup", input: dupInput });
		assert.notEqual(dupCall.block, true, "duplicate is not an error");
		assert.deepEqual(h.state(), baseline, "the tool_call hook mutates nothing for a duplicate");

		const res = await h.tools.get("Agent").execute("tc-dup", dupInput, undefined, undefined, h.ctx);
		assert.equal(res.isError, false, JSON.stringify(res.content));
		assert.equal(res.details.sessionId, "live-child");
		assert.equal(res.details.duplicate, true);
		await h.emit("tool_result", { toolName: "Agent", toolCallId: "tc-dup", input: dupInput, isError: false, details: res.details, content: res.content });

		assert.deepEqual(h.state(), baseline, "no call/cost/task mutation from the duplicate");
		assert.equal(h.entries.filter(e => e.customType === "team-child-lease").length, leaseEntries, "no extra lease");
		assert.equal(h.entries.filter(e => e.customType === "team-run").length, runEntries, "no extra run history");
		assert.equal(h.launches.length, 0, "no scheduler spawn for the duplicate");

		// A host wrapper might bypass Agent.execute after the tool_call hook marked the duplicate. Its
		// fresh-looking result details must still be consumed by tool_result without accounting a new run.
		const directInput = { subagent_type: "bridges", prompt: "TEAM_TASK: W-dup\nGoal: wrapper duplicate" };
		const directCall = await h.emit("tool_call", { toolName: "Agent", toolCallId: "tc-dup-direct", input: directInput });
		assert.notEqual(directCall.block, true, "hook lets the duplicate through for a success response");
		const directBaseline = structuredClone(h.state());
		await h.emit("tool_result", {
			toolName: "Agent", toolCallId: "tc-dup-direct", input: directInput, isError: false,
			details: { sessionId: "wrapper-fresh-looking", subagentSessionId: "wrapper-fresh-looking", status: "running" },
			content: [{ type: "text", text: "started" }],
		});
		assert.deepEqual(h.state(), directBaseline, "a wrapper duplicate result cannot account a fresh run");
		assert.equal(h.entries.filter(e => e.customType === "team-run").length, runEntries, "still no extra run history");
	});

	await test("automatic launch failure preserves the prior child id and holds it for explicit resume; unrelated tasks still launch", async () => {
		const state = initialState(defaultConfig());
		state.enabled = true;
		state.startedAt = "2026-01-01";
		const ledger = newLedger();
		const q = addRequest(ledger, "launch failure fixture", "fixture");
		addTasks(ledger, [spec(q.id, "W-prior"), spec(q.id, "W-auto")], root);
		const prior = ledger.tasks.find(t => t.id === "W-prior")!;
		markDispatched(ledger, "W-prior", "bridges", "prior-run", "prior-child");
		const priorRunId = prior.runId;
		const priorDispatchedAt = prior.dispatchedAt;
		updateTask(ledger, { id: "W-prior", status: "blocked", childStopped: true, evidence: ["verified stopped"], reason: "parent verified stop" });
		updateTask(ledger, { id: "W-prior", status: "ready", autoDispatch: true, evidence: ["explicit release"], reason: "scheduler retry" });
		state.ledger = ledger;
		const h = harness([{ type: "custom", id: "seed", customType: "team-state", data: state }], async (_name, args) => {
			if (String(args.prompt).includes("TEAM_TASK: W-prior")) {
				return { isError: true, content: [{ type: "text" as const, text: "transport exploded" }], error: "transport exploded" };
			}
			const sessionId = `auto-child-${++seq}`;
			return { isError: false, content: [{ type: "text" as const, text: "started" }], details: { sessionId, subagentSessionId: sessionId, status: "running" } };
		});
		await h.start();
		await tick();
		const failed = h.task("W-prior");
		assert.equal(failed.status, "ready", "a genuine launch failure still rolls back to ready");
		assert.equal(failed.sessionId, "prior-child", "the prior resumable child id is not deleted");
		assert.equal(failed.runId, priorRunId, "prior attempt lineage is preserved");
		assert.equal(failed.dispatchedAt, priorDispatchedAt, "prior dispatch timestamp is preserved");
		assert.equal(failed.manualDispatch, true, "the restored prior child is held for explicit resume");
		assert.match(failed.manualDispatchReason ?? "", /prior child prior-child/);
		assert.ok(failed.nextRetryAt, "normal retry tracking is still recorded");
		assert.equal(h.task("W-auto").status, "running", "the unrelated automatic task still launches");
		await tick();
		assert.equal(h.task("W-prior").status, "ready", "a later daemon tick cannot steal the held task");
		assert.equal(h.launches.filter(l => String(l.args.prompt).includes("TEAM_TASK: W-prior")).length, 1, "no fresh retry of the held task");
	});

	await test("accepted-then-error launch keeps the live child running instead of rolling back with a deleted id", async () => {
		const state = initialState(defaultConfig());
		state.enabled = true;
		state.startedAt = "2026-01-01";
		const ledger = newLedger();
		const q = addRequest(ledger, "accepted error fixture", "fixture");
		addTasks(ledger, [spec(q.id, "W-accepted"), spec(q.id, "W-thrown")], root);
		state.ledger = ledger;
		const h = harness([{ type: "custom", id: "seed", customType: "team-state", data: state }], async (_name, args) => {
			if (String(args.prompt).includes("TEAM_TASK: W-accepted")) {
				return { isError: true, content: [{ type: "text" as const, text: "post-accept transport error" }], details: { sessionId: "accepted-child", status: "running" } };
			}
			throw { details: { sessionId: "thrown-child", status: "running" } };
		});
		await h.start();
		await tick();
		const accepted = h.task("W-accepted");
		assert.equal(accepted.status, "running", "a live child returned with an error is never rolled back");
		assert.equal(accepted.sessionId, "accepted-child");
		assert.match(accepted.reason ?? "", /accepted a live child/);
		assert.ok(accepted.evidence.some((e: string) => e.startsWith("launch-accepted-with-error")), "the host error is recorded as evidence");
		const thrown = h.task("W-thrown");
		assert.equal(thrown.status, "running", "a thrown live-child result is also retained");
		assert.equal(thrown.sessionId, "thrown-child");
		assert.equal(h.entries.filter(e => e.customType === "team-child-lease" && ["accepted-child", "thrown-child"].includes(e.data?.sessionId)).length, 2, "both live children own a lease");
	});

	console.log(`\nTeam dispatch coordination tests passed: ${passed}`);
} finally {
	(globalThis as any).setInterval = realSetInterval;
	(globalThis as any).clearInterval = realClearInterval;
	rmSync(root, { recursive: true, force: true });
}