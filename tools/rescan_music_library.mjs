#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMusicStore } from "../src/modules/music/server/store.js";
import { parseMusicRoots } from "../src/platform/server/root-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEFAULT_DB_PATH = path.join(PROJECT_ROOT, "data", "music.sqlite");

function parseArgs(argv) {
  const args = {
    roots: [],
    dbPath: DEFAULT_DB_PATH,
    dryRun: false,
    limit: 0,
    ffprobePath: process.env.FFPROBE_PATH || "ffprobe"
  };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--root") {
      args.roots.push(argv[++index] || "");
    } else if (item === "--db") {
      args.dbPath = argv[++index] || args.dbPath;
    } else if (item === "--limit") {
      args.limit = Number(argv[++index] || 0) || 0;
    } else if (item === "--ffprobe") {
      args.ffprobePath = argv[++index] || args.ffprobePath;
    } else if (item === "--dry-run") {
      args.dryRun = true;
    } else if (item === "-h" || item === "--help") {
      args.help = true;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node tools/rescan_music_library.mjs [--root DIR] [--db data/music.sqlite] [--limit N] [--dry-run]

Scans local audio files into FanHao's standalone music.sqlite database.
Audio sidecars supported: album images, album intro .txt, same-name .lrc lyrics.`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  const roots = args.roots.length ? args.roots : parseMusicRoots();
  const store = createMusicStore({
    dbPath: path.resolve(args.dbPath),
    ffprobePath: args.ffprobePath,
    roots
  });
  try {
    const result = store.scan({ roots, limit: args.limit, dryRun: args.dryRun });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } finally {
    store.invalidate();
  }
}

process.exitCode = main();
