import fs from "node:fs";
import path from "node:path";

import { createShortVideoStore } from "../../src/modules/short-videos/server/store.js";

const [dbPath, root, readyPath, startPath, attemptingPath, resultPath] = process.argv.slice(2);
if (!dbPath || !root || !readyPath || !startPath || !attemptingPath || !resultPath) {
  throw new Error("usage: short_video_delete_queued_writer_child.mjs <db> <root> <ready> <start> <attempting> <result>");
}

const waitState = new Int32Array(new SharedArrayBuffer(4));
const store = createShortVideoStore({
  dbPath,
  roots: [root],
  coverCacheDir: path.join(path.dirname(dbPath), "queued-writer-covers"),
  busyTimeoutMs: 10_000,
  skipStartupMaintenance: true,
  deleteJobWarn() {},
  pathWriteTestHooks: {
    beforeWriterLock({ kind }) {
      if (kind !== "scan") return;
      fs.writeFileSync(readyPath, "ready", { flag: "wx" });
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(startPath)) {
        if (Date.now() >= deadline) throw new Error("timed out waiting for cleanup start");
        Atomics.wait(waitState, 0, 0, 10);
      }
      fs.writeFileSync(attemptingPath, "attempting", { flag: "wx" });
    }
  }
});
try {
  let result;
  try {
    result = { ok: true, error: "", scan: store.scan(root) };
  } catch (error) {
    result = { ok: false, error: String(error?.message || error), code: String(error?.code || "") };
  }
  fs.writeFileSync(resultPath, JSON.stringify(result), { encoding: "utf8", flag: "wx" });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  store.close();
}
