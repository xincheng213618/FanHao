import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { processVideo, readMarkedWorks, runBatch } from "../tools/subtitles_batch.mjs";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const temporary = createVerifiedTempDir("fanhao-subtitles-batch-");
const video = { id: "1-1", name: "TEST-001.mp4", path: path.join(temporary.tempDir, "TEST-001.mp4") };
fs.writeFileSync(video.path, "synthetic fixture");
const work = { id: "1", videos: [video], localMarkers: ["A"] };
const text = "WEBVTT\n\n00:00:01.000 --> 00:00:05.000\n这是中文字幕验证的内容，我们已经有了字幕就不应该再下载。\n";
let searches = 0, downloads = 0, probes = 0;
const result = { id: "r", title: "TEST-001" }, chinese = { id: "f", name: "TEST-001-zh-CN.srt", language: "zh-CN" };
const track = { id: "existing", language: "zh-CN", match: "code" };
const service = {
  list: async () => ({ tracks: [] }), content: async () => ({ bytes: Buffer.from(text) }),
  search: async () => { searches++; return { results: [result] }; },
  files: async () => ({ files: [chinese] }),
  download: async () => { downloads++; return { track, sidecarName: "TEST-001.zh-CN.srt" }; }
};
const options = { service, execute: true, probe: async () => { probes++; return false; }, networkDelayMs: 0 };
let checks = 0;
const expect = async (expected, w = work, v = video, opts = options) => { assert.equal((await processVideo(w, v, opts)).status, expected); checks++; };
try {
  await assert.rejects(runBatch({ execute: true }), { code: "SUBTITLE_MANUAL_DOWNLOAD_ONLY" }); checks++;
  const dbPath = path.join(temporary.tempDir, "fixture.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE local_works(id INTEGER,work_id INTEGER,local_path TEXT);CREATE TABLE local_files(local_work_id INTEGER,file_type TEXT);");
  const add = db.prepare("INSERT INTO local_works VALUES(?,?,?)");
  add.run(1, 1, "G:\\Person\\[A].TEST-001"); add.run(2, 2, "G:\\[A]\\Person\\TEST-002"); add.run(3, 3, "G:\\Person\\[a].TEST-003"); add.run(4, 4, "G:\\Person\\[A].TEST-004");
  db.exec("INSERT INTO local_files VALUES(1,'video'),(2,'video'),(3,'video'),(4,'info')"); db.close();
  assert.deepEqual(readMarkedWorks(dbPath), ["1", "3"]); checks++;
  await expect("not_marked", { ...work, localMarkers: [] });
  await expect("offline", work, { ...video, path: path.join(temporary.tempDir, "missing.mp4") });
  await expect("existing_chinese_filename", work, { ...video, name: "TEST-001-C.mp4" });
  assert.equal(probes, 0); assert.equal(searches, 0); checks++;
  await expect("existing_chinese_subtitle", work, video, { ...options, service: { ...service, list: async () => ({ tracks: [track] }) } });
  await expect("existing_chinese_subtitle", work, video, { ...options, service: { ...service, list: async () => ({ tracks: [{ ...track, language: "und" }] }) } });
  const generic = { ...track, match: "manual", language: "und", name: "output_translated.srt" };
  await expect("suspected_existing_chinese_manual", { ...work, infos: [{ name: generic.name, path: path.join(temporary.tempDir, generic.name) }] }, video,
    { ...options, service: { ...service, list: async () => ({ tracks: [generic] }) } });
  await expect("existing_chinese_embedded", work, video, { ...options, probe: async () => true });
  await expect("probe_failed", work, video, { ...options, probe: async () => { throw new Error("unavailable"); } });
  assert.equal(searches, 0); checks++;
  await expect("needs_search", work, video, { ...options, execute: false });
  assert.equal(searches, 0); checks++;
  await expect("no_code", { ...work, directoryName: "Person" }, { ...video, name: "movie.mp4" });
  await expect("no_result", work, video, { ...options, service: { ...service, search: async () => ({ results: [] }) } });
  await expect("no_chinese_download", work, video, { ...options, service: { ...service, files: async () => ({ files: [{ ...chinese, language: "en" }] }) } });
  const variant = { ...video, name: "TEST-001-U.mp4" };
  await expect("ambiguous_version", { ...work, videos: [variant, { ...video, id: "1-2", name: "TEST-001-4K.mp4" }] }, variant);
  await expect("changed_during_search", work, video, { ...options, beforeWrite: async () => false });
  assert.equal(downloads, 0); checks++;
  let reads = 0;
  await expect("existing_chinese_subtitle", work, video, { ...options, service: { ...service, list: async () => ({ tracks: ++reads > 1 ? [track] : [] }) } });
  assert.equal(downloads, 0); checks++;
  await expect("downloaded"); assert.equal(downloads, 1); checks++;
  await expect("download_failed", work, video, { ...options, verifySaved: async () => false });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(processVideo(work, video, { ...options, signal: controller.signal }), { name: "AbortError" }); checks++;
  console.log(`Subtitle batch verified: ${checks} checks (A scope, real skip evidence, dry run, exact candidates, no overwrite, playback receipt and cancellation).`);
} finally { temporary.cleanup(); }
