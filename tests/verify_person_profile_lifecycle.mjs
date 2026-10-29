import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");
const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].filter(Boolean).find(value => fs.existsSync(value));
assert(executablePath, "Chrome or Edge required for the private person-profile fixture");

// The real lazy wrapper and person-profile module run in Chromium. Every API,
// person, folder and write is synthetic; no application service is contacted.
export async function runPersonProfileFixture({ sourceOverrides = {}, casePattern = "" } = {}) {
  const held = new Set(), requests = [], faults = [];
  let checks = 0;
  const person = id => ({ id, name: `Person ${id}`, workCount: 1, videoCount: 1, sourcePaths: [], actorProfile: { displayName: `Person ${id}`, javdbUrl: `https://example.invalid/actors/${id}` } });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    const json = (body, status = 200) => { if (!res.destroyed) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); } };
    try {
      const body = ["PUT", "POST"].includes(req.method) ? JSON.parse(await readBody(req)) : null;
      requests.push({ path: url.pathname, method: req.method, body });
      const gate = [...held].find(item => !item.used && item.path === url.pathname && item.method === req.method && (!item.matches || item.matches(body)));
      if (gate) { gate.used = true; gate.requestedResolve(); res.once("close", () => { gate.closed = true; }); await gate.promise; if (gate.status !== 200 || gate.body) { json(gate.body || { error: "Synthetic failure" }, gate.status); return; } }
      const mapping = /^\/api\/admin\/person-mapping\/([AB])$/.exec(url.pathname);
      const profile = /^\/api\/actor-profiles\/([AB])$/.exec(url.pathname);
      const merge = /^\/api\/people\/([AB])\/merge$/.exec(url.pathname);
      const details = /^\/api\/people\/([AB])$/.exec(url.pathname);
      if (mapping && req.method === "GET") { json({ person: person(mapping[1]), sourceCandidates: [] }); return; }
      if (profile && req.method === "PUT") { assert(body.idempotencyKey); json({ profile: { ...person(profile[1]).actorProfile, displayName: body.displayName }, mergeCandidates: [] }); return; }
      if (profile && req.method === "GET") { json({ profile: person(profile[1]).actorProfile, mergeCandidates: [] }); return; }
      if (url.pathname === "/api/actor-profile-operations/op-A") { json({ operation: { id: "op-A", status: "completed" } }); return; }
      if (merge && req.method === "POST" && body.preview) { json({ workCount: 2, warnings: [] }); return; }
      if (merge && req.method === "POST") { assert.deepEqual(body.sourcePersonIds, ["B"]); json({ person: person(merge[1]) }); return; }
      if (details && req.method === "GET") { json({ person: person(details[1]), works: [] }); return; }
      if (url.pathname.startsWith("/api/")) { faults.push(`unexpected synthetic API ${req.method} ${url.pathname}`); json({ error: "Unmodelled API" }, 404); return; }
      if (url.pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
      let content, type;
      if (url.pathname === "/") { content = harness(); type = "text/html"; }
      else {
        const target = path.resolve(publicRoot, url.pathname.replace(/^\/+/, ""));
        assert(target.startsWith(`${publicRoot}${path.sep}`));
        content = sourceOverrides[url.pathname] || await fs.promises.readFile(target);
        type = target.endsWith(".js") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "image/svg+xml";
      }
      res.writeHead(200, { "content-type": type }); res.end(content);
    } catch (error) { faults.push(error.message); json({ error: error.message }, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  const run = async (name, task) => { if (casePattern && !name.includes(casePattern)) return; await task(); checks++; console.log(`PASS ${name}`); };
  const hold = (method, pathname, body = null, status = 200, matches = null) => {
    let release, requestedResolve;
    const gate = { method, path: pathname, body, status, matches, used: false, requested: new Promise(resolve => { requestedResolve = resolve; }), promise: new Promise(resolve => { release = resolve; }), release: () => { held.delete(gate); release(); }, requestedResolve: () => requestedResolve() };
    held.add(gate); return gate;
  };
  async function open({ waitMapping = true, ignoreAbort = true } = {}) {
    const page = await browser.newPage(); page.on("pageerror", error => faults.push(error.message));
    await page.goto(`${base}/?ignoreAbort=${ignoreAbort ? 1 : 0}`); await page.waitForFunction(() => window.fixture?.ready);
    await page.locator("#personProfile").getByRole("button", { name: "编辑映射", exact: true }).click();
    if (waitMapping) await page.waitForFunction(() => document.querySelector(".mapping-status")?.textContent === "映射已同步");
    return page;
  }
  async function settle(page, gate) {
    const before = await page.evaluate(() => fixture.settled);
    gate.release(); await page.waitForFunction(before => fixture.settled > before, before); await page.waitForTimeout(30);
  }
  try {
    await run("current profile save retains its person and idempotent request", async () => {
      const page = await open();
      try {
        await page.locator(".mapping-modal").getByLabel("显示名", { exact: true }).fill("Edited A");
        await page.locator(".mapping-modal").getByRole("button", { name: "保存映射", exact: true }).click();
        await page.waitForFunction(() => fixture.selections.length === 1);
        assert.deepEqual(await page.evaluate(() => fixture.selections), ["A"]);
        assert.equal(await page.locator(".mapping-status").textContent(), "已保存");
        assert.equal(await page.locator(".mapping-modal").getByRole("button", { name: "保存映射", exact: true }).isEnabled(), true);
      } finally { await page.close(); }
    });
    await run("closed profile save cannot merge or navigate over another person", async () => {
      const page = await open();
      const saved = hold("PUT", "/api/actor-profiles/A", { profile: person("A").actorProfile, mergeCandidates: [{ id: "B", name: "Person B", workCount: 1 }] });
      try {
        const beforeMerges = requests.filter(item => item.path === "/api/people/A/merge").length;
        page.on("dialog", dialog => dialog.dismiss());
        await page.locator(".mapping-modal").getByRole("button", { name: "保存映射", exact: true }).click(); await saved.requested;
        await page.locator(".mapping-modal").getByRole("button", { name: "关闭", exact: true }).click();
        assert.equal(saved.closed, undefined, "closing must preserve a write already accepted by the server");
        await page.evaluate(() => fixture.show("B"));
        await settle(page, saved);
        assert.equal(await page.evaluate(() => fixture.state.selectedPersonId), "B", "a completed old save must not navigate back to its person");
        assert.deepEqual(await page.evaluate(() => fixture.selections), []);
        assert.equal(requests.filter(item => item.path === "/api/people/A/merge").length, beforeMerges, "a closed editor must not start a merge preview or confirmation");
        assert.equal(await page.locator(".mapping-modal").count(), 0);
      } finally { saved.release(); await page.close(); }
    });
    await run("current save failure remains visible and can be retried", async () => {
      const page = await open(), failed = hold("PUT", "/api/actor-profiles/A", { error: "Synthetic invalid mapping" }, 400);
      try {
        await page.locator(".mapping-modal").getByRole("button", { name: "保存映射", exact: true }).click(); await failed.requested; await settle(page, failed);
        assert.equal(await page.locator(".mapping-status").textContent(), "Synthetic invalid mapping");
        assert.equal(await page.locator(".mapping-modal").getByRole("button", { name: "保存映射", exact: true }).isEnabled(), true);
        await page.locator(".mapping-modal").getByRole("button", { name: "保存映射", exact: true }).click();
        await page.waitForFunction(() => fixture.selections.length === 1);
        assert.equal(await page.locator(".mapping-status").textContent(), "已保存");
      } finally { failed.release(); await page.close(); }
    });
    await run("transient save retry keeps the same idempotency key", async () => {
      const page = await open(), failed = hold("PUT", "/api/actor-profiles/A", { error: "Synthetic temporary failure" }, 503);
      try {
        const before = requests.length;
        await page.locator(".mapping-modal").getByRole("button", { name: "保存映射", exact: true }).click(); await failed.requested; await settle(page, failed);
        await page.waitForFunction(() => fixture.selections.length === 1);
        const writes = requests.slice(before).filter(item => item.path === "/api/actor-profiles/A" && item.method === "PUT");
        assert.equal(writes.length, 2);
        assert.deepEqual(writes[0].body, writes[1].body, "a network retry must retain its original identity and payload");
      } finally { failed.release(); await page.close(); }
    });
    for (const target of ["other person", "leave", "reopened editor"]) await run(`pending profile save cannot replace ${target}`, async () => {
      const page = await open(), saved = hold("PUT", "/api/actor-profiles/A");
      try {
        await page.locator(".mapping-modal").getByRole("button", { name: "保存映射", exact: true }).click(); await saved.requested;
        if (target === "other person") await page.evaluate(() => fixture.show("B"));
        else if (target === "leave") await page.evaluate(() => fixture.hide());
        else {
          await page.locator(".mapping-modal").getByRole("button", { name: "关闭", exact: true }).click();
          await page.locator("#personProfile").getByRole("button", { name: "编辑映射", exact: true }).click();
          await page.waitForFunction(() => document.querySelector(".mapping-status")?.textContent === "映射已同步");
          await page.locator(".mapping-modal").getByLabel("显示名", { exact: true }).fill("New unsaved draft");
        }
        await settle(page, saved);
        assert.deepEqual(await page.evaluate(() => fixture.selections), []);
        assert.equal(await page.locator(".mapping-modal").count(), target === "reopened editor" ? 1 : 0, "navigation must dispose the old editor through the actual lazy wrapper");
        if (target === "reopened editor") {
          assert.equal(await page.locator(".mapping-modal").getByLabel("显示名", { exact: true }).inputValue(), "New unsaved draft");
          assert.equal(await page.locator(".mapping-status").textContent(), "映射已同步");
        }
      } finally { saved.release(); await page.close(); }
    });
    for (const ignoreAbort of [true, false]) await run(`closing editor aborts mapping reads ${ignoreAbort ? "ignored" : "honored"} transport`, async () => {
      const read = hold("GET", "/api/admin/person-mapping/A"), page = await open({ waitMapping: false, ignoreAbort });
      try {
        await read.requested;
        await page.evaluate(() => fixture.hide());
        assert.equal(await page.evaluate(() => fixture.signals.find(item => item.path.startsWith("/api/admin/person-mapping/")).signal.aborted), true);
        read.release(); await page.waitForTimeout(40);
        assert.equal(await page.locator(".mapping-modal").count(), 0);
        assert.equal(await page.locator("#personProfile").isHidden(), true);
      } finally { read.release(); await page.close(); }
    });
    await run("same-person redraw keeps the open form and draft", async () => {
      const page = await open();
      try {
        await page.locator(".mapping-modal").getByLabel("显示名", { exact: true }).fill("Unsaved draft");
        await page.evaluate(() => { fixture.editor = document.querySelector(".mapping-modal"); return fixture.show("A"); });
        assert.equal(await page.evaluate(() => fixture.editor === document.querySelector(".mapping-modal")), true);
        assert.equal(await page.locator(".mapping-modal").getByLabel("显示名", { exact: true }).inputValue(), "Unsaved draft");
      } finally { await page.close(); }
    });
    await run("closed save cannot start its following external refresh task", async () => {
      const page = await open(), saved = hold("PUT", "/api/actor-profiles/A");
      try {
        const before = requests.filter(item => item.path === "/api/admin/refresh-actor-movies").length;
        await page.locator(".mapping-modal").getByRole("button", { name: "访问 JavDB 更新片单", exact: true }).click(); await saved.requested;
        await page.locator(".mapping-modal").getByRole("button", { name: "关闭", exact: true }).click(); await settle(page, saved);
        assert.equal(requests.filter(item => item.path === "/api/admin/refresh-actor-movies").length, before, "only the accepted save may finish after close");
        assert.deepEqual(await page.evaluate(() => fixture.selections), []);
      } finally { saved.release(); await page.close(); }
    });
    await run("closing during merge preview prevents a later confirmation or merge", async () => {
      const page = await open();
      const saved = hold("PUT", "/api/actor-profiles/A", { profile: person("A").actorProfile, mergeCandidates: [{ id: "B", name: "Person B" }] });
      const preview = hold("POST", "/api/people/A/merge", { workCount: 2, warnings: [] }, 200, body => body.preview === true);
      try {
        let dialogs = 0; page.on("dialog", dialog => { dialogs++; return dialog.dismiss(); });
        await page.locator(".mapping-modal").getByRole("button", { name: "保存映射", exact: true }).click(); await saved.requested; await settle(page, saved); await preview.requested;
        await page.evaluate(() => fixture.show("B")); await settle(page, preview);
        assert.equal(dialogs, 0, "a stale preview must not ask for identity decisions");
        assert.equal(await page.evaluate(() => fixture.state.selectedPersonId), "B");
        assert.deepEqual(await page.evaluate(() => fixture.selections), []);
      } finally { saved.release(); preview.release(); await page.close(); }
    });
    await run("current merge still requires and honors confirmation", async () => {
      const page = await open();
      const saved = hold("PUT", "/api/actor-profiles/A", { profile: person("A").actorProfile, mergeCandidates: [{ id: "B", name: "Person B" }] });
      try {
        let dialogs = 0; page.on("dialog", dialog => { dialogs++; return dialog.accept(); });
        await page.locator(".mapping-modal").getByRole("button", { name: "保存映射", exact: true }).click(); await saved.requested; await settle(page, saved);
        await page.waitForFunction(() => fixture.selections.length === 1);
        assert.equal(dialogs, 1);
        assert.equal(await page.locator(".mapping-status").textContent(), "已保存并合并人物");
      } finally { saved.release(); await page.close(); }
    });
    await run("accepted merge finishes without taking over a later person", async () => {
      const page = await open();
      const saved = hold("PUT", "/api/actor-profiles/A", { profile: person("A").actorProfile, mergeCandidates: [{ id: "B", name: "Person B" }] });
      const merge = hold("POST", "/api/people/A/merge", { person: person("A") }, 200, body => !body.preview);
      try {
        page.on("dialog", dialog => dialog.accept());
        await page.locator(".mapping-modal").getByRole("button", { name: "保存映射", exact: true }).click(); await saved.requested; await settle(page, saved); await merge.requested;
        await page.evaluate(() => fixture.show("B"));
        assert.equal(merge.closed, undefined, "the accepted merge write must not be aborted by navigation");
        await settle(page, merge);
        assert.equal(await page.evaluate(() => fixture.state.selectedPersonId), "B");
        assert.deepEqual(await page.evaluate(() => fixture.selections), []);
      } finally { saved.release(); merge.release(); await page.close(); }
    });
    await run("accepted profile operation still polls and consumes its completed profile", async () => {
      const page = await open(), saved = hold("PUT", "/api/actor-profiles/A", { operation: { id: "op-A", status: "running" } });
      try {
        const before = requests.length;
        await page.locator(".mapping-modal").getByRole("button", { name: "保存映射", exact: true }).click(); await saved.requested; await settle(page, saved);
        await page.waitForFunction(() => fixture.selections.length === 1);
        assert(requests.slice(before).some(item => item.path === "/api/actor-profile-operations/op-A"));
        assert(requests.slice(before).some(item => item.path === "/api/actor-profiles/A" && item.method === "GET"));
        assert.equal(await page.locator(".mapping-status").textContent(), "已保存");
      } finally { saved.release(); await page.close(); }
    });
    await run("closing during operation polling stops later profile reads", async () => {
      const page = await open(), saved = hold("PUT", "/api/actor-profiles/A", { operation: { id: "op-A", status: "running" } });
      const poll = hold("GET", "/api/actor-profile-operations/op-A", { operation: { id: "op-A", status: "completed" } });
      try {
        await page.locator(".mapping-modal").getByRole("button", { name: "保存映射", exact: true }).click(); await saved.requested; await settle(page, saved); await poll.requested;
        const before = requests.filter(item => item.path === "/api/actor-profiles/A" && item.method === "GET").length;
        await page.evaluate(() => fixture.hide());
        assert.equal(await page.evaluate(() => fixture.signals.find(item => item.path === "/api/actor-profile-operations/op-A").signal.aborted), true);
        await settle(page, poll); await page.waitForTimeout(300);
        assert.equal(requests.filter(item => item.path === "/api/actor-profiles/A" && item.method === "GET").length, before);
        assert.deepEqual(await page.evaluate(() => fixture.selections), []);
      } finally { saved.release(); poll.release(); await page.close(); }
    });
    await run("detached mapping controls cannot submit or open another popup", async () => {
      const page = await open();
      try {
        await page.evaluate(() => { fixture.oldControls = [...document.querySelectorAll(".mapping-modal button")]; });
        await page.evaluate(() => fixture.show("B"));
        const before = requests.filter(item => item.path.startsWith("/api/")).length;
        await page.evaluate(() => { for (const button of fixture.oldControls) if (button.textContent !== "关闭") button.click(); });
        await page.waitForTimeout(80);
        assert.equal(requests.filter(item => item.path.startsWith("/api/")).length, before);
        assert.equal(await page.locator('[role="dialog"]').count(), 0);
      } finally { await page.close(); }
    });
    await run("closed cover picker cannot replace a reopened picker with its old failure", async () => {
      const page = await open(), read = hold("GET", "/api/people/A", { error: "Obsolete cover read failure" }, 503);
      try {
        await page.locator(".mapping-modal").getByRole("button", { name: "选择作品封面", exact: true }).click(); await read.requested;
        await page.locator(".mapping-cover-picker-modal").getByRole("button", { name: "关闭", exact: true }).click();
        await page.locator(".mapping-modal").getByRole("button", { name: "选择作品封面", exact: true }).click();
        await page.waitForFunction(() => document.querySelector(".mapping-cover-picker-status")?.textContent === "0 张可选封面");
        await settle(page, read);
        assert.equal(await page.locator(".mapping-cover-picker-status").textContent(), "0 张可选封面", "a closed picker must not replace the reopened picker's status");
        assert(!(await page.locator(".mapping-cover-grid").textContent()).includes("Obsolete"));
      } finally { read.release(); await page.close(); }
    });
    assert(checks > 0); assert.deepEqual(faults, []);
    console.log(`Person profile fixture passed (${checks} cases; private Chromium, synthetic APIs)`);
    return { checks };
  } finally { for (const gate of held) gate.release(); await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

  function harness() {
    return `<!doctype html><meta charset=utf-8><div id=personProfile></div><script type=module>
      import {createLazyPersonProfile} from '/modules/fanhao/lazy-person-profile.js';
      import {createPersonProfile} from '/modules/fanhao/person-profile.js';
      const people=${JSON.stringify([person("A"), person("B")])};
      const state={activeView:'people',accessMode:'local',people,selectedPersonId:'A',selectedPerson:people[0]};
      const fixture=window.fixture={state,selections:[],settled:0,signals:[],ready:false};
      const api=async(path,options={})=>{const init={...options};if(options.signal)fixture.signals.push({path,signal:options.signal});if(new URLSearchParams(location.search).get('ignoreAbort')!=='0')delete init.signal;if(init.body){init.body=JSON.stringify(init.body);init.headers={'Content-Type':'application/json'};}const response=await fetch(path,init);const data=await response.json();fixture.settled++;if(!response.ok)throw Object.assign(new Error(data.error),{status:response.status});return data;};
      const els={personProfile:document.querySelector('#personProfile')};
      const lazy=createLazyPersonProfile({els,loadPersonProfile:()=>createPersonProfile({api,els,state,coverUrl:()=>'',workCoverUrl:()=>'',formatLibraryPath:String,formatNumber:String,linesFromTextarea:value=>value.split(/\\r?\\n/).filter(Boolean),normalizeSourcePath:value=>String(value).toLowerCase(),sourcePriority:()=>0,renderPeople(){},showPeopleIndex(){lazy.hide();state.selectedPersonId='';},selectPerson:async id=>{fixture.selections.push(id);await fixture.show(id);}})});
      fixture.show=async id=>{state.activeView='people';state.selectedPersonId=id;state.selectedPerson=state.people.find(item=>item.id===id);await lazy.render(state.selectedPerson);};
      fixture.hide=()=>{state.activeView='works';state.selectedPersonId='';lazy.hide();};
      await fixture.show('A');fixture.ready=true;
    </script>`;
  }
}

async function readBody(req) { let body = ""; for await (const chunk of req) body += chunk; return body; }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const caseOption = process.argv.find(value => value.startsWith("--case="));
  await runPersonProfileFixture({ casePattern: caseOption?.slice(7) || "" });
  if (!caseOption) {
    const readSource = relative => fs.readFileSync(path.join(publicRoot, relative), "utf8").replaceAll("\r\n", "\n");
    const profile = readSource("modules/fanhao/person-profile.js");
    const lazy = readSource("modules/fanhao/lazy-person-profile.js");
    const ownership = 'const isCurrent = () => activeMapping === owner && !lifecycle.signal.aborted && overlay.isConnected\n    && state.activeView === "people" && String(state.selectedPersonId || state.selectedPerson?.id || "") === owner.personId;';
    for (const negative of [
      {
        name: "closed profile save cannot merge or navigate over another person",
        path: "/modules/fanhao/person-profile.js", source: profile,
        marker: ownership, replacement: "const isCurrent = () => true;", occurrences: 1,
        failure: /a completed old save must not navigate back to its person/
      },
      {
        name: "pending profile save cannot replace leave",
        path: "/modules/fanhao/lazy-person-profile.js", source: lazy,
        marker: "loadedInstance?.hide?.();", replacement: "", occurrences: 1,
        failure: /navigation must dispose the old editor through the actual lazy wrapper/
      },
      {
        name: "closed cover picker cannot replace a reopened picker with its old failure",
        path: "/modules/fanhao/person-profile.js", source: profile,
        marker: "coverPickerGrid !== pickerGrid", replacement: "false", occurrences: 2,
        failure: /a closed picker must not replace the reopened picker's status/
      }
    ]) {
      assert.equal(negative.source.split(negative.marker).length - 1, negative.occurrences, `negative must modify the current owning guard: ${negative.name}`);
      const sourceOverride = negative.source.replaceAll(negative.marker, negative.replacement);
      await assert.rejects(() => runPersonProfileFixture({ casePattern: negative.name, sourceOverrides: { [negative.path]: sourceOverride } }), { name: "AssertionError", message: negative.failure });
      console.log(`PASS negative control detects missing ${negative.name}`);
    }
  }
}
