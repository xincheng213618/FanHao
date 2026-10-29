import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Actual renderer, CSS and five gallery modes. Each case takes three independent
// samples with 1000 categories, 300 people, real append/summary reads and native
// select input, plus native photo category menus during real background reads.
// Constructor work/DOM ownership are gates; timing is diagnostic.
const fixture = fileURLToPath(new URL("./verify_gallery_list_rendering.mjs", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [fixture, ...args], { encoding: "utf8", timeout: 60000 });
const negativeOnly = process.argv.includes("--negative-only");
const caseArgument = process.argv.find(value => value.startsWith("--case="));
const pattern = caseArgument?.slice(7);
assert(!(negativeOnly && caseArgument), "--case and --negative-only cannot be combined");
if (caseArgument) assert(pattern, "--case requires a nonempty pattern");
if (!negativeOnly) {
  const current = run(`--case=${pattern || "control construction"}`);
  assert.equal(current.status, 0, `${current.stdout}\n${current.stderr}`);
  process.stdout.write(current.stdout);
  if (!pattern) assert.match(current.stdout, /PASS gallery list rendering: 5 actual Chromium scenarios/);
}
if (pattern) process.exit(0);
const negative = run("--legacy-eager-controls", "--case=control construction photo");
assert.notEqual(negative.status, 0, "restoring all eager selects must fail the unused-construction budget");
assert.match(`${negative.stdout}\n${negative.stderr}`, /gallery controls must not construct unused facet selects/, "reference must fail the intended constructor-work assertion");
const reference = negative.stdout.split(/\r?\n/).find(line => line.startsWith('{"kind":"gallery-control-construction"'));
assert(reference, "reference must report its actual constructor work and diagnostic timing");
console.log(reference);
console.log("PASS negative control detects eager unused facet selects/options");
const detached = run("--legacy-select-detach", "--case=control construction photo");
assert.notEqual(detached.status, 0, "temporary native select detachment must fail even when focus is restored");
assert.match(`${detached.stdout}\n${detached.stderr}`, /AssertionError/);
assert.match(`${detached.stdout}\n${detached.stderr}`, /background gallery refresh must keep native select ancestry and focus without blur/,
  "negative must fail the actual native ancestry/blur assertion, not a source marker or timeout");
console.log("PASS negative control detects native select detach despite final refocus");
const category = run("--legacy-category-detach", "--case=control construction photo");
assert.notEqual(category.status, 0, "temporary category menu detachment must fail even when open state and final focus are restored");
assert.match(`${category.stdout}\n${category.stderr}`, /AssertionError/);
assert.match(`${category.stdout}\n${category.stderr}`, /background gallery refresh must keep the expanded photo category menu ancestry and focus without transient detach/,
  "negative must fail the actual expanded-menu ancestry/blur assertion, not a marker, selector or timeout");
console.log("PASS negative control detects expanded category menu detach despite final refocus");
console.log(`Gallery control construction passed (${negativeOnly ? "3 behavior negative controls" : "5 browser cases with 3 samples each and 3 behavior negative controls"})`);
