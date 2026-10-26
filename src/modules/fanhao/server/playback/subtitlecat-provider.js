import { createHash } from "node:crypto";
import { extractWorkCodes, normalizeWorkCode, workCodeKey } from "../../../../../lib/code-parser.js";

const ORIGIN = "https://www.subtitlecat.com";
const LANGUAGE_LABELS = { "zh-CN": "简体中文", "zh-TW": "繁体中文", ja: "日语", en: "英语" };
const LANGUAGE_ORDER = ["zh-CN", "zh-TW", "ja", "en"];
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NONE_AVAILABLE = "此结果暂无可直接下载的字幕；仅提供在线翻译的语言不会自动生成。";

function issue(code, message, statusCode = 502, retryable = false) {
  return Object.assign(new Error(message), { code: `SUBTITLECAT_${code}`, statusCode, retryable });
}
function bounded(value, fallback, min, max) {
  return Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Math.trunc(Number(value)))) : fallback;
}
function cancelled(signal) {
  if (signal.aborted) throw signal.reason;
}
function entities(value) {
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (whole, entity) => {
    const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
    const key = entity.toLowerCase();
    if (named[key]) return named[key];
    const point = key.startsWith("#x") ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : whole;
  });
}
function text(value) {
  return entities(String(value).replace(/<[^>]*>/g, " ")).replace(/[\s\x00-\x1f]+/g, " ").trim();
}
function attribute(tag, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? entities(match[1] ?? match[2] ?? match[3]) : "";
}
function cleanHtml(html) {
  return html.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
}
function links(html) {
  return [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)]
    .map(match => ({ href: attribute(match[1], "href"), elementId: attribute(match[1], "id"), title: text(match[2]) }));
}
function resourceUrl(input, extension, base = ORIGIN + "/") {
  let url, decoded;
  try {
    url = new URL(input, base);
    decoded = decodeURIComponent(url.pathname);
  } catch { throw issue("INVALID_URL", "字幕来源地址无效", 400); }
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash
    || /[\\\x00-\x1f\x7f]/u.test(decoded) || decoded.length > 1200
    || !new RegExp(`^/subs/[0-9]{1,8}/[^/]+\\.${extension}$`, "i").test(decoded)
    || /%(?:2f|5c|00)/i.test(decoded)) {
    throw issue("INVALID_URL", "字幕来源地址不受支持", 400);
  }
  return url;
}
function resultId(url) { return "sc_" + Buffer.from(url.pathname).toString("base64url"); }
function detailUrl(id) {
  if (typeof id !== "string" || !/^sc_[A-Za-z0-9_-]{1,1600}$/.test(id)) throw issue("INVALID_ID", "字幕结果编号无效", 400);
  const buffer = Buffer.from(id.slice(3), "base64url");
  if (buffer.toString("base64url") !== id.slice(3)) throw issue("INVALID_ID", "字幕结果编号无效", 400);
  let decoded;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw issue("INVALID_ID", "字幕结果编号无效", 400); }
  const url = resourceUrl(decoded, "html");
  if (decoded !== url.pathname) throw issue("INVALID_ID", "字幕结果编号无效", 400);
  return url;
}
function languageCode(value) {
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(value)) return "";
  try { return Intl.getCanonicalLocales(value)[0] || ""; } catch { return ""; }
}
function safeName(url) {
  return decodeURIComponent(url.pathname.split("/").at(-1)).replace(/[<>:"/\\|?*\x00-\x1f\x7f]/gu, "_").slice(0, 176).replace(/\.srt$/i, "") + ".srt";
}
function publicFile(file) {
  return { id: file.id, name: file.name, language: file.language, languageCode: file.language,
    label: file.label, format: "srt", source: "SubtitleCat" };
}
function exactQueryCode(query) {
  const code = normalizeWorkCode(query);
  if (!code) return "";
  // A title containing a year can resemble a release code. Apply the strict
  // result filter only when the complete query is itself that code.
  const compact = value => value.normalize("NFKC").toUpperCase().replace(/[-_.\s]+/g, "")
    .replace(/\d+/g, digits => digits.replace(/^0+(?=\d)/, ""));
  const target = compact(code), input = compact(query);
  if (input === target || code.startsWith("FC2-PPV-") && input === target.replace(/^FC2PPV/, "FC2")) return workCodeKey(code);
  return "";
}

export function createSubtitlecatProvider({ fetchImpl = globalThis.fetch, timeoutMs = 8000, maxHtmlBytes = 1024 * 1024,
  maxDownloadBytes = 4 * 1024 * 1024, maxResults = 12, maxFiles = 24, concurrency = 2,
  maxQueued = 8, cacheTtlMs = 300000, maxCacheEntries = 64, stopWaitMs = 2000, now = Date.now } = {}) {
  const limits = { timeout: bounded(timeoutMs, 8000, 1, 30000), html: bounded(maxHtmlBytes, 1024 * 1024, 1, 1024 * 1024),
    download: bounded(maxDownloadBytes, 4 * 1024 * 1024, 1, 4 * 1024 * 1024), results: bounded(maxResults, 12, 1, 30),
    files: bounded(maxFiles, 24, 1, 40), concurrency: bounded(concurrency, 2, 1, 4), queued: bounded(maxQueued, 8, 0, 32),
    ttl: bounded(cacheTtlMs, 300000, 1, 1800000), cache: bounded(maxCacheEntries, 64, 1, 128),
    stop: bounded(stopWaitMs, 2000, 1, 10000) };
  const selections = new Map(), owners = new Set(), queue = [];
  let accepting = true, active = 0;

  function enqueue(task, callerSignal) {
    if (!accepting) return Promise.reject(issue("STOPPED", "字幕服务正在停止，请稍后重试", 503, true));
    if (callerSignal?.aborted) return Promise.reject(issue("ABORTED", "字幕请求已取消", 499));
    if (active >= limits.concurrency && queue.length >= limits.queued) return Promise.reject(issue("BUSY", "字幕请求较多，请稍后重试", 503, true));
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let complete;
      const entry = { task, controller, started: false, settled: false, timer: null, done: new Promise(done => { complete = done; }) };
      const reply = (error, value) => {
        if (entry.settled) return;
        entry.settled = true;
        if (error) reject(error); else resolve(value);
      };
      const callerAbort = () => controller.abort(issue("ABORTED", "字幕请求已取消", 499));
      const finish = () => {
        clearTimeout(entry.timer);
        callerSignal?.removeEventListener("abort", callerAbort);
        owners.delete(entry); complete();
      };
      controller.signal.addEventListener("abort", () => {
        reply(controller.signal.reason);
        if (!entry.started) { const index = queue.indexOf(entry); if (index >= 0) queue.splice(index, 1); finish(); }
      }, { once: true });
      callerSignal?.addEventListener("abort", callerAbort, { once: true });
      entry.start = () => {
        entry.started = true; active++;
        Promise.resolve().then(() => { cancelled(controller.signal); return task(controller.signal); }).then(
          value => { cancelled(controller.signal); reply(null, value); },
          error => reply(error?.code?.startsWith("SUBTITLECAT_") ? error : issue("NETWORK", "SubtitleCat 暂时无法连接，请稍后重试", 502, true))
        ).catch(error => reply(error)).finally(() => {
          active--; finish();
          while (accepting && active < limits.concurrency && queue.length) queue.shift().start();
        });
      };
      owners.add(entry);
      entry.timer = setTimeout(() => controller.abort(issue("TIMEOUT", "SubtitleCat 连接超时，请稍后重试", 504, true)), limits.timeout);
      if (active < limits.concurrency) entry.start(); else queue.push(entry);
    });
  }

  async function bytes(response, limit, signal) {
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel().catch(() => {});
      throw issue("TOO_LARGE", "字幕来源响应超过大小限制", 413);
    }
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        cancelled(signal);
        const chunk = await reader.read();
        cancelled(signal);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) { await reader.cancel().catch(() => {}); throw issue("TOO_LARGE", "字幕来源响应超过大小限制", 413); }
        chunks.push(Buffer.from(chunk.value));
      }
      return Buffer.concat(chunks, size);
    } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
  }

  async function request(initial, kind, signal) {
    let url = initial;
    for (let redirects = 0; redirects <= 3; redirects++) {
      cancelled(signal);
      const response = await fetchImpl(url.href, { method: "GET", redirect: "manual", credentials: "omit", signal,
        headers: { "User-Agent": "FanHao-LocalLibrary/1.0", Accept: kind === "srt" ? "text/plain,application/octet-stream;q=0.9" : "text/html,application/xhtml+xml" } });
      if (signal.aborted) { await response.body?.cancel().catch(() => {}); cancelled(signal); }
      if (response.redirected || (response.url && response.url !== url.href)) {
        await response.body?.cancel().catch(() => {});
        throw issue("REDIRECT", "字幕来源发生了未经校验的跳转", 502);
      }
      if (REDIRECTS.has(response.status)) {
        await response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location) throw issue("REDIRECT", "字幕来源跳转地址缺失", 502, true);
        if (kind === "search") {
          let next; try { next = new URL(location, url); } catch { throw issue("REDIRECT", "字幕来源跳转地址无效", 502); }
          if (next.origin !== ORIGIN || next.username || next.password || next.pathname !== "/index.php" || next.hash
            || next.searchParams.size !== 1 || !next.searchParams.has("search") || next.searchParams.get("search") !== initial.searchParams.get("search")) {
            throw issue("REDIRECT", "字幕来源跳转地址不受支持", 502);
          }
          url = next;
        } else url = resourceUrl(location, kind === "srt" ? "srt" : "html", url.href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        if (response.status === 429) throw issue("RATE_LIMIT", "SubtitleCat 请求受限，请稍后重试", 503, true);
        throw issue("HTTP", `SubtitleCat 返回错误（${response.status}），请稍后重试`, 502, response.status >= 500 || response.status === 408);
      }
      const content = await bytes(response, kind === "srt" ? limits.download : limits.html, signal);
      return { content, url, type: response.headers.get("content-type") || "" };
    }
    throw issue("REDIRECT", "字幕来源跳转次数过多，请稍后重试", 502, true);
  }

  function search(query, { signal } = {}) {
    if (typeof query !== "string" || query.trim().length < 3 || query.trim().length > 200 || /[\x00-\x1f\x7f]/u.test(query)) {
      return Promise.reject(issue("QUERY", "字幕搜索词需为 3–200 个字符", 400));
    }
    query = query.trim();
    const queryCode = exactQueryCode(query);
    return enqueue(async operationSignal => {
      const url = new URL("/index.php", ORIGIN); url.searchParams.set("search", query);
      const page = cleanHtml((await request(url, "search", operationSignal)).content.toString("utf8"));
      const table = [...page.matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table\s*>/gi)]
        .find(match => attribute(match[1], "class").split(/\s+/).includes("sub-table"));
      if (!table) throw issue("PAGE", "SubtitleCat 搜索页面未取得，请稍后重试", 502, true);
      const found = new Map();
      for (const link of links(table[2])) {
        let candidate; try { candidate = resourceUrl(link.href, "html"); } catch { continue; }
        if (!link.title || found.has(candidate.href)) continue;
        if (queryCode && !extractWorkCodes(link.title).some(code => workCodeKey(code) === queryCode)) continue;
        found.set(candidate.href, { id: resultId(candidate), title: link.title.slice(0, 300), pageUrl: candidate.href });
        if (found.size >= limits.results) break;
      }
      return { source: "SubtitleCat", query, results: [...found.values()] };
    }, signal);
  }

  function files(id, { signal } = {}) {
    let url; try { url = detailUrl(id); } catch (error) { return Promise.reject(error); }
    return enqueue(async operationSignal => {
      const response = await request(url, "detail", operationSignal);
      const page = cleanHtml(response.content.toString("utf8"));
      if (!/<(?:h[1-3]|div)\b[^>]*(?:class\s*=\s*["'][^"']*(?:sec-title|sub-single)|>\s*All language subtitles)/i.test(page)
        && !/All language subtitles for/i.test(page)) throw issue("PAGE", "SubtitleCat 字幕页面未取得，请稍后重试", 502, true);
      const available = new Map();
      for (const link of links(page)) {
        if (!/^download_[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(link.elementId)) continue;
        let download; try { download = resourceUrl(link.href, "srt", response.url.href); } catch { continue; }
        const language = languageCode(link.elementId.slice(9));
        const suffix = decodeURIComponent(download.pathname).match(/-([a-z]{2,3}(?:-[a-z0-9]{2,8})?)\.srt$/i)?.[1];
        if (!language || languageCode(suffix || "") !== language || available.has(download.href)) continue;
        const file = { id: "scf_" + createHash("sha256").update(download.href).digest("hex").slice(0, 24),
          name: safeName(download), language, label: LANGUAGE_LABELS[language] || language, url: download.href };
        available.set(download.href, file);
      }
      const chosen = [...available.values()].sort((a, b) => {
        const rank = value => { const index = LANGUAGE_ORDER.indexOf(value); return index < 0 ? 100 : index; };
        return rank(a.language) - rank(b.language) || a.language.localeCompare(b.language) || a.name.localeCompare(b.name);
      }).slice(0, limits.files);
      cancelled(operationSignal);
      selections.delete(id); selections.set(id, { expires: now() + limits.ttl, files: new Map(chosen.map(file => [file.id, file])) });
      while (selections.size > limits.cache) selections.delete(selections.keys().next().value);
      return { source: "SubtitleCat", files: chosen.map(publicFile), note: chosen.length ? "" : NONE_AVAILABLE };
    }, signal);
  }

  function download(id, fileId, { signal } = {}) {
    try { detailUrl(id); } catch (error) { return Promise.reject(error); }
    const selected = selections.get(id);
    if (!selected || selected.expires <= now()) {
      selections.delete(id);
      return Promise.reject(issue("SELECTION_EXPIRED", "字幕选择已过期，请重新获取语言列表", 409, true));
    }
    const file = typeof fileId === "string" ? selected.files.get(fileId) : null;
    if (!file) return Promise.reject(issue("FILE", "请选择语言列表中已有的字幕文件", 400));
    return enqueue(async operationSignal => {
      const result = await request(resourceUrl(file.url, "srt"), "srt", operationSignal);
      if (!result.content.length || /(?:text\/html|application\/xhtml)/i.test(result.type)
        || /^\s*<(?:!doctype|html|head|body)\b/i.test(result.content.subarray(0, 512).toString("utf8"))) {
        throw issue("CONTENT", "SubtitleCat 未返回有效的字幕文件，请稍后重试", 502, true);
      }
      return { bytes: result.content, name: file.name, language: file.language, languageCode: file.language,
        label: file.label, source: "SubtitleCat", sourceUrl: result.url.href };
    }, signal);
  }

  function beginStop() {
    accepting = false; selections.clear();
    for (const owner of [...owners]) owner.controller.abort(issue("STOPPED", "字幕服务正在停止，请稍后重试", 503, true));
  }
  async function stop() {
    beginStop();
    if (!owners.size) return;
    let timer;
    try {
      await Promise.race([Promise.all([...owners].map(owner => owner.done)), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(issue("STOP_TIMEOUT", "字幕网络请求尚未结束", 503, true)), limits.stop);
      })]);
    } finally { clearTimeout(timer); }
  }
  return { search, files, download, beginStop, stop };
}
