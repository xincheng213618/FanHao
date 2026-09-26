import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createCoreLibraryService } from "../src/modules/fanhao/server/library/core-library-service.js";
import { createPersonFolderMutationService } from "../src/modules/fanhao/server/people/person-folder-mutation-service.js";
import { createPersonLibraryService } from "../src/modules/fanhao/server/people/person-library-service.js";
import { routeAdminApi } from "../src/modules/system/server/admin/routes.js";

function withinRoot(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function createDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("ATTACH DATABASE ':memory:' AS fanhao_images");
  db.exec(`
    CREATE TABLE people (
      id INTEGER PRIMARY KEY,
      name TEXT,
      display_name TEXT,
      folder_path TEXT,
      updated_at TEXT
    );
    CREATE TABLE work_people (work_id INTEGER, person_id INTEGER, role TEXT);
    CREATE TABLE person_library_locations(id INTEGER PRIMARY KEY,person_id INTEGER,path TEXT,path_key TEXT UNIQUE,updated_at TEXT);
    CREATE TABLE local_works (
      id INTEGER PRIMARY KEY,
      work_id INTEGER,
      local_path TEXT,
      source_info_path TEXT,
      updated_at TEXT
    );
    CREATE TABLE local_files (
      id INTEGER PRIMARY KEY,
      local_work_id INTEGER,
      file_path TEXT,
      relative_path TEXT,
      updated_at TEXT
    );
    CREATE TABLE video_probe_cache (
      file_id TEXT,
      file_path TEXT,
      updated_at TEXT,
      PRIMARY KEY(file_id, file_path)
    );
    CREATE TABLE work_move_path_reservations (
      job_id TEXT,
      old_path TEXT,
      new_path TEXT,
      released_at TEXT
    );
    CREATE TABLE fanhao_images.images (
      id INTEGER PRIMARY KEY,
      local_path TEXT,
      storage_path TEXT,
      updated_at TEXT
    );
    CREATE TABLE fanhao_images.local_image_cache (
      file_id TEXT PRIMARY KEY,
      file_path TEXT,
      relative_path TEXT,
      updated_at TEXT
    );
    CREATE TABLE fanhao_images.actor_profile_image_staging (
      operation_id TEXT PRIMARY KEY,
      local_path TEXT,
      updated_at TEXT
    );
  `);
  return db;
}

function seedDatabase(db, fixture) {
  const workPath = path.join(fixture.source, "WORK-001");
  const videoPath = path.join(workPath, "video.mp4");
  const infoPath = path.join(workPath, "info.txt");
  const similarPrefixPath = path.join(`${fixture.source}-archive`, "video.mp4");
  db.prepare("INSERT INTO people VALUES (1, 'Person', 'Person', ?, '')").run(fixture.source);
  db.prepare("INSERT INTO person_library_locations VALUES(1,1,?,?, '')").run(fixture.source, fixture.source.replaceAll("\\", "/").toLowerCase());
  db.prepare("INSERT INTO work_people VALUES (101, 1, 'actor')").run();
  db.prepare("INSERT INTO local_works VALUES (11, 101, ?, ?, '')").run(workPath, infoPath);
  db.prepare("INSERT INTO local_files VALUES (21, 11, ?, ?, '')").run(videoPath, path.relative(fixture.root, videoPath));
  db.prepare("INSERT INTO local_files VALUES (22, 12, ?, ?, '')").run(similarPrefixPath, path.relative(fixture.root, similarPrefixPath));
  db.prepare("INSERT INTO video_probe_cache VALUES ('video-1', ?, '')").run(videoPath);
  db.prepare("INSERT INTO fanhao_images.images VALUES (31, ?, ?, '')").run(
    path.join(workPath, "cover.jpg"),
    path.join(workPath, "stored-cover.jpg")
  );
  db.prepare("INSERT INTO fanhao_images.local_image_cache VALUES ('image-1', ?, ?, '')").run(
    path.join(workPath, "thumb.jpg"),
    path.relative(fixture.root, path.join(workPath, "thumb.jpg"))
  );
  db.prepare("INSERT INTO fanhao_images.actor_profile_image_staging VALUES ('stage-1', ?, '')").run(
    path.join(workPath, "avatar.jpg")
  );
}

function createFixture(label, { createSource = true, createTarget = false, completeTarget = true } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `fanhao-person-folder-${label}-`));
  const root = path.join(temp, "library");
  const source = path.join(root, "Old Person");
  const target = path.join(root, "New Person");
  fs.mkdirSync(root, { recursive: true });
  if (createSource) {
    fs.mkdirSync(path.join(source, "WORK-001"), { recursive: true });
    fs.writeFileSync(path.join(source, "WORK-001", "video.mp4"), "fixture");
    fs.writeFileSync(path.join(source, "WORK-001", "info.txt"), "fixture");
  }
  if (createTarget) {
    fs.mkdirSync(completeTarget ? path.join(target, "WORK-001") : target, { recursive: true });
    if (completeTarget) {
      fs.writeFileSync(path.join(target, "WORK-001", "video.mp4"), "fixture");
      fs.writeFileSync(path.join(target, "WORK-001", "info.txt"), "fixture");
    }
  }
  const db = createDatabase();
  const fixture = { db, root, source, target, temp };
  seedDatabase(db, fixture);
  let refreshCount = 0;
  const service = createPersonFolderMutationService({
    ensureLibraryDirectoryPath(value, label) {
      const resolved = path.resolve(value);
      if (!withinRoot(resolved, root)) {
        const error = new Error(`${label}不在资料库根目录内`);
        error.statusCode = 400;
        throw error;
      }
      return resolved;
    },
    getCoreDb: () => db,
    hasCoreDb: () => true,
    refreshLibrary: () => { refreshCount += 1; },
    relativeFromRoot: (value) => path.relative(root, value).replaceAll(path.sep, "/"),
    resolveLibraryPersonByPublicId(personId) {
      const person = db.prepare("SELECT id, display_name, folder_path FROM people WHERE id = ?").get(Number(personId));
      return person ? {
        id: String(person.id),
        name: person.display_name,
        relativePath: person.folder_path,
        sourcePaths: [person.folder_path]
      } : null;
    },
    sourcePathToAbsolute: (value) => path.resolve(String(value || "").replaceAll("/", path.sep)),
    warn() {}
  });
  return { ...fixture, get refreshCount() { return refreshCount; }, service };
}

function assertDatabasePaths(fixture, targetPath) {
  assert.equal(fixture.db.prepare("SELECT path FROM person_library_locations WHERE id=1").get().path,targetPath);
  const expectedWork = path.join(targetPath, "WORK-001");
  assert.equal(fixture.db.prepare("SELECT folder_path FROM people WHERE id = 1").get().folder_path, targetPath);
  assert.equal(fixture.db.prepare("SELECT local_path FROM local_works WHERE id = 11").get().local_path, expectedWork);
  assert.equal(fixture.db.prepare("SELECT source_info_path FROM local_works WHERE id = 11").get().source_info_path, path.join(expectedWork, "info.txt"));
  assert.equal(fixture.db.prepare("SELECT file_path FROM local_files WHERE id = 21").get().file_path, path.join(expectedWork, "video.mp4"));
  assert.equal(
    fixture.db.prepare("SELECT file_path FROM local_files WHERE id = 22").get().file_path,
    path.join(`${fixture.source}-archive`, "video.mp4"),
    "a similar path prefix without a separator boundary must remain unchanged"
  );
  assert.equal(fixture.db.prepare("SELECT relative_path FROM local_files WHERE id = 21").get().relative_path, path.relative(fixture.root, path.join(expectedWork, "video.mp4")).replaceAll(path.sep, "/"));
  assert.equal(fixture.db.prepare("SELECT file_path FROM video_probe_cache WHERE file_id = 'video-1'").get().file_path, path.join(expectedWork, "video.mp4"));
  assert.equal(fixture.db.prepare("SELECT local_path FROM fanhao_images.images WHERE id = 31").get().local_path, path.join(expectedWork, "cover.jpg"));
  assert.equal(fixture.db.prepare("SELECT storage_path FROM fanhao_images.images WHERE id = 31").get().storage_path, path.join(expectedWork, "stored-cover.jpg"));
  assert.equal(fixture.db.prepare("SELECT file_path FROM fanhao_images.local_image_cache WHERE file_id = 'image-1'").get().file_path, path.join(expectedWork, "thumb.jpg"));
  assert.equal(fixture.db.prepare("SELECT local_path FROM fanhao_images.actor_profile_image_staging WHERE operation_id = 'stage-1'").get().local_path, path.join(expectedWork, "avatar.jpg"));
}

function cleanup(fixture) {
  fixture.db.close();
  assert.equal(path.dirname(path.resolve(fixture.temp)), path.resolve(os.tmpdir()));
  fs.rmSync(fixture.temp, { recursive: true, force: true });
}

{
  const fixture = createFixture("rename");
  try {
    fixture.db.prepare("UPDATE local_files SET file_path=? WHERE id=21").run(path.join(fixture.source,"WORK-001","video.mp4").replaceAll("\\", "/"));
    const result = fixture.service.renamePersonFolder({
      personId: "1",
      sourcePath: fixture.source,
      folderName: path.basename(fixture.target)
    });
    assert.equal(result.mode, "rename");
    assert.equal(fs.existsSync(fixture.source), false);
    assert.equal(fs.statSync(fixture.target).isDirectory(), true);
    assertDatabasePaths(fixture, fixture.target);
    assert.equal(fixture.db.prepare("SELECT status FROM person_folder_operations").get().status, "completed");
    assert.equal(fixture.refreshCount, 1);
  } finally {
    cleanup(fixture);
  }
}

{
  const fixture = createFixture("relink", { createSource: false, createTarget: true });
  try {
    const result = fixture.service.relinkPersonFolder({
      personId: "1",
      sourcePath: fixture.source,
      targetPath: fixture.target
    });
    assert.equal(result.mode, "relink");
    assertDatabasePaths(fixture, fixture.target);
    assert.equal(fixture.db.prepare("SELECT status FROM person_folder_operations").get().status, "completed");
  } finally {
    cleanup(fixture);
  }
}

{
  const fixture = createFixture("incomplete", { createSource: false, createTarget: true, completeTarget: false });
  try {
    assert.throws(
      () => fixture.service.relinkPersonFolder({ personId: "1", sourcePath: fixture.source, targetPath: fixture.target }),
      (error) => error?.code === "PERSON_FOLDER_RELINK_INCOMPLETE"
    );
    assert.equal(fixture.db.prepare("SELECT folder_path FROM people WHERE id = 1").get().folder_path, fixture.source);
    assert.equal(fixture.db.prepare("SELECT COUNT(*) AS count FROM person_folder_operations").get().count, 0);
  } finally {
    cleanup(fixture);
  }
}

{
  const fixture = createFixture("rollback");
  try {
    fixture.db.exec(`
      CREATE TRIGGER reject_person_folder_update
      BEFORE UPDATE OF local_path ON local_works
      BEGIN
        SELECT RAISE(ABORT, 'fixture metadata failure');
      END;
    `);
    assert.throws(() => fixture.service.renamePersonFolder({
      personId: "1",
      sourcePath: fixture.source,
      folderName: path.basename(fixture.target)
    }), /fixture metadata failure/);
    assert.equal(fs.statSync(fixture.source).isDirectory(), true);
    assert.equal(fs.existsSync(fixture.target), false);
    assert.equal(fixture.db.prepare("SELECT folder_path FROM people WHERE id = 1").get().folder_path, fixture.source);
    assert.equal(fixture.db.prepare("SELECT status FROM person_folder_operations").get().status, "failed");
  } finally {
    cleanup(fixture);
  }
}

{
  const fixture = createFixture("recovery");
  try {
    fixture.service.recoverPendingOperations();
    fs.renameSync(fixture.source, fixture.target);
    const timestamp = new Date().toISOString();
    fixture.db.prepare(`
      INSERT INTO person_folder_operations(
        operation_id, person_id, mode, source_path, target_path, status, error, created_at, updated_at, completed_at
      ) VALUES ('recover-1', '1', 'rename', ?, ?, 'filesystem_moved', '', ?, ?, '')
    `).run(fixture.source, fixture.target, timestamp, timestamp);
    const recovered = fixture.service.recoverPendingOperations();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].recovered, true);
    assertDatabasePaths(fixture, fixture.target);
    assert.equal(fixture.db.prepare("SELECT status FROM person_folder_operations WHERE operation_id = 'recover-1'").get().status, "completed");
  } finally {
    cleanup(fixture);
  }
}

{
  const missingRoot = path.join(os.tmpdir(), "fanhao-person-folder-disconnected-root");
  const missingSource = path.join(missingRoot, "Missing Person");
  const person = {
    id: "1",
    name: "Missing Person",
    relativePath: missingSource,
    sourcePaths: [missingSource],
    works: ["101"]
  };
  const library = {
    people: [person],
    peopleById: new Map([[person.id, person]]),
    worksById: new Map([["101", { id: "101", videos: [], images: [], infos: [] }]]),
    filesById: new Map(),
    totals: {}
  };
  const service = createPersonLibraryService({
    actorProfileSearchNames: () => [],
    compareNaturalTitle: () => 0,
    getLibrary: () => library,
    libraryIndexService: {},
    libraryOpenRoots: () => [missingRoot],
    libraryRoots: [missingRoot],
    normalizeSourcePath: (value) => String(value || "").toLowerCase(),
    pathWithinRoot: withinRoot,
    relativeFromRoot: (value) => value,
    rootLabel: () => "fixture",
    safeStat: () => null,
    scanPersonDirectory: () => [],
    sourcePathToAbsolute: (value) => path.resolve(value),
    warn() {}
  });
  assert.throws(
    () => service.refreshPerson("1"),
    (error) => error?.statusCode === 409 && error?.code === "PERSON_FOLDER_DISCONNECTED"
  );
  assert.equal(library.worksById.has("101"), true, "a disconnected person folder must not erase the previous local-work record");
}

{
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-person-folder-identity-"));
  const root = path.join(temp, "library");
  const declaredFolder = path.join(root, "長谷川栞");
  const workPath = path.join(declaredFolder, "WORK-001");
  fs.mkdirSync(workPath, { recursive: true });
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE people (
      id INTEGER PRIMARY KEY,
      name TEXT,
      display_name TEXT,
      folder_path TEXT
    );
  `);
  db.prepare("INSERT INTO people VALUES (1, '[長谷川栞] Shiori Hasegawa', '[長谷川栞] Shiori Hasegawa', ?)").run(declaredFolder);
  db.prepare("INSERT INTO people VALUES (2, '長谷川栞', '長谷川栞', NULL)").run();
  db.prepare("INSERT INTO people VALUES (3, '長谷川栞', '長谷川栞', NULL)").run();
  const normalizeName = (value) => String(value || "").replace(/\s+/gu, "").toLowerCase();
  const coreLibraryService = createCoreLibraryService({
    getCoreDb: () => db,
    hasCoreDb: () => true,
    libraryRoots: [root],
    normalizePersonSearchValue: normalizeName,
    pathWithinRoot: withinRoot,
    sourcePathToAbsolute: (value) => value ? path.resolve(String(value)) : "",
    uniquePersonNames: (values) => [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
  });
  try {
    const peopleByFolder = coreLibraryService.peopleByFolderName(db);
    const matchedPerson = coreLibraryService.personFromLocalPath(peopleByFolder, workPath);
    assert.equal(String(matchedPerson?.id || ""), "1", "declared folder_path must win over ambiguous same-name people");
    // Indexed paths must not enumerate all declarations for every work.
    peopleByFolder.locations = new Proxy(peopleByFolder.locations, {
      get(target, property, receiver) {
        if (property === "filter" || property === Symbol.iterator) throw new Error("unexpected full directory scan");
        return Reflect.get(target, property, receiver);
      }
    });
    for (let index = 0; index < 1000; index++) {
      assert.equal(coreLibraryService.personFromLocalPath(peopleByFolder, workPath)?.id, 1);
    }
  } finally {
    db.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

{
  let response = null;
  let mutation = null;
  const handled = await routeAdminApi(
    { method: "POST" },
    {},
    new URL("http://127.0.0.1/api/admin/person-folder/relink"),
    {
      adminPersonService: {
        mutatePersonFolderPayload(body, mode) {
          mutation = { body, mode };
          return { ok: true };
        }
      },
      readJsonBody: async () => ({ personId: "1", sourcePath: "old", targetPath: "new" }),
      requireLocalAdmin: () => true,
      sendJson: (_res, statusCode, payload) => { response = { statusCode, payload }; }
    }
  );
  assert.equal(handled, true);
  assert.deepEqual(mutation, {
    body: { personId: "1", sourcePath: "old", targetPath: "new" },
    mode: "relink"
  });
  assert.deepEqual(response, { statusCode: 200, payload: { ok: true } });
}

{
  const profileSource = fs.readFileSync(path.resolve("public/modules/fanhao/person-profile.js"), "utf8");
  assert(profileSource.includes("/api/admin/person-folder/rename"));
  assert(profileSource.includes("/api/admin/person-folder/relink"));
  assert(profileSource.includes("重命名本地文件夹") && profileSource.includes("重新关联已有文件夹"));
}

console.log("Person folder mutation verification passed.");
