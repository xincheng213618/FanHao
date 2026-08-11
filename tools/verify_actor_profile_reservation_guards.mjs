import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAdminCoreMutationService } from "../src/modules/fanhao/server/admin/admin-core-mutation-service.js";
import { createActorAvatarService } from "../src/modules/fanhao/server/people/actor-avatar-service.js";
import { createManualCoverStateService } from "../src/modules/fanhao/server/works/manual-cover-state-service.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

const temporary = createVerifiedTempDir("fanhao-avatar-guard-");
const imageDbPath = path.join(temporary.tempDir, "images.sqlite");
const db = new DatabaseSync(path.join(temporary.tempDir, "main.sqlite"));

function reserved(error) {
  return error?.code === "ACTOR_PROFILE_RESERVED" && error?.statusCode === 409;
}

function fileStat(value) {
  try { return fs.statSync(value); } catch { return null; }
}

try {
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  db.prepare("ATTACH DATABASE ? AS fanhao_images").run(imageDbPath);
  db.exec(`
    PRAGMA fanhao_images.journal_mode = WAL;
    PRAGMA fanhao_images.synchronous = FULL;
    CREATE TABLE people(
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_search TEXT,
      display_name TEXT, folder_path TEXT, movie_count INTEGER, status TEXT,
      error TEXT, source TEXT, created_at TEXT, updated_at TEXT, gender TEXT
    );
    CREATE TABLE person_aliases(
      id INTEGER PRIMARY KEY, person_id INTEGER, alias TEXT, alias_search TEXT,
      source TEXT, updated_at TEXT DEFAULT '', UNIQUE(person_id, alias_search, source)
    );
    CREATE TABLE person_external_refs(
      id INTEGER PRIMARY KEY, person_id INTEGER, provider TEXT, external_key TEXT,
      url TEXT, source TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(provider, external_key)
    );
    CREATE TABLE work_people(
      work_id INTEGER, person_id INTEGER, role TEXT, sort_order INTEGER,
      source TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(work_id, person_id, role)
    );
    CREATE TABLE works(id INTEGER PRIMARY KEY, fields_json TEXT, updated_at TEXT);
    CREATE TABLE local_works(id INTEGER PRIMARY KEY, work_id INTEGER, local_path TEXT, source_info_path TEXT, updated_at TEXT);
    CREATE TABLE fanhao_images.images(
      id INTEGER PRIMARY KEY, owner_type TEXT, owner_id INTEGER, kind TEXT,
      source_type TEXT, local_path TEXT, remote_url TEXT, storage_path TEXT,
      mime TEXT, image_blob BLOB, width INTEGER, height INTEGER, byte_size INTEGER,
      sort_order INTEGER, status TEXT, error TEXT, source TEXT,
      legacy_table TEXT, legacy_key TEXT, created_at TEXT, updated_at TEXT,
      UNIQUE(owner_type, owner_id, kind, source_type, remote_url, local_path, sort_order)
    );
    CREATE TABLE actor_profile_publications(
      person_id INTEGER PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL,
      intent_sha256 TEXT NOT NULL, published_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE cross_store_aggregate_reservations(
      aggregate_key TEXT PRIMARY KEY, op_id TEXT NOT NULL,
      aggregate_seq INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO people VALUES
      (1, 'Alice', 'alice', 'Alice', NULL, 0, 'ok', NULL, 'migration', 'old', 'old', 'unknown'),
      (2, 'Beth', 'beth', 'Beth', NULL, 0, 'ok', NULL, 'migration', 'old', 'old', 'unknown');
  `);
  const reserve = db.prepare("INSERT INTO cross_store_aggregate_reservations VALUES (?, ?, 1, 'now')");
  const clear = () => db.exec("DELETE FROM cross_store_aggregate_reservations");

  const manual = createManualCoverStateService({
    getCoreDb: () => db,
    invalidateActorProfiles: () => { throw new Error("blocked manual cover must not publish caches"); },
    maxActorAvatarBytes: 1024
  });
  reserve.run("person-avatar:1", "pending-manual");
  assert.throws(() => manual.replaceManualPersonAvatar(1, {
    blob: Buffer.from("manual"), byteSize: 6, legacyKey: "manual", mime: "image/jpeg",
    now: "now", source: "manual_upload", sourceType: "local"
  }), reserved);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM fanhao_images.images").get().count, 0);
  clear();

  const avatarRoot = path.join(temporary.tempDir, "avatar-tree");
  const avatarDir = path.join(avatarRoot, "Content", "Actors");
  fs.mkdirSync(avatarDir, { recursive: true });
  fs.writeFileSync(path.join(avatarRoot, "Filetree.json"), JSON.stringify({ Content: { Actors: { Alice: "Alice.jpg" } } }));
  fs.writeFileSync(path.join(avatarDir, "Alice.jpg"), Buffer.from("avatar-file"));
  const actorAvatar = createActorAvatarService({
    avatarExts: new Set([".jpg"]),
    fileBase: (value) => path.basename(value, path.extname(value)),
    getCoreDb: () => db,
    getPeople: () => [{ id: "1", name: "Alice" }],
    getPersonById: () => ({ id: "1", name: "Alice" }),
    getProfileRow: () => ({ avatar_url: "", display_name: "Alice" }),
    getPublicProfile: () => ({ avatarUrl: "" }),
    getSearchNames: (person) => [person.name],
    invalidateProfiles: () => { throw new Error("blocked actor import must not publish caches"); },
    localAvatarSource: "fixture",
    maxBytes: 1024,
    normalizeExt: (value) => path.extname(value).toLowerCase(),
    publicPerson: (person) => person,
    safeStat: fileStat
  });
  reserve.run("person-avatar:1", "pending-import");
  assert.throws(() => actorAvatar.importCandidate(avatarRoot, "1", "Content/Actors/Alice.jpg"), reserved);
  assert.throws(() => actorAvatar.importFromFiletree(avatarRoot, { replace: true }), reserved);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM fanhao_images.images").get().count, 0);
  assert.equal(db.prepare("SELECT updated_at FROM people WHERE id = 1").get().updated_at, "old");
  clear();

  const admin = createAdminCoreMutationService({
    getCoreDb: () => db,
    hasCoreDb: () => true,
    invalidateActorMovies: () => { throw new Error("blocked merge must not invalidate"); },
    invalidateActorProfiles: () => { throw new Error("blocked merge must not invalidate"); },
    invalidatePersonMerge: () => { throw new Error("blocked merge must not invalidate"); },
    invalidateTableStamp: () => { throw new Error("blocked merge must not invalidate"); },
    normalizePersonSearchValue: (value) => String(value || "").toLowerCase(),
    refreshLibrary: () => { throw new Error("blocked merge must not refresh"); },
    resetWorkSearch: () => { throw new Error("blocked merge must not reset search"); },
    uniquePersonNames: (values) => [...new Set((values || []).filter(Boolean))],
    uniqueTextArray: (values) => [...new Set((values || []).map(String))]
  });
  for (const guardedId of [1, 2]) {
    reserve.run(`person-avatar:${guardedId}`, `pending-merge-${guardedId}`);
    assert.throws(() => admin.mergePeopleIntoTarget(1, [2]), reserved);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM people").get().count, 2);
    clear();
  }

  const libraryRoot = path.join(temporary.tempDir, "library");
  const moveSource = path.join(libraryRoot, "Source", "WORK-10");
  fs.mkdirSync(moveSource, { recursive: true });
  db.prepare("INSERT INTO works VALUES (10, '[]', 'old')").run();
  db.prepare("INSERT INTO local_works VALUES (10, 10, ?, '', 'old')").run(moveSource);
  const insideLibrary = (value) => {
    const resolved = path.resolve(value);
    const relative = path.relative(path.resolve(libraryRoot), resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("fixture path escaped library root");
    return resolved;
  };
  const moveAdmin = createAdminCoreMutationService({
    actorIdFromJavdbUrl: (value) => String(value || "").split("/").pop(),
    canonicalJavdbActorUrl: (value) => String(value || ""),
    cleanPersonNamePart: (value) => String(value || "").trim(),
    corePersonFallbackRecord: (id) => ({ id: String(id), name: "Alice" }),
    ensureLibraryDirectoryPath: insideLibrary,
    getCoreDb: () => db,
    hasCoreDb: () => true,
    invalidateActorMovies() {},
    invalidateActorProfiles: () => { throw new Error("blocked move must not invalidate"); },
    invalidatePersonMerge: () => { throw new Error("blocked move must not invalidate"); },
    invalidateTableStamp: () => { throw new Error("blocked move must not invalidate"); },
    libraryOpenRoots: () => [libraryRoot],
    normalizePersonGender: (value) => String(value || "unknown"),
    normalizePersonSearchValue: (value) => String(value || "").trim().toLowerCase(),
    relativeFromRoot: (value) => path.relative(libraryRoot, value),
    resolveLibraryPersonByPublicId: () => ({ id: "1", name: "Alice", relativePath: "Alice", sourcePaths: ["Alice"] }),
    resolveLibraryWorkByPublicId: (id) => id === "10" ? { id: "10", missingLocal: false, title: "WORK-10" } : null,
    safeStat: fileStat,
    sourcePathToAbsolute: (value) => path.resolve(value),
    uniquePersonNames: (values) => [...new Set((values || []).filter(Boolean))],
    uniqueTextArray: (values) => [...new Set((values || []).filter(Boolean))]
  });
  reserve.run("person-avatar:1", "pending-move-target");
  assert.throws(() => moveAdmin.prepareWorkMove("10", "", {
    createPerson: { name: "Alice", displayName: "Alice Changed", folderName: "Alice", rootPath: libraryRoot }
  }), reserved);
  assert.equal(db.prepare("SELECT display_name FROM people WHERE id = 1").get().display_name, "Alice");
  assert.equal(fs.existsSync(path.join(libraryRoot, "Alice")), false);
  clear();

  db.prepare(`
    INSERT INTO person_external_refs(person_id, provider, external_key, url, source, created_at, updated_at)
    VALUES (2, 'javdb-actor', 'shared-owner', 'https://javdb.test/actors/shared-owner', 'fixture', 'old', 'old')
  `).run();
  for (const aggregateKey of ["person-avatar:2", "javdb-actor:shared-owner"]) {
    reserve.run(aggregateKey, `pending-${aggregateKey}`);
    assert.throws(() => moveAdmin.prepareWorkMove("10", "", {
      createPerson: {
        name: "Charlie", displayName: "Charlie", folderName: "Charlie",
        javdbUrl: "https://javdb.test/actors/shared-owner", rootPath: libraryRoot
      }
    }), reserved, `work-move target creation must honor ${aggregateKey}`);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM people WHERE name = 'Charlie'").get().count, 0);
    assert.equal(db.prepare("SELECT person_id FROM person_external_refs WHERE external_key = 'shared-owner'").get().person_id, 2);
    assert.equal(fs.existsSync(path.join(libraryRoot, "Charlie")), false);
    clear();
  }
} finally {
  db.close();
  temporary.cleanup();
}

console.log("actor profile manual/import/merge/move reservation guards passed");
