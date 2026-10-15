import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createNovelStore } from "../src/modules/novels/server/store.js";
import { createNovelWriteWorkerClient } from "../src/modules/novels/server/write-worker-client.js";
import { createNovelReimportService } from "../src/modules/novels/server/reimport-service.js";
import { createNovelsRuntime } from "../src/modules/novels/server/runtime.js";
import { routeNovelApi } from "../src/modules/novels/server/routes.js";
import { loadLocalReimportArtifact, sourceIdentity } from "../src/modules/novels/server/local-reimport-artifact.js";

// Actual Python exports and temporary SQLite, plus controlled child/Worker
// boundaries. Never opens a user library or starts either application service.
const projectRoot = path.resolve(import.meta.dirname, "..");
const scanner = path.join(projectRoot, "tools/rescan_novel_library.py");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-reimport-fixture-"));
const artifactRoots = new Set(), stores = new Set(), writers = new Set(), services = new Set();
const unhandled = [];
const onUnhandled = (error) => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
let sequence = 0, checks = 0;
const originalText = "第一章 开始\n\n合成正文甲。\n\n第二章 保留\n\n合成正文乙。";
const nextText = "第一章 开始\n\n合成正文甲。\n\n第二章 保留\n\n合成正文乙。\n\n第三章 新增\n\n新增合成正文😀。\n[本章完]\n下一页";
try {
  await verifyPythonParity();
  await verifyWorkerGuards();
  await verifyDirectKernelGuard();
  await verifyRealService();
  await verifyChildLifecycle();
  await verifyRuntimeDrain();
  await delay(5); assert.deepEqual(unhandled, []);
  console.log(`novel-reimport-async: ok (${checks} scenarios; real Python encoding/export/write_record parity, seventh writer receipt/guards, child ownership, stop/disconnect)`);
} finally {
  for (const service of services) { try { await service.stop(); } catch {} }
  for (const writer of writers) await writer.stop();
  for (const store of stores) store.invalidate();
  process.off("unhandledRejection", onUnhandled);
  for (const root of artifactRoots) if (fs.existsSync(root)) {
    assertOwnedArtifactRoot(root);
    for (const file of fs.readdirSync(root)) { assert.match(file, /^[0-9a-f-]{36}\.json$/); fs.unlinkSync(path.join(root, file)); }
    fs.rmdirSync(root);
  }
  removeOwnedDirectory(temporary);
}

async function verifyPythonParity() {
  for (const encoding of ["utf-8-sig", "gb18030", "big5"]) {
    const item = library({ encoding, folderAuthor: true });
    const before = item.reader.bookDetail(item.id);
    assert.equal(before.chapters.length, 2, `${encoding}: ${JSON.stringify(before)}`);
    assert.equal(before.book.title, "合成书籍"); assert.equal(before.book.author, "文件夹作者"); assert.equal(before.book.category, "小说");
    item.reader.saveProgress(item.id, modern(before, 2, 0.42));
    item.reader.updateBookMetadata(item.id, { title: "人工校正标题", author: "", category: "校正分类", summary: "保留简介" });
    item.reader.invalidate();
    const parityDb = path.join(temporary, `parity-${++sequence}.sqlite`);
    fs.copyFileSync(item.dbPath, parityDb);
    encodeFile(item.file, encodingText(nextText, encoding), encoding);
    const descriptor = exported(item);
    assert.equal(fs.existsSync(path.join(temporary, "must-not-create.sqlite")), false, "export-only must never open its --db argument");
    const record = loadLocalReimportArtifact(descriptor, descriptor.artifactRoot);
    assert.ok(record.encoding); assert.ok(record.chapters.some(chapter => chapter.content.includes("😀") || encoding === "big5"));
    python(["-c", "import json,sys; from pathlib import Path; import rescan_novel_library as scanner; value=json.load(open(sys.argv[2],encoding='utf-8'))['bookRecord']; value['chapters']=[scanner.Chapter(**row) for row in value['chapters']]; scanner.write_record(Path(sys.argv[1]),scanner.BookRecord(**value))", parityDb, descriptor.artifactPath]);
    const writer = writerFor(item, descriptor.artifactRoot);
    const imported = await writer.write("reimportLocalBook", [item.id, descriptor], { operationId: `parity-${encoding}` });
    const nodeState = sql(item.dbPath, db => ({ book: db.prepare("SELECT * FROM novel_books WHERE id=?").get(item.id), chapters: db.prepare("SELECT * FROM novel_chapters WHERE book_id=? ORDER BY chapter_index").all(item.id), progress: db.prepare("SELECT * FROM novel_reading_state WHERE book_id=?").get(item.id) }));
    const pythonState = sql(parityDb, db => ({ book: db.prepare("SELECT * FROM novel_books WHERE id=?").get(item.id), chapters: db.prepare("SELECT * FROM novel_chapters WHERE book_id=? ORDER BY chapter_index").all(item.id), progress: db.prepare("SELECT * FROM novel_reading_state WHERE book_id=?").get(item.id) }));
    const { catalog_revision: nodeRevision, ...nodeBook } = nodeState.book;
    const { catalog_revision: pythonRevision, ...pythonBook } = pythonState.book;
    // New chapter UUIDs are intentionally independent; the retained identity
    // and exact metadata/body/code-point counts must agree across coordinators.
    delete nodeBook.latest_chapter_id; delete pythonBook.latest_chapter_id;
    assert.deepEqual(nodeBook, pythonBook, `${encoding}: parser metadata and overrides must match write_record`);
    assert.deepEqual(nodeState.chapters.map(({ id, ...row }) => row), pythonState.chapters.map(({ id, ...row }) => row));
    assert.equal(nodeState.chapters[1].id, before.chapters[1].id); assert.equal(pythonState.chapters[1].id, before.chapters[1].id);
    assert.equal(imported.book.progress.chapterId, before.chapters[1].id); assert.equal(imported.book.progress.scrollRatio, 0.42);
    assert.equal(nodeState.progress.catalog_revision, nodeRevision); assert.equal(pythonState.progress.catalog_revision, pythonRevision);
    assert.deepEqual({ ...nodeState.progress, catalog_revision: "revision" }, { ...pythonState.progress, catalog_revision: "revision" });
    await writer.stop(); checks += 1;
  }
}

async function verifyDirectKernelGuard() {
  for (const mutation of ["realm", "delete"]) {
    const item = library(); const descriptor = exported(item);
    const exec = DatabaseSync.prototype.exec; let armed = true, changed = false;
    DatabaseSync.prototype.exec = function (statement, ...args) {
      if (armed && statement === "BEGIN IMMEDIATE") {
        armed = false; changed = true;
        if (mutation === "realm") sql(item.dbPath, db => db.prepare("UPDATE novel_meta SET value=? WHERE key='library_id'").run(crypto.randomUUID()));
        else {
          const concurrent = createNovelStore({ dbPath: item.dbPath });
          try { concurrent.deleteBook(item.id); } finally { concurrent.invalidate(); }
        }
      }
      return exec.call(this, statement, ...args);
    };
    try { assert.throws(() => item.reader.reimportLocalBook(item.id, descriptor), error => error.statusCode === 409); }
    finally { DatabaseSync.prototype.exec = exec; }
    assert.equal(changed, true, "the independent mutation must win before the kernel takes its writer lock");
    if (mutation === "delete") {
      assert.equal(item.reader.bookMeta(item.id), null);
      assert.equal(sql(item.dbPath, db => db.prepare("SELECT COUNT(*) AS n FROM novel_chapters WHERE book_id=?").get(item.id).n), 0);
      assert.equal(sql(item.dbPath, db => db.prepare("SELECT COUNT(*) AS n FROM novel_book_deletions WHERE book_id=?").get(item.id).n), 1);
    } else assert.equal(item.reader.bookMeta(item.id).catalogRevision, descriptor.catalogRevision);
    checks += 1;
  }
}

async function verifyWorkerGuards() {
  const item = library();
  let faultNext = "";
  const artifactRoot = newArtifactRoot();
  const writer = writerFor(item, artifactRoot, { requestTimeoutMs: 100,
    workerFactory(_url, options) { const fixtureFault = options.workerData.recovery ? "" : faultNext; if (!options.workerData.recovery) faultNext = ""; return new Worker(new URL("./fixtures/novel-write-worker-fault.mjs", import.meta.url), { ...options, execArgv: [], workerData: { ...options.workerData, fixtureFault } }); }
  });
  for (const fault of ["exit-after-commit", "drop-reply", "error-after-commit"]) {
    await writer.stop(); faultNext = fault; await writer.start();
    const descriptor = exported(item, artifactRoot);
    const operationId = `reimport-${fault}`;
    const changed = await writer.write("reimportLocalBook", [item.id, descriptor], { operationId });
    assert.notEqual(changed.catalogRevision, descriptor.catalogRevision);
    fs.unlinkSync(descriptor.artifactPath);
    assert.deepEqual(await writer.write("reimportLocalBook", [item.id, descriptor], { operationId }), changed, "a retained receipt must replay after the export has been cleaned");
    assert.equal(item.reader.bookMeta(item.id).catalogRevision, changed.catalogRevision, "lost replies never repeat a catalog replacement");
    checks += 1;
  }
  await writer.stop(); await writer.start();
  const beforeTamper = item.reader.bookMeta(item.id).catalogRevision;
  const tampered = exported(item, artifactRoot); fs.appendFileSync(tampered.artifactPath, " ");
  await assert.rejects(writer.reimportLocalBook(item.id, tampered), error => error.statusCode === 409 && error.outcome === "not_committed");
  const invalidUtf8 = exported(item, artifactRoot);
  const bytes = fs.readFileSync(invalidUtf8.artifactPath); const content = bytes.indexOf(Buffer.from("合成")); assert.ok(content > 0); bytes[content] = 0xff; fs.writeFileSync(invalidUtf8.artifactPath, bytes);
  invalidUtf8.artifactHash = crypto.createHash("sha256").update(bytes).digest("hex");
  await assert.rejects(writer.reimportLocalBook(item.id, invalidUtf8), error => error.statusCode === 409);
  assert.equal(item.reader.bookMeta(item.id).catalogRevision, beforeTamper);
  checks += 1;
  const staleRevision = exported(item, artifactRoot); await writer.reimportBook(item.id, { text: originalText });
  await assert.rejects(writer.reimportLocalBook(item.id, staleRevision), error => error.statusCode === 409);
  const changedFile = exported(item, artifactRoot); fs.appendFileSync(item.file, "\n文件随后变化");
  await assert.rejects(writer.reimportLocalBook(item.id, changedFile), error => error.statusCode === 409);
  const changedIdentity = exported(item, artifactRoot); const replacementFile = item.file + ".replacement"; fs.copyFileSync(item.file, replacementFile);
  const originalStat = fs.statSync(item.file); fs.utimesSync(replacementFile, originalStat.atime, originalStat.mtime); fs.unlinkSync(item.file); fs.renameSync(replacementFile, item.file);
  await assert.rejects(writer.reimportLocalBook(item.id, changedIdentity), error => error.statusCode === 409);
  const changedPath = exported(item, artifactRoot); sql(item.dbPath, db => db.prepare("UPDATE novel_books SET source_path=? WHERE id=?").run(item.file + ".other", item.id));
  await assert.rejects(writer.reimportLocalBook(item.id, changedPath), error => error.statusCode === 409);
  sql(item.dbPath, db => db.prepare("UPDATE novel_books SET source_path=? WHERE id=?").run(item.file, item.id));
  const deleted = exported(item, artifactRoot); await writer.deleteBook(item.id);
  await assert.rejects(writer.reimportLocalBook(item.id, deleted), error => error.statusCode === 409);
  assert.equal(item.reader.bookMeta(item.id), null); assert.equal(sql(item.dbPath, db => db.prepare("SELECT COUNT(*) AS n FROM novel_chapters WHERE book_id=?").get(item.id).n), 0);
  assert.equal(sql(item.dbPath, db => db.prepare("SELECT COUNT(*) AS n FROM novel_book_deletions WHERE book_id=?").get(item.id).n), 1, "HTTP local reimport must not erase a concurrent delete tombstone");
  checks += 1;
  await writer.stop();
  const realmItem = library(); const realmRoot = newArtifactRoot(); const realmWriter = writerFor(realmItem, realmRoot);
  await realmWriter.start(); const oldDescriptor = exported(realmItem, realmRoot);
  realmItem.reader.invalidate(); fs.renameSync(realmItem.dbPath, realmItem.dbPath + ".old");
  const fresh = createNovelStore({ dbPath: realmItem.dbPath }); stores.add(fresh); fresh.writeIdentity(); fresh.invalidate();
  await assert.rejects(realmWriter.reimportLocalBook(realmItem.id, oldDescriptor), error => error.statusCode === 409);
  assert.equal(fresh.summary().totals.books, 0); await realmWriter.stop(); checks += 1;
}

async function verifyRealService() {
  const item = library(), artifactRoot = newArtifactRoot();
  const writer = writerFor(item, artifactRoot); await writer.start();
  const novelStore = { ...item.reader, reimportBook: writer.reimportBook, reimportLocalBook: writer.reimportLocalBook };
  let spawnArguments;
  const service = serviceFor(item, { artifactRoot, novelStore, spawnProcess(executable, args, options) {
    spawnArguments = { args, options }; return spawn(executable, args, options);
  } });
  const completed = await service.reimport(item.id);
  assert.equal(completed.kind, "book"); assert.equal(completed.book.id, item.id);
  assert.ok(spawnArguments.args.includes("--export-only")); assert.ok(!spawnArguments.args.includes("--db")); assert.equal(spawnArguments.options.env.PYTHONIOENCODING, "utf-8");
  assert.equal(service.diagnostics().children, 0); assert.equal(fs.existsSync(artifactRoot), false);
  const tooLarge = serviceFor(item, { novelStore, maxArtifactBytes: 128 });
  const before = item.reader.bookMeta(item.id).catalogRevision;
  await assert.rejects(tooLarge.reimport(item.id), error => error.statusCode === 413);
  assert.equal(item.reader.bookMeta(item.id).catalogRevision, before); assert.equal(fs.existsSync(tooLarge.diagnostics().artifactRoot), false);
  await tooLarge.stop(); checks += 1;

  // SQLite's wait occurs only inside the shared writer. Stop must keep it
  // available until the already dispatched local replacement is confirmed.
  const lock = new DatabaseSync(item.dbPath); lock.exec("BEGIN IMMEDIATE");
  const controller = new AbortController(); let settled = false;
  const waiting = service.reimport(item.id, {}, { signal: controller.signal }).then(result => { settled = true; return result; });
  try {
    await waitFor(() => writer.diagnostics().dispatched); controller.abort();
    let stopped = false; const stopping = service.stop().then(() => { stopped = true; });
    await delay(20); assert.equal(settled, false); assert.equal(stopped, false, "dispatched writes survive consumer cancellation and drain before stop");
    assert.equal(item.reader.bookMeta(item.id).catalogRevision, before, "WAL reads remain available during the asynchronous locked write");
    lock.exec("ROLLBACK"); lock.close();
    await Promise.all([waiting, stopping]);
    assert.notEqual(item.reader.bookMeta(item.id).catalogRevision, before); assert.equal(fs.existsSync(artifactRoot), false);
  } catch (error) { try { lock.exec("ROLLBACK"); lock.close(); } catch {} throw error; }
  checks += 1;
  await writer.stop();
}

async function verifyChildLifecycle() {
  const item = library({ second: true });
  for (const event of ["overflow", "error", "pipe-error", "timeout", "abort", "stop"]) {
    let child, written = 0;
    const service = serviceFor(item, { processTimeoutMs: event === "timeout" ? 15 : 1000, closeTimeoutMs: 100,
      novelStore: { ...item.reader, reimportLocalBook() { written += 1; throw new Error("must not import failed parser"); } },
      spawnProcess() { return child = controlledChild(); }
    });
    const controller = new AbortController(); let settled = false;
    const pending = service.reimport(item.id, {}, { signal: controller.signal }).then(() => { settled = true; }, error => { settled = true; return error; });
    await waitFor(() => Boolean(child));
    if (event === "overflow") child.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1));
    if (event === "error") child.emit("error", new Error("controlled spawn error"));
    if (event === "pipe-error") child.stderr.emit("error", new Error("controlled pipe failure"));
    if (event === "abort") controller.abort();
    let stopping;
    if (event === "stop") stopping = service.stop();
    await waitFor(() => child.kills > 0); await delay(5);
    assert.equal(settled, false, `${event}: error/overflow/cancel must wait for actual child close`);
    assert.equal(service.diagnostics().children, 1); assert.equal(written, 0);
    child.close(9); const error = await pending; assert.ok(error instanceof Error); assert.equal(error.outcome, "not_committed");
    await (stopping || service.stop()); assert.equal(service.diagnostics().children, 0); assert.equal(fs.existsSync(service.diagnostics().artifactRoot), false);
    checks += 1;
  }
  let child, spawned = 0;
  const held = serviceFor(item, { closeTimeoutMs: 20, maxPending: 2, spawnProcess() { spawned += 1; return child = controlledChild(); } });
  const first = held.reimport(item.id).catch(error => error);
  await waitFor(() => Boolean(child));
  await assert.rejects(held.reimport(item.id), error => error.code === "NOVEL_REIMPORT_BUSY");
  const next = held.reimport(item.secondId).catch(error => error);
  await assert.rejects(held.reimport(item.thirdId), error => error.code === "NOVEL_REIMPORT_QUEUE_FULL");
  child.emit("error", new Error("held close"));
  assert.equal((await first).code, "NOVEL_REIMPORT_CHILD_UNCONFIRMED"); assert.equal((await next).code, "NOVEL_REIMPORT_STOPPED");
  assert.equal(spawned, 1, "a closing child without exit proof must block queued parser spawn");
  await assert.rejects(held.start(), error => error.code === "NOVEL_REIMPORT_CHILD_UNCONFIRMED");
  await assert.rejects(held.stop(), error => error.code === "NOVEL_REIMPORT_CHILD_UNCONFIRMED");
  assert.equal(held.diagnostics().children, 1);
  child.close(9); await held.start(); await held.stop(); checks += 1;

  let cancelledChild, cancelSpawns = 0;
  const cancelledQueue = serviceFor(item, { spawnProcess() { cancelSpawns += 1; return cancelledChild = controlledChild(); } });
  const current = cancelledQueue.reimport(item.id).catch(error => error);
  await waitFor(() => Boolean(cancelledChild));
  const queuedController = new AbortController();
  const queued = cancelledQueue.reimport(item.secondId, {}, { signal: queuedController.signal }).catch(error => error);
  queuedController.abort(); assert.equal((await queued).code, "NOVEL_REIMPORT_CANCELLED"); assert.equal(cancelSpawns, 1);
  const stopping = cancelledQueue.stop();
  const restarting = cancelledQueue.start().catch(error => error);
  cancelledQueue.beginStop(); cancelledChild.close(9);
  await Promise.all([current, stopping]);
  assert.equal((await restarting).code, "NOVEL_REIMPORT_STOPPED", "a waiting start cannot override a newer stop intent");
  assert.equal(cancelledQueue.diagnostics().accepting, false); checks += 1;

  let routeChild;
  const disconnect = serviceFor(item, { spawnProcess() { return routeChild = controlledChild(); } });
  const request = Object.assign(new EventEmitter(), { method: "POST" });
  const response = Object.assign(new EventEmitter(), { status: 0, destroyed: false, writableEnded: false });
  const route = routeNovelApi(request, response, new URL(`http://fixture/api/novels/${item.id}/reimport`), {
    novelStore: item.reader, reimportService: disconnect, collectionService: {}, requireLocalAdmin: () => true,
    readJsonBody: async () => ({}), notFound: () => assert.fail("existing book"), sendJson(res, status, data) { res.status = status; res.data = data; }
  });
  await waitFor(() => Boolean(routeChild)); response.destroyed = true; response.emit("close");
  await waitFor(() => routeChild.kills > 0); assert.equal(disconnect.diagnostics().children, 1);
  routeChild.close(9); await route; assert.equal(response.status, 0, "disconnected consumers receive no stale reimport error");
  assert.equal(request.listenerCount("aborted"), 0); assert.equal(response.listenerCount("close"), 0); await disconnect.stop(); checks += 1;
}

async function verifyRuntimeDrain() {
  const item = library();
  const marker = path.join(temporary, `child-ready-${++sequence}`);
  let actualChild, exitSeen = false;
  const runtime = createNovelsRuntime({ dbPath: item.dbPath, projectRoot, readJsonBody: async () => ({}),
    sendJson(res, status, data) { res.status = status; res.data = data; }, notFound: () => assert.fail("existing book"),
    writeWorkerOptions: { readyTimeoutMs: 2000 },
    collectionServiceFactory: () => ({ start: async () => {}, beginStop() {}, stop: async () => {}, createTask: async () => ({ task: {} }) }),
    reimportServiceOptions: { closeTimeoutMs: 2000, spawnProcess() {
      actualChild = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1],'ready');setInterval(()=>{},1000)", marker], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      actualChild.once("close", () => { exitSeen = true; }); return actualChild;
    } }
  });
  try {
    await runtime.start();
    const response = { status: 0 };
    const pending = runtime.routeApi({ method: "POST" }, response, new URL(`http://fixture/api/novels/${item.id}/reimport`));
    await waitFor(() => fs.existsSync(marker));
    await runtime.stop(); await pending;
    assert.equal(exitSeen, true, "runtime shutdown must retain and await a real local parser child");
    assert.equal(response.status, 503); assert.equal(runtime.reimportService.diagnostics().children, 0);
    assert.equal(runtime.writeService.diagnostics().connections, 0); assert.equal(fs.existsSync(runtime.reimportService.diagnostics().artifactRoot), false);
    assert.equal(item.reader.bookMeta(item.id).catalogRevision, item.initial.catalogRevision);
    checks += 1;
  } finally { await runtime.stop(); }
}

function library({ encoding = "utf-8", folderAuthor = false, second = false } = {}) {
  const base = path.join(temporary, `library-${++sequence}`); fs.mkdirSync(base);
  const sourceRoot = path.join(base, folderAuthor ? "小说" : "合成目录"); fs.mkdirSync(sourceRoot);
  const folder = folderAuthor ? path.join(sourceRoot, "文件夹作者") : sourceRoot; if (folderAuthor) fs.mkdirSync(folder);
  const file = path.join(folder, "《合成书籍》精校.txt"); encodeFile(file, encodingText(originalText, encoding), encoding);
  if (second) {
    encodeFile(path.join(folder, "另一合成书籍.txt"), originalText, encoding);
    encodeFile(path.join(folder, "第三合成书籍.txt"), originalText, encoding);
  }
  const dbPath = path.join(base, "novels.sqlite");
  python([scanner, "--db", dbPath, "--root", sourceRoot]);
  const reader = createNovelStore({ dbPath }); stores.add(reader);
  const rows = sql(dbPath, db => db.prepare("SELECT id,source_path FROM novel_books ORDER BY source_path").all());
  const id = rows.find(row => path.resolve(row.source_path) === path.resolve(file)).id;
  const others = rows.filter(row => row.id !== id);
  return { dbPath, reader, sourceRoot, file, id, secondId: others[0]?.id, thirdId: others[1]?.id, initial: reader.bookMeta(id) };
}
function encodeFile(file, text, encoding) {
  python(["-c", "import sys; from pathlib import Path; Path(sys.argv[1]).write_bytes(sys.stdin.read().encode(sys.argv[2],errors='replace'))", file, encoding], { input: text });
}
function encodingText(text, encoding) {
  // Big5 bytes can be accepted earlier by the legacy gb18030 decoder. Keep
  // that historical decoder order and compare its exact resulting text.
  return encoding === "big5" ? text.replace("第一章 开始", "1. Start").replace("第二章 保留", "2. Keep").replace("第三章 新增", "3. New") : text;
}
function newArtifactRoot() { const root = path.join(fs.realpathSync(os.tmpdir()), `fanhao-novel-reimport-${crypto.randomUUID()}`); artifactRoots.add(root); return root; }
function exported(item, artifactRoot = newArtifactRoot()) {
  if (!fs.existsSync(artifactRoot)) fs.mkdirSync(artifactRoot);
  const artifactPath = path.join(artifactRoot, `${crypto.randomUUID()}.json`);
  const metadata = item.reader.bookMeta(item.id);
  const descriptor = { bookId: item.id, sourceRealm: metadata.sourceRealm, catalogRevision: metadata.catalogRevision,
    sourcePath: fs.realpathSync(item.file), sourceRoot: fs.realpathSync(item.sourceRoot), sourceIdentity: sourceIdentity(item.file), artifactRoot, artifactPath };
  python([scanner, "--db", path.join(temporary, "must-not-create.sqlite"), "--file", item.file, "--source-root", item.sourceRoot, "--book-id", item.id, "--export-only", artifactPath]);
  const bytes = fs.readFileSync(artifactPath); Object.assign(descriptor, { artifactBytes: bytes.length, artifactHash: crypto.createHash("sha256").update(bytes).digest("hex") });
  return descriptor;
}
function writerFor(item, reimportArtifactRoot, options = {}) {
  const writer = createNovelWriteWorkerClient({ dbPath: item.dbPath, reimportArtifactRoot, readyTimeoutMs: 2000, requestTimeoutMs: 2000,
    ...options, onCommitted: () => item.reader.invalidate() }); writers.add(writer); return writer;
}
function serviceFor(item, options = {}) {
  const service = createNovelReimportService({ dbPath: item.dbPath, novelStore: item.reader, collectionService: { createTask: async () => ({ task: {} }) }, projectRoot,
    artifactRoot: newArtifactRoot(), ...options }); services.add(service); artifactRoots.add(service.diagnostics().artifactRoot); return service;
}
function python(args, options = {}) {
  const result = spawnSync(process.env.PYTHON || "python", ["-B", ...args], { cwd: projectRoot, encoding: "utf8", windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", PYTHONPATH: path.join(projectRoot, "tools") }, ...options });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr || result.stdout); return result;
}
function sql(dbPath, callback) { assert.ok(path.resolve(dbPath).startsWith(temporary + path.sep)); const database = new DatabaseSync(dbPath); try { return callback(database); } finally { database.close(); } }
function modern(detail, chapterIndex, ratio) { return { sourceRealm: detail.sourceRealm, catalogRevision: detail.catalogRevision, chapterId: detail.chapters[chapterIndex - 1].id, chapterIndex, scrollRatio: ratio }; }
function controlledChild() {
  const child = new EventEmitter(); Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kills: 0,
    kill(signal) { assert.equal(signal, "SIGKILL"); this.kills += 1; return true; }, close(code) { this.stdout.end(); this.stderr.end(); this.emit("close", code); } }); return child;
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitFor(predicate) { for (let count = 0; !predicate(); count += 1) { assert.ok(count < 300, "fixture phase timeout"); await delay(5); } }
function assertOwnedArtifactRoot(root) { const resolved = fs.realpathSync(root); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.ok(path.basename(resolved).startsWith("fanhao-novel-reimport-")); }
function removeOwnedDirectory(directory) {
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.ok(path.basename(resolved).startsWith("fanhao-reimport-fixture-"));
  const cleanup = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
    $fixtureRoot = [IO.Path]::GetFullPath($env:FANHAO_REIMPORT_FIXTURE_CLEANUP)
    $resolvedRoot = (Resolve-Path -LiteralPath $fixtureRoot).Path
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ($resolvedRoot -ne $fixtureRoot -or [IO.Path]::GetDirectoryName($resolvedRoot) -ne $temporaryRoot -or -not [IO.Path]::GetFileName($resolvedRoot).StartsWith('fanhao-reimport-fixture-')) { throw 'Unexpected fixture cleanup path' }
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
  `], { encoding: "utf8", windowsHide: true, env: { ...process.env, FANHAO_REIMPORT_FIXTURE_CLEANUP: resolved } });
  assert.ifError(cleanup.error); assert.equal(cleanup.status, 0, cleanup.stderr); assert.equal(fs.existsSync(resolved), false);
}
