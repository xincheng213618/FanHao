import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib, { brotliDecompressSync, gunzipSync } from "node:zlib";
import { createRequestHandler } from "../src/platform/server/http-app.js";
import { sendJson as actualSendJson, sendText } from "../src/platform/server/responses.js";

// A supplied sender permits an isolated negative control without changing the
// production module. Every response still crosses an actual loopback socket.
export async function runJsonResponseFixture({ sendJson = actualSendJson } = {}) {
  const large = { text: "合成 JSON response\n".repeat(1024), count: 1024 };
  const small = { text: "合成", ok: true };
  const origin = "https://fixture.invalid";
  const logs = [], completed = [];
  let scenario;
  const handler = createRequestHandler({
    attachAccessAnalytics() {}, attachAccessLogger() {},
    requestCorsOrigin: req => req.headers.origin === origin ? origin : "",
    requestAuthState: () => ({ allowed: true, user: { id: "json-fixture" } }),
    routeAuth: async () => false,
    sendLoginRequired() { assert.fail("fixture requests must be authorized"); },
    routeApi(_req, res) {
      const current = scenario;
      assert(current, "each request must have an explicit response scenario");
      current.response = res;
      if (current.vary !== undefined) res.setHeader("Vary", current.vary);
      current.onResponse?.(res);
      sendJson(res, current.status ?? 201, current.payload ?? large);
      return true;
    },
    routeMedia: async () => false,
    serveStatic() { assert.fail("JSON fixture must not serve files"); },
    renderAndroidUpdatePage: () => "", sendHtml() {}, sendJson, sendText,
    logError(...args) { logs.push(args); }
  });
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  function start(current) {
    scenario = current;
    const headers = current.origin === false ? {} : { Origin: origin };
    if (current.accepted !== undefined) headers["Accept-Encoding"] = current.accepted;
    let request;
    const promise = new Promise((resolve, reject) => {
      request = http.get({ host: "127.0.0.1", port: server.address().port, path: "/api/json-fixture", agent: false, headers }, res => {
        const chunks = [];
        res.on("data", chunk => chunks.push(chunk));
        res.once("error", reject);
        res.once("aborted", () => reject(new Error("fixture response was aborted")));
        res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      request.once("error", reject);
      request.setTimeout(5000, () => request.destroy(new Error("JSON fixture request timed out")));
    });
    // Disconnect cases observe the rejection after the server's close event.
    promise.catch(() => {});
    return { request, promise };
  }
  async function run(name, action) {
    try { await action(); assert.deepEqual(logs, [], "the actual request handler must not log an error"); }
    catch (error) { error.message = `${name}: ${error.message}`; throw error; }
    completed.push(name);
  }
  function check(response, { payload = large, encoding = "", status = 201, vary = ["Origin", "Accept-Encoding"], empty = false, cors = true } = {}) {
    assert.equal(response.status, status);
    assert.equal(response.headers["content-encoding"] || "", encoding);
    assert.equal(Number(response.headers["content-length"]), response.body.length, "Content-Length must describe transmitted bytes");
    assert.equal(response.headers["cache-control"], "no-store");
    if (cors) assert.equal(response.headers["access-control-allow-origin"], origin);
    const actualVary = String(response.headers.vary || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
    assert.equal(new Set(actualVary).size, actualVary.length, "Vary must not duplicate fields ignoring case");
    assert.deepEqual(actualVary.sort(), vary.map(value => value.toLowerCase()).sort(), "Vary must preserve existing dependencies");
    if (empty) { assert.equal(response.body.length, 0); return; }
    assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
    const decoded = encoding === "br" ? brotliDecompressSync(response.body) : encoding === "gzip" ? gunzipSync(response.body) : response.body;
    assert.deepEqual(decoded, Buffer.from(JSON.stringify(payload)), "negotiation must preserve exact UTF-8 JSON bytes");
  }
  try {
    // The first case is also the old implementation's Vary-overwrite control.
    for (const [accepted, encoding] of [
      ["br, gzip", "br"], ["gzip", "gzip"], [undefined, ""], ["identity", ""], ["zstd", ""],
      ["br;q=0, gzip;q=1", "gzip"], ["gzip;q=0.5, identity;q=1", ""],
      ["gzip;q=1, identity;q=0.5", "gzip"], ["br;q=0, *;q=0.8", "gzip"],
      ["*", "br"], ["*;q=0, identity;q=0.5", ""],
      ["Br;Q=0.2, GZiP;Q=0.8", "gzip"], ["br;q=1.1, gzip", "gzip"],
      ["br;q=0, br;q=1, gzip", "gzip"], ["br;q=1, br;q=0, gzip", "gzip"],
      ["identity;q=1, identity;q=0, gzip;q=0.5", "gzip"]
    ]) await run(`negotiation ${accepted ?? "absent"}`, async () => {
      check(await start({ accepted }).promise, { encoding });
    });

    for (const accepted of ["gzip", "identity", "*;q=0"]) {
      for (const [vary, expected] of [
        ["Origin, X-Fixture", ["Origin", "X-Fixture", "Accept-Encoding"]],
        [["Origin", "X-Fixture"], ["Origin", "X-Fixture", "Accept-Encoding"]],
        ["Origin, aCcEpT-EnCoDiNg", ["Origin", "Accept-Encoding"]],
        [["Origin", "ACCEPT-ENCODING"], ["Origin", "Accept-Encoding"]],
        ["*", ["*"]]
      ]) await run(`existing Vary ${JSON.stringify(vary)} / ${accepted}`, async () => {
        const rejected = accepted === "*;q=0";
        check(await start({ accepted, vary }).promise, { encoding: accepted === "gzip" ? "gzip" : "", vary: expected, status: rejected ? 406 : 201, empty: rejected });
      });
    }
    await run("no Origin still varies by encoding", async () => {
      check(await start({ accepted: "gzip", origin: false }).promise, { encoding: "gzip", vary: ["Accept-Encoding"], cors: false });
    });
    await run("small Unicode JSON keeps identity", async () => {
      check(await start({ accepted: "br, gzip", payload: small }).promise, { payload: small });
    });
    for (const size of [4095, 4096]) await run(`compression threshold ${size} bytes`, async () => {
      const payload = { text: "x".repeat(size - Buffer.byteLength(JSON.stringify({ text: "" }))) };
      assert.equal(Buffer.byteLength(JSON.stringify(payload)), size);
      check(await start({ accepted: "br", payload }).promise, { payload, encoding: size === 4096 ? "br" : "" });
    });
    for (const [accepted, payload] of [
      ["br;q=0, gzip;q=0, identity;q=0", large], ["*;q=0", large],
      ["zstd, identity;q=0", large], ["gzip, identity;q=0", small],
      ["identity;q=0, identity;q=1", large]
    ]) await run(`no acceptable representation ${accepted} / ${payload === small ? "small" : "large"}`, async () => {
      check(await start({ accepted, payload }).promise, { status: 406, empty: true });
    });

    for (const encoding of ["br", "gzip"]) {
      for (const identityAllowed of [true, false]) await run(`compression failure ${encoding} / identity ${identityAllowed}`, async () => {
        await withCompressionGate(encoding, async gate => {
          const pending = start({ accepted: `${encoding}, identity;q=${identityAllowed ? 1 : 0}`, status: 202 });
          await bounded(gate.entered, "compression entry");
          gate.finish(new Error("controlled compression failure"));
          check(await pending.promise, { status: identityAllowed ? 202 : 500, empty: !identityAllowed });
        });
      });
      for (const outcome of ["success", "failure"]) {
        await run(`disconnect before ${encoding} ${outcome} callback`, async () => {
          await withCompressionGate(encoding, async gate => {
            const closed = deferred(), calls = { head: 0, end: 0 };
            const current = { accepted: encoding, onResponse(res) { countWrites(res, calls); res.once("close", closed.resolve); } };
            const pending = start(current);
            await bounded(gate.entered, "compression entry");
            pending.request.destroy();
            await bounded(closed.promise, "server response close");
            await assert.rejects(pending.promise);
            assert.equal(current.response.destroyed, true);
            gate.finish(outcome === "failure" ? new Error("late compression failure") : null, Buffer.from("late compressed bytes"));
            assert.deepEqual(calls, { head: 0, end: 0 }, "late callbacks must not write to a disconnected response");
          });
        });
        await run(`ended before ${encoding} ${outcome} callback`, async () => {
          await withCompressionGate(encoding, async gate => {
            const calls = { head: 0, end: 0 };
            const current = { accepted: encoding, onResponse(res) { countWrites(res, calls); } };
            const pending = start(current);
            await bounded(gate.entered, "compression entry");
            current.response.writeHead(202, { "Content-Length": 4 });
            current.response.end("done");
            assert.equal(current.response.writableEnded, true);
            const before = { ...calls };
            gate.finish(outcome === "failure" ? new Error("late compression failure") : null, Buffer.from("late compressed bytes"));
            assert.deepEqual(calls, before, "late callbacks must not rewrite an ended response");
            const response = await pending.promise;
            assert.equal(response.status, 202); assert.equal(response.body.toString(), "done");
          });
        });
      }
    }
    console.log(`json-responses: ${completed.length} HTTP negotiation, Vary, fallback and callback-lifecycle checks passed (loopback and synthetic JSON only)`);
    return completed;
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

function countWrites(res, calls) {
  const writeHead = res.writeHead, end = res.end;
  res.writeHead = function (...args) { calls.head++; return writeHead.apply(this, args); };
  res.end = function (...args) { calls.end++; return end.apply(this, args); };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function withCompressionGate(encoding, action) {
  const name = encoding === "br" ? "brotliCompress" : "gzip";
  const original = zlib[name], entered = deferred();
  let callback;
  zlib[name] = (_body, _options, finish) => { assert.equal(callback, undefined, "one compression per gated request"); callback = finish; entered.resolve(); };
  syncBuiltinESMExports();
  try { return await action({ entered: entered.promise, finish(...args) { assert(callback, "compression must have started"); callback(...args); } }); }
  finally { zlib[name] = original; syncBuiltinESMExports(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runJsonResponseFixture();
