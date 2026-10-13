import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { normalizeWorkCode, workCodeKey } from "../lib/code-parser.js";
import { createAdminMaintenanceTaskService } from "../src/modules/fanhao/server/admin/admin-maintenance-task-service.js";
import { createCoreLibrarySyncService } from "../src/modules/fanhao/server/library/core-library-sync-service.js";
import { createLocalLibraryScanService } from "../src/modules/fanhao/server/library/local-library-scan-service.js";
import { createPersonLibraryService } from "../src/modules/fanhao/server/people/person-library-service.js";
import { sameLocalVideo } from "../src/modules/fanhao/server/library/local-video-identity.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const temporary = createVerifiedTempDir("fanhao-actor-local-sync-");
const root = temporary.tempDir;
const libraryRoots = [root];
const personDir = path.join(root, "Fixture Actor");
const workDir = path.join(personDir, "URVRSP-449 long directory title");
fs.mkdirSync(workDir, { recursive: true });
for (const part of ["A", "B"]) fs.writeFileSync(path.join(workDir, `URVRSP-449-${part}.mp4`), `fixture-${part}`);

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE works (id INTEGER PRIMARY KEY, code TEXT, code_search TEXT, title TEXT);
  CREATE TABLE work_people (work_id INTEGER, person_id INTEGER, role TEXT, sort_order INTEGER);
  CREATE TABLE local_works (
    id INTEGER PRIMARY KEY, work_id INTEGER, local_path TEXT, source_info_path TEXT,
    source_info_id TEXT, source_name TEXT, source_size INTEGER, source_mtime TEXT,
    detected_code TEXT, detected_code_search TEXT, matched_by TEXT, confidence REAL,
    created_at TEXT, updated_at TEXT
  );
  CREATE TABLE local_files (
    id INTEGER PRIMARY KEY, work_id INTEGER, local_work_id INTEGER, file_id TEXT UNIQUE,
    file_type TEXT, file_path TEXT, name TEXT, title TEXT, ext TEXT, relative_path TEXT,
    size INTEGER, modified_at TEXT, playable INTEGER, sort_order INTEGER,
    created_at TEXT, updated_at TEXT
  );
  INSERT INTO works VALUES (1, 'URVRSP-449', 'urvrsp449', 'remote metadata');
  INSERT INTO work_people VALUES (1, 1, 'actor', 0);
`);

const person = { id: "1", name: "Fixture Actor", relativePath: personDir, sourcePaths: [personDir], works: [] };
const library = {
  people: [person], peopleById: new Map([[person.id, person]]), worksById: new Map(),
  filesById: new Map(), totals: {}, fileRefCounts: new Map()
};
const events = [];
const fileBase = (value) => path.basename(value, path.extname(value));
const normalizeExt = (value) => path.extname(value).toLowerCase();
const compareName = (a, b) => String(a.title || a.name).localeCompare(String(b.title || b.name));
const safeStat = (value) => { try { return fs.statSync(value); } catch { return null; } };
const pathWithinRoot = (value, base) => {
  const relative = path.relative(base, value);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
};
const coreSync = createCoreLibrarySyncService({
  fileBase, getCoreDb: () => db, hasCoreDb: () => true, normalizeExt, normalizeWorkCode,
  relativeFromRoot: (value) => value, sourcePathToAbsolute: (value) => value,
  storedWorkCodeKey: (value) => String(value || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase(),
  workCodeKeys: (work) => [...new Set([work.infoSummary?.code, work.title, work.directoryName].map(workCodeKey).filter(Boolean))]
});
const scanner = createLocalLibraryScanService({
  compareNaturalName: compareName, compareNaturalTitle: compareName, coverHints: new Set(),
  createId: (prefix, value) => `${prefix}_${Buffer.from(value).toString("base64url")}`,
  emptyLibrary: () => library, excludedDirs: new Set(), fileBase,
  isExcludedDirName: () => false, isImage: (value) => normalizeExt(value) === ".jpg",
  isInfo: (value) => normalizeExt(value) === ".txt", isPlayableVideo: (value) => normalizeExt(value) === ".mp4",
  isVideo: (value) => normalizeExt(value) === ".mp4", libraryRoots: [root],
  linkScannedWork: coreSync.linkedScannedWork, normalizeExt,
  relativeFromRoot: (value) => value, safeStat
});
let writeError = null;
let reconciliations = 0;
const boundSources = [];
const personLibrary = createPersonLibraryService({
  bindSourcePaths: (id, sources) => boundSources.push({ id, sources }),
  actorProfileSearchNames: (value) => [value.name], compareNaturalTitle: compareName,
  getLibrary: () => library, libraryRoots, libraryOpenRoots: () => libraryRoots,
  normalizeSourcePath: (value) => String(value).replaceAll("\\", "/").toLowerCase(), pathWithinRoot,
  relativeFromRoot: (value) => value, rootLabel: (value) => value, safeStat,
  scanPersonDirectory: scanner.scanPersonDirectory, sourcePathToAbsolute: (value) => value,
  libraryIndexService: {
    registerWorkFiles: (index, work) => scanner.registerFiles(index, [...work.videos, ...work.images, ...work.infos]),
    replaceLocalFilesForWork: (work) => { if (writeError) throw writeError; coreSync.replaceLocalFilesForWork(work); },
    reconcilePersonLocalWorks: (...args) => { reconciliations += 1; return coreSync.reconcilePersonLocalWorks(...args); },
    saveCache: () => {}, invalidateDerivedCaches: () => events.push("invalidate-local")
  }
});
let capturedProcess;
let reloadResult = library;
let syncOverride = null;
const service = createAdminMaintenanceTaskService({
  actorProfileRow: () => ({ javdb_url: "https://javdb.com/actors/fixture" }),
  adminTaskService: {
    startProcessTask: (options) => {
      capturedProcess = options;
      return { id: "fixture-task", status: "running", logs: [] };
    },
    publicTask: (task) => task
  },
  clampInteger: (value, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : fallback)),
  invalidateTableStamp: () => {}, setActorMovieCache: () => {}, setLocalWorkCachesDirty: () => {},
  clearSearchSourceCaches: () => {}, refreshLibrary: () => { events.push("reload"); return reloadResult; },
  linkedPersonIds: () => ["1", "2", "1"],
  resolveLibraryPersonByPublicId: (id) => library.peopleById.get(String(id)) || { id: String(id), name: `Actor ${id}` },
  syncPersonLocal: (id) => {
    events.push(`sync:${id}`);
    return syncOverride ? syncOverride(id) : personLibrary.refreshPerson(String(id), { failOnPersistenceError: true });
  }
});

function start(body) {
  events.length = 0;
  const { task } = service.refreshActorMoviesPayload(body);
  assert.equal(task.status, "running");
  assert.deepEqual(events, [], "starting a remote refresh must not scan or mutate local media");
  return task;
}
function finish(task, status = "done") {
  task.status = status;
  capturedProcess.onDone(task);
  return task;
}

try {
  for (const maxPages of [1, 0]) {
    const task = start({ personId: "1", maxPages });
    assert.equal(capturedProcess.args[capturedProcess.args.indexOf("--max-pages") + 1], String(maxPages));
    finish(task);
    assert.equal(task.status, "done");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_works WHERE work_id = 1").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_files WHERE work_id = 1 AND file_type = 'video' AND playable = 1").get().count, 2);
    assert.equal(library.worksById.get("1").videoCount, 2);
    assert.deepEqual(events.slice(0, 2), ["reload", "sync:1"], "local association must see newly refreshed metadata");
    assert.match(task.logs.at(-1), /本地已同步.*2 个视频/);
  }

  for (const status of ["error", "stopped"]) {
    const task = finish(start({ personId: "1" }), status);
    assert.equal(task.status, status);
    assert.deepEqual(events, ["reload"], "failed/stopped remote jobs must not start a local scan");
  }

  const previousWork = library.worksById.get("1");
  const previousPerson = library.peopleById.get("1");
  const previousReconciliations = reconciliations;
  writeError = new Error("fixture database locked");
  const failed = finish(start({ personId: "1", maxPages: 0 }));
  assert.equal(failed.status, "error", "a local write failure must prevent successful completion");
  assert.match(failed.logs.at(-1), /^ERROR.*本地同步失败.*fixture database locked/);
  assert.equal(library.worksById.get("1"), previousWork, "failed persistence must preserve the public work snapshot");
  assert.equal(library.peopleById.get("1"), previousPerson);
  assert.equal(reconciliations, previousReconciliations, "failed writes must not trigger stale-row reconciliation");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_files").get().count, 2);
  writeError = null;

  syncOverride = () => null;
  const remoteOnly = finish(start({ personId: "2" }));
  assert.equal(remoteOnly.status, "done");
  assert.match(remoteOnly.logs.at(-1), /未配置本地来源/);

  syncOverride = (id) => id === "1" ? { person: library.peopleById.get("1") } : null;
  const allPeople = finish(start({ fullScan: true }));
  assert.equal(allPeople.status, "done");
  assert(capturedProcess.args.includes("--all-linked-people"));
  assert.deepEqual(events, ["reload", "sync:1", "sync:2"], "all-person refresh must synchronize its linked local people once each");

  reloadResult = null;
  const reloadFailed = finish(start({ personId: "1" }));
  assert.equal(reloadFailed.status, "error");
  assert.match(reloadFailed.logs.at(-1), /资料库重新加载失败/);
  assert.deepEqual(events, ["reload"]);

  reloadResult = library;
  syncOverride = null;
  verifyPathChanges();
  console.log("Actor movie/local sync passed: page/full refresh, moved folders/storage roots, duplicate-code file identity, partial ambiguity preservation, idempotency and write failures.");
} finally {
  db.close();
  temporary.cleanup();
}

function copyFixtureFile(source, destination) {
  assert(pathWithinRoot(source, root) && pathWithinRoot(destination, root));
  const stat = fs.statSync(source);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.utimesSync(destination, stat.atime, stat.mtime);
}

function verifyPathChanges() {
  const renamedWorkDir = path.join(personDir, "URVRSP-449 renamed folder");
  for (const part of ["A", "B"]) {
    const source = path.join(workDir, `URVRSP-449-${part}.mp4`);
    copyFixtureFile(source, path.join(renamedWorkDir, path.basename(source)));
    fs.unlinkSync(source);
  }
  fs.rmdirSync(workDir);
  db.exec(`
    INSERT INTO works VALUES (2, 'URVRSP-449', 'urvrsp449', 'old duplicate');
    INSERT INTO work_people VALUES (2, 1, 'actor', 0);
  `);
  db.prepare("INSERT INTO local_works(id,work_id,local_path) VALUES (2,2,?)").run(path.join(personDir, "missing-duplicate"));
  const scanned = scanner.scanPersonDirectory("1", personDir, { linkWorks: false })[0];
  assert.equal(coreSync.workIdForScannedWork("1", scanned), "1", "video metadata must disambiguate an old duplicate after a folder rename");
  const firstVideo = scanned.videos[0];
  assert(sameLocalVideo(firstVideo, { ...firstVideo, modifiedAt: firstVideo.modifiedAt.replace("Z", "+00:00") }));
  assert(!sameLocalVideo(firstVideo, { ...firstVideo, modifiedAt: "2000-01-01T00:00:00Z" }));
  assert(!sameLocalVideo({ ...firstVideo, size: 0 }, { ...firstVideo, size: 0 }));
  assert(!sameLocalVideo(firstVideo, { ...firstVideo, name: "different.mp4" }));

  db.exec(`
    INSERT INTO works VALUES (3, 'URVRSP-449', 'urvrsp449', 'indistinguishable duplicate');
    INSERT INTO work_people VALUES (3, 1, 'actor', 0);
    INSERT INTO local_files(work_id,local_work_id,file_id,file_type,name,size,modified_at)
      SELECT 3,3,'duplicate-' || file_id,file_type,name,size,modified_at FROM local_files WHERE work_id=1;
  `);
  db.prepare("INSERT INTO local_works(id,work_id,local_path) VALUES (3,3,?)").run(path.join(personDir, "missing-identical-duplicate"));
  assert.throws(() => coreSync.workIdForScannedWork("1", scanned), (error) =>
    error.code === "AMBIGUOUS_LOCAL_WORK_BINDING" && error.candidateWorkIds.includes("1") && error.candidateWorkIds.includes("3"),
  "identical evidence for two candidates must retain the ambiguity guard");
  const originalWork = library.worksById.get("1");
  const oldFilePaths = db.prepare("SELECT file_path FROM local_files WHERE work_id=1").all().map((row) => row.file_path);
  const otherDir = path.join(personDir, "NEW-001 separate work");
  fs.mkdirSync(otherDir);
  fs.writeFileSync(path.join(otherDir, "NEW-001.mp4"), "other-fixture");
  db.exec("INSERT INTO works VALUES (4,'NEW-001','new001','another work'); INSERT INTO work_people VALUES (4,1,'actor',0);");
  const partial = finish(start({ personId: "1" }));
  assert.equal(partial.status, "error", "a partial sync must report unresolved bindings");
  assert(partial.logs.some((line) => /^ERROR.*其余作品已同步/.test(line)));
  assert.equal(library.worksById.get("1"), originalWork, "unresolved work records must remain visible and unchanged");
  assert.deepEqual(db.prepare("SELECT file_path FROM local_files WHERE work_id=1").all().map((row) => row.file_path), oldFilePaths);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_files WHERE work_id=4").get().count, 1, "one ambiguity must not block another work's synchronization");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_works WHERE work_id IN (2,3)").get().count, 2, "unresolved duplicate records must not be reconciled away");

  db.exec("DELETE FROM local_files WHERE work_id=3; DELETE FROM local_works WHERE work_id=3; DELETE FROM work_people WHERE work_id=3; DELETE FROM works WHERE id=3;");
  assert.equal(finish(start({ personId: "1" })).status, "done");
  assert.equal(db.prepare("SELECT local_path FROM local_works WHERE work_id=1").get().local_path, renamedWorkDir);

  const movedRoot = path.join(root, "moved-storage");
  const movedPersonDir = path.join(movedRoot, person.name);
  const files = [...library.filesById.values()];
  for (const file of files) copyFixtureFile(file.path, path.join(movedPersonDir, path.relative(personDir, file.path)));
  for (const file of files) fs.unlinkSync(file.path);
  fs.rmdirSync(renamedWorkDir);
  fs.rmdirSync(otherDir);
  fs.rmdirSync(personDir);
  const wrongRoot = path.join(root, "same-name-unrelated-storage");
  const wrongDir = path.join(wrongRoot, person.name, "URVRSP-449 different files");
  fs.mkdirSync(wrongDir, { recursive: true });
  for (const part of ["A", "B"]) {
    const file = path.join(wrongDir, `URVRSP-449-${part}.mp4`);
    fs.writeFileSync(file, `fixture-${part}`);
    fs.utimesSync(file, new Date("2000-01-01T00:00:00Z"), new Date("2000-01-01T00:00:00Z"));
  }
  libraryRoots.push(movedRoot, wrongRoot);
  const migrated = finish(start({ personId: "1", maxPages: 0 }));
  assert.equal(migrated.status, "done");
  assert.deepEqual(library.peopleById.get("1").sourcePaths, [movedPersonDir], "root discovery requires prior video identity, not a matching actor name alone");
  assert.deepEqual(boundSources.at(-1), { id: "1", sources: [movedPersonDir] }, "a verified new source must be persisted for future refreshes");
  assert(db.prepare("SELECT local_path FROM local_works WHERE work_id=1").get().local_path.startsWith(movedPersonDir));
  const localsBeforeRepeat = db.prepare("SELECT COUNT(*) AS count FROM local_works").get().count;
  assert.equal(finish(start({ personId: "1" })).status, "done");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_works").get().count, localsBeforeRepeat);
  for (const part of ["A", "B"]) {
    assert.equal(fs.readFileSync(path.join(movedPersonDir, path.basename(renamedWorkDir), `URVRSP-449-${part}.mp4`), "utf8"), `fixture-${part}`);
  }
}
