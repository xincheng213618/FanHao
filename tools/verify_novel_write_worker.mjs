import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createNovelStore, novelWriteOperationHash } from "../src/modules/novels/server/store.js";
import { createNovelWriteWorkerClient } from "../src/modules/novels/server/write-worker-client.js";
import { routeNovelApi } from "../src/modules/novels/server/routes.js";
import { createNovelReimportService } from "../src/modules/novels/server/reimport-service.js";
import { createNovelCollectionService } from "../src/modules/novels/server/collection-service.js";
import { createNovelsRuntime } from "../src/modules/novels/server/runtime.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-novel-writes-"));
const dbPath = path.join(temporary, "novels.sqlite");
const reader = createNovelStore({ dbPath });
const unhandled = [];
const onUnhandled = (error) => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
let faultNext = "";
let starts = 0;
const writer = createNovelWriteWorkerClient({
  dbPath, maxPending: 3, maxPendingBytes: 1024 * 1024, readyTimeoutMs: 2000, requestTimeoutMs: 800,
  onCommitted: () => reader.invalidate(),
  workerFactory(_url, options) {
    starts += 1;
    const fixtureFault = options.workerData.recovery ? "" : faultNext;
    if (!options.workerData.recovery) faultNext = "";
    return new Worker(new URL("./fixtures/novel-write-worker-fault.mjs", import.meta.url), { ...options, execArgv: [], workerData: { ...options.workerData, fixtureFault } });
  }
});
const novelStore = { ...reader, ...Object.fromEntries(["saveProgress", "updateBookMetadata", "uploadBook", "reimportBook", "importCollectedBook", "deleteBook"].map((method) => [method, writer[method]])) };
const text = "第一章 开始\n\n合成正文第一章。\n\n第二章 继续\n\n合成正文第二章。";
let blocker = null;
try {
  const first = reader.uploadBook({ fileName: "first.txt", text });
  await writer.start();
  blocker = new DatabaseSync(dbPath);
  blocker.exec("BEGIN IMMEDIATE");
  let timerRan = false;
  let replied = false;
  const progress = route("POST", `/api/novels/${first.book.id}/progress`, modern(first, 0.3)).then((res) => { replied = true; return res; });
  await delay(25).then(() => { timerRan = true; });
  assert.equal(replied, false, "a locked progress write must remain pending");
  assert.equal(timerRan, true, "the main-thread timer must run while SQLite waits in the write Worker");
  assert.equal(reader.bookMeta(first.book.id).book.id, first.book.id, "WAL reads remain available while the separate writer waits");
  blocker.exec("ROLLBACK"); blocker.close(); blocker = null;
  const saved = await progress;
  assert.equal(saved.status, 200);
  assert.equal(saved.data.progress.scrollRatio, 0.3);
  assert.equal(reader.bookMeta(first.book.id).book.progress.scrollRatio, 0.3);
  const privateReceiptBeforeFailure = receiptRows().filter((row) => !row.retain_receipt).map((row) => row.operation_id);
  assert.equal((await route("POST", `/api/novels/${first.book.id}/progress`, { ...modern(first), sourceRealm: "wrong" })).status, 409);
  assert.deepEqual(receiptRows().filter((row) => !row.retain_receipt).map((row) => row.operation_id), privateReceiptBeforeFailure, "a failed business transaction must roll back its piggyback cleanup");
  assert.equal(writer.diagnostics().acknowledgedReceipts, 1, "failed cleanup remains pending until a later confirmed commit");
  await assert.rejects(writer.saveProgress(first.book.id, { ...modern(first), sourceRealm: "wrong" }), (error) => error.statusCode === 409 && error.rollbackConfirmed === true && error.outcome === "not_committed");
  await writer.saveProgress(first.book.id, modern(first, 0.32));
  assert.ok(receiptRows().every((row) => !privateReceiptBeforeFailure.includes(row.operation_id)));
  for (let index = 0; index < 20; index += 1) await writer.saveProgress(first.book.id, modern(first, index / 100));
  assert.equal(receiptRows().filter((row) => !row.retain_receipt).length, 1, "confirmed high-frequency progress retains only the current unacknowledged private receipt");
  assert.equal((await route("POST", "/api/novels/missing/progress", {})).status, 404);

  const uploaded = await route("POST", "/api/novels/upload", { fileName: "second.txt", text });
  assert.equal(uploaded.status, 201);
  const book = uploaded.data.book;
  const metadata = await route("PATCH", `/api/novels/${book.id}`, { title: "校正书名" });
  assert.equal(metadata.status, 200); assert.equal(metadata.data.book.title, "校正书名");
  const reimported = await route("POST", `/api/novels/${book.id}/reimport`, { text: text + "\n新增正文" });
  assert.equal(reimported.status, 200); assert.equal(reimported.data.kind, "book");
  const collected = await writer.importCollectedBook({ sourceUrl: "https://fixture.invalid/book", title: "采集测试", chapters: [{ title: "章节", content: "私有采集正文" }] });
  assert.equal(collected.book.title, "采集测试");
  const deleted = await route("DELETE", `/api/novels/${book.id}?sourceRealm=${encodeURIComponent(book.sourceRealm)}`);
  assert.equal(deleted.status, 200); assert.equal(deleted.data.deleted.id, book.id);
  assert.equal(reader.bookMeta(book.id), null);

  blocker = new DatabaseSync(dbPath); blocker.exec("BEGIN IMMEDIATE");
  const disconnected = { status: 0, data: null, destroyed: false };
  const disconnectedTask = route("POST", `/api/novels/${first.book.id}/progress`, modern(first, 0.38), disconnected);
  await waitFor(() => writer.diagnostics().dispatched);
  disconnected.destroyed = true;
  blocker.exec("ROLLBACK"); blocker.close(); blocker = null;
  await disconnectedTask;
  assert.equal(disconnected.status, 0, "disconnecting an HTTP consumer must not write a late response or cancel a dispatched commit");
  assert.equal(reader.bookMeta(first.book.id).book.progress.scrollRatio, 0.38);

  const operationId = "fixture-upload-idempotency";
  const sourceRealm = reader.writeIdentity();
  const args = [{ fileName: "idempotent.txt", text }];
  const once = await writer.write("uploadBook", args, { operationId, sourceRealm });
  const twice = await writer.write("uploadBook", args, { operationId, sourceRealm });
  assert.deepEqual(twice, once, "same-operation replay returns the original upload, including its random book identity");
  await assert.rejects(writer.write("uploadBook", [{ fileName: "different.txt", text }], { operationId, sourceRealm }), (error) => error.statusCode === 409);

  for (const fault of ["exit-after-commit", "drop-reply", "error-after-commit"]) {
    await writer.stop(); faultNext = fault; await writer.start();
    const before = reader.summary().totals.books;
    const result = await writer.uploadBook({ fileName: `${fault}.txt`, text });
    assert.equal(reader.summary().totals.books, before + 1, `${fault}: receipt recovery must not repeat a committed upload`);
    assert.equal(reader.bookMeta(result.book.id).book.id, result.book.id);
  }
  await writer.stop(); faultNext = "exit-before-commit"; await writer.start();
  const beforeRollback = reader.summary().totals.books;
  await assert.rejects(writer.uploadBook({ fileName: "rollback.txt", text }), (error) => error.code === "NOVEL_WRITE_OUTCOME_UNKNOWN" && Boolean(error.operationId));
  assert.equal(reader.summary().totals.books, beforeRollback, "business SAVEPOINT release must not commit outside the receipt envelope");
  await writer.stop(); faultNext = "rollback-failure"; await writer.start();
  await assert.rejects(writer.uploadBook({ fileName: "failed-rollback.txt", text: "" }), (error) => error.code === "NOVEL_WRITE_OUTCOME_UNKNOWN" && Boolean(error.operationId));
  assert.equal(reader.summary().totals.books, beforeRollback, "a failed ROLLBACK must preserve unknown until receipt recovery rather than return the original business error");
  await writer.start();

  blocker = new DatabaseSync(dbPath); blocker.exec("BEGIN IMMEDIATE");
  const current = reader.bookMeta(first.book.id);
  const pending = writer.saveProgress(first.book.id, modern(current, 0.4));
  await waitFor(() => writer.diagnostics().dispatched);
  const queued = [writer.saveProgress(first.book.id, modern(current, 0.5)), writer.saveProgress(first.book.id, modern(current, 0.6))].map((promise) => promise.then(() => "ok", (error) => error.code));
  await assert.rejects(writer.saveProgress(first.book.id, modern(current, 0.7)), (error) => error.code === "NOVEL_WRITE_QUEUE_FULL");
  let stopped = false;
  const stopping = writer.stop().then(() => { stopped = true; });
  assert.deepEqual(await Promise.all(queued), ["NOVEL_WRITE_STOPPED", "NOVEL_WRITE_STOPPED"]);
  await delay(20); assert.equal(stopped, false, "shutdown must wait for a dispatched transaction instead of declaring it uncommitted");
  blocker.exec("ROLLBACK"); blocker.close(); blocker = null;
  await Promise.all([pending, stopping]);
  assert.equal(reader.bookMeta(first.book.id).book.progress.scrollRatio, 0.4);
  assert.equal(writer.diagnostics().pendingBytes, 0);
  await assert.rejects(writer.uploadBook({ text }), (error) => error.code === "NOVEL_WRITE_STOPPED");
  await writer.start();
  await assert.rejects(writer.uploadBook({ text: "x".repeat(600000) }), (error) => error.code === "NOVEL_WRITE_QUEUE_FULL");

  const moved = path.join(temporary, "original.sqlite");
  reader.invalidate(); fs.renameSync(dbPath, moved);
  const replacement = createNovelStore({ dbPath }); const replacementRealm = replacement.writeIdentity(); replacement.invalidate();
  assert.notEqual(replacementRealm, sourceRealm);
  await assert.rejects(writer.write("uploadBook", args, { operationId, sourceRealm }), (error) => error.statusCode === 409);
  const replacementResult = await writer.uploadBook({ fileName: "replacement.txt", text });
  assert.equal(replacementResult.sourceRealm, replacementRealm, "each operation must reopen the replaced database file");
  assert.equal(reader.readWriteReceipt({ operationId, sourceRealm, requestHash: novelWriteOperationHash("uploadBook", args) }).status, "realm_changed");

  const sourceRoot = path.join(temporary, "text-source"); fs.mkdirSync(sourceRoot); fs.writeFileSync(path.join(sourceRoot, "synthetic.txt"), text);
  await writer.stop();
  await writer.start();
  await writer.write("uploadBook", [{ fileName: "retained-python.txt", text }], { operationId: "retained-for-python", sourceRealm: replacementRealm });
  await writer.stop();
  const python = spawnSync("python", [path.resolve("tools/rescan_novel_library.py"), "--db", dbPath, "--root", sourceRoot], { encoding: "utf8", windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  assert.ifError(python.error); assert.equal(python.status, 0, python.stderr);
  assert.equal(reader.writeIdentity(), replacementRealm);
  const receiptDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(receiptDb.prepare("SELECT value FROM novel_meta WHERE key='schema_version'").get().value, "5");
    assert.equal(receiptDb.prepare("SELECT COUNT(*) AS count FROM novel_write_receipts").get().count, 1, "Python scanning preserves explicit receipts, while confirmed private receipts are released");
  } finally { receiptDb.close(); }
  await writer.start();
  await writer.updateBookMetadata(replacementResult.book.id, { title: "扫描后写入" });
  assert.equal(reader.bookMeta(replacementResult.book.id).book.title, "扫描后写入");
  await verifyImportDrain();
  await writer.stop(); faultNext = "startup-exit";
  await assert.rejects(writer.start(), (error) => error.workerUnavailable);
  await writer.start(); await writer.stop();
  await verifyUnconfirmedShutdown();
  await verifyCleanupNoCreate();
  await verifyRestoredBackup();
  await verifyOverlappingLifecycle();
  await verifyDefaultCapacity();
  await verifyRuntimeWiring(replacementResult.book.id);
  await delay(5); assert.deepEqual(unhandled, []);
  console.log(`novel-write-worker: ok (six writes, lock/health gate, route contracts, atomic receipts, exit/lost reply, bounded queue, stop, replacement, Python v5, starts=${starts})`);
} finally {
  if (blocker) { try { blocker.exec("ROLLBACK"); } catch {} blocker.close(); }
  await writer.stop(); reader.invalidate();
  process.off("unhandledRejection", onUnhandled);
  removeOwnedDirectory(temporary);
}

function receiptRows() {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try { return database.prepare("SELECT operation_id, retain_receipt, length(response_json) AS bytes FROM novel_write_receipts ORDER BY operation_id").all(); }
  finally { database.close(); }
}
function route(method, routePath, body = {}, res = { status: 0, data: null }) {
  const reimportService = createNovelReimportService({ collectionService: {}, dbPath, novelStore, projectRoot: process.cwd() });
  return routeNovelApi({ method }, res, new URL(`http://fixture${routePath}`), {
    novelStore, reimportService, collectionService: {}, readJsonBody: async () => body,
    notFound: (response) => { response.status = 404; },
    sendJson: (response, status, data) => { response.status = status; response.data = data; }
  }).then(() => res);
}
async function verifyCleanupNoCreate() {
  for (const fault of ["", "exit-after-commit"]) {
    const cleanupPath = path.join(temporary, `cleanup-${fault || "normal"}.sqlite`);
    const movedPath = `${cleanupPath}.moved`;
    const readStore = createNovelStore({ dbPath: cleanupPath });
    const acknowledgements = [];
    let faultRemaining = fault;
    const client = createNovelWriteWorkerClient({
      dbPath: cleanupPath, readyTimeoutMs: 2000, requestTimeoutMs: 800,
      workerFactory(_url, options) {
        const fixtureFault = options.workerData.recovery || options.workerData.cleanupOnly ? "" : faultRemaining;
        if (!options.workerData.recovery && !options.workerData.cleanupOnly) faultRemaining = "";
        const worker = new Worker(new URL("./fixtures/novel-write-worker-fault.mjs", import.meta.url), { ...options, execArgv: [], workerData: { ...options.workerData, fixtureFault } });
        worker.on("message", (message) => { if (message.type === "result" && (!message.ok || Array.isArray(message.data))) acknowledgements.push(message); });
        return worker;
      }
    });
    try {
      await client.uploadBook({ fileName: "cleanup.txt", text });
      assert.equal(client.diagnostics().acknowledgedReceipts, 1);
      readStore.invalidate(); fs.renameSync(cleanupPath, movedPath);
      await client.stop();
      assert.equal(fs.existsSync(cleanupPath), false, "ack-only stop must not recreate a moved database, including a fresh cleanup Worker after reply recovery");
      assert.equal(client.diagnostics().acknowledgedReceipts, 1, "missing DB cleanup leaves its confirmation token pending");
      fs.renameSync(movedPath, cleanupPath);
      await client.start(); await client.stop();
      assert.equal(client.diagnostics().acknowledgedReceipts, 0, `restoring the original file allows a later confirmed cleanup: ${JSON.stringify(acknowledgements)}`);
      const database = new DatabaseSync(cleanupPath, { readOnly: true });
      try { assert.equal(database.prepare("SELECT COUNT(*) AS count FROM novel_write_receipts").get().count, 0); }
      finally { database.close(); }
    } finally { await client.stop(); readStore.invalidate(); }
  }
}
async function verifyRestoredBackup() {
  for (const mode of ["replacement", "overwrite"]) await verifyRestoredBackupMode(mode);
}
async function verifyRestoredBackupMode(mode) {
  const restoredPath = path.join(temporary, `restore-${mode}.sqlite`);
  const backupPath = `${restoredPath}.backup`;
  const committedPath = `${restoredPath}.committed`;
  const readStore = createNovelStore({ dbPath: restoredPath });
  const seed = readStore.uploadBook({ fileName: "seed.txt", text });
  readStore.invalidate(); fs.copyFileSync(restoredPath, backupPath);
  let writes = 0;
  const client = createNovelWriteWorkerClient({
    dbPath: restoredPath, readyTimeoutMs: 2000, requestTimeoutMs: 800,
    workerFactory(_url, options) {
      if (options.workerData.recovery) {
        // The original writer has exited. Restore an older same-realm file
        // without accidentally attaching the committed file's WAL to it.
        const before = fs.statSync(restoredPath, { bigint: true });
        if (mode === "replacement") fs.renameSync(restoredPath, committedPath);
        else fs.copyFileSync(restoredPath, committedPath);
        for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(`${restoredPath}${suffix}`)) fs.renameSync(`${restoredPath}${suffix}`, `${committedPath}${suffix}`);
        if (mode === "replacement") fs.copyFileSync(backupPath, restoredPath);
        else {
          fs.writeFileSync(restoredPath, fs.readFileSync(backupPath));
          assert.equal(fs.statSync(restoredPath, { bigint: true }).ino, before.ino, "the overwrite scenario must retain the original inode");
        }
      } else if (!options.workerData.cleanupOnly) writes += 1;
      return new Worker(new URL("./fixtures/novel-write-worker-fault.mjs", import.meta.url), { ...options, execArgv: [], workerData: { ...options.workerData, fixtureFault: options.workerData.recovery || options.workerData.cleanupOnly ? "" : "exit-after-commit" } });
    }
  });
  let failure;
  const body = { fileName: "committed-before-restore.txt", text };
  try {
    await assert.rejects(client.uploadBook(body), (error) => { failure = error; return error.code === "NOVEL_WRITE_OUTCOME_UNKNOWN" && Boolean(error.operationId); });
    assert.equal(writes, 1, "same-realm restore must not replay the dispatched business operation");
    assert.equal(readStore.writeIdentity(), seed.sourceRealm);
    assert.equal(readStore.summary().totals.books, 1, "the restored backup must stay unchanged during recovery");
    const original = createNovelStore({ dbPath: committedPath });
    try {
      assert.equal(original.summary().totals.books, 2);
      const receipt = original.readWriteReceipt({ operationId: failure.operationId, sourceRealm: seed.sourceRealm, requestHash: novelWriteOperationHash("uploadBook", [body]) });
      assert.equal(receipt.status, "committed", "an actual matching receipt still proves success after a physical move");
      assert.equal(receipt.result.book.title, "committed-before-restore");
    } finally { original.invalidate(); }
  } finally { await client.stop(); readStore.invalidate(); }
}
async function verifyOverlappingLifecycle() {
  const terminating = deferred();
  const entered = deferred();
  const workers = [];
  const client = createNovelWriteWorkerClient({
    dbPath, readyTimeoutMs: 1000,
    workerFactory() {
      const worker = new EventEmitter(); workers.push(worker);
      worker.postMessage = () => assert.fail("this lifecycle scenario has no business requests");
      worker.terminate = async () => { entered.resolve(); await terminating.promise; worker.emit("exit", 0); return 0; };
      queueMicrotask(() => worker.emit("message", { type: "ready", sourceRealm: "server:fixture" }));
      return worker;
    }
  });
  try {
    await client.start();
    const stopping = client.stop(); await entered.promise;
    const restarting = client.start();
    await client.beginStop();
    terminating.resolve(); await stopping;
    await assert.rejects(restarting, (error) => error.code === "NOVEL_WRITE_STOPPED");
    assert.equal(client.diagnostics().accepting, false, "a waiting start must not override a newer stop intent");
    assert.equal(workers.length, 1);
  } finally { terminating.resolve(); await client.stop(); }
}
async function verifyDefaultCapacity() {
  const mib = 1024 * 1024;
  // The former 80 MiB HTTP envelope and 50 MiB text kernel accept this shape:
  // author is normalized to 80 chars by the kernel. The 140 MiB UTF-16 queue
  // estimate must still dispatch. This fake checks admission, not huge parsing.
  const body = { fileName: "capacity.txt", text: "a".repeat(40 * mib), author: "b".repeat(30 * mib) };
  assert.ok(Buffer.byteLength(body.text) + Buffer.byteLength(body.author) + 100 < 80 * mib);
  const expected = { book: { id: "synthetic-capacity" } };
  let dispatched = false;
  const client = createNovelWriteWorkerClient({
    dbPath, readyTimeoutMs: 1000,
    workerFactory() {
      const worker = new EventEmitter();
      worker.postMessage = (message) => {
        if (message.type === "write") {
          dispatched = true;
          assert.equal(message.operation.args[0].text.length, 40 * mib);
          queueMicrotask(() => worker.emit("message", { type: "result", operationId: message.operation.operationId, ok: true,
            data: { result: expected, sourceRealm: "server:fixture", databaseIdentity: "fixture", requestHash: "fixture", acknowledgedReceipts: [] } }));
        } else queueMicrotask(() => worker.emit("message", { type: "result", operationId: message.operation.operationId, ok: true, data: message.operation.acknowledgedReceipts }));
      };
      worker.terminate = async () => { worker.emit("exit", 0); return 0; };
      queueMicrotask(() => worker.emit("message", { type: "ready", sourceRealm: "server:fixture" }));
      return worker;
    }
  });
  try { assert.deepEqual(await client.uploadBook(body), expected); assert.equal(dispatched, true); }
  finally { await client.stop(); }
}
async function verifyUnconfirmedShutdown() {
  for (const mode of ["reject", "hang"]) await verifyUnconfirmedShutdownMode(mode);
}
async function verifyUnconfirmedShutdownMode(mode) {
  const workers = [];
  const unstable = createNovelWriteWorkerClient({
    dbPath, readyTimeoutMs: 100, requestTimeoutMs: 10,
    workerFactory() {
      const worker = new EventEmitter();
      worker.alive = true;
      worker.messages = [];
      worker.postMessage = (message) => worker.messages.push(message);
      worker.terminate = () => {
        if (workers.length === 1) return mode === "hang" ? new Promise(() => {}) : Promise.reject(new Error("controlled terminate failure"));
        worker.alive = false;
        queueMicrotask(() => worker.emit("exit", 0));
        return Promise.resolve(0);
      };
      workers.push(worker);
      queueMicrotask(() => worker.emit("message", { type: "ready", sourceRealm: "server:fixture" }));
      return worker;
    }
  });
  try {
    const res = { status: 0, data: null };
    const routed = routeNovelApi({ method: "POST" }, res, new URL("http://fixture/api/novels/book/progress"), {
      novelStore: { saveProgress: unstable.saveProgress }, readJsonBody: async () => ({}),
      notFound: () => assert.fail("unknown is not not-found"),
      sendJson: (target, status, data) => { target.status = status; target.data = data; }
    });
    await waitFor(() => unstable.diagnostics().unconfirmedClose);
    await assert.rejects(unstable.start(), /尚未确认退出/);
    assert.equal(workers.length, 1, "start must reject while a termination is pending, before its timeout or rejection");
    await routed;
    assert.equal(res.status, 503); assert.equal(res.data.outcome, "unknown"); assert.ok(res.data.operationId);
    assert.equal(workers.length, 1, "an unconfirmed termination must not launch a recovery reader");
    assert.equal(workers[0].messages.filter((message) => message.type === "write").length, 1, "unknown outcomes must never trigger automatic business replay");
    await assert.rejects(unstable.start(), /尚未确认退出/);
    await assert.rejects(unstable.stop(), mode === "hang" ? /尚未确认退出/ : /controlled terminate failure/);
    assert.equal(workers[0].alive, true);
    assert.equal(unstable.diagnostics().connections, 1, "the lifecycle must retain an owner for a writer whose exit is unconfirmed");
    workers[0].alive = false; workers[0].emit("exit", 0);
    await unstable.start(); await unstable.stop();
    assert.equal(unstable.diagnostics().connections, 0);
  } finally {
    for (const worker of workers) if (worker.alive) { worker.alive = false; worker.emit("exit", 0); }
    try { await unstable.stop(); } catch {}
  }
}
async function verifyImportDrain() {
  const entered = deferred();
  const release = deferred();
  const collection = createNovelCollectionService({
    dbPath: path.join(temporary, "drain-collection.sqlite"), outputRoot: path.join(temporary, "drain-output"), projectRoot: process.cwd(),
    probeProcess: () => ({ status: 0, stdout: "ok" }),
    novelStore: { importCollectedBook: async (body) => { entered.resolve(); await release.promise; return writer.importCollectedBook(body); } },
    spawnProcess(_command, args) {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => false;
      const resultPath = args[args.indexOf("--result") + 1];
      queueMicrotask(() => {
        fs.writeFileSync(resultPath, JSON.stringify({ status: "ok", book: { sourceUrl: "https://fixture.invalid/drain-book", title: "停机导入", chapters: [{ title: "章节", content: "停机前已开始导入的合成正文" }] } }));
        child.stdout.end(); child.stderr.end(); child.emit("close", 0);
      });
      return child;
    }
  });
  let stopped = false;
  let stopping;
  try {
    const adapter = collection.createAdapter({ name: "私有假采集器", matchHosts: ["fixture.invalid"], contentSelector: ".body" }).adapter;
    const task = collection.createTask({ url: "https://fixture.invalid/drain-book", adapterId: adapter.id, mode: "collect" }).task;
    await collection.start(); await entered.promise;
    stopping = collection.stop().then(() => { stopped = true; });
    await delay(3100);
    assert.equal(stopped, false, "collector stop must drain an import even after the child has closed and the former three-second timeout expires");
    release.resolve(); await stopping;
    assert.equal(collection.taskDetail(task.id).status, "succeeded");
  } finally { release.resolve(); await stopping; await collection.stop(); }
}
async function verifyRuntimeWiring(bookId) {
  let body = { title: "真实runtime Worker接线" };
  const runtime = createNovelsRuntime({
    dbPath, projectRoot: process.cwd(), readJsonBody: async () => body,
    notFound: (res) => { res.status = 404; }, sendJson: (res, status, data) => { res.status = status; res.data = data; },
    // This fixture isolates the six book-write operations; collection RPC has
    // its own controlled-child runtime fixture, never a production fallback.
    collectionServiceFactory: createNovelCollectionService,
    collectionServiceOptions: { probeProcess: () => ({ status: 0, stdout: "ok" }) }
  });
  try {
    await runtime.start();
    const res = {};
    await runtime.routeApi({ method: "PATCH" }, res, new URL(`http://fixture/api/novels/${bookId}`));
    assert.equal(res.status, 200); assert.equal(res.data.book.title, body.title);
    await runtime.beginStop();
    body = { title: "停机后不会写入" };
    const stopped = {};
    await runtime.routeApi({ method: "PATCH" }, stopped, new URL(`http://fixture/api/novels/${bookId}`));
    assert.equal(stopped.status, 503);
  } finally { await runtime.stop(); }
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function modern(detail, scrollRatio = 0.2) {
  return { sourceRealm: detail.sourceRealm, catalogRevision: detail.catalogRevision, chapterId: detail.book.firstChapterId, chapterIndex: 1, scrollRatio };
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(predicate) {
  for (let attempts = 0; !predicate(); attempts += 1) { assert.ok(attempts < 100, "fixture did not reach expected worker phase"); await delay(5); }
}
function removeOwnedDirectory(directory) {
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(resolved).startsWith("fanhao-novel-writes-"));
  const cleanup = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
    $fixtureRoot = [IO.Path]::GetFullPath($env:FANHAO_NOVEL_FIXTURE_CLEANUP)
    $resolvedRoot = (Resolve-Path -LiteralPath $fixtureRoot).Path
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ($resolvedRoot -ne $fixtureRoot -or [IO.Path]::GetDirectoryName($resolvedRoot) -ne $temporaryRoot -or -not [IO.Path]::GetFileName($resolvedRoot).StartsWith('fanhao-novel-writes-')) { throw 'Unexpected fixture cleanup path' }
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
  `], { encoding: "utf8", windowsHide: true, env: { ...process.env, FANHAO_NOVEL_FIXTURE_CLEANUP: resolved } });
  assert.ifError(cleanup.error); assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.equal(fs.existsSync(resolved), false);
}
