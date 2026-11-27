import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	SUBAGENT_META_TYPE,
	SUBAGENT_STATUS_TYPE,
	SUBAGENT_RESULT_TYPE,
	HOSTED_CHILD_LINK_TYPE,
	classifyChildProvenance,
	recoverChildReport,
	verifyHostedChildProvenance,
	type SessionEntryLike,
} from "../team-recovery.ts";

const PARENT = "00000000-0000-4000-8000-000000000001";
const CHILD = "00000000-0000-4000-8000-000000000002";
const FOREIGN_PARENT = "00000000-0000-4000-8000-000000000004";
const TIME = Date.parse("2026-01-01T00:00:00.000Z");
const REPORT = "## Report\nSynthetic batch3 fixture.";

function chain(drafts: SessionEntryLike[]): SessionEntryLike[] {
	return drafts.map((draft, index) => ({
		parentId: index === 0 ? null : drafts[index - 1].id,
		timestamp: new Date(TIME + (index + 1) * 1000).toISOString(),
		...draft,
	}));
}
function assistant(id: string): SessionEntryLike {
	return {
		type: "message", id,
		message: {
			role: "assistant", content: [{ type: "text", text: REPORT }], stopReason: "stop",
			api: "openai-completions", provider: "offline-fixture", model: "offline-fixture",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			timestamp: TIME,
		},
	};
}
function user(id: string): SessionEntryLike {
	return { type: "message", id, message: { role: "user", content: "Synthetic request", timestamp: TIME } };
}
function marker(id: string, customType: string, status: string): SessionEntryLike {
	return { type: "custom", id, customType, data: { version: 1, status } };
}
function subagentMeta(parent: string): SessionEntryLike {
	return { type: "custom", id: "meta", customType: SUBAGENT_META_TYPE,
		data: { version: 1, parentSessionId: parent, parentToolCallId: "parent-call", profile: "bridges", description: "fixture" } };
}
function hostedLink(spawnedBy: string, spawned: string): SessionEntryLike {
	return { type: "custom", id: "spawn", customType: HOSTED_CHILD_LINK_TYPE,
		data: { version: 1, spawnedBySessionId: spawnedBy, spawnedSessionId: spawned } };
}
function lifecycle(idPrefix: string): SessionEntryLike[] {
	return [
		marker(`${idPrefix}-q`, SUBAGENT_STATUS_TYPE, "queued"),
		marker(`${idPrefix}-r`, SUBAGENT_STATUS_TYPE, "running"),
		user(`${idPrefix}-u`),
		{ ...marker(`${idPrefix}-i`, SUBAGENT_RESULT_TYPE, "interrupted"), data: { version: 1, status: "interrupted", error: "This operation was aborted" } },
		assistant(`${idPrefix}-a`),
	];
}
function hostedEntries(): SessionEntryLike[] {
	return chain([hostedLink(PARENT, CHILD), ...lifecycle("h")]);
}
function subagentEntries(parent = PARENT): SessionEntryLike[] {
	return chain([subagentMeta(parent), ...lifecycle("s")]);
}

// ---------------- pure classifier matrix ----------------
test("classifyChildProvenance: hosted spawn link binding this parent → ours-hosted", () => {
	assert.equal(classifyChildProvenance(hostedEntries(), PARENT, CHILD).class, "ours-hosted");
});
test("classifyChildProvenance: subagent metadata binding this parent → ours-subagent", () => {
	assert.equal(classifyChildProvenance(subagentEntries(), PARENT, CHILD).class, "ours-subagent");
});
test("classifyChildProvenance: foreign subagent metadata NEVER falls through to spawn links", () => {
	const mixed = chain([subagentMeta(FOREIGN_PARENT), hostedLink(PARENT, CHILD), ...lifecycle("m")]);
	const cls = classifyChildProvenance(mixed, PARENT, CHILD);
	assert.equal(cls.class, "foreign");
	assert.match(cls.reason ?? "", /another parent/);
});
test("classifyChildProvenance: spawn link binding another parent → foreign", () => {
	const entries = chain([hostedLink(FOREIGN_PARENT, CHILD), ...lifecycle("f")]);
	assert.equal(classifyChildProvenance(entries, PARENT, CHILD).class, "foreign");
});
test("classifyChildProvenance: spawn link for a different session id → foreign", () => {
	const entries = chain([hostedLink(PARENT, FOREIGN_PARENT), ...lifecycle("x")]);
	assert.equal(classifyChildProvenance(entries, PARENT, CHILD).class, "foreign");
});
test("classifyChildProvenance: neither metadata nor link → unproven", () => {
	assert.equal(classifyChildProvenance(chain(lifecycle("n")), PARENT, CHILD).class, "unproven");
});
test("classifyChildProvenance: malformed metadata → malformed", () => {
	const entries = chain([{ type: "custom", id: "meta", customType: SUBAGENT_META_TYPE, data: { version: 2 } }, ...lifecycle("mm")]);
	assert.equal(classifyChildProvenance(entries, PARENT, CHILD).class, "malformed");
});

// ---------------- recovery read path (the Batch-1 gap) ----------------
function withFixture(fn: (sessionsDir: string, put: (entries: SessionEntryLike[]) => void) => void): void {
	const root = mkdtempSync(join(tmpdir(), "team-batch3-prov-"));
	try {
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir);
		const put = (entries: SessionEntryLike[]) => {
			const dir = join(sessionsDir, "--fixture--");
			mkdirSync(dir, { recursive: true });
			const jsonl = [
				{ type: "session", version: 3, id: CHILD, timestamp: new Date(TIME).toISOString(), cwd: root },
				...entries,
			].map((e) => JSON.stringify(e)).join("\n") + "\n";
			writeFileSync(join(dir, `2026-01-01T00-00-00-000Z_${CHILD}.jsonl`), jsonl, "utf8");
		};
		fn(sessionsDir, put);
	} finally {
		rmSync(root, { recursive: true, force: true });
		assert.equal(existsSync(root), false);
	}
}

test("recoverChildReport recovers a hosted child through its spawn link (no foreign-parent misclassification)", () => {
	withFixture((sessionsDir, put) => {
		put(hostedEntries());
		const res = recoverChildReport(CHILD, { parentSessionId: PARENT, nativeStatus: "interrupted", sessionsDir });
		assert.notEqual(res.status, "foreign-parent", `hosted child must not misclassify: ${res.reason}`);
		assert.equal(res.status, "recovered", res.reason);
	});
});
test("recoverChildReport still rejects genuinely foreign sessions (fail closed)", () => {
	withFixture((sessionsDir, put) => {
		put(subagentEntries(FOREIGN_PARENT));
		const res = recoverChildReport(CHILD, { parentSessionId: PARENT, nativeStatus: "interrupted", sessionsDir });
		assert.equal(res.status, "foreign-parent");
		assert.equal(res.report, undefined, "foreign evidence never leaks a report");
	});
});
test("recoverChildReport: session with no provenance at all stays foreign/unproven", () => {
	withFixture((sessionsDir, put) => {
		put(chain(lifecycle("bare")));
		const res = recoverChildReport(CHILD, { parentSessionId: PARENT, nativeStatus: "interrupted", sessionsDir });
		assert.equal(res.status, "foreign-parent");
		assert.match(res.reason ?? "", /unproven|not a pi-web subagent/);
	});
});

// ---------------- cancel-path provenance consistency ----------------
test("verifyHostedChildProvenance and recovery agree on every matrix row", () => {
	withFixture((sessionsDir, put) => {
		for (const [name, entries, expectOk] of [
			["hosted", hostedEntries(), true],
			["subagent", subagentEntries(), true],
			["foreign-meta+valid-link", chain([subagentMeta(FOREIGN_PARENT), hostedLink(PARENT, CHILD), ...lifecycle("z")]), false],
			["foreign-link", chain([hostedLink(FOREIGN_PARENT, CHILD), ...lifecycle("y")]), false],
			["no-provenance", chain(lifecycle("bare2")), false],
		] as const) {
			put(entries);
			const prov = verifyHostedChildProvenance(CHILD, PARENT, { sessionsDir });
			assert.equal(prov.ok, expectOk, `${name}: ${prov.ok ? "ok" : (prov as any).reason}`);
			const rec = recoverChildReport(CHILD, { parentSessionId: PARENT, nativeStatus: "interrupted", sessionsDir });
			assert.equal(rec.status !== "foreign-parent" && rec.status !== "malformed", expectOk, `${name}: recovery agrees (${rec.status})`);
			rmSync(join(sessionsDir, "--fixture--"), { recursive: true, force: true });
		}
	});
});

console.log("\nbatch3 provenance tests passed");
