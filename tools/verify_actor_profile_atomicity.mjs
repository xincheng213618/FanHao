import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createAdminCoreMutationService } from "../src/modules/fanhao/server/admin/admin-core-mutation-service.js";
import { createActorAvatarService } from "../src/modules/fanhao/server/people/actor-avatar-service.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

export function verifyActorProfileAtomicity() {
  const temporary = createVerifiedTempDir("fanhao-actor-atomicity-");
  const db = new DatabaseSync(path.join(temporary.tempDir, "core.sqlite"));
  try {
    createSchema(db, path.join(temporary.tempDir, "images.sqlite"));
    verifyAdminProfileRollback(db);
    verifyLocalAvatarRollback(db, temporary.tempDir);
  } finally {
    db.close();
    temporary.cleanup();
  }
}

function createSchema(db, imageDbPath) {
  db.exec("PRAGMA journal_mode = WAL");
  db.prepare("ATTACH DATABASE ? AS fanhao_images").run(imageDbPath);
  db.exec("PRAGMA fanhao_images.journal_mode = WAL");
  assert.equal(db.prepare("PRAGMA main.journal_mode").get().journal_mode, "wal");
  assert.equal(db.prepare("PRAGMA fanhao_images.journal_mode").get().journal_mode, "wal");
  db.exec(`
    CREATE TABLE people (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      name_search TEXT NOT NULL,
      display_name TEXT,
      gender TEXT NOT NULL,
      movie_count INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE person_external_refs (
      id INTEGER PRIMARY KEY,
      person_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      external_key TEXT NOT NULL,
      url TEXT,
      source TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(provider, external_key)
    );
    CREATE TABLE person_aliases (
      id INTEGER PRIMARY KEY,
      person_id INTEGER NOT NULL,
      alias TEXT NOT NULL,
      alias_search TEXT NOT NULL,
      source TEXT NOT NULL,
      UNIQUE(person_id, alias_search, source)
    );
    CREATE TABLE fanhao_images.images (
      id INTEGER PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      source_type TEXT,
      local_path TEXT,
      remote_url TEXT,
      mime TEXT,
      image_blob BLOB,
      byte_size INTEGER,
      sort_order INTEGER,
      status TEXT,
      source TEXT NOT NULL,
      legacy_table TEXT,
      legacy_key TEXT,
      created_at TEXT,
      updated_at TEXT,
      UNIQUE(owner_type, owner_id, kind, source)
    );
  `);
}

function rows(db, sql, ...params) {
  return db.prepare(sql).all(...params).map((row) => ({ ...row }));
}

function verifyAdminProfileRollback(db) {
  db.exec(`
    INSERT INTO people VALUES (1, 'Old Name', 'oldname', 'Old Display', 'unknown', 3, 'error', 'old error', 'migration', '2026-08-10T00:00:00Z');
    INSERT INTO person_external_refs VALUES (11, 1, 'javdb-actor', 'oldActor', 'https://javdb.test/actors/oldActor', 'manual', 'old-created', 'old-updated');
    INSERT INTO person_aliases VALUES (21, 1, 'Old Alias', 'oldalias', 'manual');
    CREATE TRIGGER fanhao_images.fail_admin_avatar
    BEFORE INSERT ON images
    WHEN NEW.owner_id = 1
    BEGIN
      SELECT RAISE(ABORT, 'forced admin avatar failure');
    END;
  `);
  const beforePerson = rows(db, "SELECT * FROM people WHERE id = 1");
  const beforeRefs = rows(db, "SELECT * FROM person_external_refs WHERE person_id = 1 ORDER BY id");
  const beforeAliases = rows(db, "SELECT * FROM person_aliases WHERE person_id = 1 ORDER BY id");
  const invalidations = [];
  const existing = {
    ...beforePerson[0],
    avatar_mime: null,
    avatar_url: "",
    javdb_actor_id: "oldActor",
    javdb_url: "https://javdb.test/actors/oldActor"
  };
  const service = createAdminCoreMutationService({
    actorIdFromJavdbUrl: (url) => String(url).split("/").pop(),
    actorProfileRow: () => existing,
    canonicalJavdbActorUrls: (values) => (Array.isArray(values) ? values : [values]).map(String).filter(Boolean),
    cleanPersonNamePart: (value) => String(value || "").trim(),
    getCoreDb: () => db,
    invalidateActorMovies: () => invalidations.push("movies"),
    invalidateActorProfiles: () => invalidations.push("profiles"),
    invalidatePersonMerge: () => invalidations.push("merge"),
    invalidateTableStamp: () => invalidations.push("stamp"),
    normalizePersonGender: (value) => String(value || "unknown"),
    normalizePersonSearchValue: (value) => String(value || "").toLowerCase().replaceAll(" ", ""),
    publicActorProfile: (value) => value,
    uniquePersonNames: (values) => [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))]
  });

  assert.throws(
    () => service.upsertActorProfile(
      { id: "1", name: "New Name", gender: "female" },
      {
        aliases: ["New Alias"],
        displayName: "New Display",
        error: null,
        gender: "female",
        javdbUrls: ["https://javdb.test/actors/newActor"],
        movieCount: 99,
        source: "manual",
        sourceAvatarUrl: "https://images.test/new-avatar.jpg",
        status: "ok"
      }
    ),
    /forced admin avatar failure/
  );

  assert.deepEqual(rows(db, "SELECT * FROM people WHERE id = 1"), beforePerson, "all people fields, including updated_at, must roll back after an image failure");
  assert.deepEqual(rows(db, "SELECT * FROM person_external_refs WHERE person_id = 1 ORDER BY id"), beforeRefs, "actor refs must roll back after an image failure");
  assert.deepEqual(rows(db, "SELECT * FROM person_aliases WHERE person_id = 1 ORDER BY id"), beforeAliases, "aliases must roll back after an image failure");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM fanhao_images.images WHERE owner_id = 1").get().count, 0);
  assert.equal(db.isTransaction, false, "a failed admin profile save must release its savepoint");
  assert.deepEqual(invalidations, [], "rolled-back profile state must not be published through caches");
}

function verifyLocalAvatarRollback(db, temporaryDir) {
  const avatarRoot = path.join(temporaryDir, "avatar-tree");
  const contentDir = path.join(avatarRoot, "Content", "group");
  fs.mkdirSync(contentDir, { recursive: true });
  fs.writeFileSync(path.join(avatarRoot, "Filetree.json"), JSON.stringify({ Content: { group: { "Avatar Person.jpg": "avatar.jpg" } } }));
  fs.writeFileSync(path.join(contentDir, "avatar.jpg"), Buffer.from([1, 2, 3, 4]));
  db.exec(`
    INSERT INTO people VALUES (2, 'Avatar Person', 'avatarperson', NULL, 'unknown', 0, 'ok', NULL, 'migration', '2026-08-10T02:00:00Z');
    CREATE TRIGGER fanhao_images.fail_local_avatar
    BEFORE INSERT ON images
    WHEN NEW.owner_id = 2
    BEGIN
      SELECT RAISE(ABORT, 'forced local avatar failure');
    END;
  `);
  const before = rows(db, "SELECT * FROM people WHERE id = 2");
  const invalidations = [];
  const person = { id: "2", name: "Avatar Person" };
  const service = createActorAvatarService({
    avatarExts: new Set([".jpg"]),
    fileBase: (value) => path.basename(value, path.extname(value)),
    getCoreDb: () => db,
    getPeople: () => [person],
    getPersonById: (personId) => (personId === person.id ? person : null),
    getProfileRow: () => ({ avatar_url: "", display_name: null }),
    getPublicProfile: () => ({ avatarUrl: "" }),
    getSearchNames: () => [person.name],
    invalidateProfiles: () => invalidations.push("profiles"),
    localAvatarSource: "local-avatar-test",
    maxBytes: 1024,
    normalizeExt: (value) => path.extname(value).toLowerCase(),
    publicPerson: (value) => value,
    safeStat: (value) => {
      try {
        return fs.statSync(value);
      } catch {
        return null;
      }
    }
  });

  assert.throws(
    () => service.importCandidate(avatarRoot, person.id, "Content/group/avatar.jpg"),
    /forced local avatar failure/
  );
  assert.deepEqual(rows(db, "SELECT * FROM people WHERE id = 2"), before, "local-avatar failure must preserve display_name and updated_at");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM fanhao_images.images WHERE owner_id = 2").get().count, 0);
  assert.equal(db.isTransaction, false, "a failed local avatar save must release its savepoint");
  assert.deepEqual(invalidations, [], "a failed local avatar save must not invalidate committed profile state");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  verifyActorProfileAtomicity();
  console.log("actor profile ordinary-failure atomicity verification passed");
}
