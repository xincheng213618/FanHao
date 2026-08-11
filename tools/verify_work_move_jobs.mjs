import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
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

function createAdminFixture(db, fixture, { failCommit = false, failImageCommitOnce = false } = {}) {
  let imageCommits = 0;
  let imagesCommitted = false;
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
    get imageCommits() { return imageCommits; },
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
    inspectWorkMoveImages() {
      return imagesCommitted ? "completed" : "pending";
    },
    commitWorkMoveImages() {
      imageCommits += 1;
      if (failImageCommitOnce && imageCommits === 1) throw new Error("fixture attached image commit failed");
      imagesCommitted = true;
      return { committed: true, updated: 1 };
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

async function waitForPhase(service, jobId, phase, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = service.get(jobId);
    if (job.phase === phase) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${jobId} phase ${phase}`);
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
  const duplicate = service.start("1", { personId: "target ", idempotencyKey: "success-fixture" });
  assert.equal(duplicate.id, first.id, "same idempotency key must reuse one durable job");
  assert.equal(duplicate.attempts, 1, "duplicate enqueue must not increment attempts");
  const crossWork = service.start("2", { personId: "target", idempotencyKey: "success-fixture" });
  assert.notEqual(crossWork.id, first.id, "the same client key on another work must not return an unrelated job");
  assert.throws(
    () => service.start("1", { personId: "other-target", idempotencyKey: "success-fixture" }),
    (error) => error?.statusCode === 409 && String(error.message).includes(first.id),
    "the request fingerprint must distinguish a different target before enforcing one active move per work"
  );
  const completed = await waitForJob(service, first.id, ["completed"]);
  assert.equal(completed.progress, 1);
  assert.equal(completed.result.moveMode, "copy");
  assert.equal(fs.existsSync(fixture.source), false, "source is removed only after the database commit");
  assert.equal(fs.existsSync(fixture.target), true);
  const databaseRow = db.prepare("SELECT * FROM move_records WHERE work_id = '1'").get();
  assert.equal(path.resolve(databaseRow.local_path), path.resolve(fixture.target));
  assert.equal(databaseRow.person_id, "target");
  assert.equal(admin.imageCommits, 1, "the attached image phase must complete before source cleanup");
  await service.close();
  db.close();
}

async function verifyActualAdminSqliteCommit() {
  const fixture = await createFixture("admin-commit", 3);
  const db = new DatabaseSync(path.join(fixture.root, "admin-fixture.sqlite"));
  db.prepare("ATTACH DATABASE ? AS fanhao_images").run(path.join(fixture.root, "admin-images-fixture.sqlite"));
  db.exec(`
    CREATE TABLE people (
      id INTEGER PRIMARY KEY, name TEXT, name_search TEXT, display_name TEXT, folder_path TEXT,
      movie_count INTEGER, status TEXT, error TEXT, source TEXT, created_at TEXT, updated_at TEXT, gender TEXT
    );
    CREATE TABLE person_external_refs (
      id INTEGER PRIMARY KEY, person_id INTEGER, provider TEXT, external_key TEXT, url TEXT,
      source TEXT, created_at TEXT, updated_at TEXT, UNIQUE(provider, external_key)
    );
    CREATE TABLE person_aliases (
      id INTEGER PRIMARY KEY, person_id INTEGER, alias TEXT, alias_search TEXT, source TEXT,
      UNIQUE(person_id, alias_search)
    );
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
    CREATE TABLE fanhao_images.images (id INTEGER PRIMARY KEY, owner_type TEXT, owner_id INTEGER, local_path TEXT, updated_at TEXT);
    INSERT INTO people VALUES
      (1, 'Source', 'source', 'Source', NULL, 0, 'ok', NULL, 'fixture', '', '', 'unknown'),
      (2, 'Target', 'target', 'Target', NULL, 0, 'ok', NULL, 'fixture', '', '', 'unknown');
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
    resolveLibraryWorkByPublicId: (id) => ({ id: String(id), title: `WORK-${id}`, missingLocal: false }),
    safeStat: (value) => { try { return fs.statSync(value); } catch { return null; } },
    sourcePathToAbsolute: (value) => path.resolve(value),
    resetWorkSearch() {},
    uniqueTextArray: (values) => [...new Set((values || []).filter(Boolean))],
    uniquePersonNames: (values) => [...new Set((values || []).filter(Boolean))]
  });

  const ghostParent = path.join(fixture.root, "ghost-person");
  await fs.promises.mkdir(path.join(ghostParent, path.basename(fixture.source)), { recursive: true });
  const peopleBeforeFailure = db.prepare("SELECT COUNT(*) AS count FROM people").get().count;
  assert.throws(
    () => admin.prepareWorkMove("1", "", {
      createPerson: { name: "Ghost Person", folderName: "ghost-person", rootPath: fixture.root, aliases: ["Ghost Alias"] }
    }),
    (error) => error?.statusCode === 409,
    "target collision must fail before creating a person"
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM people").get().count, peopleBeforeFailure);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM person_aliases").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM person_external_refs").get().count, 0);

  db.prepare("INSERT INTO works VALUES (2, '[]', '')").run();
  db.prepare("INSERT INTO local_works VALUES (2, 2, ?, '', '')").run(path.join(fixture.root, "missing-source", "WORK-002"));
  const missingTargetPerson = path.join(fixture.root, "must-not-exist-person");
  assert.throws(
    () => admin.prepareWorkMove("2", "", {
      createPerson: { name: "Must Not Exist", folderName: path.basename(missingTargetPerson), rootPath: fixture.root }
    }),
    (error) => error?.statusCode === 404,
    "missing source must fail before mkdir or person writes"
  );
  assert.equal(fs.existsSync(missingTargetPerson), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM people").get().count, peopleBeforeFailure);

  const plan = admin.prepareWorkMove("1", "2", { targetDirectory: fixture.targetPerson });
  await fs.promises.cp(fixture.source, fixture.target, { recursive: true, errorOnExist: true, force: false });
  admin.commitWorkMove(plan);
  const localWork = db.prepare("SELECT * FROM local_works WHERE id = 1").get();
  const localFile = db.prepare("SELECT * FROM local_files WHERE id = 1").get();
  const imageBeforeCompensation = db.prepare("SELECT * FROM images WHERE id = 1").get();
  const actor = db.prepare("SELECT person_id, source FROM work_people WHERE work_id = 1 AND role = 'actor'").get();
  assert.equal(path.resolve(localWork.local_path), path.resolve(fixture.target));
  assert.equal(path.resolve(localFile.file_path), path.resolve(replacePrefix(infoPath, fixture.source, fixture.target)));
  assert.equal(path.resolve(imageBeforeCompensation.local_path), path.resolve(imagePath), "main commit must not pretend the attached image database is atomic");
  assert.equal(actor.person_id, 2);
  assert.equal(actor.source, "manual_move");
  assert.equal(admin.inspectWorkMove(plan), "target");
  assert.equal(admin.inspectWorkMoveImages(plan), "pending");
  admin.commitWorkMoveImages(plan);
  const imageAfterCompensation = db.prepare("SELECT * FROM images WHERE id = 1").get();
  assert.equal(path.resolve(imageAfterCompensation.local_path), path.resolve(replacePrefix(imagePath, fixture.source, fixture.target)));
  assert.equal(admin.inspectWorkMoveImages(plan), "completed");
  const result = admin.finalizeWorkMove(plan, { mode: "copy" });
  assert.equal(result.moveMode, "copy");
  assert.equal(reconciled.workId, "1");
  db.close();
}

async function verifyResultBeforeSourceCleanup() {
  const fixture = await createFixture("result-before-cleanup", 4);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const service = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    workerDataPatch: { forceCopy: true, delayBeforeCleanupMs: 250 }
  });
  const started = service.start("1", { personId: "target", idempotencyKey: "result-before-cleanup" });
  const cleanupPending = await waitForPhase(service, started.id, "cleanup");
  assert.equal(cleanupPending.status, "cleanup_pending");
  assert.equal(cleanupPending.result?.moved, true, "durable result must exist before source cleanup starts");
  assert.equal(cleanupPending.result?.work?.relativePath, fixture.target);
  assert.equal(fs.existsSync(fixture.source), true, "fixture source must still exist while the cleanup worker is delayed");
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM move_records WHERE work_id = '1'").get().local_path), path.resolve(fixture.target));
  assert.equal(admin.imageCommits, 1);
  await waitForJob(service, started.id, ["completed"]);
  await service.close();
  db.close();
}

async function verifyAttachedImageStageRecovery() {
  const fixture = await createFixture("image-stage-recovery", 4);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture, { failImageCommitOnce: true });
  const firstService = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    workerDataPatch: { forceCopy: true }
  });
  const started = firstService.start("1", { personId: "target", idempotencyKey: "image-stage-recovery" });
  const pending = await waitForJob(firstService, started.id, ["cleanup_pending"]);
  assert.equal(pending.status, "cleanup_pending");
  assert.equal(pending.phase, "images");
  assert.match(pending.error, /attached image commit failed/);
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM move_records WHERE work_id = '1'").get().local_path), path.resolve(fixture.target));
  assert.equal(fs.existsSync(fixture.source), true, "source cleanup must not start before the image phase commits");
  assert.equal(fs.existsSync(fixture.target), true);
  await firstService.close();

  const recoveredService = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db });
  const completed = await waitForJob(recoveredService, started.id, ["completed"]);
  assert.equal(completed.result?.moved, true);
  assert.equal(admin.imageCommits, 2, "restart recovery must replay the attached image phase idempotently");
  assert.equal(fs.existsSync(fixture.source), false);
  await recoveredService.close();
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

async function verifySilentWorkerExitFails() {
  const fixture = await createFixture("silent-worker", 2);
  const silentWorkerPath = path.join(fixture.root, "silent-worker.mjs");
  await fs.promises.writeFile(silentWorkerPath, "process.exit(0);\n", "utf8");
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const service = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    workerUrl: pathToFileURL(silentWorkerPath)
  });
  const started = service.start("1", { personId: "target", idempotencyKey: "silent-worker" });
  const failed = await waitForJob(service, started.id, ["failed"], 3_000);
  assert.match(failed.error, /没有返回完成消息/);
  assert.equal(fs.existsSync(fixture.source), true);
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM move_records WHERE work_id = '1'").get().local_path), path.resolve(fixture.source));
  await service.close();
  db.close();
}

async function verifySameSizeCorruptionBlocksDeletion() {
  const fixture = await createFixture("same-size-corruption", 3);
  await fs.promises.cp(fixture.source, fixture.target, { recursive: true, errorOnExist: true, force: false });
  const corruptPath = path.join(fixture.target, "part-0", "fixture-0.bin");
  const originalSize = (await fs.promises.stat(corruptPath)).size;
  await fs.promises.writeFile(corruptPath, Buffer.alloc(originalSize, 0xff));
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const service = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db });
  const started = service.start("1", { personId: "target", idempotencyKey: "same-size-corruption" });
  const failed = await waitForJob(service, started.id, ["failed"]);
  assert.match(failed.error, /不一致|拒绝自动删除/);
  assert.equal(fs.existsSync(fixture.source), true, "same-size content mismatch must preserve the source");
  assert.equal(fs.existsSync(fixture.target), true, "an unproven target must be preserved for explicit inspection");
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
  await verifyResultBeforeSourceCleanup();
  await verifyAttachedImageStageRecovery();
  await verifyIncrementalMemoryReconciliation();
  await verifyCrashRecoveryFromPreparedCopy();
  await verifyPartialCleanupRecovery();
  await verifyRollbackOnDatabaseFailure();
  await verifySilentWorkerExitFails();
  await verifySameSizeCorruptionBlocksDeletion();
  await verifyHttpResponsivenessDuringCopy();
  verifySourceStructure();
  console.log("work-move-jobs: ok (idempotency, checkpoint recovery, rollback, responsive HTTP)");
} finally {
  for (const root of temporaryRoots.reverse()) await safeCleanup(root);
}
