import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createVisionHarness, deferred, settle } from "./fixtures/android-vision-recovery-harness.mjs";

const source = fs.readFileSync(new URL("../android-client/www/modules/tools/tool-views.js", import.meta.url), "utf8");
const moduleSource = fs.readFileSync(new URL("../android-client/www/modules/tools/android-module.js", import.meta.url), "utf8");

const confirmations = [];
const requests = [];
let confirmed = true;
let nextResult = { ok: true, action: "sleep", message: "休眠指令已排队" };
const harness = createVisionHarness(source, {
  getActiveUrl: () => "http://192.168.1.20:29998",
  getComputerControlStatus: async () => ({ ok: true, actions: [{ id: "sleep" }] }),
  async confirmAction(options) {
    confirmations.push(structuredClone(options));
    return confirmed;
  },
  async sleepComputer() {
    requests.push({ action: "sleep" });
    if (nextResult instanceof Error) throw nextResult;
    if (nextResult?.promise) return nextResult.promise;
    return nextResult;
  }
});

await harness.render();
const section = harness.els.viewContent.querySelector(".computer-control-section");
assert(section, "Android My page must render a computer-control section");
assert.equal(section.hidden, false, "a server-approved LAN connection may show computer control");
assert.equal(section.querySelectorAll("button").length, 1, "mobile computer control must default to one action");
assert(harness.button(/^休眠电脑/, section), "mobile computer control must expose sleep");
assert.doesNotMatch(section.textContent, /关机|重启|锁屏|静音/, "mobile computer control must not expose extra system actions");

const sleepButton = harness.button(/^休眠电脑/, section);
harness.click(sleepButton);
await settle();
assert.equal(confirmations.length, 1, "sleep must require an in-app confirmation");
assert.match(confirmations[0].message, /手机会暂时无法连接/);
assert.equal(confirmations[0].confirmLabel, "立即休眠");
assert.deepEqual(requests, [{ action: "sleep" }]);
assert.match(section.textContent, /休眠指令已排队/);
assert.equal(sleepButton.disabled, false);

confirmed = false;
harness.click(sleepButton);
await settle();
assert.equal(requests.length, 1, "canceling confirmation must not send another sleep request");
assert.equal(sleepButton.disabled, false);

confirmed = true;
nextResult = new Error("SYNTHETIC SLEEP FAILURE");
harness.click(sleepButton);
await settle();
assert.equal(requests.length, 2);
assert.match(section.textContent, /SYNTHETIC SLEEP FAILURE/);
assert.equal(sleepButton.disabled, false, "failed sleep must restore the action for retry");

const pending = deferred();
nextResult = pending;
harness.click(sleepButton);
await settle();
harness.click(sleepButton);
await settle();
assert.equal(requests.length, 3, "sleep must reject double taps while a request is pending");
assert.equal(sleepButton.disabled, true);
pending.resolve({ ok: true, action: "sleep", message: "休眠指令已排队" });
await settle();
assert.equal(sleepButton.disabled, false);

assert(moduleSource.includes('fetchJson(sourceUrl, "/api/system/control"'), "Android tools module must use the source captured before confirmation");
assert(moduleSource.includes('method: "POST"') && moduleSource.includes('body: { action: "sleep" }'), "Android tools module must send only the sleep POST action");

const lan = "http://192.168.1.20:29998", remote = "https://public.example";
const approved = { ok: true, actions: [{ id: "sleep" }] };
for (const result of [new Error("403 forbidden"), new Error("offline"), {}, { ok: true, actions: [] }, { ok: false, actions: [{ id: "sleep" }] }]) {
  let dispatches = 0, prompts = 0;
  const h = createVisionHarness(source, {
    getActiveUrl: () => remote,
    getComputerControlStatus: async () => { if (result instanceof Error) throw result; return result; },
    confirmAction: async () => { prompts++; return true; }, sleepComputer: async () => { dispatches++; }
  });
  await h.render();
  const group = h.els.viewContent.querySelector(".computer-control-section");
  assert.equal(group.hidden, true, "public, unsupported and unknown access stays hidden");
  assert.equal(h.button(/^休眠电脑/, group).disabled, true);
  h.click(h.button(/^休眠电脑/, group)); await settle();
  assert.equal(prompts + dispatches, 0, "a hidden control cannot prompt or send sleep");
}
{
  let current = lan;
  const oldStatus = deferred();
  const h = createVisionHarness(source, { getActiveUrl: () => current,
    getComputerControlStatus: async url => { if (url === lan) return oldStatus.promise; throw Error("403"); } });
  await h.render();
  const group = h.els.viewContent.querySelector(".computer-control-section");
  assert.equal(group.hidden, true, "permission checking never flashes the group");
  current = remote; await h.api.refreshComputerControlAccess();
  oldStatus.resolve(approved); await settle();
  assert.equal(group.hidden, true, "late LAN permission cannot reveal controls on the public connection");
}
for (const roundTrip of [false, true]) {
  let current = lan, posts = 0;
  const approval = deferred();
  const h = createVisionHarness(source, { getActiveUrl: () => current,
    getComputerControlStatus: async url => { if (url !== lan) throw Error("403"); return approved; },
    confirmAction: () => approval.promise, sleepComputer: async () => { posts++; } });
  await h.render(); h.click(h.button(/^休眠电脑/)); await settle();
  const group = h.els.viewContent.querySelector(".computer-control-section");
  current = remote;
  const refresh = h.api.refreshComputerControlAccess();
  assert.equal(group.hidden, true, "source changes synchronously hide the whole group");
  await refresh;
  if (roundTrip) { current = lan; await h.api.refreshComputerControlAccess(); }
  approval.resolve(true); await settle();
  assert.equal(posts, 0, "changing servers cancels the old confirmation, even after a round trip");
}
{
  const reads = [deferred(), deferred()]; let index = 0;
  const h = createVisionHarness(source, { getActiveUrl: () => lan, getComputerControlStatus: () => reads[index++].promise });
  await h.render();
  const fresh = h.api.refreshComputerControlAccess();
  reads[1].reject(Error("403")); await fresh;
  reads[0].resolve(approved); await settle();
  assert.equal(h.els.viewContent.querySelector(".computer-control-section").hidden, true, "old access cannot replace a newer denial on the same source");
}
{
  let options; const calls = [];
  const context = vm.createContext({ createToolViews: value => { options = value; return {}; }, fetchJson: async (...args) => calls.push(args) });
  vm.runInContext(moduleSource.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, ""), context);
  context.createAndroidModule({ host: { els: {}, ui: {}, getActiveUrl: () => remote } });
  await options.getComputerControlStatus(lan); await options.sleepComputer(lan);
  assert(calls.every(call => call[0] === lan && call[1] === "/api/system/control"));
  assert.equal(calls[1][2].method, "POST");
  assert.equal(calls[0][2].cache, "no-store", "permissions cannot come from HTTP cache");
  assert(calls.every(call => call[2].redirect === "error"), "control requests cannot follow redirects to another origin");
}
const appSource = fs.readFileSync(new URL("../android-client/www/app.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../android-client/www/modules/tools/styles.css", import.meta.url), "utf8");
assert.match(appSource.match(/function updateServer\([^]*?\n\}/)[0], /toolViews\?\.refreshComputerControlAccess\?\.\(\)/, "changing the connected server must refresh the local controls");
assert.match(css, /\.computer-control-section\[hidden\]\s*\{\s*display:\s*none/, "author display:grid must not override hidden");
console.log("Android system sleep verification passed: LAN capability, hidden public/offline controls, stale responses, source changes during confirmation, cancellation and single-flight (network and OS actions mocked).");
