import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { createCoreLibraryService } from "../src/modules/fanhao/server/library/core-library-service.js";
import { createMediaIntakeService } from "../src/modules/fanhao/server/workflows/media-intake-service.js";
import { classifyIntakeAds, stageIntakeFile, signature } from "../src/modules/fanhao/server/workflows/intake-files.js";
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
const openCalls = [];
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

function oldVideo(id, code, marker, contents, actorDir = actor) {
  const title = `${code} Fixture`;
  const folder = path.join(actorDir, title);
  const file = write(path.join(folder, `${title}${marker}.mp4`), contents);
  db.prepare("INSERT INTO works(id,code,code_search,title,source) VALUES(?,?,?,?,'fixture')").run(id, code, code.replace("-", "").toLowerCase(), title);
  db.prepare("INSERT INTO work_people VALUES(?,1,'actor',0,'fixture',?,?)").run(id, timestamp, timestamp);
  db.prepare("INSERT INTO local_works(id,work_id,local_path) VALUES(?,?,?)").run(id, id, folder);
  db.prepare(`INSERT INTO local_files(id,work_id,local_work_id,file_id,file_type,file_path,name,size,modified_at,sort_order)
    VALUES(?,?,?,?,'video',?,?,?,?,0)`).run(id, id, id, `video-${id}`, file, path.basename(file), fs.statSync(file).size, timestamp);
  return file;
}

const serviceOptions = { getDb: () => db, sourceRoots: [incoming], libraryRoots: [library, archive],
  searchRoots: async () => [outside, library],
  classifyAds: (unnumbered, numbered) => classifyIntakeAds(process.env.PYTHON || "python", path.resolve("tools/clean.py"), unnumbered, numbered),
  targetDevice: (folder) => folder.startsWith(archive + path.sep) ? "archive" : "main",
  relativeFromRoot: (file) => path.relative(library, file), openPath: async (file) => { openCalls.push(file); },
  probeVideo: async (file) => {
    const contents = bytes(file);
    if (contents.includes("unreadable metadata")) return null;
    const fourK = contents.includes("2160p");
    return { width: fourK ? 3840 : 1920, height: fourK ? 2160 : 1080, duration: 1800, videoCodec: "h264", audioCodec: "aac" };
  },
  fetchMetadata: async (code) => ({ code, title: `${code} New Work`,
    actors: code === "ABC-936" ? ["Fixture Person", "Other Fixture Person"] : ["Fixture Person"], tags: ["fixture"], date: "2025-03-01" }),
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
  const existing = oldVideo(1, "ABC-123", "-LTX", "fixture library old 1080p");
  const replacement = source("ABC-123.mp4");
  const subtitle = source("ABC-123.zh.srt", "fixture subtitles");
  const stat = fs.statSync(replacement);
  const scan = await service.scan({ files: [{ name: path.basename(replacement), size: stat.size, modified: Math.floor(stat.mtimeMs) }] });
  assert.equal(scan.items[0].path, replacement);
  const compared = await service.compare({ path: replacement });
  assert.equal(compared.code, "ABC-123");
  assert.equal(compared.files[0].id, 1);
  await service.open({ path: replacement });
  await service.open({ path: existing, folder: true });
  assert.deepEqual(openCalls, [replacement, path.dirname(existing)]);

  const plan = await service.prepare({ action: "replace", path: replacement, oldId: 1 });
  assert.equal(plan.target, existing);
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
  const imported = await service.prepare({ action: "new", path: newWork, tags: { a: true, ltx: false, u: true, c: true } });
  assert.match(imported.target, /\[A\]\..+-UC\.mkv$/);
  service.run(imported.id);
  assert.equal((await settle(imported)).state, "completed");
  assert.match(bytes(path.join(path.dirname(imported.target), "info.txt")), /actor_names: Fixture Person/);
  assert.equal(db.prepare("SELECT release_date FROM works WHERE code='ABC-789'").get().release_date, "2025-03-01");
  assert(indexReads >= 3);

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
  await stageIntakeFile(item, () => {}, (phase, size) => { moved[phase] += size; });
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
    assert.equal(service.run(secondJob.id).state, "queued");
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
    personRecordFromWorks: (entry) => entry, relativeFromRoot: String,
    registerFiles: (index, files) => files.forEach((file) => index.filesById.set(file.id, file)),
    sourcePathToAbsolute: (value) => String(value || ""), uniquePersonNames: (values) => values
  });
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
  await desk.locator("#filePicker").setInputFiles([deskFirst, deskSecond]);
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
  await desk.getByRole("button", { name: "作为新番号入库" }).click();
  await desk.getByRole("dialog").getByText(/ABC-935 New Work.*-LTX\.mp4$/).waitFor();
  assert(fs.existsSync(autoImport));
  await desk.getByRole("button", { name: "确认提交" }).click();
  await desk.locator("#notice").filter({ hasText: /新番号入库完成.*ABC-935/ }).waitFor();
  assert(!fs.existsSync(autoImport));
  const multipleTargets = source("ABC-936.mp4");
  const alternateActor = path.join(archive, path.basename(actor));
  fs.mkdirSync(alternateActor, { recursive: true });
  await desk.locator("#filePicker").setInputFiles(multipleTargets);
  await desk.locator("#queue").getByText("ABC-936.mp4", { exact: true }).click();
  await desk.locator("#compareTable").getByText("ABC-936.mp4", { exact: true }).waitFor();
  await desk.getByRole("button", { name: "作为新番号入库" }).click();
  await desk.getByText("资料已找到，请选择人物和归档目录。", { exact: true }).waitFor();
  assert(await desk.getByRole("button", { name: "作为新番号入库" }).isDisabled());
  const choices = desk.locator("#actorTarget");
  assert((await choices.locator("option").allTextContents()).includes(`Fixture Person · ${actor}`));
  await choices.selectOption({ label: `Fixture Person · ${alternateActor}` });
  await desk.getByRole("button", { name: "作为新番号入库" }).click();
  const alternateTarget = path.join(alternateActor, "ABC-936 New Work", "ABC-936 New Work-LTX.mp4");
  await desk.getByRole("dialog").getByText(alternateTarget, { exact: true }).waitFor();
  assert(fs.existsSync(multipleTargets));
  await desk.getByRole("button", { name: "确认提交" }).click();
  await desk.locator("#notice").filter({ hasText: /新番号入库完成.*ABC-936/ }).waitFor();
  assert.equal(bytes(alternateTarget), "fixture incoming 1080p");
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
