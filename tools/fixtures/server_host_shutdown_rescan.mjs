import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createMusicRuntime } from "../../src/modules/music/server/runtime.js";
import { createServerHost } from "../../src/platform/server/server-host.js";

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-music-shutdown-"));
const libraryRoot = path.join(fixtureDir, "library");
fs.mkdirSync(libraryRoot);
const runtime = createMusicRuntime({
  dbPath: path.join(fixtureDir, "music.sqlite"),
  roots: [libraryRoot],
  scanWorkerOptions: {
    scanWorkerUrl: new URL("./music_scan_worker_failure.mjs", import.meta.url),
    scanWorkerData: { mode: "hang" }
  },
  mediaResponseService: { serveImage() {} },
  mediaStreamService: { serveVideo() {} },
  serveDownloadFile() {},
  notFound(res) { res.writeHead(404).end(); },
  readJsonBody,
  requireLocalAdmin() { return true; },
  sendJson
});
await runtime.start();

let beginStopCalled = false;
let rescanCancelled = false;
const logger = {
  log(message) {
    if (String(message).startsWith("[shutdown]")) console.log("FIXTURE_SIGTERM");
  },
  error(scope, error) {
    console.error("FIXTURE_ERROR", scope, error?.message || error);
  }
};

const host = createServerHost({
  async requestHandler(req, res) {
    const routing = runtime.routeApi(req, res, new URL(req.url, "http://127.0.0.1"));
    if (req.method === "POST" && req.url === "/api/music/rescan") {
      await waitFor(() => runtime.store.scanDiagnostics().scanDispatches === 1);
      console.log("FIXTURE_RESCAN_ACTIVE");
      setImmediate(() => process.emit("SIGTERM"));
    }
    if (!await routing && !res.writableEnded) res.writeHead(404).end();
  },
  port: 0,
  host: "127.0.0.1",
  getLibraryState: () => ({ availableRoots: [libraryRoot], missingRoots: [] }),
  async beginStop() {
    beginStopCalled = true;
    if (host.server.listening) throw new Error("server still accepting connections during beginStop");
    console.log("FIXTURE_BEGIN_STOP");
    await runtime.beginStop();
    rescanCancelled = true;
    console.log("FIXTURE_RESCAN_CANCELLED");
  },
  async stop() {
    if (!beginStopCalled || !rescanCancelled) throw new Error("rescan was not cancelled before final stop");
    await runtime.stop();
    cleanupFixture();
    console.log("FIXTURE_STOP");
  },
  logger,
  setTimeoutFn(callback, delay) {
    return setTimeout(() => {
      console.error("FIXTURE_FORCE_EXIT");
      callback();
    }, delay);
  },
  shutdownTimeoutMs: 1000
});

host.server.once("listening", () => {
  console.log("FIXTURE_LISTENING");
  const request = http.request({
    host: "127.0.0.1",
    port: host.server.address().port,
    path: "/api/music/rescan",
    method: "POST",
    agent: false
  }, (response) => response.resume());
  request.on("error", (error) => console.error("FIXTURE_FETCH_ERROR", error?.message || error));
  request.end();
});

host.listen();

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("rescan did not dispatch");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function cleanupFixture() {
  const tempRoot = path.resolve(os.tmpdir());
  const target = path.resolve(fixtureDir);
  if (path.dirname(target) !== tempRoot || !path.basename(target).startsWith("fanhao-music-shutdown-")) {
    throw new Error("shutdown fixture cleanup refused an unexpected target");
  }
  fs.rmSync(target, { recursive: true, force: false });
}
