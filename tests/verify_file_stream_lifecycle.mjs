import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { createFileServer } from "../src/platform/server/file-server.js";

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-file-streams-"));
const realOpen = fs.promises.open;
const unhandled = [];
const onUnhandled = (error) => unhandled.push(error);
process.on("uncaughtException", onUnhandled);
process.on("unhandledRejection", onUnhandled);
const file = path.join(temporary, "fixture.txt");
const moved = path.join(temporary, "moved.txt");
const originalBytes = Buffer.from("original fixture bytes");
const files = createFileServer({
  mimeTypes: { ".txt": "text/plain" }, normalizeExt: () => ".txt",
  notFound: (res) => { res.writeHead(404); res.end(); }
});
let injectedReader = null;
let lastReader = null;
fs.promises.open = async (...args) => {
  const handle = await realOpen(...args);
  const createReadStream = handle.createReadStream.bind(handle);
  handle.createReadStream = (options) => {
    const stream = injectedReader ? injectedReader(handle) : createReadStream(options);
    lastReader = stream;
    return stream;
  };
  return handle;
};

const server = http.createServer(async (req, res) => {
  try {
  if (req.url === "/health") { res.end("healthy"); return; }
  if (req.url === "/missing") { await files.serveDownloadFile(req, res, { path: `${file}.missing` }); return; }
  if (req.url === "/folder") { await files.serveInlineFile(res, temporary); return; }
  if (req.url === "/inline") await files.serveInlineFile(res, file);
  else if (req.url === "/range") await files.serveRangedFile(req, res, { path: file, ext: ".txt" });
  else await files.serveDownloadFile(req, res, { path: file, ext: ".txt" }, "测试资料.txt");
  } catch (error) {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) res.destroy(error);
    else { res.writeHead(500); res.end(); }
  }
});

try {
  fs.writeFileSync(file, originalBytes);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ["/inline", "/download"]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), originalBytes);
    assert.equal(response.headers.get("content-length"), String(originalBytes.length));
    const head = await fetch(base + route, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    assert.equal(head.headers.get("content-length"), String(originalBytes.length));
  }
  const attachment = await fetch(base + "/download", { method: "HEAD" });
  assert.match(attachment.headers.get("content-disposition"), /filename\*=UTF-8''/);
  assert.equal((await fetch(base + "/missing")).status, 404);
  assert.equal((await fetch(base + "/folder")).status, 404);

  // Change the lexical path after headers. Bytes must still come from the
  // descriptor used to compute those headers, rather than the replacement.
  for (const mode of ["inline", "download"]) {
    fs.writeFileSync(file, originalBytes);
    const res = capturedResponse(() => {
      assert.equal(path.dirname(path.resolve(file)), path.resolve(temporary));
      assert.equal(path.dirname(path.resolve(moved)), path.resolve(temporary));
      fs.renameSync(file, moved);
      fs.writeFileSync(file, "replacement with a different length");
    });
    const finished = once(res, "finish");
    if (mode === "inline") await files.serveInlineFile(res, file);
    else await files.serveDownloadFile(new EventEmitter(), res, { path: file });
    await finished;
    await waitClosed(lastReader);
    assert.deepEqual(res.body(), originalBytes, "path replacement must not change the streamed entity");
    assert.equal(res.headers["Content-Length"], originalBytes.length);
    fs.unlinkSync(moved);
  }

  // An error after headers must close the failed response, stay local to this
  // request, close its descriptor, and leave the HTTP service responsive.
  injectedReader = (handle) => new Readable({
    read() { this.destroy(Object.assign(new Error("controlled disk failure"), { code: "EIO" })); },
    destroy(error, callback) { handle.close().then(() => callback(error), callback); }
  });
  for (const route of ["/inline", "/download", "/range"]) {
    await assert.rejects(async () => {
      const response = await fetch(base + route);
      await response.arrayBuffer();
    }, "a disk failure must not finish a truncated 200 response");
    await waitClosed(lastReader);
    assert.equal(await (await fetch(base + "/health")).text(), "healthy");
  }

  // Cancel a real HTTP request after its first chunk. A controlled slow reader
  // ensures cancellation occurs while the descriptor is still in use.
  let cancelledDescriptor;
  injectedReader = (handle) => {
    cancelledDescriptor = handle.fd;
    let timer;
    return new Readable({
      read() { timer = setTimeout(() => this.push(Buffer.from("x")), 10); },
      destroy(error, callback) { clearTimeout(timer); handle.close().then(() => callback(error), callback); }
    });
  };
  await new Promise((resolve, reject) => {
    const request = http.get(base + "/download", (response) => {
      response.once("data", () => { response.destroy(); resolve(); });
      response.on("error", () => {});
    });
    request.on("error", reject);
  });
  await waitClosed(lastReader);
  assert.throws(() => fs.fstatSync(cancelledDescriptor), { code: "EBADF" });

  injectedReader = null;
  const req = new EventEmitter();
  req.aborted = true;
  const res = capturedResponse();
  const previousReader = lastReader;
  await files.serveDownloadFile(req, res, { path: file });
  assert.equal(lastReader, previousReader, "pre-aborted requests must not create a reader");
  assert.equal(res.headersSent, undefined, "pre-aborted requests must not publish headers");
  assert.equal(req.listenerCount("aborted"), 0, "pre-aborted requests must detach their stream listeners");
  assert.equal(res.listenerCount("close"), 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, [], "file failures must never escape as process-level exceptions");
  console.log("file-streams: ok (GET/HEAD, missing/directory, path replacement, read errors, HTTP cancellation, descriptor/listener release)");
} finally {
  injectedReader = null;
  fs.promises.open = realOpen;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  process.off("uncaughtException", onUnhandled);
  process.off("unhandledRejection", onUnhandled);
  const resolvedTemporary = path.resolve(temporary);
  assert.ok(path.basename(resolvedTemporary).startsWith("fanhao-file-streams-"));
  for (const candidate of [file, moved]) {
    assert.equal(path.dirname(path.resolve(candidate)), resolvedTemporary);
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
  fs.rmdirSync(resolvedTemporary);
}

function waitClosed(stream) {
  return stream.closed ? Promise.resolve() : once(stream, "close");
}
function capturedResponse(beforeHeaders = () => {}) {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  res.writeHead = (status, headers = {}) => {
    res.status = status;
    res.headers = headers;
    res.headersSent = true;
    beforeHeaders();
  };
  res.body = () => Buffer.concat(chunks);
  return res;
}
