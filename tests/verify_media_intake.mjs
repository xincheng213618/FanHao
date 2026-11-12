import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { createLtxCatalogService } from "../src/modules/fanhao/server/catalog/ltx-catalog-service.js";
import { createCoreLibraryService } from "../src/modules/fanhao/server/library/core-library-service.js";
import { createSubtitlecatProvider } from "../src/modules/fanhao/server/playback/subtitlecat-provider.js";
import { createMediaIntakeService } from "../src/modules/fanhao/server/workflows/media-intake-service.js";
import { classifyIntakeAds, nameForIntake, stageIntakeFile, signature } from "../src/modules/fanhao/server/workflows/intake-files.js";
import { routeFileWorkflows } from "../src/modules/fanhao/server/workflows/routes.js";
import { createStaticFileServer } from "../src/platform/server/static-files.js";
import { readJsonBody } from "../src/platform/server/request-io.js";
import { sendJson, notFound } from "../src/platform/server/responses.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const temporary = createVerifiedTempDir("fanhao-media-intake-");
const root = temporary.tempDir;
const incoming = path.join(root, "incoming"), library = path.join(root, "library"), actor = path.join(library, "Fixture Person");
const outside = path.join(root, "other-drive");
const archive = path.join(library, "[Archive]");
const db = new DatabaseSync(path.join(root, "fixture.sqlite"));
const timestamp = "2026-11-06T00:00:00Z";
const fixtureCoverUrl = "https://c0.jdbstatic.com/covers/fixture/ABC-789.jpg";
const openCalls = [];
const probeGates = new Map();
const fixtureChineseSubtitle = [
  "1\n00:00:01,000 --> 00:00:04,000\n你好，我们今天一起核对这个字幕文件。",
  "2\n00:15:00,000 --> 00:15:03,000\n这是一条中文测试字幕，我现在可以看到了。",
  "3\n00:29:55,000 --> 00:29:58,000\n请把字幕和这个视频一起放到正确的目录里。"
].join("\n\n") + "\n";
let indexReads = 0, browser, server;
let accessMode = "local";
const bytes = (file) => fs.readFileSync(file, "utf8");
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const source = (name, text = "fixture incoming 1080p") => write(path.join(incoming, name), text);
const descriptor = (file, relative) => {
  const { size, mtimeMs } = fs.statSync(file);
  return { name: path.basename(file), size, modified: Math.floor(mtimeMs), relative };
};

db.exec(`
  CREATE TABLE works(id INTEGER PRIMARY KEY, code TEXT, code_search TEXT, title TEXT, release_date TEXT, duration_minutes INTEGER,
    rating REAL,rating_count INTEGER,director TEXT,description TEXT,raw_text TEXT,fields_json TEXT,javdb_tags_json TEXT,status TEXT,error TEXT,
    source TEXT,created_at TEXT,updated_at TEXT,has_magnet INTEGER,is_streamable INTEGER,has_subtitles INTEGER);
  CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT,name_search TEXT,display_name TEXT,folder_path TEXT,status TEXT,source TEXT,created_at TEXT,updated_at TEXT);
  CREATE TABLE person_aliases(person_id INTEGER,alias_search TEXT);
  CREATE TABLE work_people(work_id INTEGER,person_id INTEGER,role TEXT,sort_order INTEGER,source TEXT,created_at TEXT,updated_at TEXT,
    UNIQUE(work_id,person_id,role));
  CREATE TABLE local_works(id INTEGER PRIMARY KEY,work_id INTEGER,local_path TEXT,source_info_path TEXT,source_info_id TEXT,source_name TEXT,
    source_size INTEGER,source_mtime TEXT,detected_code TEXT,detected_code_search TEXT,matched_by TEXT,confidence REAL,created_at TEXT,updated_at TEXT);
  CREATE TABLE local_files(id INTEGER PRIMARY KEY,work_id INTEGER,local_work_id INTEGER,file_id TEXT UNIQUE,file_type TEXT,file_path TEXT,name TEXT,title TEXT,
    ext TEXT,relative_path TEXT,size INTEGER,modified_at TEXT,playable INTEGER,sort_order INTEGER,created_at TEXT,updated_at TEXT);
  CREATE TABLE video_probe_cache(file_id TEXT,file_path TEXT,source_size INTEGER,source_mtime TEXT,schema_version INTEGER,status TEXT,
    probe_json TEXT,updated_at TEXT,PRIMARY KEY(file_id,file_path));
`);
db.prepare("INSERT INTO people VALUES(1,'Fixture Person','fixtureperson','Fixture Person',?,'ok','fixture',?,?)").run(actor, timestamp, timestamp);
fs.mkdirSync(incoming); fs.mkdirSync(actor, { recursive: true });

function oldVideo(id, code, marker, contents, actorDir = actor, folderPrefix = "") {
  const title = `${code} Fixture`;
  const folder = path.join(actorDir, folderPrefix + title);
  const file = write(path.join(folder, `${title}${marker}.mp4`), contents);
  db.prepare("INSERT INTO works(id,code,code_search,title,source) VALUES(?,?,?,?,'fixture')").run(id, code, code.replace("-", "").toLowerCase(), title);
  db.prepare("INSERT INTO work_people VALUES(?,1,'actor',0,'fixture',?,?)").run(id, timestamp, timestamp);
  db.prepare("INSERT INTO local_works(id,work_id,local_path) VALUES(?,?,?)").run(id, id, folder);
  db.prepare(`INSERT INTO local_files(id,work_id,local_work_id,file_id,file_type,file_path,name,size,modified_at,sort_order)
    VALUES(?,?,?,?,'video',?,?,?,?,0)`).run(id, id, id, `video-${id}`, file, path.basename(file), fs.statSync(file).size, timestamp);
  return file;
}

const snapshotItem = { title: "LTX fixture title", title_zh: "Translated title", actors: ["Fixture Person"], links: [] };
const restoredName = "ABC-943_restored.mp4";
const restoredLink = `ed2k://|file|${restoredName}|${Buffer.byteLength("fixture incoming 1080p")}|00112233445566778899aabbccddeeff|/`;
const directSubtitle = "https://www.subtitlecat.com/subs/1/ABC-943-zh-CN.srt";
const mismatchedSubtitle = "https://www.subtitlecat.com/subs/1/ABC-999-zh-CN.srt";
const batchCode = "ABC-899", batchSubtitle = `https://www.subtitlecat.com/subs/1/${batchCode}-zh-CN.srt`;
const { findIntakeMetadata } = createLtxCatalogService({ snapshotPath: write(path.join(root, "ltx-catalog.json"), JSON.stringify({
  schema_version: 1, items: [{ ...snapshotItem, code: "ABC-937" }, { ...snapshotItem, code: "ABC-938" }, { ...snapshotItem, code: "ABC-0938" },
    { ...snapshotItem, code: "ABC-943", subtitle: directSubtitle, links: [restoredLink] }, { ...snapshotItem, code: "ABC-944", subtitle: mismatchedSubtitle },
    { ...snapshotItem, code: batchCode, subtitle: batchSubtitle }]
})) });
const subtitleRequests = [];
const directProvider = createSubtitlecatProvider({ fetchImpl: async (url) => {
  if (url === batchSubtitle) return new Response(fixtureChineseSubtitle, { headers: { "Content-Type": "application/x-subrip" } });
  assert([directSubtitle, mismatchedSubtitle].includes(url));
  subtitleRequests.push(url);
  if (subtitleRequests.length === 1) return new Response("temporary outage", { status: 503 });
  return new Response(fixtureChineseSubtitle, { headers: { "Content-Type": "application/x-subrip" } });
} });
let resolveIntakeWork = () => null;
const serviceOptions = { getDb: () => db, resolveWork: (id) => resolveIntakeWork(id), sourceRoots: [incoming], libraryRoots: [library, archive], findLocalMetadata: findIntakeMetadata,
  subtitleBackupRoot: path.join(root, "subtitle-backups"),
  subtitleProvider: {
    downloadDirect: directProvider.downloadDirect,
    async search(code) {
      if (code === "ABC-945") return { results: [] };
      assert.equal(code, "ABC-935");
      return { results: [{ id: "fixture-subtitle", title: "ABC-935 中文", pageUrl: "https://www.subtitlecat.com/subs/1/ABC-935.html" }] };
    },
    async files(id) {
      assert.equal(id, "fixture-subtitle");
      return { files: [{ id: "fixture-zh-cn", name: "ABC-935-zh-CN.srt", label: "简体中文", language: "zh-CN" }] };
    },
    async download(resultId, fileId) {
      assert.deepEqual([resultId, fileId], ["fixture-subtitle", "fixture-zh-cn"]);
      return { bytes: Buffer.from(fixtureChineseSubtitle), name: "ABC-935-zh-CN.srt", language: "zh-CN" };
    }
  },
  searchRoots: async () => [outside, library],
  classifyAds: (unnumbered, numbered) => classifyIntakeAds(process.env.PYTHON || "python", path.resolve("tools/clean.py"), unnumbered, numbered),
  targetDevice: (folder) => folder.startsWith(archive + path.sep) ? "archive" : "main",
  relativeFromRoot: (file) => path.relative(library, file), openPath: async (file) => { openCalls.push(file); },
  probeVideo: async (file) => {
    await probeGates.get(file);
    const contents = bytes(file);
    if (contents.includes("unreadable metadata")) return null;
    const fourK = contents.includes("2160p");
    return { width: fourK ? 3840 : 1920, height: fourK ? 2160 : 1080, duration: 1800, videoCodec: "h264", audioCodec: "aac" };
  },
  fetchMetadata: async (code, detailUrl) => {
    if (code === "ABC-936" && !detailUrl) return null;
    if (code === "ABC-937" || code === "ABC-938") return { accessBlocked: "login" };
    if (detailUrl === "https://javdb.com/v/GatewayFixture") return { upstreamStatus: 502 };
    const pageCode = detailUrl === "https://javdb.com/v/WrongFixture" ? "ABC-999" : code;
    return { code: pageCode, title: `${pageCode} New Work`, detailUrl, imageUrl: code === "ABC-789" ? fixtureCoverUrl : "",
      actors: code === "ABC-936" ? ["Fixture Person", "Other Fixture Person"] : ["Fixture Person"], tags: ["fixture"], date: "2025-03-01" };
  },
  onIndexChanged: () => { indexReads += 1; }
};
const service = createMediaIntakeService(serviceOptions);

async function settle(job) {
  for (let i = 0; i < 160; i += 1) {
    const current = service.detail(job.id);
    if (!current.active) return current;
    await delay(30);
  }
  throw new Error("Intake did not settle");
}

try {
  assert.equal(nameForIntake(actor, "ABC-123", "[A].[A.]ABC-123 [A.]ABC-123 Fixture", { ltx: true, c: true, quality4k: true }, ".mp4", 2),
    "ABC-123 Fixture-CD2-LTXC-4K.mp4");
  assert.equal(nameForIntake(actor, "ABC-123", "ABC-1234 Fixture mentions ABC-123", {}, ".mp4"),
    "ABC-123 ABC-1234 Fixture mentions ABC-123.mp4");
  const existing = oldVideo(1, "ABC-123", "-LTX", "fixture library old 1080p", actor, "[A.]");
  db.prepare("UPDATE works SET title=? WHERE id=1").run("[A.]ABC-123 [A].ABC-123 Fixture");
  const replacement = source("ABC-123.mp4");
  const subtitle = source("ABC-123.zh.srt", "fixture subtitles");
  const stat = fs.statSync(replacement);
  const scan = await service.scan({ files: [{ name: path.basename(replacement), size: stat.size, modified: Math.floor(stat.mtimeMs) }] });
  assert.equal(scan.items[0].path, replacement);
  const compared = await service.compare({ path: replacement });
  assert.equal(compared.code, "ABC-123");
  assert.equal(compared.files[0].id, 1);
  assert.equal(compared.files[0].a, true);
  await service.open({ path: replacement });
  await service.open({ path: existing, folder: true });
  assert.deepEqual(openCalls, [replacement, path.dirname(existing)]);

  const plan = await service.prepare({ action: "replace", path: replacement, oldId: 1, tags: { a: true } });
  assert.equal(plan.target, existing);
  assert.equal(JSON.parse(db.prepare("SELECT plan_json FROM media_intake_jobs WHERE id=?").get(plan.id).plan_json).markFavorite, undefined);
  assert.equal(bytes(existing), "fixture library old 1080p");
  db.exec("CREATE TRIGGER fixture_refusal BEFORE UPDATE ON local_files BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END");
  service.run(plan.id);
  assert.equal((await settle(plan)).state, "blocked");
  assert.equal(bytes(existing), "fixture library old 1080p");
  assert(fs.existsSync(replacement)); assert(fs.existsSync(subtitle));
  db.exec("DROP TRIGGER fixture_refusal");
  service.run(plan.id);
  assert.equal((await settle(plan)).state, "completed");
  assert.equal(bytes(existing), "fixture incoming 1080p");
  assert(!fs.existsSync(replacement)); assert(!fs.existsSync(subtitle));
  assert.equal(db.prepare("SELECT file_id FROM local_files WHERE id=1").get().file_id, "video-1");
  assert.equal(service.run(plan.id).state, "completed");

  const outsideFile = write(path.join(outside, "深层目录", "ABC-991", "ABC-991 (1)-LTX.mp4"), "outside video");
  const outsideSide = write(path.join(path.dirname(outsideFile), "ABC-991 (1)-LTX.zh.srt"), "outside subtitle");
  const outsideNote = write(path.join(path.dirname(outsideFile), "notes.txt"), "keep this directory");
  oldVideo(10, "ABC-991", "", "fixture library 1080p");
  assert.equal((await service.scan({ files: [descriptor(outsideFile)] })).items[0].path, outsideFile);
  assert.equal((await service.scan({ path: path.dirname(outsideFile) })).items[0].path, outsideFile);
  assert.equal((await service.scan({ path: outsideFile })).items[0].package, null);
  await service.open({ path: outsideFile });
  assert.equal(openCalls.at(-1), outsideFile);
  const duplicate = source(path.basename(outsideFile), bytes(outsideFile));
  const outsideStat = fs.statSync(outsideFile);
  fs.utimesSync(duplicate, outsideStat.atime, outsideStat.mtime);
  const ambiguousOutside = await service.scan({ files: [descriptor(outsideFile)] });
  assert.deepEqual(ambiguousOutside.items, []);
  assert.deepEqual(new Set(ambiguousOutside.unmatched[0].candidates), new Set([duplicate, outsideFile]));
  assert.equal((await service.scan({ files: [descriptor(outsideFile, `ABC-991/${path.basename(outsideFile)}`)] })).items[0].path, outsideFile);
  assert.deepEqual((await service.scan({ files: [descriptor(existing)] })).items, []);
  await assert.rejects(service.compare({ path: existing }), /馆藏/);
  const junction = path.join(outside, "library-link");
  fs.symlinkSync(library, junction, process.platform === "win32" ? "junction" : "dir");
  try {
    await assert.rejects(service.prepare({ action: "discard", path: path.join(junction, path.relative(library, existing)) }), /链接/);
  } finally { fs.unlinkSync(junction); }
  const outsidePlan = await service.prepare({ action: "keep", path: outsideFile, oldId: 10, tags: { u: true } });
  service.run(outsidePlan.id);
  assert.equal((await settle(outsidePlan)).state, "completed");
  assert.equal(bytes(outsidePlan.target), "outside video");
  assert.equal(bytes(outsidePlan.target.replace(/\.mp4$/, ".zh.srt")), "outside subtitle");
  assert(!fs.existsSync(outsideFile) && !fs.existsSync(outsideSide));
  assert(fs.existsSync(outsideNote) && fs.existsSync(duplicate));

  const video4k = oldVideo(20, "ABC-456", "-4K", "fixture library 2160p");
  const higher = source("ABC-456-LTX.mp4", "fixture incoming 2160p");
  const keep = await service.prepare({ action: "keep", path: higher, oldId: 20, tags: { c: true } });
  assert.match(keep.target, /-LTXC-4K\.mp4$/);
  service.run(keep.id);
  assert.equal((await settle(keep)).state, "completed");
  assert(fs.existsSync(video4k)); assert(fs.existsSync(keep.target));

  const markedOld = oldVideo(24, "ABC-458", "-LTX-4K", "fixture library 2160p");
  const markedSubtitle = write(markedOld.replace(/\.mp4$/, ".zh.srt"), "fixture library subtitle");
  db.prepare(`INSERT INTO local_files(id,work_id,local_work_id,file_id,file_type,file_path,name) VALUES(25,24,24,'subtitle-24','info',?,?)`)
    .run(markedSubtitle, path.basename(markedSubtitle));
  const marked = await service.prepare({ action: "mark", code: "ABC-458", oldId: 24,
    oldSignature: signature(fs.statSync(markedOld)), tags: { u: true, c: true } });
  assert.match(marked.target, /-LTXC-U-4K\.mp4$/);
  assert.match(marked.items[1].target, /-LTXC-U-4K\.zh\.srt$/);
  db.exec("CREATE TRIGGER fixture_marker_failure BEFORE UPDATE ON local_files WHEN old.id=25 BEGIN SELECT RAISE(ABORT,'fixture marker failure'); END");
  service.run(marked.id);
  assert.equal((await settle(marked)).state, "blocked");
  assert(fs.existsSync(markedOld) && fs.existsSync(markedSubtitle));
  assert(!fs.existsSync(marked.target) && !fs.existsSync(marked.items[1].target));
  assert.equal(db.prepare("SELECT file_path FROM local_files WHERE id=24").get().file_path, markedOld);
  db.exec("DROP TRIGGER fixture_marker_failure");
  service.run(marked.id);
  assert.equal((await settle(marked)).state, "completed");
  assert(!fs.existsSync(markedOld) && !fs.existsSync(markedSubtitle));
  assert.equal(bytes(marked.target), "fixture library 2160p");
  assert.equal(bytes(marked.items[1].target), "fixture library subtitle");
  assert.deepEqual(db.prepare("SELECT file_id,file_path FROM local_files WHERE local_work_id=24 ORDER BY id").all().map((r) => [r.file_id, r.file_path]),
    [["video-24", marked.target], ["subtitle-24", marked.items[1].target]]);

  const newWork = source("ABC-789.mkv");
  await assert.rejects(service.prepare({ action: "new", path: newWork }), /115Chrome/);
  const meta = await service.metadata({ path: newWork });
  assert.equal(meta.metadata.actors[0], "Fixture Person");
  await assert.rejects(service.metadata({ path: newWork, detailUrl: "https://javdb.com.example.invalid/v/Fixture" }), /请粘贴 JavDB/);
  await assert.rejects(service.metadata({ path: newWork, detailUrl: "https://javdb.com/v/WrongFixture" }), /番号与 ABC-789 不一致/);
  await assert.rejects(service.metadata({ path: newWork, detailUrl: "https://javdb.com/v/GatewayFixture" }), /详情页返回 HTTP 502/);
  const imported = await service.prepare({ action: "new", path: newWork, tags: { a: true, ltx: false, u: true, c: true } });
  assert.match(imported.target, /\[A\]\..+-UC\.mkv$/);
  service.run(imported.id);
  assert.equal((await settle(imported)).state, "completed");
  assert.match(bytes(path.join(path.dirname(imported.target), "info.txt")), /actor_names: Fixture Person/);
  assert.equal(db.prepare("SELECT release_date FROM works WHERE code='ABC-789'").get().release_date, "2025-03-01");
  assert(indexReads >= 3);

  const localFallback = source("ABC-937.mp4");
  const fallbackResult = await service.metadata({ path: localFallback });
  assert.equal(fallbackResult.metadata.source, "LTX 本地目录");
  assert.equal(fallbackResult.metadata.title, "LTX fixture title");
  assert.equal(fallbackResult.actors[0].folder, actor);
  await assert.rejects(service.metadata({ path: localFallback, detailUrl: "https://javdb.com/v/Fixture937" }), /详情页需要 JavDB 登录/);
  await assert.rejects(service.metadata({ path: source("ABC-938.mp4") }), /跳到了登录页/);
  const fallbackPlan = await service.prepare({ action: "new", path: localFallback });
  assert.match(fallbackPlan.target, /ABC-937 LTX fixture title-LTX\.mp4$/);
  service.cancel(fallbackPlan.id);

  const cross = source("ABC-991 系统文件传输 [fixture]'s.mp4");
  const item = { source: cross, temp: path.join(library, ".copy-fixture.part"), sourceSignature: signature(fs.statSync(cross)) };
  const nativeLink = fsp.link;
  const nativeLstat = fs.lstatSync;
  const crossSize = fs.statSync(cross).size;
  fsp.link = async () => { throw Object.assign(new Error("fixture EXDEV"), { code: "EXDEV" }); };
  // Damage the staged copy after the transfer finishes and before verification reads it from disk.
  let copied = false, damaged = false;
  fs.lstatSync = (file, options) => {
    if (copied && !damaged && file === item.temp) { damaged = true; fs.writeFileSync(file, Buffer.alloc(crossSize)); }
    return nativeLstat(file, options);
  };
  try {
    await assert.rejects(stageIntakeFile(item, () => {}, (phase) => { if (phase === "copy") copied = true; }), /内容不一致/);
  } finally {
    fsp.link = nativeLink;
    fs.lstatSync = nativeLstat;
  }
  assert(damaged);
  assert.equal(item.staged, undefined);
  assert.equal(fs.statSync(item.temp).size, crossSize);
  assert.equal(bytes(cross), "fixture incoming 1080p");
  const tempIdentity = item.tempIdentity;
  const moved = { copy: 0, verify: 0 };
  await stageIntakeFile(item, () => {}, (phase, size) => { moved[phase] += size; }, async (file, report) => {
    fs.writeFileSync(file.temp, "incomplete");
    report(10);
    throw Object.assign(new Error("fixture Windows copy crash"), { code: 3221225477 });
  });
  assert.equal(bytes(item.temp), bytes(cross));
  assert.deepEqual(item.staged.slice(0, 2), tempIdentity);
  assert.deepEqual(moved, { copy: crossSize, verify: crossSize });

  // A volume holds its own lane while another volume, a discard and a rename can run.
  let release;
  const heldLink = async () => {
    await new Promise((resolve) => { release = resolve; });
    throw Object.assign(new Error("fixture EXDEV"), { code: "EXDEV" });
  };
  const firstOld = oldVideo(30, "ABC-921", "-LTX", "fixture library old 1080p");
  oldVideo(31, "ABC-922", "-LTX", "fixture library old 1080p");
  oldVideo(33, "ABC-925", "-LTX", "fixture library old 1080p", path.join(archive, "Fixture Archive Person"));
  const firstSource = source("ABC-921.mp4"), secondSource = source("ABC-922.mp4");
  const archiveSource = source("ABC-925.mp4", "fixture incoming archive 1080p");
  const firstJob = await service.prepare({ action: "replace", path: firstSource, oldId: 30 });
  const secondJob = await service.prepare({ action: "replace", path: secondSource, oldId: 31 });
  const archiveJob = await service.prepare({ action: "replace", path: archiveSource, oldId: 33 });
  const conflictingDiscard = await service.prepare({ action: "discard", path: firstSource });
  const immediateOld = oldVideo(36, "ABC-928", "", "fixture library 1080p");
  const legacyOld = oldVideo(37, "ABC-929", "", "fixture library 1080p");
  const immediateMark = await service.prepare({ action: "mark", code: "ABC-928", oldId: 36,
    oldSignature: signature(fs.statSync(immediateOld)), tags: { c: true } });
  const legacyMark = await service.prepare({ action: "mark", code: "ABC-929", oldId: 37,
    oldSignature: signature(fs.statSync(legacyOld)), tags: { u: true } });
  const held = new Map();
  fsp.link = async (sourcePath, targetPath) => {
    await new Promise((resolve) => { held.set(sourcePath, resolve); });
    await nativeLink(sourcePath, targetPath);
  };
  try {
    service.run(firstJob.id);
    while (!held.has(firstSource)) await delay(5);
    // Distinct NTFS IDs can round to the same Number above 2^53. Exercise
    // only the admission check with that representation, while the second
    // job cannot start. The file transfers below use native identities.
    const preciseInodes = new Map([[firstSource, 2n ** 54n], [secondSource, 2n ** 54n + 1n]]);
    const savedSignatures = db.prepare("SELECT id,plan_json FROM media_intake_jobs WHERE id IN (?,?)")
      .all(firstJob.id, secondJob.id).map(({ id, plan_json }) => ({ id, signature: JSON.parse(plan_json).sourceSignature }));
    const saveSignature = db.prepare("UPDATE media_intake_jobs SET plan_json=json_set(plan_json,'$.sourceSignature',json(?)) WHERE id=?");
    const roundedInode = Number(preciseInodes.get(firstSource));
    assert.equal(roundedInode, Number(preciseInodes.get(secondSource)));
    let sameExactIdentity = true;
    try {
      for (const { id, signature } of savedSignatures) saveSignature.run(JSON.stringify([signature[0], roundedInode, ...signature.slice(2)]), id);
      fs.lstatSync = (file, options) => {
        const stat = nativeLstat(file, options);
        const inode = preciseInodes.get(file);
        if (stat && inode !== undefined) stat.ino = options?.bigint ? (sameExactIdentity ? preciseInodes.get(firstSource) : inode) : roundedInode;
        return stat;
      };
      assert.throws(() => service.run(secondJob.id), { statusCode: 409, message: "这个视频已在执行队列中" });
      assert.equal(db.prepare("SELECT 1 FROM media_intake_queue WHERE job_id=?").get(secondJob.id), undefined);
      sameExactIdentity = false;
      assert.equal(service.run(secondJob.id).state, "queued", "different exact inodes must not conflict when their Number IDs round together");
    } finally {
      fs.lstatSync = nativeLstat;
      for (const { id, signature } of savedSignatures) saveSignature.run(JSON.stringify(signature), id);
    }
    assert.equal(service.run(archiveJob.id).state, "working");
    while (!held.has(firstSource) || !held.has(archiveSource)) await delay(5);
    assert.equal(service.detail(secondJob.id).position, 1);
    assert.equal(service.detail(firstJob.id).progress.total, fs.statSync(firstSource).size);
    assert.equal(service.detail(archiveJob.id).progress.total, fs.statSync(archiveSource).size);
    assert.equal(service.detail(firstJob.id).targetVolume, library);
    assert.equal(service.detail(archiveJob.id).targetVolume, archive);
    assert(fs.existsSync(firstSource) && fs.existsSync(firstOld));
    const sameCode = source("ABC-921-copy.mp4");
    await assert.rejects(service.prepare({ action: "replace", path: sameCode, code: "ABC-921", oldId: 30 }), /执行队列/);
    await assert.rejects(service.prepare({ action: "mark", code: "ABC-921", oldId: 30,
      oldSignature: signature(fs.statSync(firstOld)), tags: { c: true } }), /执行队列/);
    assert.throws(() => service.cancel(firstJob.id), /不能取消/);
    assert.throws(() => service.run(conflictingDiscard.id), /执行队列/);
    assert.equal(service.cancel(conflictingDiscard.id).cancelled, true);
    const extra = source("ABC-923.mp4");
    const extraJob = await service.prepare({ action: "discard", path: extra });
    assert.equal(service.run(extraJob.id).position, 0);
    assert.equal((await settle(extraJob)).state, "completed");
    assert(!fs.existsSync(extra));
    assert.equal(service.run(immediateMark.id).position, 0);
    while (!held.has(immediateOld)) await delay(5);
    held.get(immediateOld)();
    assert.equal((await settle(immediateMark)).state, "completed");
    assert.equal(bytes(immediateMark.target), "fixture library 1080p");
    db.prepare(`UPDATE media_intake_jobs SET plan_json=json_set(plan_json,'$.disk',json('{"key":"main"}')) WHERE id=?`).run(legacyMark.id);
    db.prepare("INSERT INTO media_intake_queue(job_id) VALUES (?)").run(legacyMark.id);
    service.start();
    assert.equal(service.detail(legacyMark.id).position, 0);
    while (!held.has(legacyOld)) await delay(5);
    held.get(legacyOld)();
    assert.equal((await settle(legacyMark)).state, "completed");
    assert.equal(bytes(legacyMark.target), "fixture library 1080p");
    assert.equal(service.detail(secondJob.id).state, "queued");
    held.get(archiveSource)();
    assert.equal((await settle(archiveJob)).state, "completed");
    assert(!held.has(secondSource));
    held.get(firstSource)();
    while (!held.has(secondSource)) await delay(5);
    held.get(secondSource)();
    assert.equal((await settle(firstJob)).state, "completed");
    assert.equal((await settle(secondJob)).state, "completed");
    assert.equal(service.detail(firstJob.id).progress, null);
    assert.equal(bytes(firstOld), "fixture incoming 1080p");
    assert(!fs.existsSync(firstSource) && !fs.existsSync(secondSource));
  } finally { fsp.link = nativeLink; for (const resume of held.values()) resume(); }

  // A separate SQLite connection can acquire the write lock after the files
  // have been published and the index refresh begins. The receipt and owner
  // release must survive that lock without executing the file operation again.
  const receiptLocker = new DatabaseSync(path.join(root, "fixture.sqlite"));
  const { timeout: fixtureBusyTimeout } = db.prepare("PRAGMA busy_timeout").get();
  db.exec("PRAGMA busy_timeout=5000");
  let receiptRefreshes = 0, lockedAt = 0;
  const receiptService = createMediaIntakeService({ ...serviceOptions, onIndexChanged() {
    if (++receiptRefreshes === 1) {
      receiptLocker.exec("BEGIN IMMEDIATE");
      lockedAt = performance.now();
    }
  } });
  try {
    const first = oldVideo(38, "TST-930", "-LTX", "original 1080p");
    const second = oldVideo(39, "TST-940", "-LTX", "original 1080p");
    const input = source("TST-930.mp4", "replacement one 1080p");
    const follower = source("TST-940.mp4", "replacement two 1080p");
    const job = await receiptService.prepare({ action: "replace", path: input, oldId: 38 });
    const next = await receiptService.prepare({ action: "replace", path: follower, oldId: 39 });
    receiptService.run(job.id);
    assert.equal(receiptService.run(next.id).state, "queued");
    for (let i = 0; i < 160 && !lockedAt; i++) await delay(20);
    assert(lockedAt, "the second connection must hold the real write lock during terminal receipt publication");
    assert(performance.now() - lockedAt < 2000, "the retry must yield to the event loop before the configured 5-second timeout");
    assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000, "the receipt retry must restore the shared connection timeout");
    assert.equal(receiptService.detail(job.id).state, "committed");
    assert.equal(receiptService.detail(next.id).state, "queued");
    assert.equal(bytes(first), "replacement one 1080p");
    assert(!fs.existsSync(input));
    receiptLocker.exec("COMMIT");
    lockedAt = 0;
    assert.equal((await settle(job)).state, "completed");
    assert.equal((await settle(next)).state, "completed");
    assert.equal(bytes(second), "replacement two 1080p");
    assert.equal(receiptRefreshes, 2, "retrying the journal write must not repeat either index refresh");
    assert.deepEqual(db.prepare("SELECT owner FROM media_intake_jobs WHERE id IN (?,?)").all(job.id, next.id).map(({ owner }) => owner), ["", ""]);
  } finally {
    if (lockedAt) receiptLocker.exec("ROLLBACK");
    await receiptService.close();
    receiptLocker.close();
    db.exec(`PRAGMA busy_timeout=${fixtureBusyTimeout}`);
  }

  // A stopped instance leaves confirmed, unclaimed jobs for startup to resume.
  const priorService = createMediaIntakeService(serviceOptions);
  oldVideo(34, "ABC-926", "-LTX", "fixture library old 1080p");
  oldVideo(35, "ABC-927", "-LTX", "fixture library old 1080p");
  const inFlight = await priorService.prepare({ action: "replace", path: source("ABC-926.mp4"), oldId: 34 });
  const afterRestart = await priorService.prepare({ action: "replace", path: source("ABC-927.mp4"), oldId: 35 });
  release = null;
  fsp.link = heldLink;
  try {
    priorService.run(inFlight.id);
    while (!release) await delay(5);
    assert.equal(priorService.run(afterRestart.id).state, "queued");
    priorService.beginStop();
    release();
    await priorService.close();
    assert.equal(service.detail(afterRestart.id).state, "queued");
  } finally { fsp.link = nativeLink; release?.(); await priorService.close(); }
  const resumedDb = new DatabaseSync(path.join(root, "fixture.sqlite"));
  const resumedService = createMediaIntakeService({ ...serviceOptions, getDb: () => resumedDb });
  try {
    resumedService.start();
    assert.equal((await settle(afterRestart)).state, "completed");
  } finally { await resumedService.close(); resumedDb.close(); }

  // Abandoning a failed job removes only its own staged files.
  const failedOld = oldVideo(32, "ABC-924", "-LTX", "fixture library old 1080p");
  const failedSource = source("ABC-924.mp4");
  const failedJob = await service.prepare({ action: "replace", path: failedSource, oldId: 32 });
  db.exec("CREATE TRIGGER fixture_refusal BEFORE UPDATE ON local_files BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END");
  service.run(failedJob.id);
  assert.equal((await settle(failedJob)).state, "blocked");
  db.exec("DROP TRIGGER fixture_refusal");
  assert(fs.readdirSync(path.dirname(failedOld)).some((name) => name.startsWith(".fh-")));
  assert.equal(service.cancel(failedJob.id).cancelled, true);
  assert(!fs.readdirSync(path.dirname(failedOld)).some((name) => name.startsWith(".fh-")));
  assert.equal(bytes(failedOld), "fixture library old 1080p");
  assert.equal(fs.statSync(failedSource).nlink, 1);

  const pending = source("ABC-912.mp4");
  source("ABC-912.mp4.115chrome_123.cfg", "partial");
  await assert.rejects(service.prepare({ action: "discard", path: pending }), /未完成下载/);
  const drift = source("ABC-913.mp4");
  const stale = await service.prepare({ action: "discard", path: drift });
  fs.appendFileSync(drift, "changed"); service.run(stale.id);
  assert.equal((await settle(stale)).state, "blocked"); assert(fs.existsSync(drift));
  await assert.rejects(service.prepare({ action: "discard", path: video4k }), /根目录|馆藏/);
  service.cancel(stale.id);

  const firstAd = "社 區 最 新 情 報.mp4";
  const secondAd = "台湾uu美少女直播 20年信誉保证服务全球.mp4";
  const priorPackageVideo = oldVideo(46, "ABC-940", "", "fixture library old 1080p");
  const packageOld = priorPackageVideo.replace(/\.mp4$/, ".wmv");
  fs.renameSync(priorPackageVideo, packageOld);
  db.prepare("UPDATE local_files SET file_path=?,name=? WHERE id=46").run(packageOld, path.basename(packageOld));
  const librarySrt = write(`${packageOld}_1587573784.srt`, "fixture old library subtitles");
  db.prepare("INSERT INTO local_files(id,work_id,local_work_id,file_id,file_type,file_path,name) VALUES(44,46,46,'old-srt-46','info',?,?)")
    .run(librarySrt, path.basename(librarySrt));
  const packaged = source("ABC-940-LTX/489155.com@ABC-940-LTX.mp4");
  const packageDir = path.dirname(packaged);
  source(`ABC-940-LTX/${firstAd}`);
  source(`ABC-940-LTX/${secondAd}`);
  const downloadedSubtitle = source("ABC-940-LTX/489155.com@ABC-940-LTX.zh.srt", "download subtitle");
  const packageScan = await service.scan({ path: packageDir });
  assert.equal(packageScan.items.length, 1);
  assert.equal(packageScan.items[0].path, packaged);
  assert.deepEqual(new Set(packageScan.items[0].package.ads), new Set([firstAd, secondAd]));
  const singleScan = await service.scan({ path: packaged });
  assert.deepEqual(singleScan.items[0].package, packageScan.items[0].package);
  const packagedStat = fs.statSync(packaged);
  const filePickerScan = await service.scan({ files: [{ name: path.basename(packaged), size: packagedStat.size, modified: Math.floor(packagedStat.mtimeMs) }] });
  assert.deepEqual(filePickerScan.items[0].package, packageScan.items[0].package);
  assert.deepEqual((await service.compare({ path: packaged })).package, packageScan.items[0].package);
  await assert.rejects(service.prepare({ action: "discard", path: packaged }), /确认整个文件夹/);
  await assert.rejects(service.prepare({ action: "replace", path: packaged, oldId: 46 }), /确认整个文件夹/);
  const packageComparison = await service.compare({ path: packaged, packageFolder: packageDir });
  const packageInput = { action: "replace", path: packaged, packageFolder: packageDir,
    packageFingerprint: packageComparison.package.fingerprint, oldId: 46 };
  const packagePlan = await service.prepare(packageInput);
  assert.equal(packagePlan.items.length, 3);
  assert.equal(packagePlan.package.subtitles.length, 1);
  assert.match(packagePlan.items[1].target, /-LTX\.zh\.srt$/);
  assert(!packagePlan.items[1].retainedSubtitle);
  assert(packagePlan.items[2].retainedSubtitle);
  assert.match(packagePlan.items[2].target, /-LTX\.srt$/);
  assert.equal(fs.readdirSync(packageDir).length, 4);
  const extra = source("ABC-940-LTX/new.txt", "arrived after confirmation");
  fs.writeFileSync(downloadedSubtitle, "updated download subtitle");
  service.run(packagePlan.id);
  assert.equal((await settle(packagePlan)).state, "blocked");
  assert.equal(fs.readdirSync(packageDir).length, 5);
  assert.equal(bytes(packageOld), "fixture library old 1080p");
  service.cancel(packagePlan.id);
  await assert.rejects(service.prepare(packageInput), /下载包内容已改变/);
  const approvedPackage = await service.compare({ path: packaged, packageFolder: packageDir });
  fs.unlinkSync(extra);
  const currentPackage = await service.prepare({ ...packageInput, packageFingerprint: approvedPackage.package.fingerprint,
    packageMediaFingerprint: approvedPackage.package.mediaFingerprint });
  fs.unlinkSync(path.join(packageDir, firstAd));
  const unreviewed = source("ABC-940-LTX/unreviewed.txt", "new file after approval");
  db.exec("CREATE TRIGGER package_refusal BEFORE UPDATE ON local_files BEGIN SELECT RAISE(ABORT,'fixture package commit failure'); END");
  service.run(currentPackage.id);
  assert.equal((await settle(currentPackage)).state, "blocked");
  assert.equal(fs.readdirSync(packageDir).length, 4);
  assert.equal(bytes(librarySrt), "fixture old library subtitles");
  db.exec("DROP TRIGGER package_refusal");
  service.run(currentPackage.id);
  assert.equal((await settle(currentPackage)).state, "completed");
  assert.deepEqual(fs.readdirSync(packageDir), [path.basename(unreviewed)]);
  assert.equal(bytes(unreviewed), "new file after approval");
  assert.equal(service.detail(currentPackage.id).result.sourceFolderRemaining, packageDir);
  assert.deepEqual(fs.readdirSync(path.dirname(packageOld)).sort(), currentPackage.items.map((item) => path.basename(item.target)).sort());
  assert.equal(bytes(currentPackage.items[1].target), "updated download subtitle");
  assert.equal(bytes(currentPackage.items[2].target), "fixture old library subtitles");
  assert.deepEqual({ ...db.prepare("SELECT file_id,file_path FROM local_files WHERE id=44").get() },
    { file_id: "old-srt-46", file_path: currentPackage.items[2].target });
  assert.equal(db.prepare("SELECT file_id FROM local_files WHERE id=46").get().file_id, "video-46");

  const promoMain = source("ABC-980-LTX/489155.com@ABC-980-LTX.mp4");
  const promoFolder = path.dirname(promoMain);
  const promos = [
    "18禁游戏22HY.CC热门推荐.mp4",
    "2048/澳门银河赌场-注册免费送36元.mp4",
    "2048/美女荷官竟然被....vip1196.mp4",
    "2048/哥哥快来大饱眼福uuf39.com.mp4",
    "2048/美女直播.mp4",
    "宣傳文件/594.wmv",
  ];
  for (const promo of promos) source("ABC-980-LTX/" + promo);
  const promoScan = await service.scan({ path: promoFolder });
  assert.deepEqual(promoScan.items.map(({ path }) => path), [promoMain]);
  assert.deepEqual(new Set(promoScan.items[0].package.ads), new Set(promos.map((promo) => path.basename(promo))));
  const stalePromoPath = path.join(promoFolder, promos[3]);
  await assert.rejects(service.compare({ path: stalePromoPath }), /下载包中的广告/);
  await assert.rejects(service.prepare({ action: "replace", path: stalePromoPath, code: "ABC-980" }), /下载包中的广告/);
  const separateWork = source("ABC-980-LTX/489155.com@ABC-981 妹妹直播.mp4");
  const mixedScan = await service.scan({ path: promoFolder });
  assert.deepEqual(new Set(mixedScan.items.map(({ path }) => path)), new Set([promoMain, separateWork]));
  assert(mixedScan.items.every(({ package: bundle }) => !bundle));

  const firstPart = source("ABC-941/ABC-941-1.mp4", "fixture incoming part one 1080p");
  const secondPart = source("ABC-941/ABC-941-2.mp4", "fixture incoming part two 2160p");
  source(`ABC-941/${firstAd}`);
  source("ABC-941/ABC-941-2.chs.ass", "part two subtitle");
  source("ABC-941/subs/简体中文.srt", "loose package subtitle");
  const partDir = path.dirname(firstPart);
  const partCompare = await service.compare({ path: firstPart, packageFolder: partDir });
  assert.deepEqual(partCompare.package.videos.map((item) => item.path), [firstPart, secondPart]);
  await service.metadata({ path: firstPart, code: "ABC-941" });
  const multipart = await service.prepare({ action: "new", path: firstPart, packageFolder: partDir, packageFingerprint: partCompare.package.fingerprint });
  assert.match(multipart.items[0].target, /-CD1-LTX\.mp4$/);
  assert.match(multipart.items[1].target, /-CD2-LTX-4K\.mp4$/);
  assert.match(multipart.items[2].target, /-CD2-LTX-4K\.chs\.ass$/);
  assert.match(multipart.items[3].target, /-CD1-LTX\.简体中文\.srt$/);
  service.run(multipart.id);
  assert.equal((await settle(multipart)).state, "completed");
  assert(!fs.existsSync(partDir));
  assert.equal(bytes(multipart.items[1].target), "fixture incoming part two 2160p");
  assert.equal(bytes(multipart.items[2].target), "part two subtitle");
  assert.equal(bytes(multipart.items[3].target), "loose package subtitle");
  assert.deepEqual(db.prepare("SELECT file_path FROM local_files WHERE local_work_id=? AND file_type='video' ORDER BY sort_order")
    .all(service.detail(multipart.id).result.localId).map((entry) => entry.file_path), multipart.items.slice(0, 2).map((entry) => entry.target));

  const selectedPart = oldVideo(80, "ABC-950", "-CD2", "fixture selected library part 1080p");
  const insertSibling = db.prepare(`INSERT INTO local_files(id,work_id,local_work_id,file_id,file_type,file_path,name,size,sort_order)
    VALUES(?,80,80,?,'video',?,?,?,?)`);
  const siblingBefore = write(path.join(path.dirname(selectedPart), "ABC-950 Fixture-CD1.mp4"), "fixture preceding part");
  const siblingAfter = write(path.join(path.dirname(selectedPart), "ABC-950 Fixture-CD10.mp4"), "fixture following part");
  insertSibling.run(81, "video-81", siblingBefore, path.basename(siblingBefore), fs.statSync(siblingBefore).size, 1);
  insertSibling.run(82, "video-82", siblingAfter, path.basename(siblingAfter), fs.statSync(siblingAfter).size, 2);
  const projectedLibrary = createCoreLibraryService({
    chooseCover: () => null, compareNaturalName: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }),
    emptyLibrary: () => ({ availableRoots: [], missingRoots: [], worksById: new Map(), filesById: new Map(),
      people: [], peopleById: new Map(), totals: {} }),
    fileBase: (name) => path.parse(name).name, getCoreDb: () => db, hasCoreDb: () => true, libraryRoots: [],
    normalizeExt: (name) => path.extname(name), normalizePersonSearchValue: String, parseJsonTextArray: () => [], dbBoolOrNull: () => null,
    personRecordFromWorks: (entry) => entry, relativeFromRoot: String, publicRemoteUrl: (url) => url,
    registerFiles: (index, files) => files.forEach((file) => index.filesById.set(file.id, file)),
    sourcePathToAbsolute: (value) => String(value || ""), uniquePersonNames: (values) => values
  });
  const importedWork = projectedLibrary.loadLibrary().worksById.get(String(service.detail(imported.id).result.workId));
  resolveIntakeWork = (id) => projectedLibrary.loadLibrary().worksById.get(String(id));
  const discardWorkId = "190";
  const discardVideo = oldVideo(190, "ABC-987", "-CD1", "fixture video to delete");
  const retainedVideo = write(path.join(path.dirname(discardVideo), "ABC-987 Fixture-CD2.mp4"), "fixture video to keep");
  const retainedSubtitle = write(discardVideo.replace(/\.mp4$/, ".zh-CN.srt"), fixtureChineseSubtitle);
  const fileMtime = (file) => fs.statSync(file).mtime.toISOString();
  db.prepare("UPDATE local_files SET modified_at=? WHERE id=190").run(fileMtime(discardVideo));
  db.prepare(`INSERT INTO local_files(id,work_id,local_work_id,file_id,file_type,file_path,name,size,modified_at,sort_order)
    VALUES(191,190,190,'video-191','video',?,?,?,?,1)`)
    .run(retainedVideo, path.basename(retainedVideo), fs.statSync(retainedVideo).size, fileMtime(retainedVideo));
  const discardRequest = (video) => ({
    action: "discardLibraryVideo", workId: discardWorkId, videoId: video.id,
    path: video.path, size: video.size, modifiedAt: video.modifiedAt
  });
  const [discardEntry, retainedEntry] = resolveIntakeWork(discardWorkId).videos;
  const discardRequestBody = discardRequest(discardEntry);
  await assert.rejects(service.prepare({ ...discardRequestBody, videoId: retainedEntry.id }), /已改变/);
  const rollbackSingleVideo = await service.prepare(discardRequestBody);
  db.exec(`CREATE TEMP TRIGGER fail_single_video_discard BEFORE DELETE ON local_files WHEN OLD.id=190
    BEGIN SELECT RAISE(ABORT, 'fixture single-video discard failure'); END;`);
  service.run(rollbackSingleVideo.id);
  assert.equal((await settle(rollbackSingleVideo)).state, "blocked");
  assert.equal(bytes(discardVideo), "fixture video to delete");
  assert.equal(bytes(retainedVideo), "fixture video to keep");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_files WHERE local_work_id=190").get().count, 2);
  db.exec("DROP TRIGGER fail_single_video_discard");
  service.cancel(rollbackSingleVideo.id);
  const missingVideo = path.join(path.dirname(discardVideo), "ABC-987 Fixture-CD3.mp4");
  const unreadableVideo = path.join(path.dirname(discardVideo), "unavailable", "ABC-987 Fixture-CD4.mp4");
  const addMissingVideo = db.prepare(`INSERT INTO local_files(id,work_id,local_work_id,file_id,file_type,file_path,name,size,modified_at,sort_order)
    VALUES(?,190,190,?,'video',?,?,1024,?,?)`);
  addMissingVideo.run(192, "video-192", missingVideo, path.basename(missingVideo), fileMtime(discardVideo), 2);
  addMissingVideo.run(193, "video-193", unreadableVideo, path.basename(unreadableVideo), fileMtime(discardVideo), 3);
  const staleRequest = (file) => discardRequest(resolveIntakeWork(discardWorkId).videos.find((video) => video.path === file));
  await assert.rejects(service.prepare(staleRequest(unreadableVideo)), /无法读取视频所在目录/);
  assert.equal(db.prepare("SELECT file_path FROM local_files WHERE id=193").get().file_path, unreadableVideo);
  db.prepare("DELETE FROM local_files WHERE id=193").run();
  fs.mkdirSync(missingVideo);
  await assert.rejects(service.prepare(staleRequest(missingVideo)), /已变成链接或其他类型/);
  fs.rmdirSync(missingVideo);
  const reappearingVideo = await service.prepare(staleRequest(missingVideo));
  assert.equal(reappearingVideo.missingSource, true);
  write(missingVideo, "fixture file returned");
  service.run(reappearingVideo.id);
  const blockedCleanup = await settle(reappearingVideo);
  assert.equal(blockedCleanup.state, "blocked");
  assert.match(blockedCleanup.error, /已重新出现/);
  assert.equal(bytes(missingVideo), "fixture file returned");
  assert.equal(db.prepare("SELECT file_path FROM local_files WHERE id=192").get().file_path, missingVideo);
  service.cancel(reappearingVideo.id);
  fs.unlinkSync(missingVideo);
  assert.equal(importedWork.coverId, null);
  assert.equal(importedWork.infoSummary.imageUrl, fixtureCoverUrl,
    "an imported cover must remain available from persisted metadata when the local image is missing");
  const projectedParts = () => projectedLibrary.loadLibrary().worksById.get("80").videos.map(({ id, path: file }) => [id, file]);
  assert.deepEqual(projectedParts(), [["80-1", siblingBefore], ["80-2", selectedPart], ["80-3", siblingAfter]]);
  const renamePart = await service.prepare({ action: "replace", path: source("ABC-950.mp4"), oldId: 80 });
  service.run(renamePart.id);
  assert.equal((await settle(renamePart)).state, "completed");
  assert.deepEqual(projectedParts(), [["80-1", siblingBefore], ["80-2", renamePart.target], ["80-3", siblingAfter]]);
  const replacementPartOne = source("ABC-950/ABC-950-1.mp4", "fixture replacement part one");
  source("ABC-950/ABC-950-2.mp4", "fixture replacement part two");
  const replacementPartDir = path.dirname(replacementPartOne);
  const replacementPartComparison = await service.compare({ path: replacementPartOne, packageFolder: replacementPartDir });
  const replacementInput = { action: "replace", path: replacementPartOne, oldId: 80,
    packageFolder: replacementPartDir, packageFingerprint: replacementPartComparison.package.fingerprint };
  const occupiedTarget = write(path.join(path.dirname(selectedPart), "ABC-950 Fixture-CD2-LTX.mp4"), "fixture occupied target");
  await assert.rejects(service.prepare(replacementInput), /目标文件已存在/);
  assert.equal(bytes(occupiedTarget), "fixture occupied target");
  fs.unlinkSync(occupiedTarget);
  const replacementParts = await service.prepare(replacementInput);
  service.run(replacementParts.id);
  assert.equal((await settle(replacementParts)).state, "completed");
  const [replacementOne, replacementTwo] = replacementParts.items.map((item) => item.target);
  assert.deepEqual(projectedParts(), [["80-1", siblingBefore], ["80-2", replacementOne], ["80-3", replacementTwo], ["80-4", siblingAfter]]);
  assert.equal(db.prepare("SELECT file_id FROM local_files WHERE id=80").get().file_id, "video-80");
  assert.equal(bytes(replacementOne), "fixture replacement part one");
  assert.equal(bytes(replacementTwo), "fixture replacement part two");
  assert.equal(bytes(siblingBefore), "fixture preceding part");
  assert.equal(bytes(siblingAfter), "fixture following part");
  assert(!fs.existsSync(replacementPartDir) && !fs.existsSync(renamePart.target));

  const wmvAlternate = oldVideo(100, "PGD-606", "", "fixture separate edition");
  const wmvFolder = path.dirname(wmvAlternate);
  const wmvVideoCount = db.prepare("SELECT count(*) AS count FROM local_files WHERE local_work_id=100 AND file_type='video'");
  const insertWmv = db.prepare(`INSERT INTO local_files(id,work_id,local_work_id,file_id,file_type,file_path,name,size,sort_order)
    VALUES(?,100,100,?,'video',?,?,?,?)`);
  const wmvParts = [1, 2, 3, 4].map((part) => {
    const file = write(path.join(wmvFolder, `[NoDRM]-pgd00606hhb${part}.wmv`), `fixture WMV part ${part}`);
    insertWmv.run(100 + part, `wmv-${part}`, file, path.basename(file), fs.statSync(file).size, part);
    return file;
  });
  const wmvSubtitle = write(path.join(wmvFolder, "[NoDRM]-pgd00606hhb2.zh.srt"), "fixture part subtitle");
  const mergedSource = source("PGD-606-LTX.mp4");
  const wmvComparison = await service.compare({ path: mergedSource });
  const oldParts = [101, 102, 103, 104].map((id) => ({ id, signature: wmvComparison.files.find((file) => file.id === id).signature }));
  assert.deepEqual(wmvComparison.files.find((file) => file.id === 102).partIds, oldParts.map(({ id }) => id));
  const replaceWmvs = { action: "replace", path: mergedSource, oldId: 102, oldParts };
  await assert.rejects(service.prepare({ ...replaceWmvs, oldParts: oldParts.slice(0, 2) }), /馆藏分段已改变/);
  const wmvRollback = await service.prepare(replaceWmvs);
  assert.deepEqual(wmvRollback.oldPaths, wmvParts);
  db.exec("CREATE TRIGGER fixture_wmv_refusal BEFORE DELETE ON local_files WHEN old.id=104 BEGIN SELECT RAISE(ABORT,'fixture part commit failure'); END");
  service.run(wmvRollback.id);
  assert.equal((await settle(wmvRollback)).state, "blocked");
  assert(wmvParts.every(fs.existsSync) && fs.existsSync(mergedSource));
  assert.equal(wmvVideoCount.get().count, 5);
  assert(!fs.existsSync(wmvRollback.target));
  db.exec("DROP TRIGGER fixture_wmv_refusal");
  service.cancel(wmvRollback.id);

  const indexedFirst = oldVideo(110, "ABC-951", "-CD1-LTX", "first original");
  const indexedSecond = write(path.join(path.dirname(indexedFirst), "ABC-951 Fixture-CD2-LTX.mp4"), "second original");
  db.prepare(`INSERT INTO local_files(id,work_id,local_work_id,file_id,file_type,file_path,name,size,sort_order)
    VALUES(111,110,110,'video-111','video',?,?,?,1)`).run(indexedSecond, path.basename(indexedSecond), fs.statSync(indexedSecond).size);
  const indexedReplacement = source("ABC-951/ABC-951-1.mp4", "first replacement");
  source("ABC-951/ABC-951-2.mp4", "second replacement");
  const indexedComparison = await service.compare({ path: indexedReplacement, packageFolder: path.dirname(indexedReplacement) });
  const indexedPlan = await service.prepare({ action: "replace", path: indexedReplacement, oldId: 110,
    packageFolder: indexedComparison.package.folder, packageFingerprint: indexedComparison.package.fingerprint,
    oldParts: indexedComparison.files.map(({ id, signature }) => ({ id, signature })) });
  assert.deepEqual(indexedPlan.items.map((item) => item.target), [indexedFirst, indexedSecond]);
  db.exec("CREATE TRIGGER fixture_cd_refusal BEFORE DELETE ON local_files WHEN old.id=111 BEGIN SELECT RAISE(ABORT,'fixture CD commit failure'); END");
  service.run(indexedPlan.id);
  assert.equal((await settle(indexedPlan)).state, "blocked");
  assert.deepEqual([bytes(indexedFirst), bytes(indexedSecond)], ["first original", "second original"]);
  db.exec("DROP TRIGGER fixture_cd_refusal");
  service.run(indexedPlan.id);
  assert.equal((await settle(indexedPlan)).state, "completed");
  assert.deepEqual([bytes(indexedFirst), bytes(indexedSecond)], ["first replacement", "second replacement"]);

  const ambiguous = source("ABC-942/ABC-942.mp4");
  const unnumbered = source("ABC-942/活动直播.mp4");
  const genericAd = source(`ABC-942/${firstAd}`);
  const ambiguousScan = await service.scan({ path: path.dirname(ambiguous) });
  assert.deepEqual(new Set(ambiguousScan.items.map((item) => item.path)), new Set([ambiguous, unnumbered]));
  assert(ambiguousScan.items.every((item) => item.package === null));
  assert.deepEqual(ambiguousScan.skippedAds, [genericAd]);
  assert(fs.existsSync(genericAd));

  const discardOld = oldVideo(65, "ABC-946", "", "fixture library old 1080p");
  const discardLibrary = path.dirname(discardOld);
  const extraLibraryVideo = write(path.join(discardLibrary, "ABC-946 other.mp4"), "another version");
  write(path.join(discardLibrary, "art", "cover.jpg"), "fixture cover");
  const otherLibrary = path.join(archive, "Other", "ABC-946");
  const otherVideo = write(path.join(otherLibrary, "ABC-946.mp4"), "separately archived version");
  db.prepare("INSERT INTO local_works(id,work_id,local_path) VALUES(?,?,?)").run(66, 65, otherLibrary);
  db.prepare("INSERT INTO local_files(id,work_id,local_work_id,file_id,file_type,file_path,name,size) VALUES(?,?,?,'archive-946','video',?,?,?)")
    .run(66, 65, 66, otherVideo, path.basename(otherVideo), fs.statSync(otherVideo).size);
  const discardIncoming = source("ABC-946-LTX/ABC-946-LTX.mp4");
  const discardPackageDir = path.dirname(discardIncoming);
  const discardAd = source(`ABC-946-LTX/${firstAd}`);
  const discardCompare = await service.compare({ path: discardIncoming, packageFolder: discardPackageDir });
  const discardInput = { action: "discardBoth", path: discardIncoming, oldId: 65,
    sourceSignature: discardCompare.source.signature, oldSignature: discardCompare.files.find(({ id }) => id === 65).signature,
    packageFolder: discardPackageDir, packageFingerprint: discardCompare.package.fingerprint };
  const discardPair = await service.prepare(discardInput);
  assert.deepEqual(discardPair.libraryRemoval, { folder: discardLibrary, videos: 2, files: 3 });
  assert(fs.existsSync(discardIncoming) && fs.existsSync(discardOld));
  db.exec("CREATE TRIGGER fixture_pair_refusal BEFORE DELETE ON local_works WHEN OLD.id=65 BEGIN SELECT RAISE(ABORT,'fixture delete failure'); END");
  service.run(discardPair.id);
  assert.equal((await settle(discardPair)).state, "blocked");
  assert(fs.existsSync(discardAd) && fs.existsSync(extraLibraryVideo));
  assert(db.prepare("SELECT 1 FROM local_files WHERE id=65").get());
  db.exec("DROP TRIGGER fixture_pair_refusal");
  service.run(discardPair.id);
  assert.equal((await settle(discardPair)).state, "completed");
  assert(!fs.existsSync(discardPackageDir) && !fs.existsSync(discardLibrary));
  assert(fs.existsSync(otherVideo));
  assert(!db.prepare("SELECT 1 FROM local_works WHERE id=65").get());
  assert(db.prepare("SELECT 1 FROM local_works WHERE id=66").get());
  assert(db.prepare("SELECT 1 FROM works WHERE id=65").get());

  const staticFiles = createStaticFileServer({ publicDir: path.resolve("public"),
    mimeTypes: { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" }, normalizeExt: path.extname, notFound });
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    if (await routeFileWorkflows(req, res, url, { intake: service, requestAccess: () => ({ mode: accessMode }), requireLocalAdmin: () => true, readJsonBody, sendJson })) return;
    await staticFiles.serveStatic(req, res, url.pathname);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = `http://127.0.0.1:${server.address().port}`;
  accessMode = "lan";
  assert.equal((await fetch(`${address}/api/fanhao/file-workflows/intake/config`)).status, 403);
  accessMode = "local";
  const executablePath = process.env.FANHAO_CHROME_PATH || ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/chromium"].find(fs.existsSync);
  assert(executablePath, "Chromium is required");
  browser = await chromium.launch({ headless: true, executablePath });
  const batchPage = await browser.newPage();
  const batchFiles = Array.from({ length: 24 }, (_, index) => source(`ABC-${870 + index}.mp4`));
  const batchVideo = source(`${batchCode}-LTX/${batchCode}-LTX.mp4`);
  const batchFolder = path.dirname(batchVideo);
  const batchOld = oldVideo(76, batchCode, "-LTX", "fixture library old 1080p");
  const firstCode = "ABC-870", backgroundSubtitle = Promise.withResolvers(), selectedSubtitle = Promise.withResolvers();
  const subtitleCalls = [], prepareCalls = [];
  await batchPage.route("**/intake/subtitle-download-direct", async (route) => {
    const { code } = route.request().postDataJSON();
    subtitleCalls.push(code);
    if (code === firstCode) {
      await backgroundSubtitle.promise;
      return route.fulfill({ json: { available: false, reason: "no-direct-link" } });
    }
    if (code === batchCode) await selectedSubtitle.promise;
    return route.continue();
  });
  batchPage.on("request", (request) => {
    if (request.url().endsWith("/intake/prepare")) prepareCalls.push(request.postDataJSON());
  });
  const autoRequestFor = (code) => (request) => request.url().endsWith("/intake/subtitle-download-direct") && request.postDataJSON().code === code;
  try {
    await batchPage.goto(`${address}/fanhao/file-workflows/intake`);
    await batchPage.getByText("把视频或文件夹拖到这里").waitFor();
    await Promise.all([
      batchPage.waitForRequest(autoRequestFor(firstCode)),
      batchPage.evaluate((files) => {
        const transfer = new DataTransfer();
        for (const { name, size, modified } of files) transfer.items.add(new File([new Uint8Array(size)], name, { lastModified: modified }));
        document.getElementById("dropArea").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }, [...batchFiles, batchVideo].map((file) => descriptor(file)))
    ]);
    assert.equal(await batchPage.locator("#queue .queue-pick").count(), 25);
    await batchPage.locator("#queue").getByText(path.basename(batchVideo), { exact: true }).click();
    await batchPage.waitForFunction(() => ["replace", "keep", "discard"].every((id) => !document.getElementById(id).disabled));
    const resolution = batchPage.getByRole("row").filter({ hasText: "分辨率" });
    assert.equal(await resolution.getByText("1920×1080", { exact: true }).count(), 2);
    assert.deepEqual(subtitleCalls, [firstCode]);

    await Promise.all([batchPage.waitForRequest(autoRequestFor(batchCode)), batchPage.locator("#replace").click()]);
    assert.match(await batchPage.locator("#actionHint").textContent(), /当前视频的自动字幕/);
    assert.equal(prepareCalls.length, 0, "prepare waits for the selected video's subtitle write");
    const openFile = fsp.open;
    const temporaryOpened = Promise.withResolvers(), finishWrite = Promise.withResolvers();
    fsp.open = async (file, ...options) => {
      const handle = await openFile(file, ...options);
      if (path.dirname(file) === batchFolder && path.basename(file).startsWith(".fanhao-subtitle-")) {
        temporaryOpened.resolve();
        await finishWrite.promise;
      }
      return handle;
    };
    try {
      selectedSubtitle.resolve();
      await Promise.race([temporaryOpened.promise, delay(5000, undefined, { ref: false }).then(() => { throw new Error("Subtitle write did not start"); })]);
      const sourceRequest = { path: batchVideo, phase: "source" };
      const reading = await service.compare(sourceRequest);
      assert.equal(reading.source.probe.width, 1920);
      assert.deepEqual(reading.package.subtitles, []);
      assert.equal(prepareCalls.length, 0);
      const partial = write(path.join(batchFolder, `${batchCode}.mp4.part`), "fixture incomplete download");
      try { await assert.rejects(service.compare(sourceRequest), /还有未完成文件/); }
      finally { fs.unlinkSync(partial); }
    } finally {
      fsp.open = openFile;
      finishWrite.resolve();
    }
    const dialog = batchPage.getByRole("dialog");
    await dialog.getByText("配套文件", { exact: true }).waitFor();
    assert.deepEqual(subtitleCalls, [firstCode, batchCode]);
    const [preparedInput] = prepareCalls;
    const saved = path.join(batchFolder, preparedInput.automaticSubtitle.name);
    assert.equal(bytes(saved), fixtureChineseSubtitle);
    const discardWithSubtitle = await service.prepare({ ...preparedInput, action: "discard" });
    service.cancel(discardWithSubtitle.id);
    const unrelatedSubtitle = write(path.join(batchFolder, "unreviewed.srt"), "fixture added separately");
    try {
      await assert.rejects(service.prepare(preparedInput), /正片或字幕已改变/);
      await assert.rejects(service.prepare({ ...preparedInput, action: "discard" }), /下载包内容已改变/);
    } finally { fs.unlinkSync(unrelatedSubtitle); }

    await dialog.getByRole("button", { name: "确认提交" }).click();
    await batchPage.locator("#notice").filter({ hasText: /替换馆藏视频完成/ }).waitFor();
    assert.deepEqual(subtitleCalls, [firstCode, batchCode], "migration completes while the earlier subtitle request is still pending");
    assert(!fs.existsSync(batchVideo) && !fs.existsSync(saved));
    const indexedSubtitle = db.prepare("SELECT file_path FROM local_files WHERE work_id=76 AND file_type='info'").get();
    assert.equal(path.dirname(indexedSubtitle.file_path), path.dirname(batchOld));
    assert.equal(bytes(indexedSubtitle.file_path), fixtureChineseSubtitle);
    backgroundSubtitle.resolve();
    await batchPage.waitForRequest(autoRequestFor("ABC-893"));
    assert.equal(subtitleCalls.filter((code) => code === batchCode).length, 1);
    console.log("media intake: 25-file drop, independent probing, priority subtitle write and sidecar migration verified");
  } finally {
    backgroundSubtitle.resolve(); selectedSubtitle.resolve();
    await batchPage.close();
  }
  const shots = process.env.FANHAO_INTAKE_SHOTS;
  const desk = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const fits = (target) => target.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth + 1);
  await desk.goto(`${address}/fanhao/file-workflows/intake`);
  await desk.getByText("把视频或文件夹拖到这里").waitFor();
  assert.equal(await desk.locator(".topbar, .hero, h1").count(), 0);
  const dropBox = await desk.locator(".drop-card").boundingBox();
  assert(dropBox.height >= 760 && dropBox.width >= 1240, "drop target should fill the window");
  assert(await fits(desk));
  if (shots) await desk.screenshot({ path: path.join(shots, "drop.png") });
  const deskOld = oldVideo(40, "ABC-931", "-LTX", "fixture library old 1080p");
  oldVideo(41, "ABC-932", "-LTX", "fixture library old 1080p");
  const deskFirst = source("ABC-931.mp4"), deskSecond = source("ABC-932.mp4");
  const sourceGate = Promise.withResolvers(), libraryGate = Promise.withResolvers();
  probeGates.set(deskFirst, sourceGate.promise);
  probeGates.set(deskOld, libraryGate.promise);
  try {
    await desk.locator("#filePicker").setInputFiles([deskFirst, deskSecond]);
    await desk.locator("#workMetadata").getByText("ABC-931 Fixture", { exact: true }).waitFor();
    await desk.locator("#compareTable").getByText("ABC-931 Fixture-LTX.mp4", { exact: true }).waitFor();
    const resolutionRow = desk.getByRole("row").filter({ hasText: "分辨率" });
    assert.equal(await resolutionRow.getByText("读取中…", { exact: true }).count(), 2);
    assert(await desk.getByRole("button", { name: "替换所选馆藏" }).isDisabled());
    sourceGate.resolve();
    await resolutionRow.getByText("1920×1080", { exact: true }).waitFor();
    assert.equal(await resolutionRow.getByText("读取中…", { exact: true }).count(), 1);
    assert(await desk.getByRole("button", { name: "替换所选馆藏" }).isDisabled());
    await desk.locator("#queue").getByText("ABC-932.mp4", { exact: true }).click();
    await desk.locator("#workMetadata").getByText("ABC-932 Fixture", { exact: true }).waitFor();
    libraryGate.resolve();
    await desk.locator("#compareTable").getByText("ABC-932 Fixture-LTX.mp4", { exact: true }).waitFor();
    assert.equal(await desk.locator("#compareTable").getByText("ABC-931 Fixture-LTX.mp4", { exact: true }).count(), 0);
  } finally {
    sourceGate.resolve(); libraryGate.resolve();
    probeGates.clear();
  }
  await desk.locator("#queue").getByText("ABC-931.mp4", { exact: true }).click();
  await desk.locator("#compareTable").getByText("ABC-931.mp4", { exact: true }).waitFor();
  assert(await fits(desk));
  fsp.link = heldLink;
  release = null;
  try {
    await desk.getByRole("button", { name: "替换所选馆藏" }).click();
    await desk.getByRole("button", { name: "确认提交" }).waitFor();
    await desk.keyboard.press("Enter");
    await desk.locator("#compareTable").getByText("ABC-932.mp4", { exact: true }).waitFor();
    await desk.locator(".task progress").first().waitFor();
    assert(fs.existsSync(deskFirst));
    if (shots) await desk.screenshot({ path: path.join(shots, "work.png") });
    await desk.getByRole("button", { name: "替换所选馆藏" }).click();
    await desk.getByRole("button", { name: "确认提交" }).click();
    await desk.locator(".task").filter({ hasText: "第 1 位" }).waitFor();
    await desk.getByRole("heading", { name: library, exact: true }).waitFor();
    assert(await fits(desk));
    if (shots) await desk.screenshot({ path: path.join(shots, "queued.png") });
    while (!release) await delay(5);
    release(); release = null;
    while (!release) await delay(5);
    release();
    await desk.getByText("把视频或文件夹拖到这里").waitFor();
    assert.equal(bytes(deskOld), "fixture incoming 1080p");
    assert(!fs.existsSync(deskFirst) && !fs.existsSync(deskSecond));
  } finally { fsp.link = nativeLink; }
  const desk4k = oldVideo(42, "ABC-933", "-4K", "fixture library 2160p");
  const incoming1080p = source("ABC-933-LTX.mp4");
  await desk.locator("#filePicker").setInputFiles(incoming1080p);
  await desk.getByText("馆藏是 4K 或更高分辨率，推荐两份都保留。", { exact: true }).waitFor();
  assert.equal(await desk.locator("#keep.primary").count(), 1);
  await desk.getByRole("button", { name: "替换所选馆藏" }).click();
  const confirm4k = desk.getByRole("dialog");
  await confirm4k.getByText(/所选馆藏为 4K 或更高分辨率/).waitFor();
  assert(await confirm4k.getByRole("button", { name: "返回核对" }).evaluate((button) => button === document.activeElement));
  assert.equal(bytes(desk4k), "fixture library 2160p");
  await confirm4k.getByRole("button", { name: "确认提交" }).click();
  await desk.locator("#notice").filter({ hasText: /替换馆藏视频完成.*ABC-933/ }).waitFor();
  assert(!fs.existsSync(desk4k));
  const replaced4k = db.prepare("SELECT file_id,file_path FROM local_files WHERE id=42").get();
  assert.equal(replaced4k.file_id, "video-42");
  assert.equal(bytes(replaced4k.file_path), "fixture incoming 1080p");
  const unknownOld = oldVideo(79, "ABC-919", "", "fixture library unreadable metadata");
  const unknownIncoming = source("ABC-919-LTX.mp4");
  await desk.locator("#filePicker").setInputFiles(unknownIncoming);
  await desk.getByText("馆藏参数暂未读取，核对后仍可替换。", { exact: true }).waitFor();
  await desk.getByRole("button", { name: "替换所选馆藏" }).click();
  const confirmUnknown = desk.getByRole("dialog");
  await confirmUnknown.getByText(/旧馆藏参数未能读取/).waitFor();
  assert(await confirmUnknown.getByRole("button", { name: "返回核对" }).evaluate((button) => button === document.activeElement));
  assert(fs.existsSync(unknownOld));
  await confirmUnknown.getByRole("button", { name: "确认提交" }).click();
  await desk.locator("#notice").filter({ hasText: /替换馆藏视频完成.*ABC-919/ }).waitFor();
  const replacedUnknown = db.prepare("SELECT file_id,file_path FROM local_files WHERE id=79").get();
  assert.equal(replacedUnknown.file_id, "video-79");
  assert.equal(bytes(replacedUnknown.file_path), "fixture incoming 1080p");
  assert(!fs.existsSync(unknownOld));

  await desk.locator("#filePicker").setInputFiles(mergedSource);
  await desk.locator("#versions label").nth(2).click();
  await desk.getByRole("button", { name: "替换所选馆藏" }).click();
  const confirmParts = desk.getByRole("dialog");
  await confirmParts.getByText(/一起移除下列 4 段馆藏视频/).waitFor();
  for (const file of wmvParts) await confirmParts.getByText(file, { exact: true }).waitFor();
  assert.equal(await confirmParts.getByText(wmvAlternate, { exact: true }).count(), 0);
  assert(wmvParts.every(fs.existsSync));
  await confirmParts.getByRole("button", { name: "确认提交" }).click();
  await desk.locator("#notice").filter({ hasText: /替换馆藏视频完成.*PGD-606/ }).waitFor();
  assert(wmvParts.every((file) => !fs.existsSync(file)));
  assert.equal(bytes(wmvAlternate), "fixture separate edition");
  assert.equal(bytes(wmvSubtitle), "fixture part subtitle");
  assert.equal(wmvVideoCount.get().count, 2);
  assert.equal(bytes(db.prepare("SELECT file_path FROM local_files WHERE id=101").get().file_path), "fixture incoming 1080p");

  const deskMark = oldVideo(43, "ABC-934", "", "fixture library old 1080p");
  const markIncoming = source("ABC-934-LTX.mp4");
  await desk.locator("#filePicker").setInputFiles(markIncoming);
  await desk.getByRole("button", { name: "修改馆藏标记" }).click();
  const markDialog = desk.getByRole("dialog", { name: "修改馆藏标记" });
  assert(!(await markDialog.getByRole("checkbox", { name: "LTX" }).isChecked()));
  await markDialog.getByRole("checkbox", { name: "U 无码" }).check();
  await markDialog.getByRole("checkbox", { name: "C 中字" }).check();
  await markDialog.getByRole("button", { name: "预览重命名" }).click();
  await desk.getByRole("dialog").getByText(/ABC-934 Fixture-UC\.mp4$/).waitFor();
  assert(fs.existsSync(deskMark) && fs.existsSync(markIncoming));
  await desk.getByRole("button", { name: "确认提交" }).click();
  await desk.locator("#compareTable").getByText("ABC-934 Fixture-UC.mp4", { exact: true }).waitFor();
  assert(!fs.existsSync(deskMark) && fs.existsSync(markIncoming));
  assert(await desk.getByRole("button", { name: "丢弃源视频" }).isEnabled());
  const autoImport = source("ABC-935.mp4");
  await desk.locator("#filePicker").setInputFiles(autoImport);
  await desk.locator("#queue").getByText("ABC-935.mp4", { exact: true }).click();
  await desk.locator("#compareTable").getByText("ABC-935.mp4", { exact: true }).waitFor();
  await desk.locator("#compareTable").getByRole("button", { name: "字幕", exact: true }).click();
  const subtitleDialog = desk.locator("#sourceSubtitles");
  await subtitleDialog.getByRole("button", { name: "一键下载字幕" }).click();
  await subtitleDialog.getByRole("button", { name: "查看中文字幕" }).click();
  await subtitleDialog.getByRole("button", { name: "下载并匹配" }).click();
  const pendingSubtitle = path.join(incoming, "ABC-935.zh-CN.srt");
  await desk.locator("#compareTable").getByText("ABC-935.zh-CN.srt", { exact: true }).waitFor({ state: "attached" });
  assert.equal(bytes(pendingSubtitle), fixtureChineseSubtitle);
  assert(!(await desk.locator("#tagC").isChecked()));
  await subtitleDialog.waitFor({ state: "hidden" });
  await desk.locator("#compareTable").getByRole("button", { name: "移除外挂…", exact: true }).click();
  const removal = desk.waitForResponse((response) => response.url().endsWith("/intake/subtitle-remove") && response.ok());
  await subtitleDialog.getByRole("button", { name: "移除外挂 ABC-935.zh-CN.srt" }).click();
  const { backupPath } = await (await removal).json();
  await subtitleDialog.getByText(/已移除 ABC-935\.zh-CN\.srt/).waitFor();
  assert(!fs.existsSync(pendingSubtitle));
  assert.equal(bytes(backupPath), fixtureChineseSubtitle);
  await desk.locator("#sourceSubtitlePicker").setInputFiles(backupPath);
  await subtitleDialog.waitFor({ state: "hidden" });
  assert.equal(bytes(pendingSubtitle), fixtureChineseSubtitle);
  await desk.getByRole("button", { name: "作为新番号入库" }).click();
  await desk.getByRole("dialog").getByText(/ABC-935 New Work.*-LTX\.mp4$/).waitFor();
  assert(fs.existsSync(autoImport));
  await desk.getByRole("button", { name: "确认提交" }).click();
  await desk.locator("#notice").filter({ hasText: /新番号入库完成.*ABC-935/ }).waitFor();
  assert(!fs.existsSync(autoImport));
  assert(!fs.existsSync(pendingSubtitle));
  const indexedSubtitle = db.prepare(`SELECT f.file_path FROM local_files f JOIN works w ON w.id=f.work_id
    WHERE w.code_search='abc935' AND f.file_type='info' AND f.ext='.srt'`).get();
  assert.equal(path.basename(indexedSubtitle.file_path), "ABC-935 New Work-LTX.zh-CN.srt");
  assert.equal(bytes(indexedSubtitle.file_path), fixtureChineseSubtitle);

  const otherVersion = source(restoredName, "different byte size");
  assert.equal((await service["subtitle-download-direct"]({ path: otherVersion, code: "ABC-943", automatic: true })).reason, "different-version");
  const directIncoming = source(restoredName);
  const directSidecar = path.join(incoming, "ABC-943_restored.zh-CN.srt");
  let subtitleModeComparisons = 0;
  const onCompare = (request) => {
    if (request.url().endsWith("/intake/compare")) subtitleModeComparisons += 1;
  };
  await desk.locator("#reviewMode").getByRole("button", { name: "字幕", exact: true }).click();
  desk.on("request", onCompare);
  await desk.locator("#filePicker").setInputFiles(directIncoming);
  await desk.locator("#queue").getByText(restoredName, { exact: true }).click();
  const subtitlePane = desk.locator("#subtitlePane");
  await subtitlePane.getByText(restoredName, { exact: true }).waitFor();
  assert(await desk.locator("#compareBody").isHidden());
  await subtitlePane.getByText(/已自动保存到视频旁.*ABC-943/).waitFor();
  assert.equal(subtitleModeComparisons, 0);
  desk.off("request", onCompare);
  assert.deepEqual(subtitleRequests, [directSubtitle, directSubtitle]);
  assert.equal(bytes(directSidecar), fixtureChineseSubtitle);
  await desk.locator("#reviewMode").getByRole("button", { name: "洗版", exact: true }).click();
  await desk.locator("#compareTable").getByText("ABC-943_restored.zh-CN.srt", { exact: true }).waitFor();
  assert(await desk.locator(".compare-head").getByRole("button", { name: "丢弃源视频" }).isVisible());
  await desk.getByRole("button", { name: "作为新番号入库" }).click();
  await desk.getByRole("dialog").getByText(/ABC-943 New Work-LTX\.mp4$/).waitFor();
  await desk.getByRole("button", { name: "确认提交" }).click();
  await desk.locator("#notice").filter({ hasText: /新番号入库完成.*ABC-943/ }).waitFor();
  assert(!fs.existsSync(directIncoming) && !fs.existsSync(directSidecar));
  const directIndexed = db.prepare(`SELECT f.file_path FROM local_files f JOIN works w ON w.id=f.work_id
    WHERE w.code_search='abc943' AND f.file_type='info' AND f.ext='.srt'`).get();
  assert.equal(path.basename(directIndexed.file_path), "ABC-943 New Work-LTX.zh-CN.srt");
  assert.equal(bytes(directIndexed.file_path), fixtureChineseSubtitle);

  const wrongIncoming = source("ABC-944.mp4");
  const wrongSubtitle = await fetch(`${address}/api/fanhao/file-workflows/intake/subtitle-download-direct`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: wrongIncoming, code: "ABC-944", url: directSubtitle })
  });
  assert.equal(wrongSubtitle.status, 422);
  assert.match((await wrongSubtitle.json()).error, /番号、分段或版本/);
  assert.deepEqual(subtitleRequests, [directSubtitle, directSubtitle, mismatchedSubtitle]);
  assert(!fs.existsSync(path.join(incoming, "ABC-944.zh-CN.srt")));

  const libraryVideo = directIndexed.file_path.replace(/\.zh-CN\.srt$/, ".mp4");
  const foundLibrary = await service.scan({ files: [descriptor(libraryVideo)], subtitleMode: true });
  assert.deepEqual(foundLibrary.items.map((item) => [item.path, item.library]), [[libraryVideo, true]]);
  assert.deepEqual((await service.scan({ files: [descriptor(libraryVideo)] })).items, []);
  const libraryInput = { path: libraryVideo, code: "ABC-943", subtitleMode: true };
  const before = await service["subtitle-source"](libraryInput);
  assert.deepEqual(before.source.subtitles, [path.basename(directIndexed.file_path)]);
  const removedSubtitle = await service["subtitle-remove"]({ ...libraryInput, name: before.source.subtitles[0] });
  assert.equal(bytes(removedSubtitle.backupPath), fixtureChineseSubtitle);
  assert(!fs.existsSync(directIndexed.file_path));
  const restoredSubtitle = await service["subtitle-download-direct"]({ ...libraryInput, automatic: true });
  assert.equal(bytes(restoredSubtitle.path), fixtureChineseSubtitle);
  assert.equal(db.prepare("SELECT file_type FROM local_files WHERE file_path=?").get(restoredSubtitle.path).file_type, "info");

  const subtitleWindowContext = desk.context();
  const catalogWork = { id: "subtitle-fixture", title: "ABC-943 Fixture", personId: "fixture-person", personName: "Fixture Person", videoCount: 2, localMarkers: ["A"],
    cachedCover: { coverUrl: "/app-icon.svg" }, traits: { flags: { ltx: true, quality4k: true, subtitled: true } } };
  const completedWorks = Array.from({ length: 36 }, (_, index) => ({ id: `completed-${index}`, title: `ABC-943 已完成 ${index}`, personId: "another-person",
    videoCount: 1, traits: { flags: index % 2 ? { hasChineseSidecar: true } : { embeddedChinese: true } } }));
  const vrWorks = [
    { ...catalogWork, id: "vr-path", title: "ABC-943 Path", relativePath: "V:\\Fixture" },
    { ...catalogWork, id: "vr-title", title: "ABC-943 [VR]" },
    { ...catalogWork, id: "vr-tag", title: "ABC-943 Tag", traits: { ...catalogWork.traits, tags: ["VR"] } }
  ];
  const catalogQueries = [];
  const discardCard = { ...catalogWork, id: discardWorkId, title: "ABC-987 Fixture" };
  const sequenceWorks = [
    ...Array.from({ length: 18 }, (_, index) => ({ ...catalogWork, id: `sequence-${index}`, title: `Sequence ${index}`, videoCount: 1 })),
    completedWorks[0],
    { ...catalogWork, id: "sequence-multiple", title: "Sequence Multiple" },
    { ...catalogWork, id: "sequence-final", title: "Sequence Final", videoCount: 1 }
  ];
  let resumeWorks = Array.from({ length: 125 }, (_, index) => ({
    ...catalogWork, id: `resume-${index}`, title: `Resume Fixture ${index}`, videoCount: 1
  }));
  let resumeGate = null;
  let sequencePageAttempts = 0;
  await subtitleWindowContext.route("**/app-icon.svg", (route) => route.fulfill({ path: path.resolve("public/app-icon.svg"), contentType: "image/svg+xml" }));
  await subtitleWindowContext.route("**/api/library", (route) => route.fulfill({ json: { totals: { works: 37 }, people: [
    { id: "fixture-person", name: "Fixture Person", workCount: 37, avatarUrl: "/app-icon.svg", actorProfile: { displayName: "  ", aliases: ["Alias One"] } },
    { id: "another-person", name: "Another Person", workCount: 1 }
  ] } }));
  let personQuery, personReads = 0;
  await subtitleWindowContext.route("**/api/people/fixture-person?*", (route) => {
    personQuery = new URL(route.request().url()).searchParams;
    personReads++;
    const works = [catalogWork, ...vrWorks, discardCard, { ...catalogWork, id: "different-title", title: "Unrelated title" }];
    return route.fulfill({ json: { works, total: works.length } });
  });
  await subtitleWindowContext.route("**/api/works?*", (route) => route.fulfill({ json: { works: [catalogWork], total: 1 } }));
  await subtitleWindowContext.route("**/api/fanhao/search?*", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (Number(query.get("limit")) < 1000) catalogQueries.push(Object.fromEntries(query));
    const offset = Number(query.get("offset")), limit = Number(query.get("limit"));
    const sequence = query.get("q") === "Sequence";
    if (sequence && offset === 18 && limit < 1000 && ++sequencePageAttempts === 1) return route.fulfill({ status: 503 });
    const matches = sequence ? sequenceWorks : query.get("q") === "Resume Fixture" ? resumeWorks : query.get("q")?.endsWith("ABC-987") ? [discardCard] : /ABC-943$/.test(query.get("q"))
      ? (query.get("filter").includes("localMarkedA") ? [catalogWork, ...vrWorks] : [catalogWork, ...completedWorks]) : [];
    if (resumeGate && query.get("q") === "Resume Fixture" && limit === 109) {
      const { release, done } = resumeGate;
      resumeGate = null;
      await release.promise;
      try { await route.fulfill({ json: { works: matches.slice(offset, offset + limit), total: matches.length } }); }
      catch { /* A newer search may have canceled the response. */ }
      finally { done.resolve(); }
      return;
    }
    await route.fulfill({ json: { works: matches.slice(offset, offset + limit), total: matches.length } });
  });
  await subtitleWindowContext.route(/\/api\/works\/sequence-(17|multiple|final)$/, (route) => {
    const id = route.request().url().split("/").at(-1);
    const files = id === "sequence-multiple" ? [firstOld, libraryVideo] : [id === "sequence-final" ? retainedVideo : libraryVideo];
    return route.fulfill({ json: { work: { videos: files.map((file, index) => ({ id: `part-${index + 1}`,
      name: path.basename(file), sourcePath: file })) } } });
  });
  await subtitleWindowContext.route(/\/api\/works\/resume-(108|109|110)$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const file = { "resume-108": firstOld, "resume-109": libraryVideo, "resume-110": retainedVideo }[id];
    return route.fulfill({ json: { work: { id, videos: [{ id: "part-1", name: path.basename(file), sourcePath: file }] } } });
  });
  await subtitleWindowContext.route("**/api/works/subtitle-fixture", (route) => route.fulfill({ json: { work: { videos: [
    { id: "part-1", name: path.basename(firstOld), sourcePath: firstOld }, { id: "part-2", name: path.basename(libraryVideo), sourcePath: libraryVideo }
  ] } } }));
  await subtitleWindowContext.route(`**/api/works/${discardWorkId}`, (route) => route.fulfill({ json: { work: {
    videos: resolveIntakeWork(discardWorkId).videos.map((video) => ({ ...video, sourcePath: video.path }))
  } } }));
  await subtitleWindowContext.route("**/player.html?*", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Fixture preview</title>" }));
  await subtitleWindowContext.route("**/intake/subtitle-download-direct", (route) => route.fulfill({ json: { name: path.basename(restoredSubtitle.path) } }));
  const [subtitleWindow] = await Promise.all([
    desk.waitForEvent("popup"), desk.getByRole("link", { name: /独立字幕工作台/ }).click()
  ]);
  try {
    const workbenchRequests = [];
    subtitleWindow.on("request", (request) => {
      if (request.method() === "POST") workbenchRequests.push(new URL(request.url()).pathname);
    });
    await subtitleWindow.getByRole("heading", { name: "字幕工作台", exact: true }).waitFor();
    const card = subtitleWindow.locator(".library-search-results .work-card").filter({ hasText: "ABC-943 Fixture" });
    await card.waitFor();
    assert.equal(await card.locator("img").getAttribute("src"), "/app-icon.svg");
    const catalogBounds = await subtitleWindow.locator("#librarySearch").boundingBox();
    const peopleBounds = await subtitleWindow.locator("#libraryPeople").boundingBox();
    const cardBounds = await card.boundingBox();
    assert(peopleBounds.x + peopleBounds.width <= cardBounds.x, "the person filter belongs to the left of the work cards");
    const drawer = subtitleWindow.locator("#reviewPane");
    assert.equal(catalogBounds.width, 1280);
    assert(await drawer.isHidden(), "the gallery should use the full width until a work is selected");
    await subtitleWindow.setViewportSize({ width: 390, height: 750 });
    assert(await subtitleWindow.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert(await subtitleWindow.locator("#reviewMode").isHidden());
    const queryInput = subtitleWindow.getByRole("searchbox", { name: "搜索馆藏番号、标题或人物" });
    await queryInput.fill("missing fixture");
    await queryInput.press("Enter");
    await subtitleWindow.getByRole("status").filter({ hasText: "没有匹配的馆藏视频" }).waitFor();
    await queryInput.fill("ABC-943");
    await queryInput.press("Enter");
    await card.waitFor();
    assert.equal(await card.locator(".cover-marker").filter({ hasText: /^A$/ }).count(), 1);
    await card.evaluate((node) => { window.firstCatalogCard = node; });
    await subtitleWindow.locator("#libraryLoadMore").scrollIntoViewIfNeeded();
    await subtitleWindow.waitForFunction(() => document.querySelectorAll(".library-search-results .work-card").length > 18);
    assert.equal(await card.evaluate((node) => node === window.firstCatalogCard), true, "scroll loading must append without replacing the first card");
    assert.equal(await subtitleWindow.getByRole("button", { name: "下一页", exact: true }).count(), 0);
    await subtitleWindow.getByRole("button", { name: "4K", exact: true }).click();
    await card.waitFor();
    await subtitleWindow.locator("#librarySort").selectOption("updated");
    await card.waitFor();
    assert.deepEqual([catalogQueries.at(-1).q, catalogQueries.at(-1).sort], ["class:4k ABC-943", "updated"]);
    const exclude = subtitleWindow.getByRole("button", { name: "排除中字", exact: true });
    await exclude.click();
    await subtitleWindow.getByRole("status").filter({ hasText: "已显示 1 部" }).waitFor();
    assert.equal(await exclude.getAttribute("aria-pressed"), "true");
    assert.equal(await subtitleWindow.locator(".library-search-results .work-card").count(), 1);
    assert.equal(catalogQueries.at(-1).offset, "36", "subtitle filtering must refill from subsequent source pages");
    await subtitleWindow.locator("#libraryPeopleStatus").filter({ hasText: /^1 人$/ }).waitFor();
    assert.equal(await subtitleWindow.getByRole("button", { name: /Another Person/ }).count(), 0);
    const markedA = subtitleWindow.getByRole("button", { name: "只看 A", exact: true });
    await markedA.click();
    await card.waitFor();
    assert.equal(catalogQueries.at(-1).filter, "localOnly,localMarkedA");
    assert.equal(await subtitleWindow.locator(".library-search-results .work-card").count(), 4);
    const excludeVr = subtitleWindow.getByRole("button", { name: "排除 VR", exact: true });
    await excludeVr.click();
    await subtitleWindow.getByRole("status").filter({ hasText: "已显示 1 部 · 已排除中字、VR" }).waitFor();
    assert.equal(await excludeVr.getAttribute("aria-pressed"), "true");
    await subtitleWindow.getByRole("searchbox", { name: "筛选人物" }).fill("Alias One");
    assert.equal(await subtitleWindow.getByRole("button", { name: /Another Person/ }).count(), 0);
    const person = subtitleWindow.locator(".library-person").filter({ hasText: "Fixture Person" });
    assert.equal(await person.locator(".library-person-name").getAttribute("title"), "Fixture Person");
    assert.equal(await person.locator(".library-person-count").textContent(), "1");
    await person.click();
    await card.waitFor();
    assert.equal(personQuery.get("filter"), "localOnly,localMarkedA,quality4k");
    assert.equal(await subtitleWindow.locator(".library-search-results .work-card").count(), 1);
    await card.click();
    assert.deepEqual(workbenchRequests, [], "search and work expansion must not write files or enqueue intake");
    await subtitleWindow.locator("#libraryFileChoices button").filter({ hasText: path.basename(libraryVideo) }).click();
    await subtitleWindow.locator("#subtitlePane").getByText(path.basename(restoredSubtitle.path), { exact: true }).waitFor();
    assert.deepEqual(workbenchRequests, ["scan", "subtitle-source"].map((route) => `/api/fanhao/file-workflows/intake/${route}`));
    assert.equal(await subtitleWindow.locator("#queueCount").textContent(), "1");
    assert(await subtitleWindow.getByRole("button", { name: "查找中文字幕" }).isVisible());
    assert.equal(await card.getAttribute("aria-pressed"), "true");
    assert.equal(await drawer.evaluate((node) => getComputedStyle(node).position), "fixed");
    assert.equal((await subtitleWindow.locator("#librarySearch").boundingBox()).width, 390);
    await subtitleWindow.getByRole("button", { name: "播放确认", exact: true }).click();
    const preview = subtitleWindow.locator("#subtitlePreview iframe");
    assert.match(await preview.getAttribute("src"), /workId=subtitle-fixture&videoId=part-2&preview=1&t=0$/);
    await subtitleWindow.getByRole("button", { name: "关闭字幕浮窗", exact: true }).click();
    assert(await drawer.isHidden());
    assert.equal(await preview.count(), 0, "closing the drawer must stop the embedded player");
    assert(await card.evaluate((node) => node === document.activeElement), "closing the drawer must restore focus to the selected card");
    await subtitleWindow.getByRole("button", { name: "仅看未核查", exact: true }).click();
    await card.click();
    await subtitleWindow.locator("#libraryFileChoices button").filter({ hasText: path.basename(libraryVideo) }).click();
    const readsBeforeReview = [catalogQueries.length, personReads];
    await subtitleWindow.getByRole("button", { name: "标记已查无中字", exact: true }).click();
    assert(await card.isHidden(), "reviewed works leave the unreviewed filter immediately");
    assert(await person.isHidden(), "reviewing the final matching work hides the person");
    assert.deepEqual([catalogQueries.length, personReads], readsBeforeReview, "marking a review must not re-query the catalog");

    const [checkWindow] = await Promise.all([
      desk.waitForEvent("popup"), desk.getByRole("link", { name: /独立字幕工作台/ }).click()
    ]);
    try {
      const checked = checkWindow.locator(".library-search-results .work-card").filter({ hasText: "ABC-943 Fixture" });
      await checked.locator("[data-review-badge]").getByText("已查无中字", { exact: true }).waitFor();
      await checked.click();
      await checkWindow.locator("#libraryFileChoices button").filter({ hasText: path.basename(libraryVideo) }).click();
      await checkWindow.getByRole("button", { name: "撤销已查无中字", exact: true }).click();
      await checked.locator("[data-review-badge]").waitFor({ state: "detached" });
    } finally { await checkWindow.close(); }
    await card.waitFor({ state: "visible" });
    await person.waitFor({ state: "visible" });
    const readsBeforeSave = [catalogQueries.length, personReads];
    await subtitleWindow.getByRole("button", { name: "一键下载字幕", exact: true }).click();
    await subtitleWindow.locator("#sourceSubtitleStatus").filter({ hasText: "已保存到视频旁" }).waitFor();
    assert(await card.isHidden(), "the saved Chinese subtitle must immediately hide its card");
    assert(await person.isHidden(), "the last completed film must hide its person from the filtered list");
    assert(await drawer.isVisible(), "the drawer stays open for playback confirmation");
    assert.deepEqual([catalogQueries.length, personReads], readsBeforeSave, "saving a subtitle must not restart the catalog or person feed");
    assert.equal(bytes(restoredSubtitle.path), fixtureChineseSubtitle);

    await drawer.getByRole("button", { name: "关闭字幕浮窗", exact: true }).click();
    await queryInput.fill("ABC-987");
    await queryInput.press("Enter");
    const videoCard = subtitleWindow.locator(".work-card").filter({ hasText: "ABC-987 Fixture" });
    await videoCard.click();
    const missingButton = drawer.getByRole("button", { name: `删除此文件：${path.basename(missingVideo)}`, exact: true });
    const deleteConfirmation = subtitleWindow.locator("#confirm");
    await missingButton.click();
    await missingButton.waitFor({ state: "detached" });
    assert(await deleteConfirmation.isHidden());
    await videoCard.getByText(/2 份视频/).waitFor();
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_files WHERE id=192").get().count, 0);
    assert.equal(bytes(discardVideo), "fixture video to delete");
    assert.equal(bytes(retainedVideo), "fixture video to keep");
    assert.equal(bytes(retainedSubtitle), fixtureChineseSubtitle);
    const removeVideo = drawer.getByRole("button", { name: `删除此文件：${path.basename(discardVideo)}`, exact: true });
    await removeVideo.click();
    assert.equal(await deleteConfirmation.locator("#confirmPaths dd").textContent(), discardVideo);
    await deleteConfirmation.locator("#confirmBack").click();
    assert.equal(bytes(discardVideo), "fixture video to delete");
    await removeVideo.click();
    await deleteConfirmation.getByRole("button", { name: "永久删除" }).click();
    await drawer.locator("#libraryFileChoices .queue-pick").filter({ hasText: path.basename(retainedVideo) }).waitFor();
    await removeVideo.waitFor({ state: "detached" });
    await videoCard.getByText(/1 份视频/).waitFor();
    assert.equal(fs.existsSync(discardVideo), false);
    assert.equal(bytes(retainedVideo), "fixture video to keep");
    assert.equal(bytes(retainedSubtitle), fixtureChineseSubtitle);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_files WHERE id=190").get().count, 0);
    assert.equal(resolveIntakeWork(discardWorkId).videos[0].id, retainedEntry.id);
    await assert.rejects(service.prepare(discardRequest(retainedEntry)), /至少保留一份/);

    await subtitleWindow.reload();
    await subtitleWindow.locator("#librarySearchResults .work-card").filter({ hasText: "ABC-987 Fixture" }).waitFor();
    assert.equal(await queryInput.inputValue(), "ABC-987");
    assert.equal(await subtitleWindow.locator("#librarySort").inputValue(), "updated");
    for (const id of ["excludeChineseSubtitles", "excludeLibraryVr", "libraryOnlyMarkedA", "libraryOnlyUnreviewed"]) {
      assert.equal(await subtitleWindow.locator(`#${id}`).getAttribute("aria-pressed"), "true");
    }
    await subtitleWindow.locator("#libraryPeoplePanel > summary").click();
    assert.equal(await person.getAttribute("aria-pressed"), "true");
    await subtitleWindow.getByRole("button", { name: /全部人物/ }).click();
    await subtitleWindow.locator('[data-classification=""]').click();
    await queryInput.fill("Sequence");
    await queryInput.press("Enter");
    const anchor = subtitleWindow.locator('[data-work-id="sequence-17"]');
    await anchor.evaluate((card) => card.click());
    const next = drawer.getByRole("button", { name: "下一部作品", exact: true });
    await drawer.getByRole("button", { name: "播放确认", exact: true }).click();
    assert.equal(sequencePageAttempts, 0, "the later catalog page must still be unloaded");
    await drawer.getByRole("button", { name: "标记无中字并继续", exact: true }).click();
    await drawer.getByText("下一部作品读取失败，请重试。", { exact: true }).waitFor();
    assert(await anchor.isHidden());
    assert(await drawer.locator("#subtitlePreview iframe").isVisible(), "a failed advance keeps the current preview");
    await next.click();
    await drawer.getByRole("heading", { name: "Sequence Multiple", exact: true }).waitFor();
    assert.equal(sequencePageAttempts, 2, "the failed page is retried without restarting the feed");
    assert.equal(await drawer.locator("#subtitlePreview iframe").count(), 0);
    assert.equal(await subtitleWindow.locator('[data-work-id="completed-0"]').count(), 0);
    await next.click();
    await drawer.getByRole("heading", { name: path.basename(retainedVideo), exact: true }).waitFor();
    await next.click();
    await drawer.getByText("已到当前筛选结果的最后一部。", { exact: true }).waitFor();
    await drawer.getByRole("button", { name: "关闭字幕浮窗", exact: true }).click();
    assert(await subtitleWindow.locator('[data-work-id="sequence-final"]').evaluate((card) => card === document.activeElement));

    await queryInput.fill("Resume Fixture");
    await queryInput.press("Enter");
    const deep = subtitleWindow.locator('[data-work-id="resume-108"]');
    for (let min = 18; min <= 126; min += 18) {
      const size = Math.min(min, resumeWorks.length);
      await subtitleWindow.waitForFunction(count => document.querySelectorAll('[data-work-id^="resume-"]').length >= count, size);
      if (await deep.count()) break;
      await subtitleWindow.locator("#libraryLoadMore").scrollIntoViewIfNeeded();
    }
    await deep.click();
    await drawer.getByRole("button", { name: "标记已查无中字", exact: true }).click();
    await drawer.getByRole("button", { name: "关闭字幕浮窗", exact: true }).click();
    assert(await deep.isHidden());
    resumeWorks = [{ ...resumeWorks[0], id: "resume-inserted", title: "Resume Fixture New" }, ...resumeWorks];

    const reopenedWrites = [];
    const recordReopenedWrite = request => { if (request.method() === "POST") reopenedWrites.push(request.url()); };
    subtitleWindowContext.on("request", recordReopenedWrite);
    const [reopened] = await Promise.all([
      desk.waitForEvent("popup"), desk.getByRole("link", { name: /独立字幕工作台/ }).click()
    ]);
    try {
      await reopened.setViewportSize({ width: 320, height: 750 });
      const first = reopened.locator("#librarySearchResults .work-card").first();
      const requestStart = catalogQueries.length;
      const resumeButton = reopened.getByRole("button", { name: "继续上次", exact: true });
      await resumeButton.click();
      await reopened.locator("#libraryResumeStatus").getByText("已回到上次处理位置。", { exact: true }).waitFor();
      assert.equal(await first.getAttribute("data-work-id"), "resume-109", "resume skips the reviewed anchor after confirming its moved identity");
      assert(await first.evaluate(card => card === document.activeElement));
      const resumeRequests = catalogQueries.slice(requestStart).filter(query => query.q === "Resume Fixture");
      assert.deepEqual(resumeRequests.map(query => [query.offset, query.limit]), [["54", "109"]]);
      assert.equal(await reopened.locator("#librarySearchForm input").inputValue(), "Resume Fixture");
      assert.equal(await reopened.locator("#libraryOnlyUnreviewed").getAttribute("aria-pressed"), "true");
      assert.deepEqual(reopenedWrites, [], "restoring the catalog position must not process a video automatically");
      assert(await reopened.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await first.click();
      await reopened.locator("#subtitleVideoName").getByText(path.basename(libraryVideo), { exact: true }).waitFor();
      await reopened.getByRole("button", { name: "下一部作品", exact: true }).click();
      await reopened.locator("#subtitleVideoName").getByText(path.basename(retainedVideo), { exact: true }).waitFor();
      await reopened.getByRole("button", { name: "关闭字幕浮窗", exact: true }).click();

      await reopened.getByRole("button", { name: "从头浏览", exact: true }).click();
      await reopened.locator('[data-work-id="resume-inserted"]').waitFor();
      assert.equal(await reopened.locator("#librarySearchForm input").inputValue(), "Resume Fixture");
      const stale = resumeGate = { release: Promise.withResolvers(), done: Promise.withResolvers() };
      try {
        await Promise.all([resumeButton.click(), reopened.waitForRequest(request => {
          const params = new URL(request.url()).searchParams;
          return params.get("q") === "Resume Fixture" && params.get("limit") === "109";
        })]);
        const search = reopened.locator("#librarySearchForm input");
        await search.fill("No matches");
        await search.press("Enter");
        await reopened.locator("#librarySearchStatus").getByText("没有匹配的馆藏视频。", { exact: true }).waitFor();
      } finally { stale.release.resolve(); }
      await stale.done.promise;
      assert.equal(await first.count(), 0, "a later search owns the catalog after a delayed resume response");
      assert(await reopened.locator("#libraryResumeTools").isHidden());
      resumeWorks = resumeWorks.filter(work => work.id !== "resume-110");
      const writes = reopenedWrites.length;
      await resumeButton.click();
      await reopened.locator("#libraryResumeStatus").getByText("上次处理位置已变化，已从头显示当前筛选。", { exact: true }).waitFor();
      assert.equal(await first.getAttribute("data-work-id"), "resume-inserted");
      assert.equal(reopenedWrites.length, writes, "a removed anchor must never select an adjacent video implicitly");
    } finally {
      subtitleWindowContext.off("request", recordReopenedWrite);
      await reopened.close();
    }
  } finally {
    await subtitleWindow.close();
    await subtitleWindowContext.unrouteAll();
  }

  await desk.locator("#filePicker").setInputFiles(source("ABC-945.mp4"));
  await desk.locator("#queue").getByText("ABC-945.mp4", { exact: true }).click();
  await desk.locator("#compareTable").getByRole("button", { name: "字幕", exact: true }).click();
  await subtitleDialog.getByRole("button", { name: "一键下载字幕" }).click();
  await subtitleDialog.getByText("未找到此番号的字幕，可以继续洗版。").waitFor();
  await subtitleDialog.getByRole("button", { name: "关闭" }).click();
  assert(await desk.getByRole("button", { name: "作为新番号入库" }).isEnabled());

  const multipleTargets = source("ABC-936.mp4");
  const alternateActor = path.join(archive, path.basename(actor));
  const unregisteredActor = path.join(archive, "Other Fixture Person");
  fs.mkdirSync(alternateActor, { recursive: true });
  fs.mkdirSync(unregisteredActor);
  await desk.locator("#filePicker").setInputFiles(multipleTargets);
  await desk.locator("#queue").getByText("ABC-936.mp4", { exact: true }).click();
  await desk.locator("#compareTable").getByText("ABC-936.mp4", { exact: true }).waitFor();
  await desk.getByRole("button", { name: "用 115Chrome 查资料" }).click();
  await desk.locator("#notice").filter({ hasText: "可以粘贴详情页网址读取" }).waitFor();
  await desk.getByRole("textbox", { name: "JavDB 作品详情页网址" }).fill("javdb.com/v/Fixture936?from=search#title");
  await desk.getByRole("button", { name: "从网址读取" }).click();
  await desk.locator("#workMetadata").getByText("ABC-936 New Work", { exact: true }).waitFor();
  assert(await desk.getByRole("button", { name: "作为新番号入库" }).isDisabled());
  const choices = desk.locator("#actorTarget");
  assert((await choices.locator("option").allTextContents()).includes(`Fixture Person · ${actor}`));
  assert((await choices.locator("option").allTextContents()).includes(`Other Fixture Person · ${unregisteredActor}`));
  await choices.selectOption({ label: `Fixture Person · ${alternateActor}` });
  await desk.getByRole("button", { name: "作为新番号入库" }).click();
  const alternateTarget = path.join(alternateActor, "ABC-936 New Work", "ABC-936 New Work-LTX.mp4");
  await desk.getByRole("dialog").getByText(alternateTarget, { exact: true }).waitFor();
  assert(fs.existsSync(multipleTargets));
  await desk.getByRole("button", { name: "确认提交" }).click();
  await desk.locator("#notice").filter({ hasText: /新番号入库完成.*ABC-936/ }).waitFor();
  assert.equal(bytes(alternateTarget), "fixture incoming 1080p");
  assert.match(bytes(path.join(path.dirname(alternateTarget), "info.txt")), /detail_url: https:\/\/javdb\.com\/v\/Fixture936\r?\n/);
  await desk.close();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const discard = write(path.join(outside, "ABC-914.mp4"), "fixture outside download disk");
  await page.goto(`${address}/fanhao/file-workflows/intake`);
  await page.evaluate(({ name, size, modified }) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(size)], name, { lastModified: modified }));
    document.getElementById("dropArea").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, descriptor(discard));
  await page.getByText("未找到同番号的馆藏视频。").waitFor();
  assert(await page.locator("#tagLtx").isChecked());
  await page.getByRole("button", { name: "丢弃源视频" }).click();
  await page.getByRole("dialog").waitFor();
  assert(fs.existsSync(discard));
  await page.getByRole("button", { name: "返回核对" }).click();
  assert(fs.existsSync(discard));
  await page.getByRole("button", { name: "丢弃源视频" }).click();
  await page.getByLabel("待丢弃的是 LTX").check();
  await page.getByRole("checkbox", { name: "保留 4K 馆藏", exact: true }).check();
  await page.getByRole("checkbox", { name: "保留中字馆藏", exact: true }).check();
  await page.getByRole("button", { name: "确认提交" }).click();
  await page.getByText("丢弃源视频完成。", { exact: true }).waitFor();
  assert(!fs.existsSync(discard));
  const discardStats = service.discardStats({ reason: "keep-subtitled", ltxOnly: true });
  assert.equal(discardStats.matched, 1);
  assert.equal(discardStats.records[0].code, "ABC-914");
  assert.deepEqual(discardStats.records[0].reasons, ["keep-4k", "keep-subtitled"]);
  assert.equal(discardStats.counts["keep-4k"], 1);
  const legacyDiscard = await service.prepare({ action: "discard", path: source("ABC-949旧标题LTX_restored.mp4") });
  service.run(legacyDiscard.id);
  assert.equal((await settle(legacyDiscard)).state, "completed");
  assert(service.discardStats({ reason: "unrecorded", ltxOnly: true }).records.some((record) => record.code === "ABC-949" && record.inferred));
  await page.getByRole("button", { name: "迁移记录", exact: true }).click();
  await page.getByRole("button", { name: "丢弃统计", exact: true }).click();
  await page.getByLabel("只看 LTX").check();
  await page.locator("#discardFilter").selectOption("keep-4k");
  await page.locator("#discardRecords").getByText("ABC-914 · LTX · 保留 4K 馆藏、保留中字馆藏", { exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  const dragFolder = source("ABC-915-LTX/ABC-915.mp4");
  const dragAd = source(`ABC-915-LTX/${firstAd}`);
  const droppedStat = fs.statSync(dragFolder);
  await page.evaluate(({ size, modified }) => {
    const child = { name: "ABC-915.mp4", isFile: true, fullPath: "/ABC-915-LTX/ABC-915.mp4",
      file: (callback) => callback(new File([new Uint8Array(size)], "ABC-915.mp4", { lastModified: modified })) };
    const batches = [[child], []];
    const folder = { name: "ABC-915-LTX", isDirectory: true, createReader: () => ({ readEntries: (callback) => callback(batches.shift()) }) };
    const event = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { items: [{ webkitGetAsEntry: () => folder }] } });
    document.getElementById("dropArea").dispatchEvent(event);
  }, { size: droppedStat.size, modified: Math.floor(droppedStat.mtimeMs) });
  await page.locator("#compareTable").getByText("ABC-915.mp4", { exact: true }).waitFor();
  assert(fs.existsSync(dragFolder));
  assert(fs.existsSync(dragAd));
  await page.locator("#compareTable").getByText(firstAd, { exact: true }).waitFor();
  assert.equal(await page.locator("#queueCount").textContent(), "1");
  await page.getByRole("button", { name: "丢弃整个文件夹" }).click();
  await page.getByRole("dialog").getByText(path.dirname(dragFolder), { exact: true }).waitFor();
  assert(fs.existsSync(dragAd));
  await page.getByRole("button", { name: "确认提交" }).click();
  await page.getByText("丢弃整个文件夹完成。", { exact: true }).waitFor();
  assert(!fs.existsSync(path.dirname(dragFolder)));
  const pickedPackage = source("ABC-916-LTX/ABC-916-LTX.mp4");
  const pickedAd = source(`ABC-916-LTX/${firstAd}`);
  await page.locator("#filePicker").setInputFiles(pickedPackage);
  await page.locator("#compareTable").getByText(firstAd, { exact: true }).waitFor();
  await page.getByRole("button", { name: "移除下载包 ABC-916" }).click();
  await page.getByRole("dialog").getByText(path.dirname(pickedPackage), { exact: true }).waitFor();
  assert(fs.existsSync(pickedAd));
  await page.getByRole("button", { name: "确认提交" }).click();
  await page.getByText("丢弃整个文件夹完成。", { exact: true }).waitFor();
  assert(!fs.existsSync(path.dirname(pickedPackage)));

  const staleLibrary = oldVideo(60, "ABC-917", "", "fixture library old 1080p");
  const staleSource = source("ABC-917-LTX/ABC-917-LTX.mp4");
  const staleFolder = path.dirname(staleSource);
  source(`ABC-917-LTX/${firstAd}`);
  await page.route("**/api/fanhao/file-workflows/intake/compare", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, package: null } });
  });
  await page.locator("#filePicker").setInputFiles(staleSource);
  await page.locator("#compareTable").getByText("ABC-917-LTX.mp4", { exact: true }).waitFor();
  await page.getByRole("button", { name: "替换所选馆藏" }).click();
  const migration = page.getByRole("dialog");
  await migration.getByText("将删除的源文件夹", { exact: true }).waitFor();
  await migration.getByText(staleFolder, { exact: true }).waitFor();
  assert(fs.existsSync(staleSource));
  assert.equal(bytes(staleLibrary), "fixture library old 1080p");
  await page.getByRole("button", { name: "确认提交" }).click();
  await page.locator("#notice").filter({ hasText: /替换馆藏视频完成.*ABC-917/ }).waitFor();
  assert(!fs.existsSync(staleFolder));
  assert.equal(bytes(db.prepare("SELECT file_path FROM local_files WHERE id=60").get().file_path), "fixture incoming 1080p");

  const browserDeleteOld = oldVideo(75, "ABC-918", "", "fixture library 1080p");
  const browserDeleteSource = source("ABC-918.mp4");
  await page.locator("#filePicker").setInputFiles(browserDeleteSource);
  await page.getByRole("button", { name: "两份都删除" }).click();
  const deleteDialog = page.getByRole("dialog");
  await deleteDialog.getByText(browserDeleteSource, { exact: true }).waitFor();
  await deleteDialog.getByText(path.dirname(browserDeleteOld), { exact: true }).waitFor();
  assert(fs.existsSync(browserDeleteSource) && fs.existsSync(browserDeleteOld));
  await deleteDialog.getByRole("button", { name: "确认提交" }).click();
  await page.getByText("两份都删除完成。", { exact: true }).waitFor();
  assert(!fs.existsSync(browserDeleteSource) && !fs.existsSync(path.dirname(browserDeleteOld)));

  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  if (shots) await page.screenshot({ path: path.join(shots, "narrow.png") });
  console.log("media intake: cross-root lookup and migration, replacement, rollback/retry, 4K choices, metadata, discard, renames, per-volume queue and restart, local API and responsive UI verified");
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await service.close();
  db.close();
  temporary.cleanup();
}
