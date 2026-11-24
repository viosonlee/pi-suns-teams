#!/usr/bin/env node
// Runs every offline TypeScript test (node >= 22.6 type stripping). Python/RPC tests need a real pi + model and are opt-in.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((name) => /^test-.*\.ts$/.test(name)).sort();
const failed = [];
for (const name of files) {
	const started = Date.now();
	const result = spawnSync(process.execPath, [join(dir, name)], {
		encoding: "utf8",
		timeout: 180_000,
		// Hook tests must never launch a real `pi`; native tests opt back in themselves with a fake binary.
		env: { ...process.env, PI_TEAMS_DISABLE_NATIVE_SPAWN: "1" },
	});
	const ok = result.status === 0;
	console.log(`${ok ? "✓" : "✗"} ${name} (${Date.now() - started}ms)`);
	if (!ok) {
		failed.push(name);
		process.stdout.write(`${result.stdout ?? ""}${result.stderr ?? ""}`.split("\n").slice(-30).join("\n") + "\n");
	}
}
console.log(`\n${files.length - failed.length}/${files.length} test files passed`);
if (failed.length) {
	console.log(`Failed: ${failed.join(", ")}`);
	process.exit(1);
}
