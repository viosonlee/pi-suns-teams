/**
 * The selectable model list must match pi's own /model list: registry models with configured auth
 * (getAvailable), not every catalog model (getAll), and argument completions must see the same set.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "team-model-list-"));
process.env.PI_CODING_AGENT_DIR = root;
writeFileSync(join(root, "team.json"), JSON.stringify({}));
// models.json only knows a custom provider; pi additionally has an OAuth provider with auth.
writeFileSync(join(root, "models.json"), JSON.stringify({ providers: { custom: { models: [{ id: "local-llm", reasoning: false }] } } }));

const { default: team, loadAllAvailableModels, supportedThinkingLevels } = await import("../extensions/team.ts");

const authed = [
	{ provider: "custom", id: "local-llm", name: "Local", reasoning: false },
	{ provider: "oauthco", id: "smart-1", name: "Smart", reasoning: true, thinkingLevelMap: { minimal: null, max: "max" } },
];
const unauthed = [{ provider: "nokey", id: "catalog-only", reasoning: true }];
const registry = { getAll: () => [...authed, ...unauthed], getAvailable: () => authed, find: () => undefined };

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
	return Promise.resolve(fn()).then(() => { passed++; console.log(`✓ ${name}`); });
}

await test("registry list uses getAvailable (auth-configured), not getAll", () => {
	const refs = loadAllAvailableModels(join(root, "models.json"), { modelRegistry: registry }).map((m: any) => m.ref);
	assert.deepEqual(refs, ["custom/local-llm", "oauthco/smart-1"]);
});

await test("thinking levels mirror pi-ai getSupportedThinkingLevels", () => {
	assert.deepEqual(supportedThinkingLevels({ reasoning: false }), ["off"]);
	assert.deepEqual(supportedThinkingLevels({ reasoning: true }), ["off", "minimal", "low", "medium", "high"]);
	assert.deepEqual(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { minimal: null, max: "max" } }), ["off", "low", "medium", "high", "max"]);
});

await test("models.json is only a fallback without a registry", () => {
	assert.deepEqual(loadAllAvailableModels(join(root, "models.json")).map((m: any) => m.ref), ["custom/local-llm"]);
});

await test("/team model completions and /team model list show the pi registry set", async () => {
	const hooks = new Map<string, Function[]>(), commands = new Map<string, any>(), notes: string[] = [];
	const entries: any[] = [];
	const ctx: any = {
		cwd: root, hasUI: true, isIdle: () => true,
		sessionManager: { getEntries: () => entries, getBranch: () => entries, getSessionId: () => "parent", getSessionFile: () => join(root, "parent.jsonl") },
		ui: { notify: (m: string) => notes.push(m), setStatus() {} },
		model: { provider: "custom", id: "local-llm" }, modelRegistry: registry,
	};
	const pi: any = {
		on: (n: string, f: Function) => hooks.set(n, [...(hooks.get(n) ?? []), f]),
		registerFlag() {}, getFlag: () => false, registerTool() {},
		registerCommand: (n: string, c: any) => commands.set(n, c),
		appendEntry: (t: string, data: any) => entries.push({ type: "custom", id: `e${entries.length}`, customType: t, data }),
		getThinkingLevel: () => "high", sendMessage() {}, sendUserMessage: async () => {},
	};
	team(pi);
	for (const f of hooks.get("session_start") ?? []) await f({ reason: "startup" }, ctx);
	const completions = commands.get("team").getArgumentCompletions("model bridges ").map((c: any) => c.value);
	assert.ok(completions.includes("model bridges oauthco/smart-1"), `OAuth model missing from completions: ${completions}`);
	assert.ok(!completions.some((v: string) => v.includes("nokey/")), "unauthenticated catalog model must not be offered");
	const complete = (prefix: string) => (commands.get("team").getArgumentCompletions(prefix) ?? []).map((c: any) => c.value);
	assert.deepEqual(complete("model bri"), ["model bridges"]);
	assert.ok(complete("mod").includes("model list"), "bare subcommand prefix still completes from the top-level list");
	assert.deepEqual(complete("model bridges smart"), ["model bridges oauthco/smart-1"]);
	assert.ok(complete("model bridges oauthco/smart-1 ").includes("model bridges oauthco/smart-1 max"));
	assert.deepEqual(complete("model bridges thinking hi"), ["model bridges thinking high"]);
	await commands.get("team").handler("model list", ctx);
	const listing = notes.join("\n");
	assert.ok(listing.includes("oauthco/smart-1") && listing.includes("custom/local-llm"), listing);
	assert.ok(!listing.includes("nokey/catalog-only"), listing);
	for (const f of hooks.get("session_shutdown") ?? []) await f({}, ctx);
});

rmSync(root, { recursive: true, force: true });
console.log(`Model list tests passed: ${passed}`);
