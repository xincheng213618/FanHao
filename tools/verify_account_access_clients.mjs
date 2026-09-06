import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { createAccountFixture } from "./fixtures/account-service.mjs";

const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
  .find((candidate) => candidate && fs.existsSync(candidate));
assert(executablePath, "Chrome or Edge is required for account access verification");
const fixture = createAccountFixture(), base = await fixture.listen();
const browser = await chromium.launch({ executablePath, headless: true });
const output = path.resolve(".codex-artifacts/accounts"); fs.mkdirSync(output, { recursive: true });
const password = "Access-client-fixture-123", errors = [];
async function api(route, body) {
  const response = await fetch(base + "/api/accounts" + route, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
}
async function ready(page) { await page.waitForFunction(() => !document.querySelector(".account-ui")?.hasAttribute("aria-busy")); }
async function pageAt(route, mobile = false) {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile });
  page.on("pageerror", (error) => errors.push(error.message)); await page.goto(base + route);
  await page.getByLabel("用户名", { exact: true }).waitFor(); await ready(page); return page;
}
async function signIn(page, username) {
  await page.getByLabel("用户名", { exact: true }).fill(username); await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).last().click();
  await page.getByRole("button", { name: "保存资料" }).waitFor(); await ready(page);
}
async function settings(page) {
  await page.getByRole("button", { name: "注册与访问", exact: true }).click(); await page.getByLabel("访问资料库必须登录账号", { exact: true }).waitFor(); await ready(page);
}
async function save(page) { await page.getByRole("button", { name: "保存设置", exact: true }).click(); await page.getByText("设置已保存", { exact: true }).waitFor(); await ready(page); }
try {
  await api("/setup", { username: "access-owner", password });
  const guest = await pageAt("/login");
  assert.equal(await guest.getByText("使用原访问密码", { exact: true }).count(), 1);
  await guest.goto(base + "/account-protected-fixture"); await guest.getByRole("heading", { name: "资料库测试页面" }).waitFor();
  const owner = await pageAt("/account"); await signIn(owner, "access-owner"); await settings(owner);
  assert.equal(await owner.getByLabel("访问资料库必须登录账号", { exact: true }).isChecked(), false);
  await owner.getByLabel("访问资料库必须登录账号", { exact: true }).check(); await save(owner);
  assert.equal((await api("/status")).accountLoginRequired, true);
  await owner.screenshot({ path: path.join(output, "web-account-access-settings.png"), fullPage: true });
  const target = "/account-protected-fixture?item=kept&view=library";
  await guest.goto(base + target); await guest.getByLabel("用户名", { exact: true }).waitFor(); await ready(guest);
  assert.equal(new URL(guest.url()).pathname, "/login"); assert.equal(new URL(guest.url()).searchParams.get("next"), target);
  assert.equal(await guest.getByText("使用原访问密码", { exact: true }).count(), 0);
  await guest.getByText("此资料库已关闭访客访问，请使用账号登录。", { exact: true }).waitFor();
  await guest.getByRole("button", { name: "注册", exact: true }).click(); await ready(guest);
  await guest.getByLabel("用户名", { exact: true }).fill("access-member"); await guest.getByLabel("密码", { exact: true }).fill(password);
  await guest.getByLabel("确认密码", { exact: true }).fill(password);
  assert.equal(await guest.getByLabel("邀请码（选填）", { exact: true }).inputValue(), "");
  await guest.getByRole("button", { name: "注册并登录", exact: true }).click();
  await guest.getByRole("heading", { name: "资料库测试页面" }).waitFor(); assert.equal(new URL(guest.url()).pathname + new URL(guest.url()).search, target);
  await guest.goto(base + "/account"); await guest.getByRole("button", { name: "退出登录", exact: true }).waitFor(); await ready(guest);
  assert.equal(await guest.getByRole("button", { name: "注册与访问", exact: true }).count(), 0);
  await guest.getByRole("button", { name: "退出登录", exact: true }).click(); await guest.getByText("已退出登录", { exact: true }).waitFor(); await ready(guest);
  assert.equal(await guest.evaluate(async () => (await fetch("/api/protected")).status), 401);
  await guest.goto(base + target); await guest.getByLabel("用户名", { exact: true }).waitFor();

  const android = await pageAt("/android-account-fixture", true);
  await android.getByText("此资料库已关闭访客访问，请使用账号登录。", { exact: true }).waitFor();
  await android.screenshot({ path: path.join(output, "android-account-required.png"), fullPage: true });
  assert(await android.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await signIn(android, "access-member");
  assert.equal(await android.evaluate(async () => (await fetch(location.origin + "/api/protected")).status), 200);
  assert.match(await android.evaluate(async () => (await Capacitor.Plugins.FanHaoAuth.getSession()).token), /^usr\./);
  await android.getByRole("button", { name: "退出登录", exact: true }).click(); await android.getByText("已退出登录", { exact: true }).waitFor(); await ready(android);
  assert.equal(await android.evaluate(async () => (await fetch(location.origin + "/api/protected")).status), 401);
  await signIn(android, "access-owner"); await settings(android);
  assert.equal(await android.getByLabel("访问资料库必须登录账号", { exact: true }).isChecked(), true);
  await android.screenshot({ path: path.join(output, "android-account-access-settings.png"), fullPage: true });
  assert(await android.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await android.getByLabel("访问资料库必须登录账号", { exact: true }).uncheck(); await save(android);
  assert.equal((await api("/status")).accountLoginRequired, false);
  await guest.goto(base + target); await guest.getByRole("heading", { name: "资料库测试页面" }).waitFor();
  await guest.goto(base + "/account"); await guest.getByText("使用原访问密码", { exact: true }).waitFor();
  await owner.getByRole("button", { name: "操作记录", exact: true }).click(); await owner.getByLabel("搜索操作记录").waitFor(); await ready(owner);
  assert.equal(await owner.getByText("调整访问设置", { exact: true }).count(), 2);
  assert.deepEqual(errors, []);
  console.log("account-access-clients: ok (default compatibility, Web gating and return route, invite-optional registration, Android login/logout and setting sync, guest restoration, audit and responsive layout)");
} catch (error) {
  const page = browser.contexts().at(-1)?.pages().at(-1);
  if (page) await page.screenshot({ path: path.join(output, "account-access-failure.png"), fullPage: true });
  throw error;
} finally { await browser.close(); await fixture.close(); }
