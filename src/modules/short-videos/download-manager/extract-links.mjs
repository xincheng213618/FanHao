import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { chromium } from "playwright-core";
import {
  collectConfirmedLikeItems,
  hasUsableWorkMetadata,
} from "./like-extraction.mjs";
import { profileNicknameFromSnapshot } from "./profile-nickname.mjs";

const defaultCookieFile = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "douyin-downloader-desktop",
  "custom-batch-douyin-cookies.txt"
);

function parseArgs(argv) {
  const opts = {
    url: "",
    out: "",
    max: 0,
    scrolls: 260,
    idleRounds: 20,
    streamOut: "",
    flushEvery: 25,
    headed: false,
    browser: "edge",
    cookieFile: defaultCookieFile,
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith("--")) {
    opts.url = args.shift();
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = () => {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1;
      return next;
    };
    if (arg === "--out") opts.out = value();
    else if (arg === "--max") opts.max = Number(value());
    else if (arg === "--scrolls") opts.scrolls = Number(value());
    else if (arg === "--idle-rounds") opts.idleRounds = Number(value());
    else if (arg === "--stream-out") opts.streamOut = value();
    else if (arg === "--flush-every") opts.flushEvery = Number(value());
    else if (arg === "--cookie-file") opts.cookieFile = value();
    else if (arg === "--browser") opts.browser = value();
    else if (arg === "--headed") opts.headed = true;
    else if (arg === "--headless") opts.headed = false;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!opts.url) throw new Error("Profile URL is required");
  if (!Number.isFinite(opts.max) || opts.max < 0) opts.max = 0;
  if (!Number.isFinite(opts.scrolls) || opts.scrolls < 1) opts.scrolls = 260;
  if (!Number.isFinite(opts.idleRounds) || opts.idleRounds < 1) opts.idleRounds = 20;
  if (!Number.isFinite(opts.flushEvery) || opts.flushEvery < 1) opts.flushEvery = 25;
  return opts;
}

function browserPath(kind) {
  const candidates = {
    edge: [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ],
    chrome: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  };
  if (kind && fs.existsSync(kind)) return kind;
  for (const p of candidates[kind] || [...candidates.edge, ...candidates.chrome]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`Browser executable not found for ${kind}`);
}

function parseNetscapeCookies(file) {
  if (!file || !fs.existsSync(file)) return [];
  const cookies = [];
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const [domain, , cookiePath, secure, expires, name, ...valueParts] = parts;
    const value = valueParts.join("\t");
    if (!domain || !name) continue;
    cookies.push({
      name,
      value,
      domain,
      path: cookiePath || "/",
      secure: secure === "TRUE",
      expires: Number(expires) > 0 ? Number(expires) : undefined,
      sameSite: "Lax",
    });
  }
  return cookies;
}

function workFromHref(href) {
  if (!href) return null;
  try {
    const url = new URL(href, "https://www.douyin.com");
    const pathMatch = url.pathname.match(/^\/(video|note|gallery|slides)\/(\d{16,22})$/);
    if (pathMatch) {
      const kind = pathMatch[1] === "video" ? "video" : "note";
      const awemeId = pathMatch[2];
      return {
        aweme_id: awemeId,
        kind,
        url: `https://www.douyin.com/${kind}/${awemeId}`,
      };
    }
    const modalId = url.searchParams.get("modal_id") || url.searchParams.get("vid");
    if (modalId && /^\d{16,22}$/.test(modalId)) {
      return {
        aweme_id: modalId,
        kind: "video",
        url: `https://www.douyin.com/video/${modalId}`,
      };
    }
  } catch {
    const rawMatch = String(href).match(/\/(video|note|gallery|slides)\/(\d{16,22})(?:\D|$)/);
    if (rawMatch) {
      const kind = rawMatch[1] === "video" ? "video" : "note";
      const awemeId = rawMatch[2];
      return {
        aweme_id: awemeId,
        kind,
        url: `https://www.douyin.com/${kind}/${awemeId}`,
      };
    }
  }
  return null;
}

function profileSecUidFromUrl(value) {
  try {
    const url = new URL(value, "https://www.douyin.com");
    const match = url.pathname.match(/^\/user\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    const match = String(value || "").match(/\/user\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : "";
  }
}

function isLikeProfileUrl(value) {
  try {
    const url = new URL(value, "https://www.douyin.com");
    return url.searchParams.get("showTab") === "like";
  } catch {
    return /[?&]showTab=like(?:&|$)/i.test(String(value || ""));
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return Math.trunc(number);
  }
  return null;
}

function parseHumanNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const text = String(value || "").replace(/,/g, "").trim();
  if (!text) return null;
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*([万亿wk])?/i);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const unit = String(match[2] || "").toLowerCase();
  const multiplier = unit === "亿" ? 100000000 : unit === "万" || unit === "w" ? 10000 : unit === "k" ? 1000 : 1;
  return Math.trunc(base * multiplier);
}

function firstHumanNumber(...values) {
  for (const value of values) {
    const number = parseHumanNumber(value);
    if (Number.isFinite(number)) return number;
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
    return firstUrlAny(
      value.url_list,
      value.urlList,
      value.urls,
      value.url,
      value.uri,
      value.src,
      value.origin_url,
      value.originUrl,
      value.display_url,
      value.displayUrl
    );
  }
  return "";
}

function extractProfile(value) {
  if (!value || typeof value !== "object") return null;
  const user =
    value.user ||
    value.userInfo ||
    value.user_info ||
    value.author ||
    value.authorInfo ||
    value.author_info ||
    value.profile ||
    value;
  if (!user || typeof user !== "object") return null;
  const secUid = firstString(
    user.sec_uid,
    user.secUid,
    user.sec_user_id,
    user.secUserId,
    value.sec_uid,
    value.secUid
  );
  const uid = firstString(user.uid, user.id, user.user_id, user.userId, value.uid, value.user_id, value.userId);
  const nickname = firstString(user.nickname, user.nick_name, user.nickName, user.name, value.nickname);
  const uniqueId = firstString(user.unique_id, user.uniqueId, value.unique_id, value.uniqueId);
  const shortId = firstString(user.short_id, user.shortId, value.short_id, value.shortId);
  const signature = firstString(user.signature, user.desc, user.description, user.bio, value.signature);
  const followerCount = firstHumanNumber(user.follower_count, user.followerCount, user.fans_count, user.fansCount);
  const followingCount = firstHumanNumber(user.following_count, user.followingCount);
  const totalFavorited = firstHumanNumber(user.total_favorited, user.totalFavorited, user.total_favorite, user.totalFavorite);
  const awemeCount = firstHumanNumber(user.aweme_count, user.awemeCount, user.work_count, user.workCount);
  const favoritingCount = firstHumanNumber(user.favoriting_count, user.favoritingCount);
  const hasProfileSignal =
    secUid ||
    uid ||
    nickname ||
    uniqueId ||
    shortId ||
    signature ||
    followerCount !== null ||
    followingCount !== null ||
    totalFavorited !== null ||
    awemeCount !== null;
  if (!hasProfileSignal) return null;
  const avatarUrl = firstUrlAny(
    user.avatar_thumb,
    user.avatar_medium,
    user.avatar_larger,
    user.avatar,
    user.avatar_url,
    user.avatarUrl,
    user.avatarThumb
  );
  return {
    uid,
    sec_uid: secUid,
    nickname,
    avatar_url: avatarUrl,
    unique_id: uniqueId,
    short_id: shortId,
    signature,
    ip_location: firstString(user.ip_location, user.ipLocation, user.ip_label, user.ipLabel),
    following_count: followingCount,
    follower_count: followerCount,
    total_favorited: totalFavorited,
    aweme_count: awemeCount,
    favoriting_count: favoritingCount,
    gender: firstNumber(user.gender),
    age: firstNumber(user.age),
    verification: firstString(user.custom_verify, user.customVerify, user.enterprise_verify_reason, user.enterpriseVerifyReason),
    profile_url: secUid ? `https://www.douyin.com/user/${secUid}` : "",
    raw_json: user,
  };
}

function collectJsonProfiles(value, out, depth = 0) {
  if (!value || depth > 10) return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonProfiles(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const profile = extractProfile(value);
  if (profile) out.push(profile);
  for (const child of Object.values(value)) {
    if (child && (Array.isArray(child) || typeof child === "object")) {
      collectJsonProfiles(child, out, depth + 1);
    }
  }
}

function profileScore(profile = {}) {
  let score = 0;
  for (const key of ["sec_uid", "uid", "nickname", "avatar_url", "unique_id", "short_id", "signature", "ip_location"]) {
    if (profile[key]) score += key === "sec_uid" ? 8 : 3;
  }
  for (const key of ["following_count", "follower_count", "total_favorited", "aweme_count", "favoriting_count", "age"]) {
    if (Number.isFinite(Number(profile[key]))) score += 2;
  }
  return score;
}

function pickBestProfile(profiles) {
  return [...(profiles || [])].sort((a, b) => profileScore(b) - profileScore(a))[0] || null;
}

function pickTargetProfile(profiles, targetSecUid) {
  if (!targetSecUid) return pickBestProfile(profiles);
  const exact = (profiles || []).filter((profile) => profile?.sec_uid === targetSecUid);
  return pickBestProfile(exact);
}

function mergeProfile(target, incoming, overwriteKeys = new Set()) {
  if (!incoming) return false;
  let changed = false;
  for (const [key, value] of Object.entries(incoming)) {
    if (value === "" || value === null || value === undefined) continue;
    if (key === "raw_json") {
      const text = JSON.stringify(value);
      if (text && text !== JSON.stringify(target.raw_json || null)) {
        target.raw_json = value;
        changed = true;
      }
      continue;
    }
    if (target[key] !== value && (overwriteKeys.has(key) || !target[key] || Number.isFinite(Number(value)))) {
      target[key] = value;
      changed = true;
    }
  }
  return changed;
}

function domProfileFromSnapshot(snapshot = {}) {
  const text = String(snapshot.text || "");
  const labelNumber = (label) => {
    const match = text.match(new RegExp(`${label}\\s*([0-9.,]+\\s*[万亿wk]?)`, "i"));
    return match ? parseHumanNumber(match[1]) : null;
  };
  const douyinId = (text.match(/抖音号[:：]?\s*([A-Za-z0-9_.-]+)/) || [])[1] || "";
  const ipLocation = ((text.match(/IP属地[:：]?\s*([^\s｜|·]+)/) || [])[1] || "").replace(/^IP属地[:：]?/u, "");
  const age = firstNumber((text.match(/(\d{1,3})\s*岁/) || [])[1]);
  return {
    nickname: profileNicknameFromSnapshot(snapshot),
    avatar_url: firstUrlAny(snapshot.avatar_url),
    unique_id: douyinId,
    short_id: /^\d+$/.test(douyinId) ? douyinId : "",
    ip_location: ipLocation,
    following_count: labelNumber("关注"),
    follower_count: labelNumber("粉丝"),
    total_favorited: labelNumber("获赞"),
    aweme_count: labelNumber("作品"),
    age,
  };
}

function firstUrlAny(...values) {
  for (const value of values) {
    const url = firstUrl(value);
    if (url) return url;
  }
  return "";
}

function extractAuthor(value) {
  const author = value.author || value.authorInfo || value.author_info || value.user || value.userInfo || value.user_info || {};
  const authorSecUid = firstString(
    author.sec_uid,
    author.secUid,
    author.sec_user_id,
    author.secUserId,
    value.author_sec_uid,
    value.authorSecUid,
    value.sec_author_id,
    value.secAuthorId
  );
  return {
    author_uid: firstString(
      author.uid,
      author.id,
      author.user_id,
      author.userId,
      value.author_uid,
      value.authorUid,
      value.author_user_id,
      value.authorUserId
    ),
    author_sec_uid: authorSecUid,
    author_nickname: firstString(
      author.nickname,
      author.nick_name,
      author.nickName,
      author.name,
      value.author_nickname,
      value.authorNickname,
      value.nickname
    ),
    author_avatar_url: firstUrlAny(
      author.avatar_thumb,
      author.avatar_medium,
      author.avatar_larger,
      author.avatar,
      author.avatar_url,
      author.avatarUrl,
      author.avatarThumb,
      value.author_avatar_url,
      value.authorAvatarUrl
    ),
    author_url: firstString(author.url, author.user_url, author.userUrl, value.author_url, value.authorUrl)
      || (authorSecUid ? `https://www.douyin.com/user/${authorSecUid}` : ""),
  };
}

function extractPreview(value, kind) {
  const video = value.video || {};
  const stats = value.statistics || value.stats || value.stat || {};
  const images =
    value.images ||
    value.image_infos ||
    value.imageInfos ||
    value.images_info ||
    value.image_list ||
    value.imageList ||
    [];
  return {
    desc: firstString(value.desc, value.title, value.caption, value.text, value.content),
    cover_url: firstUrlAny(
      video.cover,
      video.origin_cover,
      video.dynamic_cover,
      value.cover,
      value.origin_cover,
      value.preview_cover,
      value.thumbnail,
      Array.isArray(images) ? images[0] : null
    ),
    create_time: firstNumber(value.create_time, value.createTime, value.publish_time, value.publishTime),
    duration_ms: firstNumber(video.duration, value.duration_ms, value.duration, value.durationMs),
    digg_count: firstNumber(stats.digg_count, stats.diggCount, stats.like_count, stats.likeCount, value.digg_count, value.like_count),
    comment_count: firstNumber(stats.comment_count, stats.commentCount, value.comment_count),
    share_count: firstNumber(stats.share_count, stats.shareCount, value.share_count),
    collect_count: firstNumber(stats.collect_count, stats.collectCount, value.collect_count),
    media_type: kind === "note" ? "gallery" : "video",
  };
}

function workFromObject(value) {
  if (!value || typeof value !== "object") return null;
  const rawId = value.aweme_id || value.awemeId || value.group_id || value.groupId || value.item_id || value.itemId;
  const awemeId = String(rawId || "");
  if (!/^\d{16,22}$/.test(awemeId)) return null;
  const hasImages =
    Array.isArray(value.images) ||
    Array.isArray(value.image_infos) ||
    Array.isArray(value.imageInfos) ||
    Array.isArray(value.images_info) ||
    Array.isArray(value.animated_cover);
  const kind = hasImages ? "note" : "video";
  return {
    aweme_id: awemeId,
    kind,
    url: `https://www.douyin.com/${kind}/${awemeId}`,
    ...extractAuthor(value),
    ...extractPreview(value, kind),
  };
}

function collectJsonWorks(value, out, depth = 0) {
  if (!value || depth > 12) return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonWorks(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const work = workFromObject(value);
  if (work) out.push(work);
  for (const child of Object.values(value)) {
    if (child && (Array.isArray(child) || typeof child === "object")) {
      collectJsonWorks(child, out, depth + 1);
    }
  }
}

const REFRESHED_WORK_FIELDS = new Set([
  "digg_count",
  "comment_count",
  "share_count",
  "collect_count",
]);

function addWork(works, pending, work, max = 0) {
  if (!work || !work.aweme_id) return false;
  if (works.has(work.aweme_id)) {
    const existing = works.get(work.aweme_id);
    let changed = false;
    for (const key of [
      "author_uid",
      "author_sec_uid",
      "author_nickname",
      "author_avatar_url",
      "author_url",
      "desc",
      "cover_url",
      "create_time",
      "duration_ms",
      "digg_count",
      "comment_count",
      "share_count",
      "collect_count",
      "media_type",
    ]) {
      const incoming = work[key];
      const hasIncoming = incoming !== undefined && incoming !== null && incoming !== "";
      if (
        (REFRESHED_WORK_FIELDS.has(key) && hasIncoming && !Object.is(existing[key], incoming))
        || (!REFRESHED_WORK_FIELDS.has(key) && !existing[key] && incoming)
      ) {
        existing[key] = incoming;
        changed = true;
      }
    }
    if (changed) pending.push(existing);
    return false;
  }
  if (max > 0 && works.size >= max) return false;
  works.set(work.aweme_id, work);
  pending.push(work);
  return true;
}

function createJsonlWriter(file) {
  let chain = Promise.resolve();
  async function write(row) {
    if (!file) return;
    const line = `${JSON.stringify(row)}\n`;
    chain = chain.then(() => fsp.appendFile(file, line, "utf8"));
    await chain;
  }
  return { write, drain: () => chain };
}

async function flushPending(writer, pending, reason, count) {
  if (!pending.length) return 0;
  const works = pending.splice(0, pending.length);
  await writer.write({ type: "works", reason, count, works });
  return works.length;
}

async function collectCardLinks(page, works, pending, max) {
  const rows = await page.evaluate(() => {
    const anchors = Array.from(
      document.querySelectorAll(
        'a[href*="/video/"], a[href*="/note/"], a[href*="/gallery/"], a[href*="/slides/"], a[href*="modal_id="], a[href*="vid="]'
      )
    );
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const rows = [];
    for (const anchor of anchors) {
      const rect = anchor.getBoundingClientRect();
      const looksLikeProfileCard =
        rect.width >= 80 &&
        rect.height >= 80 &&
        rect.right > 260 &&
        rect.left < viewportWidth - 20;
      if (!looksLikeProfileCard) continue;
      const image = anchor.querySelector("img");
      rows.push({
        href: anchor.href,
        desc: (anchor.getAttribute("title") || image?.alt || anchor.innerText || "").trim(),
        cover_url: image?.currentSrc || image?.src || "",
      });
    }
    return rows;
  });

  let added = 0;
  for (const row of rows) {
    const work = workFromHref(row.href);
    if (work) {
      if (row.desc) work.desc = row.desc;
      if (row.cover_url) work.cover_url = row.cover_url;
    }
    if (!hasUsableWorkMetadata(work)) continue;
    if (addWork(works, pending, work, max)) added += 1;
  }
  return added;
}

async function collectDomProfile(page) {
  return page.evaluate(() => {
    const text = (document.body?.innerText || "").slice(0, 8000);
    const heading =
      document.querySelector("h1")?.textContent?.trim() ||
      Array.from(document.querySelectorAll("span, div"))
        .map((node) => (node.textContent || "").trim())
        .find((line) => line && line.length <= 32 && !/关注|粉丝|获赞|作品|推荐|喜欢|合集/.test(line)) ||
      "";
    const images = Array.from(document.querySelectorAll("img"));
    const normalizedHeading = heading.replace(/\s+/g, "").toLowerCase();
    const avatarImage =
      images.find((img) => {
        const alt = String(img.alt || "").replace(/\s+/g, "").toLowerCase();
        return normalizedHeading && alt.includes(normalizedHeading) && /头像|avatar/.test(alt);
      }) ||
      images.find((img) => {
        const rect = img.getBoundingClientRect();
        const src = img.currentSrc || img.src || "";
        return rect.width >= 48 && rect.height >= 48 && rect.top < 420 && /avatar|aweme-avatar|douyinpic/i.test(src);
      }) ||
      images.find((img) => /avatar|aweme-avatar/i.test(img.currentSrc || img.src || ""));
    const avatar = avatarImage?.currentSrc || avatarImage?.src || "";
    return {
      title: document.title || "",
      heading,
      avatar_url: avatar,
      text,
    };
  });
}

async function scrollProfileGrid(page, pixels) {
  await page.evaluate((amount) => {
    const candidates = Array.from(document.querySelectorAll("*"))
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          el,
          rect,
          range: el.scrollHeight - el.clientHeight,
        };
      })
      .filter((row) => row.range > 200 && row.rect.left > 100 && row.rect.width > 400)
      .sort((a, b) => b.range - a.range);
    const target = candidates[0]?.el || document.scrollingElement || document.documentElement;
    target.scrollTop += amount;
  }, pixels);
}

async function extractWorks(opts) {
  const executablePath = browserPath(opts.browser);
  const browser = await chromium.launch({
    executablePath,
    headless: !opts.headed,
    args: ["--disable-blink-features=AutomationControlled"],
  });
  const works = new Map();
  const pending = [];
  const writer = createJsonlWriter(opts.streamOut);
  const profile = {};
  const rawTargetSecUid = profileSecUidFromUrl(opts.url);
  const targetSecUid = rawTargetSecUid.toLowerCase() === "self" ? "" : rawTargetSecUid;
  const likeProfile = isLikeProfileUrl(opts.url);
  const filterToTargetAuthor = Boolean(targetSecUid && !likeProfile);
  if (targetSecUid) profile.sec_uid = targetSecUid;
  const emitProfile = async (reason, incoming) => {
    if (incoming && targetSecUid) incoming.sec_uid = targetSecUid;
    const overwriteKeys = reason === "dom" ? new Set(["nickname", "avatar_url", "unique_id", "short_id", "ip_location"]) : new Set();
    if (!mergeProfile(profile, incoming, overwriteKeys)) return;
    await writer.write({ type: "profile", reason, profile: { ...profile } });
  };
  const shouldKeepWork = (work) => {
    if (!work) return false;
    if (!filterToTargetAuthor) return true;
    return work.author_sec_uid === targetSecUid;
  };
  try {
    const context = await browser.newContext({
      viewport: { width: 1365, height: 900 },
      locale: "zh-CN",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      extraHTTPHeaders: {
        "Accept-Language": "zh-CN,zh;q=0.9",
      },
    });
    const cookies = parseNetscapeCookies(opts.cookieFile);
    if (cookies.length > 0) {
      await context.addCookies(cookies);
      console.error(`[extract] loaded ${cookies.length} cookies`);
    } else {
      console.error("[extract] no cookie file loaded; public pages may be limited");
    }

    const page = await context.newPage();
    page.on("response", async (response) => {
      try {
        const request = response.request();
        const resourceType = request.resourceType();
        const url = response.url();
        const contentType = response.headers()["content-type"] || "";
        const likelyData =
          resourceType === "xhr" ||
          resourceType === "fetch" ||
          /aweme|favorite|post|like|recommend|feed/i.test(url);
        if (!likelyData || !/json|text|javascript/i.test(contentType)) return;
        const text = await response.text();
        if (!text || text.length > 8_000_000) return;
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          return;
        }
        const found = [];
        if (likeProfile) {
          for (const item of collectConfirmedLikeItems(data, targetSecUid)) {
            const work = workFromObject(item);
            if (work) found.push(work);
          }
        } else {
          collectJsonWorks(data, found);
        }
        const profiles = [];
        collectJsonProfiles(data, profiles);
        await emitProfile("network", pickTargetProfile(profiles, targetSecUid));
        let added = 0;
        for (const work of found) {
          if (!shouldKeepWork(work)) continue;
          if (addWork(works, pending, work, opts.max)) added += 1;
        }
        if (added > 0 && pending.length >= opts.flushEvery) {
          await flushPending(writer, pending, "network", works.size);
        }
      } catch {
        // Network parsing is best-effort; DOM collection still runs.
      }
    });
    console.error(`[extract] opening ${opts.url}`);
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(4000);
    await emitProfile("dom", domProfileFromSnapshot(await collectDomProfile(page)));

    let stable = 0;
    let lastCount = 0;
    for (let round = 0; round < opts.scrolls; round += 1) {
      if (!filterToTargetAuthor) await collectCardLinks(page, works, pending, opts.max);
      if (round === 0 || round % 5 === 4) {
        await emitProfile("dom", domProfileFromSnapshot(await collectDomProfile(page)));
      }
      await flushPending(writer, pending, "dom", works.size);
      const count = works.size;
      console.error(`[extract] round ${round + 1}: ${count} work URL(s)`);
      await writer.write({ type: "progress", round: round + 1, count, stable });
      if (opts.max > 0 && count >= opts.max) break;
      stable = count === lastCount ? stable + 1 : 0;
      lastCount = count;
      const expectedWorks = filterToTargetAuthor ? Number(profile.aweme_count || 0) : 0;
      const expectedGapTolerance = Math.max(2, Math.ceil(expectedWorks * 0.005));
      const nearExpectedWorks = expectedWorks > 0 && count >= Math.max(1, expectedWorks - expectedGapTolerance);
      const nearExpectedIdleRounds = Math.min(opts.idleRounds, 20);
      if (nearExpectedWorks && stable >= nearExpectedIdleRounds) {
        console.error(
          `[extract] collected ${count}/${expectedWorks} work URL(s), stable ${stable} round(s); finishing early`
        );
        break;
      }
      if (stable >= opts.idleRounds) break;
      await page.mouse.wheel(0, 900);
      await scrollProfileGrid(page, 900);
      await page.waitForTimeout(1200);
    }
    await flushPending(writer, pending, "final", works.size);
    await writer.write({ type: "done", count: works.size, profile: { ...profile } });
    await writer.drain();
  } finally {
    await browser.close();
  }

  const worksList = [...works.values()];
  return {
    works: opts.max > 0 ? worksList.slice(0, opts.max) : worksList,
    profile: { ...profile },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = await extractWorks(opts);
  const works = result.works || [];
  const payload = {
    source: opts.url,
    count: works.length,
    profile: result.profile || {},
    works,
    extracted_at: new Date().toISOString(),
  };
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
