import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createNavigationFixtureDocument } from "./fixtures/android-gallery-navigation-harness.mjs";
import { captureAccountOwner, isAccountOwnerCurrent, setAccountOwner } from "../android-client/www/js/account-owner.js";
import { createDetailSectionTitle } from "../android-client/www/js/detail-ui.js";
import { formatBytes, formatNumber } from "../android-client/www/js/format.js";

// Entire current factory with real account revision guards and detail helpers.
// DOM, frames and read completion are controlled; aborted reads deliberately
// settle late. No library, real account, filesystem data or device is accessed.
let source = fs.readFileSync(new URL("../android-client/www/js/info-preview.js", import.meta.url), "utf8");
if (process.argv.includes("--legacy-ownership")) {
  for (const [before, after] of [["if (!isCurrent()) return;", "if (false) return;"],
    ['if (!isCurrent() || error?.name === "AbortError") return;', 'if (error?.name === "AbortError") return;']]) {
    assert.equal(source.split(before).length, 2); source = source.replace(before, after);
  }
}
if (process.argv.includes("--legacy-panel-ownership")) {
  assert.equal(source.split("if (ownsPanel()) renderInfoPreview").length, 2);
  source = source.replace("if (ownsPanel()) renderInfoPreview", "if (true) renderInfoPreview");
}
if (process.argv.includes("--legacy-reveal")) {
  assert.equal(source.split("if (isCurrent()) mount.scrollIntoView").length, 2);
  source = source.replace("if (isCurrent()) mount.scrollIntoView", "if (true) mount.scrollIntoView");
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const flush = async () => { for (let turn = 0; turn < 20; turn++) await Promise.resolve(); };
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem() {} } });
let sequence = 0, cases = 0;
function fixture() {
  const document = createNavigationFixtureDocument(), prototype = Object.getPrototypeOf(document.body);
  if (!Object.getOwnPropertyDescriptor(prototype, "isConnected")) Object.defineProperty(prototype, "isConnected", { get() { return this.ownerDocument.body.contains(this); } });
  const frames = [], reads = [], scrolls = [], listeners = new Map();
  const create = document.createElement;
  document.createElement = tag => { const node = create(tag); node.scrollIntoView = () => scrolls.push(node); return node; };
  const A = `https://info-${++sequence}-a.fixture.invalid`, B = `https://info-${sequence}-b.fixture.invalid`;
  let base = A;
  setAccountOwner(A, "guest", { force: true }); setAccountOwner(B, "guest", { force: true });
  const window = { requestAnimationFrame: callback => frames.push(callback),
    addEventListener(type, callback) { const values = listeners.get(type) || []; values.push(callback); listeners.set(type, values); } };
  const context = vm.createContext({ document, window, console, AbortController,
    captureAccountOwner, isAccountOwnerCurrent, createDetailSectionTitle, formatBytes, formatNumber,
    fetchJson(base, path, options) { const read = { base, path, options, ...deferred() }; reads.push(read); return read.promise; } });
  const savedDocument = globalThis.document; globalThis.document = document;
  const factory = vm.runInContext(`(function(){${source.replace(/^import[^\n]*\n/gm, "").replace(/^export /gm, "")}\nreturn createInfoPreviewSection;})()`, context)({ getActiveUrl: () => base });
  return { A, B, document, reads, scrolls, factory,
    panel(infos = [{ id: "A", name: "A.txt" }, { id: "B", name: "B.txt" }]) { const panel = factory.createFileInfoPanel({ infos }); document.body.append(panel); return panel; },
    emit(type) { for (const callback of listeners.get(type) || []) callback(); },
    switchSource() { base = B; }, switchAccount() { setAccountOwner(base, "guest", { force: true }); },
    frames() { while (frames.length) frames.shift()(); },
    cleanup() { globalThis.document = savedDocument; }
  };
}
async function run(name, task) {
  const f = fixture();
  try { await task(f); cases++; console.log(`PASS ${name}`); } finally { f.cleanup(); }
}
await run("current text, structured and inline previews retain their normal presentation", async f => {
  const panel = f.panel(), preview = panel.querySelector(".info-preview");
  panel.querySelectorAll("button")[0].click();
  assert.equal(f.reads[0].base, f.A); assert.equal(f.reads[0].options.accountScope.origin, f.A);
  f.reads[0].resolve({ name: "A.txt", content: "Synthetic A" }); await flush(); f.frames();
  assert.equal(preview.querySelector("pre").textContent, "Synthetic A");
  assert(f.scrolls.length > 0);
  preview.querySelector("button").click(); assert.equal(preview.children.length, 0);
  panel.querySelectorAll("button")[1].click();
  f.reads[1].resolve({ metadata: { fields: [{ label: "合成字段", value: "合成值" }] } }); await flush();
  assert.equal(preview.querySelector("dd").textContent, "合成值");
  preview.querySelector("button").click(); assert.equal(preview.children.length, 0);
  const inline = f.factory.createInlineInfoPanel({ infos: [{ id: "inline", name: "info.txt" }] });
  f.document.body.append(inline); f.reads[2].resolve({ content: "Synthetic inline" }); await flush();
  assert.equal(inline.querySelector("pre").textContent, "Synthetic inline"); assert.equal(inline.querySelectorAll("button").length, 0);
});
for (const failure of [false, true]) await run(`newer file survives older ${failure ? "failure" : "success"} even when cancellation is ignored`, async f => {
  const panel = f.panel(), buttons = panel.querySelectorAll("button"), preview = panel.querySelector(".info-preview");
  buttons[0].click(); buttons[1].click(); assert.equal(f.reads[0].options.signal.aborted, true);
  f.reads[1].resolve({ name: "B.txt", content: "Current B" }); await flush();
  if (failure) f.reads[0].reject(new Error("Stale A failure")); else f.reads[0].resolve({ content: "Stale A" });
  await flush(); assert.equal(preview.querySelector("pre").textContent, "Current B");
});
await run("different mounts read independently and stale close controls cannot collapse a newer preview", async f => {
  const first = f.panel(), second = f.panel();
  first.querySelector("button").click(); second.querySelector("button").click();
  assert.equal(f.reads[0].options.signal.aborted, false);
  f.reads[0].resolve({ content: "First mount" }); f.reads[1].resolve({ content: "Second mount" }); await flush();
  const preview = first.querySelector(".info-preview"), oldClose = preview.querySelector("button");
  first.querySelectorAll("button")[1].click(); oldClose.click();
  f.reads[2].resolve({ content: "Updated first" }); await flush(); oldClose.click();
  assert.equal(preview.querySelector("pre").textContent, "Updated first");
  assert.equal(second.querySelector("pre").textContent, "Second mount");
});
for (const boundary of ["source", "account", "detach", "navigation", "pagehide"]) await run(`${boundary} prevents late preview updates and scheduled scrolling`, async f => {
  const panel = f.panel(); panel.querySelector("button").click();
  const preview = panel.querySelector(".info-preview");
  if (boundary === "source") f.switchSource();
  if (boundary === "account") f.switchAccount();
  if (boundary === "detach") panel.remove();
  if (boundary === "navigation") f.emit("fanhaoViewWillRender");
  if (boundary === "pagehide") f.emit("pagehide");
  f.reads[0].resolve({ content: "Stale content" }); await flush(); f.frames();
  assert.equal(preview.querySelector("pre"), null); assert.equal(f.scrolls.length, 0);
  if (["navigation", "pagehide"].includes(boundary)) assert.equal(f.reads[0].options.signal.aborted, true);
  const before = f.reads.length; panel.querySelector("button").click();
  assert.equal(f.reads.length, before, "retired panel buttons must not start reads");
});
await run("current failures show an error and the same file can be retried", async f => {
  const panel = f.panel(), view = panel.querySelector("button"); view.click();
  f.reads[0].reject(new Error("Synthetic current failure")); await flush();
  assert.equal(panel.querySelector(".message-box").textContent, "Synthetic current failure");
  view.click(); f.reads[1].resolve({ content: "Retry succeeded" }); await flush();
  assert.equal(panel.querySelector("pre").textContent, "Retry succeeded");
});
console.log(`Android info preview: ${cases} cases PASS`);
if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage); else delete globalThis.localStorage;
