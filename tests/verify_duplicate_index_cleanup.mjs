import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";
import { createDuplicateIndexCleanup } from "../src/modules/fanhao/server/duplicates/index-cleanup.js";
import { createDuplicateService } from "../src/modules/fanhao/server/duplicates/service.js";
import { duplicateSnapshot } from "../src/modules/fanhao/server/duplicates/source.js";

const temporary = createVerifiedTempDir("fanhao-duplicate-index-cleanup-");
const directory = fs.realpathSync(temporary.tempDir), dbPath = path.join(directory, "fixture.sqlite"), root = path.join(directory, "library");
fs.mkdirSync(root);
const db = new DatabaseSync(dbPath), services = [];
let refreshed = 0;
try {
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE works(id INTEGER PRIMARY KEY,code TEXT,title TEXT);
    CREATE TABLE local_works(id INTEGER PRIMARY KEY,work_id INTEGER REFERENCES works(id),local_path TEXT);
    CREATE TABLE local_files(id INTEGER PRIMARY KEY,work_id INTEGER REFERENCES works(id),local_work_id INTEGER REFERENCES local_works(id),
      file_id TEXT,file_path TEXT,name TEXT,size INTEGER,modified_at TEXT,file_type TEXT);
    CREATE TABLE collection_items(work_id INTEGER REFERENCES works(id),note TEXT);
    CREATE TABLE watch_history(work_id INTEGER REFERENCES works(id),position INTEGER);
    CREATE TABLE work_move_path_reservations(work_id TEXT,released_at TEXT);
    INSERT INTO works VALUES(1,'TEST-100','中性测试作品');
    INSERT INTO collection_items VALUES(1,'favorite'); INSERT INTO watch_history VALUES(1,120);`);
  const add = (id, folder, type = "video", extra = {}) => {
    const location = path.join(folder, type === "video" ? `TEST-100-copy-${id}.mp4` : `cover-${id}.jpg`);
    const row = { id: String(id), workId: "1", fileId: `file-${id}`, path: location,
      name: path.basename(location), size: 4, modifiedAt: "2026-01-01T00:00:00.000Z", ...extra };
    if (!db.prepare("SELECT 1 FROM local_works WHERE id=?").get(id)) db.prepare("INSERT INTO local_works VALUES(?,1,?)").run(id, folder);
    db.prepare("INSERT INTO local_files VALUES(?,1,?,?,?,?,?,?,?)").run(id, id, row.fileId, row.path, row.name, row.size, row.modifiedAt, type);
    return row;
  };
  const goneFolder = path.join(root, "removed (1)"), missing = add(1, goneFolder);
  const cover = add(2, goneFolder, "image");
  db.prepare("UPDATE local_files SET local_work_id=1 WHERE id=2").run(); db.prepare("DELETE FROM local_works WHERE id=2").run();
  const presentFolder = path.join(root, "present"); fs.mkdirSync(presentFolder);
  const present = add(3, presentFolder); fs.writeFileSync(present.path, "safe"); fs.utimesSync(present.path, new Date(present.modifiedAt), new Date(present.modifiedAt));
  const absentVideo = add(4, presentFolder), offlineRoot = path.join(directory, "offline"), offline = add(5, offlineRoot);
  const outside = add(6, path.join(directory, "outside")), changed = add(7, presentFolder);
  db.prepare("UPDATE local_files SET size=99 WHERE id=7").run();
  const cleanup = createDuplicateIndexCleanup({ getCoreDb: () => db, roots: [root, offlineRoot], onIndexChanged: () => { refreshed++; } });
  const rawUserState = () => JSON.stringify([db.prepare("SELECT * FROM works").all(), db.prepare("SELECT * FROM collection_items").all(), db.prepare("SELECT * FROM watch_history").all()]);
  const userBefore = rawUserState();
  const result = cleanup([missing, present, absentVideo, offline, outside, changed]);
  assert.deepEqual(result.removedFileIds.sort(), ["1", "2", "4"]);
  assert.deepEqual(result.removedLocalWorkIds, ["1"]);
  assert.equal(db.prepare("SELECT 1 FROM local_works WHERE id=1").get(), undefined);
  assert(db.prepare("SELECT 1 FROM local_works WHERE id=4").get(), "an existing directory must remain indexed");
  for (const id of [3, 5, 6, 7]) assert(db.prepare("SELECT 1 FROM local_files WHERE id=?").get(id));
  assert.equal(refreshed, 1); assert.equal(rawUserState(), userBefore);
  assert.equal(fs.readFileSync(present.path, "utf8"), "safe");
  assert.deepEqual(cleanup([missing]).removedFileIds, []); assert.equal(refreshed, 1);

  const reserved = add(8, path.join(root, "moving"));
  db.exec("INSERT INTO work_move_path_reservations VALUES('1','')");
  assert.throws(() => cleanup([reserved]), { statusCode: 409 });
  assert(db.prepare("SELECT 1 FROM local_files WHERE id=8").get()); db.exec("DELETE FROM work_move_path_reservations");
  const rollback = add(9, path.join(root, "rollback"));
  db.exec("CREATE TRIGGER fixture_fail BEFORE DELETE ON local_files WHEN OLD.id=9 BEGIN SELECT RAISE(ABORT,'fixture rollback'); END");
  assert.throws(() => cleanup([reserved, rollback]), /fixture rollback/);
  assert(db.prepare("SELECT 1 FROM local_files WHERE id=8").get(), "a later failure rolls back earlier row removals");
  assert(db.prepare("SELECT 1 FROM local_works WHERE id=8").get()); db.exec("DROP TRIGGER fixture_fail");

  const linkedTarget = path.join(directory, "escaped"); fs.mkdirSync(linkedTarget);
  const link = path.join(root, "linked"); fs.symlinkSync(linkedTarget, link, "junction");
  const escaped = add(10, link);
  assert.deepEqual(cleanup([escaped]).removedFileIds, []);
  assert(db.prepare("SELECT 1 FROM local_files WHERE id=10").get());

  const create = () => { const service = createDuplicateService({ dbPath, roots: [root, offlineRoot], cleanupMissing: cleanup }); services.push(service); return service; };
  const service = create();
  const beforeGet = db.prepare("SELECT COUNT(*) AS count FROM local_files").get().count;
  await service.list(); assert.equal(db.prepare("SELECT COUNT(*) AS count FROM local_files").get().count, beforeGet, "GET/list never mutates the database");
  const httpCleanup = await service.cleanup({ q: "TEST-100" });
  assert(httpCleanup.removedFileIds.includes("8")); assert(httpCleanup.removedFileIds.includes("9"));
  assert(httpCleanup.uncertainFiles >= 1); assert.equal(rawUserState(), userBefore);
  assert.deepEqual((await service.cleanup({ q: "not-a-match" })).removedFileIds, []);
  await assert.rejects(service.cleanup({ groupId: "invalid" }), { statusCode: 400 });
  assert.equal((await create().list({ q: "moving" })).total, 0, "stale paths stay gone after service recreation");
  let releaseSnapshot;
  const gate = new Promise(resolve => { releaseSnapshot = resolve; }), heldSnapshot = duplicateSnapshot(dbPath);
  const racing = createDuplicateService({ dbPath, roots: [root], cleanupMissing: cleanup, snapshotLoader: async () => { await gate; return heldSnapshot; } });
  services.push(racing);
  const startingHash = racing.startCheck(heldSnapshot.groups[0].id).then(() => null, error => error);
  const pendingCleanup = racing.cleanup({ q: "not-a-match" });
  releaseSnapshot();
  assert.equal((await startingHash).statusCode, 409, "hash startup must not race an index cleanup across snapshot loading");
  await pendingCleanup;
  let releaseStopping;
  const stoppingGate = new Promise(resolve => { releaseStopping = resolve; });
  let cleanupCalls = 0;
  const stopping = createDuplicateService({ dbPath, roots: [root], cleanupMissing: () => { cleanupCalls++; }, snapshotLoader: async () => { await stoppingGate; return heldSnapshot; } });
  services.push(stopping);
  const stoppedCleanup = stopping.cleanup().then(() => null, error => error);
  stopping.beginStop(); releaseStopping();
  assert.equal((await stoppedCleanup).statusCode, 503); assert.equal(cleanupCalls, 0, "shutdown must prevent a pending index mutation");
  console.log("Duplicate index cleanup verified: exact row identity, absent directories and sidecar refs, video-only absence, offline/outside/junction protection, reservations, rollback, idempotency, read-only GET, scoped cleanup and preserved works/user state/media.");
} finally {
  await Promise.allSettled(services.map(service => service.stop()));
  db.close(); temporary.cleanup();
}
