import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { createAccountFixture } from "./fixtures/account-service.mjs";

for (const file of ["account-ui.js", "account.css"]) assert.equal(
  fs.readFileSync(new URL(`../public/platform/accounts/${file}`, import.meta.url), "utf8"),
  fs.readFileSync(new URL(`../android-client/www/platform/accounts/${file}`, import.meta.url), "utf8"), "Android shared account assets must match Web");
const executablePath = [process.env.CHROME_PATH, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"].find((candidate) => candidate && fs.existsSync(candidate));
assert(executablePath, "Chrome or Edge is required for account client verification");
const fixture = createAccountFixture();
const base = await fixture.listen();
const browser = await chromium.launch({ executablePath, headless: true });
const output = path.resolve(".codex-artifacts/accounts"); fs.mkdirSync(output, { recursive: true });
const errors = [];
function observe(page) { page.on("pageerror", (error) => errors.push(error.message)); }
async function ready(page) { await page.waitForFunction(() => !document.querySelector('.account-ui')?.hasAttribute('aria-busy')); }
async function fillSignup(page, username) {
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("昵称（选填）", { exact: true }).fill(username === "owner" ? "资料库管理员" : "测试用户");
  await page.getByLabel("密码", { exact: true }).fill("Fixture-password-123");
  await page.getByLabel("确认密码", { exact: true }).fill("Fixture-password-123");
}
async function api(pathname, { token, body, method = body ? "POST" : "GET" } = {}) {
  const response = await fetch(base + pathname, { method, headers: { Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
}
async function signIn(page, username) {
  await page.getByLabel("用户名", { exact: true }).fill(username);
  await page.getByLabel("密码", { exact: true }).fill("Fixture-password-123");
  await page.getByRole("button", { name: "登录", exact: true }).last().click();
  await page.getByRole("button", { name: "保存资料" }).waitFor(); await ready(page);
}
try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); observe(desktop);
  await desktop.goto(base + "/account"); await desktop.getByRole("button", { name: "本机初始化管理员 →" }).waitFor(); await ready(desktop);
  await desktop.screenshot({ path: path.join(output, "web-login.png"), fullPage: true });
  await desktop.getByRole("button", { name: "本机初始化管理员 →" }).click(); await fillSignup(desktop, "owner");
  await desktop.getByRole("button", { name: "创建管理员", exact: true }).click();
  await desktop.getByRole("button", { name: "用户管理", exact: true }).waitFor(); await ready(desktop);
  const otherDevice = await browser.newPage(); observe(otherDevice);
  await otherDevice.goto(base + "/account"); await otherDevice.getByLabel("用户名", { exact: true }).waitFor(); await ready(otherDevice);
  await signIn(otherDevice, "owner");
  const appDevice = await api("/api/accounts/login", { body: { username: "owner", password: "Fixture-password-123", client: "android" } });
  assert.equal(appDevice.status, 200);
  await desktop.getByRole("button", { name: "登录设备", exact: true }).click();
  await desktop.getByRole("button", { name: "刷新设备", exact: true }).waitFor(); await ready(desktop);
  assert.equal(await desktop.locator(".account-session-row").count(), 3);
  assert.equal(await desktop.getByText("当前设备", { exact: true }).count(), 1);
  await desktop.screenshot({ path: path.join(output, "web-devices.png"), fullPage: true });
  desktop.once("dialog", (dialog) => dialog.accept());
  await desktop.locator(".account-session-row").filter({ hasText: "Android App" }).getByRole("button", { name: "退出此设备", exact: true }).click();
  await desktop.getByText("该设备已退出登录", { exact: true }).waitFor(); await ready(desktop);
  assert.equal((await api("/api/protected", { token: appDevice.body.token })).status, 401);
  assert.equal(await desktop.locator(".account-session-row").count(), 2);
  desktop.once("dialog", (dialog) => dialog.dismiss());
  await desktop.getByRole("button", { name: /退出其他全部设备/ }).click(); await ready(desktop);
  assert.equal(await otherDevice.evaluate(async () => (await (await fetch('/api/accounts/status')).json()).user.username), "owner");
  desktop.once("dialog", (dialog) => dialog.accept());
  await desktop.getByRole("button", { name: /退出其他全部设备/ }).click();
  await desktop.getByText("已退出 1 个其他设备", { exact: true }).waitFor(); await ready(desktop);
  assert.equal(await desktop.getByRole("button", { name: /退出其他全部设备/ }).isDisabled(), true);
  await otherDevice.getByRole("button", { name: "登录设备", exact: true }).click();
  await otherDevice.getByText("登录已失效，请重新登录", { exact: true }).waitFor(); await ready(otherDevice);
  await signIn(otherDevice, "owner");
  await otherDevice.getByRole("button", { name: "登录设备", exact: true }).click();
  await otherDevice.getByRole("button", { name: "退出当前设备", exact: true }).waitFor(); await ready(otherDevice);
  otherDevice.once("dialog", (dialog) => dialog.accept()); await otherDevice.getByRole("button", { name: "退出当前设备", exact: true }).click();
  await otherDevice.getByText("已退出当前设备", { exact: true }).waitFor();
  assert.equal((await otherDevice.context().cookies()).some((cookie) => cookie.name === "fanhao_web_auth"), false);
  await desktop.getByRole("button", { name: "邀请码", exact: true }).click(); await desktop.getByLabel("生成数量").waitFor(); await ready(desktop);
  await desktop.getByLabel("生成数量").fill("2"); await desktop.getByLabel("备注（选填）").fill("新成员邀请");
  await desktop.getByRole("button", { name: "生成邀请码", exact: true }).click();
  await desktop.getByLabel("刚生成的邀请码").waitFor(); await ready(desktop);
  const codes = (await desktop.getByLabel("刚生成的邀请码").inputValue()).trim().split("\n"); assert.equal(codes.length, 2);
  await desktop.screenshot({ path: path.join(output, "web-invites.png"), fullPage: true });
  await desktop.getByRole("button", { name: "注册与访问", exact: true }).click();
  await desktop.getByLabel("注册时必须填写邀请码").check(); await desktop.getByRole("button", { name: "保存设置" }).click();
  await desktop.getByText("设置已保存", { exact: true }).waitFor(); await ready(desktop);
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }); observe(mobile);
  await mobile.goto(base + "/register"); await mobile.getByLabel("邀请码", { exact: true }).waitFor(); await ready(mobile);
  await fillSignup(mobile, "mobile-user"); await mobile.getByLabel("邀请码", { exact: true }).fill(codes[0]);
  await mobile.screenshot({ path: path.join(output, "mobile-register.png"), fullPage: true });
  await mobile.getByRole("button", { name: "注册并登录" }).click(); await mobile.getByRole("button", { name: "保存资料" }).waitFor(); await ready(mobile);
  assert.equal(await mobile.getByRole("button", { name: "用户管理", exact: true }).count(), 0);
  await mobile.getByLabel("昵称", { exact: true }).fill("<img src=x onerror=alert(1)>"); await mobile.getByRole("button", { name: "保存资料" }).click();
  await mobile.getByText("个人资料已保存", { exact: true }).waitFor(); assert.equal(await mobile.locator(".account-ui img").count(), 0);
  await mobile.getByText("修改密码", { exact: true }).click();
  await mobile.getByLabel("当前密码", { exact: true }).fill("Fixture-password-123");
  await mobile.getByLabel("新密码", { exact: true }).fill("New-password-123");
  await mobile.getByLabel("确认新密码", { exact: true }).fill("New-password-123");
  await mobile.getByRole("button", { name: "更新密码" }).click(); await mobile.getByText("密码已修改，请重新登录", { exact: true }).waitFor();
  assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile page must not overflow");
  await desktop.getByRole("button", { name: "用户管理", exact: true }).click(); await desktop.getByLabel("搜索用户").waitFor(); await ready(desktop);
  await desktop.getByLabel("搜索用户").fill("mobile-user"); await desktop.getByRole("button", { name: "搜索", exact: true }).click();
  await desktop.getByText("共 1 条 · 第 1 页").waitFor(); await ready(desktop);
  desktop.once("dialog", (dialog) => dialog.accept()); await desktop.getByRole("button", { name: "停用", exact: true }).click();
  await desktop.getByText("用户状态已更新", { exact: true }).waitFor(); assert.equal(await desktop.getByRole("button", { name: "启用", exact: true }).count(), 1);
  const android = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true }); observe(android);
  await android.goto(base + "/android-account-fixture"); await android.getByRole("button", { name: "注册", exact: true }).waitFor(); await ready(android);
  await android.getByRole("button", { name: "注册", exact: true }).click(); await fillSignup(android, "android-user");
  await android.getByLabel("邀请码", { exact: true }).fill(codes[1]); await android.getByRole("button", { name: "注册并登录" }).click();
  await android.getByRole("button", { name: "保存资料" }).waitFor(); await ready(android); assert.equal(await android.evaluate(() => window.signedIn), true);
  await android.screenshot({ path: path.join(output, "android-profile.png"), fullPage: true });
  assert(await android.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await android.getByRole("button", { name: "退出登录", exact: true }).click(); await android.getByText("已退出登录", { exact: true }).waitFor();
  assert.equal(await android.evaluate(() => window.signedIn), false);
  await android.getByLabel("用户名", { exact: true }).fill("android-user"); await android.getByLabel("密码", { exact: true }).fill("Fixture-password-123");
  await android.getByRole("button", { name: "登录", exact: true }).last().click(); await android.getByRole("button", { name: "保存资料" }).waitFor();
  await ready(android); await android.getByRole("button", { name: "登录设备", exact: true }).click();
  await android.getByRole("button", { name: "退出当前设备", exact: true }).waitFor(); await ready(android);
  await android.screenshot({ path: path.join(output, "android-devices.png"), fullPage: true });
  assert(await android.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  android.once("dialog", (dialog) => dialog.accept()); await android.getByRole("button", { name: "退出当前设备", exact: true }).click();
  await android.getByText("已退出当前设备", { exact: true }).waitFor(); await ready(android);
  assert.equal(await android.evaluate(async () => (await Capacitor.Plugins.FanHaoAuth.getSession({serverUrl:location.origin})).token), "");
  await signIn(android, "android-user");
  await android.getByRole("button", { name: "登录设备", exact: true }).click(); await android.getByRole("button", { name: "刷新设备", exact: true }).waitFor(); await ready(android);
  const nativeToken = await android.evaluate(async () => (await Capacitor.Plugins.FanHaoAuth.getSession({serverUrl:location.origin})).token);
  const controllingDevice = await api("/api/accounts/login", { body: { username: "android-user", password: "Fixture-password-123", client: "android" } });
  const beforeRevoke = await api("/api/accounts/sessions", { token: controllingDevice.body.token });
  const nativeSession = beforeRevoke.body.sessions.find((session) => !session.current);
  assert.equal((await api(`/api/accounts/sessions/${nativeSession.id}/revoke`, { token: controllingDevice.body.token, body: {} })).status, 200);
  await android.getByRole("button", { name: "刷新设备", exact: true }).click();
  await android.getByText("登录已失效，请重新登录", { exact: true }).waitFor();
  assert.equal(await android.evaluate(async () => (await Capacitor.Plugins.FanHaoAuth.getSession({serverUrl:location.origin})).token), nativeToken,
    "revoked Android session must not silently revert to anonymous LAN access");
  await signIn(android, "android-user");
  const settingsPage = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true }); observe(settingsPage);
  await settingsPage.goto(base + "/android-settings-fixture"); await settingsPage.getByRole("button", { name: "注册", exact: true }).waitFor(); await ready(settingsPage);
  await settingsPage.locator(".settings-account-group").scrollIntoViewIfNeeded();
  await settingsPage.screenshot({ path: path.join(output, "android-settings.png") });
  assert(await settingsPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await settingsPage.evaluate(() => document.documentElement.dataset.theme = "dark");
  assert.equal(await settingsPage.locator(".account-card").evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(23, 27, 33)", "account panel follows Android's explicit theme");
  await settingsPage.screenshot({ path: path.join(output, "android-settings-dark.png"), animations: "disabled" });
  assert.deepEqual(errors, []);
  console.log("account-clients: ok (desktop admin/invites/policy, cross-device revoke/cancel/expiry, mobile registration/profile/password, Android native-session clearing and re-login, responsive themes)");
} catch (error) {
  const page = browser.contexts().at(-1)?.pages().at(-1);
  if (page) { await page.screenshot({ path: path.join(output, "failure.png"), fullPage: true }); console.error(await page.locator("body").innerText()); }
  console.error("Browser errors:", errors);
  throw error;
} finally { await browser.close(); await fixture.close(); }
