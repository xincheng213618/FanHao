import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { chromium } from "playwright-core";

const defaultCookieFile = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "douyin-downloader-desktop",
  "custom-batch-douyin-cookies.txt"
);

function parseArgs(argv) {
  const opts = { url: "", out: "", max: 0, scrolls: 1200, idleRounds: 16, headed: false, browser: "edge", cookieFile: defaultCookieFile };
  const args = [...argv];
  if (args[0] && !args[0].startsWith("--")) opts.url = args.shift();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = () => {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      index += 1;
      return next;
    };
    if (arg === "--out") opts.out = value();
    else if (arg === "--max") opts.max = Number(value());
    else if (arg === "--scrolls") opts.scrolls = Number(value());
    else if (arg === "--idle-rounds") opts.idleRounds = Number(value());
    else if (arg === "--cookie-file") opts.cookieFile = value();
    else if (arg === "--browser") opts.browser = value();
    else if (arg === "--headed") opts.headed = true;
    else if (arg === "--headless") opts.headed = false;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!opts.url) throw new Error("Profile URL is required");
  if (!Number.isFinite(opts.max) || opts.max < 0) opts.max = 0;
  if (!Number.isFinite(opts.scrolls) || opts.scrolls < 1) opts.scrolls = 1200;
  if (!Number.isFinite(opts.idleRounds) || opts.idleRounds < 1) opts.idleRounds = 16;
  return opts;
}

function browserPath(kind) {
  const candidates = {
    edge: ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"],
    chrome: ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"],
  };
  if (kind && fs.existsSync(kind)) return kind;
  for (const candidate of candidates[kind] || [...candidates.edge, ...candidates.chrome]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Browser executable not found for ${kind}`);
}

function parseNetscapeCookies(file) {
  if (!file || !fs.existsSync(file)) return [];
  const cookies = [];
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const [domain, , cookiePath, secure, expires, name, ...valueParts] = parts;
    if (!domain || !name) continue;
    cookies.push({
      name,
      value: valueParts.join("\t"),
      domain,
      path: cookiePath || "/",
      secure: secure === "TRUE",
      expires: Number(expires) > 0 ? Number(expires) : undefined,
      sameSite: "Lax",
    });
  }
  return cookies;
}

function textValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function numberValue(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return Math.trunc(number);
  }
  return null;
}

function firstUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return /^https?:\/\//i.test(value) ? value : "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = firstUrl(item);
      if (url) return url;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const key of ["url_list", "urlList", "urls", "url", "src", "uri"]) {
      const url = firstUrl(value[key]);
      if (url) return url;
    }
  }
  return "";
}

function userFromObject(value) {
  if (!value || typeof value !== "object") return null;
  const user = value.user || value.user_info || value.userInfo || value.author || value;
  const secUid = textValue(user.sec_uid, user.secUid, user.sec_user_id, user.secUserId);
  if (!secUid || !/^MS4wLj/i.test(secUid)) return null;
  return {
    sec_uid: secUid,
    uid: textValue(user.uid, user.user_id, user.userId, user.id),
    nickname: textValue(user.nickname, user.nick_name, user.nickName, user.name),
    avatar_url: firstUrl(user.avatar_larger) || firstUrl(user.avatar_medium) || firstUrl(user.avatar_thumb) || firstUrl(user.avatar),
    unique_id: textValue(user.unique_id, user.uniqueId),
    short_id: textValue(user.short_id, user.shortId),
    signature: textValue(user.signature, user.desc, user.description),
    ip_location: textValue(user.ip_location, user.ipLocation).replace(/^IP属地[:：]?/u, ""),
    following_count: numberValue(user.following_count, user.followingCount),
    follower_count: numberValue(user.follower_count, user.followerCount),
    total_favorited: numberValue(user.total_favorited, user.totalFavorited),
    aweme_count: numberValue(user.aweme_count, user.awemeCount),
    favoriting_count: numberValue(user.favoriting_count, user.favoritingCount),
    gender: numberValue(user.gender),
    age: numberValue(user.age),
    verification: textValue(user.custom_verify, user.customVerify, user.verification),
    profile_url: `https://www.douyin.com/user/${secUid}`,
  };
}

function collectUsers(value, output, depth = 0) {
  if (!value || depth > 12) return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectUsers(item, output, depth + 1));
    return;
  }
  if (typeof value !== "object") return;
  const user = userFromObject(value);
  if (user) output.push(user);
  Object.values(value).forEach((child) => {
    if (child && (Array.isArray(child) || typeof child === "object")) collectUsers(child, output, depth + 1);
  });
}

function mergeUser(users, incoming, max) {
  if (!incoming?.sec_uid || incoming.sec_uid === "self") return false;
  const existing = users.get(incoming.sec_uid);
  if (!existing && max > 0 && users.size >= max) return false;
  if (!existing) {
    users.set(incoming.sec_uid, incoming);
    return true;
  }
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== "" && value !== null && value !== undefined && !existing[key]) existing[key] = value;
  }
  return false;
}

async function clickFollowing(page) {
  const clicked = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("a, button, div, span"));
    const candidates = elements
      .map((element) => ({ element, text: (element.textContent || "").replace(/\s+/g, "").trim(), rect: element.getBoundingClientRect() }))
      .filter(({ text, rect }) => rect.width > 0 && rect.height > 0 && rect.left > 180 && rect.top < 420 && (/^关注[\d.,万亿wk]+$/i.test(text) || /^[\d.,万亿wk]+关注$/i.test(text)))
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height);
    const exactLabel = elements
      .map((element) => ({ element, text: (element.textContent || "").replace(/\s+/g, "").trim(), rect: element.getBoundingClientRect() }))
      .filter(({ text, rect }) => text === "关注" && rect.width > 0 && rect.height > 0 && rect.left > 180 && rect.top < 420)
      .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0]?.element;
    const target = candidates[0]?.element || exactLabel?.closest("a, button") || exactLabel?.parentElement;
    if (!target) return false;
    target.click();
    return true;
  });
  if (!clicked) {
    const diagnostic = await page.evaluate(() => (document.body?.innerText || "").slice(0, 600).replace(/\s+/g, " "));
    throw new Error(`未找到主页上的关注列表入口，请确认 Cookie 对应的是本人账号。页面内容：${diagnostic}`);
  }
  await page.waitForTimeout(8000);
}

async function collectDomUsers(page, users, max) {
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/user/"]')).map((anchor) => {
    const match = anchor.href.match(/\/user\/([^/?#]+)/);
    if (!match) return null;
    const container = anchor.closest("li") || anchor.closest('[role="dialog"] div') || anchor.parentElement;
    const lines = String(container?.innerText || anchor.innerText || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
    const nickname = lines.find((line) => line.length <= 32 && !/已关注|关注|粉丝|作品未看|综合排序/.test(line)) || "";
    const image = container?.querySelector("img") || anchor.querySelector("img");
    return { sec_uid: decodeURIComponent(match[1]), nickname, avatar_url: image?.currentSrc || image?.src || "", profile_url: `https://www.douyin.com/user/${decodeURIComponent(match[1])}` };
  }).filter(Boolean));
  let added = 0;
  for (const row of rows) if (mergeUser(users, row, max)) added += 1;
  return added;
}

async function scrollFollowing(page) {
  return page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll("*"))
      .map((element) => ({ element, rect: element.getBoundingClientRect(), range: element.scrollHeight - element.clientHeight }))
      .filter(({ rect, range }) => range > 120 && rect.left > 180 && rect.width > 360 && rect.height > 260)
      .sort((a, b) => b.range - a.range);
    const target = candidates[0]?.element;
    if (!target) return false;
    target.scrollTop = target.scrollHeight;
    return true;
  });
}

async function extractFollowing(opts) {
  const browser = await chromium.launch({ executablePath: browserPath(opts.browser), headless: !opts.headed, args: ["--disable-blink-features=AutomationControlled"] });
  const users = new Map();
  let checkpoint = Promise.resolve();
  const writeCheckpoint = () => {
    if (!opts.out) return;
    const payload = { source: opts.url, count: users.size, users: [...users.values()], extracted_at: new Date().toISOString(), partial: true };
    checkpoint = checkpoint.then(async () => {
      await fsp.mkdir(path.dirname(path.resolve(opts.out)), { recursive: true });
      await fsp.writeFile(opts.out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    });
  };
  try {
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      locale: "zh-CN",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      extraHTTPHeaders: { "Accept-Language": "zh-CN,zh;q=0.9" },
    });
    const cookies = parseNetscapeCookies(opts.cookieFile);
    if (cookies.length) await context.addCookies(cookies);
    console.error(`[following] loaded ${cookies.length} cookies`);
    const page = await context.newPage();
    page.on("response", async (response) => {
      try {
        const url = response.url();
        if (!/following|follow\/list|relation\/follow/i.test(url)) return;
        const contentType = response.headers()["content-type"] || "";
        if (!/json|text|javascript/i.test(contentType)) return;
        const data = JSON.parse(await response.text());
        const found = [];
        collectUsers(data, found);
        const responseUrl = new URL(url);
        const offset = Number(responseUrl.searchParams.get("offset") || 0);
        console.error(`[following] response offset=${offset}: ${found.length} user candidate(s)`);
        found.forEach((user) => mergeUser(users, user, opts.max));
        if (offset % 200 === 0) writeCheckpoint();
      } catch {
        // DOM collection remains available when response parsing fails.
      }
    });
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(3500);
    await clickFollowing(page);
    let stable = 0;
    let lastCount = -1;
    for (let round = 0; round < opts.scrolls; round += 1) {
      await collectDomUsers(page, users, opts.max);
      const count = users.size;
      console.error(`[following] round ${round + 1}: ${count} user(s)`);
      if (opts.max > 0 && count >= opts.max) break;
      stable = count === lastCount ? stable + 1 : 0;
      lastCount = count;
      if (stable >= opts.idleRounds) break;
      const scrolled = await scrollFollowing(page);
      if (!scrolled) await page.mouse.wheel(0, 760);
      await page.waitForTimeout(700);
    }
    writeCheckpoint();
    await checkpoint;
  } finally {
    await browser.close();
  }
  return [...users.values()].slice(0, opts.max > 0 ? opts.max : undefined);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const users = await extractFollowing(opts);
  const payload = { source: opts.url, count: users.length, users, extracted_at: new Date().toISOString() };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (opts.out) {
    await fsp.mkdir(path.dirname(path.resolve(opts.out)), { recursive: true });
    await fsp.writeFile(opts.out, text, "utf8");
  }
  process.stdout.write(text);
}

main().catch((error) => {
  console.error(`[error] ${error.stack || error.message || String(error)}`);
  process.exitCode = 1;
});
