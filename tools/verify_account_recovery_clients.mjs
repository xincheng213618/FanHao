import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { createAccountFixture } from "./fixtures/account-service.mjs";

const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
  .find((candidate) => candidate && fs.existsSync(candidate));
assert(executablePath, "Chrome or Edge is required for account recovery verification");
const fixture = createAccountFixture(), base = await fixture.listen();
const browser = await chromium.launch({ executablePath, headless: true });
const output = path.resolve(".codex-artifacts/accounts"); fs.mkdirSync(output, { recursive: true });
const password = "Recovery-client-123", newPassword = "Recovery-client-456", errors = [];
async function api(route, body, token) {
  const response = await fetch(base + "/api/accounts" + route, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const result = await response.json(); assert(response.ok, JSON.stringify(result)); return result;
}
async function ready(page) { await page.waitForFunction(() => !document.querySelector(".account-ui")?.hasAttribute("aria-busy")); }
async function pageAt(route, mobile = false) {
  const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + route); await page.getByLabel("用户名", { exact: true }).waitFor(); await ready(page); return page;
}
async function signIn(page, username, secret = password) {
  await page.getByLabel("用户名", { exact: true }).fill(username); await page.getByLabel("密码", { exact: true }).fill(secret);
  await page.getByRole("button", { name: "登录", exact: true }).last().click();
  await page.getByRole("button", { name: "保存资料" }).waitFor(); await ready(page);
}
async function openReset(page, username, code) {
  await page.getByRole("button", { name: "忘记密码？", exact: true }).click(); await ready(page);
  await page.getByLabel("用户名", { exact: true }).fill(username); await page.getByLabel("密码重置码", { exact: true }).fill(code);
  await page.getByLabel("新密码", { exact: true }).fill(newPassword); await page.getByLabel("确认新密码", { exact: true }).fill(newPassword);
}
async function generate(page, id) {
  await page.locator(`[data-reset-user="${id}"]`).click(); await ready(page);
  await page.getByLabel("你的管理员密码").fill(password); await page.getByRole("button", { name: "生成一次性重置码" }).click();
  await page.locator("[data-reset-code]").waitFor(); await ready(page); return page.locator("[data-reset-code]").inputValue();
}
try {
  const owner = await api("/setup", { username: "recovery-owner", password, client: "android" });
  const web = await api("/register", { username: "web-recovery", password, client: "android" });
  const android = await api("/register", { username: "android-recovery", password, client: "android" });
  const admin = await pageAt("/account"); await signIn(admin, owner.user.username);
  await admin.getByRole("button", { name: "用户管理", exact: true }).click(); await admin.getByLabel("搜索用户").waitFor(); await ready(admin);
  await admin.locator(`[data-reset-user="${web.user.id}"]`).click(); await ready(admin);
  await admin.getByLabel("你的管理员密码").fill("Incorrect-password"); await admin.getByRole("button", { name: "生成一次性重置码" }).click();
  await admin.getByText("管理员密码不正确", { exact: true }).waitFor(); await ready(admin);
  assert.equal(await admin.locator("[data-reset-code]").count(), 0);
  await admin.getByLabel("你的管理员密码").fill(password); await admin.getByRole("button", { name: "生成一次性重置码" }).click();
  await admin.locator("[data-reset-code]").waitFor(); await ready(admin);
  const discardedCode = await admin.locator("[data-reset-code]").inputValue();
  assert.equal(await admin.locator('input[type="password"]').count(), 0, "administrator password is removed after generation");
  await admin.getByRole("button", { name: "关闭", exact: true }).click(); await ready(admin);
  assert.equal(await admin.locator("[data-reset-code]").count(), 0);
  const code = await generate(admin, web.user.id); assert.notEqual(code, discardedCode);
  await admin.screenshot({ path: path.join(output, "web-password-reset-admin.png"), fullPage: true });
  assert(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const mobile = await pageAt("/login", true); await openReset(mobile, web.user.username, code);
  await mobile.getByLabel("确认新密码", { exact: true }).fill(password); await mobile.getByRole("button", { name: "重置密码", exact: true }).click();
  await mobile.getByText("两次输入的新密码不一致", { exact: true }).waitFor(); await ready(mobile);
  await mobile.getByLabel("确认新密码", { exact: true }).fill(newPassword);
  await mobile.getByLabel("密码重置码", { exact: true }).fill(discardedCode); await mobile.getByRole("button", { name: "重置密码", exact: true }).click();
  await mobile.getByText("重置码无效或已过期，请向管理员重新获取", { exact: true }).waitFor(); await ready(mobile);
  await mobile.getByLabel("密码重置码", { exact: true }).fill(code);
  await mobile.screenshot({ path: path.join(output, "mobile-password-reset.png"), fullPage: true });
  assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mobile.getByRole("button", { name: "重置密码", exact: true }).click();
  await mobile.getByText("密码已重置，所有设备已退出。请使用新密码登录", { exact: true }).waitFor(); await ready(mobile);
  assert.equal(await mobile.getByRole("button", { name: "保存资料" }).count(), 0);
  await signIn(mobile, web.user.username, newPassword);
  assert.equal(await mobile.getByRole("button", { name: "操作记录", exact: true }).count(), 0);

  const native = await pageAt("/android-account-fixture", true); await signIn(native, android.user.username);
  const staleToken = await native.evaluate(async () => (await Capacitor.Plugins.FanHaoAuth.getSession()).token);
  const first = await generate(admin, android.user.id);
  await api("/password/reset", { username: android.user.username, resetCode: first, newPassword });
  await native.getByRole("button", { name: "登录设备", exact: true }).click();
  await native.getByText("登录已失效，请重新登录", { exact: true }).waitFor(); await ready(native);
  assert.equal(await native.evaluate(async () => (await Capacitor.Plugins.FanHaoAuth.getSession()).token), staleToken);
  const second = await generate(admin, android.user.id); await openReset(native, android.user.username, second);
  await native.screenshot({ path: path.join(output, "android-password-reset.png"), fullPage: true });
  assert(await native.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await native.getByRole("button", { name: "重置密码", exact: true }).click();
  await native.getByText("密码已重置，所有设备已退出。请使用新密码登录", { exact: true }).waitFor(); await ready(native);
  assert.equal(await native.evaluate(async () => (await Capacitor.Plugins.FanHaoAuth.getSession()).token), "");
  assert.equal(await native.evaluate(() => window.signedIn), false);
  await signIn(native, android.user.username, newPassword); assert.equal(await native.evaluate(() => window.signedIn), true);

  await admin.getByRole("button", { name: "操作记录", exact: true }).click(); await admin.getByLabel("搜索操作记录").waitFor(); await ready(admin);
  await admin.getByLabel("搜索操作记录").fill(web.user.username); await admin.getByRole("button", { name: "搜索", exact: true }).click(); await ready(admin);
  const auditText = await admin.getByLabel("操作记录列表").innerText();
  assert(auditText.includes("重置密码") && auditText.includes("通过重置码验证") && !auditText.includes(android.user.username));
  for (const secret of [code, discardedCode, password, newPassword]) assert(!auditText.includes(secret));
  await admin.screenshot({ path: path.join(output, "web-account-audit.png"), fullPage: true });
  await admin.getByRole("button", { name: "用户管理", exact: true }).click(); await admin.getByLabel("搜索用户").waitFor(); await ready(admin);
  assert.equal(await admin.locator("[data-reset-code]").count(), 0, "leaving the user list discards displayed reset codes");
  assert.deepEqual(errors, []);
  console.log("account-recovery-clients: ok (admin reauthentication/code display, Web reset/error/re-login, Android stale-token recovery and native-session clearing, audit search/privacy, mobile layout)");
} finally { await browser.close(); await fixture.close(); }
