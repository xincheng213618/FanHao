import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { syncDownloadManagerSourceMemberships } from "../src/modules/short-videos/server/download-manager-metadata-sync.js";
import { createShortVideosRuntime } from "../src/modules/short-videos/server/runtime.js";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";

const LEGACY_SCHEMA_VERSION = "20260812-short-video-collections-11";
const ACTIONS_12_SCHEMA_VERSION = "20260812-native-user-actions-12";
const CURRENT_SCHEMA_VERSION = "20260812-native-user-actions-13";
const TARGET_ID = "action-contract-target";
const TARGET_AWEME_ID = "7600000000000000001";
const ANCHOR_ID = "action-contract-anchor";
const PLAIN_ID = "action-contract-plain";
const CANONICAL_ID = "7600000000000000003";
const LEGACY_IMPORTED_ID = "action-contract-legacy-imported";
const LEGACY_IMPORTED_AWEME_ID = "7600000000000000004";
const CUSTOM_SOURCE_ID = "action-contract-custom-source";

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-actions-"));
const dbPath = path.join(fixtureRoot, "short-videos.sqlite");
const managerDbPath = path.join(fixtureRoot, "download-manager.sqlite");
const cacheRoot = path.join(fixtureRoot, "cache");
let runtime = null;
let listQueryHook = null;
const touchedListCachePaths = [];

try {
  createLegacyFixture();
  assert.equal(hasCatalogColumn(dbPath, "library_liked"), false, "the fixture must start with the legacy catalog view");
  assert.equal(hasActionColumn(dbPath, "baseline_active"), false, "the legacy fixture must predate the baseline column");

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
  assert.equal(
    readMeta(dbPath, "schema_version"),
    CURRENT_SCHEMA_VERSION,
    "the writable preflight must advance the schema version"
  );
  assert.equal(hasActionColumn(dbPath, "baseline_active"), true, "actions-13 must add the baseline column");

  await verifyLegacyFalseOwnershipMigration();
  await verifyPublicReadSurfaces();
  await verifyActionStatistics();
  await verifyListCacheAuthorityContract();
  await verifyMetadataSyncPreservesExplicitFalse();
  await verifyDownloadImportPreservesExplicitFalse();
  await verifyRecommendedRecoversAfterLockedPreflight();

  console.log("short-video-action-contract: ok (legacy migration, read parity, idempotent stats, downloader ownership)");
} finally {
  await runtime?.stop();
  runtime?.store?.close();
  fs.rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function createLegacyFixture() {
  const bootstrap = createShortVideoStore({
    dbPath,
    roots: [fixtureRoot],
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
    insertVideo.run(
      LEGACY_IMPORTED_ID,
      LEGACY_IMPORTED_AWEME_ID,
      "author-legacy-imported",
      "sec-legacy-imported",
      "契约作者戊",
      "旧版取消点赞所有权",
      "验证 actions-13 迁移不会被后台同步重新激活",
      "2026-08-09T12:00:00.000Z",
      "2026-08-09T12:00:00.000Z",
      500,
      50,
      path.join(fixtureRoot, `${LEGACY_IMPORTED_ID}.mp4`),
      `${LEGACY_IMPORTED_ID}.mp4`,
      now
    );
    db.prepare(`
      INSERT INTO short_video_source_memberships (
        aweme_id, source_type, source_profile_id, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, 'like', 'legacy-fixture', ?, ?, ?)
    `).run(TARGET_AWEME_ID, now, now, now);
    db.prepare(`
      INSERT INTO short_video_source_memberships (
        aweme_id, source_type, source_profile_id, first_seen_at, last_seen_at, updated_at
      ) VALUES (?, 'like', 'legacy-imported-fixture', ?, ?, ?)
    `).run(LEGACY_IMPORTED_AWEME_ID, now, now, now);
    writeAction(db, TARGET_ID, "like", false, "download_manager");
    writeAction(db, LEGACY_IMPORTED_ID, "like", false, "imported");
    writeAction(db, TARGET_ID, "collect", false, "download_manager");
    writeAction(db, ANCHOR_ID, "like", true, "imported");
    writeAction(db, PLAIN_ID, "like", false, "imported");
    writeAction(db, CUSTOM_SOURCE_ID, "like", false, "custom");
    db.prepare(`
      INSERT INTO short_video_user_actions (
        local_user_id, video_id, action_type, active, source, acted_at, updated_at
      ) VALUES ('local:other', ?, 'like', 0, 'download_manager', ?, ?)
    `).run(TARGET_ID, now, now);
    fs.writeFileSync(path.join(fixtureRoot, `${TARGET_ID}.mp4`), Buffer.from("action-contract-video"));
    fs.writeFileSync(path.join(fixtureRoot, `${CANONICAL_ID}.mp4`), Buffer.from("canonical-action-contract-video"));
    fs.writeFileSync(path.join(fixtureRoot, `${LEGACY_IMPORTED_ID}.mp4`), Buffer.from("legacy-imported-action-contract-video"));
    downgradeCatalogView(db);
  } finally {
    db.close();
  }
}

async function verifyLegacyFalseOwnershipMigration() {
  assertStoredAction(
    TARGET_ID,
    false,
    "local_web",
    "actions-13 migration must claim a legacy download-manager false like for the local user"
  );
  assertStoredAction(
    LEGACY_IMPORTED_ID,
    false,
    "local_web",
    "actions-13 migration must claim a legacy imported false like for the local user"
  );
  assertStoredActionType(
    TARGET_ID,
    "collect",
    false,
    "download_manager",
    "actions-13 migration must not rewrite collect ownership"
  );
  assertStoredActionType(
    ANCHOR_ID,
    "like",
    true,
    "imported",
    "actions-13 migration must not rewrite an active background like"
  );
  assertStoredAction(
    PLAIN_ID,
    false,
    "local_web",
    "actions-13 migration must preserve a legacy imported false as a local override"
  );
  assertStoredBaseline(
    PLAIN_ID,
    true,
    "actions-13 migration must retain the imported counting baseline independently of ownership"
  );
  assertStoredAction(
    CUSTOM_SOURCE_ID,
    false,
    "custom",
    "actions-13 migration must not rewrite an unrelated action source"
  );
  assertStoredActionForUser(
    "local:other",
    TARGET_ID,
    "like",
    false,
    "download_manager",
    "actions-13 migration must not rewrite another user's action"
  );

  await assertPutAction(PLAIN_ID, "like", true, "liked", "likes", 200);
  await assertPutAction(PLAIN_ID, "like", false, "liked", "likes", 199);
  createManagerMembershipFixture();
  const targetDb = new DatabaseSync(dbPath);
  const managerDb = new DatabaseSync(managerDbPath, { readOnly: true });
  try {
    syncDownloadManagerSourceMemberships(targetDb, managerDb, "2026-08-12T12:45:00.000Z");
  } finally {
    managerDb.close();
    targetDb.close();
  }
  assertStoredAction(
    TARGET_ID,
    false,
    "local_web",
    "real metadata sync must preserve the migrated false like"
  );
  assertStoredAction(
    PLAIN_ID,
    false,
    "local_web",
    "real metadata sync must not reopen a migrated imported false override"
  );
  runtime.clearListCache();
  await assertActionState(
    TARGET_ID,
    "liked",
    false,
    "likes",
    99,
    "migrated downloader false must remain effective in public stats after sync"
  );
  await assertActionState(
    LEGACY_IMPORTED_ID,
    "liked",
    false,
    "likes",
    499,
    "migrated imported false must retain its public baseline subtraction"
  );
  await assertActionState(
    PLAIN_ID,
    "liked",
    false,
    "likes",
    199,
    "legacy imported PUT false must remain baseline-relative after real sync"
  );
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
  const legacyActionSql = legacyBaseSql.replace(
    /\s*COALESCE\(user_like\.baseline_active, 0\) AS user_like_baseline_active,\s*/u,
    ""
  );
  assert.notEqual(legacyActionSql, baseSql, "legacy fixture downgrade must remove current action baseline expressions");
  assert.equal(legacyActionSql.includes("library_liked"), false);
  assert.equal(legacyActionSql.includes("user_like_baseline_active"), false);

  db.exec("DROP VIEW short_video_catalog; DROP VIEW short_video_catalog_base;");
  db.exec(legacyActionSql);
  db.exec(catalogSql);
  db.exec("ALTER TABLE short_video_user_actions DROP COLUMN baseline_active");
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
    roots: [fixtureRoot],
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
      touch(filePath) {
        if (String(filePath).includes(`${path.sep}short-videos${path.sep}lists${path.sep}`)) {
          touchedListCachePaths.push(filePath);
        }
      }
    },
    listQuery(url, options, fallback) {
      return typeof listQueryHook === "function"
        ? listQueryHook(url, options, fallback)
        : fallback();
    }
  });
}

async function verifyListCacheAuthorityContract() {
  const requestPath = "/api/short-videos?q=%E5%8A%A8%E4%BD%9C%E5%A5%91%E7%BA%A6%E7%9B%AE%E6%A0%87&source=all&sort=published&limit=7&facets=0&stats=0";
  await assertPutAction(TARGET_ID, "like", false, "liked", "likes", 99);
  touchedListCachePaths.length = 0;
  const seeded = await request("GET", `${requestPath}&refresh=1`);
  assert.equal(findVideo(seeded.data?.videos, TARGET_ID)?.actions?.liked, false, "authority fixture must seed the old cached action");
  const cachePath = touchedListCachePaths.at(-1);
  assert(cachePath && fs.existsSync(cachePath), "authority fixture must exercise the real disk list cache");

  await assertPutAction(TARGET_ID, "like", true, "liked", "likes", 100);
  const afterInvalidation = await request("GET", requestPath);
  assert.equal(afterInvalidation.status, 200);
  assert.equal(afterInvalidation.data?.stale, undefined, "generation-invalidated cache must not be exposed as TTL-stale data");
  assert.equal(findVideo(afterInvalidation.data?.videos, TARGET_ID)?.actions?.liked, true,
    "an ordinary GET after action invalidation must synchronously return the authoritative action");

  const ageOnlyCache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  ageOnlyCache.cachedAt = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(cachePath, JSON.stringify(ageOnlyCache));
  const ageOnlyStale = await request("GET", requestPath);
  assert.equal(ageOnlyStale.status, 200);
  assert.equal(ageOnlyStale.data?.stale, true, "same-generation age expiry may retain the fast stale-while-revalidate path");
  assert.equal(ageOnlyStale.data?.cacheState, "stale-refreshing");
  await new Promise((resolve) => setTimeout(resolve, 80));

  await assertPutAction(TARGET_ID, "like", false, "liked", "likes", 99);
  touchedListCachePaths.length = 0;
  await request("GET", `${requestPath}&refresh=1`);
  let firstQueryRelease;
  let firstQueryStartedResolve;
  const firstQueryStarted = new Promise((resolve) => { firstQueryStartedResolve = resolve; });
  const firstQueryReleasePromise = new Promise((resolve) => { firstQueryRelease = resolve; });
  let raceQueries = 0;
  const oldSnapshot = seeded.data;
  listQueryHook = async (_url, _options, fallback) => {
    raceQueries += 1;
    if (raceQueries === 1) {
      firstQueryStartedResolve();
      await firstQueryReleasePromise;
      return oldSnapshot;
    }
    return fallback();
  };
  const racingGet = request("GET", `${requestPath}&refresh=1`);
  await firstQueryStarted;
  await assertPutAction(TARGET_ID, "like", true, "liked", "likes", 100);
  firstQueryRelease();
  const raced = await racingGet;
  listQueryHook = null;
  assert.equal(raceQueries, 2, "a mutation during a foreground query must force one stable retry");
  assert.equal(raced.status, 200);
  assert.equal(raced.data?.stale, undefined, "the pre-mutation query snapshot must never be sent as authority");
  assert.equal(findVideo(raced.data?.videos, TARGET_ID)?.actions?.liked, true,
    "the route must send only the post-mutation stable snapshot");
  const racedCache = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  assert.equal(findVideo(racedCache.videos, TARGET_ID)?.actions?.liked, true,
    "the pre-mutation snapshot must not be written under the current cache generation");

  const exhaustedPath = "/api/short-videos?q=authority-fence-exhausted&source=all&sort=published&limit=9&facets=0&stats=0&refresh=1";
  const cacheFilesBeforeExhaustion = new Set(listCacheFiles());
  let exhaustedQueries = 0;
  listQueryHook = async () => {
    exhaustedQueries += 1;
    runtime.clearListCache();
    return oldSnapshot;
  };
  const exhausted = await request("GET", exhaustedPath);
  listQueryHook = null;
  assert.equal(exhaustedQueries, 3, "foreground authority fence must remain bounded under continuous mutation");
  assert.equal(exhausted.status, 503, "an unstable list must fail retryably instead of returning false authority");
  assert.equal(exhausted.data?.retryable, true);
  assert.deepEqual(new Set(listCacheFiles()), cacheFilesBeforeExhaustion,
    "exhausted unstable snapshots must not create an authoritative cache entry");

  listQueryHook = async () => { throw new Error("fixture query offline"); };
  runtime.clearListCache();
  const offlineFallback = await request("GET", requestPath);
  listQueryHook = null;
  assert.equal(offlineFallback.status, 200, "generation-invalidated disk data must remain available as an explicit offline fallback");
  assert.equal(offlineFallback.data?.stale, true);
  assert.equal(offlineFallback.data?.offline, true);
  assert.equal(offlineFallback.data?.cacheState, "offline");

  await verifyWatchGenerationAuthorityFence();
  await assertPutAction(TARGET_ID, "like", false, "liked", "likes", 99);
}

async function verifyWatchGenerationAuthorityFence() {
  const requestPath = "/api/short-videos?source=history&sort=watched&limit=6&facets=0&stats=0&refresh=1";
  const oldData = {
    videos: [{ id: TARGET_ID, actions: { liked: false, collected: false }, watch: { progressMs: 0 } }],
    total: 1,
    hasMore: false,
    source: "history",
    sort: "watched"
  };
  const newData = {
    ...oldData,
    videos: [{ ...oldData.videos[0], watch: { progressMs: 1200, lastWatchedAt: "2026-08-12T13:00:00.000Z" } }]
  };
  let releaseFirst;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
  const releaseFirstPromise = new Promise((resolve) => { releaseFirst = resolve; });
  let queries = 0;
  listQueryHook = async () => {
    queries += 1;
    if (queries === 1) {
      firstStartedResolve();
      await releaseFirstPromise;
      return oldData;
    }
    return newData;
  };
  const listRequest = request("GET", requestPath);
  await firstStarted;
  const watch = await request("PUT", `/api/short-videos/${encodeURIComponent(TARGET_ID)}/watch`, {
    progressMs: 1200,
    lastWatchedAt: "2026-08-12T13:00:00.000Z"
  });
  assert.equal(watch.status, 200);
  releaseFirst();
  const response = await listRequest;
  listQueryHook = null;
  assert.equal(queries, 2, "watch-sensitive foreground queries must retry after a watch generation change");
  assert.equal(response.data?.videos?.[0]?.watch?.progressMs, 1200,
    "watch-sensitive routes must send the post-watch stable snapshot");
}

function listCacheFiles() {
  const directory = path.join(cacheRoot, "short-videos", "lists");
  try {
    return fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
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

  await setStoredAction(PLAIN_ID, "collect", true, "imported");
  await assertActionState(PLAIN_ID, "collected", true, "collects", 20, "legacy imported collect counting must remain unchanged");
  await setStoredAction(PLAIN_ID, "collect", false, "imported");
  await assertActionState(PLAIN_ID, "collected", false, "collects", 19, "legacy imported collect removal must remain unchanged");

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
  const targetDb = new DatabaseSync(dbPath);
  const managerDb = new DatabaseSync(managerDbPath, { readOnly: true });
  try {
    const result = syncDownloadManagerSourceMemberships(
      targetDb,
      managerDb,
      "2026-08-12T13:00:00.000Z"
    );
    assert.equal(result.membershipsSeen, 3);
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
    insertLink.run(
      3,
      LEGACY_IMPORTED_AWEME_ID,
      fixtureRoot,
      JSON.stringify([path.join(fixtureRoot, `${LEGACY_IMPORTED_ID}.mp4`)]),
      500,
      50
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
  assertStoredActionForUser("local:self", videoId, "like", active, source, message);
}

function assertStoredActionType(videoId, actionType, active, source, message) {
  assertStoredActionForUser("local:self", videoId, actionType, active, source, message);
}

function assertStoredActionForUser(localUserId, videoId, actionType, active, source, message) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const action = db.prepare(`
      SELECT active, source
      FROM short_video_user_actions
      WHERE local_user_id = ? AND video_id = ? AND action_type = ?
    `).get(localUserId, videoId, actionType);
    assert.equal(Boolean(action?.active), active, message);
    assert.equal(action?.source, source, message);
  } finally {
    db.close();
  }
}

function assertStoredBaseline(videoId, expected, message) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare(`
      SELECT baseline_active FROM short_video_user_actions
      WHERE local_user_id = 'local:self' AND video_id = ? AND action_type = 'like'
    `).get(videoId);
    assert.equal(Boolean(row?.baseline_active), expected, message);
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
  const baselineActive = actionType === "like" && (source === "imported" || source === "download_manager") ? 1 : 0;
  db.prepare(`
    INSERT INTO short_video_user_actions (
      local_user_id, video_id, action_type, active, source, baseline_active, acted_at, updated_at
    ) VALUES ('local:self', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(local_user_id, video_id, action_type) DO UPDATE SET
      active = excluded.active,
      source = excluded.source,
      baseline_active = excluded.baseline_active,
      acted_at = excluded.acted_at,
      updated_at = excluded.updated_at
  `).run(videoId, actionType, active ? 1 : 0, source, baselineActive, now, now);
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

async function verifyRecommendedRecoversAfterLockedPreflight() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-schema-retry-"));
  const lockedDbPath = path.join(root, "short-videos.sqlite");
  const lockedCacheRoot = path.join(root, "cache");
  let lockedRuntime = null;
  const bootstrap = createShortVideoStore({ dbPath: lockedDbPath, roots: [] });
  try {
    bootstrap.summary();
  } finally {
    bootstrap.close();
  }
  const db = new DatabaseSync(lockedDbPath);
  try {
    const baseSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='short_video_catalog_base'").get()?.sql || "");
    const catalogSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='short_video_catalog'").get()?.sql || "");
    const oldBaseSql = baseSql.replace(/\s*COALESCE\(user_like\.baseline_active, 0\) AS user_like_baseline_active,\s*/u, "");
    db.exec("DROP VIEW short_video_catalog; DROP VIEW short_video_catalog_base;");
    db.exec(oldBaseSql);
    db.exec(catalogSql);
    db.exec("ALTER TABLE short_video_user_actions DROP COLUMN baseline_active");
    db.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('schema_version', ?)").run(ACTIONS_12_SCHEMA_VERSION);
    db.exec("BEGIN IMMEDIATE");

    lockedRuntime = createShortVideosRuntime({
      dbPath: lockedDbPath,
      downloadManagerDbPath: "",
      downloadManagerSyncMs: 0,
      schemaBusyTimeoutMs: 25,
      ffmpegPath: "ffmpeg",
      ffprobePath: "ffprobe",
      roots: [],
      mediaResponseService: { serveImage() {} },
      mediaStreamService: { serveVideo() {} },
      notFound() {},
      readJsonBody: async () => ({}),
      requireLocalAdmin: () => true,
      sendJson(res, status, data) { res.status = status; res.data = data; },
      sharedCache: { rootDir: lockedCacheRoot, scheduleCleanup() {}, touch() {} }
    });
    assert.equal(readMeta(lockedDbPath, "schema_version"), ACTIONS_12_SCHEMA_VERSION, "locked startup preflight must leave actions-12 pending");
    assert.equal(lockedRuntime.catalogWorkerDiagnostics().workerStarts, 0, "failed startup preflight must not start the reader");
    db.exec("ROLLBACK");

    const response = {};
    await lockedRuntime.routeApi(
      { method: "GET" },
      response,
      new URL("http://fixture/api/short-videos?source=recommended&stats=0&facets=0&limit=5")
    );
    assert.equal(response.status, 200, "the first recommended request after lock release must repair schema and succeed");
    assert.equal(readMeta(lockedDbPath, "schema_version"), CURRENT_SCHEMA_VERSION, "recommended recovery must advance schema");
    assert.equal(hasActionColumn(lockedDbPath, "baseline_active"), true, "recommended recovery must add the action baseline column");
    assert.equal(lockedRuntime.catalogWorkerDiagnostics().workerStarts, 1, "recommended recovery must start one read-only worker");
    const repeated = {};
    await lockedRuntime.routeApi(
      { method: "GET" },
      repeated,
      new URL("http://fixture/api/short-videos?source=recommended&stats=0&facets=0&limit=5&refresh=1")
    );
    assert.equal(repeated.status, 200, "later recommended requests must stay healthy after schema repair");
    assert.equal(lockedRuntime.catalogWorkerDiagnostics().workerStarts, 1, "successful schema repair must remain latched");
  } finally {
    try { db.exec("ROLLBACK"); } catch {}
    db.close();
    await lockedRuntime?.stop();
    lockedRuntime?.store?.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function hasActionColumn(filePath, columnName) {
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return db.prepare("PRAGMA table_info(short_video_user_actions)").all().some((column) => column.name === columnName);
  } finally {
    db.close();
  }
}
