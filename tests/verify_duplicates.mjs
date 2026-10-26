import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";
import { duplicateSnapshot } from "../src/modules/fanhao/server/duplicates/source.js";
import { buildDuplicateGroups } from "../src/modules/fanhao/server/duplicates/model.js";
import { createDuplicateService } from "../src/modules/fanhao/server/duplicates/service.js";
import { createDuplicateRuntime } from "../src/modules/fanhao/server/duplicates/runtime.js";
import { createMediaFileRelocationService } from "../src/modules/fanhao/server/works/media-file-relocation-service.js";
import { checkDuplicateAvailability } from "../src/modules/fanhao/server/duplicates/availability.js";

const temporary = createVerifiedTempDir("fanhao-duplicate-compare-");
const directory = fs.realpathSync(temporary.tempDir), dbPath = path.join(directory, "fixture.sqlite");
const services = [], servers = [];
const checksum = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const original = Buffer.alloc(2 * 1024 * 1024, 65), different = Buffer.alloc(original.length, 66);
const work = { id: "1", videos: [] };
const rows = [];
function add(id, name, bytes, code = "TEST-100") {
  const filePath = path.join(directory, name); fs.writeFileSync(filePath, bytes);
  const stat = fs.statSync(filePath), file = { id: `video-${id}`, name, path: filePath, size: stat.size, modifiedAt: stat.mtime.toISOString(), type: "video" };
  work.videos.push(file); const row = { ...file, id: String(id), workId: "1", fileId: file.id, videoId: file.id, code, title: "中性测试作品" }; rows.push(row); return row;
}
let probeCalls = 0, resolveCalls = 0;
const options = {
  dbPath, roots: [directory],
  resolveWork: id => { resolveCalls++; return id === "1" ? work : null; },
  resolveVideo: id => work.videos.find(file => file.id === id),
  videoProbeService: { probeCachedAsync: async () => { probeCalls++; return { duration: 180, width: 1920, height: 1080, videoCodec: "h264" }; } }
};
const serviceFor = extra => { const service = createDuplicateService({ ...options, ...extra }); services.push(service); return service; };
async function wait(service, id, predicate = job => job.status !== "running") {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const { job } = service.check(id); if (predicate(job)) return job; if (job.status !== "running") throw new Error(`fixture ended before expected progress: ${JSON.stringify(job.files)}`); await new Promise(resolve => setTimeout(resolve, 1)); }
  throw new Error("fixture duplicate check timed out");
}
let checks = 0;
try {
  add(1, "TEST-100-original.mp4", original); add(2, "TEST-100-copy.mp4", original); add(3, "TEST-100-different.mp4", different);
  add(4, "TEST-100-small.mp4", Buffer.from("different size")); const missing = add(5, "TEST-100-missing.mp4", Buffer.from("offline fixture")); fs.unlinkSync(missing.path);
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE works(id INTEGER PRIMARY KEY,code TEXT,title TEXT); CREATE TABLE local_files(id INTEGER PRIMARY KEY,work_id INTEGER,file_id TEXT,file_path TEXT,name TEXT,size INTEGER,modified_at TEXT,file_type TEXT); INSERT INTO works VALUES(1,'TEST-100','中性测试作品');");
  const insert = db.prepare("INSERT INTO local_files VALUES(?,?,?,?,?,?,?,'video')");
  for (const row of rows) insert.run(Number(row.id), 1, row.fileId, row.path, row.name, row.size, row.modifiedAt);
  db.exec("ALTER TABLE works ADD COLUMN javdb_tags_json TEXT; INSERT INTO works VALUES(2,'ABC-200','中性作品','[\"VR\"]')");
  insert.run(11, 2, "vr-11", path.join(directory, "ABC-200.mp4"), "ABC-200.mp4", 100, rows[0].modifiedAt);
  insert.run(12, 2, "vr-12", path.join(directory, "ABC-200.mkv"), "ABC-200.mkv", 100, rows[0].modifiedAt);
  db.exec("CREATE TABLE video_probe_cache(file_id TEXT,file_path TEXT,source_size INTEGER,source_mtime TEXT,status TEXT,probe_json TEXT,schema_version INTEGER)");
  db.prepare("INSERT INTO video_probe_cache VALUES(?,?,?,?,?,?,1)").run(rows[0].fileId, rows[0].path, rows[0].size, `library:${rows[0].modifiedAt}`, "ok", JSON.stringify({ duration: 120, width: 1280, height: 720 }));
  db.prepare("INSERT INTO video_probe_cache VALUES(?,?,?,?,?,?,1)").run(rows[1].fileId, rows[1].path, rows[1].size + 1, `library:${rows[1].modifiedAt}`, "ok", JSON.stringify({ duration: 999 }));
  db.close();
  const dbBefore = fs.readFileSync(dbPath), beforeFiles = rows.slice(0, 4).map(row => checksum(fs.readFileSync(row.path)));
  const snapshot = duplicateSnapshot(dbPath);
  assert.equal(snapshot.groups.length, 1); assert.deepEqual(fs.readFileSync(dbPath), dbBefore); checks += 2;
  assert.equal(snapshot.summary.indexedFiles, 5, "VR metadata must not enter the list or its summary"); checks++;
  assert.equal(snapshot.groups[0].files.find(file => file.id === "1").probe.duration, 120);
  assert.equal(snapshot.groups[0].files.find(file => file.id === "2").probe, null); checks += 2;
  const automatic = serviceFor();
  const automaticPage = await automatic.list();
  assert.equal(automaticPage.groups[0].files.length, 4, "normal list loading automatically removes confirmed missing files");
  assert.equal(automaticPage.summary.indexedFiles, 4);
  assert.equal((await automatic.list({ q: "missing" })).total, 0); checks += 3;
  fs.writeFileSync(missing.path, Buffer.from("offline fixture"));
  fs.utimesSync(missing.path, new Date(missing.modifiedAt), new Date(missing.modifiedAt));
  assert.equal((await automatic.list({ refresh: true })).groups[0].files.length, 5, "explicit refresh bypasses availability cache and sees restored files");
  fs.unlinkSync(missing.path);
  assert.equal((await automatic.list({ refresh: true })).groups[0].files.length, 4);
  const freshAutomatic = serviceFor();
  assert.equal((await freshAutomatic.list()).groups[0].files.length, 4, "a new service still excludes missing paths without a saved manual check"); checks += 3;
  const service = serviceFor({ snapshotLoader: async () => snapshot });
  const page = await service.list(); const group = page.groups[0];
  assert.equal(group.files.length, 5); assert.equal(probeCalls, 0); assert.equal(resolveCalls, 0); checks += 3;
  assert.equal((await service.list({ q: "missing" })).total, 1);
  assert.equal((await service.list({ q: "not-found" })).total, 0);
  await assert.rejects(service.list({ limit: 100 }), { statusCode: 400 }); checks += 3;
  const preview = await service.resolve(group.id, "1");
  assert.equal(new URL(preview.url, "http://fixture").searchParams.get("videoId"), "video-1");
  await assert.rejects(service.resolve(group.id, "../../other-file"), { statusCode: 404 }); checks += 2;
  const loaded = await service.probe(group.id);
  assert.equal(loaded.group.files.find(file => file.id === "1").duration, 180);
  assert(loaded.group.files.find(file => file.id === "5").probeError); checks += 2;
  const { job } = await service.startCheck(group.id);
  const completed = await wait(service, job.id);
  assert.equal(completed.status, "complete");
  assert.deepEqual(completed.matches.map(match => [...match.fileIds].sort()), [["1", "2"]]);
  assert.equal(completed.files.find(file => file.id === "3").status, "hashed");
  assert.equal(completed.files.find(file => file.id === "4").status, "size_distinct");
  assert.equal(completed.files.find(file => file.id === "5").status, "unavailable");
  assert.equal(completed.progressBytes, original.length * 3); checks += 6;
  const mutable = service.check(job.id); mutable.job.matches.length = 0; assert.equal(service.check(job.id).job.matches.length, 1); checks++;
  const indexedTime = work.videos[0].modifiedAt;
  work.videos[0].modifiedAt = "2030-01-01T00:00:00.000Z";
  assert.equal(service.check(job.id).job.matches.length, 0);
  assert.equal(service.check(job.id).job.files.find(file => file.id === "1").status, "changed");
  work.videos[0].modifiedAt = indexedTime; checks += 2;
  assert.deepEqual(rows.slice(0, 4).map(row => checksum(fs.readFileSync(row.path))), beforeFiles);
  assert.deepEqual(fs.readFileSync(dbPath), dbBefore); checks += 2;
  const selected = await service.startCheck(group.id, ["1", "3"]);
  const selectedDone = await wait(service, selected.job.id);
  assert.deepEqual(selectedDone.files.map(file => file.id).sort(), ["1", "3"]);
  assert.equal(selectedDone.matches.length, 0);
  await assert.rejects(service.startCheck(group.id, ["1", "outside-group"]), { statusCode: 400 });
  await assert.rejects(service.probe(group.id, ["1", "1"]), { statusCode: 400 }); checks += 4;

  const large = Buffer.alloc(16 * 1024 * 1024, 67);
  const largeA = add(6, "TEST-200-original.mp4", large, "TEST-200"), largeB = add(7, "TEST-200-copy.mp4", large, "TEST-200");
  const changing = serviceFor({ snapshotLoader: async () => buildDuplicateGroups([largeA, largeB]) });
  const largeGroup = (await changing.list()).groups[0];
  const run = await changing.startCheck(largeGroup.id);
  await wait(changing, run.job.id, job => job.progressBytes > 0);
  fs.appendFileSync(largeA.path, "changed during full-file read");
  const changed = await wait(changing, run.job.id);
  assert.equal(changed.matches.length, 0); assert.equal(changed.files.find(file => file.id === "6").status, "changed"); checks += 2;
  const cancelRun = await changing.startCheck(largeGroup.id);
  changing.cancel(cancelRun.job.id);
  assert.equal((await wait(changing, cancelRun.job.id)).status, "cancelled"); checks++;
  await changing.stop(); await assert.rejects(changing.list(), { statusCode: 503 }); checks++;

  const blockedWorker = new EventEmitter();
  let releaseTermination, enteredWorker = false;
  const physicalTermination = new Promise(resolve => { releaseTermination = resolve; });
  blockedWorker.terminate = () => physicalTermination;
  const stopping = serviceFor({ workerFactory: () => { enteredWorker = true; return blockedWorker; }, stopTimeoutMs: 20 });
  const waiting = stopping.list().then(() => null, error => error);
  while (!enteredWorker) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(stopping.stop(), { code: "DUPLICATE_STOP_INCOMPLETE" });
  blockedWorker.emit("exit", 1); releaseTermination();
  assert.equal((await waiting).statusCode, 503); await stopping.stop(); checks += 2;

  const outsideDir = path.join(directory, "allowed"); fs.mkdirSync(outsideDir);
  const restricted = serviceFor({ roots: [outsideDir], snapshotLoader: async () => snapshot });
  await assert.rejects(restricted.resolve(group.id, "1"), { statusCode: 400 }); checks++;
  const wrongWork = serviceFor({ resolveWork: () => ({ id: "1", videos: [] }), snapshotLoader: async () => snapshot });
  await assert.rejects(wrongWork.resolve(group.id, "1"), { statusCode: 409 }); checks++;

  const runtime = createDuplicateRuntime({ service, requireLocalAdmin: (req, res) => {
    if (req.headers["x-fixture-local"] === "1") return true;
    res.writeHead(403); res.end(); return false;
  }, readJsonBody: async req => { let value = ""; for await (const chunk of req) { value += chunk; if (value.length > 4096) throw Object.assign(new Error("too large"), { statusCode: 413 }); } return JSON.parse(value); },
  sendJson: (res, status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); } });
  const server = createServer(async (req, res) => { if (!await runtime.routeApi(req, res, new URL(req.url, "http://fixture"))) { res.writeHead(404); res.end(); } }); servers.push(server);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/fanhao/duplicates`, headers = { "x-fixture-local": "1", "Content-Type": "application/json" };
  assert.equal((await fetch(base)).status, 403);
  assert.equal((await fetch(base + "/check", { method: "POST", body: JSON.stringify({ groupId: group.id }) })).status, 403);
  assert.equal((await fetch(base, { headers })).status, 200);
  assert.equal((await fetch(base + "/resolve", { method: "POST", headers, body: JSON.stringify({ groupId: group.id, fileId: "not-in-group", path: rows[0].path }) })).status, 404);
  assert.equal((await fetch(base + "/resolve", { method: "POST", headers, body: "[]" })).status, 400);
  assert.equal((await fetch(base, { method: "DELETE", headers })).status, 405); checks += 6;
  assert.equal((await fetch(base + "/recheck", { method: "POST", body: JSON.stringify({ groupId: group.id }) })).status, 403);
  assert.equal((await fetch(base + "/cleanup", { method: "POST", body: JSON.stringify({ q: "" }) })).status, 403); checks++;
  const checked = await fetch(base + "/recheck", { method: "POST", headers, body: JSON.stringify({ groupId: group.id, path: "not-a-trusted-target" }) });
  assert.equal(checked.status, 200);
  assert.deepEqual((await checked.json()).missingFileIds, ["5"]);
  assert.equal((await service.list()).summary.indexedFiles, 4);
  assert.equal((await service.list({ q: "missing" })).total, 0); checks += 5;

  const reviewA = add(8, "TEST-300-original.mp4", Buffer.from("kept fixture"), "TEST-300");
  const reviewB = add(9, "TEST-300-copy.mp4", Buffer.from("removed fixture"), "TEST-300");
  const reviewing = serviceFor({ cacheMs: 0, snapshotLoader: async () => buildDuplicateGroups([reviewA, reviewB]) });
  fs.unlinkSync(reviewB.path);
  const removed = await reviewing.recheck((await reviewing.list()).groups[0].id);
  assert.deepEqual(removed.missingFileIds, ["9"]); assert.equal(removed.group.files.length, 1);
  const afterRemoval = await reviewing.list();
  assert.equal(afterRemoval.total, 0); assert.equal(afterRemoval.summary.candidateFiles, 0);
  assert.equal(afterRemoval.summary.potentialExtraBytes, 0); checks += 5;
  fs.writeFileSync(reviewB.path, Buffer.from("restored fixture"));
  assert.equal((await reviewing.list()).total, 1, "a restored path reappears; its changed identity must be rescanned before hashing"); checks++;

  const offlineRoot = path.join(directory, "offline-root");
  const offlineRows = [reviewA, reviewB].map(row => ({ ...row, path: path.join(offlineRoot, row.name) }));
  const offline = serviceFor({ roots: [offlineRoot], snapshotLoader: async () => buildDuplicateGroups(offlineRows),
    resolveWork: () => ({ ...work, videos: offlineRows }), resolveVideo: id => offlineRows.find(row => row.id === id) });
  const offlineGroup = (await offline.list()).groups[0];
  const offlineResult = await offline.recheck(offlineGroup.id);
  assert.equal(offlineResult.missingFileIds.length, 0); assert.equal(offlineResult.warnings.length, 2);
  assert.equal((await offline.list()).total, 1); checks += 3;
  const wrongOwnership = await wrongWork.recheck(group.id);
  assert.equal(wrongOwnership.missingFileIds.length, 0); assert.equal(wrongOwnership.warnings.length, 5); checks += 2;
  const relocation = createMediaFileRelocationService({ safeStat: filePath => fs.statSync(filePath, { throwIfNoEntry: false }), readRootDirectoryNames: () => [] });
  const playbackResolved = serviceFor({ snapshotLoader: async () => snapshot,
    resolveVideo: id => relocation.resolve(work.videos.find(file => file.id === id)) });
  assert.equal(relocation.resolve(work.videos.find(file => file.id === "video-5")), null);
  const checkedDeleted = await playbackResolved.recheck(group.id);
  assert.deepEqual(checkedDeleted.missingFileIds, ["5"], "manual deletion must be recognized even when playback resolution has already rejected the file");
  assert.equal(checkedDeleted.warnings.length, 0);
  assert.equal(checkedDeleted.group.files.length, 4);
  assert.equal((await playbackResolved.list({ q: "missing" })).total, 0); checks += 5;
  const confinedRecheck = await restricted.recheck(group.id);
  assert.equal(confinedRecheck.missingFileIds.length, 0);
  assert.equal(confinedRecheck.warnings.length, 5, "indexed-only inspection must retain real-path root authorization"); checks += 2;
  const offlineAvailability = await checkDuplicateAvailability(buildDuplicateGroups(offlineRows), [offlineRoot]);
  assert(offlineAvailability.groups[0].files.every(file => file.availabilityStatus === "unknown"));
  const outsideAvailability = await checkDuplicateAvailability(snapshot, [outsideDir]);
  assert(outsideAvailability.groups[0].files.every(file => file.availabilityStatus === "unknown")); checks += 2;
  const removedDirectory = path.join(directory, "removed-copy (1)"); fs.mkdirSync(removedDirectory);
  const directoryRows = [reviewA, reviewB].map((row, at) => ({ ...row, path: at ? path.join(removedDirectory, "TEST-300.mp4") : row.path }));
  // The disposable fixture directory is empty; no real media is removed.
  fs.rmdirSync(removedDirectory);
  const directoryAvailability = await checkDuplicateAvailability(buildDuplicateGroups(directoryRows), [directory]);
  assert.equal(directoryAvailability.groups[0].files.find(file => file.id === reviewB.id).availabilityStatus, "missing", "a removed parent directory is also a confirmed absent path"); checks++;
  const outsideTarget = path.join(directory, "outside-availability"); fs.mkdirSync(outsideTarget);
  const junction = path.join(outsideDir, "linked-folder"); fs.symlinkSync(outsideTarget, junction, "junction");
  const linkedRows = directoryRows.map((row, at) => ({ ...row, path: path.join(junction, `TEST-300-copy-${at}.mp4`) }));
  const linkedAvailability = await checkDuplicateAvailability(buildDuplicateGroups(linkedRows), [outsideDir]);
  assert(linkedAvailability.groups[0].files.every(file => file.availabilityStatus === "unknown"), "a missing path through a link escaping the root must remain uncertain"); checks++;
  assert.deepEqual(fs.readFileSync(dbPath), dbBefore); checks++;
  console.log(`Duplicate comparison verified: ${checks} checks (read-only worker/index, cached probe identity, explicit media reads, full SHA256, size differences, changed/offline files, cancellation, path and work ownership, HTTP authorization).`);
} finally {
  await Promise.allSettled(services.map(service => service.stop()));
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  temporary.cleanup();
}
