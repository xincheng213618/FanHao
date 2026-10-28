import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { once } from "node:events";
import { createFileServer } from "../src/platform/server/file-server.js";

// Real HTTP/FileHandle streams over temporary synthetic bytes. Mutation occurs
// after fstat/headers, and native descriptor close can settle independently of
// the HTTP response. No application service, database or media is accessed.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-file-conditional-"));
const source = path.join(root, "source.bin"), prefix = path.join(root, "prefix.bin");
const mutable = path.join(root, "mutable.bin"), empty = path.join(root, "empty.bin");
const fractional = path.join(root, "fractional.mp4"), ordinary = path.join(root, "ordinary.mp4");
const paths = [source, prefix, mutable, empty, fractional, ordinary];
const original = Buffer.from("0123456789"), records = [], responses = [], tasks = new Set(), closeGates = [];
const realOpen = fs.promises.open;
let nextCloseGate = null, lastTask;
fs.writeFileSync(source, original); fs.writeFileSync(prefix, original.subarray(0, 4)); fs.writeFileSync(empty, "");
fs.utimesSync(source, 1_700_000_000, 1_700_000_000); fs.utimesSync(prefix, 1_700_001_000, 1_700_001_000);
const sourceMtime = fs.statSync(source).mtimeMs;
const fractionalSeconds = 1_700_000_000.123456;
for (const file of [fractional, ordinary]) { fs.writeFileSync(file, original); fs.utimesSync(file, fractionalSeconds, fractionalSeconds); }
const fractionalMtime = fs.statSync(fractional).mtimeMs;
assert.notEqual(fractionalMtime, Math.floor(fractionalMtime), "this fixture needs actual sub-millisecond filesystem precision");
const fractionalFile = { id: "fractional", type: "video", path: fractional, ext: ".mp4", size: original.length,
  cacheVersion: Math.floor(fractionalMtime), entityMtimeMs: Math.floor(fractionalMtime) };
let sourceLookupStats = 0;
const runtime = fs.readFileSync(new URL("../src/modules/short-videos/server/runtime.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const runtimeFunction = name => {
  const start = new RegExp(`^  (?:async )?function ${name}\\(`, "m").exec(runtime)?.index;
  assert(start != null, name); return runtime.slice(start, runtime.indexOf("\n  }", start) + 4);
};
const runtimeContext = vm.createContext({
  fs: { ...fs, statSync(file, ...args) { if (file === fractional) { sourceLookupStats++; throw new Error("unexpected source lookup stat"); } return fs.statSync(file, ...args); } },
  path, crypto, SHORT_VIDEO_STARTUP_CACHE_BYTES: 4, sharedCache: { rootDir: root, touch() {} }
});
vm.runInContext(`${["cachedStartupVideoFile", "startupVideoCacheDescriptor", "safeStat", "hashText", "safeFilePart"].map(runtimeFunction).join("\n")}\nglobalThis.startup = { cachedStartupVideoFile, startupVideoCacheDescriptor };`, runtimeContext);
const startupDescriptor = runtimeContext.startup.startupVideoCacheDescriptor(fractionalFile.id, fractionalFile);
fs.mkdirSync(startupDescriptor.cacheDir, { recursive: true }); fs.writeFileSync(startupDescriptor.cachePath, original.subarray(0, 4));
const fractionalPrefix = runtimeContext.startup.cachedStartupVideoFile(fractionalFile.id, fractionalFile);
fs.promises.open = async (...args) => {
  const handle = await realOpen(...args), gate = nextCloseGate; nextCloseGate = null;
  const record = { handle, streams: [], physicalCloses: 0 }; records.push(record);
  const close = handle.close.bind(handle), stream = handle.createReadStream.bind(handle);
  handle.close = async () => { if (gate) await gate.promise; await close(); record.physicalCloses++; };
  handle.createReadStream = options => { record.streams.push(options); return stream(options); };
  return handle;
};
const files = createFileServer({ mimeTypes: { ".bin": "application/octet-stream", ".mp4": "video/mp4" }, normalizeExt: () => ".bin",
  notFound(res) { res.writeHead(404, { "Content-Length": 0 }); res.end(); } });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://fixture.local"), response = { route: url.pathname, finished: false };
  responses.push(response); res.once("finish", () => { response.finished = true; });
  const task = (async () => {
    const file = { path: source, ext: ".bin", cacheControl: "private, max-age=0, must-revalidate" };
    if (url.pathname === "/prefix") Object.assign(file, { path: prefix, totalSize: original.length, entityMtimeMs: sourceMtime });
    if (url.pathname === "/metadata-override") Object.assign(file, { entityMtimeMs: sourceMtime + 999_000, cacheVersion: sourceMtime + 999_000 });
    if (url.pathname === "/strong") file.entityTag = '"version,one"';
    if (url.pathname === "/fractional") Object.assign(file, fractionalFile, { entityMtimeResolutionMs: 1 });
    if (url.pathname === "/fractional-prefix") Object.assign(file, fractionalPrefix);
    if (url.pathname === "/ordinary") Object.assign(file, { ...fractionalFile, path: ordinary });
    if (url.pathname === "/empty") file.path = empty;
    if (url.pathname === "/missing") file.path = path.join(root, "missing.bin");
    const mode = url.searchParams.get("mode") || "range";
    if (url.pathname === "/mutate") {
      fs.writeFileSync(mutable, original); file.path = mutable;
      const writeHead = res.writeHead.bind(res);
      res.writeHead = (...args) => {
        const result = writeHead(...args);
        if (url.searchParams.get("kind") === "grow") fs.appendFileSync(mutable, "ABCDEFGHIJ");
        else fs.truncateSync(mutable, 4);
        return result;
      };
    }
    if (mode === "inline") await files.serveInlineFile(res, file.path);
    else if (mode === "download") await files.serveDownloadFile(req, res, file);
    else await files.serveRangedFile(req, res, file);
  })();
  lastTask = task; tasks.add(task);
  task.catch(error => { if (!res.destroyed && !res.writableEnded) res.destroy(error); }).finally(() => tasks.delete(task));
});
const tick = () => new Promise(resolve => setImmediate(resolve));
const drain = async () => { await Promise.all([...tasks]); assert.equal(files.diagnostics().active, 0); };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  const gate = { promise, resolve }; closeGates.push(gate); return gate;
}
function assertReleased(record) {
  assert.equal(record.handle.fd, -1); assert.equal(record.physicalCloses, 1);
}

try {
  assert.equal(fractionalPrefix.entityMtimeResolutionMs, 1, "the real runtime startup helper explicitly carries the catalog precision contract");
  assert.equal(sourceLookupStats, 0, "a startup cache hit cannot wake the source disk for another stat");
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port, base = `http://127.0.0.1:${port}`;
  const raw = route => new Promise((resolve, reject) => {
    const chunks = [], socket = net.connect(port, "127.0.0.1", () => socket.write(`GET ${route} HTTP/1.1\r\nHost: fixture.local\r\nConnection: close\r\n\r\n`));
    socket.on("data", bytes => chunks.push(bytes)); socket.on("error", reject);
    socket.on("end", () => {
      const bytes = Buffer.concat(chunks), index = bytes.indexOf("\r\n\r\n");
      resolve({ headers: bytes.subarray(0, index).toString(), body: bytes.subarray(index + 4) });
    });
  });
  for (const mode of ["range", "inline", "download"]) {
    const grown = await raw(`/mutate?kind=grow&mode=${mode}`); await drain();
    assert.match(grown.headers, /Content-Length: 10\r\n/i);
    assert.deepEqual(grown.body, original, `${mode}: an in-place append cannot exceed the advertised fstat boundary`);
    const record = records.at(-1); assert.deepEqual(record.streams[0], { start: 0, end: 9, autoClose: true, emitClose: true }); assertReleased(record);
    await assert.rejects(async () => { const response = await fetch(`${base}/mutate?kind=truncate&mode=${mode}`); await response.arrayBuffer(); }, `${mode}: an early EOF must abort its incomplete Content-Length response`);
    await drain(); assert.equal(responses.at(-1).finished, false, `${mode}: short reads cannot report a normal response finish`); assertReleased(records.at(-1));
    const head = await fetch(`${base}/mutate?kind=grow&mode=${mode}`, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), "10"); assert.equal((await head.arrayBuffer()).byteLength, 0);
    await drain(); assert.equal(records.at(-1).streams.length, 0); assertReleased(records.at(-1));
  }
  await assert.rejects(async () => { const response = await fetch(`${base}/mutate?kind=truncate`, { headers: { range: "bytes=3-7" } }); await response.arrayBuffer(); });
  await drain(); assert.equal(responses.at(-1).finished, false); assertReleased(records.at(-1));

  const initial = await fetch(base + "/source", { method: "HEAD" });
  const tag = initial.headers.get("etag"), modified = initial.headers.get("last-modified"); await drain();
  const oldDate = "Mon, 13 Nov 2023 00:00:00 GMT", futureDate = "Tue, 14 Nov 2034 00:00:00 GMT";
  const conditions = [
    [{ "if-none-match": tag }, 304],
    [{ "if-none-match": tag.replace(/^W\//, ""), range: "bytes=1-3" }, 304],
    [{ "if-none-match": `"different", ${tag}`, range: "bytes=99-" }, 304],
    [{ "if-none-match": "*" }, 304],
    [{ "if-none-match": '"different"', "if-modified-since": futureDate }, 200],
    [{ "if-modified-since": modified }, 304],
    [{ "if-modified-since": oldDate }, 200],
    [{ "if-modified-since": "2050" }, 200],
    [{ "if-modified-since": "Foo, 14 Nov 2034 00:00:00 GMT" }, 200],
    [{ "if-unmodified-since": oldDate }, 412],
    [{ "if-unmodified-since": modified, "if-none-match": tag }, 304],
    [{ "if-match": '"stale"', "if-none-match": tag }, 412],
    [{ "if-match": tag }, 412],
    [{ "if-match": "*", "if-unmodified-since": oldDate }, 200]
  ];
  for (const method of ["GET", "HEAD"]) {
    for (const [headers, status] of conditions) {
      const response = await fetch(base + "/source", { method, headers });
      assert.equal(response.status, status, `${method}/${JSON.stringify(headers)}: preconditions precede Range with correct entity-tag/date precedence`);
      const body = Buffer.from(await response.arrayBuffer()); await drain();
      assertReleased(records.at(-1));
      if (status !== 200 || method === "HEAD") assert.equal(body.length, 0);
      if (status !== 200) {
        assert.equal(records.at(-1).streams.length, 0, "304/412 cannot create a data stream");
        assert.equal(response.headers.get("content-range"), null);
      }
      if (status === 304) {
        assert.equal(response.headers.get("content-length"), null); assert.equal(response.headers.get("etag"), tag);
        assert.equal(response.headers.get("cache-control"), "private, max-age=0, must-revalidate");
      }
    }
  }
  for (const mode of ["inline", "download"]) {
    for (const method of ["GET", "HEAD"]) {
      for (const [headers, status] of [
        [{ "if-none-match": tag }, 304], [{ "if-modified-since": modified }, 304],
        [{ "if-match": '"stale"', "if-none-match": tag }, 412],
        [{ "if-none-match": '"different"', "if-modified-since": futureDate }, 200]
      ]) {
        const response = await fetch(`${base}/source?mode=${mode}`, { method, headers });
        assert.equal(response.status, status, `${mode}/${method}: whole-file transfers share the same read preconditions`);
        const body = await response.arrayBuffer(); await drain(); assertReleased(records.at(-1));
        if (status !== 200 || method === "HEAD") { assert.equal(body.byteLength, 0); assert.equal(records.at(-1).streams.length, 0); }
      }
    }
  }
  for (const [headers, status] of [
    [{ "if-none-match": '"other", W/"version,one"', range: "bytes=2-4" }, 304],
    [{ "if-match": '"other", "version,one"', range: "bytes=2-4" }, 206],
    [{ "if-match": 'W/"version,one"' }, 412]
  ]) {
    const response = await fetch(base + "/strong", { headers }); assert.equal(response.status, status); await response.arrayBuffer(); await drain(); assertReleased(records.at(-1));
  }
  const missing = await fetch(base + "/missing", { headers: { "if-none-match": "*" } });
  assert.equal(missing.status, 404); await missing.arrayBuffer(); await drain();

  const prefixed = await fetch(base + "/prefix", { headers: { range: "bytes=0-3" } });
  assert.equal(prefixed.status, 206); assert.equal(prefixed.headers.get("etag"), tag); assert.equal(prefixed.headers.get("last-modified"), modified);
  assert.equal(prefixed.headers.get("content-range"), "bytes 0-3/10"); assert.deepEqual(Buffer.from(await prefixed.arrayBuffer()), original.subarray(0, 4)); await drain();
  const prefixVerified = await fetch(base + "/prefix", { headers: { range: "bytes=0-3", "if-none-match": tag } });
  assert.equal(prefixVerified.status, 304); await prefixVerified.arrayBuffer(); await drain(); assert.equal(records.at(-1).streams.length, 0);
  const overridden = await fetch(base + "/metadata-override", { method: "HEAD" });
  assert.equal(overridden.headers.get("etag"), tag); assert.equal(overridden.headers.get("last-modified"), modified); await drain();

  const prefixFraction = await fetch(base + "/fractional-prefix", { headers: { range: "bytes=0-3" } });
  const prefixTag = prefixFraction.headers.get("etag");
  assert.equal(prefixFraction.status, 206); assert.deepEqual(Buffer.from(await prefixFraction.arrayBuffer()), original.subarray(0, 4)); await drain();
  const sourceFraction = await fetch(base + "/fractional", { headers: { range: "bytes=4-7" } });
  assert.equal(sourceFraction.headers.get("etag"), prefixTag, "a real runtime prefix and fractional-mtime source share the opted-in millisecond validator");
  assert.deepEqual(Buffer.from(await sourceFraction.arrayBuffer()), original.subarray(4, 8)); await drain();
  const fractionalVerified = await fetch(base + "/fractional", { headers: { "if-none-match": prefixTag } });
  assert.equal(fractionalVerified.status, 304); await fractionalVerified.arrayBuffer(); await drain();
  assert.equal(records.at(-1).streams.length, 0);
  assert.equal(fractionalFile.entityMtimeResolutionMs, undefined, "precision selection never mutates the catalog source object");

  const plainBefore = await fetch(base + "/ordinary", { method: "HEAD" }); const nativeTag = plainBefore.headers.get("etag"); await drain();
  fs.writeFileSync(ordinary, "abcdefghij"); fs.utimesSync(ordinary, 1_700_000_000.123789, 1_700_000_000.123789);
  const rewrittenOrdinary = fs.statSync(ordinary);
  assert.equal(Math.floor(rewrittenOrdinary.mtimeMs), Math.floor(fractionalMtime));
  assert.notEqual(rewrittenOrdinary.mtimeMs, fractionalMtime);
  const plainAfter = await fetch(base + "/ordinary", { method: "HEAD" }); await drain();
  assert.notEqual(plainAfter.headers.get("etag"), nativeTag, "a complete file without opt-in still detects same-length sub-millisecond rewrites through fstat");

  fs.writeFileSync(fractional, "abcdefghij"); fs.utimesSync(fractional, 1_700_000_000.125234, 1_700_000_000.125234);
  assert.equal(fractionalFile.cacheVersion, Math.floor(fractionalMtime), "the catalog revision intentionally stays stale");
  const sourceChanged = await fetch(base + "/fractional", { headers: { "if-none-match": prefixTag } });
  assert.equal(sourceChanged.status, 200, "cross-millisecond source changes cannot be hidden by stale catalog metadata");
  assert.notEqual(sourceChanged.headers.get("etag"), prefixTag); assert.deepEqual(Buffer.from(await sourceChanged.arrayBuffer()), Buffer.from("abcdefghij")); await drain();
  for (const method of ["GET", "HEAD"]) {
    const response = await fetch(base + "/empty", { method });
    assert.equal(response.status, 200); assert.equal(response.headers.get("content-length"), "0"); assert.equal((await response.arrayBuffer()).byteLength, 0);
    await drain(); assert.equal(records.at(-1).streams.length, 0); assertReleased(records.at(-1));
  }

  const gate = deferred(); nextCloseGate = gate;
  const verified = await fetch(base + "/source", { headers: { "if-none-match": tag } });
  assert.equal(verified.status, 304); await verified.arrayBuffer();
  let served = false, stopped = false;
  const serving = lastTask.then(() => { served = true; });
  const stopping = files.stop().then(() => { stopped = true; }); await tick();
  assert.equal(records.at(-1).streams.length, 0); assert.ok(records.at(-1).handle.fd >= 0);
  assert.equal(served, false); assert.equal(stopped, false); assert.equal(files.diagnostics().active, 1, "304 retains ownership until its physical FileHandle closes");
  gate.resolve(); await serving; await stopping; assertReleased(records.at(-1));
  assert.equal(await files.start(), true); await drain();
  console.log("file-server-conditional: passed real HTTP fstat body bounds, conditional GET/HEAD, fractional runtime prefix precision, stale catalog authority and descriptor drain");
} finally {
  closeGates.forEach(gate => gate.resolve()); server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await Promise.allSettled([...tasks]); await files.stop(); fs.promises.open = realOpen;
  const resolvedRoot = path.resolve(root); assert(path.basename(resolvedRoot).startsWith("fanhao-file-conditional-"));
  for (const candidate of paths) { assert.equal(path.dirname(path.resolve(candidate)), resolvedRoot); if (fs.existsSync(candidate)) fs.unlinkSync(candidate); }
  assert.equal(path.dirname(startupDescriptor.cacheDir), path.join(resolvedRoot, "short-videos"));
  if (fs.existsSync(startupDescriptor.cachePath)) fs.unlinkSync(startupDescriptor.cachePath);
  fs.rmdirSync(startupDescriptor.cacheDir); fs.rmdirSync(path.dirname(startupDescriptor.cacheDir));
  fs.rmdirSync(resolvedRoot);
}
