import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createFileServer, entityValidators, ifRangeMatches, parseRange } from "../src/platform/server/file-server.js";
import { createMediaFileRelocationService } from "../src/modules/fanhao/server/works/media-file-relocation-service.js";
import { createVideoProbeService } from "../src/platform/server/video-probe-service.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

assert.deepEqual(parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
assert.deepEqual(parseRange("bytes=900-", 1000), { start: 900, end: 999 });
assert.deepEqual(parseRange("bytes=-100", 1000), { start: 900, end: 999 });
assert.deepEqual(parseRange("bytes=900-2000", 1000), { start: 900, end: 999 });
assert.equal(parseRange("bytes=1000-", 1000), null);
assert.equal(parseRange("bytes=-0", 1000), null);

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
assertPlaybackMode({ ext: ".mp4", videoCodec: "hevc", audioCodec: "aac", expected: "transcode" });
assertPlaybackMode({ ext: ".mp4", videoCodec: "h264", audioCodec: "ac3", expected: "remux" });
assertPlaybackMode({ ext: ".mkv", videoCodec: "h264", audioCodec: "aac", expected: "remux" });
assertPlaybackMode({ ext: ".mkv", videoCodec: "hevc", audioCodec: "aac", expected: "transcode" });
assertPlaybackMode({ ext: ".wmv", videoCodec: "vc1", audioCodec: "wmapro", expected: "transcode" });

const serverConfigSource = fs.readFileSync(path.join(root, "src", "bootstrap", "server-config.js"), "utf8");
const routeSource = fs.readFileSync(path.join(root, "src", "modules", "fanhao", "server", "works", "routes-media.js"), "utf8");
const streamSource = fs.readFileSync(path.join(root, "src", "platform", "server", "media-stream-service.js"), "utf8");
const fileServerSource = fs.readFileSync(path.join(root, "src", "platform", "server", "file-server.js"), "utf8");
const playerHtmlSource = fs.readFileSync(path.join(root, "public", "player.html"), "utf8");
const playerSource = fs.readFileSync(path.join(root, "public", "js", "player-page.js"), "utf8");
const nativePlayerSource = fs.readFileSync(
  path.join(root, "android-client", "android", "app", "src", "main", "java", "local", "fanhao", "library", "NativePlayerActivity.java"),
  "utf8"
);
const shortVideoRuntimeSource = fs.readFileSync(path.join(root, "src", "modules", "short-videos", "server", "runtime.js"), "utf8");

assert(serverConfigSource.includes("DEFAULT_VIDEO_CHUNK_BYTES: 4 * 1024 * 1024"), "video initial ranges should avoid 1 MB request churn");
assert(routeSource.includes('cacheControl: "private, max-age=0, must-revalidate"'), "native video ranges should be reusable with validators");
assert(fileServerSource.includes("const entitySize = Math.max(stat.size") && fileServerSource.includes('"Content-Range": `bytes ${responseRange.start}-${responseRange.end}/${entitySize}`'), "partial startup files must preserve the original media entity size in HTTP ranges");
assert(fileServerSource.includes("...responseHeaders"), "media range responses must expose module diagnostics without changing the shared file server contract");
assert(shortVideoRuntimeSource.includes("!hasIfRange(req)") && shortVideoRuntimeSource.includes('req?.headers?.["if-range"]'), "conditional ranges must bypass physical startup-prefix files so stale validators can receive a complete 200 entity");
assert(shortVideoRuntimeSource.includes("entityMtimeMs: renditionEntityMtimeMs") && shortVideoRuntimeSource.includes("sourceEntityMtimeMs / 1000"), "smooth renditions must expose a representation revision distinct from the source served at the same URL");
assert(shortVideoRuntimeSource.includes("short-video-smooth") && shortVideoRuntimeSource.includes('"no-store"'), "uncached adaptive short-video responses must not pin the original stream under the rendition URL");
assert(shortVideoRuntimeSource.includes('url.searchParams.get("wait")') && shortVideoRuntimeSource.includes('playbackPrepare = "source-no-wait"'), "mobile smooth playback must reuse a ready rendition without blocking first play on a background transcode");
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
for (const option of ['"-fflags", "+genpts"', '"-avoid_negative_ts", "make_zero"', '"-pix_fmt", "yuv420p"']) {
  assert(streamSource.includes(option), `missing compatibility option: ${option}`);
}

async function verifyFileServerRangeContract() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-file-range-contract-"));
  const fixturePath = path.join(fixtureRoot, "fixture.mp4");
  const emptyPath = path.join(fixtureRoot, "empty.mp4");
  const rewritePath = path.join(fixtureRoot, "rewrite.mp4");
  try {
    fs.writeFileSync(fixturePath, Buffer.from("0123456789"));
    fs.writeFileSync(emptyPath, Buffer.alloc(0));
    const stat = fs.statSync(fixturePath);
    const derivedValidators = entityValidators({}, stat, stat.size);
    assert.match(derivedValidators.ETag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    assert.equal(ifRangeMatches(derivedValidators.ETag, derivedValidators), false, "metadata-derived weak ETags must never authorize a range append");
    assert.equal(ifRangeMatches(derivedValidators["Last-Modified"], derivedValidators), true);
    const file = { path: fixturePath, ext: ".mp4", entityTag: '"fixture-content-v1"' };
    const validators = entityValidators(file, stat, stat.size);
    assert.equal(validators.ETag, '"fixture-content-v1"');
    assert.equal(ifRangeMatches(validators.ETag, validators), true);
    assert.equal(ifRangeMatches(`W/${validators.ETag}`, validators), false);
    assert.equal(ifRangeMatches(validators["Last-Modified"], validators), true);
    const sourceAtSameUrl = entityValidators({}, { size: 10, mtimeMs: 1_725_000_000_000 }, 10);
    const renditionAtSameUrl = entityValidators(
      { entityMtimeMs: 1_725_000_001_000 },
      { size: 10, mtimeMs: 1_725_000_000_000 },
      10
    );
    assert.notEqual(
      renditionAtSameUrl["Last-Modified"],
      sourceAtSameUrl["Last-Modified"],
      "source-to-rendition transitions at one URL must invalidate Last-Modified checkpoints"
    );

    const fileServer = createFileServer({
      defaultChunkBytes: 4,
      mimeTypes: { ".mp4": "video/mp4" },
      normalizeExt: (filePath) => path.extname(filePath).toLowerCase(),
      notFound: () => assert.fail("controlled file fixture should exist"),
      safeStat: (filePath) => fs.statSync(filePath, { throwIfNoEntry: false })
    });

    const full = await captureFileResponse(fileServer, "serveRangedFile", "GET", {}, file);
    assert.equal(full.status, 200);
    assert.equal(full.body.toString(), "0123456789");
    assert.equal(full.headers["Content-Length"], 10);
    assert.equal(full.headers.ETag, validators.ETag);
    assert.ok(full.headers["Last-Modified"]);
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
      "HEAD",
      { range: "bytes=2-4", "if-range": validators["Last-Modified"] },
      file
    );
    assert.equal(byDate.status, 206);
    assert.equal(byDate.headers["Content-Range"], "bytes 2-4/10");
    assert.equal(byDate.body.length, 0);

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
    const unsatisfiedHead = await captureFileResponse(
      fileServer,
      "serveRangedFile",
      "HEAD",
      { range: "bytes=10-" },
      file
    );
    assert.equal(unsatisfiedHead.status, unsatisfied.status);
    assert.deepEqual(unsatisfiedHead.headers, unsatisfied.headers);
    assert.equal(unsatisfiedHead.body.length, 0);

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

    const prefixPath = path.join(fixtureRoot, "fixture.mp4.start");
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
    fs.rmSync(resolvedRoot, { recursive: true, force: true });
  }
}

async function captureFileResponse(fileServer, methodName, method, headers, file) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  const res = new CaptureResponse();
  fileServer[methodName](req, res, file, "fixture.mp4");
  if (!res.writableFinished) await once(res, "finish");
  return {
    status: res.status,
    headers: res.responseHeaders,
    body: Buffer.concat(res.chunks)
  };
}

class CaptureResponse extends Writable {
  constructor() {
    super();
    this.status = 0;
    this.responseHeaders = {};
    this.headersSent = false;
    this.chunks = [];
  }

  writeHead(status, headers = {}) {
    this.status = status;
    this.responseHeaders = { ...headers };
    this.headersSent = true;
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
}

await verifyFileServerRangeContract();
console.log("video-playback: ok (range contract, native MP4, MKV remux, WMV/MKV transcode)");
