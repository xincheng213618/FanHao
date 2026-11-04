import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

assert(process.argv.slice(2).every(value => ["--legacy-queue-order", "--measure-queue-order", "--legacy-queue-removal", "--legacy-queue-removal-tail", "--measure-queue-removal"].includes(value)));
const result = spawnSync(process.execPath, [fileURLToPath(new URL("./verify_android_music_list_rendering.mjs", import.meta.url)),
  "--queue-order", ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
