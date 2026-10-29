import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Existing actual Web modules/CSS in private Chromium, with synthetic albums,
// decoded covers and controlled animation frames. No real library is accessed.
const fixture = fileURLToPath(new URL("./verify_gallery_list_rendering.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [fixture, ...args], { encoding: "utf8", timeout: 60000 });
const current = run("--case=photo reader return");
assert.equal(current.status, 0, `${current.stdout}\n${current.stderr}`);
assert.match(current.stdout, /9 actual Chromium scenarios/);
process.stdout.write(current.stdout);
for (const [flag, pattern, failure] of [
  ["--legacy-reader-return", "photo reader return 1280", /returning from an album must restore its previous long-list position/],
  ["--legacy-reader-return-intent", "photo reader return intent focus", /new user intent must cancel the pending return position/]
]) {
  const negative = run(flag, `--case=${pattern}`);
  assert.notEqual(negative.status, 0, "restoring the previous return behavior must fail");
  assert.match(`${negative.stdout}\n${negative.stderr}`, failure, "negative must fail the intended return ownership assertion");
  console.log(`PASS negative control detects return regression: ${pattern}`);
}
console.log("Gallery list return passed (9 private Chromium scenarios + 2 independent negative controls)");
