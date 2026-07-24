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
let transcodeConcurrency = 2;

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
    readJsonBody: async (req) => req?.body || {},
    requireLocalAdmin: () => true,
    sendJson(res, status, data) {
      res.status = status;
      res.data = data;
    },
    getTranscodeConcurrency: () => transcodeConcurrency,
    setTranscodeConcurrency: (value) => {
      transcodeConcurrency = value;
      return transcodeConcurrency;
    },
    sharedCache: {
      rootDir: cacheRoot,
      scheduleCleanup() {},
      touch() {}
    }
  });
  // Production keeps the multi-gigabyte catalog lazy; this isolated fixture
  // initializes its empty schema explicitly before inserting test rows.
  runtime.store.warm();

  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.mkdirSync(renditionDir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  const insert = db.prepare(`
    INSERT INTO short_videos (
      id, aweme_id, visibility, media_type, title, source_path, metadata_json,
      digg_count, liked_at, mtime_ms, size_bytes, actual_width, actual_height,
      actual_codec, actual_frame_rate, actual_pixels, actual_long_edge
    ) VALUES (?, ?, 'local_only', 'video', ?, ?, '{}', ?, ?, ?, 4096, 1080, 2160, 'hevc', 60, 2332800, 2160)
  `);
  const reportIssue = db.prepare(`
    INSERT INTO short_video_playback_issues (
      video_id, reason, occurrences, first_reported_at, last_reported_at, active
    ) VALUES (?, 'first-frame-timeout', 1, ?, ?, 1)
  `);
  db.exec("BEGIN");
  for (let index = 0; index < 530; index += 1) {
    const id = `runtime-page-${String(index).padStart(4, "0")}`;
    const sourcePath = path.join(sourceRoot, `${id}.mp4`);
    const mtimeMs = 1000 + index;
    const reportedAt = `2026-07-15T00:00:${String(index % 60).padStart(2, "0")}.000Z`;
    insert.run(id, id, id, sourcePath, 1_000_000 - index, `2026-07-15T00:00:${String(index % 60).padStart(2, "0")}.000Z`, mtimeMs);
    reportIssue.run(id, reportedAt, reportedAt);
    if (index >= 512) continue;
    const version = crypto.createHash("sha1")
      .update(`${sourcePath}:4096:${mtimeMs}:h264:30:2560:v2`)
      .digest("hex")
      .slice(0, 18);
    fs.writeFileSync(path.join(renditionDir, `${id}-${version}-2k30-h264.mp4`), "cached rendition");
  }
  db.exec("COMMIT");
  db.close();

  await runtime.start();
  await new Promise((resolve) => setTimeout(resolve, 1900));
  const response = {};
  await runtime.routeApi(
    { method: "GET" },
    response,
    new URL("http://127.0.0.1/api/short-videos/playback-cache-status")
  );
  const smooth = response.data?.smooth || {};
  assert.equal(response.status, 200);
  assert.equal(smooth.warmupCandidates, 530, "observed playback issue total must include rows beyond the in-memory backlog limit");
  assert.equal(smooth.scanOffset, 530, "candidate scan must page past the first 512 rows");
  assert.equal(smooth.scanComplete, true, "candidate scan must terminate after the final page");
  assert.equal(smooth.resolved, 512, "already resolved rows must make room for later pages without creating jobs");
  assert.equal(smooth.cacheIndexEntries, 512, "warmup must discover resolved rendition markers with one directory index");
  assert.ok(smooth.warmupDurationMs < 500, `indexed warmup must stay below 500ms, got ${smooth.warmupDurationMs}ms`);
  assert.equal(smooth.jobs, 3, "only the bounded active job quota may be materialized");
  assert.equal(smooth.backlog, 15, "all remaining rows after the first three jobs must stay in the bounded backlog");
  assert.equal(smooth.pipeline?.encoder, "libx264", "diagnostics must report the configured CPU encoder when NVENC is unavailable");
  assert.equal(smooth.pipeline?.concurrency, 2, "diagnostics must report the configured FFmpeg process concurrency");
  assert.equal(smooth.pipeline?.schedulingPolicy, "continuous", "playback must not pause or delay the FFmpeg queue");
  assert.equal(smooth.queue?.length, 3, "diagnostics must expose the bounded set of materialized jobs");
  assert.match(smooth.queue?.[0]?.title || "", /^runtime-page-/, "queued diagnostics must include catalog-backed display names");
  assert.match(smooth.queue?.[0]?.source?.path || "", /runtime-page-\d+\.mp4$/, "queued diagnostics must expose the exact source file path");
  const concurrencyResponse = {};
  await runtime.routeApi(
    { method: "POST", body: { action: "set-concurrency", concurrency: 3 } },
    concurrencyResponse,
    new URL("http://127.0.0.1/api/short-videos/playback-cache-control")
  );
  assert.equal(concurrencyResponse.status, 200, "local admin must be able to configure FFmpeg concurrency");
  assert.equal(concurrencyResponse.data?.status?.smooth?.concurrency, 3);
  const pauseResponse = {};
  await runtime.routeApi(
    { method: "POST", body: { action: "pause" } },
    pauseResponse,
    new URL("http://127.0.0.1/api/short-videos/playback-cache-control")
  );
  assert.equal(pauseResponse.status, 200, "local admin must be able to pause smooth transcoding");
  assert.equal(pauseResponse.data?.status?.smooth?.pausedByUser, true);
  const resumeResponse = {};
  await runtime.routeApi(
    { method: "POST", body: { action: "resume" } },
    resumeResponse,
    new URL("http://127.0.0.1/api/short-videos/playback-cache-control")
  );
  assert.equal(resumeResponse.status, 200, "local admin must be able to resume smooth transcoding");
  assert.equal(resumeResponse.data?.status?.smooth?.pausedByUser, false);
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

  const lockDb = new DatabaseSync(dbPath);
  lockDb.exec("BEGIN IMMEDIATE");
  const watchResponse = {};
  const watchRequest = runtime.routeApi(
    { method: "PUT", body: { progressMs: 1250 } },
    watchResponse,
    new URL("http://127.0.0.1/api/short-videos/runtime-page-0000/watch")
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  const healthResponse = {};
  const healthStartedAt = performance.now();
  await runtime.routeApi(
    { method: "GET" },
    healthResponse,
    new URL("http://127.0.0.1/api/short-videos/playback-cache-status")
  );
  const healthDurationMs = performance.now() - healthStartedAt;
  assert.equal(healthResponse.status, 200, "media-adjacent status requests must keep running while a watch write is locked");
  assert.ok(healthDurationMs < 100, `watch SQLite lock must not block the HTTP event loop, got ${healthDurationMs.toFixed(1)}ms`);
  assert.equal(watchResponse.status, undefined, "the locked watch write must still be pending in its worker");
  lockDb.exec("ROLLBACK");
  lockDb.close();
  await watchRequest;
  assert.equal(watchResponse.status, 200, "watch write must complete after the SQLite lock is released");
  assert.equal(watchResponse.data?.watch?.progressMs, 1250);

  const verifyDb = new DatabaseSync(dbPath, { readOnly: true });
  const savedWatch = verifyDb.prepare(`
    SELECT progress_ms
    FROM short_video_watch_history
    WHERE local_user_id = 'local:self' AND video_id = 'runtime-page-0000'
  `).get();
  verifyDb.close();
  assert.equal(savedWatch?.progress_ms, 1250, "worker writes must remain linked to the existing short-video database");
  console.log(`short-video-runtime-queue: ok (530 observed playback issues; locked watch write kept HTTP responsive at ${healthDurationMs.toFixed(1)}ms)`);
} finally {
  await runtime?.stop();
  runtime?.store?.close();
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
