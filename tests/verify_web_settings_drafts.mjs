import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Current controller + actual DOM/CSS and native keyboard. The provided API is
// a controlled Promise transport: synthetic DTOs only, including late replies.
// No settings service, credentials, application database or real writes.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), publicRoot = path.join(repository, "public");
const controllerUrl = "/modules/system/settings-controller.js";
const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
  .filter(Boolean).find(value => fs.existsSync(value));

export async function runWebSettingsFixture({ casePattern = "", sourceOverride = null } = {}) {
  assert(executablePath, "Chrome or Edge required for the private settings fixture");
  const faults = [], held = new Set(); let checks = 0;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "GET", "the fixture HTTP server only serves static sources");
      const url = new URL(req.url, "http://fixture");
      if (url.pathname === "/") return send(res, harness(), "text/html");
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      if (url.pathname === controllerUrl && sourceOverride !== null) return send(res, sourceOverride, "text/javascript");
      const filename = path.resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
      assert(filename.startsWith(publicRoot + path.sep), "static sources must stay inside public");
      send(res, await fs.promises.readFile(filename), filename.endsWith(".css") ? "text/css" : "text/javascript");
    } catch (error) { faults.push(error.message); res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ executablePath, headless: true }), base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run("settings drafts module navigation retains typed controls and keyboard focus", async () => {
      const { page, runtime } = await open(320);
      try {
        const general = form(page, "alpha", "general"), advanced = form(page, "alpha", "advanced");
        await field(general, "name").fill("  Alpha draft  "); await field(general, "enabled").check();
        await field(general, "mode").selectOption("two"); await field(general, "quota").fill("2.750");
        await field(advanced, "paths").fill(" first \nfirst\n second "); await field(advanced, "secret").fill("synthetic-unsaved-token");
        await page.evaluate(() => { window.__settingsDraftInput = document.querySelector('[data-settings-module="alpha"][data-settings-section="general"] [data-setting-key="name"]');
          window.__settingsDraftChain = []; for (let node = __settingsDraftInput; node; node = node.parentElement) __settingsDraftChain.push(node);
          window.__settingsDraftChain.push(document.querySelector(".admin-settings-modules"), ...document.querySelectorAll(".admin-settings-modules > button")); });
        const beta = moduleButton(page, "beta"); await beta.focus(); await beta.press("Enter");
        assert.equal(await beta.evaluate(node => node === document.activeElement), true, "module navigation must retain native focus on its activated button");
        assert.equal(await page.locator('[data-settings-module-panel="alpha"]').isVisible(), false);
        await field(form(page, "beta", "general"), "name").fill("Beta draft");
        const alpha = moduleButton(page, "alpha"); await alpha.focus(); await alpha.press("Enter");
        assert.equal(await field(general, "name").inputValue(), "  Alpha draft  ", "switching settings modules must preserve the user's unsubmitted text");
        assert.equal(await field(general, "enabled").isChecked(), true); assert.equal(await field(general, "mode").inputValue(), "two");
        assert.equal(await field(general, "quota").inputValue(), "2.750");
        assert.equal(await field(advanced, "paths").inputValue(), " first \nfirst\n second ");
        assert.equal(await field(advanced, "secret").inputValue(), "synthetic-unsaved-token");
        assert.equal(await page.evaluate(() => __settingsDraftChain.every(node => node.isConnected)), true, "switching modules must retain complete editable panel ancestry");
        assert.equal(await alpha.evaluate(node => node === document.activeElement), true);
        assert.equal(runtime.calls.filter(call => call.method !== "GET").length, 0);
      } finally { await page.close(); }
    });

    await run("settings drafts saving one section preserves other sections and modules", async () => {
      const { page, runtime } = await open();
      try {
        const general = form(page, "alpha", "general"), advanced = form(page, "alpha", "advanced");
        await moduleButton(page, "beta").click(); await field(form(page, "beta", "general"), "name").fill("Unsubmitted beta"); await moduleButton(page, "alpha").click();
        await field(general, "name").fill("  Saved alpha  "); await field(general, "enabled").check();
        await field(general, "mode").selectOption("two"); await field(general, "quota").fill("2.5");
        await field(advanced, "memo").fill("Unsubmitted other group"); await field(advanced, "paths").fill("one\none\ntwo");
        await field(advanced, "secret").fill("synthetic-unsubmitted-token");
        await general.getByRole("button", { name: "Save general", exact: true }).click(); await saved(page, 1);
        assert.deepEqual(runtime.calls.find(call => call.method === "PATCH").body.values, { name: "Saved alpha", enabled: true, mode: "two", quota: 2.5 * 1024 ** 3 }, "the saved section must retain existing checkbox/select/byte serialization and omit read-only or unrelated fields");
        assert.equal(await field(advanced, "memo").inputValue(), "Unsubmitted other group", "saving one settings section must not clear another section's draft");
        assert.equal(await field(advanced, "paths").inputValue(), "one\none\ntwo"); assert.equal(await field(advanced, "secret").inputValue(), "synthetic-unsubmitted-token");
        await moduleButton(page, "beta").click();
        assert.equal(await field(form(page, "beta", "general"), "name").inputValue(), "Unsubmitted beta", "saving another module must not clear a retained module draft");
      } finally { await page.close(); }
    });

    await run("settings drafts late save yields to newer edits composition and selection", async () => {
      const { page, runtime } = await open();
      const pending = hold(runtime, "PATCH", "/api/admin/settings/alpha");
      try {
        const general = form(page, "alpha", "general"), name = field(general, "name");
        await name.fill("  Submitted alpha  "); await general.getByRole("button", { name: "Save general", exact: true }).click(); await requested(pending);
        await name.fill("Intermediate edit"); await name.fill("  Submitted alpha  ");
        await field(general, "enabled").check(); await field(general, "mode").selectOption("two"); await field(general, "quota").fill("3.25");
        await name.focus(); await name.evaluate(node => { window.__lateSettingsInput = node; window.__lateSettingsForm = node.closest("form"); node.setSelectionRange(2, 11); node.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "合成" })); });
        await settle(page, pending);
        assert.deepEqual(await name.evaluate(node => [node === __lateSettingsInput, node.closest("form") === __lateSettingsForm, node === document.activeElement, node.value, node.selectionStart, node.selectionEnd]),
          [true, true, true, "  Submitted alpha  ", 2, 11], "a late settings save must preserve newer raw input, composition ownership and selection even after a value was changed back");
        assert.equal(await field(general, "enabled").isChecked(), true); assert.equal(await field(general, "mode").inputValue(), "two"); assert.equal(await field(general, "quota").inputValue(), "3.25");
        assert((await general.locator("[data-settings-section-status]").textContent()).includes("保留了后续编辑"), "a confirmed save must distinguish its submitted content from later edits still in the form");
        await name.evaluate(node => node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "合成" })));
      } finally { pending.release(); await page.close(); }
      const reverted = await open();
      const revertingSave = hold(reverted.runtime, "PATCH", "/api/admin/settings/alpha");
      try {
        const general = form(reverted.page, "alpha", "general"), name = field(general, "name"), quota = field(general, "quota");
        const baseline = await name.inputValue();
        await name.fill("Submitted replacement"); await general.getByRole("button", { name: "Save general", exact: true }).click(); await requested(revertingSave);
        await name.fill("A newer temporary edit"); await name.fill(baseline); await quota.focus();
        await name.evaluate(node => { window.__revertedSaveInput = node; }); await settle(reverted.page, revertingSave);
        assert.equal(await name.evaluate(node => node === __revertedSaveInput && node.value === "alpha saved"), true,
          "a late settings save must preserve a new edit reverted to its old baseline without composition or focused-selection guards");
        assert.equal(await quota.evaluate(node => node === document.activeElement), true);
        assert.equal(await reverted.page.evaluate(() => fixture.saved.length), 1);
      } finally { revertingSave.release(); await reverted.page.close(); }
    });

    await run("settings drafts late save preserves a newer native keyboard selection", async () => {
      for (const matchesBaseline of [false, true]) {
        const { page, runtime } = await open();
        const pending = hold(runtime, "PATCH", "/api/admin/settings/alpha");
        try {
          const general = form(page, "alpha", "general"), name = field(general, "name");
          if (matchesBaseline) {
            runtime.modules[0].values.name = " draft "; await page.evaluate(() => fixture.controller.load());
          } else await name.fill(" draft ");
          assert.equal(await name.inputValue(), " draft ");
          await general.getByRole("button", { name: "Save general", exact: true }).click(); await requested(pending);
          assert.equal(pending.entry.body.values.name, "draft");
          await name.evaluate(node => {
            window.__selectionSettingsInput = node; window.__selectionSettingsChain = []; window.__selectionInputEvents = 0;
            for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) __selectionSettingsChain.push(ancestor);
            for (const type of ["input", "change"]) node.addEventListener(type, () => __selectionInputEvents++);
          });
          await name.focus(); await name.press("Home"); await name.press("ArrowRight");
          for (let index = 0; index < 3; index++) await name.press("Shift+ArrowRight");
          assert.deepEqual(await name.evaluate(node => [node.selectionStart, node.selectionEnd, node.selectionDirection, __selectionInputEvents]), [1, 4, "forward", 0],
            "native selection setup must change the selection without editing the field");
          await settle(page, pending);
          assert.deepEqual(await name.evaluate(node => [node === __selectionSettingsInput, __selectionSettingsChain.every(ancestor => ancestor.isConnected), node === document.activeElement,
            node.value, node.selectionStart, node.selectionEnd, node.selectionDirection, __selectionInputEvents]), [true, true, true, " draft ", 1, 4, "forward", 0],
            "a settings acknowledgement must preserve a later native keyboard selection and its raw text without an input event, including an unchanged baseline");
          assert.equal(await page.evaluate(() => fixture.saved.length), 1);
        } finally { pending.release(); await page.close(); }
      }
    });

    await run("settings drafts failed save remains editable and retries once", async () => {
      const { page, runtime } = await open();
      const failed = hold(runtime, "PATCH", "/api/admin/settings/alpha", "Synthetic settings save failure");
      try {
        const general = form(page, "alpha", "general"), name = field(general, "name"); await name.fill("Retry draft");
        await general.getByRole("button", { name: "Save general", exact: true }).click(); await requested(failed);
        await general.evaluate(node => { node.requestSubmit(); node.requestSubmit(); }); await frames(page);
        assert.equal(runtime.calls.filter(call => call.method === "PATCH").length, 1, "one settings section must reject duplicate pending submissions");
        await name.focus(); await name.fill("New retry draft"); await settle(page, failed);
        assert.equal(await name.inputValue(), "New retry draft"); assert.equal(await name.evaluate(node => node === document.activeElement), true);
        assert((await page.locator("#status").textContent()).includes("Synthetic settings save failure"));
        const retry = general.getByRole("button", { name: "Save general", exact: true }); assert.equal(await retry.isEnabled(), true);
        await retry.focus(); await retry.press("Space"); await saved(page, 1);
        assert.equal(runtime.calls.filter(call => call.method === "PATCH").length, 2);
        assert.equal(runtime.modules[0].values.name, "New retry draft");
      } finally { failed.release(); await page.close(); }
    });

    await run("settings drafts write-only values clear only an unchanged acknowledged edit", async () => {
      const { page, runtime } = await open();
      const pending = hold(runtime, "PATCH", "/api/admin/settings/alpha");
      try {
        const advanced = form(page, "alpha", "advanced"), secret = field(advanced, "secret");
        await field(advanced, "paths").fill("one, two\none\n three "); await secret.fill("synthetic-token-v1");
        await advanced.getByRole("button", { name: "Save advanced", exact: true }).click(); await requested(pending);
        assert.deepEqual(pending.entry.body.values.paths, ["one", "two", "three"]);
        await secret.fill("synthetic-intermediate"); await secret.fill("synthetic-token-v1"); await settle(page, pending);
        assert.equal(await secret.inputValue(), "synthetic-token-v1", "an acknowledged write-only field must not clear an edit made after submission, even if its final value matches");
        await advanced.getByRole("button", { name: "Save advanced", exact: true }).click(); await saved(page, 2);
        assert.equal(await secret.inputValue(), "", "an unchanged acknowledged write-only value must be cleared from the browser");
        assert(runtime.responses.filter(value => value.module).every(value => !Object.hasOwn(value.module.values, "secret")), "synthetic server receipts must stay redacted");
      } finally { pending.release(); await page.close(); }
    });

    await run("settings drafts newer reads win without replacing local edits", async () => {
      for (const error of ["", "Obsolete settings read failure"]) {
        const { page, runtime } = await open();
        const old = hold(runtime, "GET", "/api/admin/settings", error);
        let newer;
        try {
          await field(form(page, "alpha", "general"), "name").fill("Local read draft"); await startLoad(page); await requested(old);
          runtime.modules[0].values.quota = 4 * 1024 ** 3; runtime.modules[1].values.name = "New server beta";
          newer = hold(runtime, "GET", "/api/admin/settings"); await startLoad(page); await requested(newer); await settle(page, newer); await settle(page, old);
          assert.equal(await field(form(page, "alpha", "general"), "name").inputValue(), "Local read draft", "catalog reloads must preserve dirty settings fields");
          assert.equal(await field(form(page, "alpha", "general"), "quota").inputValue(), "4", "an older catalog response must not replace a newer clean value");
          assert(!(await page.locator("#status").textContent()).includes("Obsolete settings read failure"));
          await moduleButton(page, "beta").click(); assert.equal(await field(form(page, "beta", "general"), "name").inputValue(), "New server beta");
          const beta = field(form(page, "beta", "general"), "name"); await beta.fill("Draft during catalog failure");
          const failed = hold(runtime, "GET", "/api/admin/settings", "Current catalog unavailable");
          try {
            await page.evaluate(() => { fixture.pending.push(fixture.controller.load()); }); await requested(failed); await beta.focus();
            await beta.evaluate(node => { window.__failedCatalogInput = node; }); await settle(page, failed);
            assert.equal(await beta.evaluate(node => node === __failedCatalogInput && node === document.activeElement && node.value === "Draft during catalog failure"), true,
              "a current catalog read failure must preserve usable settings controls and their draft");
            await page.evaluate(() => fixture.controller.load()); await frames(page);
            assert.equal(await beta.inputValue(), "Draft during catalog failure");
            assert(!(await page.locator("#status").textContent()).includes("Current catalog unavailable"));
            assert.equal(await page.locator("#summary").textContent(), "2 个模块 · 4 组设置", "a successful catalog retry must clear its failed summary");
          } finally { failed.release(); }
        } finally { old.release(); newer?.release(); await page.close(); }
      }
      const reverted = await open();
      const revertingRead = hold(reverted.runtime, "GET", "/api/admin/settings");
      try {
        const general = form(reverted.page, "alpha", "general"), name = field(general, "name"), quota = field(general, "quota");
        const baseline = await name.inputValue();
        reverted.runtime.modules[0].values.name = "New remote title"; reverted.runtime.modules[0].values.quota = 5 * 1024 ** 3;
        await startLoad(reverted.page); await requested(revertingRead);
        await name.fill("A newer temporary read edit"); await name.fill(baseline); await quota.focus();
        await name.evaluate(node => { window.__revertedReadInput = node; }); await settle(reverted.page, revertingRead);
        assert.equal(await name.evaluate(node => node === __revertedReadInput && node.value === "alpha saved"), true,
          "a pending catalog must preserve a new edit reverted to its old baseline without composition or focused-selection guards");
        assert.equal(await quota.inputValue(), "5", "a catalog must still refresh untouched settings fields alongside the protected reverted input");
        assert.equal(await quota.evaluate(node => node === document.activeElement), true);
        assert.equal(reverted.runtime.calls.filter(call => call.method !== "GET").length, 0);
      } finally { revertingRead.release(); await reverted.page.close(); }
    });

    await run("settings drafts a read started before saving cannot revert the acknowledgement", async () => {
      const { page, runtime } = await open();
      const old = hold(runtime, "GET", "/api/admin/settings");
      try {
        await startLoad(page); await requested(old);
        const general = form(page, "alpha", "general"); await field(general, "name").fill("Confirmed after read started");
        await general.getByRole("button", { name: "Save general", exact: true }).click(); await saved(page, 1); await settle(page, old);
        assert.equal(await field(general, "name").inputValue(), "Confirmed after read started", "a catalog read captured before a confirmed settings write must not roll it back");
        assert.equal(runtime.calls.filter(call => call.method === "GET").length, 3, "a read invalidated by a confirmed write must obtain a fresh catalog once");
      } finally { old.release(); await page.close(); }
    });

    await run("settings drafts parallel section acknowledgements preserve both confirmed groups", async () => {
      const { page, runtime } = await open();
      const first = hold(runtime, "PATCH", "/api/admin/settings/alpha"), second = hold(runtime, "PATCH", "/api/admin/settings/alpha");
      try {
        const general = form(page, "alpha", "general"), advanced = form(page, "alpha", "advanced");
        await field(general, "name").fill("General confirmed"); await general.getByRole("button", { name: "Save general", exact: true }).click(); await requested(first);
        await field(advanced, "memo").fill("Advanced confirmed"); await advanced.getByRole("button", { name: "Save advanced", exact: true }).click(); await requested(second);
        await settle(page, second); await settle(page, first);
        assert.equal(await field(general, "name").inputValue(), "General confirmed");
        assert.equal(await field(advanced, "memo").inputValue(), "Advanced confirmed", "a late full-module acknowledgement must not revert another section already confirmed by a newer response");
        assert.equal((await page.evaluate(() => fixture.saved.length)), 2);
      } finally { first.release(); second.release(); await page.close(); }
    });

    await run("settings drafts actions preserve edits and retired controls cannot submit", async () => {
      const { page, runtime } = await open();
      const action = hold(runtime, "POST", "/api/admin/settings/alpha/actions/probe");
      action.result = { ok: false, message: "Synthetic business failure" };
      try {
        const general = form(page, "alpha", "general"), advanced = form(page, "alpha", "advanced");
        await field(general, "name").fill("Draft before action"); await field(advanced, "secret").fill("synthetic-action-draft");
        const retired = await advanced.elementHandle();
        await advanced.getByRole("button", { name: "Probe alpha", exact: true }).click(); await requested(action);
        assert.deepEqual(action.entry.body, {}, "a settings action must not send the module's unsubmitted form values");
        await general.evaluate(node => node.requestSubmit()); await frames(page);
        assert.equal(runtime.calls.filter(call => call.method === "PATCH").length, 0, "an action must exclude concurrent mutations in the same module");
        await moduleButton(page, "beta").click(); const beta = field(form(page, "beta", "general"), "name"); await beta.fill("Beta while action waits");
        await settle(page, action);
        assert.equal(await beta.inputValue(), "Beta while action waits", "an action acknowledgement must not clear another module's current draft");
        assert.equal(await beta.evaluate(node => node === document.activeElement), true);
        const before = runtime.calls.length;
        await retired.evaluate(node => { node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); node.querySelector("[data-settings-action]")?.click(); }); await frames(page);
        assert.equal(runtime.calls.length, before, "hidden or retired settings controls must not write into the currently active module");
        await moduleButton(page, "alpha").click();
        assert.equal(await field(general, "name").inputValue(), "Draft before action"); assert.equal(await field(advanced, "secret").inputValue(), "synthetic-action-draft");
        assert((await advanced.locator("[data-settings-section-status]").textContent()).includes("Synthetic business failure"), "HTTP 200 business failure must remain visible in its own section");
        assert.equal(await advanced.locator("[data-settings-section-status]").evaluate(node => node.classList.contains("error")), true);
        assert.equal(await page.evaluate(() => fixture.saved.length), 1, "one acknowledged action must notify its host exactly once even when its result reports a business failure");
      } finally { action.release(); await page.close(); }
      const reverted = await open();
      const revertingAction = hold(reverted.runtime, "POST", "/api/admin/settings/alpha/actions/probe");
      try {
        const general = form(reverted.page, "alpha", "general"), advanced = form(reverted.page, "alpha", "advanced");
        const name = field(general, "name"), quota = field(general, "quota"), baseline = await name.inputValue();
        reverted.runtime.modules[0].values.name = "Remote action value"; reverted.runtime.modules[0].values.quota = 4 * 1024 ** 3;
        await advanced.getByRole("button", { name: "Probe alpha", exact: true }).click(); await requested(revertingAction);
        assert.deepEqual(revertingAction.entry.body, {});
        await name.fill("A newer temporary action edit"); await name.fill(baseline); await quota.focus();
        await name.evaluate(node => { window.__revertedActionInput = node; }); await settle(reverted.page, revertingAction);
        assert.equal(await name.evaluate(node => node === __revertedActionInput && node.value === "alpha saved"), true,
          "an action acknowledgement must preserve a new edit reverted to its old baseline without composition or focused-selection guards");
        assert.equal(await quota.inputValue(), "4", "an action must still refresh untouched settings fields alongside the protected reverted input");
        assert.equal(await quota.evaluate(node => node === document.activeElement), true);
        assert.equal(await reverted.page.evaluate(() => fixture.saved.length), 1);
      } finally { revertingAction.release(); await reverted.page.close(); }
    });
    await run("settings drafts inactive hosts cannot submit or receive stale global feedback", async () => {
      for (const error of ["", "Synthetic inactive save failure"]) {
        const { page, runtime } = await open();
        const pending = hold(runtime, "PATCH", "/api/admin/settings/alpha", error);
        try {
          const general = form(page, "alpha", "general"), name = field(general, "name"); await name.fill("Submitted before leaving");
          await general.getByRole("button", { name: "Save general", exact: true }).click(); await requested(pending);
          await page.evaluate(() => { fixture.active = false; document.querySelector("#settings").inert = true;
            document.querySelector("#status").textContent = "Other host status"; document.querySelector("#summary").textContent = "Other host summary"; });
          await page.locator("#outside").focus();
          const calls = runtime.calls.length;
          await general.evaluate(node => node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
          await form(page, "alpha", "advanced").locator("[data-settings-action]").evaluate(node => node.click()); await frames(page);
          assert.equal(runtime.calls.length, calls, "inactive settings controls must not create writes in a different host view");
          await settle(page, pending);
          assert.deepEqual(await page.evaluate(() => [document.activeElement.id, document.querySelector("#status").textContent, document.querySelector("#summary").textContent]),
            ["outside", "Other host status", "Other host summary"], "a departed settings operation must not replace another host's focus or global feedback");
          await page.evaluate(() => { fixture.active = true; document.querySelector("#settings").inert = false; fixture.controller.render(); });
          assert.equal(await name.inputValue(), "Submitted before leaving");
          if (error) assert((await general.locator("[data-settings-section-status]").textContent()).includes(error));
          assert.equal(await page.evaluate(() => fixture.saved.length), error ? 0 : 1);
        } finally { pending.release(); await page.close(); }
      }
    });
    assert(checks > 0, `no settings case matched ${casePattern}`); assert.deepEqual(faults, [], "browser errors must remain visible");
    console.log(`Web settings drafts passed (${checks} actual-controller Chromium scenarios)`); return { checks };
  } finally { for (const gate of held) gate.release(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

  async function run(name, task) { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); }
  async function open(width = 1280) {
    const runtime = { modules: fixtureModules(), calls: [], responses: [] };
    const page = await browser.newPage({ viewport: { width, height: 820 } }); page.setDefaultTimeout(5000); page.on("pageerror", error => faults.push(error.message));
    await page.exposeFunction("__settingsApi", async (url, options, id) => {
      const entry = { id, url, method: options.method || "GET", body: options.body || null }; runtime.calls.push(entry);
      const gate = [...held].find(value => value.runtime === runtime && !value.used && value.method === entry.method && value.url === url);
      if (gate) { gate.used = true; gate.entry = entry; gate.arrived(); }
      let response;
      if (entry.method === "GET" && url === "/api/admin/settings") response = { modules: runtime.modules.map(snapshot) };
      else {
        const match = /^\/api\/admin\/settings\/([^/]+)(?:\/actions\/([^/]+))?$/.exec(url);
        assert(match, `unmodelled settings path ${url}`); const module = runtime.modules.find(value => value.id === decodeURIComponent(match[1])); assert(module);
        if (entry.method === "PATCH" && !match[2]) {
          if (!gate?.error) Object.assign(module.values, structuredClone(entry.body.values));
          response = { module: snapshot(module) };
        } else {
          assert(entry.method === "POST" && match[2] === "probe"); response = { module: snapshot(module), action: { result: gate?.result || { ok: true, message: "Synthetic action completed" } } };
        }
      }
      if (gate) await gate.wait;
      if (gate?.error) throw new Error(gate.error);
      runtime.responses.push(structuredClone(response)); return response;
    });
    await page.goto(base); await page.waitForFunction(() => fixture.ready === true); return { page, runtime };
  }
  function hold(runtime, method, url, error = "") {
    let arrived, release; const gate = { runtime, method, url, error, used: false,
      requested: new Promise(resolve => { arrived = resolve; }), wait: new Promise(resolve => { release = resolve; }),
      arrived: () => arrived(), release: () => { held.delete(gate); release(); } };
    held.add(gate); return gate;
  }
}

function form(page, module, section) { return page.locator(`form[data-settings-module="${module}"][data-settings-section="${section}"]`); }
function field(form, key) { return form.locator(`[data-setting-key="${key}"]`); }
function moduleButton(page, module) { return page.locator(`button[data-settings-module="${module}"]:not([data-settings-section])`); }
async function frames(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function requested(gate) { let timer; try { await Promise.race([gate.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`expected controlled ${gate.method} ${gate.url}`)), 5000); })]); } finally { clearTimeout(timer); } }
async function settle(page, gate) { gate.release(); await page.waitForFunction(id => fixture.settled.includes(id), gate.entry.id); await frames(page); }
async function saved(page, count) { await page.waitForFunction(count => fixture.saved.length >= count, count); await frames(page); }
async function startLoad(page) { await page.evaluate(() => { fixture.pending.push(fixture.controller.load({ quiet: true })); }); }
function snapshot(module) { const value = structuredClone(module); delete value.values.secret; value.status = { fields: { secret: { configured: Boolean(module.values.secret), label: module.values.secret ? "Configured" : "Not configured" } } }; return value; }
function fixtureModules() {
  return ["alpha", "beta"].map(id => ({ id, title: id === "alpha" ? "Alpha" : "Beta", description: "Synthetic module settings", schema: { sections: [
    { id: "general", title: "General", saveLabel: "Save general", fields: [
      { key: "name", type: "string", label: `${id} title` }, { key: "enabled", type: "boolean", label: `${id} enabled` },
      { key: "mode", type: "select", label: `${id} mode`, options: [{ value: "one", label: "One" }, { value: "two", label: "Two" }] },
      { key: "quota", type: "bytes", unit: "GB", step: "0.25", label: `${id} quota` }, { key: "version", readOnly: true, label: "Read-only version" }
    ] },
    { id: "advanced", title: "Advanced", saveLabel: "Save advanced", fields: [
      { key: "memo", type: "string", label: `${id} note` }, { key: "paths", type: "string-list", rows: 3, label: `${id} paths` },
      { key: "secret", type: "secret", writeOnly: true, label: `${id} synthetic token` }
    ], actions: [{ id: "probe", label: `Probe ${id}` }] }
  ] }, values: { name: `${id} saved`, enabled: false, mode: "one", quota: 2 * 1024 ** 3, version: "synthetic-v1", memo: `${id} note saved`, paths: ["/synthetic/one"], secret: "" } }));
}
function harness() {
  return `<!doctype html><meta charset="utf-8"><title>Synthetic settings</title><link rel="stylesheet" href="/css/foundation.css"><link rel="stylesheet" href="/modules/system/admin.css"><link rel="stylesheet" href="/css/responsive.css"><main><input id="outside" aria-label="Other host input"><p id="summary"></p><p id="status" role="status"></p><div id="settings" class="admin-settings-layout"></div></main><script type="module">
import {createSettingsController} from '${controllerUrl}';
window.fixture={saved:[],settled:[],pending:[],serial:0,ready:false,active:true};
const api=async(url,options={})=>{const id=++fixture.serial;try{return await window.__settingsApi(url,{method:options.method,body:options.body},id);}finally{fixture.settled.push(id);}};
fixture.controller=createSettingsController({api,root:document.querySelector('#settings'),summary:document.querySelector('#summary'),status:document.querySelector('#status'),isActive:()=>fixture.active,onSaved:module=>{fixture.saved.push(module.id);}});
fixture.ready=await fixture.controller.load();
</script>`;
}
function send(res, body, type) { res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" }); res.end(body); }
async function runNegativeControls() {
  const source = fs.readFileSync(path.join(publicRoot, controllerUrl), "utf8");
  let checks = 0;
  for (const control of [
    { name: "retained settings ancestry", marker: 'if (navigation?.parentElement !== root || content?.parentElement !== root) {', replacement: "if (true) {",
      pattern: "late save yields", failure: /a late settings save must preserve newer raw input, composition ownership and selection/ },
    { name: "post-submission edit revision", marker: "submitted && submitted.revision === binding.revision && submitted.value === value", replacement: "submitted && submitted.value === value",
      pattern: "write-only values", failure: /an acknowledged write-only field must not clear an edit made after submission/ },
    { name: "section-scoped receipt merge", marker: 'if (request.kind === "action") modules[index] = nextModule;', replacement: "if (true) modules[index] = nextModule;",
      pattern: "parallel section", failure: /a late full-module acknowledgement must not revert another section already confirmed/ },
    { name: "catalog write generation", marker: "// A catalog captured before a write cannot undo its confirmed receipt.\n        if (version !== writeVersion || mutations.size) continue;", replacement: "// Negative control publishes the obsolete catalog.",
      pattern: "a read started before", failure: /a read invalidated by a confirmed write must obtain a fresh catalog once/ },
    { name: "newer native selection ownership", marker: "const selectedLater = submitted && document.activeElement === control && selection && submitted.selection\n            && (selection.start !== submitted.selection.start || selection.end !== submitted.selection.end || selection.direction !== submitted.selection.direction);", replacement: "const selectedLater = false;",
      pattern: "late save preserves a newer native keyboard selection", failure: /a settings acknowledgement must preserve a later native keyboard selection and its raw text without an input event/ },
    { name: "catalog post-request edit revision", marker: "const editedAfterRead = observed && (observed.revision !== binding.revision || (document.activeElement === control && selection && observed.selection\n            && (selection.start !== observed.selection.start || selection.end !== observed.selection.end || selection.direction !== observed.selection.direction)));", replacement: "const editedAfterRead = false;",
      pattern: "newer reads win", failure: /a pending catalog must preserve a new edit reverted to its old baseline/ }
  ]) {
    const normalized = source.replaceAll("\r\n", "\n");
    assert.equal(normalized.split(control.marker).length, 2, `negative control source marker must be unique: ${control.name}`);
    await assert.rejects(() => runWebSettingsFixture({ casePattern: control.pattern, sourceOverride: normalized.replace(control.marker, control.replacement) }),
      { name: "AssertionError", message: control.failure });
    checks++; console.log(`PASS negative control detects missing ${control.name}`);
  }
  return checks;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pattern = process.argv.find(value => value.startsWith("--case="))?.slice(7) || "";
  const sourceFile = process.argv.find(value => value.startsWith("--source-file="))?.slice(14);
  const negativeOnly = process.argv.includes("--negative-only");
  assert(!(negativeOnly && (pattern || sourceFile)), "--negative-only cannot be combined with --case or --source-file");
  const current = negativeOnly ? null : await runWebSettingsFixture({ casePattern: pattern, sourceOverride: sourceFile ? fs.readFileSync(sourceFile, "utf8") : null });
  if (!pattern && !sourceFile) {
    if (!negativeOnly) assert.equal(current.checks, 11, "the default settings browser entry must exercise all current scenarios");
    const negatives = await runNegativeControls();
    assert.equal(negatives, 6, "the settings browser entry must retain its behavior negative controls");
    console.log(`Web settings drafts complete (${current?.checks || 0} actual-controller Chromium scenarios + ${negatives} behavior negative controls; synthetic API and composition only)`);
  }
}
