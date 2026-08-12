import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { syncDownloadManagerSourceMemberships } from "../src/modules/short-videos/server/download-manager-metadata-sync.js";
import { createShortVideosRuntime } from "../src/modules/short-videos/server/runtime.js";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";

const LEGACY_SCHEMA_VERSION = "20260812-short-video-collections-11";
const TARGET_ID = "action-contract-target";
const TARGET_AWEME_ID = "7600000000000000001";
const ANCHOR_ID = "action-contract-anchor";
const PLAIN_ID = "action-contract-plain";
const CANONICAL_ID = "7600000000000000003";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-actions-"));
const dbPath = path.join(fixtureRoot, "short-videos.sqlite");
const managerDbPath = path.join(fixtureRoot, "download-manager.sqlite");
const cacheRoot = path.join(fixtureRoot, "cache");
let runtime = null;

try {
  createLegacyFixture();
  assert.equal(hasCatalogColumn(dbPath, "library_liked"), false, "the fixture must start with the legacy catalog view");

  runtime = createFixtureRuntime();
  assert.equal(
    runtime.catalogWorkerDiagnostics().workerStarts,
    0,
    "runtime construction must not start the read-only catalog worker"
  );
  assert.equal(
    hasCatalogColumn(dbPath, "library_liked"),
    true,
    "runtime construction must complete the versioned writable view migration before worker reads"
  );
  assert.notEqual(
    readMeta(dbPath, "schema_version"),
    LEGACY_SCHEMA_VERSION,
    "the writable preflight must advance the schema version"
  );

  await verifyPublicReadSurfaces();
  await verifyActionStatistics();
  await verifyMetadataSyncPreservesExplicitFalse();
  await verifyDownloadImportPreservesExplicitFalse();

  console.log("short-video-action-contract: ok (legacy migration, read parity, idempotent stats, downloader ownership)");
} finally {
  await runtime?.stop();
  runtime?.store?.close();
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function createLegacyFixture() {
  const bootstrap = createShortVideoStore({
    dbPath,
    roots: [],
    skipStartupMaintenance: false
  });
  try {
    bootstrap.summary();
  } finally {
    bootstrap.close();
  }

  const db = new DatabaseSync(dbPath);
  try {
    const insertVideo = db.prepare(`
      INSERT INTO short_videos (
        id, aweme_id, owner_user_id, origin, status, visibility, media_type,
        author_sec_uid, author_name, title, description, tags_json, tags_text,
        published_at, liked_at, digg_count, comment_count, collect_count,
        share_count, play_count, source_path, file_name, metadata_json, mtime_ms,
        updated_at
      ) VALUES (
        ?, ?, ?, 'fixture', 'normal', 'local_only', 'video', ?, ?, ?, ?,
        '["shared-contract"]', 'shared-contract', ?, ?, ?, 7, ?, 3, 1000,
        ?, ?, '{}', 1, ?
      )
    `);
    const now = "2026-08-12T12:00:00.000Z";
    insertVideo.run(
      ANCHOR_ID,
      "7600000000000000000",
      "author-anchor",
      "sec-anchor",
      "契约作者甲",
      "动作契约锚点",
      "相邻与相关入口",
      "2026-08-13T12:00:00.000Z",
      "2026-08-13T12:00:00.000Z",
      300,
      30,
      path.join(fixtureRoot, `${ANCHOR_ID}.mp4`),
      `${ANCHOR_ID}.mp4`,
      now
    );
    insertVideo.run(
      TARGET_ID,
      TARGET_AWEME_ID,
      "author-target",
      "sec-target",
      "契约作者乙",
      "动作契约目标",
      "服务器权威动作状态",
      "2026-08-12T12:00:00.000Z",
      "2026-08-12T12:00:00.000Z",
      100,
      10,
      path.join(fixtureRoot, `${TARGET_ID}.mp4`),
      `${TARGET_ID}.mp4`,
      now
    );
    insertVideo.run(
      PLAIN_ID,
      "7600000000000000002",
      "author-plain",
      "sec-plain",
      "契约作者丙",
      "动作来源基线",
      "无下载来源喜欢关系",
      "2026-08-11T12:00:00.000Z",
      "2026-08-11T12:00:00.000Z",
      200,
      20,
      path.join(fixtureRoot, `${PLAIN_ID}.mp4`),
      `${PLAIN_ID}.mp4`,
      now
    );
    insertVideo.run(
      CANONICAL_ID,
      CANONICAL_ID,
      "author-canonical",
      "sec-canonical",
      "契约作者丁",
      "同 ID 动作所有权",
      "验证标准化写入不能覆盖本地意图",
      "2026-08-10T12:00:00.000Z",
      "2026-08-10T12:00:00.000Z",
      400,
      40,
      path.join(fixtureRoot, `${CANONICAL_ID}.mp4`),
      `${CANONICAL_ID}.mp4`,
      now
    );
    db.prepare(`
      INSERT INTO short_video_source_memberships (
        aweme_id, source_type, source_profile_id, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, 'like', 'legacy-fixture', ?, ?, ?)
    `).run(TARGET_AWEME_ID, now, now, now);
    writeAction(db, TARGET_ID, "like", true, "local_web");
    fs.writeFileSync(path.join(fixtureRoot, `${TARGET_ID}.mp4`), Buffer.from("action-contract-video"));
    fs.writeFileSync(path.join(fixtureRoot, `${CANONICAL_ID}.mp4`), Buffer.from("canonical-action-contract-video"));
    downgradeCatalogView(db);
  } finally {
    db.close();
  }
}

function downgradeCatalogView(db) {
  const baseSql = String(db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'short_video_catalog_base'
  `).get()?.sql || "");
  const catalogSql = String(db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'short_video_catalog'
  `).get()?.sql || "");
  assert(baseSql.includes("library_liked"), "current fixture schema must contain library_liked before downgrade");
  assert(catalogSql, "current fixture schema must contain the public catalog view");

  const libraryColumn = /\s*CASE WHEN EXISTS \(\s*SELECT 1\s*FROM short_video_source_memberships liked_membership\s*WHERE liked_membership\.aweme_id = v\.aweme_id\s*AND liked_membership\.source_type = 'like'\s*\) THEN 1 ELSE 0 END AS library_liked,\s*/u;
  const legacyBaseSql = baseSql.replace(libraryColumn, "");
  assert.notEqual(legacyBaseSql, baseSql, "legacy fixture downgrade must remove the library_liked expression");
  assert.equal(legacyBaseSql.includes("library_liked"), false);

  db.exec("DROP VIEW short_video_catalog; DROP VIEW short_video_catalog_base;");
  db.exec(legacyBaseSql);
  db.exec(catalogSql);
  db.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('schema_version', ?)")
    .run(LEGACY_SCHEMA_VERSION);
}

function createFixtureRuntime() {
  return createShortVideosRuntime({
    dbPath,
    downloadManagerDbPath: "",
    downloadManagerSyncMs: 0,
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    roots: [],
    mediaResponseService: { serveImage() {} },
    mediaStreamService: { serveVideo() {} },
    notFound(res) {
      res.status = 404;
      res.data = { error: "not found" };
    },
    readJsonBody: async (req) => req?.body || {},
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
}

async function verifyPublicReadSurfaces() {
  const list = await request("GET", "/api/short-videos?source=all&sort=published&stats=0&facets=0&limit=20");
  assert.equal(list.status, 200);
  assertLibraryLiked(findVideo(list.data?.videos, TARGET_ID), "standard list fast path");

  const detail = await request("GET", `/api/short-videos/videos/${TARGET_ID}?metadata=0&neighbors=1&source=all&sort=published`);
  assert.equal(detail.status, 200);
  assertLibraryLiked(detail.data?.video, "detail path");

  const anchorDetail = await request("GET", `/api/short-videos/videos/${ANCHOR_ID}?metadata=0&neighbors=1&source=all&sort=published`);
  assert.equal(anchorDetail.status, 200);
  assertLibraryLiked(findVideo(anchorDetail.data?.neighbors?.next, TARGET_ID), "detail neighbor fast path");

  const recommended = await request("GET", "/api/short-videos?source=recommended&stats=0&facets=0&limit=20");
  assert.equal(recommended.status, 200, "the first real worker read must succeed after runtime migration");
  assert.equal(runtime.catalogWorkerDiagnostics().workerStarts, 1, "recommended list must exercise the real read-only catalog worker");
  assertLibraryLiked(findVideo(recommended.data?.videos, TARGET_ID), "recommended worker list");

  const adjacent = await request(
    "GET",
    `/api/short-videos/${ANCHOR_ID}/adjacent?direction=next&source=all&sort=published`
  );
  assert.equal(adjacent.status, 200);
  assert.equal(adjacent.data?.video?.id, TARGET_ID, "published adjacent route must select the target fixture");
  assertLibraryLiked(adjacent.data?.video, "adjacent fast path");

  const related = await request("GET", `/api/short-videos/${ANCHOR_ID}/related?limit=10`);
  assert.equal(related.status, 200);
  assertLibraryLiked(findVideo(related.data?.videos, TARGET_ID), "related hydration path");
}

async function verifyActionStatistics() {
  await setStoredAction(PLAIN_ID, "like", true, "imported");
  await assertActionState(PLAIN_ID, "liked", true, "likes", 200, "imported active like is already in the public baseline");
  await setStoredAction(PLAIN_ID, "like", false, "imported");
  await assertActionState(PLAIN_ID, "liked", false, "likes", 199, "imported inactive like removes the baseline contribution");

  await setStoredAction(PLAIN_ID, "like", true, "download_manager");
  await assertActionState(PLAIN_ID, "liked", true, "likes", 200, "download-manager active like is already in the public baseline");
  await setStoredAction(PLAIN_ID, "like", false, "download_manager");
  await assertActionState(PLAIN_ID, "liked", false, "likes", 199, "download-manager inactive like removes the baseline contribution");

  await setStoredAction(PLAIN_ID, "like", true, "local_web");
  await assertActionState(PLAIN_ID, "liked", true, "likes", 201, "local-web like adds to a non-library video");
  await setStoredAction(PLAIN_ID, "like", false, "local_web");
  await assertActionState(PLAIN_ID, "liked", false, "likes", 200, "local-web false leaves a non-library baseline unchanged");

  await setStoredAction(TARGET_ID, "like", true, "local_web");
  await assertActionState(TARGET_ID, "liked", true, "likes", 100, "library membership is the active like baseline");
  await assertPutAction(TARGET_ID, "like", true, "liked", "likes", 100);
  await assertPutAction(TARGET_ID, "like", true, "liked", "likes", 100);
  await assertPutAction(TARGET_ID, "like", false, "liked", "likes", 99);
  await assertPutAction(TARGET_ID, "like", false, "liked", "likes", 99);

  await assertPutAction(TARGET_ID, "collect", true, "collected", "collects", 11);
  await assertPutAction(TARGET_ID, "collect", true, "collected", "collects", 11);
  await assertPutAction(TARGET_ID, "collect", false, "collected", "collects", 10);
  await assertPutAction(TARGET_ID, "collect", false, "collected", "collects", 10);
}

async function verifyMetadataSyncPreservesExplicitFalse() {
  await assertPutAction(TARGET_ID, "like", false, "liked", "likes", 99);
  createManagerMembershipFixture();
  const targetDb = new DatabaseSync(dbPath);
  const managerDb = new DatabaseSync(managerDbPath, { readOnly: true });
  try {
    const result = syncDownloadManagerSourceMemberships(
      targetDb,
      managerDb,
      "2026-08-12T13:00:00.000Z"
    );
    assert.equal(result.membershipsSeen, 2);
    const action = targetDb.prepare(`
      SELECT active, source
      FROM short_video_user_actions
      WHERE local_user_id = 'local:self' AND video_id = ? AND action_type = 'like'
    `).get(TARGET_ID);
    assert.equal(Boolean(action?.active), false, "metadata sync must not overwrite an explicit local_web false intent");
    assert.equal(action?.source, "local_web", "metadata sync must retain the local action ownership marker");
  } finally {
    managerDb.close();
    targetDb.close();
  }
  runtime.clearListCache();
  await assertActionState(
    TARGET_ID,
    "liked",
    false,
    "likes",
    99,
    "metadata sync must preserve the explicit false action and its effective count"
  );
  await assertPutAction(TARGET_ID, "like", true, "liked", "likes", 100);
  await assertPutAction(TARGET_ID, "like", true, "liked", "likes", 100);
}

function createManagerMembershipFixture() {
  const db = new DatabaseSync(managerDbPath);
  try {
    db.exec(`
      CREATE TABLE profiles (
        id INTEGER PRIMARY KEY,
        tab TEXT NOT NULL,
        sec_uid TEXT,
        url TEXT,
        nickname TEXT,
        updated_at TEXT
      );
      CREATE TABLE links (
        id INTEGER PRIMARY KEY,
        profile_id INTEGER NOT NULL,
        aweme_id TEXT NOT NULL,
        status TEXT,
        kind TEXT,
        media_type TEXT,
        output_dir TEXT,
        local_file_paths TEXT,
        duration_ms INTEGER,
        downloaded_at TEXT NOT NULL DEFAULT '',
        last_seen_at TEXT,
        digg_count INTEGER,
        comment_count INTEGER,
        collect_count INTEGER,
        share_count INTEGER
      );
      INSERT INTO profiles (id, tab, sec_uid, url, nickname, updated_at)
      VALUES (1, 'like', 'action-contract-author', '', '动作契约作者', '2026-08-12T12:30:00.000Z');
    `);
    const insertLink = db.prepare(`
      INSERT INTO links (
        id, profile_id, aweme_id, status, kind, media_type, output_dir,
        local_file_paths, duration_ms, downloaded_at, last_seen_at,
        digg_count, comment_count, collect_count, share_count
      ) VALUES (
        ?, 1, ?, 'downloaded', 'video', 'video', ?, ?, 1000,
        '2026-08-12T12:30:00.000Z', '2026-08-12T12:30:00.000Z',
        ?, 7, ?, 3
      )
    `);
    insertLink.run(
      1,
      TARGET_AWEME_ID,
      fixtureRoot,
      JSON.stringify([path.join(fixtureRoot, `${TARGET_ID}.mp4`)]),
      100,
      10
    );
    insertLink.run(
      2,
      CANONICAL_ID,
      fixtureRoot,
      JSON.stringify([path.join(fixtureRoot, `${CANONICAL_ID}.mp4`)]),
      400,
      40
    );
  } finally {
    db.close();
  }
}

async function verifyDownloadImportPreservesExplicitFalse() {
  assertStoredAction(
    CANONICAL_ID,
    true,
    "download_manager",
    "metadata sync must establish the canonical downloader-owned starting state"
  );
  await assertPutAction(CANONICAL_ID, "like", false, "liked", "likes", 399);
  assertStoredAction(
    CANONICAL_ID,
    false,
    "local_web",
    "an explicit PUT must transfer the canonical action to local ownership"
  );
  await assertPutAction(TARGET_ID, "like", false, "liked", "likes", 99);
  const first = runtime.store.importDownloadManagerDb(managerDbPath, {
    includePosts: true,
    skipSummary: true
  });
  assert.equal(first.ok, true, "the real downloader import must complete");
  assertImportedLocalAction();
  assertStoredAction(
    CANONICAL_ID,
    false,
    "local_web",
    "same-ID normalized upsert must not reactivate an explicit local intent"
  );

  const repeated = runtime.store.importDownloadManagerDb(managerDbPath, {
    includePosts: true,
    skipSummary: true
  });
  assert.equal(repeated.ok, true, "a repeated real downloader import must complete");
  assertImportedLocalAction();
  assertStoredAction(
    CANONICAL_ID,
    false,
    "local_web",
    "repeated same-ID normalized upsert must retain local ownership"
  );
  runtime.clearListCache();
  await assertActionState(
    CANONICAL_ID,
    "liked",
    false,
    "likes",
    399,
    "same-ID downloader upserts must preserve the explicit false action and its effective count"
  );
  await assertActionState(
    TARGET_AWEME_ID,
    "liked",
    false,
    "likes",
    99,
    "real downloader upsert and duplicate merge must preserve local_web=false"
  );
}

function assertImportedLocalAction() {
  assertStoredAction(
    TARGET_AWEME_ID,
    false,
    "local_web",
    "alias duplicate merge must retain the explicit local action"
  );
}

function assertStoredAction(videoId, active, source, message) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const action = db.prepare(`
      SELECT active, source
      FROM short_video_user_actions
      WHERE local_user_id = 'local:self' AND video_id = ? AND action_type = 'like'
    `).get(videoId);
    assert.equal(Boolean(action?.active), active, message);
    assert.equal(action?.source, source, message);
  } finally {
    db.close();
  }
}

async function assertPutAction(videoId, actionType, active, actionKey, metricKey, expectedMetric) {
  const response = await request(
    "PUT",
    `/api/short-videos/${encodeURIComponent(videoId)}/actions/${actionType}`,
    { active }
  );
  assert.equal(response.status, 200);
  assert.equal(response.data?.active, active, "the API response must echo the explicit active value");
  assert.equal(response.data?.video?.actions?.[actionKey], active);
  assert.equal(response.data?.video?.stats?.[metricKey], expectedMetric);
  await assertActionState(
    videoId,
    actionKey,
    active,
    metricKey,
    expectedMetric,
    `persisted ${actionType}=${active} must match the PUT response`
  );
}

async function assertActionState(videoId, actionKey, active, metricKey, expectedMetric, message) {
  const response = await request(
    "GET",
    `/api/short-videos/videos/${encodeURIComponent(videoId)}?metadata=0&neighbors=1&source=all`
  );
  assert.equal(response.status, 200);
  assert.equal(response.data?.video?.actions?.[actionKey], active, message);
  assert.equal(response.data?.video?.stats?.[metricKey], expectedMetric, message);
}

async function setStoredAction(videoId, actionType, active, source) {
  const db = new DatabaseSync(dbPath);
  try {
    writeAction(db, videoId, actionType, active, source);
  } finally {
    db.close();
  }
  runtime.clearListCache();
}

function writeAction(db, videoId, actionType, active, source) {
  const now = "2026-08-12T12:00:00.000Z";
  db.prepare(`
    INSERT INTO short_video_user_actions (
      local_user_id, video_id, action_type, active, source, acted_at, updated_at
    ) VALUES ('local:self', ?, ?, ?, ?, ?, ?)
    ON CONFLICT(local_user_id, video_id, action_type) DO UPDATE SET
      active = excluded.active,
      source = excluded.source,
      acted_at = excluded.acted_at,
      updated_at = excluded.updated_at
  `).run(videoId, actionType, active ? 1 : 0, source, now, now);
}

async function request(method, pathname, body = null) {
  const response = {};
  const handled = await runtime.routeApi(
    { method, body },
    response,
    new URL(`http://fixture${pathname}`)
  );
  assert.equal(handled, true, `${method} ${pathname} must be handled by the real runtime`);
  return { status: response.status, data: response.data };
}

function findVideo(videos, id) {
  return Array.isArray(videos) ? videos.find((video) => video?.id === id) : null;
}

function assertLibraryLiked(video, surface) {
  assert(video, `${surface} must return ${TARGET_ID}`);
  assert.equal(video.libraryLiked, true, `${surface} must expose libraryLiked=true`);
}

function hasCatalogColumn(filePath, columnName) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return db.prepare("PRAGMA table_info(short_video_catalog)").all()
      .some((column) => column.name === columnName);
  } finally {
    db.close();
  }
}

function readMeta(filePath, key) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return String(db.prepare("SELECT value FROM short_video_meta WHERE key = ?").get(key)?.value || "");
  } finally {
    db.close();
  }
}
