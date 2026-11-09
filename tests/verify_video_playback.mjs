import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createFileServer, entityValidators, ifRangeMatches, parseRange } from "../src/platform/server/file-server.js";
import { createFanhaoDependencies } from "../src/modules/fanhao/server/composition.js";
import { createMediaFileRelocationService } from "../src/modules/fanhao/server/works/media-file-relocation-service.js";
import { createMediaStreamService } from "../src/platform/server/media-stream-service.js";
import { createRequestHandler } from "../src/platform/server/http-app.js";
import { createVideoProbeService } from "../src/platform/server/video-probe-service.js";
import { createWorksRuntime } from "../src/modules/fanhao/server/works/runtime.js";
import { createGalleryMediaService } from "../src/modules/media/server/gallery-media-service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
assert.deepEqual(parseRange("bytes=900-2000", 1000), { start: 900, end: 999 });
assert.equal(parseRange("bytes=1000-", 1000), null);
assert.equal(parseRange("bytes=-0", 1000), null);
assert.equal(parseRange("bytes=5-3", 1000), null);

const staleVideoPath = "R:\\Polly Yangs MegaPack\\nested\\movie.mp4";
const relocatedVideoPath = "R:\\Polly Yangs\\nested\\movie.mp4";
let relocationDirectoryReads = 0;
const relocationWarnings = [];
const relocatedFileStat = { size: 2048, isFile: () => true };
const relocationService = createMediaFileRelocationService({
  safeStat: (filePath) => filePath === relocatedVideoPath ? relocatedFileStat : null,
  readRootDirectoryNames(rootPath) {
    relocationDirectoryReads += 1;
    assert.equal(rootPath, "R:\\");
    return ["Other", "Polly Yangs"];
  },
  warn: (message) => relocationWarnings.push(message)
});
const relocatedFile = relocationService.resolve({ id: "stale-video", path: staleVideoPath, size: 2048 });
assert.equal(relocatedFile.path, relocatedVideoPath, "renamed person folders must recover the same relative media path");
assert.equal(relocationWarnings.length, 1, "successful media relocation must leave one diagnostic trail");
assert.equal(relocationService.resolve({ id: "stale-video", path: staleVideoPath, size: 2048 }).path, relocatedVideoPath, "relocated media paths must be cached while they exist");
assert.equal(relocationDirectoryReads, 1, "cached media relocation must avoid rescanning the drive root");
assert.equal(relocationService.resolve({ id: "wrong-size", path: staleVideoPath, size: 4096 }), null, "media relocation must not guess when file size differs");

assertPlaybackMode({ ext: ".mp4", videoCodec: "h264", audioCodec: "aac", expected: "direct" });
assertPlaybackMode({ ext: ".mp4", videoCodec: "hevc", audioCodec: "aac", expected: "direct" });
assertPlaybackMode({ ext: ".m4v", videoCodec: "hvc1", audioCodec: "aac", expected: "direct" });
assertPlaybackMode({ ext: ".mp4", videoCodec: "h264", audioCodec: "ac3", expected: "remux" });
assertPlaybackMode({ ext: ".mkv", videoCodec: "h264", audioCodec: "aac", expected: "remux" });
assertPlaybackMode({ ext: ".mkv", videoCodec: "hevc", audioCodec: "aac", expected: "transcode" });
assertPlaybackMode({ ext: ".wmv", videoCodec: "vc1", audioCodec: "wmapro", expected: "transcode" });

const serverConfigSource = fs.readFileSync(path.join(root, "src", "bootstrap", "server-config.js"), "utf8");
const routeSource = fs.readFileSync(path.join(root, "src", "modules", "fanhao", "server", "works", "routes-media.js"), "utf8");
const streamSource = fs.readFileSync(path.join(root, "src", "platform", "server", "media-stream-service.js"), "utf8");
let createRoutedMediaStreamService = createMediaStreamService;
if (process.argv.includes("--legacy-video-forwarding")) {
  const forwarding = "return serveRangedFile(req, res, file, options);";
  assert.equal(streamSource.split(forwarding).length, 2, "negative must remove the actual video promise forwarding");
  ({ createMediaStreamService: createRoutedMediaStreamService } = await import(
    `data:text/javascript;base64,${Buffer.from(streamSource.replace(forwarding, "serveRangedFile(req, res, file, options);")).toString("base64")}`
  ));
}
const fileServerSource = fs.readFileSync(path.join(root, "src", "platform", "server", "file-server.js"), "utf8");
const playerHtmlSource = fs.readFileSync(path.join(root, "public", "player.html"), "utf8");
const playerSource = fs.readFileSync(path.join(root, "public", "js", "player-page.js"), "utf8");
const workDetailPlayerSource = fs.readFileSync(path.join(root, "public", "modules", "fanhao", "work-detail-page.js"), "utf8");
const androidWebPlayerSource = fs.readFileSync(path.join(root, "android-client", "www", "js", "android-player.js"), "utf8");
const nativePlayerSource = fs.readFileSync(
  path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativePlayerActivity.java"),
  "utf8"
);
const shortVideoRuntimeSource = fs.readFileSync(path.join(root, "src", "modules", "short-videos", "server", "runtime.js"), "utf8");

assert(serverConfigSource.includes("DEFAULT_VIDEO_CHUNK_BYTES: 4 * 1024 * 1024"), "video initial ranges should avoid 1 MB request churn");
assert(routeSource.includes('cacheControl: "no-store"'), "native video ranges must not create weak If-Range cache revalidation loops");
assert(fileServerSource.includes("const entitySize = Math.max(stat.size") && fileServerSource.includes('"Content-Range": `bytes ${responseRange.start}-${responseRange.end}/${entitySize}`'), "partial startup files must preserve the original media entity size in HTTP ranges");
assert(fileServerSource.includes("...responseHeaders"), "media range responses must expose module diagnostics without changing the shared file server contract");
assert(shortVideoRuntimeSource.includes("!hasIfRange(req)") && shortVideoRuntimeSource.includes('req?.headers?.["if-range"]'), "conditional ranges must bypass physical startup-prefix files so stale validators can receive a complete 200 entity");
assert(shortVideoRuntimeSource.includes("entityMtimeMs: Math.max(0, Number(cachedStat.mtimeMs || 0))"), "smooth renditions must expose the physical rendition timestamp without inventing a future revision");
assert(!shortVideoRuntimeSource.includes("sourceEntityMtimeMs / 1000"), "smooth rendition validators must not synthesize a future timestamp from the source");
assert(shortVideoRuntimeSource.includes("short-video-smooth") && shortVideoRuntimeSource.includes('"no-store"'), "uncached adaptive short-video responses must not pin the original stream under the rendition URL");
assert(shortVideoRuntimeSource.includes('url.searchParams.get("wait")') && shortVideoRuntimeSource.includes("sendSmoothPlaybackUnavailable") && shortVideoRuntimeSource.includes('"Retry-After": "1"'), "unready smooth playback must return a retryable response instead of original bytes under a rendition URL");
assert(shortVideoRuntimeSource.includes("applyMobilePlaybackHints") && shortVideoRuntimeSource.includes('req.headers?.["x-fanhao-client"]'), "native playback must receive a stable rendition URL and an untruncated Media3 byte stream");
assert(playerHtmlSource.includes('href="/css/foundation.css?'), "standalone player should load only the shared foundation styles");
assert(!playerHtmlSource.includes('href="/styles.css?'), "standalone player must not parse every application module stylesheet");
assert(playerHtmlSource.includes("*::before") && playerHtmlSource.includes("box-sizing: border-box;"), "standalone player should own the box model reset it needs");
assert(playerHtmlSource.includes('<video id="playerVideo" playsinline preload="metadata" autoplay hidden>'), "standalone playback should declare autoplay before its source is attached");
assert(playerSource.includes('els.video.preload = mode === "direct" ? "auto" : "none";'), "native MP4 should preload while generated streams start on demand");
assert(playerSource.includes("if (customControls && autoPlay)"), "generated stream seeks should restart playback without waiting for metadata preload");
assert(playerSource.includes("setVideoSourceAt(resumePosition, { autoPlay: options.autoPlay !== false });"), "the initial video should start as soon as play-info is ready while restored playback can retain its paused state");
assert(playerSource.includes("const deferGeneratedStream = customControls && !autoPlay;"), "generated streams should defer only when an explicit non-playing source switch requests it");
assert(playerSource.includes('name === "NotAllowedError" && options.allowMutedFallback'), "blocked sound autoplay should fall back to immediate muted playback");
assert(playerSource.includes('dataset.autoplayMuted !== "1"') && playerSource.includes("restoreAutoplayAudioFromInteraction") && playerSource.includes("els.video.muted = false;") && playerSource.includes("requestVideoPlayback();"), "the first trusted interaction should restore sound and keep playing after muted autoplay");
assert(playerSource.includes('document.addEventListener("click", restoreAutoplayAudioFromInteraction, { capture: true });'), "sound restoration must run during the browser-authorized click phase");
assert(playerSource.includes("handleVideoPlaybackError") && playerSource.includes("currentPlayInfo?.fallbackStreamUrl") && playerSource.includes("直连失败，正在切换兼容播放"), "standalone playback must retry a failed direct HEVC source through the server-provided compatibility stream");
assert(workDetailPlayerSource.includes("playInfoOverride = null") && workDetailPlayerSource.includes("playInfo.fallbackStreamUrl") && workDetailPlayerSource.includes("renderPlayer(work, selected.id, fallbackPosition, true, fallbackInfo)"), "work-detail playback must preserve position while falling back from direct decoding to compatibility transcoding");
assert(androidWebPlayerSource.includes("nativeFallbackInfo") && androidWebPlayerSource.includes("playInfo.fallbackStreamUrl") && androidWebPlayerSource.includes('fallbackStreamUrl: ""'), "Android FanHao playback must give the native player a real compatibility fallback instead of retrying the versioned direct URL");
assert(playerSource.includes('els.markerA.textContent = playbackSnapshot?.videoId ? "释放播放"') && playerSource.includes("stopCurrentPlayback();") && playerSource.includes("await delay(LOCAL_MARKER_RELEASE_DELAY_MS);"), "local markers must release the active media handle before renaming its folder");
assert(playerSource.includes("await restorePlaybackSnapshot(playbackSnapshot);") && playerSource.includes("resumePosition: snapshot.position") && playerSource.includes("autoPlay: snapshot.autoPlay"), "local markers must restore the same playback position and playing state after the rename");
assert(playerSource.includes('createMoveField("搜索人物", existingInput)') && playerSource.includes('existingInput.placeholder = "输入人物姓名，例如：皆瀬あかり"'), "existing-person migration must ask for a searchable name instead of an internal person id");
assert(playerSource.includes('const data = await api("/api/library");') && playerSource.includes("searchMovePeople(movePeople, query)") && playerSource.includes('option.setAttribute("role", "option")'), "existing-person migration must render selectable matching people from the library");
assert(playerSource.includes("submit.disabled = !selectedExistingPerson") && playerSource.includes("const personId = targetPerson?.id || parsePersonIdInput(existingInput.value);"), "migration must derive the internal id from the selected person");
assert(!playerSource.includes('addEventListener("click", activateGeneratedStreamFromInteraction'), "the first generated-stream play gesture must remain native");
assert(playerSource.includes("function requestVideoPlayback(options = {})"), "play promise failures should stay retryable and visible");
assert(playerSource.includes('els.streamStart?.addEventListener("click", startDeferredStream);'), "generated streams need a dedicated trusted start control");
assert(nativePlayerSource.includes("removeControllerScrims();"), "native FanHao playback must remove Media3 controller scrims");
assert(nativePlayerSource.includes("R.id.exo_controls_background"), "native FanHao playback must clear the full-screen controller dim layer");
assert(nativePlayerSource.includes("R.id.exo_bottom_bar"), "native FanHao playback must clear the progress bar shadow background");
assert(nativePlayerSource.includes("HttpDataSource.InvalidResponseCodeException") && nativePlayerSource.includes("视频文件已移动或离线"), "native FanHao playback must translate missing media responses into an actionable message");
assert(nativePlayerSource.includes('Log.e(TAG, "Playback failed:'), "native FanHao playback must retain the complete Media3 failure in ADB logs");
assert(nativePlayerSource.includes("streamOffsetMs + player.getCurrentPosition()") && nativePlayerSource.includes("playUrl(fallbackPlaybackUrl, 0)") && nativePlayerSource.includes("streamOffsetFromUrl"), "native FanHao compatibility playback must seek the generated stream once and keep reporting the original media timeline");
for (const option of ['"-fflags", "+genpts"', '"-avoid_negative_ts", "make_zero"', '"-pix_fmt", "yuv420p"']) {
  assert(streamSource.includes(option), `missing compatibility option: ${option}`);
}
assert(streamSource.includes("TRANSCODE_MAX_EDGE = 4096") && streamSource.includes("force_original_aspect_ratio=decrease:force_divisible_by=2"), "shared compatibility transcoding must scale oversized sources within NVENC's supported edge");
assert(streamSource.includes('child.stdout.once("data", job.onFirstData)') && streamSource.includes('job.onFirstData = (chunk)'), "transcoded GET responses must commit headers from the first media data handler; HEAD does not spawn FFmpeg");

async function verifyFileServerRangeContract() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-file-range-contract-"));
  const fixturePath = path.join(fixtureRoot, "fixture.mp4");
  const emptyPath = path.join(fixtureRoot, "empty.mp4");
  const rewritePath = path.join(fixtureRoot, "rewrite.mp4");
  const sameSecondPath = path.join(fixtureRoot, "same-second.mp4");
  const replacementPath = path.join(fixtureRoot, "replacement.mp4");
  const retiredPath = path.join(fixtureRoot, "fixture-retired.mp4");
  const prefixPath = path.join(fixtureRoot, "fixture.mp4.start");
  try {
    fs.writeFileSync(fixturePath, Buffer.from("0123456789"));
    fs.writeFileSync(emptyPath, Buffer.alloc(0));
    const stat = fs.statSync(fixturePath);
    const derivedValidators = entityValidators({}, stat, stat.size);
    assert.match(derivedValidators.ETag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    assert.equal(ifRangeMatches(derivedValidators.ETag, derivedValidators), false, "metadata-derived weak ETags must never authorize a range append");
    assert.equal(ifRangeMatches(derivedValidators["Last-Modified"], derivedValidators), false, "HTTP dates must not authorize byte reuse");
    const file = { path: fixturePath, ext: ".mp4", entityTag: '"fixture-content-v1"' };
    const validators = entityValidators(file, stat, stat.size);
    assert.equal(validators.ETag, '"fixture-content-v1"');
    assert.equal(ifRangeMatches(validators.ETag, validators), true);
    assert.equal(ifRangeMatches(`W/${validators.ETag}`, validators), false);
    assert.equal(ifRangeMatches(validators["Last-Modified"], validators), false);

    const fileServer = createFileServer({
      defaultChunkBytes: 4,
      mimeTypes: { ".mp4": "video/mp4" },
      normalizeExt: (filePath) => path.extname(filePath).toLowerCase(),
      notFound: (res) => { res.writeHead(404); res.end(); },
      safeStat: (filePath) => fs.statSync(filePath, { throwIfNoEntry: false })
    });
    await verifyComposedVideoRangeRelocation(fileServer, fixturePath);

    const full = await captureFileResponse(fileServer, "serveRangedFile", "GET", {}, file);
    assert.equal(full.status, 200);
    assert.equal(full.body.toString(), "0123456789");
    assert.equal(full.headers["Content-Length"], 10);
    assert.equal(full.headers.ETag, validators.ETag);
    assert.ok(full.headers["Last-Modified"]);
    for (const unavailablePath of [path.join(fixtureRoot, "missing.mp4"), fixtureRoot]) {
      const unavailable = await captureFileResponse(fileServer, "serveRangedFile", "GET", {}, { path: unavailablePath, ext: ".mp4" });
      assert.equal(unavailable.status, 404, "missing paths and directories must complete without media headers");
      assert.equal(unavailable.headers["Content-Range"], undefined);
      assert.equal(unavailable.body.length, 0);
    }
    const limitedFull = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      {},
      { ...file, maxRangeBytes: 2 }
    );
    assert.equal(limitedFull.status, 200);
    assert.equal(limitedFull.body.toString(), "0123456789", "range chunk limits must not truncate an ordinary 200 response");
    const fullHead = await captureFileResponse(fileServer, "serveRangedFile", "HEAD", {}, file);
    assert.equal(fullHead.status, full.status);
    assert.deepEqual(fullHead.headers, full.headers);
    assert.equal(fullHead.body.length, 0);

    const partial = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      { range: "bytes=3-5", "if-range": validators.ETag },
      { ...file, responseHeaders: { etag: '"caller-must-not-override"', "Content-Range": "invalid", "X-Fixture": "kept" } }
    );
    assert.equal(partial.status, 206);
    assert.equal(partial.body.toString(), "345");
    assert.equal(partial.headers["Content-Range"], "bytes 3-5/10");
    assert.equal(partial.headers.ETag, validators.ETag);
    assert.equal(partial.headers.etag, undefined);
    assert.equal(partial.headers["X-Fixture"], "kept");

    const defaultLimitedRange = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      { range: "bytes=3-", "if-range": validators.ETag },
      file
    );
    assert.equal(defaultLimitedRange.status, 206);
    assert.equal(defaultLimitedRange.body.toString(), "3456");
    assert.equal(defaultLimitedRange.headers["Content-Range"], "bytes 3-6/10");
    assert.equal(defaultLimitedRange.headers["Content-Length"], 4);

    const explicitlyLimitedRange = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      { range: "bytes=3-", "if-range": validators.ETag },
      { ...file, maxRangeBytes: 2 }
    );
    assert.equal(explicitlyLimitedRange.body.toString(), "34");
    assert.equal(explicitlyLimitedRange.headers["Content-Range"], "bytes 3-4/10");

    const explicitlyUnlimitedRange = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      { range: "bytes=3-", "if-range": validators.ETag },
      { ...file, maxRangeBytes: 0, fullResponse: true }
    );
    assert.equal(explicitlyUnlimitedRange.body.toString(), "3456789");
    assert.equal(explicitlyUnlimitedRange.headers["Content-Range"], "bytes 3-9/10");

    const stale = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      { range: "bytes=3-", "if-range": '"stale"' },
      file
    );
    assert.equal(stale.status, 200);
    assert.equal(stale.body.toString(), "0123456789");
    assert.equal(stale.headers["Content-Range"], undefined);

    const staleUnsatisfied = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      { range: "bytes=99-", "if-range": '"stale"' },
      file
    );
    assert.equal(staleUnsatisfied.status, 200, "a stale If-Range must be ignored before range satisfiability is evaluated");
    assert.equal(staleUnsatisfied.body.toString(), "0123456789");

    const weak = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      { range: "bytes=3-", "if-range": `W/${validators.ETag}` },
      file
    );
    assert.equal(weak.status, 200);
    assert.equal(weak.body.toString(), "0123456789");

    const byDate = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      { range: "bytes=2-4", "if-range": validators["Last-Modified"] },
      file
    );
    assert.equal(byDate.status, 200, "date If-Range must fall back to a complete entity");
    assert.equal(byDate.headers["Content-Range"], undefined);
    assert.equal(byDate.body.toString(), "0123456789");

    const byFutureDate = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      { range: "bytes=2-4", "if-range": "Fri, 01 Jan 2100 00:00:00 GMT" },
      file
    );
    assert.equal(byFutureDate.status, 200, "a future If-Range date must not authorize a partial response");
    assert.equal(byFutureDate.headers["Content-Range"], undefined);
    assert.equal(byFutureDate.body.toString(), "0123456789");

    const headWithRange = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "HEAD",
      { range: "bytes=2-4", "if-range": validators.ETag },
      file
    );
    assert.equal(headWithRange.status, 200, "HEAD must ignore Range");
    assert.deepEqual(headWithRange.headers, full.headers);
    assert.equal(headWithRange.body.length, 0);

    for (const ignoredRange of ["items=2-4", "bytes=0-1,3-4", "bytes=a-b", "bytes="]) {
      const ignored = await captureFileResponse(
        fileServer,
        "serveRangedFile",
        "GET",
        { range: ignoredRange },
        file
      );
      assert.equal(ignored.status, 200, `${ignoredRange} must be ignored instead of rejected`);
      assert.equal(ignored.headers["Content-Range"], undefined);
      assert.equal(ignored.body.toString(), "0123456789");
    }

    const unsatisfied = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      { range: "bytes=10-" },
      file
    );
    assert.equal(unsatisfied.status, 416);
    assert.equal(unsatisfied.headers["Content-Range"], "bytes */10");
    assert.equal(unsatisfied.headers.ETag, validators.ETag);
    assert.equal(unsatisfied.body.length, 0);
    const reversed = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      { range: "bytes=5-3" },
      file
    );
    assert.equal(reversed.status, 416, "a syntactically valid but reversed byte range is unsatisfiable");
    assert.equal(reversed.headers["Content-Range"], "bytes */10");

    const emptyFull = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      {},
      { path: emptyPath, ext: ".mp4" }
    );
    assert.equal(emptyFull.status, 200);
    assert.equal(emptyFull.headers["Content-Length"], 0);
    assert.equal(emptyFull.body.length, 0);
    const emptyRange = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      { range: "bytes=0-" },
      { path: emptyPath, ext: ".mp4" }
    );
    assert.equal(emptyRange.status, 416);
    assert.equal(emptyRange.headers["Content-Range"], "bytes */0");

    const download = await captureFileResponse(fileServer, "serveDownloadFile", "HEAD", { range: "bytes=3-" }, file);
    assert.equal(download.status, 200);
    assert.equal(download.headers["Accept-Ranges"], undefined);
    assert.equal(download.body.length, 0);

    fs.writeFileSync(rewritePath, Buffer.from("v1-data"));
    fs.utimesSync(rewritePath, 1_725_000_000, 1_725_000_000);
    const beforeRewrite = entityValidators({}, fs.statSync(rewritePath));
    fs.writeFileSync(rewritePath, Buffer.from("v2-data"));
    fs.utimesSync(rewritePath, 1_725_000_002, 1_725_000_002);
    const afterRewrite = entityValidators({}, fs.statSync(rewritePath));
    assert.notEqual(afterRewrite.ETag, beforeRewrite.ETag, "same-length rewrites with a new revision timestamp must change the weak metadata tag");
    assert.notEqual(afterRewrite["Last-Modified"], beforeRewrite["Last-Modified"]);

    fs.writeFileSync(sameSecondPath, Buffer.from("v1-data"));
    const sameSecondStartNs = 1_725_000_000_100_000_000;
    fs.utimesSync(sameSecondPath, sameSecondStartNs / 1_000_000_000, sameSecondStartNs / 1_000_000_000);
    const sameSecondV1 = entityValidators({}, fs.statSync(sameSecondPath));
    fs.writeFileSync(sameSecondPath, Buffer.from("v2-data"));
    const sameSecondEndNs = sameSecondStartNs + 500_000_000;
    fs.utimesSync(sameSecondPath, sameSecondEndNs / 1_000_000_000, sameSecondEndNs / 1_000_000_000);
    const sameSecondV2 = entityValidators({}, fs.statSync(sameSecondPath));
    assert.equal(sameSecondV2["Last-Modified"], sameSecondV1["Last-Modified"], "fixture rewrites must stay within one HTTP-date second");
    const sameSecondResume = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      { range: "bytes=3-", "if-range": sameSecondV1["Last-Modified"] },
      { path: sameSecondPath, ext: ".mp4" }
    );
    assert.equal(sameSecondResume.status, 200, "same-second equal-length replacements must not reuse a date checkpoint");
    assert.equal(sameSecondResume.headers["Content-Range"], undefined);
    assert.equal(sameSecondResume.body.toString(), "v2-data");

    fs.writeFileSync(replacementPath, Buffer.from("abcdefghij"));
    fs.utimesSync(replacementPath, (stat.mtimeMs + 10_000) / 1000, (stat.mtimeMs + 10_000) / 1000);
    const replacementValidators = entityValidators(file, fs.statSync(replacementPath));
    let replacedDuringWriteHead = false;
    const stableHandleResponse = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      { range: "bytes=3-5", "if-range": validators.ETag },
      file,
      () => {
        fs.renameSync(fixturePath, retiredPath);
        fs.renameSync(replacementPath, fixturePath);
        replacedDuringWriteHead = true;
      }
    );
    assert.equal(replacedDuringWriteHead, true);
    assert.equal(fs.readFileSync(fixturePath, "utf8"), "abcdefghij", "the public path must point at the replacement fixture");
    assert.equal(stableHandleResponse.status, 206);
    assert.equal(stableHandleResponse.headers.ETag, validators.ETag, "the 206 must retain the validator of the opened entity");
    assert.equal(stableHandleResponse.headers["Last-Modified"], validators["Last-Modified"]);
    assert.notEqual(stableHandleResponse.headers["Last-Modified"], replacementValidators["Last-Modified"]);
    assert.equal(stableHandleResponse.headers["Content-Range"], "bytes 3-5/10");
    assert.equal(stableHandleResponse.body.toString(), "345", "206 bytes must come from the fstat-validated open handle");

    fs.writeFileSync(prefixPath, Buffer.from("0123"));
    const impossibleFull = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "GET",
      {},
      { path: prefixPath, ext: ".mp4", totalSize: 10, entityMtimeMs: stat.mtimeMs }
    );
    assert.equal(impossibleFull.status, 503, "a physical startup prefix must never pose as a complete 200 entity");
    const impossibleHead = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "HEAD",
      {},
      { path: prefixPath, ext: ".mp4", totalSize: 10, entityMtimeMs: stat.mtimeMs }
    );
    assert.equal(impossibleHead.status, impossibleFull.status, "HEAD must expose the same unsatisfied representation status as GET");
  } finally {
    const resolvedRoot = path.resolve(fixtureRoot);
    assert.ok(path.basename(resolvedRoot).startsWith("fanhao-file-range-contract-"));
    for (const candidate of [fixturePath, emptyPath, rewritePath, sameSecondPath, replacementPath, retiredPath, prefixPath]) {
      assert.equal(path.dirname(path.resolve(candidate)), resolvedRoot);
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
    fs.rmdirSync(resolvedRoot);
  }
}

async function captureFileResponse(fileServer, methodName, method, headers, file, onWriteHead = null) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  const res = new CaptureResponse(onWriteHead);
  await fileServer[methodName](req, res, file, "fixture.mp4");
  if (!res.writableFinished) await once(res, "finish");
  assert.equal(req.listenerCount("aborted"), 0, "the awaited file API must release request listeners before returning");
  return {
    status: res.status,
    headers: res.responseHeaders,
    body: Buffer.concat(res.chunks)
  };
}

class CaptureResponse extends Writable {
  constructor(onWriteHead = null) {
    super();
    this.status = 0;
    this.responseHeaders = {};
    this.headersSent = false;
    this.chunks = [];
    this.onWriteHead = onWriteHead;
  }

  writeHead(status, headers = {}) {
    this.status = status;
    this.responseHeaders = { ...headers };
    this.headersSent = true;
    this.onWriteHead?.();
    return this;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

function assertPlaybackMode({ ext, videoCodec, audioCodec, expected }) {
  const service = createVideoProbeService({
    directVideoExts: new Set([".mp4", ".m4v", ".webm"]),
    ffprobePath: "ffprobe",
    hasNvenc: true,
    safeStat: () => ({ size: 1, mtimeMs: 1 }),
    spawnSyncFn: () => ({
      status: 0,
      stdout: JSON.stringify({
        format: { duration: 60 },
        streams: [
          { codec_type: "video", codec_name: videoCodec, width: 1920, height: 1080 },
          { codec_type: "audio", codec_name: audioCodec }
        ]
      })
    })
  });
  const info = service.playInfoForFile({ id: `${videoCodec}-${audioCodec}`, path: `sample${ext}`, ext });
  assert.equal(info.mode, expected, `${ext} ${videoCodec}/${audioCodec}`);
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
  if (expected === "direct") {
    const streamUrl = new URL(info.streamUrl, "http://fanhao.local");
    assert.match(streamUrl.searchParams.get("v") || "", /^\d{8}-range-chunks-\d+$/);
    const fallbackUrl = new URL(info.fallbackStreamUrl, "http://fanhao.local");
    assert.equal(fallbackUrl.searchParams.get("mode"), "transcode");
    assert.equal(fallbackUrl.searchParams.get("audio"), "aac");
  }
}

await verifyFileServerRangeContract();
await verifyVideoRouteForwarding();
await verifyTranscodeResponseContract();
await verifyWorkTranscodeRelocation();
await verifyTranscodeRelocationCancellation();
await verifyWorkPlayInfoSourceChecks();
console.log("video-playback: ok (range contract, awaited video routes, direct fallback, bounded transcode, truthful failures)");

async function verifyVideoRouteForwarding() {
  // Real works routing and the public HTTP boundary surround only a controlled
  // final transport. No service, media path, database or process is opened.
  for (const method of ["GET", "HEAD"]) {
    const gate = controlledRangeGate(), entered = controlledRangeGate();
    let rangeWork;
    const fixture = videoRouteFixture((req, res, file, options) => {
      assert.equal(fixture.realm.getStore()?.id, "fixture-user");
      assert.equal(req.method, method);
      assert.equal(file.id, "fixture video/%");
      assert.equal(file.path, "controlled-route.mp4");
      assert.equal(file.cacheControl, "no-store");
      assert.equal(options.resolveMissingSource, fixture.resolveMissingVideoSource);
      entered.resolve();
      rangeWork = gate.promise.then(() => {
        assert.equal(fixture.realm.getStore()?.id, "fixture-user", "the awaited transport must retain the authenticated realm");
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": 11 });
        res.end(method === "HEAD" ? undefined : "route-video");
      });
      rangeWork.catch(() => {});
      return rangeWork;
    });
    const req = capturedVideoRequest(method, fixture.url), res = new CaptureResponse();
    let settled = false;
    const pending = fixture.handler(req, res).then(() => { settled = true; });
    try {
      await entered.promise;
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, "the real request handler must await the video transport rather than a detached call");
      assert.equal(res.headersSent, false);
      gate.resolve(); await pending;
      if (!res.writableFinished) await once(res, "finish");
      assert.equal(res.status, 200);
      assert.equal(Buffer.concat(res.chunks).toString(), method === "HEAD" ? "" : "route-video");
      assert.deepEqual(fixture.errors, []);
      assert.equal(fixture.staticCalls(), 0, "matched videos must not fall through to static content");
    } finally { gate.resolve(); await Promise.allSettled([pending, rangeWork]); }
  }

  const gate = controlledRangeGate(), entered = controlledRangeGate();
  const failure = new Error("controlled private video read failure");
  let rangeWork;
  const fixture = videoRouteFixture(() => {
    entered.resolve();
    rangeWork = gate.promise.then(() => { throw failure; });
    rangeWork.catch(() => {});
    return rangeWork;
  });
  const req = capturedVideoRequest("GET", fixture.url), res = new CaptureResponse();
  const pending = fixture.handler(req, res);
  try {
    await entered.promise; assert.equal(res.headersSent, false);
    gate.resolve(); await pending;
    if (!res.writableFinished) await once(res, "finish");
    assert.equal(res.status, 500, "a late transport rejection must reach the public request boundary");
    assert.deepEqual(JSON.parse(Buffer.concat(res.chunks).toString()), { error: "Internal server error" });
    assert.deepEqual(fixture.errors, [failure]);
    assert.equal(fixture.staticCalls(), 0);
  } finally { gate.resolve(); await Promise.allSettled([pending, rangeWork]); }

  const unmatched = videoRouteFixture(() => assert.fail("unmatched paths must not start a video transport"));
  for (const id of ["missing-video", "fixture-image"]) {
    const missing = new CaptureResponse();
    await unmatched.handler(capturedVideoRequest("GET", `/media/video/${id}`), missing);
    assert.equal(missing.status, 404, "unknown and non-video IDs must not reach the range transport");
  }
  const unmatchedReq = capturedVideoRequest("GET", "/unmatched-video-fixture");
  assert.equal(await unmatched.route(unmatchedReq, new CaptureResponse(), new URL(unmatchedReq.url, "http://fixture.local")), false);
  const fallback = new CaptureResponse();
  await unmatched.handler(unmatchedReq, fallback);
  if (!fallback.writableFinished) await once(fallback, "finish");
  assert.equal(fallback.status, 200);
  assert.equal(Buffer.concat(fallback.chunks).toString(), "fixture-static");
  assert.equal(unmatched.staticCalls(), 1);
  console.log("PASS video route forwarding (held GET/HEAD, late rejection, unmatched false/static fallback)");
}

function videoRouteFixture(serveRangedFile) {
  const realm = new AsyncLocalStorage(), errors = [];
  const mediaStreamService = createRoutedMediaStreamService({ serveRangedFile });
  const file = { id: "fixture video/%", type: "video", path: "controlled-route.mp4", ext: ".mp4" };
  const library = { filesById: new Map([[file.id, file], ["fixture-image", { type: "image" }]]) };
  const resolveMissingVideoSource = () => assert.fail("only the shared range owner may call the resolver");
  let staticCalls = 0;
  const runtime = createWorksRuntime({
    getLibrary: () => library, mediaStreamService,
    notFound(res) { res.writeHead(404); res.end(); }, resolveMissingVideoSource,
    resolveVideoFileByPublicId() { assert.fail("direct video routing must not synchronously resolve a file"); }
  });
  const route = runtime.routeMedia;
  const handler = createRequestHandler({
    attachAccessAnalytics() {}, attachAccessLogger() {}, requestCorsOrigin: () => "",
    requestAuthState: () => ({ allowed: true, user: { id: "fixture-user" } }),
    runForUser: (user, action) => realm.run(user, action), routeAuth: async () => false,
    routeApi: async () => false, routeMedia: route,
    serveStatic(_req, res) { staticCalls++; res.writeHead(200); res.end("fixture-static"); },
    sendJson(res, status, payload) { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(payload)); },
    logError(_prefix, error) { errors.push(error); }
  });
  return { handler, route, realm, errors, resolveMissingVideoSource, url: `/media/video/${encodeURIComponent(file.id)}`, staticCalls: () => staticCalls };
}

async function verifyComposedVideoRangeRelocation(fileServer, fixturePath) {
  const original = Object.freeze({
    id: "relocated video/%", path: path.join(path.dirname(fixturePath), "work-missing.mp4"),
    type: "video", ext: ".mp4", size: 10, entityTag: '"route-relocation-v1"',
    responseHeaders: { "X-Fixture": "catalog descriptor" }
  });
  const present = { ...original, id: "present-video", path: fixturePath };
  const library = { filesById: new Map([[original.id, original], [present.id, present]]) };
  const relocations = [];
  const grouped = createFanhaoDependencies(new Proxy({
    diskUsage: {}, getLibrary: () => library,
    mediaStreamService: createMediaStreamService({ serveRangedFile: fileServer.serveRangedFile }),
    notFound(res) { res.writeHead(404); res.end(); },
    resolveVideoFileByPublicId() { assert.fail("the composed range route must not use the synchronous resolver"); },
    async resolveMissingVideoSource(file, signal) {
      assert.equal(signal.aborted, false);
      relocations.push(file.path);
      assert.equal(file.path, original.path);
      return { ...file, path: fixturePath, cacheControl: "public", entityTag: '"resolver-ignored"', responseHeaders: {} };
    }
  }, { get: (source, key) => source[key] ?? (() => {}) }));
  const runtime = createWorksRuntime(grouped.works);
  const request = async (method, id) => {
    const url = `/media/video/${encodeURIComponent(id)}`;
    const res = new CaptureResponse();
    assert.equal(await runtime.routeMedia(capturedVideoRequest(method, url), res, new URL(url, "http://fixture.local")), true);
    if (!res.writableFinished) await once(res, "finish");
    return res;
  };
  const direct = await request("GET", present.id);
  assert.equal(direct.status, 206);
  assert.deepEqual(relocations, [], "an available indexed file needs no relocation work");

  const relocated = await request("GET", original.id);
  assert.equal(relocated.status, 206);
  assert.equal(Buffer.concat(relocated.chunks).toString(), "3456");
  assert.equal(relocated.responseHeaders["Content-Range"], "bytes 3-6/10");
  assert.equal(relocated.responseHeaders["Cache-Control"], "no-store");
  assert.equal(relocated.responseHeaders["X-Fixture"], "catalog descriptor");
  assert.equal(relocated.responseHeaders.ETag, original.entityTag);
  const head = await request("HEAD", original.id);
  assert.equal(head.status, 200);
  assert.equal(head.responseHeaders["Content-Length"], 10);
  assert.equal(head.chunks.length, 0);
  assert.deepEqual(relocations, [original.path, original.path]);
  assert.equal(fileServer.diagnostics().active, 0);
  console.log("PASS composed video range (indexed and relocated GET/HEAD, response metadata, descriptor drain)");
}

function capturedVideoRequest(method, url) {
  const req = new EventEmitter(); req.method = method; req.url = url; req.headers = { host: "fixture.local", range: "bytes=3-" };
  return req;
}

function controlledRangeGate() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

async function verifyTranscodeResponseContract() {
  let spawnedArgs = [];
  const successChild = fakeTranscodeChild();
  const service = createTranscodeFixtureService((command, args) => {
    assert.equal(command, "ffmpeg-fixture");
    spawnedArgs = args;
    setImmediate(() => {
      successChild.stdout.write(Buffer.from("ftyp"));
      setImmediate(() => {
        successChild.stdout.end(Buffer.from("mdat"));
        successChild.exitCode = 0;
        successChild.emit("close", 0);
      });
    });
    return successChild;
  });
  const successResponse = new CaptureResponse();
  service.serveTranscodedVideo(new EventEmitter(), successResponse, { path: "fixture-8k.mp4" }, new URL("http://fanhao.local/transcode?mode=transcode"));
  if (!successResponse.writableFinished) await once(successResponse, "finish");
  assert.equal(successResponse.status, 200);
  assert.equal(Buffer.concat(successResponse.chunks).toString(), "ftypmdat");
  const filterIndex = spawnedArgs.indexOf("-vf");
  assert(filterIndex >= 0);
  assert.match(spawnedArgs[filterIndex + 1], /min\(iw,4096\).*min\(ih,4096\)/);

  const failedChild = fakeTranscodeChild();
  const failedService = createTranscodeFixtureService(() => {
    setImmediate(() => {
      failedChild.stderr.end("Width 8192 exceeds 4096");
      failedChild.stdout.end();
      failedChild.exitCode = 1;
      failedChild.emit("close", 1);
    });
    return failedChild;
  });
  const failedResponse = new CaptureResponse();
  failedService.serveTranscodedVideo(new EventEmitter(), failedResponse, { path: "fixture-8k.mp4" }, new URL("http://fanhao.local/transcode?mode=transcode"));
  if (!failedResponse.writableFinished) await once(failedResponse, "finish");
  assert.equal(failedResponse.status, 500, "FFmpeg failures before output must not masquerade as empty HTTP 200 videos");
  assert.match(Buffer.concat(failedResponse.chunks).toString(), /视频转码失败/);
}

function createTranscodeFixtureService(spawnProcess) {
  return createMediaStreamService({
    decodeInfoBuffer: () => "",
    ffmpegPath: "ffmpeg-fixture",
    hasNvenc: true,
    isSubtitleLikeInfoText: () => false,
    maxInfoBytes: 1024,
    notFound: () => assert.fail("transcode fixture must exist"),
    parseInfoMetadata: () => null,
    statFile: async () => ({ isFile: () => true }),
    sendJson(res, status, payload) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    },
    serveRangedFile: () => {},
    spawnProcess,
    warn: () => {}
  });
}

function fakeTranscodeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

async function verifyWorkTranscodeRelocation() {
  const file = Object.freeze({ id: "fixture video/1", type: "video", path: staleVideoPath, ext: ".mp4", size: 2048 });
  const otherPath = "R:\\Other\\nested\\movie.mp4";
  const stats = new Map([[relocatedVideoPath, relocatedFileStat]]);
  const calls = [], warnings = [];
  const relocation = createMediaFileRelocationService({
    safeStat() { assert.fail("work transcode must never inspect a path synchronously"); },
    async statFile(candidate) { calls.push(candidate); return stats.get(candidate); },
    async readRootDirectoryNamesAsync(rootPath) { calls.push(rootPath); return ["Other", "Polly Yangs"]; },
    warn: (message) => warnings.push(message)
  });
  const firstStat = controlledRangeGate();
  const child = fakeTranscodeChild();
  let inputPath;
  const mediaStreamService = createMediaStreamService({
    ffmpegPath: "ffmpeg-fixture",
    async statFile(source) { calls.push(source); return firstStat.promise; },
    notFound(res) { res.writeHead(404); res.end(); },
    sendJson(res, status, payload) { res.writeHead(status); res.end(JSON.stringify(payload)); },
    spawnProcess(_command, args) {
      inputPath = args[args.indexOf("-i") + 1];
      setImmediate(() => { child.stdout.end("fixture-transcode"); child.exitCode = 0; child.emit("close", 0); });
      return child;
    },
    warn() {}
  });
  const library = { filesById: new Map([[file.id, file]]) };
  const composition = createFanhaoDependencies(new Proxy({
    diskUsage: {}, getLibrary: () => library, mediaStreamService, notFound: (res) => { res.writeHead(404); res.end(); },
    resolveMissingVideoSource: relocation.resolveMissingSource,
    resolveVideoFileByPublicId() { assert.fail("transcode must use the indexed descriptor directly"); }
  }, { get: (source, key) => source[key] ?? (() => {}) }));
  const runtime = createWorksRuntime(composition.works);
  const route = `/media/video/${encodeURIComponent(file.id)}/transcode`;
  const res = new CaptureResponse();
  try {
    assert.equal(await runtime.routeMedia(capturedVideoRequest("GET", route), res, new URL(route, "http://fixture.local")), true);
    assert.deepEqual(calls, [staleVideoPath], "only the occupied transcode slot may try the original path first");
    assert.equal(inputPath, undefined);
    firstStat.resolve(null);
    if (!res.writableFinished) await once(res, "finish");
    assert.equal(res.status, 200);
    assert.equal(inputPath, relocatedVideoPath);
    assert.equal(file.path, staleVideoPath, "relocation must not mutate the indexed descriptor");
    assert.deepEqual(calls, [staleVideoPath, "R:\\", otherPath, relocatedVideoPath]);
    assert.equal(warnings.length, 1);
    calls.length = 0;
    assert.equal((await relocation.resolveMissingSource(file)).path, relocatedVideoPath);
    assert.deepEqual(calls, [relocatedVideoPath], "a cached relocation is checked without another directory scan");
    assert.equal(await relocation.resolveMissingSource({ ...file, size: 1024 }), null, "relocation must reject mismatched sizes");
    stats.set(otherPath, relocatedFileStat);
    assert.equal(await relocation.resolveMissingSource(file), null, "multiple matching files must not select an arbitrary source");
  } finally { firstStat.resolve(null); await mediaStreamService.stop(); }
}

async function verifyTranscodeRelocationCancellation() {
  const file = { path: staleVideoPath, size: 2048 };
  for (const phase of ["before-scan", "scan", "stat"]) {
    const controller = new AbortController();
    const gate = controlledRangeGate();
    const calls = [];
    const relocation = createMediaFileRelocationService({
      async readRootDirectoryNamesAsync() { calls.push("scan"); return phase === "scan" ? gate.promise : ["Polly Yangs", "Other"]; },
      async statFile() { calls.push("stat"); return gate.promise; },
      warn() { assert.fail("cancelled relocation must not publish a path"); }
    });
    if (phase === "before-scan") controller.abort();
    const pending = relocation.resolveMissingSource(file, controller.signal);
    if (phase === "stat") await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    gate.resolve(phase === "scan" ? ["Polly Yangs", "Other"] : relocatedFileStat);
    assert.equal(await pending, null);
    assert.deepEqual(calls, phase === "before-scan" ? [] : phase === "scan" ? ["scan"] : ["scan", "stat"],
      "an abort must prevent the next relocation IO");
  }
}

async function verifyWorkPlayInfoSourceChecks() {
  const workId = "work %id", overlapId = "work-and-gallery";
  const workGate = controlledRangeGate(), disconnectGate = controlledRangeGate();
  const events = new EventEmitter();
  const event = name => once(events, name, { signal: AbortSignal.timeout(5000) });
  const stat = { isFile: () => true, size: 2048, mtimeMs: 12345 };
  const forbidden = () => assert.fail("play-info fixture must not perform synchronous IO or start ffprobe");
  const paths = [], galleryLookups = [], relocations = [], sent = [];
  const file = (id, name) => ({ id, type: "video", path: `work/${name}.mp4`, ext: ".mp4", size: 2048 });
  const files = [file(workId, "healthy"), file("relocated", "rename-old"), file(overlapId, "moved"),
    file("missing", "missing"), file("disconnect", "disconnect"), file("source-error", "source-error")];
  const library = { filesById: new Map(files.map(item => [item.id, item])) };
  const galleryIndex = { mediaItems: [workId, overlapId, "offline", "source-error"].map((id, index) => ({
    id, sourceRoot: "gallery", relativePath: `${index}.mp4`, size: 2048
  })) };
  const gallery = createGalleryMediaService({
    getImageLibraryIndex: () => galleryIndex, directVideoExts: new Set([".mp4"]),
    safeChildPath: (root, relative) => `${root}/${relative}`, safeStat: forbidden,
    normalizeExt: value => path.extname(value)
  });
  const probe = createVideoProbeService({
    directVideoExts: new Set([".mp4"]), safeStat: forbidden, spawnSyncFn: forbidden, execFileFn: forbidden,
    statTimeoutMs: 4000,
    async statFile(candidate) {
      paths.push(candidate);
      if (candidate === "work/healthy.mp4") { events.emit("work-stat"); return workGate.promise; }
      if (candidate === "work/disconnect.mp4") { events.emit("disconnect-stat"); return disconnectGate.promise; }
      if (candidate === "work/rename-new.mp4") return stat;
      if (candidate === "work/source-error.mp4") throw Object.assign(new Error("synthetic source IO failure"), { code: "EIO" });
      return candidate.startsWith("gallery/") && candidate !== "gallery/2.mp4" ? stat : null;
    },
    persistentCache: { get: () => ({ hit: true, value: { videoCodec: "h264", audioCodec: "aac", duration: 600 } }) }
  });
  const responsePaths = new WeakMap();
  const sendJson = (res, status, payload) => {
    sent.push(responsePaths.get(res));
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  const runtime = createWorksRuntime({
    getLibrary: () => library,
    galleryMediaService: { byId(id) { galleryLookups.push(id); return gallery.byId(id); }, videoFile: gallery.videoFile },
    videoProbeService: probe, resolveVideoFileByPublicId: forbidden, sendJson,
    async resolveMissingVideoSource(file, signal) {
      assert.equal(signal.aborted, false);
      relocations.push(file.id);
      return file.id === "relocated" ? { ...file, path: "work/rename-new.mp4" } : null;
    }
  });
  const errors = [];
  const handler = createRequestHandler({
    attachAccessAnalytics() {}, attachAccessLogger() {}, requestCorsOrigin: () => "",
    requestAuthState: () => ({ allowed: true }), routeAuth: async () => false, routeMedia: async () => false,
    async routeApi(req, res, url) {
      responsePaths.set(res, url.pathname);
      if (url.pathname === "/health") { sendJson(res, 200, { ok: true }); return true; }
      try { return await runtime.routeApi(req, res, url); }
      finally { if (url.pathname === "/api/playinfo/disconnect") events.emit("disconnect-finished"); }
    },
    serveStatic: forbidden, sendJson, logError: (_label, error) => errors.push(error)
  });
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const playInfo = (id, query = "", signal = AbortSignal.timeout(5000)) => fetch(`${base}/api/playinfo/${encodeURIComponent(id)}${query}`, { signal });
  try {
    const entered = event("work-stat");
    const opening = playInfo(workId);
    await entered;
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    assert.deepEqual(await health.json(), { ok: true }, "health must respond while a work source lookup is held");
    assert.deepEqual(galleryLookups, []);
    workGate.resolve(stat);
    const healthy = await opening;
    assert.equal(healthy.status, 200);
    assert.match((await healthy.json()).streamUrl, /^\/media\/video\//);

    const relocated = await playInfo("relocated");
    assert.equal(relocated.status, 200);
    assert.match((await relocated.json()).streamUrl, /^\/media\/video\/relocated\?/);
    assert.deepEqual(paths.slice(-2), ["work/rename-old.mp4", "work/rename-new.mp4"]);
    assert.deepEqual(galleryLookups, []);
    const fallback = await playInfo(overlapId);
    assert.equal(fallback.status, 200);
    assert.match((await fallback.json()).streamUrl, /^\/media\/gallery-video\//);
    assert.deepEqual(relocations, ["relocated", overlapId]);
    const beforeExplicit = paths.length;
    const explicit = await playInfo(workId, "?source=gallery");
    assert.equal(explicit.status, 200);
    assert.match((await explicit.json()).streamUrl, /^\/media\/gallery-video\//);
    assert.deepEqual(paths.slice(beforeExplicit), ["gallery/0.mp4"], "explicit gallery play-info must bypass work file lookup");

    const offline = await playInfo("offline", "?source=gallery");
    assert.equal(offline.status, 200, "a known offline gallery video retains fallback play-info");
    const offlinePayload = await offline.json();
    assert.equal(offlinePayload.duration, null);
    assert.match(offlinePayload.streamUrl, /^\/media\/gallery-video\//);
    const missing = await playInfo("missing");
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "视频文件不存在或已移动，请刷新作品资料" });
    const sourceError = await playInfo("source-error");
    assert.equal(sourceError.status, 503, "a failed stat must not report an absent video or fall back to a different source");
    assert.equal(sourceError.headers.get("retry-after"), "1");
    assert.deepEqual(await sourceError.json(), { error: "暂时无法检查视频文件，请稍后重试", code: "PROBE_SOURCE_UNAVAILABLE", retryable: true });
    assert.equal(relocations.includes("source-error"), false);
    assert.equal(galleryLookups.includes("source-error"), false);

    const enteredDisconnect = event("disconnect-stat"), disconnected = event("disconnect-finished");
    const controller = new AbortController();
    const pending = assert.rejects(playInfo("disconnect", "", controller.signal), { name: "AbortError" });
    await enteredDisconnect; controller.abort(); await pending; await disconnected;
    disconnectGate.resolve(null);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(galleryLookups.includes("disconnect"), false);
    assert.equal(sent.includes("/api/playinfo/disconnect"), false);
    assert.deepEqual(errors, []);

    await probe.stop();
    const stopped = await playInfo(workId);
    assert.equal(stopped.status, 503);
    assert.equal(stopped.headers.get("retry-after"), "1");
    const error = await stopped.json();
    assert.equal(error.code, "PROBE_STOPPED");
    assert.equal(error.retryable, true);
    console.log("PASS play-info (held source/health, relocation, gallery fallback, 404/503, disconnect)");
  } finally {
    workGate.resolve(null); disconnectGate.resolve(null);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await probe.stop();
  }
}
