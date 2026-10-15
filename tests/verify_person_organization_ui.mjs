import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { routeAdminApi } from "../src/modules/system/server/admin/routes.js";

const preview = { id: "synthetic-plan", workCount: 2, moveCount: 1, skipped: [{ code: "BAD-123", reason: "目标目录已存在" }],
  groups: [{ code: "ABC-123", target: `R:/synthetic/${"long".repeat(70)}` }], obsolete: ["R:/synthetic/cover.jpg", "R:/synthetic/javdb-info.txt"] };
let starts = 0, polls = 0, active = false, deny = false, bodyReads = 0, lastBody;
const task = () => ({ id: "synthetic-task", status: polls > 0 ? "done" : "running", logs: ["整理结果：2 部"] });
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/modules/fanhao/styles.css">
<main><div id="profile"></div><p id="refreshes">0</p></main><script type="module">
import { createPersonProfile } from '/modules/fanhao/person-profile.js';
const person = {id:'1',name:'Synthetic',sourcePaths:['R:/synthetic'],videoCount:3};
window.fixtureState = {accessMode:'local',selectedPerson:person,people:[person]};
const api = async (url, options={}) => { const response=await fetch(url,{method:options.method||'GET',headers:{'content-type':'application/json'},body:options.body?JSON.stringify(options.body):undefined}); const data=await response.json(); if(!response.ok)throw new Error(data.error);return data;};
createPersonProfile({api,els:{personProfile:document.getElementById('profile')},state:window.fixtureState,
coverUrl:()=>'',formatLibraryPath:p=>p,formatNumber:String,normalizeSourcePath:p=>p,sourcePriority:()=>0,
renderPeople:()=>{},selectPerson:async()=>{document.getElementById('refreshes').textContent=String(Number(document.getElementById('refreshes').textContent)+1);},showPeopleIndex:()=>{}}).render(person);
</script>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture");
  if (url.pathname === "/fixture") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); return; }
  if (url.pathname === "/api/admin/tasks") { polls += 1; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ tasks: [task()] })); return; }
  if (await routeAdminApi(req, res, url, {
    requireLocalAdmin: (_req, response) => { if (!deny) return true; response.statusCode = 403; response.end(JSON.stringify({error:"forbidden"})); return false; },
    readJsonBody: async (request) => { bodyReads++; let body=""; for await (const chunk of request) body+=chunk; return JSON.parse(body); },
    sendJson: (response, status, data) => { response.statusCode=status; response.setHeader("Content-Type","application/json"); response.end(JSON.stringify(data)); },
    adminMaintenanceTaskService: { organizePersonPayload: (body) => {
      if (body.preview) return active ? {task:task()} : {plan:preview};
      starts++; lastBody=body; active=true; return {task:task()};
    } }
  })) return;
  const relative = decodeURIComponent(url.pathname).replace(/^\//, "");
  const file = path.resolve("public", relative), publicRoot = path.resolve("public") + path.sep;
  if (!file.startsWith(publicRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {res.statusCode=404;res.end();return;}
  res.setHeader("Content-Type", file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/plain");
  res.end(fs.readFileSync(file));
});
let browser;
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((p) => p && fs.existsSync(p));
  assert(executablePath);
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/fixture`);
  await page.getByRole("button", {name:"重新整理",exact:true}).click();
  const dialog = page.getByRole("dialog", {name:"重新整理人物目录"});
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("checkbox").isChecked(), true);
  assert((await dialog.textContent()).includes("不备份"));
  assert.equal(await page.evaluate(()=>document.activeElement.textContent), "关闭");
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.evaluate(()=>document.activeElement.textContent), "开始整理");
  await page.keyboard.press("Escape");
  assert.equal(starts,0,"closing preview must not start a task");
  await page.getByRole("button", {name:"重新整理",exact:true}).click();
  await dialog.getByRole("button",{name:"开始整理"}).waitFor();
  await page.setViewportSize({width:390,height:844});
  await dialog.getByText("查看本次目录与跳过原因").click();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), "mobile dialog must fit the viewport");
  assert(await dialog.evaluate((element)=>element.scrollWidth<=element.clientWidth), "long paths must wrap inside dialog");
  await dialog.getByRole("button",{name:"开始整理"}).click();
  await dialog.getByText("整理完成，封面、info 和本地索引已同步。").waitFor();
  assert.equal(starts,1);assert.equal(lastBody.refreshMetadata,true);
  assert.equal(await page.locator("#refreshes").textContent(),"1");
  await dialog.getByRole("button",{name:"关闭",exact:true}).click();
  // An existing task is monitored without another start; a route switch must not navigate back.
  polls=0;
  await page.getByRole("button", {name:"重新整理",exact:true}).click();
  await dialog.getByRole("button",{name:"查看运行进度"}).waitFor();
  await page.evaluate(()=>{window.fixtureState.selectedPerson={id:'2'};});
  await dialog.getByRole("button",{name:"查看运行进度"}).click();
  await dialog.getByText("整理完成，封面、info 和本地索引已同步。").waitFor();
  assert.equal(starts,1);assert.equal(await page.locator("#refreshes").textContent(),"1");
  deny=true;const reads=bodyReads;
  const denied = await fetch(`${base}/api/admin/organize-person`, {method:"POST",body:'{"personId":"1"}'});
  assert.equal(denied.status,403);assert.equal(bodyReads,reads);
  assert.deepEqual(errors,[]);
  console.log("person-organization-ui: actual profile button, preview/cancel, default direct refresh, no backups, mobile wrapping, focus, completion, existing task, route ownership and local-admin rejection passed (synthetic API only)");
} finally { await browser?.close(); await new Promise((resolve)=>server.close(resolve)); }
