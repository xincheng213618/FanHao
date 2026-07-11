import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAccessLogger, shouldWriteAccessLog } from "../src/platform/server/access-log.js";

assert.equal(shouldWriteAccessLog({ path: "/api/health", status: 200, ms: 2 }), true);
assert.equal(shouldWriteAccessLog({ path: "/vendor/plyr/plyr.svg", status: 200, ms: 3 }), false);
assert.equal(shouldWriteAccessLog({ path: "/media/music/abc", status: 206, ms: 20 }), false);
assert.equal(shouldWriteAccessLog({ path: "/media/video/abc", status: 206, ms: 20 }), true);
assert.equal(shouldWriteAccessLog({ path: "/public/app.js", status: 200, ms: 3 }), true);
assert.equal(shouldWriteAccessLog({ path: "/api/music/tracks?q=test", status: 200, ms: 20 }), true);
assert.equal(shouldWriteAccessLog({ path: "/media/music/missing", status: 404, ms: 20 }), true);
assert.equal(shouldWriteAccessLog({ path: "/media/music/slow", status: 206, ms: 6_000 }), true);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-access-log-"));
const accessLogPath = path.join(tempDir, "access.log");
const attach = createAccessLogger({ accessLogPath, maxBytes: 700, maxQueueBytes: 4096 });
const authState = {
  access: { host: "localhost", clientAddress: "127.0.0.1", mode: "local" },
  reason: "test"
};

function finishRequest(requestPath, status = 200) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.getHeader = () => "";
  attach(
    { method: "GET", headers: {} },
    res,
    new URL(requestPath, "http://localhost"),
    authState,
    Date.now()
  );
  res.emit("finish");
}

finishRequest("/vendor/plyr/plyr.svg");
for (let index = 0; index < 12; index += 1) finishRequest(`/api/music/tracks?q=${index}`);
await new Promise((resolve) => setTimeout(resolve, 150));

assert.equal(fs.existsSync(accessLogPath), true);
assert.equal(fs.existsSync(`${accessLogPath}.1`), true);
assert.equal(fs.readFileSync(accessLogPath, "utf8").includes("plyr.svg"), false);
assert.ok(fs.statSync(accessLogPath).size <= 700);
assert.ok(fs.statSync(`${accessLogPath}.1`).size <= 900);

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("access log verification passed");
