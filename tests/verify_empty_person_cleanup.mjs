import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createEmptyPersonCleanupService } from "../src/modules/fanhao/server/people/empty-person-cleanup-service.js";
import { routeWorksApi } from "../src/modules/fanhao/server/works/routes-api.js";

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-empty-person-"));
const dbPath = path.join(temporaryRoot, "core.sqlite");
const imageDbPath = path.join(temporaryRoot, "images.sqlite");
const db = new DatabaseSync(dbPath);

try {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE people (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT,
      folder_path TEXT,
      movie_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'ok',
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE work_people (work_id INTEGER NOT NULL, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE);
    CREATE TABLE person_aliases (id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE);
    CREATE TABLE person_external_refs (id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE);
    CREATE TABLE person_identity_merges (operation_id TEXT PRIMARY KEY, target_id INTEGER NOT NULL REFERENCES people(id), source_ids_json TEXT);
    CREATE TABLE person_redirects (
      source_id INTEGER PRIMARY KEY REFERENCES people(id),
      target_id INTEGER NOT NULL REFERENCES people(id),
      operation_id TEXT
    );
    CREATE TABLE person_library_locations (
      id INTEGER PRIMARY KEY,
      person_id INTEGER NOT NULL REFERENCES people(id),
      path TEXT NOT NULL,
      source TEXT NOT NULL
    );
    CREATE TABLE actor_profile_publications (person_id INTEGER);
    CREATE TABLE actor_profile_image_revocations (person_id INTEGER);
    CREATE TABLE person_folder_operations (person_id INTEGER);
    CREATE TABLE work_move_jobs (person_id INTEGER);
    ATTACH DATABASE '${imageDbPath.replaceAll("'", "''")}' AS fanhao_images;
    CREATE TABLE fanhao_images.images (owner_type TEXT, owner_id INTEGER);
    CREATE TABLE fanhao_images.actor_profile_image_staging (person_id INTEGER);
    CREATE TABLE fanhao_images.actor_profile_image_gc_receipts (person_id INTEGER);
  `);

  const missingPath = path.join(temporaryRoot, "missing-person");
  const existingPath = path.join(temporaryRoot, "existing-person");
  fs.mkdirSync(existingPath);
  const insertPerson = db.prepare(`INSERT INTO people
    (id, name, display_name, folder_path, movie_count, status, source, updated_at)
    VALUES (?, ?, ?, ?, 0, 'ok', ?, ?)`);
  const insertLocation = db.prepare("INSERT INTO person_library_locations (id, person_id, path, source) VALUES (?, ?, ?, 'fixture')");
  insertPerson.run(1, "Empty", "Empty", missingPath, "manual_move", "2026-09-20T00:00:00.000Z");
  insertLocation.run(1, 1, missingPath);
  insertPerson.run(2, "Existing", "Existing", existingPath, "manual_move", "2026-09-20T00:00:00.000Z");
  insertLocation.run(2, 2, existingPath);
  insertPerson.run(3, "Linked", "Linked", path.join(temporaryRoot, "linked-missing"), "manual_move", "2026-09-20T00:00:00.000Z");
  insertLocation.run(3, 3, path.join(temporaryRoot, "linked-missing"));
  db.prepare("INSERT INTO work_people VALUES (30, 3)").run();
  insertPerson.run(4, "External", "External", path.join(temporaryRoot, "external-missing"), "manual_move", "2026-09-20T00:00:00.000Z");
  insertLocation.run(4, 4, path.join(temporaryRoot, "external-missing"));
  db.prepare("INSERT INTO person_external_refs VALUES (1, 4)").run();
  insertPerson.run(5, "Metadata", "Metadata", path.join(temporaryRoot, "metadata-missing"), "manual", "2026-09-20T00:00:00.000Z");
  insertLocation.run(5, 5, path.join(temporaryRoot, "metadata-missing"));
  insertPerson.run(6, "Changed", "Changed", path.join(temporaryRoot, "changed-missing"), "manual_move", "2026-09-20T00:00:00.000Z");
  insertLocation.run(6, 6, path.join(temporaryRoot, "changed-missing"));

  let refreshCount = 0;
  const invalidations = [];
  const service = createEmptyPersonCleanupService({
    actorMovieRows: () => [],
    getCoreDb: () => db,
    hasCoreDb: () => true,
    invalidateTableStamp: (...tables) => invalidations.push(tables),
    refreshLibrary: () => {
      refreshCount += 1;
      return { people: [] };
    },
    resolveLibraryPersonByPublicId: (personId) => ({ id: String(personId), works: [] }),
    safeStat: (value) => {
      try { return fs.statSync(value); } catch { return null; }
    },
    sourcePathToAbsolute: (value) => path.resolve(value)
  });

  const preview = service.preview("1");
  assert.equal(preview.eligible, true);
  assert.equal(preview.sourcePaths.length, 1);
  assert.match(preview.confirmationToken, /^[a-f0-9]{64}$/);
  assert.throws(
    () => service.remove("1", { confirmationToken: "wrong" }),
    (error) => error.code === "EMPTY_PERSON_PREVIEW_STALE"
  );
  assert.equal(db.prepare("SELECT COUNT(*) count FROM people WHERE id = 1").get().count, 1);

  const removed = service.remove("1", { confirmationToken: preview.confirmationToken });
  assert.equal(removed.deleted, true);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM people WHERE id = 1").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM person_library_locations WHERE person_id = 1").get().count, 0);
  assert.equal(refreshCount, 1);
  assert.deepEqual(invalidations, [["people", "person_library_locations"]]);

  assert.equal(service.preview("2").blockers.some((item) => item.code === "SOURCE_PATH_EXISTS"), true);
  assert.equal(service.preview("3").blockers.some((item) => item.code === "PERSON_HAS_WORKS"), true);
  assert.equal(service.preview("4").blockers.some((item) => item.code === "PERSON_HAS_IDENTITY"), true);
  assert.equal(service.preview("5").blockers.some((item) => item.code === "PERSON_SOURCE"), true);

  const changedPreview = service.preview("6");
  db.prepare("UPDATE people SET updated_at = ? WHERE id = 6").run("2026-09-20T00:01:00.000Z");
  assert.throws(
    () => service.remove("6", { confirmationToken: changedPreview.confirmationToken }),
    (error) => error.code === "EMPTY_PERSON_PREVIEW_STALE"
  );
  assert.equal(db.prepare("SELECT COUNT(*) count FROM people WHERE id = 6").get().count, 1);

  let routeAuthorized = false;
  let routedPayload = null;
  const routed = await routeWorksApi(
    { method: "POST" },
    {},
    new URL("http://127.0.0.1/api/people/1845/empty-cleanup"),
    {
      notFound: () => {},
      personDetailService: {
        cleanupEmptyPerson(personId, body) {
          assert.equal(personId, "1845");
          assert.deepEqual(body, { preview: true });
          return { ok: true, preview: true };
        }
      },
      readJsonBody: async () => ({ preview: true }),
      requireLocalAdmin: () => {
        routeAuthorized = true;
        return true;
      },
      requireTrustedFileMutation: () => false,
      sendJson: (_res, status, payload) => {
        routedPayload = { status, payload };
      },
      workDetailService: {},
      workMutationService: {},
      workQueryService: {}
    }
  );
  assert.equal(routed, true);
  assert.equal(routeAuthorized, true);
  assert.deepEqual(routedPayload, { status: 200, payload: { ok: true, preview: true } });

  const routeSource = fs.readFileSync(new URL("../src/modules/fanhao/server/works/routes-api.js", import.meta.url), "utf8");
  const clientSource = fs.readFileSync(new URL("../public/modules/fanhao/person-profile.js", import.meta.url), "utf8");
  assert.match(routeSource, /empty-cleanup/);
  assert.match(routeSource, /requireLocalAdmin/);
  assert.match(clientSource, /preview:\s*true/);
  assert.match(clientSource, /confirmationToken:\s*preview\.confirmationToken/);
  assert.match(clientSource, /不会删除任何文件/);

  console.log("empty-person-cleanup: ok");
} finally {
  db.close();
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
