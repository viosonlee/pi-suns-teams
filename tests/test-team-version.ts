import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_TEAMS_VERSION, comparePiTeamsVersions } from "../extensions/team.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.equal(PI_TEAMS_VERSION, pkg.version, "extensions/team.ts PI_TEAMS_VERSION must match package.json version");
assert.ok(comparePiTeamsVersions("1.10.0", "1.9.9") > 0);
assert.ok(comparePiTeamsVersions("1.0.0", "1.1.0") < 0, "an older remote must not be reported as an update");
assert.equal(comparePiTeamsVersions("1.1", "1.1.0"), 0);
assert.equal(comparePiTeamsVersions("2.0.0-beta", "2.0.0"), 0);
console.log("Version tests passed: 4");
