import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createApiClient } from "../public/js/api.js";
import { createAdminCoreMutationService } from "../src/modules/fanhao/server/admin/admin-core-mutation-service.js";
import { ensureRealPathWithinRoots } from "../src/modules/fanhao/server/library/library-path-safety.js";
import { createPersonLibraryService } from "../src/modules/fanhao/server/people/person-library-service.js";
import { routeWorksApi } from "../src/modules/fanhao/server/works/routes-api.js";
import { createWorkLocalMutationService } from "../src/modules/fanhao/server/works/work-local-mutation-service.js";
import { createWorkMutationService } from "../src/modules/fanhao/server/works/work-mutation-service.js";
import { createWorkMoveJobService } from "../src/modules/fanhao/server/works/work-move-job-service.js";
import { createWorkMoveReservationService } from "../src/modules/fanhao/server/works/work-move-reservation-service.js";

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

function createAdminFixture(db, fixture, {
  failCommit = false,
  failImageCommitOnce = false,
  sharedConflictAtCheck = 0,
  sharedConflictAtCommit = false
} = {}) {
  let imageCommits = 0;
  let imagesCommitted = false;
  let sharedChecks = 0;
  let reservation = null;
  const releasedReservationJobs = new Set();
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
    libraryRoots: [fixture.root],
    createdPerson: null,
    before: [{ person_id: "source", name: "Source" }]
  };
  return {
    get imageCommits() { return imageCommits; },
    get reservation() { return reservation ? { ...reservation } : null; },
    get releasedReservationJobs() { return new Set(releasedReservationJobs); },
    get sharedChecks() { return sharedChecks; },
    plan,
    acquireWorkMoveReservation(currentPlan, context = {}) {
      reservation = {
        jobId: currentPlan.jobId,
        ownerId: context.ownerId,
        leaseUntil: context.leaseUntil,
        released: false
      };
      return { reserved: true };
    },
    renewWorkMoveReservation(currentPlan, context = {}) {
      if (!reservation || reservation.jobId !== currentPlan.jobId || reservation.ownerId !== context.ownerId || reservation.released) {
        const error = new Error("fixture reservation owner lost");
        error.code = "WORK_MOVE_LEASE_LOST";
        throw error;
      }
      reservation.leaseUntil = context.leaseUntil;
      return { reserved: true };
    },
    releaseWorkMoveReservation(jobId, context = {}) {
      if (reservation?.jobId === jobId && reservation.ownerId === context.ownerId) {
        reservation.released = true;
        releasedReservationJobs.add(jobId);
      }
      return { released: true };
    },
    parkWorkMoveReservation(currentPlan, context = {}) {
      if (reservation && reservation.jobId === currentPlan.jobId && reservation.ownerId === context.ownerId && !reservation.released) {
        reservation.ownerId = "";
        reservation.leaseUntil = "";
      }
      return { parked: true };
    },
    repairWorkMoveReservations() {
      return { repaired: 0 };
    },
    prepareWorkMove() {
      return plan;
    },
    hydrateWorkMovePlanRoots(currentPlan) {
      ensureRealPathWithinRoots(currentPlan.oldDir, [fixture.root], "源作品文件夹");
      ensureRealPathWithinRoots(currentPlan.newDir, [fixture.root], "目标作品文件夹");
      return { ...currentPlan, libraryRoots: [fixture.root] };
    },
    assertWorkMoveSourceUnshared(currentPlan, context = {}) {
      if (!reservation || reservation.jobId !== currentPlan.jobId || reservation.ownerId !== context.ownerId || reservation.released) {
        const error = new Error("fixture reservation owner lost");
        error.code = "WORK_MOVE_LEASE_LOST";
        throw error;
      }
      sharedChecks += 1;
      if (sharedConflictAtCheck === sharedChecks) {
        db.prepare("INSERT OR REPLACE INTO move_records(work_id, person_id, local_path) VALUES (?, 'shared', ?)")
          .run(`shared-${sharedChecks}`, fixture.source);
        const error = new Error("fixture source gained another local_work owner");
        error.statusCode = 409;
        throw error;
      }
      return { unshared: true };
    },
    inspectWorkMove(currentPlan) {
      const row = db.prepare("SELECT local_path FROM move_records WHERE work_id = ?").get(currentPlan.workId);
      if (path.resolve(row.local_path) === path.resolve(currentPlan.oldDir)) return "source";
      if (path.resolve(row.local_path) === path.resolve(currentPlan.newDir)) return "target";
      return "conflict";
    },
    commitWorkMove(currentPlan) {
      if (failCommit) throw new Error("fixture database commit failed");
      if (sharedConflictAtCommit) {
        db.prepare("INSERT OR REPLACE INTO move_records(work_id, person_id, local_path) VALUES ('shared-commit', 'shared', ?)")
          .run(fixture.source);
        const error = new Error("fixture source gained another local_work owner before commit");
        error.statusCode = 409;
        throw error;
      }
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

async function waitForJobMatching(service, jobId, predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = service.get(jobId);
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const job = service.get(jobId);
  throw new Error(`timed out waiting for ${jobId}: ${job.status}/${job.phase}`);
}

async function verifySuccessfulMoveAndIdempotency() {
  const fixture = await createFixture("success", 12);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const lifecycle = [];
  const service = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    log: (line) => lifecycle.push(String(line)),
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
  assert.equal(admin.releasedReservationJobs.has(first.id), true, "completed jobs must release their own durable path reservation");
  assert.ok(lifecycle.some((line) => line.includes('"event":"completed"')));
  assert.equal(lifecycle.some((line) => line.includes(fixture.source)), false, "completed lifecycle logs must not expose absolute paths");
  await service.close();
  db.close();
}

async function waitForCondition(predicate, message, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function verifyWorkLookupRecoversLostStartResponse() {
  const fixture = await createFixture("lost-start-response", 2);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const service = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db, schedule: () => {} });
  const started = service.start("1", { personId: "target", idempotencyKey: "lost-response-key" });
  assert.equal(service.findForWork("1", { idempotencyKey: "lost-response-key" })?.id, started.id, "the client key persisted before POST must recover the committed journal row");
  assert.equal(service.findForWork("1")?.id, started.id, "the work-scoped fallback must recover the one blocking job");
  assert.equal(service.findForWork("other", { idempotencyKey: "lost-response-key" }), null, "a client key must never cross work ownership");

  let response = null;
  await routeWorksApi(
    { method: "GET" },
    {},
    new URL("http://fixture/api/works/1/move-job?idempotencyKey=lost-response-key"),
    {
      notFound() {},
      personDetailService: {},
      readJsonBody: async () => ({}),
      requireLocalAdmin: () => true,
      requireTrustedFileMutation: () => true,
      sendJson: (_res, status, payload) => { response = { status, payload }; },
      workDetailService: {},
      workMutationService: {
        moveJobForWork(workId, options) {
          return { ok: true, job: service.findForWork(workId, options) };
        }
      },
      workQueryService: {}
    }
  );
  assert.equal(response?.status, 200);
  assert.equal(response?.payload?.job?.id, started.id);

  db.prepare("UPDATE work_move_jobs SET status = 'blocked', phase = 'manual_review', error = 'fixture blocked' WHERE id = ?").run(started.id);
  assert.equal(service.findForWork("1")?.status, "blocked", "blocked work must remain discoverable instead of leaving the UI polling an unknown task");
  await service.close();
  db.close();
}

async function verifyOverlappingPathReservationsAreRejected() {
  const fixture = await createFixture("overlapping-reservations", 1);
  const imageDbPath = path.join(fixture.root, "images.sqlite");
  const db = new DatabaseSync(path.join(fixture.root, "reservations.sqlite"));
  db.exec(`
    ATTACH DATABASE ${JSON.stringify(imageDbPath)} AS fanhao_images;
    CREATE TABLE local_works (id INTEGER PRIMARY KEY, work_id INTEGER NOT NULL, local_path TEXT);
    CREATE TABLE local_files (id INTEGER PRIMARY KEY, local_work_id INTEGER, file_path TEXT);
    CREATE TABLE fanhao_images.images (id INTEGER PRIMARY KEY, owner_type TEXT, owner_id INTEGER, local_path TEXT);
  `);
  const child = path.join(fixture.source, "nested", "WORK-CHILD");
  db.prepare("INSERT INTO local_works(id, work_id, local_path) VALUES (1, 1, ?), (2, 2, ?)").run(fixture.source, child);
  const reservations = createWorkMoveReservationService({ getCoreDb: () => db });
  const createdAt = new Date().toISOString();
  const parentKey = path.resolve(fixture.source).replace(/\\/g, "/").toLowerCase();
  const parentTarget = path.resolve(fixture.target).replace(/\\/g, "/").toLowerCase();
  for (const table of ["work_move_path_reservations", "fanhao_images.work_move_path_reservations"]) {
    db.prepare(`
      INSERT INTO ${table} (
        job_id, work_id, local_work_id, old_path, old_path_key, new_path, new_path_key,
        owner_id, lease_until, created_at, updated_at
      ) VALUES ('parent-job', '1', 1, ?, ?, ?, ?, 'parent-owner', '2999-01-01T00:00:00.000Z', ?, ?)
    `).run(fixture.source, parentKey, fixture.target, parentTarget, createdAt, createdAt);
  }
  assert.throws(
    () => reservations.acquire({
      jobId: "child-job",
      workId: "2",
      localWorkId: 2,
      oldDir: child,
      newDir: path.join(fixture.targetPerson, "WORK-CHILD")
    }, { ownerId: "child-owner", leaseUntil: "2999-01-01T00:00:00.000Z" }),
    (error) => error?.code === "WORK_MOVE_RESERVATION_CONFLICT" && /parent-job/.test(error.message),
    "ancestor and descendant work paths must never receive simultaneous reservations"
  );
  db.prepare("UPDATE work_move_path_reservations SET mutation_mode = 'fixture' WHERE job_id = 'parent-job'").run();
  db.prepare("DELETE FROM local_works WHERE id = 2").run();
  db.prepare("UPDATE work_move_path_reservations SET mutation_mode = '' WHERE job_id = 'parent-job'").run();
  assert.throws(
    () => db.prepare("INSERT INTO local_works(id, work_id, local_path) VALUES (3, 3, ?)").run(path.dirname(fixture.source)),
    /ancestor path reserved/,
    "reservation triggers must reject a later writer that introduces an ancestor path"
  );
  assert.throws(
    () => db.prepare("INSERT INTO local_files(id, local_work_id, file_path) VALUES (3, 3, ?)").run(path.dirname(fixture.source)),
    /ancestor path reserved/,
    "local_files writers must not introduce an ancestor of a reserved tree"
  );
  assert.throws(
    () => db.prepare("INSERT INTO fanhao_images.images(id, owner_type, owner_id, local_path) VALUES (3, 'work', 3, ?)").run(path.dirname(fixture.source)),
    /ancestor path reserved/,
    "image writers must not introduce an ancestor of a reserved tree"
  );
  db.close();
}

async function verifyAllBusyStagesRequeue() {
  const fixture = await createFixture("all-stage-busy-requeue", 4);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const acquire = admin.acquireWorkMoveReservation.bind(admin);
  const commit = admin.commitWorkMove.bind(admin);
  const release = admin.releaseWorkMoveReservation.bind(admin);
  let acquireBusy = 0;
  let commitBusy = 0;
  let releaseBusy = 0;
  admin.acquireWorkMoveReservation = (...args) => {
    if (acquireBusy++ === 0) {
      const error = new Error("database is locked during reservation");
      error.code = "SQLITE_BUSY";
      throw error;
    }
    return acquire(...args);
  };
  admin.commitWorkMove = (...args) => {
    if (commitBusy++ === 0) {
      const error = new Error("database is locked during main commit");
      error.code = "SQLITE_BUSY";
      throw error;
    }
    return commit(...args);
  };
  admin.releaseWorkMoveReservation = (...args) => {
    if (releaseBusy++ === 0) {
      const error = new Error("database is locked during terminal reservation release");
      error.code = "SQLITE_BUSY";
      throw error;
    }
    return release(...args);
  };
  const warnings = [];
  const service = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    warn: (...args) => warnings.push(args.map(String).join(" ")),
    workerDataPatch: { forceCopy: true }
  });
  const started = service.start("1", { personId: "target", idempotencyKey: "all-stage-busy-requeue" });
  const completed = await waitForJob(service, started.id, ["completed"]);
  assert.equal(completed.status, "completed");
  await waitForCondition(
    () => admin.releasedReservationJobs.has(started.id),
    "a terminal reservation release blocked by SQLITE_BUSY must be retried without restarting the service"
  );
  assert.ok(acquireBusy >= 2, "reservation acquisition must be retried by a queued recovery run");
  assert.ok(commitBusy >= 2, "main commit must be retried by a queued recovery run");
  assert.ok(releaseBusy >= 2, "terminal reservation release must be retried by a queued recovery run");
  assert.ok(warnings.some((message) => message.includes("work-move-stage-busy")), "stage BUSY retries must remain observable");
  assert.ok(warnings.some((message) => message.includes("work-move-terminal-release-busy")), "terminal release BUSY retries must remain observable");
  await service.close();
  db.close();
}

function waitForWorkerMessage(worker, predicate, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for concurrent starter worker"));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
    };
    worker.on("message", onMessage);
    worker.on("error", onError);
  });
}

async function verifyConcurrentStartsAreAtomicallyUnique() {
  const fixture = await createFixture("concurrent-start-unique", 6);
  const dbPath = path.join(fixture.root, "fixture.sqlite");
  const db = createDatabase(fixture.root, fixture.source);
  db.exec("PRAGMA busy_timeout = 5000");
  const starterPath = path.join(fixture.root, "concurrent-starter.mjs");
  await fs.promises.writeFile(starterPath, `
    import { parentPort, workerData } from "node:worker_threads";
    import { DatabaseSync } from "node:sqlite";
    const { createWorkMoveJobService } = await import(workerData.serviceUrl);
    const db = new DatabaseSync(workerData.dbPath);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL");
    const service = createWorkMoveJobService({
      adminCoreMutationService: { repairWorkMoveReservations() { return { repaired: 0 }; } },
      getCoreDb: () => db,
      schedule: () => {}
    });
    parentPort.postMessage({ type: "ready" });
    parentPort.once("message", async (message) => {
      if (message !== "go") return;
      try {
        const job = service.start("1", workerData.request);
        parentPort.postMessage({ type: "result", ok: true, job });
      } catch (error) {
        parentPort.postMessage({ type: "result", ok: false, statusCode: error.statusCode || 0, job: error.job || null });
      } finally {
        await service.close();
        db.close();
      }
    });
  `, "utf8");
  const serviceUrl = new URL("../src/modules/fanhao/server/works/work-move-job-service.js", import.meta.url).href;
  const starters = [
    new Worker(pathToFileURL(starterPath), { workerData: { dbPath, serviceUrl, request: { personId: "target-a", idempotencyKey: "concurrent-a" } } }),
    new Worker(pathToFileURL(starterPath), { workerData: { dbPath, serviceUrl, request: { personId: "target-b", idempotencyKey: "concurrent-b" } } })
  ];
  const exits = starters.map((worker) => new Promise((resolve, reject) => {
    worker.once("exit", resolve);
    worker.once("error", reject);
  }));
  await Promise.all(starters.map((worker) => waitForWorkerMessage(worker, (message) => message?.type === "ready")));
  const resultsPromise = Promise.all(starters.map((worker) => waitForWorkerMessage(worker, (message) => message?.type === "result")));
  for (const worker of starters) worker.postMessage("go");
  const results = await resultsPromise;
  await Promise.all(exits);
  assert.equal(results.filter((result) => result.ok).length, 1, "only one concurrent start may insert an active job");
  assert.equal(results.filter((result) => !result.ok && result.statusCode === 409).length, 1, "the losing request must receive the existing job conflict");
  const winner = results.find((result) => result.ok)?.job;
  const loser = results.find((result) => !result.ok);
  assert.equal(loser?.job?.id, winner?.id, "the 409 response must identify the single durable winner");
  const activeRows = db.prepare(`
    SELECT * FROM work_move_jobs
    WHERE work_id = '1' AND status IN ('queued', 'running', 'cleanup_pending', 'rollback_pending', 'blocked')
  `).all();
  assert.equal(activeRows.length, 1, "the partial unique index must enforce one blocking job per work across connections");

  let stageStarts = 0;
  class CountingWorker extends Worker {
    constructor(url, options) {
      if (options?.workerData?.operation === "stage") stageStarts += 1;
      super(url, options);
    }
  }
  const admin = createAdminFixture(db, fixture);
  const service = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db, workerClass: CountingWorker, workerDataPatch: { forceCopy: true } });
  service.recover();
  await waitForJob(service, activeRows[0].id, ["completed"]);
  assert.equal(stageStarts, 1, "only the single durable job may execute a staging worker");
  await service.close();
  db.close();
}

async function verifyLegacyDuplicateJobsMigrateFailClosed() {
  const fixture = await createFixture("legacy-duplicate-jobs", 1);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const bootstrap = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db, schedule: () => {} });
  await bootstrap.close();
  db.exec("DROP INDEX idx_work_move_jobs_one_active_work");
  const insert = db.prepare(`
    INSERT INTO work_move_jobs (
      id, request_key, work_id, person_id, status, phase, request_json, plan_json,
      attempts, created_at, updated_at
    ) VALUES (?, ?, ?, 'target', ?, ?, '{}', ?, 1, ?, ?)
  `);
  insert.run("legacy-queued-a", "legacy-key-a", "legacy-queued", "queued", "queued", "", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  insert.run("legacy-queued-b", "legacy-key-b", "legacy-queued", "queued", "queued", "", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
  insert.run("legacy-progress-a", "legacy-key-c", "legacy-progress", "running", "copying", '{"oldDir":"a"}', "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  insert.run("legacy-progress-b", "legacy-key-d", "legacy-progress", "cleanup_pending", "cleanup", '{"oldDir":"b"}', "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");

  const migrated = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db, schedule: () => {} });
  const queuedRows = db.prepare("SELECT id, status, phase FROM work_move_jobs WHERE work_id = 'legacy-queued' ORDER BY id").all();
  assert.equal(queuedRows.filter((row) => row.status === "queued").length, 1, "queued legacy duplicates must deterministically keep one survivor");
  assert.equal(queuedRows.filter((row) => row.phase === "duplicate_superseded").length, 1);
  const progressedRows = db.prepare("SELECT id, status, phase FROM work_move_jobs WHERE work_id = 'legacy-progress' ORDER BY id").all();
  assert.equal(progressedRows.filter((row) => row.status === "blocked" && row.phase === "duplicate_conflict").length, 1, "multiple progressed legacy jobs must stop behind one durable blocking row");
  assert.equal(progressedRows.filter((row) => row.phase === "duplicate_superseded").length, 1);
  assert.throws(
    () => insert.run("legacy-progress-c", "legacy-key-e", "legacy-progress", "queued", "queued", "", "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z"),
    /UNIQUE constraint failed/,
    "the migrated partial unique index must reject another blocking job"
  );
  await migrated.close();
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

  db.prepare("INSERT INTO works VALUES (3, '[]', '')").run();
  db.prepare("INSERT INTO local_works VALUES (3, 3, ?, '', '')").run(fixture.source);
  assert.throws(
    () => admin.prepareWorkMove("1", "2", { targetDirectory: fixture.targetPerson }),
    (error) => error?.statusCode === 409 && /同时属于多个/.test(error.message),
    "a directory shared by another local_work must be rejected before filesystem mutation"
  );
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM local_works WHERE id = 3").get().local_path), path.resolve(fixture.source));
  assert.equal(fs.existsSync(fixture.source), true);
  db.prepare("DELETE FROM local_works WHERE id = 3").run();
  db.prepare("DELETE FROM works WHERE id = 3").run();

  const plan = { ...admin.prepareWorkMove("1", "2", { targetDirectory: fixture.targetPerson }), jobId: "fixture-admin-move" };
  let reservationContext = {
    ownerId: "fixture-owner",
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    claimedAt: new Date().toISOString()
  };
  await fs.promises.cp(fixture.source, fixture.target, { recursive: true, errorOnExist: true, force: false });
  db.prepare("INSERT INTO works VALUES (3, '[]', '')").run();
  db.prepare("INSERT INTO local_works VALUES (3, 3, ?, '', '')").run(fixture.source);
  assert.throws(
    () => admin.acquireWorkMoveReservation(plan, reservationContext),
    (error) => error?.statusCode === 409 && /其他数据库引用/.test(error.message),
    "reservation acquisition must close the prepare-to-claim shared-reference window"
  );
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM local_works WHERE id = 1").get().local_path), path.resolve(fixture.source));
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM local_works WHERE id = 3").get().local_path), path.resolve(fixture.source));
  assert.equal(path.resolve(db.prepare("SELECT file_path FROM local_files WHERE id = 1").get().file_path), path.resolve(infoPath));
  db.prepare("DELETE FROM local_works WHERE id = 3").run();
  db.prepare("DELETE FROM works WHERE id = 3").run();
  admin.acquireWorkMoveReservation(plan, reservationContext);
  db.prepare("UPDATE work_move_path_reservations SET lease_until = '2000-01-01T00:00:00.000Z' WHERE job_id = ?").run(plan.jobId);
  db.prepare("UPDATE fanhao_images.work_move_path_reservations SET lease_until = '2000-01-01T00:00:00.000Z' WHERE job_id = ?").run(plan.jobId);
  reservationContext = {
    ownerId: "fixture-recovery-owner",
    leaseUntil: new Date(Date.now() + 60_000).toISOString(),
    claimedAt: new Date().toISOString(),
    takeover: true
  };
  admin.acquireWorkMoveReservation(plan, reservationContext);
  assert.equal(db.prepare("SELECT owner_id FROM work_move_path_reservations WHERE job_id = ?").get(plan.jobId).owner_id, reservationContext.ownerId);
  assert.equal(db.prepare("SELECT owner_id FROM fanhao_images.work_move_path_reservations WHERE job_id = ?").get(plan.jobId).owner_id, reservationContext.ownerId);
  const localMutationWork = { id: "1", missingLocal: false, directoryName: path.basename(fixture.source), videos: [], images: [], infos: [] };
  const localMutationService = createWorkLocalMutationService({
    ensureLibraryDirectoryPath: (value) => {
      const resolved = path.resolve(value);
      if (!withinRoot(resolved)) throw new Error("fixture path escaped temporary root");
      return resolved;
    },
    getCoreDb: () => db,
    getWorkById: () => localMutationWork,
    hasCoreDb: () => true,
    invalidateLibraryDerivedCaches() {},
    invalidateTableStamp() {},
    invalidateWorkCodeIndex() {},
    libraryOpenRoots: () => [fixture.root],
    localWorkMarkerKey: (value) => String(value || "").trim().toLowerCase(),
    markerDirectoryName: (base) => `${base} [A]`,
    pathWithinRoot: (candidate, root) => {
      const relative = path.relative(path.resolve(root), path.resolve(candidate));
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    },
    publicWork: (value) => value,
    reconcileDeletedLocalWorks() {},
    relativeFromRoot: (value) => path.relative(fixture.root, value),
    replacePathPrefix: replacePrefix,
    resolveLibraryPersonByPublicId: () => null,
    resolveLibraryWorkByPublicId: () => localMutationWork,
    safeStat: (value) => { try { return fs.statSync(value); } catch { return null; } },
    sourcePathToAbsolute: (value) => path.resolve(value),
    resetWorkSearch() {},
    uniqueTextArray: (values) => [...new Set(values || [])],
    workHasLocalMarker: () => false
  });
  assert.throws(
    () => localMutationService.setWorkLocalMarker("1", "a", true),
    (error) => error?.statusCode === 409 && /正在迁移/.test(error.message),
    "the marker writer must reject the reservation before renaming the filesystem directory"
  );
  assert.equal(fs.existsSync(fixture.source), true);
  assert.equal(fs.existsSync(`${fixture.source} [A]`), false);
  assert.throws(
    () => localMutationService.deleteWorkLocalFiles("1"),
    (error) => error?.statusCode === 409 && /正在迁移/.test(error.message),
    "the local delete writer must hold BEGIN IMMEDIATE and reject a reserved path before deleting files"
  );
  assert.equal(fs.existsSync(fixture.source), true);
  const unexpectedPath = path.join(fixture.root, "unexpected", "WORK-001");
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE work_move_path_reservations SET mutation_mode = 'fixture' WHERE job_id = ?").run(plan.jobId);
  db.prepare("UPDATE local_works SET local_path = ? WHERE id = 1").run(unexpectedPath);
  db.prepare("UPDATE work_move_path_reservations SET mutation_mode = '' WHERE job_id = ?").run(plan.jobId);
  db.exec("COMMIT");
  assert.throws(
    () => admin.commitWorkMove(plan, reservationContext),
    (error) => error?.statusCode === 409 && /其他操作修改/.test(error.message),
    "commit must re-read oldDir/current state inside the same BEGIN IMMEDIATE transaction"
  );
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE work_move_path_reservations SET mutation_mode = 'fixture' WHERE job_id = ?").run(plan.jobId);
  db.prepare("UPDATE local_works SET local_path = ? WHERE id = 1").run(fixture.source);
  db.prepare("UPDATE work_move_path_reservations SET mutation_mode = '' WHERE job_id = ?").run(plan.jobId);
  db.exec("COMMIT");
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE work_move_path_reservations SET mutation_mode = 'fixture' WHERE job_id = ?").run(plan.jobId);
  db.prepare("INSERT INTO works VALUES (3, '[]', '')").run();
  db.prepare("INSERT INTO local_works VALUES (3, 3, ?, '', '')").run(fixture.source);
  db.prepare("UPDATE work_move_path_reservations SET mutation_mode = '' WHERE job_id = ?").run(plan.jobId);
  db.exec("COMMIT");
  assert.throws(
    () => admin.commitWorkMove(plan, reservationContext),
    (error) => error?.statusCode === 409 && /其他本地作品引用/.test(error.message),
    "commit must still recheck shared local_path inside its own BEGIN IMMEDIATE transaction"
  );
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE work_move_path_reservations SET mutation_mode = 'fixture' WHERE job_id = ?").run(plan.jobId);
  db.prepare("DELETE FROM local_works WHERE id = 3").run();
  db.prepare("UPDATE work_move_path_reservations SET mutation_mode = '' WHERE job_id = ?").run(plan.jobId);
  db.prepare("DELETE FROM works WHERE id = 3").run();
  db.exec("COMMIT");
  admin.commitWorkMove(plan, reservationContext);
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
  const lateImagePath = path.join(fixture.source, "part-2", "fixture-2.bin");
  db.exec("BEGIN IMMEDIATE");
  db.prepare("UPDATE fanhao_images.work_move_path_reservations SET mutation_mode = 'fixture' WHERE job_id = ?").run(plan.jobId);
  db.prepare("INSERT INTO fanhao_images.images VALUES (2, 'work', 1, ?, '')").run(lateImagePath);
  db.prepare("UPDATE fanhao_images.work_move_path_reservations SET mutation_mode = '' WHERE job_id = ?").run(plan.jobId);
  db.exec("COMMIT");
  const imageCommit = admin.commitWorkMoveImages(plan, reservationContext);
  assert.equal(imageCommit.updated, 2, "the image commit must build and apply its pending snapshot inside one transaction");
  const imageAfterCompensation = db.prepare("SELECT * FROM images WHERE id = 1").get();
  assert.equal(path.resolve(imageAfterCompensation.local_path), path.resolve(replacePrefix(imagePath, fixture.source, fixture.target)));
  assert.equal(
    path.resolve(db.prepare("SELECT local_path FROM fanhao_images.images WHERE id = 2").get().local_path),
    path.resolve(replacePrefix(lateImagePath, fixture.source, fixture.target))
  );
  assert.equal(admin.inspectWorkMoveImages(plan), "completed");
  const result = admin.finalizeWorkMove(plan, { mode: "copy" });
  assert.equal(result.moveMode, "copy");
  assert.equal(reconciled.workId, "1");
  const gateDb = new DatabaseSync(path.join(fixture.root, "admin-fixture.sqlite"));
  gateDb.prepare("ATTACH DATABASE ? AS fanhao_images").run(path.join(fixture.root, "admin-images-fixture.sqlite"));
  assert.throws(
    () => gateDb.prepare("INSERT INTO local_works VALUES (4, 4, ?, '', '')").run(fixture.source),
    /work move path reserved/,
    "scanner/import local_work inserts must be gated while the path is reserved"
  );
  assert.throws(
    () => gateDb.prepare("INSERT INTO local_files VALUES (4, 999, ?, '', '')").run(path.join(fixture.source, "late.bin")),
    /work move path reserved/,
    "local_files writers must not add a late reference below the reserved source"
  );
  assert.throws(
    () => gateDb.prepare("INSERT INTO fanhao_images.images VALUES (4, 'work', 4, ?, '')").run(path.join(fixture.source, "late.jpg")),
    /work move path reserved/,
    "the independently attached image database must gate late source references"
  );
  assert.throws(
    () => gateDb.prepare("UPDATE local_works SET local_path = ? WHERE id = 1").run(`${fixture.target} [A]`),
    /work move path reserved/,
    "marker/admin updates to the reserved local_work must fail before exposing a split filesystem/database state"
  );

  const quarantinePath = path.join(fixture.sourcePerson, `.${path.basename(fixture.source)}.fanhao-quarantine-${plan.jobId}`);
  await runMoveWorker({
    jobId: plan.jobId,
    operation: "isolate",
    allowedRoots: [fixture.root],
    sourcePath: fixture.source,
    targetPath: fixture.target,
    quarantinePath
  });
  admin.assertWorkMoveSourceUnshared(plan, reservationContext);
  assert.throws(
    () => gateDb.prepare("INSERT INTO local_works VALUES (5, 5, ?, '', '')").run(fixture.source),
    /work move path reserved/,
    "a second connection must remain blocked after the final check and before cleanup deletion"
  );
  await runMoveWorker({
    jobId: plan.jobId,
    operation: "cleanup",
    allowedRoots: [fixture.root],
    sourcePath: fixture.source,
    targetPath: fixture.target,
    quarantinePath
  });
  assert.equal(fs.existsSync(fixture.source), false, "cleanup may delete only after every late database writer was rejected");
  gateDb.close();
  admin.releaseWorkMoveReservation(plan.jobId, { ...reservationContext, terminalStatus: "completed" });
  const releasedMain = db.prepare("SELECT released_at, terminal_status FROM work_move_path_reservations WHERE job_id = ?").get(plan.jobId);
  const releasedImages = db.prepare("SELECT released_at, terminal_status FROM fanhao_images.work_move_path_reservations WHERE job_id = ?").get(plan.jobId);
  assert.ok(releasedMain.released_at && releasedImages.released_at, "both durable reservation mirrors must release after the terminal state");
  assert.equal(releasedMain.terminal_status, "completed");
  assert.equal(releasedImages.terminal_status, "completed");
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
  const jobSource = fs.readFileSync(new URL("../src/modules/fanhao/server/works/work-move-job-service.js", import.meta.url), "utf8");
  const localMutationSource = fs.readFileSync(new URL("../src/modules/fanhao/server/works/work-local-mutation-service.js", import.meta.url), "utf8");
  const reservationSource = fs.readFileSync(new URL("../src/modules/fanhao/server/works/work-move-reservation-service.js", import.meta.url), "utf8");
  const routeSource = fs.readFileSync(new URL("../src/modules/fanhao/server/works/routes-api.js", import.meta.url), "utf8");
  const clientSource = fs.readFileSync(new URL("../public/js/player-page.js", import.meta.url), "utf8");
  assert.equal(/Atomics\.wait|spawnSync|moveDirectorySync|fs\.cpSync/.test(adminSource), false, "move-to-person must not retain synchronous copy or sleep paths");
  assert.match(jobSource, /CREATE UNIQUE INDEX IF NOT EXISTS idx_work_move_jobs_one_active_work/);
  assert.match(jobSource, /BEGIN IMMEDIATE/);
  assert.match(jobSource, /\[work-move-heartbeat\]/);
  assert.match(jobSource, /scheduleClaimRetry\(jobId\)/);
  assert.match(localMutationSource, /assertLocalPathsNotReserved/);
  assert.match(reservationSource, /trg_work_move_reserve_local_works_insert/);
  assert.match(reservationSource, /trg_work_move_reserve_local_files_insert/);
  assert.match(reservationSource, /trg_work_move_reserve_images_insert/);
  assert.match(reservationSource, /BEGIN IMMEDIATE/);
  assert.match(routeSource, /publicWorkMoveJobPayload/);
  assert.match(routeSource, /sanitizeWorkMoveJob\(payload\?\.job\)/);
  assert.ok(routeSource.includes("work-move-jobs"));
  assert.match(clientSource, /waitForWorkMoveJob\(data\.job\)/);
  assert.match(clientSource, /AbortController/);
  assert.match(clientSource, /pagehide/);
  assert.match(clientSource, /pageshow/);
  assert.match(clientSource, /ACTIVE_MOVE_STORAGE_KEY/);
  assert.match(clientSource, /ACTIVE_MOVE_REQUEST_STORAGE_KEY/);
  assert.match(clientSource, /findMoveJobForWork\(idempotencyKey\)/);
  assert.match(clientSource, /job\.status === "blocked"/);
  assert.match(clientSource, /恢复迁移/);
}

async function verifyCrashRecoveryFromPreparedCopy() {
  const fixture = await createFixture("recovery", 6);
  await fs.promises.cp(fixture.source, fixture.target, { recursive: true, errorOnExist: true, force: false });
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const legacyPlan = { ...admin.plan };
  delete legacyPlan.libraryRoots;
  const dormant = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db, schedule: () => {} });
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO work_move_jobs (
      id, request_key, work_id, person_id, status, phase, request_json, plan_json,
      attempts, created_at, updated_at
    ) VALUES ('crash-fixture', 'client:crash-fixture', '1', 'target', 'running', 'filesystem_ready', ?, ?, 1, ?, ?)
  `).run(JSON.stringify({ personId: "target" }), JSON.stringify(legacyPlan), createdAt, createdAt);
  await dormant.close();

  const recovered = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db, workerDataPatch: { forceCopy: true } });
  const completed = await waitForJob(recovered, "crash-fixture", ["completed"]);
  assert.equal(completed.result.moveMode, "copy-resume");
  assert.equal(fs.existsSync(fixture.source), false);
  assert.equal(fs.existsSync(fixture.target), true);
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM move_records WHERE work_id = '1'").get().local_path), path.resolve(fixture.target));
  const hydratedPlan = JSON.parse(db.prepare("SELECT plan_json FROM work_move_jobs WHERE id = 'crash-fixture'").get().plan_json);
  assert.deepEqual(hydratedPlan.libraryRoots, [fixture.root], "a legitimate legacy plan must be hydrated only from current trusted roots");
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
  const lifecycle = [];
  const service = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    log: (line) => lifecycle.push(String(line)),
    workerDataPatch: { forceCopy: true }
  });
  const job = service.start("1", { personId: "target", idempotencyKey: "rollback-fixture" });
  const rolledBack = await waitForJob(service, job.id, ["rolled_back", "failed"]);
  assert.equal(rolledBack.status, "rolled_back", rolledBack.error);
  assert.match(rolledBack.error, /fixture database commit failed/);
  assert.equal(fs.existsSync(fixture.source), true, "database failure must preserve the source fixture");
  assert.equal(fs.existsSync(fixture.target), false, "database failure must remove the prepared target copy");
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM move_records WHERE work_id = '1'").get().local_path), path.resolve(fixture.source));
  assert.equal(admin.reservation?.released, true, "rolled-back jobs must release their durable path reservation");
  assert.ok(lifecycle.some((line) => line.includes('"event":"rolled_back"')));
  assert.equal(lifecycle.some((line) => line.includes(fixture.source)), false, "rolled-back lifecycle logs must not expose absolute paths");
  await service.close();
  db.close();
}

async function verifySharedOwnerAddedBeforeCommitRollsBackCopy() {
  const fixture = await createFixture("shared-before-commit", 5);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture, { sharedConflictAtCommit: true });
  const service = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    workerDataPatch: { forceCopy: true }
  });
  const started = service.start("1", { personId: "target", idempotencyKey: "shared-before-commit" });
  const rolledBack = await waitForJob(service, started.id, ["rolled_back"]);
  assert.match(rolledBack.error, /another local_work owner/);
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM move_records WHERE work_id = '1'").get().local_path), path.resolve(fixture.source));
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM move_records WHERE work_id = 'shared-commit'").get().local_path), path.resolve(fixture.source));
  assert.equal(fs.existsSync(fixture.source), true, "commit-time shared owner conflict must preserve the source");
  assert.equal(fs.existsSync(fixture.target), false, "the uncommitted target copy must be rolled back safely");
  await service.close();
  db.close();
}

async function verifySharedOwnerDuringImageStageBlocksCleanup() {
  const fixture = await createFixture("shared-during-images", 5);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture, { sharedConflictAtCheck: 1 });
  const service = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db, workerDataPatch: { forceCopy: true } });
  const started = service.start("1", { personId: "target", idempotencyKey: "shared-during-images" });
  const pending = await waitForJobMatching(
    service,
    started.id,
    (job) => job.status === "cleanup_pending" && /another local_work owner/.test(job.error || "")
  );
  assert.equal(pending.phase, "main_committed");
  assert.match(pending.error, /another local_work owner/);
  assert.equal(admin.imageCommits, 0, "image compensation must not start after the shared-source recheck fails");
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM move_records WHERE work_id = '1'").get().local_path), path.resolve(fixture.target));
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM move_records WHERE work_id = 'shared-1'").get().local_path), path.resolve(fixture.source));
  assert.equal(fs.existsSync(fixture.source), true);
  assert.equal(fs.existsSync(fixture.target), true);
  await service.close();
  db.close();
}

async function verifySharedOwnerBeforeCleanupRetainsSource() {
  const fixture = await createFixture("shared-before-cleanup", 5);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture, { sharedConflictAtCheck: 4 });
  const service = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db, workerDataPatch: { forceCopy: true } });
  const started = service.start("1", { personId: "target", idempotencyKey: "shared-before-cleanup" });
  const pending = await waitForJobMatching(
    service,
    started.id,
    (job) => job.status === "cleanup_pending" && /another local_work owner/.test(job.error || "")
  );
  assert.equal(pending.phase, "isolating", "the durable isolation checkpoint must remain recoverable after the source is restored");
  assert.match(pending.error, /another local_work owner/);
  assert.equal(admin.imageCommits, 1);
  assert.equal(pending.result?.moved, true, "durable moved result stays available while cleanup is blocked");
  assert.equal(admin.sharedChecks, 4, "the source must be checked again under a write lock after atomic isolation");
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM move_records WHERE work_id = 'shared-4'").get().local_path), path.resolve(fixture.source));
  assert.equal(fs.existsSync(fixture.source), true, "a late shared owner must restore and retain the original source directory");
  assert.equal(fs.existsSync(fixture.target), true);
  const quarantine = path.join(fixture.sourcePerson, `.${path.basename(fixture.source)}.fanhao-quarantine-${started.id}`);
  assert.equal(fs.existsSync(quarantine), false, "shared-owner failure after isolation must restore the quarantine to the source path");
  await service.close();
  db.close();
}

async function verifySilentWorkerExitFails() {
  const fixture = await createFixture("silent-worker", 2);
  const silentWorkerPath = path.join(fixture.root, "silent-worker.mjs");
  await fs.promises.writeFile(silentWorkerPath, "process.exit(0);\n", "utf8");
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const lifecycle = [];
  const service = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    log: (line) => lifecycle.push(String(line)),
    workerUrl: pathToFileURL(silentWorkerPath)
  });
  const started = service.start("1", { personId: "target", idempotencyKey: "silent-worker" });
  const failed = await waitForJob(service, started.id, ["failed"], 3_000);
  assert.match(failed.error, /没有返回完成消息/);
  assert.equal(fs.existsSync(fixture.source), true);
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM move_records WHERE work_id = '1'").get().local_path), path.resolve(fixture.source));
  assert.ok(lifecycle.some((line) => line.includes('"event":"failed"')));
  assert.equal(lifecycle.some((line) => line.includes(fixture.source)), false, "failed lifecycle logs must not expose absolute paths");
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

function runMoveWorker(workerData, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../src/modules/fanhao/server/works/work-move-worker.js", import.meta.url), { workerData });
    let settled = false;
    worker.on("message", (message) => {
      if (message?.type === "progress") onProgress(message);
      else if (message?.type === "done") {
        settled = true;
        resolve(message.result || {});
      } else if (message?.type === "error") {
        settled = true;
        reject(new Error(message.error?.message || "worker failed"));
      }
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (!settled && code !== 0) reject(new Error(`worker exited ${code}`));
    });
  });
}

async function verifyCleanupQuarantineClosesLateFileRace() {
  const fixture = await createFixture("cleanup-quarantine-race", 5);
  await fs.promises.cp(fixture.source, fixture.target, { recursive: true, errorOnExist: true, force: false });
  const jobId = "late-file-fixture";
  const quarantinePath = path.join(fixture.sourcePerson, `.${path.basename(fixture.source)}.fanhao-quarantine-${jobId}`);
  let injected = false;
  await assert.rejects(
    runMoveWorker({
      jobId,
      operation: "cleanup",
      allowedRoots: [fixture.root],
      sourcePath: fixture.source,
      targetPath: fixture.target,
      quarantinePath,
      delayBeforeVerificationMs: 150
    }, (progress) => {
      if (progress.phase !== "verifying" || injected) return;
      injected = true;
      fs.rmSync(fixture.source, { force: true });
      fs.mkdirSync(fixture.source, { recursive: true });
      fs.writeFileSync(path.join(fixture.source, "late.bin"), "late data");
    }),
    /重新出现|拒绝删除/
  );
  assert.equal(injected, true, "fixture must add late.bin after the quarantined tree starts verification");
  assert.equal(fs.existsSync(path.join(fixture.source, "late.bin")), true, "late data at the live path must be preserved");
  assert.equal(fs.existsSync(quarantinePath), true, "the original tree must remain in job-owned quarantine for inspection/recovery");
  assert.equal(fs.existsSync(fixture.target), true);
}

async function verifySecondVerificationSourceRebuildFailsClosed() {
  const fixture = await createFixture("second-verify-source-race", 6);
  await fs.promises.cp(fixture.source, fixture.target, { recursive: true, errorOnExist: true, force: false });
  const jobId = "second-verify-fixture";
  const quarantinePath = path.join(fixture.sourcePerson, `.${path.basename(fixture.source)}.fanhao-quarantine-${jobId}`);
  let verificationCount = 0;
  await assert.rejects(
    runMoveWorker({
      jobId,
      operation: "cleanup",
      allowedRoots: [fixture.root],
      sourcePath: fixture.source,
      targetPath: fixture.target,
      quarantinePath,
      delayBeforeVerificationMs: 120
    }, (progress) => {
      if (progress.phase !== "verifying") return;
      verificationCount += 1;
      if (verificationCount !== 2) return;
      fs.rmSync(fixture.source, { force: true });
      fs.mkdirSync(fixture.source, { recursive: true });
      fs.writeFileSync(path.join(fixture.source, "late.bin"), "late after second verification started");
    }),
    /重建|替换|保护标记|拒绝/
  );
  assert.equal(verificationCount >= 2, true, "fixture must race after the second verification starts");
  assert.equal(fs.existsSync(path.join(fixture.source, "late.bin")), true);
  assert.equal(fs.existsSync(quarantinePath), true, "immutable snapshot must be retained when the source guard is replaced");
  assert.equal(fs.existsSync(fixture.target), true);
}

async function waitForOwnerChange(db, jobId, previousOwner, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = db.prepare("SELECT owner_id FROM work_move_jobs WHERE id = ?").get(jobId);
    if (row?.owner_id && row.owner_id !== previousOwner) return row.owner_id;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for a new lease owner for ${jobId}`);
}

async function verifyExpiredLeaseTakeoverFencesOldWorker() {
  const fixture = await createFixture("lease-takeover-fencing", 18);
  const db1 = createDatabase(fixture.root, fixture.source);
  const db2 = new DatabaseSync(path.join(fixture.root, "fixture.sqlite"));
  const admin = createAdminFixture(db1, fixture);
  let oldWorkerTerminations = 0;
  let oldWorkerTerminationResolved = false;
  let newWorkerStartedBeforeOldStop = false;
  const oldWorkerOperations = [];
  class TrackingWorker extends Worker {
    constructor(url, options) {
      super(url, options);
      oldWorkerOperations.push(options?.workerData?.operation || "");
    }
    terminate() {
      oldWorkerTerminations += 1;
      return super.terminate().then((code) => {
        oldWorkerTerminationResolved = true;
        return code;
      });
    }
  }
  class HandoffWorker extends Worker {
    constructor(url, options) {
      if (!oldWorkerTerminationResolved) newWorkerStartedBeforeOldStop = true;
      super(url, options);
    }
  }
  const first = createWorkMoveJobService({
    adminCoreMutationService: admin,
    checkpointIntervalMs: 5_000,
    getCoreDb: () => db1,
    workerClass: TrackingWorker,
    workerDataPatch: { forceCopy: true, delayPerFileMs: 80 }
  });
  const started = first.start("1", { personId: "target", idempotencyKey: "lease-takeover-fencing" });
  await waitForPhase(first, started.id, "copying");
  const oldOwner = db1.prepare("SELECT owner_id FROM work_move_jobs WHERE id = ?").get(started.id).owner_id;
  assert.ok(oldOwner);
  db1.prepare("UPDATE work_move_jobs SET lease_until = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(started.id);

  const second = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db2,
    workerClass: HandoffWorker,
    workerDataPatch: { forceCopy: true, delayPerFileMs: 5 }
  });
  second.recover();
  await waitForOwnerChange(db1, started.id, oldOwner);
  const completed = await waitForJob(second, started.id, ["completed"]);
  assert.equal(completed.phase, "completed");
  assert.ok(oldWorkerTerminations >= 1, "the stale owner must terminate its worker as soon as fencing detects takeover");
  assert.equal(oldWorkerTerminationResolved, true, "the stale worker termination promise must resolve before handoff acknowledgement");
  assert.equal(newWorkerStartedBeforeOldStop, false, "the new lease owner must not start a worker before the previous owner acknowledges termination");
  assert.equal(oldWorkerOperations.includes("rollback"), false, "the fenced owner must never start rollback after losing its lease");
  assert.equal(admin.imageCommits, 1, "the fenced owner must not reach image commit or rollback");
  assert.equal(fs.existsSync(fixture.source), false);
  assert.equal(fs.existsSync(fixture.target), true);
  await Promise.all([first.close(), second.close()]);
  db2.close();
  db1.close();
}

async function verifyAliveOwnerHandoffTimesOutBlocked() {
  const fixture = await createFixture("alive-owner-timeout", 2);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const dormant = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    log: () => {},
    schedule: () => {}
  });
  const started = dormant.start("1", { personId: "target", idempotencyKey: "alive-owner-timeout" });
  const staleOwner = `move-owner-${process.pid}-stale-fixture`;
  const plan = { ...admin.plan, jobId: started.id };
  db.prepare(`
    UPDATE work_move_jobs
    SET status = 'running', phase = 'prepared', plan_json = ?, owner_id = ?,
        lease_until = '2000-01-01T00:00:00.000Z', version = version + 1
    WHERE id = ?
  `).run(JSON.stringify(plan), staleOwner, started.id);
  await dormant.close();

  let workerStarts = 0;
  const lifecycle = [];
  class MustNotStartWorker extends Worker {
    constructor(...args) {
      workerStarts += 1;
      super(...args);
    }
  }
  const recovered = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    handoffTimeoutMs: 90,
    leaseDurationMs: 300,
    log: (message) => lifecycle.push(String(message)),
    workerClass: MustNotStartWorker
  });
  const blocked = await waitForJob(recovered, started.id, ["blocked"], 2_000);
  assert.equal(blocked.phase, "handoff_timeout");
  assert.equal(blocked.errorCode, "WORK_MOVE_HANDOFF_TIMEOUT");
  assert.match(blocked.error, /双重文件操作|人工处理/);
  assert.equal(workerStarts, 0, "an alive PID without owner acknowledgement must never start a new worker");
  await waitForCondition(
    () => db.prepare("SELECT owner_id, lease_until FROM work_move_jobs WHERE id = ?").get(started.id).owner_id === "",
    "blocked handoff must release the journal lease"
  );
  const parked = db.prepare("SELECT owner_id, lease_until, version FROM work_move_jobs WHERE id = ?").get(started.id);
  await new Promise((resolve) => setTimeout(resolve, 360));
  const afterHeartbeatWindow = db.prepare("SELECT owner_id, lease_until, version FROM work_move_jobs WHERE id = ?").get(started.id);
  assert.equal(afterHeartbeatWindow.owner_id, "");
  assert.equal(afterHeartbeatWindow.lease_until, "");
  assert.equal(afterHeartbeatWindow.version, parked.version, "blocked handoff must stop renewing its lease");
  assert.ok(lifecycle.some((line) => line.includes('"event":"blocked"') && line.includes("WORK_MOVE_HANDOFF_TIMEOUT")));
  assert.equal(lifecycle.some((line) => line.includes(fixture.source)), false, "structured lifecycle logs must not expose absolute media paths");
  await recovered.close();
  db.close();
}

async function verifyHandoffAckWinsTimeoutCasRace() {
  const fixture = await createFixture("handoff-ack-timeout-race", 2);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const dormant = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    log: () => {},
    schedule: () => {}
  });
  const started = dormant.start("1", { personId: "target", idempotencyKey: "handoff-ack-timeout-race" });
  const staleOwner = `move-owner-${process.pid}-ack-race-fixture`;
  db.prepare(`
    UPDATE work_move_jobs
    SET status = 'running', phase = 'prepared', plan_json = ?, owner_id = ?,
        lease_until = '2000-01-01T00:00:00.000Z', version = version + 1
    WHERE id = ?
  `).run(JSON.stringify({ ...admin.plan, jobId: started.id }), staleOwner, started.id);
  await dormant.close();

  let ackInjected = false;
  const racingDb = {
    exec: db.exec.bind(db),
    prepare(sql) {
      const statement = db.prepare(sql);
      const normalized = String(sql).replace(/\s+/g, " ");
      const timeoutBlockStatement = normalized.includes("SET status = 'blocked', phase = 'handoff_timeout'");
      const genericStateStatement = normalized.includes("SET status = ?, phase = ?, error = ?");
      if (!timeoutBlockStatement && !genericStateStatement) return statement;
      return {
        run(...args) {
          const attemptsTimeoutBlock = timeoutBlockStatement
            || (genericStateStatement && args[0] === "blocked" && args[1] === "handoff_timeout");
          if (!ackInjected && attemptsTimeoutBlock) {
            const before = db.prepare("SELECT owner_id, handoff_from, handoff_ack FROM work_move_jobs WHERE id = ?").get(started.id);
            assert.notEqual(before.owner_id, "");
            assert.equal(before.handoff_from, staleOwner);
            assert.equal(before.handoff_ack, "");
            db.prepare(`
              UPDATE work_move_jobs
              SET handoff_ack = ?, updated_at = ?, version = version + 1
              WHERE id = ? AND handoff_from = ? AND owner_id <> ?
            `).run(staleOwner, new Date().toISOString(), started.id, staleOwner, staleOwner);
            ackInjected = true;
          }
          return statement.run(...args);
        }
      };
    }
  };
  let workerStarts = 0;
  class AckRaceWorker extends Worker {
    constructor(...args) {
      workerStarts += 1;
      super(...args);
    }
  }
  const lifecycle = [];
  const recovered = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => racingDb,
    handoffTimeoutMs: 75,
    leaseDurationMs: 300,
    log: (message) => lifecycle.push(String(message)),
    workerClass: AckRaceWorker,
    workerDataPatch: { forceCopy: true }
  });
  const completed = await waitForJob(recovered, started.id, ["completed"], 5_000);
  assert.equal(ackInjected, true, "fixture must inject the prior-owner ACK after timeout observation and before the blocked CAS");
  assert.ok(workerStarts > 0, "the acknowledged handoff must proceed to worker execution");
  assert.equal(completed.phase, "completed");
  assert.equal(lifecycle.some((line) => line.includes('"event":"blocked"')), false, "a winning ACK must never be published as blocked");
  const journal = db.prepare("SELECT status, owner_id, lease_until FROM work_move_jobs WHERE id = ?").get(started.id);
  assert.equal(journal.status, "completed", "the timeout/ACK race must not strand an active unowned job");
  assert.equal(journal.owner_id, "");
  assert.equal(journal.lease_until, "");
  await recovered.close();
  db.close();
}

async function verifyHandoffBusyRetryPreservesOutstandingFence() {
  const fixture = await createFixture("handoff-busy-retry-fence", 2);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const originalPrepare = admin.prepareWorkMove.bind(admin);
  let prepareCalls = 0;
  admin.prepareWorkMove = (...args) => {
    prepareCalls += 1;
    return originalPrepare(...args);
  };
  const dormant = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    log: () => {},
    schedule: () => {}
  });
  const started = dormant.start("1", { personId: "target", idempotencyKey: "handoff-busy-retry-fence" });
  const staleOwner = `move-owner-${process.pid}-stale-busy-retry`;
  db.prepare(`
    UPDATE work_move_jobs
    SET status = 'running', phase = 'prepared', plan_json = '', owner_id = ?,
        lease_until = '2000-01-01T00:00:00.000Z', version = version + 1
    WHERE id = ?
  `).run(staleOwner, started.id);
  await dormant.close();

  let injectedBusy = false;
  const wrappedDb = {
    exec: db.exec.bind(db),
    prepare(sql) {
      const statement = db.prepare(sql);
      const normalized = String(sql).replace(/\s+/g, " ");
      if (!normalized.includes("SET lease_until = ?, version = version + 1")) return statement;
      return {
        run(...args) {
          if (!injectedBusy) {
            injectedBusy = true;
            throw Object.assign(new Error("database is locked by handoff fixture"), { code: "SQLITE_BUSY" });
          }
          return statement.run(...args);
        }
      };
    }
  };
  let workerStarts = 0;
  class MustNotStartWorker extends Worker {
    constructor(...args) {
      workerStarts += 1;
      super(...args);
    }
  }
  const recovered = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => wrappedDb,
    handoffTimeoutMs: 450,
    leaseDurationMs: 300,
    log: () => {},
    warn: () => {},
    workerClass: MustNotStartWorker
  });
  const blocked = await waitForJob(recovered, started.id, ["blocked"], 3_000);
  assert.equal(injectedBusy, true, "fixture must fence and requeue the handoff waiter through heartbeat SQLITE_BUSY");
  assert.equal(blocked.phase, "handoff_timeout");
  assert.equal(prepareCalls, 0, "BUSY requeue must keep waiting for the live prior owner before preparing a move");
  assert.equal(workerStarts, 0, "BUSY requeue must never start a worker without the prior-owner ACK");
  await waitForCondition(
    () => db.prepare("SELECT owner_id FROM work_move_jobs WHERE id = ?").get(started.id).owner_id === "",
    "blocked BUSY handoff must release its current owner"
  );
  const journal = db.prepare("SELECT status, owner_id, handoff_from, handoff_ack FROM work_move_jobs WHERE id = ?").get(started.id);
  assert.equal(journal.status, "blocked");
  assert.equal(journal.owner_id, "");
  assert.equal(journal.handoff_from, staleOwner, "the outstanding handoff provenance must survive fence/release/reclaim");
  assert.equal(journal.handoff_ack, "");
  await recovered.close();
  db.close();
}

async function verifyCloseDuringHandoffRequeuesWithoutDroppingFence() {
  const fixture = await createFixture("handoff-close-requeue-fence", 2);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const originalPrepare = admin.prepareWorkMove.bind(admin);
  let prepareCalls = 0;
  admin.prepareWorkMove = (...args) => {
    prepareCalls += 1;
    return originalPrepare(...args);
  };
  const dormant = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    log: () => {},
    schedule: () => {}
  });
  const started = dormant.start("1", { personId: "target", idempotencyKey: "handoff-close-requeue-fence" });
  const staleOwner = `move-owner-${process.pid}-stale-close-requeue`;
  db.prepare(`
    UPDATE work_move_jobs
    SET status = 'running', phase = 'prepared', plan_json = '', owner_id = ?,
        lease_until = '2000-01-01T00:00:00.000Z', version = version + 1
    WHERE id = ?
  `).run(staleOwner, started.id);
  await dormant.close();

  const middle = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    handoffTimeoutMs: 5_000,
    leaseDurationMs: 6_000,
    log: () => {}
  });
  await waitForOwnerChange(db, started.id, staleOwner);
  await middle.close();
  const parked = db.prepare("SELECT status, phase, owner_id, lease_until, handoff_from, handoff_ack FROM work_move_jobs WHERE id = ?").get(started.id);
  assert.equal(parked.status, "queued", "close during handoff must downgrade fake-running state to its recovery status");
  assert.equal(parked.phase, "prepared");
  assert.equal(parked.owner_id, "");
  assert.equal(parked.lease_until, "");
  assert.equal(parked.handoff_from, staleOwner);
  assert.equal(parked.handoff_ack, "");

  let workerStarts = 0;
  class MustNotStartWorker extends Worker {
    constructor(...args) {
      workerStarts += 1;
      super(...args);
    }
  }
  const finalOwner = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    handoffTimeoutMs: 350,
    leaseDurationMs: 300,
    log: () => {},
    workerClass: MustNotStartWorker
  });
  await new Promise((resolve) => setTimeout(resolve, 120));
  const waiting = db.prepare("SELECT status, owner_id, handoff_from, handoff_ack FROM work_move_jobs WHERE id = ?").get(started.id);
  assert.ok(waiting.owner_id, "the next service must claim the safely requeued job");
  assert.equal(waiting.handoff_from, staleOwner);
  assert.equal(waiting.handoff_ack, "");
  assert.equal(prepareCalls, 0, "a reclaim after close must not prepare before the live old owner ACKs");
  assert.equal(workerStarts, 0);
  const blocked = await waitForJob(finalOwner, started.id, ["blocked"], 3_000);
  assert.equal(blocked.phase, "handoff_timeout");
  assert.equal(prepareCalls, 0, "a live old PID without ACK must never reach prepare after close/reclaim");
  assert.equal(workerStarts, 0, "a live old PID without ACK must never start a worker after close/reclaim");
  await waitForCondition(
    () => db.prepare("SELECT owner_id FROM work_move_jobs WHERE id = ?").get(started.id).owner_id === "",
    "blocked close/reclaim handoff must release its current owner"
  );
  await finalOwner.close();
  db.close();
}

async function verifyRetryCasBusyAndBlockedContract() {
  const fixture = await createFixture("retry-contract", 1);
  const db = createDatabase(fixture.root, fixture.source);
  db.exec("PRAGMA busy_timeout = 20");
  const admin = createAdminFixture(db, fixture);
  const service = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    log: () => {},
    schedule: () => {}
  });
  const started = service.start("1", { personId: "target", idempotencyKey: "retry-contract" });
  db.prepare("UPDATE work_move_jobs SET status = 'failed', phase = 'validation', error = 'fixture failed', version = version + 1 WHERE id = ?").run(started.id);
  const before = db.prepare("SELECT version, attempts FROM work_move_jobs WHERE id = ?").get(started.id);
  const retried = service.retry(started.id);
  const after = db.prepare("SELECT version, attempts FROM work_move_jobs WHERE id = ?").get(started.id);
  assert.equal(retried.status, "queued");
  assert.equal(after.version, before.version + 1, "retry must advance the CAS version");
  assert.equal(after.attempts, before.attempts + 1);

  db.prepare("UPDATE work_move_jobs SET status = 'failed', phase = 'validation', version = version + 1 WHERE id = ?").run(started.id);
  const competingDb = new DatabaseSync(path.join(fixture.root, "fixture.sqlite"));
  competingDb.exec("PRAGMA busy_timeout = 20; BEGIN IMMEDIATE");
  assert.throws(
    () => service.retry(started.id),
    (error) => error?.statusCode === 503 && error?.code === "WORK_MOVE_SQLITE_BUSY" && error?.retryable === true,
    "retry SQLITE_BUSY must become a stable retryable 503"
  );
  competingDb.exec("ROLLBACK");
  competingDb.close();

  const casDb = {
    exec: db.exec.bind(db),
    prepare(sql) {
      const statement = db.prepare(sql);
      if (!String(sql).includes("WHERE id = ? AND status = ? AND version = ?")) return statement;
      return {
        run(...args) {
          db.prepare("UPDATE work_move_jobs SET version = version + 1 WHERE id = ?").run(args[1]);
          return statement.run(...args);
        }
      };
    }
  };
  const casService = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => casDb,
    log: () => {},
    schedule: () => {}
  });
  assert.throws(
    () => casService.retry(started.id),
    (error) => error?.statusCode === 409
      && error?.code === "WORK_MOVE_RETRY_CONFLICT"
      && error?.job?.id === started.id
      && error?.job?.status === "failed",
    "retry must fail closed when status/version changes before its CAS update"
  );
  assert.equal(db.prepare("SELECT status FROM work_move_jobs WHERE id = ?").get(started.id).status, "failed");
  await casService.close();

  db.prepare("UPDATE work_move_jobs SET status = 'blocked', phase = 'manual_review', error = 'fixture manual review', error_code = 'FIXTURE_BLOCKED', version = version + 1 WHERE id = ?").run(started.id);
  assert.throws(
    () => service.retry(started.id),
    (error) => error?.statusCode === 409
      && error?.code === "WORK_MOVE_MANUAL_INTERVENTION_REQUIRED"
      && error?.job?.id === started.id
      && error?.job?.status === "blocked",
    "blocked retry must return an explicit manual-intervention conflict with the job"
  );

  let response = null;
  await routeWorksApi(
    { method: "POST" },
    {},
    new URL(`http://fixture/api/work-move-jobs/${started.id}/retry`),
    {
      notFound() {},
      personDetailService: {},
      readJsonBody: async () => ({}),
      requireLocalAdmin: () => true,
      requireTrustedFileMutation: () => true,
      sendJson: (_res, status, payload) => { response = { status, payload }; },
      workDetailService: {},
      workMutationService: {
        retryMoveJob(jobId) {
          return { ok: true, job: service.retry(jobId) };
        }
      },
      workQueryService: {}
    }
  );
  assert.equal(response?.status, 409);
  assert.equal(response?.payload?.code, "WORK_MOVE_MANUAL_INTERVENTION_REQUIRED");
  assert.equal(response?.payload?.job?.id, started.id);
  assert.equal(response?.payload?.job?.status, "blocked");

  db.prepare("UPDATE work_move_jobs SET status = 'failed', phase = 'validation', error = 'old failure', error_code = 'OLD_FAILURE', version = version + 1 WHERE id = ?").run(started.id);
  const restarted = service.start("1", { personId: "target", idempotencyKey: "retry-contract" });
  assert.equal(restarted.id, started.id);
  assert.equal(restarted.status, "queued");
  assert.equal(restarted.error, "");
  assert.equal(restarted.errorCode, "", "idempotent start revival must clear the previous terminal error code");
  await service.close();
  db.close();
}

async function verifyMoveJobListApiAndRedaction() {
  const fixture = await createFixture("ops-list", 1);
  const db = createDatabase(fixture.root, fixture.source);
  const imageDbPath = path.join(fixture.root, "ops-images.sqlite");
  db.exec(`
    ATTACH DATABASE ${JSON.stringify(imageDbPath)} AS fanhao_images;
    CREATE TABLE work_move_path_reservations (job_id TEXT PRIMARY KEY, released_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE fanhao_images.work_move_path_reservations (job_id TEXT PRIMARY KEY, released_at TEXT NOT NULL DEFAULT '');
  `);
  const service = createWorkMoveJobService({
    adminCoreMutationService: createAdminFixture(db, fixture),
    getCoreDb: () => db,
    log: () => {},
    now: () => "2026-08-11T12:00:00.000Z",
    schedule: () => {}
  });
  const insert = db.prepare(`
    INSERT INTO work_move_jobs (
      id, request_key, work_id, person_id, status, phase, request_json, plan_json,
      result_json, attempts, error, error_code, created_at, updated_at, finished_at
    ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `);
  const absoluteSecret = path.join(fixture.root, "private", "WORK-SECRET");
  insert.run("ops-running", "ops-running-key", "1", "running", "copying", "{}", JSON.stringify({ oldDir: absoluteSecret }), "{}", "", "", "2026-08-11T11:40:00.000Z", "2026-08-11T11:45:00.000Z", "");
  insert.run("ops-failed", "ops-failed-key", "2", "failed", "validation", JSON.stringify({ targetDirectory: absoluteSecret }), "", JSON.stringify({ oldPath: absoluteSecret }), `failed at C:\\media\\secret\\WORK-001 and ${absoluteSecret}`, "FIXTURE_FAILED", "2026-08-11T11:00:00.000Z", "2026-08-11T11:10:00.000Z", "2026-08-11T11:10:00.000Z");
  insert.run("ops-completed", "ops-completed-key", "3", "completed", "completed", "{}", "", "{}", "", "", "2026-08-11T11:20:00.000Z", "2026-08-11T11:30:00.000Z", "2026-08-11T11:30:00.000Z");
  insert.run("ops-rolled-back", "ops-rolled-back-key", "4", "rolled_back", "rolled_back", "{}", "", "{}", "old terminal", "FIXTURE_ROLLED_BACK", "2026-08-11T08:00:00.000Z", "2026-08-11T09:00:00.000Z", "2026-08-11T09:00:00.000Z");
  db.prepare("INSERT INTO work_move_path_reservations(job_id) VALUES ('ops-running')").run();
  db.prepare("INSERT INTO fanhao_images.work_move_path_reservations(job_id) VALUES ('ops-running')").run();

  const listed = service.list({ status: "failed", workId: "2", limit: "10" });
  assert.deepEqual(listed.jobs.map((job) => job.id), ["ops-failed"]);
  assert.equal(listed.summary.active, 1);
  assert.equal(listed.summary.failed, 1);
  assert.equal(listed.summary.rolledBack, 1);
  assert.equal(listed.summary.activeReservations, 1, "dual-schema reservation rows must count as one active job");
  assert.equal(listed.summary.oldestOutstandingAgeMs, 50 * 60 * 1000, "terminal rolled_back jobs must not make outstanding age grow forever");
  assert.equal(listed.jobs[0].error, "迁移未完成，请根据错误代码检查服务端日志。");
  assert.equal(JSON.stringify(listed).includes("C:\\media\\secret"), false, "list API must replace stored errors with a safe message");
  assert.equal(JSON.stringify(listed).includes(absoluteSecret), false, "list payload must not expose request, plan, result, or absolute paths");
  assert.throws(() => service.list({ status: "not-a-status" }), (error) => error?.statusCode === 400 && error?.code === "WORK_MOVE_STATUS_INVALID");

  let deniedCalls = 0;
  let response = null;
  const deps = {
    notFound() {},
    personDetailService: {},
    readJsonBody: async () => ({}),
    requireLocalAdmin: () => false,
    requireTrustedFileMutation: () => true,
    sendJson: (_res, status, payload) => { response = { status, payload }; },
    workDetailService: {},
    workMutationService: {
      listMoveJobs(options) {
        deniedCalls += 1;
        return { ok: true, ...service.list(options) };
      }
    },
    workQueryService: {}
  };
  await routeWorksApi({ method: "GET" }, {}, new URL("http://fixture/api/work-move-jobs?status=failed&workId=2&limit=10"), deps);
  assert.equal(deniedCalls, 0, "list route must not query the journal when local-admin authorization fails");
  deps.requireLocalAdmin = () => true;
  await routeWorksApi({ method: "GET" }, {}, new URL("http://fixture/api/work-move-jobs?status=failed&workId=2&limit=10"), deps);
  assert.equal(response?.status, 200);
  assert.deepEqual(response?.payload?.jobs?.map((job) => job.id), ["ops-failed"]);
  assert.equal(JSON.stringify(response.payload).includes(absoluteSecret), false);
  deps.workMutationService.listMoveJobs = () => {
    throw Object.assign(new Error("cannot open C:\\media\\secret\\journal.sqlite"), { statusCode: 500 });
  };
  await routeWorksApi({ method: "GET" }, {}, new URL("http://fixture/api/work-move-jobs"), deps);
  assert.equal(response?.status, 500);
  assert.equal(response?.payload?.code, "WORK_MOVE_LIST_FAILED");
  assert.equal(JSON.stringify(response.payload).includes("C:\\media\\secret"), false, "list route failures must not echo internal database or media paths");

  const mutationService = createWorkMutationService({
    adminCoreMutationService: {},
    generateWorkCover: () => null,
    manualCoverStateService: {},
    publicWork: (work) => work,
    resolveLibraryWorkByPublicId: () => null,
    workLocalMutationService: {},
    workMoveJobService: service
  });
  deps.workMutationService = mutationService;
  db.prepare("UPDATE work_move_jobs SET result_json = ?, version = version + 1 WHERE id = 'ops-completed'")
    .run(JSON.stringify({ oldPath: absoluteSecret }));
  await routeWorksApi({ method: "POST" }, {}, new URL("http://fixture/api/work-move-jobs/ops-completed/retry"), deps);
  assert.equal(response?.status, 202);
  assert.equal(response?.payload?.job?.id, "ops-completed");
  assert.equal("result" in response.payload.job, false, "retry success payload must use the same sanitized job contract as the list API");
  assert.equal(JSON.stringify(response.payload).includes(absoluteSecret), false, "retry success must not expose persisted result paths");

  db.prepare(`
    UPDATE work_move_jobs
    SET status = 'blocked', phase = 'manual_review', error = ?, result_json = ?, error_code = 'FIXTURE_BLOCKED', version = version + 1
    WHERE id = 'ops-failed'
  `).run(`manual review at ${absoluteSecret}`, JSON.stringify({ oldPath: absoluteSecret }));
  await routeWorksApi({ method: "POST" }, {}, new URL("http://fixture/api/work-move-jobs/ops-failed/retry"), deps);
  assert.equal(response?.status, 409);
  assert.equal(response?.payload?.code, "WORK_MOVE_MANUAL_INTERVENTION_REQUIRED");
  assert.equal(response?.payload?.job?.id, "ops-failed");
  assert.equal(JSON.stringify(response.payload).includes(absoluteSecret), false, "retry errors and embedded jobs must be sanitized together");

  const safeJobFields = [
    "id", "workId", "personId", "status", "phase", "progress", "progressFiles", "totalFiles",
    "progressBytes", "totalBytes", "attempts", "errorCode", "error", "createdAt", "updatedAt",
    "finishedAt", "recoverable"
  ].sort();
  const assertSafeNestedJobResponse = (payload, label) => {
    assert.equal(payload?.ok, true, `${label} must keep the normal success envelope`);
    assert.deepEqual(Object.keys(payload.job || {}).sort(), safeJobFields, `${label} must use the exact public job serializer`);
    assert.equal(JSON.stringify(payload).includes(absoluteSecret), false, `${label} must not expose persisted paths or raw request data`);
    assert.equal("result" in payload.job, false, `${label} must not expose worker result details`);
  };

  // These are the three nested job routes. Use the real mutation service so a
  // future publicJob field cannot silently cross an HTTP boundary.
  db.prepare("UPDATE work_move_jobs SET result_json = ?, version = version + 1 WHERE id = 'ops-running'")
    .run(JSON.stringify({ oldPath: absoluteSecret, work: { sourcePath: absoluteSecret } }));
  deps.requireLocalAdmin = () => true;
  deps.readJsonBody = async () => ({ personId: "target", sourcePath: absoluteSecret });
  deps.workMutationService = mutationService;
  await routeWorksApi({ method: "POST" }, {}, new URL("http://fixture/api/works/nested%2Fwork/move-to-person"), deps);
  assert.equal(response?.status, 202);
  assertSafeNestedJobResponse(response.payload, "move-to-person response");
  await routeWorksApi({ method: "GET" }, {}, new URL("http://fixture/api/work-move-jobs/ops-failed"), deps);
  assert.equal(response?.status, 200);
  assertSafeNestedJobResponse(response.payload, "single job response");
  await routeWorksApi({ method: "GET" }, {}, new URL("http://fixture/api/works/1/move-job"), deps);
  assert.equal(response?.status, 200);
  assertSafeNestedJobResponse(response.payload, "current work job response");

  deps.workMutationService = {
    moveJob() {
      const error = Object.assign(new Error(`raw journal error at ${absoluteSecret}`), {
        statusCode: 500,
        job: service.get("ops-failed")
      });
      throw error;
    }
  };
  await routeWorksApi({ method: "GET" }, {}, new URL("http://fixture/api/work-move-jobs/ops-failed"), deps);
  assert.equal(response?.status, 500);
  assert.equal(response?.payload?.error, "读取迁移任务失败");
  assert.equal(JSON.stringify(response.payload).includes(absoluteSecret), false, "nested job route errors must not echo raw errors or embedded job paths");

  let unauthorizedRetryCalls = 0;
  deps.requireLocalAdmin = () => false;
  deps.workMutationService = { retryMoveJob: () => { unauthorizedRetryCalls += 1; } };
  await routeWorksApi({ method: "POST" }, {}, new URL("http://fixture/api/work-move-jobs/ops-failed/retry"), deps);
  assert.equal(unauthorizedRetryCalls, 0, "retry route must not touch the journal when local-admin authorization fails");
  await service.close();
  db.close();
}

async function verifyTargetParentJunctionSwapBlocksPublish() {
  const fixture = await createFixture("target-junction-swap", 8);
  const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fanhao-move-target-junction-outside-"));
  temporaryRoots.push(outside);
  const movedParent = path.join(fixture.root, "target-person-before-junction");
  let swapped = false;
  await assert.rejects(
    runMoveWorker({
      jobId: "target-junction-swap",
      operation: "stage",
      allowedRoots: [fixture.root],
      sourcePath: fixture.source,
      targetPath: fixture.target,
      stagingPath: `${fixture.target}.fanhao-move-target-junction-swap`,
      forceCopy: true,
      delayBeforePublishMs: 150
    }, (progress) => {
      if (progress.phase !== "publishing" || swapped) return;
      swapped = true;
      fs.renameSync(fixture.targetPerson, movedParent);
      fs.symlinkSync(outside, fixture.targetPerson, process.platform === "win32" ? "junction" : "dir");
    }),
    /链接|根目录/
  );
  assert.equal(swapped, true, "fixture must replace the target parent after verification and before publish");
  assert.equal(fs.existsSync(fixture.source), true, "publish rejection must preserve the source");
  assert.equal(fs.existsSync(path.join(outside, path.basename(fixture.target))), false, "no target may be published through the junction");
  assert.equal(fs.existsSync(`${path.join(movedParent, path.basename(fixture.target))}.fanhao-move-target-junction-swap`), true, "verified staging data stays inside the allowed root for recovery");
}

async function verifyDatabaseLeasePreventsDoubleExecution() {
  const fixture = await createFixture("double-service-lease", 8);
  const db1 = createDatabase(fixture.root, fixture.source);
  const db2 = new DatabaseSync(path.join(fixture.root, "fixture.sqlite"));
  const admin = createAdminFixture(db1, fixture);
  const first = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db1,
    workerDataPatch: { forceCopy: true, delayPerFileMs: 15 }
  });
  const second = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db2,
    workerDataPatch: { forceCopy: true, delayPerFileMs: 15 }
  });
  const started = first.start("1", { personId: "target", idempotencyKey: "double-service-lease" });
  second.recover();
  const completed = await waitForJob(first, started.id, ["completed"]);
  assert.equal(completed.attempts, 1);
  assert.equal(second.get(started.id).status, "completed");
  assert.equal(admin.imageCommits, 1, "only the SQLite lease owner may execute the attached image phase");
  const journal = db1.prepare("SELECT owner_id, lease_until, version FROM work_move_jobs WHERE id = ?").get(started.id);
  assert.equal(journal.owner_id, "", "the winning service must release its durable claim");
  assert.equal(journal.lease_until, "");
  assert.ok(Number(journal.version) > 1);
  assert.equal(fs.existsSync(fixture.source), false);
  assert.equal(fs.existsSync(fixture.target), true);
  await Promise.all([first.close(), second.close()]);
  db2.close();
  db1.close();
}

async function verifySqliteBusyClaimRetriesAndHeartbeatRecovers() {
  const claimFixture = await createFixture("claim-busy-retry", 5);
  const claimDb1 = createDatabase(claimFixture.root, claimFixture.source);
  claimDb1.exec("PRAGMA busy_timeout = 20");
  const claimDb2 = new DatabaseSync(path.join(claimFixture.root, "fixture.sqlite"));
  claimDb2.exec("PRAGMA busy_timeout = 20");
  const claimAdmin = createAdminFixture(claimDb1, claimFixture);
  const scheduled = [];
  const warnings = [];
  let uncaught = null;
  const onUncaught = (error) => { uncaught = error; };
  process.on("uncaughtException", onUncaught);
  try {
    const claimService = createWorkMoveJobService({
      adminCoreMutationService: claimAdmin,
      getCoreDb: () => claimDb1,
      schedule: (callback) => scheduled.push(callback),
      warn: (...args) => warnings.push(args.map(String).join(" ")),
      workerDataPatch: { forceCopy: true }
    });
    const started = claimService.start("1", { personId: "target", idempotencyKey: "claim-busy-retry" });
    claimDb2.exec("BEGIN IMMEDIATE");
    for (const callback of scheduled.splice(0)) callback();
    await new Promise((resolve) => setTimeout(resolve, 450));
    const queued = claimDb1.prepare("SELECT status, owner_id FROM work_move_jobs WHERE id = ?").get(started.id);
    assert.equal(queued.status, "queued");
    assert.equal(queued.owner_id, "", "a busy claim must remain durably queued until bounded backoff retries it");
    assert.equal(uncaught, null, "SQLITE_BUSY during claim must never escape as an uncaught process error");
    claimDb2.exec("COMMIT");
    try {
      await waitForJob(claimService, started.id, ["completed"]);
    } catch (error) {
      error.message += ` warnings=${JSON.stringify(warnings)}`;
      throw error;
    }
    await claimService.close();
  } finally {
    process.off("uncaughtException", onUncaught);
    try { claimDb2.exec("ROLLBACK"); } catch {}
    claimDb2.close();
    claimDb1.close();
  }

  const heartbeatFixture = await createFixture("heartbeat-busy-recovery", 12);
  const heartbeatDb1 = createDatabase(heartbeatFixture.root, heartbeatFixture.source);
  heartbeatDb1.exec("PRAGMA busy_timeout = 20");
  const heartbeatDb2 = new DatabaseSync(path.join(heartbeatFixture.root, "fixture.sqlite"));
  heartbeatDb2.exec("PRAGMA busy_timeout = 20");
  const heartbeatAdmin = createAdminFixture(heartbeatDb1, heartbeatFixture);
  const heartbeatWarnings = [];
  let heartbeatUncaught = null;
  const onHeartbeatUncaught = (error) => { heartbeatUncaught = error; };
  process.on("uncaughtException", onHeartbeatUncaught);
  try {
    const heartbeatService = createWorkMoveJobService({
      adminCoreMutationService: heartbeatAdmin,
      checkpointIntervalMs: 1_000,
      getCoreDb: () => heartbeatDb1,
      leaseDurationMs: 300,
      warn: (...args) => heartbeatWarnings.push(args.map(String).join(" ")),
      workerDataPatch: { forceCopy: true, delayPerFileMs: 80 }
    });
    const started = heartbeatService.start("1", { personId: "target", idempotencyKey: "heartbeat-busy-recovery" });
    await waitForPhase(heartbeatService, started.id, "copying");
    heartbeatDb2.exec("BEGIN IMMEDIATE");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(heartbeatUncaught, null, "heartbeat SQLITE_BUSY must be caught at the timer boundary");
    assert.ok(heartbeatWarnings.some((message) => message.includes("work-move-heartbeat")), "the caught heartbeat failure must be observable");
    heartbeatDb2.exec("COMMIT");
    const completed = await waitForJob(heartbeatService, started.id, ["completed"]);
    assert.equal(completed.phase, "completed", "a fenced busy heartbeat must automatically resume after the lock is released");
    await heartbeatService.close();
  } finally {
    process.off("uncaughtException", onHeartbeatUncaught);
    try { heartbeatDb2.exec("ROLLBACK"); } catch {}
    heartbeatDb2.close();
    heartbeatDb1.close();
  }
}

async function verifyLeaseSchemaMigratesExistingJournal() {
  const fixture = await createFixture("lease-schema-migration", 1);
  const db = createDatabase(fixture.root, fixture.source);
  db.exec(`
    CREATE TABLE work_move_jobs (
      id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, work_id TEXT NOT NULL,
      person_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, phase TEXT NOT NULL,
      request_json TEXT NOT NULL, plan_json TEXT NOT NULL DEFAULT '', result_json TEXT NOT NULL DEFAULT '',
      progress_files INTEGER NOT NULL DEFAULT 0, total_files INTEGER NOT NULL DEFAULT 0,
      progress_bytes INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, finished_at TEXT NOT NULL DEFAULT ''
    );
  `);
  const stamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO work_move_jobs (id, request_key, work_id, status, phase, request_json, created_at, updated_at)
    VALUES ('legacy-job', 'legacy-key', '1', 'failed', 'validation', '{}', ?, ?)
  `).run(stamp, stamp);
  const service = createWorkMoveJobService({
    adminCoreMutationService: createAdminFixture(db, fixture),
    getCoreDb: () => db,
    schedule: () => {}
  });
  const columns = new Set(db.prepare("PRAGMA table_info(work_move_jobs)").all().map((column) => column.name));
  assert.equal(columns.has("owner_id"), true);
  assert.equal(columns.has("lease_until"), true);
  assert.equal(columns.has("version"), true);
  const legacy = db.prepare("SELECT id, owner_id, lease_until, version FROM work_move_jobs WHERE id = 'legacy-job'").get();
  assert.equal(legacy.id, "legacy-job");
  assert.equal(legacy.owner_id, "");
  assert.equal(legacy.lease_until, "");
  assert.equal(legacy.version, 0);
  await service.close();
  db.close();
}

async function verifyLegacyPlanOutsideTrustedRootsFailsClosed() {
  const fixture = await createFixture("legacy-plan-fail-closed", 3);
  const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fanhao-move-legacy-outside-"));
  temporaryRoots.push(outside);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const legacyPlan = { ...admin.plan, newDir: path.join(outside, "WORK-001") };
  delete legacyPlan.libraryRoots;
  const dormant = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db, schedule: () => {} });
  const stamp = new Date().toISOString();
  db.prepare(`
    INSERT INTO work_move_jobs (
      id, request_key, work_id, person_id, status, phase, request_json, plan_json,
      attempts, created_at, updated_at
    ) VALUES ('legacy-outside', 'legacy-outside-key', '1', 'target', 'running', 'filesystem_ready', ?, ?, 1, ?, ?)
  `).run(JSON.stringify({ personId: "target" }), JSON.stringify(legacyPlan), stamp, stamp);
  await dormant.close();

  let workerStarts = 0;
  class MustNotStartWorker extends Worker {
    constructor(...args) {
      workerStarts += 1;
      super(...args);
    }
  }
  const recovered = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    workerClass: MustNotStartWorker
  });
  const failed = await waitForJob(recovered, "legacy-outside", ["failed"]);
  assert.equal(failed.phase, "validation");
  assert.match(failed.error, /根目录|可信/);
  assert.equal(workerStarts, 0, "an untrusted legacy plan must be rejected before any worker starts");
  assert.equal(fs.existsSync(fixture.source), true);
  assert.equal(fs.existsSync(legacyPlan.newDir), false);
  assert.equal(path.resolve(db.prepare("SELECT local_path FROM move_records WHERE work_id = '1'").get().local_path), path.resolve(fixture.source));
  await recovered.close();
  db.close();
}

async function verifyClosePreservesRollbackCheckpoint() {
  const fixture = await createFixture("close-rollback", 5);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture, { failCommit: true });
  const first = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    workerDataPatch: { forceCopy: true, delayBeforeRollbackMs: 600 }
  });
  const started = first.start("1", { personId: "target", idempotencyKey: "close-rollback" });
  await waitForPhase(first, started.id, "rollback");
  await first.close();
  const checkpoint = first.get(started.id);
  assert.equal(checkpoint.status, "rollback_pending", "close must not overwrite an interrupted rollback with queued/failed");
  assert.equal(checkpoint.phase, "rollback");

  const recovered = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db });
  const rolledBack = await waitForJob(recovered, started.id, ["rolled_back"]);
  assert.equal(rolledBack.phase, "rolled_back");
  assert.equal(fs.existsSync(fixture.source), true);
  assert.equal(fs.existsSync(fixture.target), false);
  await recovered.close();
  db.close();
}

async function verifyClosePreservesCleanupCheckpoint() {
  const fixture = await createFixture("close-cleanup", 5);
  const db = createDatabase(fixture.root, fixture.source);
  const admin = createAdminFixture(db, fixture);
  const first = createWorkMoveJobService({
    adminCoreMutationService: admin,
    getCoreDb: () => db,
    workerDataPatch: { forceCopy: true, delayBeforeCleanupMs: 600 }
  });
  const started = first.start("1", { personId: "target", idempotencyKey: "close-cleanup" });
  await waitForPhase(first, started.id, "cleanup");
  await first.close();
  const checkpoint = first.get(started.id);
  assert.equal(checkpoint.status, "cleanup_pending", "close must retain the post-commit cleanup recovery lane");
  assert.notEqual(checkpoint.status, "failed");
  assert.equal(fs.existsSync(fixture.source), true);
  assert.equal(fs.existsSync(fixture.target), true);

  const recovered = createWorkMoveJobService({ adminCoreMutationService: admin, getCoreDb: () => db });
  await waitForJob(recovered, started.id, ["completed"]);
  assert.equal(fs.existsSync(fixture.source), false);
  await recovered.close();
  db.close();
}

async function verifyJunctionEscapeIsRejected() {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fanhao-move-junction-root-"));
  const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), "fanhao-move-junction-outside-"));
  temporaryRoots.push(root, outside);
  const junction = path.join(root, "linked-outside");
  await fs.promises.symlink(outside, junction, process.platform === "win32" ? "junction" : "dir");
  assert.throws(
    () => ensureRealPathWithinRoots(path.join(junction, "new-person"), [root], "目标人物文件夹"),
    (error) => error?.statusCode === 400 && /链接|根目录/.test(error.message),
    "an existing junction ancestor must not project a write outside the library root"
  );
  assert.equal(ensureRealPathWithinRoots(path.join(root, "normal-person"), [root]), path.resolve(root, "normal-person"));
  const source = path.join(root, "source", "WORK-001");
  const escapedTarget = path.join(junction, "WORK-001");
  await fs.promises.mkdir(source, { recursive: true });
  await fs.promises.writeFile(path.join(source, "fixture.bin"), "fixture");
  await assert.rejects(runMoveWorker({
    jobId: "junction-worker",
    operation: "stage",
    allowedRoots: [root],
    sourcePath: source,
    targetPath: escapedTarget,
    stagingPath: `${escapedTarget}.staging`
  }), /链接|根目录/);
  assert.equal(fs.existsSync(source), true, "junction rejection must happen before moving the source");
  assert.equal(fs.existsSync(path.join(outside, "WORK-001")), false, "junction rejection must not create an outside target");
}

async function verifyConflictPayloadAndClientJobPropagation() {
  const conflictingJob = { id: "move_conflict", status: "running", phase: "copying" };
  let response = null;
  await routeWorksApi(
    { method: "POST" },
    {},
    new URL("http://fixture/api/works/1/move-to-person"),
    {
      notFound() {},
      personDetailService: {},
      readJsonBody: async () => ({ personId: "2" }),
      requireLocalAdmin: () => true,
      requireTrustedFileMutation: () => true,
      sendJson: (_res, status, payload) => { response = { status, payload }; },
      workDetailService: {},
      workMutationService: {
        moveToPerson() {
          const error = new Error("conflict");
          error.statusCode = 409;
          error.job = conflictingJob;
          throw error;
        }
      },
      workQueryService: {}
    }
  );
  assert.equal(response.status, 409);
  assert.equal(response.payload.job?.id, conflictingJob.id);
  assert.equal(response.payload.job?.status, conflictingJob.status);
  assert.equal(response.payload.job?.phase, conflictingJob.phase);
  assert.equal("result" in response.payload.job, false, "conflict jobs must cross the same public serializer boundary");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(response.payload), {
    status: 409,
    headers: { "content-type": "application/json" }
  });
  try {
    const client = createApiClient();
    await assert.rejects(client("/fixture"), (error) => error.statusCode === 409 && error.job?.id === conflictingJob.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

let verificationError = null;
try {
  await verifySuccessfulMoveAndIdempotency();
  await verifyWorkLookupRecoversLostStartResponse();
  await verifyOverlappingPathReservationsAreRejected();
  await verifyAllBusyStagesRequeue();
  await verifyConcurrentStartsAreAtomicallyUnique();
  await verifyLegacyDuplicateJobsMigrateFailClosed();
  await verifyActualAdminSqliteCommit();
  await verifyResultBeforeSourceCleanup();
  await verifyAttachedImageStageRecovery();
  await verifyIncrementalMemoryReconciliation();
  await verifyCrashRecoveryFromPreparedCopy();
  await verifyPartialCleanupRecovery();
  await verifyRollbackOnDatabaseFailure();
  await verifySharedOwnerAddedBeforeCommitRollsBackCopy();
  await verifySharedOwnerDuringImageStageBlocksCleanup();
  await verifySharedOwnerBeforeCleanupRetainsSource();
  await verifySilentWorkerExitFails();
  await verifySameSizeCorruptionBlocksDeletion();
  await verifyCleanupQuarantineClosesLateFileRace();
  await verifySecondVerificationSourceRebuildFailsClosed();
  await verifyLeaseSchemaMigratesExistingJournal();
  await verifyLegacyPlanOutsideTrustedRootsFailsClosed();
  await verifyExpiredLeaseTakeoverFencesOldWorker();
  await verifyAliveOwnerHandoffTimesOutBlocked();
  await verifyHandoffAckWinsTimeoutCasRace();
  await verifyHandoffBusyRetryPreservesOutstandingFence();
  await verifyCloseDuringHandoffRequeuesWithoutDroppingFence();
  await verifyDatabaseLeasePreventsDoubleExecution();
  await verifySqliteBusyClaimRetriesAndHeartbeatRecovers();
  await verifyRetryCasBusyAndBlockedContract();
  await verifyMoveJobListApiAndRedaction();
  await verifyClosePreservesRollbackCheckpoint();
  await verifyClosePreservesCleanupCheckpoint();
  await verifyJunctionEscapeIsRejected();
  await verifyTargetParentJunctionSwapBlocksPublish();
  await verifyConflictPayloadAndClientJobPropagation();
  await verifyHttpResponsivenessDuringCopy();
  verifySourceStructure();
  console.log("work-move-jobs: ok (atomic start, durable path reservation, idempotency, immutable quarantine, lease fencing/CAS, SQLITE_BUSY recovery, trusted-root recovery, rollback, responsive HTTP)");
} catch (error) {
  verificationError = error;
} finally {
  for (const root of temporaryRoots.reverse()) {
    try {
      await safeCleanup(root);
    } catch (error) {
      if (!verificationError) verificationError = error;
    }
  }
}
if (verificationError) throw verificationError;
