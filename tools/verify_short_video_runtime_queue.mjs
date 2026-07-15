import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createShortVideosRuntime } from "../src/modules/short-videos/server/runtime.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-runtime-"));
const dbPath = path.join(tempDir, "short-videos.sqlite");
const cacheRoot = path.join(tempDir, "cache");
const sourceRoot = path.join(tempDir, "videos");
const renditionDir = path.join(cacheRoot, "short-videos", "renditions");
let runtime;

try {
  runtime = createShortVideosRuntime({
    dbPath,
    downloadManagerDbPath: "",
    downloadManagerSyncMs: 0,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    hasNvenc: false,
    roots: [],
    mediaResponseService: { serveImage() {} },
    mediaStreamService: { serveVideo() {} },
    notFound() {},
    readJsonBody: async () => ({}),
    requireLocalAdmin: () => true,
    sendJson(res, status, data) {
      res.status = status;
      res.data = data;
    },
    sharedCache: {
      rootDir: cacheRoot,
      scheduleCleanup() {},
      touch() {}
    }
  });

  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(renditionDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  const insert = db.prepare(`
    INSERT INTO short_videos (
      id, aweme_id, visibility, media_type, title, source_path, metadata_json,
      digg_count, liked_at, mtime_ms, size_bytes, actual_width, actual_height,
      actual_codec, actual_frame_rate, actual_pixels, actual_long_edge
    ) VALUES (?, ?, 'local_only', 'video', ?, ?, '{}', ?, ?, ?, 4096, 1080, 2160, 'h264', 30, 2332800, 2160)
  `);
  db.exec("BEGIN");
  for (let index = 0; index < 530; index += 1) {
    const id = `runtime-page-${String(index).padStart(4, "0")}`;
    const sourcePath = path.join(sourceRoot, `${id}.mp4`);
    const mtimeMs = 1000 + index;
    insert.run(id, id, id, sourcePath, 1_000_000 - index, `2026-07-15T00:00:${String(index % 60).padStart(2, "0")}.000Z`, mtimeMs);
    if (index >= 512) continue;
    const version = crypto.createHash("sha1")
      .update(`${sourcePath}:4096:${mtimeMs}:h264:30:2560:v2`)
      .digest("hex")
      .slice(0, 18);
    fs.writeFileSync(path.join(renditionDir, `${id}-${version}-2k30-h264.mp4.source-ok`), "{}");
  }
  db.exec("COMMIT");
  db.close();

  runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 1900));
  const response = {};
  await runtime.routeApi(
    { method: "GET" },
    response,
    new URL("http://127.0.0.1/api/short-videos/playback-cache-status")
  );
  const smooth = response.data?.smooth || {};
  assert.equal(response.status, 200);
  assert.equal(smooth.warmupCandidates, 530, "candidate total must include rows beyond the in-memory backlog limit");
  assert.equal(smooth.scanOffset, 530, "candidate scan must page past the first 512 rows");
  assert.equal(smooth.scanComplete, true, "candidate scan must terminate after the final page");
  assert.equal(smooth.resolved, 512, "already resolved rows must make room for later pages without creating jobs");
  assert.equal(smooth.cacheIndexEntries, 512, "warmup must discover resolved rendition markers with one directory index");
  assert.ok(smooth.warmupDurationMs < 500, `indexed warmup must stay below 500ms, got ${smooth.warmupDurationMs}ms`);
  assert.equal(smooth.jobs, 3, "only the bounded active job quota may be materialized");
  assert.equal(smooth.backlog, 15, "all remaining rows after the first three jobs must stay in the bounded backlog");
  const authorsResponse = {};
  await runtime.routeApi(
    { method: "GET" },
    authorsResponse,
    new URL("http://127.0.0.1/api/short-videos/authors?q=missing&limit=10")
  );
  assert.equal(authorsResponse.status, 200, "author reads must be served by the prewarmed catalog worker");
  assert.equal(authorsResponse.data?.total, 0);
  const facetsResponse = {};
  await runtime.routeApi(
    { method: "GET" },
    facetsResponse,
    new URL("http://127.0.0.1/api/short-videos/facets")
  );
  assert.equal(facetsResponse.status, 200, "facet reads must share the prewarmed catalog worker");
  assert.equal(facetsResponse.data?.summary?.totals?.videos, 530);
  console.log("short-video-runtime-queue: ok (530 candidates paged through a 512-row backlog)");
} finally {
  runtime?.stop();
  runtime?.store?.close();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
