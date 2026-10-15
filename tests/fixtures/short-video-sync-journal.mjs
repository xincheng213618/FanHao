import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export function installFixtureSyncJournal(dbPath) {
  const resolved = path.resolve(dbPath), relative = path.relative(os.tmpdir(), resolved);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "journal fixture must use a temporary database");
  const modulePath = fileURLToPath(new URL("../../src/modules/short-videos/download-manager/manager_core/library_sync.py", import.meta.url));
  const bundledPython = fileURLToPath(new URL("../../src/modules/short-videos/download-manager/downloader/.venv/Scripts/python.exe", import.meta.url));
  const python = fs.existsSync(bundledPython) ? bundledPython : process.env.PYTHON || "python";
  const result = spawnSync(python, ["-B", "-c", `
import runpy, sqlite3, sys
module = runpy.run_path(sys.argv[1])
with sqlite3.connect(sys.argv[2]) as db:
    module['migrate_library_sync'](db)
`, modulePath, resolved], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.error?.message || `${result.stdout}\n${result.stderr}`);
}
