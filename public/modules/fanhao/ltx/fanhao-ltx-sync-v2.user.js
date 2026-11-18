// ==UserScript==
// @name         FanHao · Jasna-LTX 目录同步 (加密站 v2)
// @namespace    fanhao.ltx
// @version      2.0.0
// @match        https://ltxlib.dpdns.org/*
// @run-at       document-start
// @grant        unsafeWindow
// @noframes
// ==/UserScript==
//
// 也可以直接把整个文件粘进官网页面的 DevTools Console 运行。
// 站点从 2026-11 起启用 Turnstile + ECDH/AES-GCM 加密响应，
// 会话密钥只在页面内存里，因此不能把 /api/items 的响应体拷出来离线解密。
// 本脚本在页面内自行协商会话并解密，再把目录转换成 FanHao 需要的格式。

(() => {
  "use strict";

  const w = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const OFFICIAL = "https://ltxlib.dpdns.org";
  const LABEL = "[FanHao LTX]";
  const DOMAIN = "ltx-api-response-v1";
  const SESSION_URL = "/api/crypto/session";
  const ITEMS_URL = "/api/items";
  const QUERY_URL = "/api/items/query";
  const LINK_RE = /^(?:ed2k:\/\/\|file\||magnet:\?)/i;
  const MAX_BYTES = 32 * 1024 * 1024;
  const ITEM_FIELDS = ["code", "title", "title_zh", "actors", "maker", "cover", "url", "subtitle",
    "added_at", "date", "score", "votes", "genres", "pending", "waiting", "missing"];

  const log = (...args) => console.log(LABEL, ...args);
  const warn = (...args) => console.warn(LABEL, ...args);

  function toBytes(value) {
    let text = String(value).replace(/-/g, "+").replace(/_/g, "/");
    text += "=".repeat((4 - text.length % 4) % 4);
    const binary = w.atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function toBase64Url(bytes) {
    let text = "";
    for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
    return w.btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function aad(sid, rid, method, path, status, encoding) {
    return new TextEncoder().encode(JSON.stringify([
      DOMAIN, sid, rid, method.toUpperCase(), path, status, encoding
    ]));
  }

  // 1) ECDH P-256 -> HKDF(SHA-256, salt, info="ltx-api-response-v1:<sid>") -> AES-GCM 256
  async function negotiate() {
    const pair = await w.crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const publicKey = toBase64Url(await w.crypto.subtle.exportKey("raw", pair.publicKey));
    const response = await w.fetch(SESSION_URL, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ v: 1, publicKey })
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`会话协商失败 HTTP ${response.status} ${detail.slice(0, 120)}`);
    }
    const info = await response.json();
    if (info.v !== 1 || typeof info.sid !== "string" || !info.sid) throw new Error("会话响应格式异常");
    const serverKey = await w.crypto.subtle.importKey("raw", toBytes(info.publicKey),
      { name: "ECDH", namedCurve: "P-256" }, false, []);
    const bits = await w.crypto.subtle.deriveBits({ name: "ECDH", public: serverKey }, pair.privateKey, 256);
    const hkdf = await w.crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    const key = await w.crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: toBytes(info.salt), info: new TextEncoder().encode(`${DOMAIN}:${info.sid}`) },
      hkdf, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    return { sid: info.sid, key, expiresAt: info.expiresAt };
  }

  async function decryptEnvelope(response, session, rid, method, path) {
    const envelope = await response.clone().json();
    const { sid, rid: echoRid, v, encoding, iv, body } = envelope || {};
    if (v !== 1 || sid !== session.sid || echoRid !== rid
      || (encoding !== "identity" && encoding !== "gzip")) {
      throw new Error("加密响应头不匹配（会话可能已过期）");
    }
    const plain = await w.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toBytes(iv), additionalData: aad(sid, rid, method, path, response.status, encoding) },
      session.key, toBytes(body));
    let buffer = plain;
    if (encoding === "gzip") {
      const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream("gzip"));
      buffer = await new Response(stream).arrayBuffer();
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
  }

  async function call(state, path, { method = "GET", body, retried = false } = {}) {
    const session = state.session;
    const rid = toBase64Url(w.crypto.getRandomValues(new Uint8Array(16)));
    const headers = { Accept: "application/json", "X-LTX-Session": session.sid, "X-LTX-Request": rid };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await w.fetch(path, {
      method, credentials: "include", headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (response.status === 428 && !retried) {
      state.session = await negotiate();
      return call(state, path, { method, body, retried: true });
    }
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`${method} ${path} -> HTTP ${response.status} ${detail.slice(0, 120)}`);
    }
    if (!contentType.includes("vnd.ltx.encrypted+json")) return response.json();
    return decryptEnvelope(response, session, rid, method, path);
  }

  function toFanhaoItem(item) {
    const mapped = {};
    for (const field of ITEM_FIELDS) {
      let value = item[field];
      if (field === "score" && value == null) value = item.rawScore;
      if ((field === "actors" || field === "genres") && !Array.isArray(value)) value = [];
      if ((field === "pending" || field === "waiting" || field === "missing") && value == null) value = false;
      mapped[field] = value ?? (field === "actors" || field === "genres" ? [] : "");
    }
    // 新站把下载链接改成单条 link + linkPending；旧站是 links[] + pending_links[]。
    const rawLinks = Array.isArray(item.links) ? item.links
      : typeof item.link === "string" && item.link ? [item.link] : [];
    const pendingLinks = Array.isArray(item.pending_links) ? item.pending_links
      : item.linkPending && typeof item.link === "string" ? [item.link] : [];
    const pending = new Set(pendingLinks);
    mapped.links = rawLinks.filter((link) => typeof link === "string" && LINK_RE.test(link) && !pending.has(link));
    return mapped;
  }

  async function collect() {
    const state = { session: null };
    const deadline = Date.now() + 90_000;
    while (!state.session && Date.now() < deadline) {
      try { state.session = await negotiate(); }
      catch (error) {
        log("等待官网人机验证/会话…", error.message);
        await new Promise((resolve) => setTimeout(resolve, 2500));
      }
    }
    if (!state.session) throw new Error("无法建立加密会话，请先在官网完成人机验证并确认已显示作品列表。");
    log("会话已建立", state.session.sid);

    const first = await call(state, ITEMS_URL);
    if (!Array.isArray(first.items) || typeof first.snapshot !== "string") {
      throw new Error("目录响应格式异常，字段：" + Object.keys(first || {}).join(","));
    }
    const items = [...first.items];
    const limit = 100;
    let offset = (Number(first.offset) || 0) + items.length;
    let pages = 0;
    while (pages < 120) {
      const page = await call(state, QUERY_URL, {
        method: "POST",
        body: {
          snapshot: first.snapshot, offset, limit, q: "", status: "all", genres: [],
          sort: { field: "score", dir: "desc" }, metadata: true
        }
      });
      const batch = Array.isArray(page.items) ? page.items : [];
      if (!batch.length) break;
      items.push(...batch);
      offset += batch.length;
      pages += 1;
      if (page.hasMore === false || (Number.isFinite(page.total) && items.length >= page.total)) break;
    }

    const seen = new Set();
    const unique = items.filter((item) => {
      if (!item || typeof item.code !== "string" || !item.code.trim() || seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    });
    const mapped = unique.map(toFanhaoItem);
    const catalog = {
      items: mapped,
      avatars: first.avatars || {},
      genres: first.genres || {},
      updated_at: first.updated_at
    };
    const fields = [...new Set(items.flatMap((item) => Object.keys(item || {})))];
    log("原始 item 字段", fields.join(", "));
    log(`共 ${mapped.length} 部（${pages} 页追加），其中有已确认链接 ${mapped.filter((i) => i.links.length).length} 部`);
    log("样例", mapped[0]);
    if (!mapped.some((item) => item.links.length)) warn("没有解析到任何 ed2k/magnet 链接，请检查上面的字段清单。");
    return catalog;
  }

  function download(catalog) {
    const blob = new Blob([JSON.stringify(catalog)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = w.document.createElement("a");
    link.href = url;
    link.download = "ltx-catalog.json";
    w.document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function main() {
    // 油猴脚本只在「更新目录」打开的小窗里自动工作；粘进 Console 时总是运行。
    const inUserscript = typeof unsafeWindow !== "undefined"
      || typeof GM_info !== "undefined" || typeof GM !== "undefined";
    const params = new URLSearchParams(w.location.hash.slice(1));
    const id = params.get("fanhaoCatalog");
    const origin = params.get("fanhaoOrigin");
    const opener = w.opener;
    const popupMode = !!opener && /^[0-9a-f-]{36}$/i.test(id || "")
      && ["http://127.0.0.1:29998", "http://localhost:29998"].includes(origin);
    if (inUserscript && !popupMode) return;
    if (popupMode) opener.postMessage({ type: "fanhao:ltx:ready", id }, origin);

    try {
      const catalog = await collect();
      const json = JSON.stringify(catalog);
      if (new Blob([json]).size > MAX_BYTES) throw new Error("目录超过 32 MiB 限制。");
      if (popupMode) {
        opener.postMessage({ type: "fanhao:ltx:catalog", id, json }, origin);
        log("已回传给 FanHao，可以关闭本小窗。");
      } else {
        download(catalog);
        log("已下载 ltx-catalog.json，在 FanHao「更新目录」里选「选择文件」导入即可。");
      }
    } catch (error) {
      warn("同步失败：", error);
      if (popupMode) opener.postMessage({ type: "fanhao:ltx:ready", id }, origin);
      console.error(LABEL, error);
    }
  }

  if (w.location.origin !== OFFICIAL) return;
  if (w.document.readyState === "loading") w.document.addEventListener("DOMContentLoaded", main, { once: true });
  else main();
})();
