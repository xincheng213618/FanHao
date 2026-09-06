import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createCoreLibrarySyncService } from "../src/modules/fanhao/server/library/core-library-sync-service.js";

const BASE_PATH = "G:\\田中レモン\\IPZZ-932 base";
const COLLISION_PATH = "G:\\田中レモン\\IPZZ-932 base (1)";

function pathKey(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function codeKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function plainRows(rows) {
  return rows.map((row) => ({ ...row }));
}

function createDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE works (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL DEFAULT '',
      code_search TEXT NOT NULL DEFAULT '',
      title TEXT
    );
    CREATE TABLE work_people (
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE local_works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      local_path TEXT,
      source_info_path TEXT,
      source_info_id TEXT,
      source_name TEXT,
      source_size INTEGER,
      source_mtime TEXT,
      detected_code TEXT,
      detected_code_search TEXT NOT NULL DEFAULT '',
      matched_by TEXT NOT NULL DEFAULT 'migration',
      confidence REAL NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE local_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      local_work_id INTEGER REFERENCES local_works(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL UNIQUE,
      file_type TEXT,
      file_path TEXT,
      name TEXT,
      title TEXT,
      ext TEXT,
      relative_path TEXT,
      size INTEGER,
      modified_at TEXT,
      playable INTEGER,
      sort_order INTEGER,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  return db;
}

function seedWorks(db, ids = [77897, 77898]) {
  const insertWork = db.prepare("INSERT INTO works (id, code, code_search, title) VALUES (?, 'IPZZ-932', 'ipzz932', ?)");
  const insertPerson = db.prepare("INSERT INTO work_people (work_id, person_id, role, sort_order) VALUES (?, 610, 'actor', 0)");
  for (const id of ids) {
    insertWork.run(id, id === 77897 ? "IPZZ-932 base" : "IPZZ-932 base (1)");
    insertPerson.run(id);
  }
}

function seedLocalWork(db, id, workId, localPath, fileId = `old-${id}`) {
  db.prepare("INSERT INTO local_works (id, work_id, local_path) VALUES (?, ?, ?)").run(id, workId, localPath);
  db.prepare(
    "INSERT INTO local_files (work_id, local_work_id, file_id, file_type, file_path, name) VALUES (?, ?, ?, 'video', ?, ?)"
  ).run(workId, id, fileId, `${localPath}\\old.mp4`, "old.mp4");
}

function scannedWork(localPath, { size = 100, suffix = "base" } = {}) {
  const videoName = `${suffix}.mp4`;
  return {
    id: `scanned-${suffix}`,
    personId: "610",
    title: path.win32.basename(localPath),
    directoryName: path.win32.basename(localPath),
    relativePath: localPath,
    modifiedAt: "2026-08-30T00:00:00.000Z",
    infoSummary: { code: "IPZZ-932" },
    videos: [{
      id: `video-${suffix}`,
      path: `${localPath}\\${videoName}`,
      relativePath: `${localPath}\\${videoName}`,
      name: videoName,
      title: suffix,
      ext: ".mp4",
      size,
      modifiedAt: "2026-08-30T00:00:00.000Z",
      playable: true
    }],
    images: [],
    infos: []
  };
}

function createService(db, existingPaths = []) {
  const existing = new Set(existingPaths.map(pathKey));
  return createCoreLibrarySyncService({
    fileBase: (value) => path.parse(String(value || "")).name,
    getCoreDb: () => db,
    hasCoreDb: () => true,
    normalizeExt: (value) => path.extname(String(value || "")).toLowerCase(),
    normalizeWorkCode: (value) => String(value || "").match(/IPZZ[-_ ]?932/i)?.[0]?.toUpperCase() || "",
    pathExists: (value) => existing.has(pathKey(value)),
    relativeFromRoot: (value) => value,
    sourcePathToAbsolute: (value) => value,
    storedWorkCodeKey: codeKey,
    workCodeKeys: () => ["ipzz932"]
  });
}

{
  const db = createDb();
  try {
    seedWorks(db);
    seedLocalWork(db, 40654, 77897, BASE_PATH);
    seedLocalWork(db, 40655, 77898, COLLISION_PATH);
    const service = createService(db, [BASE_PATH, COLLISION_PATH]);
    const base = scannedWork(BASE_PATH, { size: 7_782_422_622, suffix: "base" });
    const collision = scannedWork(COLLISION_PATH, { size: 6_186_064_852, suffix: "collision" });

    assert.equal(
      service.workIdForScannedWork(610, { ...base, relativePath: BASE_PATH.toLowerCase().replace(/\\/g, "/") }),
      "77897",
      "exact local-path lookup must normalize Windows separators and case"
    );
    const linkedBase = service.linkedScannedWork(610, base);
    const linkedCollision = service.linkedScannedWork(610, collision);
    assert.equal(linkedBase.id, "77897", "the base directory must retain its own duplicate-code work id");
    assert.equal(linkedCollision.id, "77898", "the numbered directory must retain its own duplicate-code work id");

    service.replaceLocalFilesForWork(linkedBase);
    service.replaceLocalFilesForWork(linkedCollision);
    const reconciliation = service.reconcilePersonLocalWorks(
      [
        { id: "77897", relativePath: BASE_PATH },
        { id: "77898", relativePath: COLLISION_PATH }
      ],
      [linkedBase, linkedCollision]
    );
    assert.deepEqual(reconciliation.deletedLocalWorkIds, [], "exact duplicate-code bindings must not reconcile either local copy away");
    assert.deepEqual(
      plainRows(db.prepare("SELECT id, work_id, local_path, source_size FROM local_works ORDER BY id").all()),
      [
        { id: 40654, work_id: 77897, local_path: BASE_PATH, source_size: 7_782_422_622 },
        { id: 40655, work_id: 77898, local_path: COLLISION_PATH, source_size: 6_186_064_852 }
      ],
      "refreshing base and numbered directories must preserve both local-work identities"
    );
  } finally {
    db.close();
  }
}

{
  const db = createDb();
  try {
    seedWorks(db);
    seedLocalWork(db, 40655, 77898, COLLISION_PATH);
    const service = createService(db, [BASE_PATH]);
    const base = scannedWork(BASE_PATH, { size: 7_782_422_622, suffix: "migrated" });
    const linked = service.linkedScannedWork(610, base);
    assert.equal(linked.id, "77898", "a unique missing-path owner must win over a lower-id no-local duplicate");

    service.replaceLocalFilesForWork(linked);
    const reconciliation = service.reconcilePersonLocalWorks(
      [{ id: "77898", relativePath: COLLISION_PATH }],
      [linked]
    );
    assert.deepEqual(reconciliation.deletedLocalWorkIds, [], "migration must update before reconciliation without deleting the retained row");
    assert.deepEqual(
      plainRows(db.prepare("SELECT id, work_id, local_path, source_size FROM local_works ORDER BY id").all()),
      [{ id: 40655, work_id: 77898, local_path: BASE_PATH, source_size: 7_782_422_622 }],
      "a unique missing path must migrate in place and preserve local_work.id"
    );
    assert.deepEqual(
      plainRows(db.prepare("SELECT local_work_id, file_id FROM local_files ORDER BY id").all()),
      [{ local_work_id: 40655, file_id: "video-migrated" }],
      "in-place migration must replace stale files on the retained local-work row"
    );
  } finally {
    db.close();
  }
}

{
  const db = createDb();
  try {
    seedWorks(db);
    seedLocalWork(db, 40654, 77897, "G:\\田中レモン\\missing-a");
    seedLocalWork(db, 40655, 77898, "G:\\田中レモン\\missing-b");
    const service = createService(db, [BASE_PATH]);
    const before = plainRows(db.prepare("SELECT id, work_id, local_path FROM local_works ORDER BY id").all());
    assert.throws(
      () => service.linkedScannedWork(610, scannedWork(BASE_PATH, { suffix: "ambiguous" })),
      (error) => error?.code === "AMBIGUOUS_LOCAL_WORK_BINDING" && /multiple core works have a missing local path/.test(error.message),
      "multiple missing-path owners must fail closed"
    );
    assert.deepEqual(
      plainRows(db.prepare("SELECT id, work_id, local_path FROM local_works ORDER BY id").all()),
      before,
      "an ambiguous link failure must not write to local_works"
    );
  } finally {
    db.close();
  }
}

{
  const db = createDb();
  try {
    seedWorks(db, [77897]);
    seedLocalWork(db, 40654, 77897, COLLISION_PATH);
    const service = createService(db, [BASE_PATH, COLLISION_PATH]);
    const linked = service.linkedScannedWork(610, scannedWork(BASE_PATH, { suffix: "additional" }));
    assert.equal(linked.id, "77897", "a sole metadata work remains the only safe owner for an additional local copy");
    service.replaceLocalFilesForWork(linked);
    assert.deepEqual(
      plainRows(db.prepare("SELECT id, work_id, local_path FROM local_works ORDER BY id").all()),
      [
        { id: 40654, work_id: 77897, local_path: COLLISION_PATH },
        { id: 40655, work_id: 77897, local_path: BASE_PATH }
      ],
      "replaceLocalFilesForWork must insert instead of overwriting another path that still exists"
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM local_files WHERE local_work_id = 40654").get().count,
      1,
      "inserting another local copy must leave the existing copy's files untouched"
    );
  } finally {
    db.close();
  }
}

{
  const db = createDb();
  try {
    seedWorks(db);
    seedLocalWork(db, 40654, 77897, COLLISION_PATH);
    const service = createService(db, [BASE_PATH, COLLISION_PATH]);
    assert.equal(
      service.workIdForScannedWork(610, scannedWork(BASE_PATH, { suffix: "unused-metadata" })),
      "77898",
      "when every recorded path still exists, a unique no-local duplicate is the only safe target"
    );
  } finally {
    db.close();
  }
}

console.log("core library duplicate-code sync verification passed");
