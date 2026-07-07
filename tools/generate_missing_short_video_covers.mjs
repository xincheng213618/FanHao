#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createShortVideoStore } from "../src/server/short-video-store.js";
import { parseShortVideoRoots } from "../src/server/root-config.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "data", "short-videos.sqlite");

const options = parseArgs(process.argv.slice(2));
const dbPath = path.resolve(options.db || DEFAULT_DB_PATH);
const ffmpegPath = options.ffmpeg || process.env.FFMPEG_PATH || "ffmpeg";
const write = Boolean(options.write);
const limit = options.limit === "0" ? 0 : positiveInteger(options.limit) || (write ? 50 : 20);
const sampleLimit = positiveInteger(options.sample) ?? 10;
const concurrency = positiveInteger(options.concurrency) || 2;

const store = createShortVideoStore({
  dbPath,
  ffmpegPath,
  roots: parseShortVideoRoots()
});

try {
  if (!write) {
    const status = store.coverBackfillStatus(sampleLimit);
    console.log(`short-video-db: ${status.dbPath}`);
    console.log("mode: dry-run");
    console.log(`missing covers: ${status.missing}`);
    console.log(`sample: ${status.sample.length}`);
    for (const item of status.sample) {
      console.log(`  - ${item.id} ${item.title || item.sourcePath}`);
    }
    console.log("\nAdd --write to generate ffmpeg covers. Use --limit 0 to process all missing covers.");
  } else {
    const result = await store.backfillMissingCoversAsync({ limit, concurrency });
    console.log(`short-video-db: ${result.dbPath}`);
    console.log("mode: write");
    console.log(`limit: ${limit === 0 ? "all" : limit}`);
    console.log(`concurrency: ${result.concurrency}`);
    console.log(`before missing: ${result.beforeMissing}`);
    console.log(`selected: ${result.selected}`);
    console.log(`generated: ${result.generated}`);
    console.log(`skipped: ${result.skipped}`);
    console.log(`after missing: ${result.afterMissing}`);
  }
} finally {
  store.close();
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "write") {
      result[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      result[key] = "";
      continue;
    }
    result[key] = value;
    index += 1;
  }
  return result;
}

function positiveInteger(value) {
  if (value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}
