import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The existing private Chromium fixture uses actual modules and synthetic APIs.
// Restoring the previous delayed focus callbacks must fail both ownership checks.
const fixture = fileURLToPath(new URL("./verify_gallery_list_rendering.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [fixture, ...args], { encoding: "utf8", timeout: 60000 });
const current = run("--case=search focus");
assert.equal(current.status, 0, `${current.stdout}\n${current.stderr}`);
process.stdout.write(current.stdout);
for (const [pattern, failure] of [
  ["search focus photo: new control", /submitted search must not steal focus/],
  ["search focus media: selection", /late submit retries must not overwrite a newer cursor selection/]
]) {
  const negative = run("--legacy-search-focus", `--case=${pattern}`);
  assert.notEqual(negative.status, 0, "restoring delayed focus retries must fail");
  assert.match(`${negative.stdout}\n${negative.stderr}`, failure, "negative must fail the intended focus ownership assertion");
  console.log(`PASS negative control detects delayed focus retry: ${pattern}`);
}
console.log("Gallery search focus passed (4 browser cases and 2 behavior negative controls)");
