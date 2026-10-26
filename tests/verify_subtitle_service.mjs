import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createSubtitleService } from "../src/modules/fanhao/server/playback/subtitle-service.js";
import { createSubtitleRuntime } from "../src/modules/fanhao/server/playback/subtitle-runtime.js";
import { readJsonBody } from "../src/platform/server/request-io.js";
import { sendJson } from "../src/platform/server/responses.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const temporary = createVerifiedTempDir("fanhao-subtitles-service-");
const directory = fs.realpathSync(temporary.tempDir);
const media = path.join(directory, "media"), cacheDir = path.join(directory, "cache");
fs.mkdirSync(media);
const srt = "1\r\n00:00:02,000 --> 00:00:05,000\r\n字幕验证\r\n\r\n2\r\n00:00:12,000 --> 00:00:15,000\r\n第二句\r\n";
const raw = Buffer.concat([Buffer.from([255, 254]), Buffer.from(srt, "utf16le")]);
const file = (id, name, type = "info") => ({ id, name, path: path.join(media, name), type });
const video = file("v/1", "ABC-001.mp4", "video");
const local = file("s/1", "ABC-001.zh-CN.srt");
fs.writeFileSync(local.path, raw);
const work = { id: "w/1", code: "ABC-001", videos: [video], infos: [local] };
const other = { id: "w/2", code: "ABC-002", videos: [file("v/2", "ABC-002.mp4", "video")], infos: [] };
fs.writeFileSync(video.path, "synthetic fixture video");
fs.writeFileSync(other.videos[0].path, "synthetic fixture video two");
const provider = {
  search: async query => ({ source: "SubtitleCat", query, results: [{ id: "result", title: "Synthetic fixture" }] }),
  files: async resultId => { assert.equal(resultId, "result"); return { files: [{ id: "english", name: "fixture.en.srt", language: "en" }] }; },
  download: async (resultId, fileId) => { assert.equal(resultId, "result"); assert.equal(fileId, "english"); return { bytes: Buffer.from(srt.replace("字幕验证", "Fixture")), name: "fixture.en.srt", language: "en", sourceUrl: "https://www.subtitlecat.com/subs/1/fixture-en.srt" }; },
  beginStop() {}, stop: async () => {}
};
const options = { cacheDir, roots: [media], resolveWork: id => [work, other].find(item => item.id === id), provider };
let service = createSubtitleService(options), runtime, server;
let checks = 0;
const reject = async (promise, code) => { await assert.rejects(promise, error => code === undefined || error.code === code); checks++; };

try {
  const listed = await service.list(work.id, video.id);
  assert.equal(listed.tracks.length, 1);
  assert.equal(listed.tracks[0].language, "zh-CN");
  assert.equal(listed.tracks[0].autoSelect, true);
  assert(!JSON.stringify(listed).includes(media), "responses must not expose filesystem paths"); checks++;
  const track = listed.tracks[0];
  assert.equal((await service.content(work.id, video.id, track.id, { download: true })).bytes.equals(raw), true);
  const converted = await service.content(work.id, video.id, track.id);
  assert.match(converted.bytes.toString(), /WEBVTT\n/);
  assert.match(converted.bytes.toString(), /字幕验证/);
  assert.equal(converted.cueCount, 2); checks++;
  const shifted = await service.content(work.id, video.id, track.id, { offsetSeconds: -10 });
  assert.equal(shifted.cueCount, 1);
  assert.match(shifted.bytes.toString(), /00:00:02\.000 --> 00:00:05\.000/); checks++;
  await reject(service.list(other.id, video.id), "SUBTITLE_VIDEO_MISSING");
  await reject(service.list("missing", video.id), "SUBTITLE_WORK_MISSING");
  await reject(service.content(work.id, video.id, "cache:forged"), "SUBTITLE_TRACK_MISSING");
  assert.equal((await service.search(work.id, video.id)).query, "ABC-001");
  work.infoSummary = { code: "人物名称" }; work.directoryName = "人物名称";
  assert.equal((await service.list(work.id, video.id)).query, "ABC-001", "the selected filename wins over invalid metadata codes");
  assert.equal((await service.search(work.id, video.id, "The Matrix 1999")).query, "The Matrix 1999", "explicit title queries remain available");
  assert.equal((await service.files(work.id, video.id, "result")).files.length, 1); checks++;

  const uploadBody = { videoId: video.id, name: "../../导入.zh-CN.srt", contentBase64: raw.toString("base64") };
  const uploaded = await service.upload(work.id, uploadBody);
  assert.equal(uploaded.tracks.length, 2);
  assert.equal(uploaded.track.name, "导入.zh-CN.srt");
  assert.equal(uploaded.track.source, "upload");
  assert.equal((await service.content(work.id, video.id, uploaded.track.id, { download: true })).bytes.equals(raw), true); checks++;
  const duplicated = await Promise.all([service.upload(work.id, uploadBody), service.upload(work.id, uploadBody)]);
  assert(duplicated.every(value => value.track.id === uploaded.track.id && value.tracks.length === 2), "uploads are serialized and content-idempotent"); checks++;
  const downloaded = await service.download(work.id, { videoId: video.id, resultId: "result", fileId: "english" });
  assert.equal(downloaded.savedBesideVideo, true);
  assert(fs.existsSync(path.join(media, downloaded.sidecarName)), "downloaded subtitle must sit beside the video");
  assert.equal(downloaded.track.language, "en"); checks++;
  const oldDownloadId = "cache:" + crypto.createHash("sha256").update(Buffer.from(srt.replace("字幕验证", "Fixture"))).digest("hex");
  assert.equal((await service.content(work.id, video.id, oldDownloadId)).cueCount, 2, "cache URLs remain valid when a sidecar becomes visible"); checks++;
  assert.equal((await service.list(other.id, other.videos[0].id)).tracks.length, 0, "saved tracks are video-scoped"); checks++;
  await service.stop();
  await reject(service.list(work.id, video.id), "SUBTITLE_STOPPING");
  service = createSubtitleService(options);
  assert.equal((await service.list(work.id, video.id)).tracks.length, 3, "cache survives restart"); checks++;
  const workCache = path.join(cacheDir, crypto.createHash("sha256").update(work.id).digest("hex"));
  const savedFile = path.join(workCache, fs.readdirSync(workCache)[0], uploaded.track.id.slice(6) + ".srt");
  const oldId = video.id; video.id = "v/reordered";
  assert.equal((await service.list(work.id, video.id)).tracks.length, 3, "rescan sort ids cannot move subtitles to a different file"); checks++;
  const oldPath = video.path;
  video.name = "different-video.mp4"; video.path = path.join(media, video.name); fs.writeFileSync(video.path, "replacement fixture video");
  assert.equal((await service.list(work.id, video.id)).tracks.length, 1, "replacement video cannot inherit saved subtitles"); checks++;
  video.id = oldId; video.name = "ABC-001.mp4"; video.path = oldPath;
  fs.writeFileSync(savedFile, "replaced");
  await reject(service.content(work.id, video.id, uploaded.track.id), "SUBTITLE_CACHE_CHANGED");
  await reject(service.upload(work.id, uploadBody), "SUBTITLE_CACHE_CHANGED");
  fs.writeFileSync(savedFile, raw);
  await reject(service.upload(work.id, { videoId: video.id, name: "bad.srt", text: "<html>provider error</html>" }), "SUBTITLE_NO_CUES");
  await reject(service.upload(work.id, { videoId: video.id, name: "file.exe", text: srt }));
  await reject(service.upload(work.id, { videoId: video.id, name: "file.srt", contentBase64: "a===" }));
  await reject(service.upload(work.id, null));
  await reject(service.upload(work.id, { videoId: video.id, name: "big.srt", text: "x".repeat(2097153) }), "SUBTITLE_TOO_LARGE");
  const before = fs.readFileSync(local.path);
  await reject(service.content(work.id, video.id, "local:unknown"));
  assert(fs.readFileSync(local.path).equals(before), "imports/downloads leave original subtitles intact"); checks++;

  const outside = path.join(directory, "outside"); fs.mkdirSync(outside);
  const escaped = { ...local, id: "outside", path: path.join(outside, local.name) };
  fs.writeFileSync(escaped.path, raw); work.infos.push(escaped);
  const outsideTrack = (await service.list(work.id, video.id)).tracks.find(item => item.id === "local:" + Buffer.from(escaped.id).toString("base64url"));
  await reject(service.content(work.id, video.id, outsideTrack.id)); work.infos.pop();
  const junction = path.join(media, "linked"); fs.symlinkSync(outside, junction, "junction");
  work.infos.push({ ...escaped, id: "junction", path: path.join(junction, local.name) });
  await reject(service.content(work.id, video.id, "local:" + Buffer.from("junction").toString("base64url")));
  work.infos.pop(); fs.unlinkSync(junction);

  let bodyReads = 0;
  runtime = createSubtitleRuntime({ ...options, sendJson,
    readJsonBody: (...args) => { bodyReads++; return readJsonBody(...args); },
    requireLocalAdmin: (req, res) => { if (req.headers["x-fixture-denied"]) { sendJson(res, 403, { error: "denied" }); return false; } return true; }
  });
  server = http.createServer(async (req, res) => {
    try { if (!await runtime.routeApi(req, res, new URL(req.url, "http://localhost"))) { res.writeHead(404); res.end(); } }
    catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const endpoint = origin + `/api/works/${encodeURIComponent(work.id)}/subtitles`;
  const response = await fetch(endpoint + "?videoId=" + encodeURIComponent(video.id));
  assert.equal(response.status, 200); checks++;
  const fromApi = await response.json();
  const head = await fetch(origin + fromApi.tracks[0].url, { method: "HEAD" });
  assert.equal(head.status, 200); assert.match(head.headers.get("content-type"), /text\/vtt/);
  assert.equal((await head.arrayBuffer()).byteLength, 0); checks++;
  const downloadResponse = await fetch(origin + fromApi.tracks.find(item => item.id === track.id).downloadUrl);
  assert.match(downloadResponse.headers.get("content-disposition"), /attachment/);
  assert.deepEqual(Buffer.from(await downloadResponse.arrayBuffer()), raw); checks++;
  assert.equal((await fetch(origin + fromApi.tracks[0].url + "&offsetSeconds=NaN")).status, 400); checks++;
  assert.equal((await fetch(origin + "/api/works/%ZZ/subtitles?videoId=x")).status, 400); checks++;
  const post = async (suffix, body, headers = {}) => fetch(endpoint + "/" + suffix, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  assert.equal((await post("upload", JSON.stringify(uploadBody), { "x-fixture-denied": "1" })).status, 403);
  assert.equal(bodyReads, 0, "authorization precedes body parsing"); checks++;
  assert.equal((await post("upload", "{")).status, 400);
  assert.equal((await post("upload", "null")).status, 400);
  assert.equal((await post("upload", JSON.stringify(uploadBody))).status, 200); checks++;
  assert.equal((await post("upload", JSON.stringify({ text: "x".repeat(3 * 1024 * 1024) }))).status, 413); checks++;
  assert.equal((await fetch(endpoint, { method: "DELETE" })).status, 405); checks++;
  await runtime.stop();
  assert.equal((await fetch(endpoint + "?videoId=" + encodeURIComponent(video.id))).status, 503); checks++;

  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocking = createSubtitleService({ ...options, provider: { ...provider, search: async (query, { signal }) => {
    entered(); await new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  } } });
  const waiting = blocking.search(work.id, video.id).catch(error => error);
  await started; await blocking.stop();
  assert.equal((await waiting).name, "AbortError", "shutdown cancels and owns in-flight requests"); checks++;
  let release, enteredHeld;
  const heldStarted = new Promise(resolve => { enteredHeld = resolve; });
  const held = createSubtitleService({ ...options, stopWaitMs: 20, provider: { ...provider, search: () => {
    enteredHeld(); return new Promise(resolve => { release = resolve; });
  } } });
  const heldRequest = held.search(work.id, video.id);
  await heldStarted; await reject(held.stop(), "SUBTITLE_STOP_TIMEOUT");
  await reject(held.list(work.id, video.id), "SUBTITLE_STOPPING");
  release({ results: [] }); await heldRequest; await held.stop(); checks++;
  const freshCache = path.join(directory, "first-upload-cache");
  const pair = createSubtitleService({ ...options, cacheDir: freshCache, resolveWork: () => ({ ...work, videos: [video, other.videos[0]] }) });
  const concurrent = await Promise.all([pair.upload(work.id, uploadBody), pair.upload(work.id, { ...uploadBody, videoId: other.videos[0].id })]);
  assert(concurrent.every(value => value.track), "first uploads to two videos share parent creation safely"); checks++;
  await pair.stop();
  console.log(`Subtitle service verified: ${checks} behavior checks (temporary media/cache and HTTP server).`);
} finally {
  await service.stop(); await runtime?.stop();
  if (server) await new Promise(resolve => server.close(resolve));
  temporary.cleanup();
}
