import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright-core";
import { createAccountFixture } from "./fixtures/account-service.mjs";
import { createAccountStore } from "../src/platform/server/accounts/store.js";

const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
  .find((candidate) => candidate && fs.existsSync(candidate));
assert(executablePath, "Chrome or Edge is required for account invitation verification");
let time = Date.now();
const fixture = createAccountFixture({ now: () => time }), base = await fixture.listen();
const store = createAccountStore({ dbPath: fixture.dbPath, now: () => time });
const browser = await chromium.launch({ executablePath, headless: true });
const output = path.resolve(".codex-artifacts/accounts"); fs.mkdirSync(output, { recursive: true });
const password = "Invite-client-123", errors = [];
async function api(route, body) {
  const response = await fetch(base + "/api/accounts" + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
}
async function ready(page) { await page.waitForFunction(() => !document.querySelector(".account-ui")?.hasAttribute("aria-busy")); }
async function signIn(route, username, mobile = false) {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile });
  page.on("pageerror", (error) => errors.push(error.message)); await page.goto(base + route);
  await page.getByLabel("用户名", { exact: true }).waitFor(); await ready(page);
  await page.getByLabel("用户名", { exact: true }).fill(username); await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).last().click(); await page.getByRole("button", { name: "保存资料" }).waitFor(); await ready(page); return page;
}
async function filter(page, status, search = "") {
  await page.getByLabel("搜索邀请码", { exact: true }).fill(search); await page.getByLabel("邀请码状态", { exact: true }).selectOption(status);
  await page.getByRole("button", { name: "筛选", exact: true }).click(); await ready(page);
}
async function searchUses(page, value) {
  await page.getByLabel("搜索使用者", { exact: true }).fill(value); await page.getByRole("button", { name: "搜索", exact: true }).click(); await ready(page);
}
let db;
try {
  const owner = await api("/setup", { username: "invitation-owner", password, client: "android" });
  await api("/register", { username: "direct-viewer", password });
  const [invite] = store.createInvites(owner.user.id, { count: 1, maxUses: 1000, note: "launch_% <img src=x onerror=alert(1)>" });
  const [expired] = store.createInvites(owner.user.id, { count: 1, expiresInDays: 1, note: "expired fixture" });
  await api("/register", { username: "invited-viewer", displayName: "<img src=x onerror=alert(1)>", password, inviteCode: invite.code });
  db = new DatabaseSync(fixture.dbPath);
  const hash = db.prepare("SELECT password_hash FROM account_users WHERE id=?").get(owner.user.id).password_hash;
  const insert = db.prepare("INSERT INTO account_users(id,username,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)");
  const redeem = db.prepare("INSERT INTO account_redemptions VALUES(?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 54; i++) {
    const id = crypto.randomUUID(), created = new Date(time + i * 1000 + 1).toISOString();
    insert.run(id, `visitor-${String(i).padStart(2, "0")}`, `Visitor ${i}`, hash, "user", created); redeem.run(id, invite.id, created);
  }
  db.prepare("UPDATE account_invites SET uses=uses+54 WHERE id=?").run(invite.id); db.exec("COMMIT");
  time += 86400000;
  const desktop = await signIn("/account", owner.user.username);
  await desktop.getByRole("button", { name: "邀请码", exact: true }).click(); await desktop.getByLabel("搜索邀请码").waitFor(); await ready(desktop);
  await filter(desktop, "expired");
  assert.equal(await desktop.locator("[data-invite-row]").count(), 1);
  assert(await desktop.locator(`[data-invite-row="${expired.id}"]`).innerText().then((text) => text.includes("已过期")), "status follows the server clock");
  await filter(desktop, "all", "no-match"); await desktop.getByText("没有符合筛选条件的邀请码。", { exact: true }).waitFor();
  await filter(desktop, "available", "_%"); assert.equal(await desktop.locator("[data-invite-row]").count(), 1);
  assert.equal(await desktop.locator(".account-ui img").count(), 0, "invitation notes are escaped");
  await desktop.screenshot({ path: path.join(output, "web-invite-filter.png"), fullPage: true });
  let firstRequest = true;
  await desktop.route(`**/api/accounts/admin/invites/${invite.id}?*`, (route) => {
    if (!firstRequest) return route.continue(); firstRequest = false;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "临时连接失败" }) });
  });
  await desktop.getByRole("button", { name: "使用记录", exact: true }).click();
  await desktop.getByRole("button", { name: "重新加载", exact: true }).waitFor(); await ready(desktop);
  await desktop.getByRole("button", { name: "重新加载", exact: true }).click(); await desktop.getByLabel("搜索使用者").waitFor(); await ready(desktop);
  assert.equal(await desktop.getByLabel("邀请码使用者", { exact: true }).locator("article").count(), 50);
  await desktop.getByRole("button", { name: "下一页", exact: true }).click(); await ready(desktop);
  assert.equal(await desktop.getByLabel("邀请码使用者", { exact: true }).locator("article").count(), 5);
  await desktop.getByText("共 55 条 · 第 2 页", { exact: true }).waitFor();
  await searchUses(desktop, "invited-viewer"); await desktop.getByText("共 1 条 · 第 1 页", { exact: true }).waitFor();
  assert.equal(await desktop.locator(".account-ui img").count(), 0, "user display names are escaped");
  await desktop.screenshot({ path: path.join(output, "web-invite-redemptions.png"), fullPage: true });
  await desktop.getByRole("button", { name: "← 返回邀请码列表", exact: true }).click(); await desktop.getByLabel("搜索邀请码").waitFor(); await ready(desktop);
  assert.equal(await desktop.getByLabel("搜索邀请码").inputValue(), "_%"); assert.equal(await desktop.getByLabel("邀请码状态").inputValue(), "available");
  await desktop.getByRole("button", { name: "用户管理", exact: true }).click(); await desktop.getByLabel("搜索用户").waitFor(); await ready(desktop);
  await desktop.getByLabel("搜索用户").fill("invited-viewer"); await desktop.getByRole("button", { name: "搜索", exact: true }).click(); await ready(desktop);
  await desktop.getByRole("button", { name: /来自邀请码/ }).click(); await desktop.getByLabel("搜索使用者").waitFor(); await ready(desktop);
  await desktop.getByRole("button", { name: "← 返回用户管理", exact: true }).click(); await desktop.getByLabel("搜索用户").waitFor(); await ready(desktop);
  assert.equal(await desktop.getByLabel("搜索用户").inputValue(), "invited-viewer");
  await desktop.getByText("共 1 条 · 第 1 页", { exact: true }).waitFor();

  const android = await signIn("/android-account-fixture", owner.user.username, true);
  await android.getByRole("button", { name: "邀请码", exact: true }).click(); await android.getByLabel("搜索邀请码").waitFor(); await ready(android);
  await filter(android, "available", "launch_%");
  await android.screenshot({ path: path.join(output, "android-invite-filter.png"), fullPage: true });
  assert(await android.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await android.getByRole("button", { name: "使用记录", exact: true }).click(); await android.getByLabel("搜索使用者").waitFor(); await ready(android);
  await searchUses(android, "visitor-01");
  await android.screenshot({ path: path.join(output, "android-invite-redemptions.png"), fullPage: true });
  assert(await android.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  android.once("dialog", (dialog) => dialog.dismiss()); await android.getByRole("button", { name: "停用邀请码", exact: true }).click(); await ready(android);
  assert.equal(await android.getByRole("button", { name: "停用邀请码", exact: true }).count(), 1);
  android.once("dialog", (dialog) => dialog.accept()); await android.getByRole("button", { name: "停用邀请码", exact: true }).click();
  await android.getByText("邀请码已停用", { exact: true }).waitFor(); await ready(android);
  assert.equal(await android.getByRole("button", { name: "停用邀请码", exact: true }).count(), 0);
  assert((await android.locator(".account-invite-summary").innerText()).includes("已停用 · 已用 55/1000 次"));
  assert.equal(await android.getByLabel("邀请码使用者", { exact: true }).locator("article").count(), 1);
  await android.getByRole("button", { name: "← 返回邀请码列表", exact: true }).click(); await ready(android);
  await android.getByText("没有符合筛选条件的邀请码。", { exact: true }).waitFor();
  await filter(android, "disabled", "launch_%"); assert.equal(await android.locator("[data-invite-row]").count(), 1);
  const ordinary = await signIn("/android-account-fixture", "direct-viewer", true);
  assert.equal(await ordinary.getByRole("button", { name: "邀请码", exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log("account-invitation-clients: ok (Web/Android filtering, server-clock status, detail pagination/search, retry, provenance navigation, escaped content, revocation/cancel, mobile layout)");
} catch (error) {
  const page = browser.contexts().at(-1)?.pages().at(-1);
  if (page) {
    await page.screenshot({ path: path.join(output, "invitation-failure.png"), fullPage: true });
    console.error(await page.locator("select").evaluateAll((nodes) => nodes.map((node) => ({ html: node.outerHTML, labels: [...node.labels].map((label) => label.textContent) }))));
  }
  throw error;
} finally { db?.close(); await browser.close(); store.close(); await fixture.close(); }
