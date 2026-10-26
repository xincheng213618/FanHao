import assert from "node:assert/strict";
import { createSubtitlecatProvider } from "../src/modules/fanhao/server/playback/subtitlecat-provider.js";

// No network, application database or media files participate in this fixture.
const origin = "https://www.subtitlecat.com";
const detailPath = "/subs/123/Fixture%20ABC-001.html";
const id = "sc_" + Buffer.from(detailPath).toString("base64url");
const searchHtml = `<html><table class="table sub-table"><tbody>
  <tr><td><a href="subs/123/Fixture%20ABC-001.html">Fixture &amp; ABC-001</a></td></tr>
  <tr><td><a href="${detailPath}">duplicate</a></td></tr>
  <tr><td><a href="https://elsewhere.invalid/subs/1/Other.html">foreign</a></td></tr>
  <tr><td><a href="javascript:alert(1)">script</a></td></tr>
  <tr><td><a href='subs/124/Second.html'><span>ABC-001 Second</span> result</a></td></tr>
</tbody></table></html>`;
const detailHtml = `<html><h2 class="sec-title">All language subtitles for Fixture ABC-001</h2>
  <div class="sub-single"><img alt="zh-CN"><a id="download_zh-CN" href="/subs/321/Fixture%20ABC-001-zh-CN.srt">Download</a></div>
  <div class="sub-single"><img alt="zh-TW"><a id='download_zh-TW' href='/subs/123/Fixture%20ABC-001-zh-TW.srt'>Download</a></div>
  <div class="sub-single"><button id="ja" onclick="translate_from_server_folder()">Translate</button></div>
  <a id="download_en" href="/subs/124/Fixture%20ABC-001-en.srt">Download</a>
  <a id="download_fr" href="https://elsewhere.invalid/subs/1/Bad-fr.srt">Download</a>
  <a id="download_de" href="/subs/123/Fixture-ja.srt">mismatched language</a>
  <script><a id="download_es" href="/subs/123/Hidden-es.srt">script content</a></script>
  <!-- <a id="download_ko" href="/subs/123/Hidden-ko.srt">comment</a> -->
</html>`;
const subtitle = Buffer.from("1\r\n00:00:01,000 --> 00:00:03,000\r\nFixture text\r\n", "utf8");
const instances = [];
const tick = () => new Promise(resolve => setImmediate(resolve));
let checks = 0;
function make(fetchImpl, options = {}) {
  const provider = createSubtitlecatProvider({ fetchImpl, ...options }); instances.push(provider); return provider;
}
function html(value, options = {}) { return new Response(value, { headers: { "content-type": "text/html; charset=utf-8" }, ...options }); }
function failure(code, retryable) { return error => { assert.equal(error.code, `SUBTITLECAT_${code}`); if (retryable !== undefined) assert.equal(error.retryable, retryable); checks++; return true; }; }
function standardFetch(log = [], transform = null) {
  return async (url, options) => {
    log.push({ url, options });
    assert.equal(new URL(url).origin, origin);
    assert.equal(options.redirect, "manual");
    assert.equal(options.credentials, "omit");
    assert.ok(!Object.keys(options.headers).some(key => /cookie|authorization/i.test(key)));
    if (transform) { const changed = await transform(url, options); if (changed) return changed; }
    if (url.includes("/index.php?")) return html(searchHtml);
    if (url.endsWith(".html")) return html(detailHtml);
    return new Response(subtitle, { headers: { "content-type": "application/x-subrip" } });
  };
}

try {
  const log = [], provider = make(standardFetch(log));
  const search = await provider.search(" ABC-001 ");
  assert.equal(search.source, "SubtitleCat"); assert.equal(search.query, "ABC-001");
  assert.equal(search.results.length, 2); assert.equal(search.results[0].id, id);
  assert.equal(search.results[0].title, "Fixture & ABC-001");
  assert.equal(search.results[0].pageUrl, origin + detailPath);
  assert.equal(search.results[1].title, "ABC-001 Second result");
  assert.equal(new URL(log[0].url).searchParams.get("search"), "ABC-001");
  await assert.rejects(provider.download(id, "scf_forged"), failure("SELECTION_EXPIRED", true));
  const selection = await provider.files(id);
  assert.deepEqual(selection.files.map(file => file.language), ["zh-CN", "zh-TW", "en"]);
  assert.deepEqual(selection.files.map(file => file.label), ["简体中文", "繁体中文", "英语"]);
  assert.ok(selection.files.every(file => file.id.startsWith("scf_") && file.format === "srt" && file.languageCode === file.language));
  assert.equal(selection.note, "");
  const file = selection.files[0], fetched = await provider.download(id, file.id);
  assert.ok(Buffer.isBuffer(fetched.bytes)); assert.deepEqual(fetched.bytes, subtitle);
  assert.equal(fetched.name, "Fixture ABC-001-zh-CN.srt"); assert.equal(fetched.language, "zh-CN");
  assert.equal(fetched.sourceUrl, origin + "/subs/321/Fixture%20ABC-001-zh-CN.srt", "a translated file may live in a different numeric folder");
  const beforeForged = log.length;
  await assert.rejects(provider.download(id, "https://127.0.0.1/secret.srt"), failure("FILE", false));
  assert.equal(log.length, beforeForged);
  const fresh = make(standardFetch());
  await assert.rejects(fresh.download(id, file.id), failure("SELECTION_EXPIRED", true));
  assert.equal((await fresh.files(id)).files[0].id, file.id, "a stateless result can be queried again after restart");

  for (const query of ["", "ab", "a".repeat(201), "ABC\u0000test", null]) {
    await assert.rejects(provider.search(query), failure("QUERY", false));
  }
  for (const path of ["https://127.0.0.1/subs/1/Test.html", "/index.php", "/subs/1/Test%2Fsecret.html", "/subs/1/Test.html?x=1",
    "/subs/1/Test.html#fragment", "/subs/1/Test%5Csecret.html", "/subs/1/%252fsecret.html"]) {
    const token = "sc_" + Buffer.from(path).toString("base64url");
    await assert.rejects(provider.files(token), error => { assert.ok(/^SUBTITLECAT_(?:INVALID_URL|INVALID_ID)$/.test(error.code)); checks++; return true; });
  }
  for (const token of ["https://www.subtitlecat.com/subs/1/Test.html", "../", "sc_***", "sc__w"]) {
    await assert.rejects(provider.files(token), failure("INVALID_ID", false));
  }

  const limited = make(standardFetch(), { maxResults: 1, maxFiles: 1 });
  assert.equal((await limited.search("ABC-001")).results.length, 1);
  assert.deepEqual((await limited.files(id)).files.map(value => value.language), ["zh-CN"]);
  const wrongCodes = Array.from({ length: 16 }, (_, index) => `<tr><td><a href="/subs/500/Other-${index}.html">SDMU-${index + 201}</a></td></tr>`).join("");
  const exactSearch = make(async () => html(`<table class="sub-table">${wrongCodes}
    <tr><td><a href="/subs/500/Longer.html">SDMU-7600</a></td></tr>
    <tr><td><a href="/subs/500/Next.html">SDMU-761</a></td></tr>
    <tr><td><a href="/subs/500/OtherPrefix.html">XSDMU-760</a></td></tr>
    <tr><td><a href="/subs/500/Actual.html">SDMU-760 English subtitles</a></td></tr>
    <tr><td><a href="/subs/500/Actual2.html">SDMU 0760 Chinese subtitles</a></td></tr>
  </table>`), { maxResults: 1 });
  for (const query of ["SDMU-760", "sdmu760", "SDMU-0760"]) {
    assert.deepEqual((await exactSearch.search(query)).results.map(row => row.title), ["SDMU-760 English subtitles"],
      "exact release filtering precedes the result limit and rejects near or longer numbers");
  }
  const absent = make(async () => html(`<table class="sub-table">${wrongCodes}</table>`));
  assert.deepEqual((await absent.search("SDMU-760")).results, [], "explicitly different releases cannot be offered as download candidates");
  const movieSearch = make(async () => html('<table class="sub-table"><a href="/subs/1/Matrix.html">The Matrix (1999) 1080p English</a></table>'));
  assert.equal((await movieSearch.search("The Matrix 1999")).results.length, 1, "a full movie title is not forced through release-code matching");
  let clock = 10;
  const expired = make(standardFetch(), { now: () => clock, cacheTtlMs: 20 });
  const old = await expired.files(id); clock = 31;
  await assert.rejects(expired.download(id, old.files[0].id), failure("SELECTION_EXPIRED", true));
  const smallCache = make(standardFetch(), { maxCacheEntries: 1 });
  const first = await smallCache.files(id);
  await smallCache.files(search.results[1].id);
  await assert.rejects(smallCache.download(id, first.files[0].id), failure("SELECTION_EXPIRED", true));

  const empty = make(async url => url.includes("index.php") ? html('<table class="sub-table"><tbody></tbody></table>')
    : html('<h2 class="sec-title">All language subtitles for Fixture</h2><button id="zh-CN">Translate</button>'));
  assert.deepEqual((await empty.search("No match")).results, []);
  const noFiles = await empty.files(id);
  assert.deepEqual(noFiles.files, []); assert.match(noFiles.note, /在线翻译/u);
  for (const kind of ["search", "files"]) {
    const bad = make(async () => html("<html><h1>Network challenge</h1></html>"));
    await assert.rejects(kind === "search" ? bad.search("Fixture") : bad.files(id), failure("PAGE", true));
  }
  for (const [status, code, retryable] of [[429, "RATE_LIMIT", true], [503, "HTTP", true], [404, "HTTP", false]]) {
    const bad = make(async () => new Response("failure", { status }));
    await assert.rejects(bad.search("Fixture"), failure(code, retryable));
  }
  const disconnected = make(async () => { throw new TypeError("private connection details"); });
  await assert.rejects(disconnected.search("Fixture"), error => { assert.ok(!error.message.includes("private")); return failure("NETWORK", true)(error); });

  for (const destination of ["http://www.subtitlecat.com/subs/1/Test.html", "https://127.0.0.1/subs/1/Test.html",
    "https://www.subtitlecat.com.evil.invalid/subs/1/Test.html", "https://www.subtitlecat.com:444/subs/1/Test.html",
    "https://user@www.subtitlecat.com/subs/1/Test.html", "//evil.invalid/subs/1/Test.html", "/admin.html", "/subs/1/Test.html?file=secret"]) {
    let calls = 0;
    const redirect = make(async () => { calls++; return new Response(null, { status: 302, headers: { location: destination } }); });
    await assert.rejects(redirect.files(id), error => { assert.equal(error.code, "SUBTITLECAT_INVALID_URL"); checks++; return true; });
    assert.equal(calls, 1, "unsafe redirects must never make a second request");
  }
  let hops = 0;
  const allowedRedirect = make(async url => {
    hops++;
    return url === origin + detailPath ? new Response(null, { status: 302, headers: { location: "/subs/124/Replacement.html" } }) : html(detailHtml);
  });
  assert.equal((await allowedRedirect.files(id)).files.length, 3); assert.equal(hops, 2);
  let loops = 0;
  const loop = make(async () => { loops++; return new Response(null, { status: 302, headers: { location: detailPath } }); });
  await assert.rejects(loop.files(id), failure("REDIRECT", true)); assert.equal(loops, 4);
  const autoRedirect = make(async () => { const response = html(searchHtml); Object.defineProperty(response, "redirected", { value: true }); return response; });
  await assert.rejects(autoRedirect.search("Fixture"), failure("REDIRECT", false));

  let cancelledBodies = 0, pulls = 0;
  const huge = make(async () => new Response(new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(512)); },
    cancel() { cancelledBodies++; } }, { highWaterMark: 0 })), { maxHtmlBytes: 1024 });
  await assert.rejects(huge.search("Fixture"), failure("TOO_LARGE", false));
  assert.equal(pulls, 3); assert.equal(cancelledBodies, 1);
  const declaredHuge = make(async () => new Response("body", { headers: { "content-length": "99999" } }), { maxHtmlBytes: 100 });
  await assert.rejects(declaredHuge.search("Fixture"), failure("TOO_LARGE", false));
  for (const mode of ["oversized", "html"]) {
    const badFile = make(standardFetch([], url => url.endsWith(".srt") ? mode === "html" ? html("<html>rate limit</html>")
      : new Response(new Uint8Array(100)) : null), { maxDownloadBytes: 99 });
    const options = await badFile.files(id);
    await assert.rejects(badFile.download(id, options.files[0].id), failure(mode === "html" ? "CONTENT" : "TOO_LARGE", mode === "html"));
  }

  const timeout = make((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }), { timeoutMs: 15 });
  await assert.rejects(timeout.search("Fixture"), failure("TIMEOUT", true)); await timeout.stop();
  const controlled = [], pending = [];
  let count = 0, peak = 0;
  const bounded = make((_url, { signal }) => new Promise((resolve, reject) => {
    count++; peak = Math.max(peak, count);
    const finish = value => { count--; resolve(value); };
    controlled.push(() => finish(html('<table class="sub-table"></table>')));
    signal.addEventListener("abort", () => { count--; reject(signal.reason); }, { once: true });
  }), { concurrency: 2, maxQueued: 2, timeoutMs: 1000 });
  for (let index = 0; index < 4; index++) pending.push(bounded.search("Fixture " + index));
  await tick();
  await assert.rejects(bounded.search("Fixture overflow"), failure("BUSY", true));
  assert.equal(controlled.length, 2);
  controlled[0](); controlled[1](); await tick();
  assert.equal(controlled.length, 4); controlled[2](); controlled[3]();
  await Promise.all(pending); assert.equal(peak, 2);

  let releaseLate, ownedFetches = 0;
  const held = make(() => { ownedFetches++; return new Promise(resolve => { releaseLate = resolve; }); },
    { concurrency: 1, maxQueued: 1, timeoutMs: 15, stopWaitMs: 5 });
  await assert.rejects(held.search("Held fixture"), failure("TIMEOUT", true));
  await assert.rejects(held.search("Queued fixture"), failure("TIMEOUT", true));
  assert.equal(ownedFetches, 1, "a timed-out but physically unsettled fetch still owns its concurrency slot");
  await assert.rejects(held.stop(), failure("STOP_TIMEOUT", true));
  releaseLate(html(searchHtml)); await tick(); await held.stop();
  await assert.rejects(held.search("After stop"), failure("STOPPED", true));

  const abort = new AbortController();
  const abortable = make((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  const aborted = abortable.search("Fixture", { signal: abort.signal }); await tick(); abort.abort();
  await assert.rejects(aborted, failure("ABORTED", false));
  const stopped = abortable.search("Fixture again"); await tick(); abortable.beginStop();
  await assert.rejects(stopped, failure("STOPPED", true)); await abortable.stop();
  console.log(JSON.stringify({ ok: true, checks, searchAndLanguageDownload: true, exactReleaseBeforeResultLimit: true, freeTitleSearch: true, fixedHttpsOrigin: true,
    rejectsUnsafeIdsRedirectsAndSelections: true, responseAndQueueBounds: true, physicalConcurrency: peak,
    timeoutAbortAndStop: true, liveNetworkRequests: 0 }));
} finally {
  for (const instance of instances) await instance.stop();
}
