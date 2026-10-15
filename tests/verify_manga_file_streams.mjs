import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { createFileServer } from "../src/platform/server/file-server.js";
import { createMangaService } from "../src/modules/photos/server/manga-service.js";

// Exercise the actual manga routes and shared file server using private files.
// Open/close gates and injected read failures never touch user media or SQLite.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-file-streams-"));
const book = path.join(root, "smtt6_cache_fixture");
const chapters = path.join(book, "chapters");
const chapter = path.join(chapters, "001");
const images = path.join(chapter, "images");
for (const directory of [book, chapters, chapter, images]) fs.mkdirSync(directory);
const coverPath = path.join(book, "cover.png");
const archivePath = path.join(chapters, "001.zip");
const body = Buffer.alloc(256 * 1024, 42);
fs.writeFileSync(coverPath, body);
fs.writeFileSync(archivePath, body);
fs.writeFileSync(path.join(images, "001.png"), "fixture image");
fs.writeFileSync(path.join(book, "catalog.json"), JSON.stringify({ title: "Fixture", url: "https://synthetic.invalid/stream" }));
fs.writeFileSync(path.join(book, "manifest.json"), JSON.stringify({ chapters: [{
  index: 1, title: "One", status: "done", images: [{ index: 1, local_path: "chapters/001/images/001.png", status: "downloaded" }]
}] }));
const notFound = res => { res.writeHead(404, { "Content-Length": 0 }); res.end(); };
const mimeTypes = { ".png": "image/png", ".zip": "application/zip" };
const normalizeExt = file => path.extname(file).toLowerCase();
const fileServer = createFileServer({ mimeTypes, normalizeExt, notFound });
const service = createMangaService({
  root, mimeTypes, normalizeExt, notFound, serveWholeFile: fileServer.serveWholeFile,
  safeStat(file) { try { return fs.statSync(file); } catch { return null; } }
});
const id = service.publicSummary(book).id;
assert.equal(service.cacheById(id), book);
const originalOpen = fs.promises.open;
const handles = [];
const streams = [];
let mode = {};
let checks = 0;
fs.promises.open = async function (file, ...args) {
  assert.ok(file === coverPath || file === archivePath, "only this fixture's transfer files may be opened");
  const intent = mode;
  if (intent.removeBeforeOpen) fs.unlinkSync(file);
  const handle = await originalOpen.call(this, file, ...args);
  const record = { handle, physicallyClosed: false };
  handles.push(record);
  const close = handle.close.bind(handle);
  handle.close = async () => {
    intent.closeStarted?.resolve();
    if (intent.closeGate) await intent.closeGate.promise;
    await close();
    record.physicallyClosed = true;
  };
  const createReadStream = handle.createReadStream.bind(handle);
  handle.createReadStream = options => {
    const stream = createReadStream(options);
    streams.push(stream);
    intent.streamStarted?.resolve();
    if (intent.readError) queueMicrotask(() => stream.destroy(Object.assign(new Error("controlled manga read failure"), { code: "EIO" })));
    return stream;
  };
  intent.opened?.resolve();
  if (intent.openGate) await intent.openGate.promise;
  return handle;
};

try {
  for (const kind of ["cover", "archive"]) {
    mode = {};
    const success = response();
    await bounded(serve(kind, request(), success));
    assert.equal(success.status, 200);
    assert.deepEqual(Buffer.concat(success.chunks), body);
    assert.equal(success.headers["Content-Length"], body.length);
    assert.equal(success.headers["Cache-Control"], kind === "cover" ? "private, max-age=86400" : "no-store");
    assert.equal(success.headers["Content-Type"], kind === "cover" ? "image/png" : "application/zip");
    assert.equal(success.headers["Content-Disposition"], kind === "cover" ? "inline" : "attachment; filename=\"Fixture - One.zip\"; filename*=UTF-8''Fixture%20-%20One.zip");
    assert.equal(success.writableFinished, true);
    assertDrained(); checks++;

    const beforeHead = streams.length;
    const head = response();
    await bounded(serve(kind, request("HEAD"), head));
    assert.deepEqual(head.headers, success.headers);
    assert.equal(head.chunks.length, 0);
    assert.equal(streams.length, beforeHead, "HEAD must close its opened descriptor without creating a data stream");
    assertDrained(); checks++;

    const beforeAborted = handles.length;
    const aborted = request(); aborted.aborted = true;
    const cancelled = response();
    await bounded(serve(kind, aborted, cancelled));
    assert.equal(handles.length, beforeAborted, "an already aborted request must not open the transfer file");
    assert.equal(cancelled.destroyed, true);
    assert.equal(cancelled.headersSent, false);
    assertDrained(); checks++;

    mode = { opened: deferred(), openGate: deferred() };
    const late = response();
    const lateTask = serve(kind, request(), late);
    await bounded(mode.opened.promise);
    late.destroy();
    const beforeLateStream = streams.length;
    mode.openGate.resolve();
    await bounded(lateTask);
    assert.equal(late.headersSent, false);
    assert.equal(streams.length, beforeLateStream, "a descriptor arriving after disconnect must be closed without streaming");
    assertDrained(); checks++;

    mode = { closeStarted: deferred(), closeGate: deferred() };
    const disconnect = response(res => res.destroy());
    let disconnectSettled = false;
    const disconnectTask = serve(kind, request(), disconnect).finally(() => { disconnectSettled = true; });
    await bounded(mode.closeStarted.promise);
    assert.equal(streams.at(-1).destroyed, true);
    assert.equal(disconnectSettled, false, "the manga route must await physical descriptor closure after disconnect");
    assert.equal(fileServer.diagnostics().active, 1, "shutdown must retain the route's open descriptor owner");
    mode.closeGate.resolve();
    await bounded(disconnectTask);
    assertDrained(); checks++;

    mode = { readError: true };
    const failed = response();
    await bounded(serve(kind, request(), failed));
    assert.equal(failed.status, 200, "the read error occurs after the successful headers");
    assert.equal(failed.destroyed, true, "a failed partial response must close instead of leaving the client waiting");
    assert.equal(failed.writableFinished, false);
    assertDrained(); checks++;

    mode = {};
    const partial = response(() => streams.at(-1).destroy(Object.assign(new Error("controlled partial manga read failure"), { code: "EIO" })));
    await bounded(serve(kind, request(), partial));
    assert.ok(Buffer.concat(partial.chunks).length > 0 && Buffer.concat(partial.chunks).length < body.length);
    assert.equal(partial.destroyed, true, "a read failure after some bytes must close the incomplete response");
    assert.equal(partial.writableFinished, false);
    assertDrained(); checks++;

    mode = { removeBeforeOpen: true };
    const missing = response();
    await bounded(serve(kind, request(), missing));
    assert.equal(missing.status, 404, "a file removed after the metadata lookup must not publish a successful body length");
    assert.equal(missing.writableFinished, true);
    fs.writeFileSync(kind === "cover" ? coverPath : archivePath, body);
    assertDrained(); checks++;

    mode = { closeStarted: deferred(), closeGate: deferred() };
    const stopping = response(() => fileServer.beginStop());
    const stoppingTask = serve(kind, request(), stopping);
    await bounded(mode.closeStarted.promise);
    let stopSettled = false;
    const stopTask = fileServer.stop().finally(() => { stopSettled = true; });
    await Promise.resolve();
    assert.equal(stopping.destroyed, true);
    assert.equal(stopSettled, false, "global file-server shutdown must await the manga transfer descriptor");
    mode.closeGate.resolve();
    await bounded(Promise.all([stoppingTask, stopTask]));
    assertDrained();
    await fileServer.start(); checks++;
  }
  console.log(JSON.stringify({ ok: true, routes: 2, scenarios: checks, openedHandles: handles.length, physicalCloses: handles.filter(handle => handle.physicallyClosed).length, activeOwners: fileServer.diagnostics().active }, null, 2));
} finally {
  mode.openGate?.resolve(); mode.closeGate?.resolve();
  fs.promises.open = originalOpen;
  for (const stream of streams) stream.destroy();
  await fileServer.stop();
  for (const record of handles) await record.handle.close().catch(() => undefined);
  // Explicitly created private directories only, deepest first; no recursive rm.
  for (const directory of [images, chapter, chapters, book, root]) {
    assert.ok(directory === root || (path.isAbsolute(directory) && path.relative(root, directory).split(path.sep)[0] !== ".."));
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      assert.equal(entry.isDirectory(), false);
      fs.unlinkSync(path.join(directory, entry.name));
    }
    fs.rmdirSync(directory);
  }
}

function serve(kind, req, res) {
  return kind === "cover" ? service.serveCover(req, res, id) : service.serveChapterDownload(req, res, id, "1");
}
function request(method = "GET") { return Object.assign(new EventEmitter(), { method, aborted: false }); }
function response(onChunk) {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); onChunk?.(res); callback(); } });
  res.chunks = chunks;
  res.headersSent = false;
  res.writeHead = (status, headers = {}) => { assert.equal(res.headersSent, false); res.status = status; res.headers = headers; res.headersSent = true; };
  return res;
}
function assertDrained() {
  assert.equal(fileServer.diagnostics().active, 0);
  assert.equal(handles.every(handle => handle.physicallyClosed), true, "all completed route handles must have finished closing");
  assert.equal(streams.every(stream => stream.closed), true);
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("fixture transfer did not settle")), 2000); })]); }
  finally { clearTimeout(timer); }
}
