import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createAdminCoreMutationService } from "../src/modules/fanhao/server/admin/admin-core-mutation-service.js";
import { createPersonLibraryService } from "../src/modules/fanhao/server/people/person-library-service.js";
import { createWorkMoveJobService } from "../src/modules/fanhao/server/works/work-move-job-service.js";

const temporaryRoots = [];

async function createFixture(name, fileCount = 8) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `fanhao-move-${name}-`));
  temporaryRoots.push(root);
  const sourcePerson = path.join(root, "source-person");
  const targetPerson = path.join(root, "target-person");
  const source = path.join(sourcePerson, "WORK-001");
  const target = path.join(targetPerson, "WORK-001");
  await fs.promises.mkdir(source, { recursive: true });
  await fs.promises.mkdir(targetPerson, { recursive: true });
  for (let index = 0; index < fileCount; index += 1) {
    const directory = path.join(source, `part-${index % 3}`);
    await fs.promises.mkdir(directory, { recursive: true });
    await fs.promises.writeFile(path.join(directory, `fixture-${index}.bin`), Buffer.alloc(4096 + index, index));
  }
  return { root, source, sourcePerson, target, targetPerson };
}

function createDatabase(root, source) {
  const db = new DatabaseSync(path.join(root, "fixture.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE move_records (
      work_id TEXT PRIMARY KEY,
      person_id TEXT NOT NULL,
      local_path TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO move_records(work_id, person_id, local_path) VALUES ('1', 'source', ?)").run(source);
  return db;
}

function createAdminFixture(db, fixture, { failCommit = false } = {}) {
  const plan = {
    version: 1,
    workId: "1",
    localWorkId: 1,
    personId: "target",
    targetPerson: { id: "target", name: "Target", sourcePaths: [fixture.targetPerson] },
    personDir: fixture.targetPerson,
    oldDir: fixture.source,
    newDir: fixture.target,
    sourceInfoPath: "",
    createdPerson: null,
    before: [{ person_id: "source", name: "Source" }]
  };
  return {
    plan,
    prepareWorkMove() {
      return plan;
    },
    inspectWorkMove(currentPlan) {
      const row = db.prepare("SELECT local_path FROM move_records WHERE work_id = ?").get(currentPlan.workId);
      if (path.resolve(row.local_path) === path.resolve(currentPlan.oldDir)) return "source";
      if (path.resolve(row.local_path) === path.resolve(currentPlan.newDir)) return "target";
      return "conflict";
    },
    commitWorkMove(currentPlan) {
      if (failCommit) throw new Error("fixture database commit failed");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE move_records SET person_id = ?, local_path = ? WHERE work_id = ?")
          .run(currentPlan.personId, currentPlan.newDir, currentPlan.workId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    finalizeWorkMove(currentPlan, move) {
      return {
        moved: true,
        moveMode: move.mode,
        person: currentPlan.targetPerson,
        work: { id: currentPlan.workId, relativePath: currentPlan.newDir }
      };
    }
  };
}

async function waitForJob(service, jobId, statuses, timeoutMs = 12_000) {
  const expected = new Set(statuses);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = service.get(jobId);
    if (expected.has(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${jobId}: ${service.get(jobId).status}/${service.get(jobId).phase}`);
}

async function verifySuccessfulMoveAndIdempotency() {
  const fixture = await createFixture("success", 12);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const service = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    workerDataPatch: { forceCopy: true, delayPerFileMs: 8 }
  });
  const first = service.start("1", { personId: "target", idempotencyKey: "success-fixture" });
  const duplicate = service.start("1", { personId: "target", idempotencyKey: "success-fixture" });
  assert.equal(duplicate.id, first.id, "same idempotency key must reuse one durable job");
  assert.equal(duplicate.attempts, 1, "duplicate enqueue must not increment attempts");
  assert.throws(
    () => service.start("1", { personId: "other-target", idempotencyKey: "conflicting-fixture" }),
    (error) => error?.statusCode === 409 && String(error.message).includes(first.id),
    "one work must not run two conflicting file moves concurrently"
  );
  const completed = await waitForJob(service, first.id, ["completed"]);
  assert.equal(completed.progress, 1);
  assert.equal(completed.result.moveMode, "copy");
  assert.equal(fs.existsSync(fixture.source), false, "source is removed only after the database commit");
  assert.equal(fs.existsSync(fixture.target), true);
  const databaseRow = db.prepare("SELECT * FROM move_records WHERE work_id = '1'").get();
  assert.equal(path.resolve(databaseRow.local_path), path.resolve(fixture.target));
  assert.equal(databaseRow.person_id, "target");
  await service.close();
  db.close();
}

async function verifyActualAdminSqliteCommit() {
  const fixture = await createFixture("admin-commit", 3);
  const db = new DatabaseSync(path.join(fixture.root, "admin-fixture.sqlite"));
  db.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, display_name TEXT, folder_path TEXT);
    CREATE TABLE works (id INTEGER PRIMARY KEY, fields_json TEXT, updated_at TEXT);
    CREATE TABLE work_people (
      work_id INTEGER, person_id INTEGER, role TEXT, sort_order INTEGER, source TEXT,
      created_at TEXT, updated_at TEXT, UNIQUE(work_id, person_id, role)
    );
    CREATE TABLE local_works (
      id INTEGER PRIMARY KEY, work_id INTEGER, local_path TEXT, source_info_path TEXT, updated_at TEXT
    );
    CREATE TABLE local_files (
      id INTEGER PRIMARY KEY, local_work_id INTEGER, file_path TEXT, relative_path TEXT, updated_at TEXT
    );
    CREATE TABLE images (id INTEGER PRIMARY KEY, owner_type TEXT, owner_id INTEGER, local_path TEXT, updated_at TEXT);
    INSERT INTO people VALUES (1, 'Source', 'Source', NULL), (2, 'Target', 'Target', NULL);
    INSERT INTO works VALUES (1, '[{"label":"演员","value":"Source"}]', '');
    INSERT INTO work_people VALUES (1, 1, 'actor', 0, 'fixture', '', '');
  `);
  const infoPath = path.join(fixture.source, "part-0", "fixture-0.bin");
  const imagePath = path.join(fixture.source, "part-1", "fixture-1.bin");
  db.prepare("INSERT INTO local_works VALUES (1, 1, ?, ?, '')").run(fixture.source, infoPath);
  db.prepare("INSERT INTO local_files VALUES (1, 1, ?, ?, '')").run(infoPath, path.relative(fixture.root, infoPath));
  db.prepare("INSERT INTO images VALUES (1, 'work', 1, ?, '')").run(imagePath);

  const withinRoot = (candidate) => {
    const relative = path.relative(path.resolve(fixture.root), path.resolve(candidate));
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  };
  const replacePrefix = (value, oldPrefix, newPrefix) => {
    const relative = path.relative(path.resolve(oldPrefix), path.resolve(String(value || "")));
    return relative && (relative.startsWith("..") || path.isAbsolute(relative)) ? value : path.join(newPrefix, relative);
  };
  let reconciled = null;
  const admin = createAdminCoreMutationService({
    actorIdFromJavdbUrl: () => "",
    actorProfileRow: () => null,
    canonicalJavdbActorUrl: () => "",
    canonicalJavdbActorUrls: () => [],
    cleanPersonNamePart: (value) => String(value || "").trim(),
    coreLocalPathPersonName: () => "",
    coreLocalPersonSourcePath: () => "",
    corePersonFallbackRecord: (id) => ({ id: String(id), name: id === "2" ? "Target" : "Source" }),
    ensureLibraryDirectoryPath: (value) => {
      const resolved = path.resolve(value);
      if (!withinRoot(resolved)) throw new Error("fixture path escaped temporary root");
      return resolved;
    },
    getCoreDb: () => db,
    invalidateActorMovies() {},
    invalidateActorProfiles() {},
    invalidatePersonMerge() {},
    invalidateTableStamp() {},
    hasCoreDb: () => true,
    libraryOpenRoots: () => [fixture.root],
    normalizePersonGender: (value) => value,
    normalizePersonSearchValue: (value) => String(value || "").trim().toLowerCase(),
    parseJsonArray: (value) => JSON.parse(value || "[]"),
    publicActorProfile: (value) => value,
    publicMergedPersonById: () => null,
    publicPerson: (value) => value,
    publicWork: (value) => value,
    reconcileMovedLocalWork: (value) => { reconciled = value; },
    refreshLibrary() {},
    relativeFromRoot: (value) => path.relative(fixture.root, value),
    replacePathPrefix: replacePrefix,
    resolveLibraryPersonByPublicId: (id) => id === "2"
      ? { id: "2", name: "Target", relativePath: fixture.targetPerson, sourcePaths: [fixture.targetPerson] }
      : { id: "1", name: "Source", relativePath: fixture.sourcePerson, sourcePaths: [fixture.sourcePerson] },
    resolveLibraryWorkByPublicId: () => ({ id: "1", title: "WORK-001", missingLocal: false }),
    safeStat: (value) => { try { return fs.statSync(value); } catch { return null; } },
    sourcePathToAbsolute: (value) => path.resolve(value),
    resetWorkSearch() {},
    uniqueTextArray: (values) => [...new Set((values || []).filter(Boolean))],
    uniquePersonNames: (values) => [...new Set((values || []).filter(Boolean))]
  });

  const plan = admin.prepareWorkMove("1", "2", { targetDirectory: fixture.targetPerson });
  await fs.promises.cp(fixture.source, fixture.target, { recursive: true, errorOnExist: true, force: false });
  admin.commitWorkMove(plan);
  const localWork = db.prepare("SELECT * FROM local_works WHERE id = 1").get();
  const localFile = db.prepare("SELECT * FROM local_files WHERE id = 1").get();
  const image = db.prepare("SELECT * FROM images WHERE id = 1").get();
  const actor = db.prepare("SELECT person_id, source FROM work_people WHERE work_id = 1 AND role = 'actor'").get();
  assert.equal(path.resolve(localWork.local_path), path.resolve(fixture.target));
  assert.equal(path.resolve(localFile.file_path), path.resolve(replacePrefix(infoPath, fixture.source, fixture.target)));
  assert.equal(path.resolve(image.local_path), path.resolve(replacePrefix(imagePath, fixture.source, fixture.target)));
  assert.equal(actor.person_id, 2);
  assert.equal(actor.source, "manual_move");
  assert.equal(admin.inspectWorkMove(plan), "target");
  const result = admin.finalizeWorkMove(plan, { mode: "copy" });
  assert.equal(result.moveMode, "copy");
  assert.equal(reconciled.workId, "1");
  db.close();
}

async function verifyIncrementalMemoryReconciliation() {
  const fixture = await createFixture("memory", 1);
  const videoPath = path.join(fixture.source, "part-0", "fixture-0.bin");
  const work = {
    id: "1",
    personId: "source",
    title: "WORK-001",
    relativePath: path.relative(fixture.root, fixture.source),
    coverId: null,
    videoCount: 1,
    playableCount: 1,
    imageCount: 0,
    infoCount: 0,
    videos: [{ id: "video-1", type: "video", path: videoPath, relativePath: path.relative(fixture.root, videoPath), playable: true }],
    images: [],
    infos: []
  };
  const sourcePerson = { id: "source", name: "Source", sourcePaths: [fixture.sourcePerson], relativePath: fixture.sourcePerson, works: ["1"] };
  const targetPerson = { id: "target", name: "Target", sourcePaths: [fixture.targetPerson], relativePath: fixture.targetPerson, works: [] };
  const library = {
    people: [sourcePerson, targetPerson],
    peopleById: new Map([["source", sourcePerson], ["target", targetPerson]]),
    worksById: new Map([["1", work]]),
    filesById: new Map([["video-1", work.videos[0]]]),
    fileRefCounts: new Map([["video-1", 1]]),
    totals: { people: 2, works: 1, videos: 1, playableVideos: 1, images: 0, infoFiles: 0 }
  };
  let invalidated = 0;
  const service = createPersonLibraryService({
    actorProfileSearchNames: () => [],
    compareNaturalTitle: (left, right) => left.title.localeCompare(right.title),
    getLibrary: () => library,
    libraryIndexService: { saveCache() {}, invalidateDerivedCaches() { invalidated += 1; } },
    libraryOpenRoots: () => [fixture.root],
    libraryRoots: [fixture.root],
    normalizeSourcePath: (value) => String(value || "").toLowerCase(),
    pathWithinRoot: () => true,
    relativeFromRoot: (value) => path.relative(fixture.root, value),
    rootLabel: (value) => value,
    safeStat: (value) => { try { return fs.statSync(value); } catch { return null; } },
    scanPersonDirectory: () => [],
    sourcePathToAbsolute: (value) => path.resolve(value)
  });
  service.moveLocalWork({
    beforePersonIds: ["source"],
    newDir: fixture.target,
    oldDir: fixture.source,
    personDir: fixture.targetPerson,
    targetPerson,
    workId: "1"
  });
  assert.equal(library.worksById.get("1").personId, "target");
  assert.equal(path.resolve(library.filesById.get("video-1").path), path.resolve(path.join(fixture.target, "part-0", "fixture-0.bin")));
  assert.equal(library.peopleById.has("source"), false);
  assert.deepEqual(library.peopleById.get("target").works, ["1"]);
  assert.equal(invalidated, 1);
}

function verifySourceStructure() {
  const adminSource = fs.readFileSync(new URL("../src/modules/fanhao/server/admin/admin-core-mutation-service.js", import.meta.url), "utf8");
  const routeSource = fs.readFileSync(new URL("../src/modules/fanhao/server/works/routes-api.js", import.meta.url), "utf8");
  const clientSource = fs.readFileSync(new URL("../public/js/player-page.js", import.meta.url), "utf8");
  assert.equal(/Atomics\.wait|spawnSync|moveDirectorySync|fs\.cpSync/.test(adminSource), false, "move-to-person must not retain synchronous copy or sleep paths");
  assert.match(routeSource, /sendJson\(res, 202, workMutationService\.moveToPerson/);
  assert.ok(routeSource.includes("work-move-jobs"));
  assert.match(clientSource, /waitForWorkMoveJob\(data\.job\)/);
}

async function verifyCrashRecoveryFromPreparedCopy() {
  const fixture = await createFixture("recovery", 6);
  await fs.promises.cp(fixture.source, fixture.target, { recursive: true, errorOnExist: true, force: false });
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const dormant = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db, schedule: () => {} });
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO work_move_jobs (
      id, request_key, work_id, person_id, status, phase, request_json, plan_json,
      attempts, created_at, updated_at
    ) VALUES ('crash-fixture', 'client:crash-fixture', '1', 'target', 'running', 'filesystem_ready', ?, ?, 1, ?, ?)
  `).run(JSON.stringify({ personId: "target" }), JSON.stringify(admin.plan), createdAt, createdAt);
  await dormant.close();

  const recovered = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db, workerDataPatch: { forceCopy: true } });
  const completed = await waitForJob(recovered, "crash-fixture", ["completed"]);
  assert.equal(completed.result.moveMode, "copy-resume");
  assert.equal(fs.existsSync(fixture.source), false);
  assert.equal(fs.existsSync(fixture.target), true);
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM move_records WHERE work_id = '1'").get().local_path), path.resolve(fixture.target));
  await recovered.close();
  db.close();
}

async function verifyPartialCleanupRecovery() {
  const fixture = await createFixture("cleanup-recovery", 6);
  await fs.promises.cp(fixture.source, fixture.target, { recursive: true, errorOnExist: true, force: false });
  await fs.promises.rm(path.join(fixture.source, "part-0", "fixture-0.bin"), { force: true });
  const db = createDatabase(fixture.root, fixture.target);
  db.prepare("UPDATE move_records SET person_id = 'target' WHERE work_id = '1'").run();
  const admin = createAdminFixture(db, fixture);
  const dormant = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db, schedule: () => {} });
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO work_move_jobs (
      id, request_key, work_id, person_id, status, phase, request_json, plan_json,
      attempts, created_at, updated_at
    ) VALUES ('cleanup-fixture', 'client:cleanup-fixture', '1', 'target', 'cleanup_pending', 'cleanup', ?, ?, 1, ?, ?)
  `).run(JSON.stringify({ personId: "target" }), JSON.stringify(admin.plan), createdAt, createdAt);
  await dormant.close();

  const recovered = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db });
  await waitForJob(recovered, "cleanup-fixture", ["completed"]);
  assert.equal(fs.existsSync(fixture.source), false, "cleanup recovery must finish removing a partially deleted source tree");
  assert.equal(fs.existsSync(fixture.target), true);
  await recovered.close();
  db.close();
}

async function verifyRollbackOnDatabaseFailure() {
  const fixture = await createFixture("rollback", 5);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture, { failCommit: true });
  const service = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    workerDataPatch: { forceCopy: true }
  });
  const job = service.start("1", { personId: "target", idempotencyKey: "rollback-fixture" });
  const rolledBack = await waitForJob(service, job.id, ["rolled_back", "failed"]);
  assert.equal(rolledBack.status, "rolled_back", rolledBack.error);
  assert.match(rolledBack.error, /fixture database commit failed/);
  assert.equal(fs.existsSync(fixture.source), true, "database failure must preserve the source fixture");
  assert.equal(fs.existsSync(fixture.target), false, "database failure must remove the prepared target copy");
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM move_records WHERE work_id = '1'").get().local_path), path.resolve(fixture.source));
  await service.close();
  db.close();
}

async function verifyHttpResponsivenessDuringCopy() {
  const fixture = await createFixture("responsive", 24);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const service = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    workerDataPatch: { forceCopy: true, delayPerFileMs: 15 }
  });
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/move" && req.method === "POST") {
      const job = service.start("1", { personId: "target", idempotencyKey: "responsive-fixture" });
      res.writeHead(202).end(JSON.stringify({ job }));
      return;
    }
    if (req.url === "/health") {
      res.writeHead(200).end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const moveResponse = await fetch(`${base}/move`, { method: "POST" });
  const movePayload = await moveResponse.json();
  assert.equal(moveResponse.status, 202);
  const startedAt = Date.now();
  const healthResponse = await fetch(`${base}/health`);
  const healthElapsed = Date.now() - startedAt;
  assert.equal(healthResponse.status, 200);
  assert.ok(healthElapsed < 250, `health response was blocked for ${healthElapsed}ms`);
  assert.notEqual(service.get(movePayload.job.id).status, "completed", "health must respond while the delayed worker copy is still active");
  await waitForJob(service, movePayload.job.id, ["completed"]);
  await new Promise((resolve) => server.close(resolve));
  await service.close();
  db.close();
}

async function safeCleanup(root) {
  const resolved = path.resolve(root);
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`.toLowerCase();
  assert.ok(resolved.toLowerCase().startsWith(tempRoot), `refusing to remove non-temporary path: ${resolved}`);
  assert.ok(path.basename(resolved).startsWith("fanhao-move-"), `refusing to remove unexpected fixture: ${resolved}`);
  await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

try {
  await verifySuccessfulMoveAndIdempotency();
  await verifyActualAdminSqliteCommit();
  await verifyIncrementalMemoryReconciliation();
  await verifyCrashRecoveryFromPreparedCopy();
  await verifyPartialCleanupRecovery();
  await verifyRollbackOnDatabaseFailure();
  await verifyHttpResponsivenessDuringCopy();
  verifySourceStructure();
  console.log("work-move-jobs: ok (idempotency, checkpoint recovery, rollback, responsive HTTP)");
} finally {
  for (const root of temporaryRoots.reverse()) await safeCleanup(root);
}
