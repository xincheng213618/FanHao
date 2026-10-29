import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Current gallery page/renderer and CSS, private Chromium and synthetic APIs.
// Each negative restores one old behavior and must fail its observable contract.
const fixture = fileURLToPath(new URL("./verify_gallery_list_rendering.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [fixture, ...args], { encoding: "utf8", timeout: 60000 });
const current = run("--case=search IME");
assert.equal(current.status, 0, `${current.stdout}\n${current.stderr}`);
process.stdout.write(current.stdout);
for (const [flag, pattern, failure] of [
  ["--legacy-search-ime", "search IME photo: composition", /IME confirmation\/cancellation must not submit or clear/],
  ["--legacy-search-key229", "search IME media: trailing", /the trailing IME key must retain/],
  ["--legacy-search-detach", "search IME photo: summary", /background gallery refresh must not detach or blur/]
]) {
  const negative = run(flag, `--case=${pattern}`);
  assert.notEqual(negative.status, 0, `restoring ${flag} must fail`);
  assert.match(`${negative.stdout}\n${negative.stderr}`, failure, "negative must fail its intended input behavior assertion");
  console.log(`PASS negative control detects ${flag.slice(2)}`);
}
console.log("Gallery search input passed (8 browser cases and 3 behavior negative controls)");
