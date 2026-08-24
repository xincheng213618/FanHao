import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { SQLITE_SHORT_VIDEO_COVER_SOURCE } from "../src/modules/short-videos/server/cover-database.js";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import { createDownloadManagerSyncService } from "../src/modules/short-videos/server/download-manager-sync-service.js";
import { createShortVideoPublicVideoMapper } from "../src/modules/short-videos/server/public-video-mapper.js";

const shortVideoStoreSource = fs.readFileSync(new URL("../src/modules/short-videos/server/store.js", import.meta.url), "utf8");
const shortVideoImportItemMapperSource = fs.readFileSync(
  new URL("../src/modules/short-videos/server/import-item-mapper.js", import.meta.url),
  "utf8"
);
const shortVideoListPageQueriesSource = fs.readFileSync(
  new URL("../src/modules/short-videos/server/list-page-queries.js", import.meta.url),
  "utf8"
);
const shortVideoNavigationQueriesSource = fs.readFileSync(
  new URL("../src/modules/short-videos/server/navigation-queries.js", import.meta.url),
  "utf8"
);
const shortVideoLibraryInsightsSource = fs.readFileSync(
  new URL("../src/modules/short-videos/server/library-insights.js", import.meta.url),
  "utf8"
);
const shortVideoPublicVideoMapperSource = fs.readFileSync(
  new URL("../src/modules/short-videos/server/public-video-mapper.js", import.meta.url),
  "utf8"
);
assert.match(shortVideoStoreSource, /createShortVideoListPageQueries/, "store should delegate list-page query planning to the query component");
assert.match(shortVideoStoreSource, /createShortVideoImportItemMapper/, "store should delegate filesystem and download-manager item mapping");
assert.doesNotMatch(
  shortVideoStoreSource,
  /^function (?:parseVideoFile|parseGalleryDirectory|downloadManagerRowToItem)\b/m,
  "store should not reintroduce import item parsing"
);
assert.match(
  shortVideoImportItemMapperSource,
  /return Object\.freeze\(\{\s*downloadManagerRowToItem,\s*parseGalleryDirectory,\s*parseVideoFile\s*\}\)/,
  "import item mapper should expose the three canonical import entry points"
);
assert.match(shortVideoStoreSource, /createShortVideoPublicVideoMapper/, "store should delegate public video presentation mapping");
assert.doesNotMatch(
  shortVideoStoreSource,
  /^function (?:publicVideo|publicVideoMedia|publicShortVideoRecommendation|publicShortVideoSound|shortVideoActionMetricDelta)\b/m,
  "store should not reintroduce public video presentation mapping"
);
assert.match(
  shortVideoPublicVideoMapperSource,
  /return Object\.freeze\(\{ publicVideo, publicVideoMedia \}\)/,
  "public video mapper should expose the canonical row and media mapping entry points"
);
const { publicVideo: mapPublicVideoFixture } = createShortVideoPublicVideoMapper({
  clampInt: (value, fallback, min, max) => Math.max(min, Math.min(max, Math.round(Number(value ?? fallback) || fallback))),
  optionalInteger: (value) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : null,
  parseJsonArray: (value) => {
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  },
  parseJsonObject: (value) => {
    try {
      const parsed = typeof value === "string" ? JSON.parse(value) : value;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
});
const singleLiveFixtureId = "7666424537071935673";
const singleLiveFixture = mapPublicVideoFixture({
  id: singleLiveFixtureId,
  aweme_id: singleLiveFixtureId,
  media_type: "gallery",
  source_path: `C:\\media\\${singleLiveFixtureId}_1.jpg`,
  metadata_json: JSON.stringify({
    is_live_photo: 1,
    images: [{
      width: 1080,
      height: 1920,
      live_photo_type: 1,
      video: { duration: 4967, play_addr: { url_list: ["https://example.invalid/live.mp4"] } }
    }],
    fanhaoMedia: { type: "gallery", galleryCount: 2, galleryItems: ["image", "video"] }
  })
});
assert.equal(singleLiveFixture.galleryPresentation, "live-photo");
assert.equal(singleLiveFixture.galleryCount, 1, "a single live photo should expose one logical playback item");
assert.deepEqual(singleLiveFixture.galleryItems.map((item) => item.type), ["video"]);
assert.equal(singleLiveFixture.galleryItems[0]?.sourceIndex, 1);
assert.equal(singleLiveFixture.galleryItems[0]?.posterIndex, 0);
assert.equal(singleLiveFixture.galleryItems[0]?.url, `/media/short-video-gallery/${singleLiveFixtureId}/1`);
assert.equal(singleLiveFixture.galleryItems[0]?.posterUrl, `/media/short-video-gallery/${singleLiveFixtureId}/0`);
const multiLiveFixtureId = "7665938053522214858";
const multiLiveFixture = mapPublicVideoFixture({
  id: multiLiveFixtureId,
  aweme_id: multiLiveFixtureId,
  media_type: "gallery",
  source_path: `C:\\media\\${multiLiveFixtureId}_1.jpg`,
  metadata_json: JSON.stringify({
    images: Array.from({ length: 3 }, () => ({
      live_photo_type: 1,
      video: { duration: 3000, play_addr: { url_list: ["https://example.invalid/live.mp4"] } }
    })),
    fanhaoMedia: {
      type: "gallery",
      galleryCount: 6,
      galleryItems: ["image", "video", "image", "video", "image", "video"]
    }
  })
});
assert.equal(multiLiveFixture.galleryPresentation, "live-photo");
assert.equal(multiLiveFixture.galleryCount, 3, "three live-photo pairs should expose three logical playback items");
assert.deepEqual(multiLiveFixture.galleryItems.map((item) => item.type), ["video", "video", "video"]);
assert.deepEqual(multiLiveFixture.galleryItems.map((item) => item.sourceIndex), [1, 3, 5]);
assert.deepEqual(multiLiveFixture.galleryItems.map((item) => item.posterIndex), [0, 2, 4]);
const mixedLiveFixture = mapPublicVideoFixture({
  id: "7675202366409522161",
  aweme_id: "7675202366409522161",
  media_type: "gallery",
  source_path: "C:\\media\\7675202366409522161_1.jpg",
  metadata_json: JSON.stringify({
    images: [
      { live_photo_type: 1, video: { duration: 3000 } },
      {},
      { live_photo_type: 1, video: { duration: 3000 } },
      {}
    ],
    fanhaoMedia: {
      type: "gallery",
      galleryCount: 6,
      galleryItems: ["image", "video", "image", "video", "image", "image"]
    }
  })
});
assert.equal(mixedLiveFixture.galleryPresentation, "live-photo");
assert.deepEqual(mixedLiveFixture.galleryItems.map((item) => item.type), ["video", "image", "video", "image"]);
assert.deepEqual(mixedLiveFixture.galleryItems.map((item) => item.sourceIndex), [1, 2, 3, 5]);
assert.deepEqual(mixedLiveFixture.galleryItems.map((item) => item.posterIndex), [0, undefined, 4, undefined]);
assert.ok(shortVideoStoreSource.split(/\r?\n/).length <= 4950, "short-video store exceeded its refactored 4950-line budget");
assert.ok(shortVideoImportItemMapperSource.split(/\r?\n/).length <= 650, "short-video import item mapper exceeded its 650-line budget");
assert.ok(shortVideoPublicVideoMapperSource.split(/\r?\n/).length <= 280, "short-video public video mapper exceeded its 280-line budget");
assert.doesNotMatch(
  shortVideoStoreSource,
  /^function (?:fastHistoryVideoPage|fastFilteredVideoPage|fastPublishedVideoPage|shortVideoRelationshipTotal)\b/m,
  "store should not reintroduce list-page SQL strategies"
);
assert.match(
  shortVideoListPageQueriesSource,
  /function orderedCatalogRows\(/,
  "list-page query component should centralize ordered catalog hydration"
);
assert.match(shortVideoStoreSource, /createShortVideoNavigationQueries/, "store should delegate adjacent-video navigation to the query component");
assert.match(shortVideoStoreSource, /shortVideoLibraryInsights/, "store should delegate personal-value and data-health analytics to a dedicated component");
assert.match(shortVideoLibraryInsightsSource, /function authorEfficiency\(/, "library insights should quantify author input against explicit-like hits");
assert.match(shortVideoLibraryInsightsSource, /lowYieldAuthors[\s\S]*authors,/, "author efficiency should retain the complete eligible relationship table instead of only eight dashboard rows");
assert.match(shortVideoLibraryInsightsSource, /function managerQualityAudit\(/, "library insights should read the real quality-audit state instead of hard-coding a likes band");
assert.doesNotMatch(
  shortVideoStoreSource,
  /^function (?:adjacentOrder|adjacentRows|fastHistoryAdjacentRows|fastLikedAdjacentRows|fastPublishedAdjacentRows|fastMetricAdjacentRows)\b/m,
  "store should not reintroduce adjacent-video SQL strategies"
);
assert.match(
  shortVideoNavigationQueriesSource,
  /function multiColumnAdjacentRows\(/,
  "navigation query component should own multi-column cursor traversal"
);
const contentStructureStart = shortVideoStoreSource.indexOf("  function contentStructureInsights(database) {");
const contentStructureEnd = shortVideoStoreSource.indexOf("\n  function ", contentStructureStart + 12);
const contentStructureSource = shortVideoStoreSource.slice(contentStructureStart, contentStructureEnd);
assert.ok(contentStructureStart >= 0 && contentStructureEnd > contentStructureStart, "content-structure analytics implementation should remain discoverable");
assert.doesNotMatch(contentStructureSource, /PERCENT_RANK\s*\(/, "content-structure analytics must avoid SQLite's full-result window materialization");
assert.doesNotMatch(contentStructureSource, /v\.(?:title|share_url|published_at|liked_at|actual_width|actual_height|actual_long_edge)/, "content-structure analytics must not load unused presentation columns for every video");
assert.match(contentStructureSource, /rows\.sort\(\(left, right\) => Number\(left\.engagement_score/, "content-structure analytics must compute the equivalent tied percentile in one in-memory numeric sort");
assert.match(contentStructureSource, /medianSorted\(collectRatios\)/, "content-structure analytics must reuse its sorted ratio arrays instead of repeatedly sorting the full sample");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-store-"));
const root = path.join(tempDir, "likes");
const authorDir = path.join(root, "测试作者_MS4wTestAuthor");
const galleryId = "7660219617974484837";
const liveId = "7660744527430769851";
const galleryDir = path.join(authorDir, `2026-07-09_测试图集_${galleryId}`);
const liveDir = path.join(authorDir, `2026-07-10_测试实况_${liveId}`);
const targetDbPath = path.join(tempDir, "short-videos.sqlite");
const sourceDbPath = path.join(tempDir, "douyin-downloads.sqlite");
const followingManagerDbPath = path.join(tempDir, "following-manager.sqlite");
let store;
let explicitStore;

async function runSyncWorker(workerData) {
  const service = createDownloadManagerSyncService({
    sourceDbPath: workerData.sourceDbPath,
    intervalMs: 60_000,
    dbPath: workerData.dbPath,
    ffmpegPath: workerData.ffmpegPath,
    roots: workerData.roots
  });
  try {
    const result = await service.sync({ force: true });
    return { ok: Boolean(result?.ok), result };
  } finally {
    service.stop();
  }
}

try {
  fs.mkdirSync(galleryDir, { recursive: true });
  const galleryPaths = [1, 2, 3].map((index) => path.join(galleryDir, `gallery_${galleryId}_${index}.jpg`));
  for (const filePath of galleryPaths) fs.writeFileSync(filePath, Buffer.from(`image:${filePath}`));
  fs.writeFileSync(path.join(galleryDir, `gallery_${galleryId}_data.json`), JSON.stringify({
    aweme_id: galleryId,
    aweme_type: 68,
    create_time: Math.floor(Date.parse("2026-07-09T08:00:00.000Z") / 1000),
    desc: "三张图片测试",
    images: galleryPaths.map(() => ({ width: 1080, height: 1440 })),
    author: { sec_uid: "MS4wTestAuthor", nickname: "测试作者" }
  }));

  const followingManagerDb = new DatabaseSync(followingManagerDbPath);
  followingManagerDb.exec(`
    CREATE TABLE profiles (
      id INTEGER PRIMARY KEY,
      sec_uid TEXT,
      tab TEXT,
      is_following INTEGER NOT NULL DEFAULT 0,
      following_discovered_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE links (
      id INTEGER PRIMARY KEY,
      aweme_id TEXT,
      kind TEXT,
      status TEXT,
      download_intent TEXT
    );
    CREATE TABLE video_quality_audit_runs (
      id INTEGER PRIMARY KEY,
      generated_at TEXT,
      downloaded_count INTEGER,
      probe_error_count INTEGER
    );
    CREATE TABLE video_quality_audit_items (
      id INTEGER PRIMARY KEY,
      run_id INTEGER,
      audit_status TEXT,
      redownload_status TEXT,
      verification_status TEXT
    );
  `);
  followingManagerDb.prepare(`
    INSERT INTO profiles (id, sec_uid, tab, is_following, following_discovered_at, updated_at)
    VALUES (1, 'MS4wTestAuthor', 'post', 1, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `).run();
  followingManagerDb.prepare(`
    INSERT INTO profiles (id, sec_uid, tab, is_following, following_discovered_at, updated_at)
    VALUES (2, 'MS4wNoLikedVideos', 'post', 1, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')
  `).run();
  followingManagerDb.prepare("INSERT INTO links VALUES (1, 'distribution-video', 'video', 'downloaded', '')").run();
  followingManagerDb.prepare("INSERT INTO video_quality_audit_runs VALUES (7, '2026-07-15T12:00:00.000Z', 1, 0)").run();
  followingManagerDb.prepare("INSERT INTO video_quality_audit_items VALUES (1, 7, 'skipped_threshold', 'not_needed', 'not_checked')").run();
  followingManagerDb.prepare("INSERT INTO video_quality_audit_items VALUES (2, 7, 'upgrade_available', 'completed', 'passed')").run();
  followingManagerDb.close();

  store = createShortVideoStore({
    dbPath: targetDbPath,
    downloadManagerDbPath: followingManagerDbPath,
    roots: [root]
  });
  const scan = store.scan(root);
  assert.equal(scan.imported, 1, "pure image gallery should be imported by the filesystem scanner");
  const legacyGeneratedId = "legacy-generated-cover";
  const legacyGeneratedVideo = path.join(root, `${legacyGeneratedId}.mp4`);
  const legacyCoverDir = path.join(tempDir, "short-video-covers");
  const legacyGeneratedCover = path.join(legacyCoverDir, `${legacyGeneratedId}-legacy.jpg`);
  const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  fs.mkdirSync(legacyCoverDir, { recursive: true });
  fs.writeFileSync(legacyGeneratedVideo, Buffer.from("legacy-video"));
  fs.writeFileSync(legacyGeneratedCover, jpegBuffer);
  const legacyCoverDb = new DatabaseSync(targetDbPath);
  legacyCoverDb.prepare(`
    INSERT INTO short_videos (
      id, aweme_id, visibility, media_type, title, source_path, cover_path, cover_source,
      metadata_json, size_bytes, mtime_ms
    ) VALUES (?, ?, 'local_only', 'video', '旧封面迁移测试', ?, ?, 'ffmpeg', '{}', ?, ?)
  `).run(legacyGeneratedId, legacyGeneratedId, legacyGeneratedVideo, legacyGeneratedCover, 12, 1234);
  legacyCoverDb.prepare(`
    INSERT INTO short_video_assets (id, video_id, asset_type, local_path, size_bytes, mime_type)
    VALUES (?, ?, 'ffmpeg_cover', ?, ?, 'image/jpeg')
  `).run(`${legacyGeneratedId}:ffmpeg_cover`, legacyGeneratedId, legacyGeneratedCover, jpegBuffer.length);
  legacyCoverDb.close();
  const legacyMigration = store.migrateLegacyCoverFiles();
  assert.equal(legacyMigration.migrated, 1, "legacy generated covers should migrate into the dedicated cover database");
  assert.equal(fs.existsSync(legacyGeneratedCover), true, "migration must retain legacy files until the caller completes verification");
  const migratedCover = store.coverFile(legacyGeneratedId);
  assert.equal(migratedCover?.buffer?.equals(jpegBuffer), true, "migrated covers should be read directly from SQLite BLOB storage");
  const migratedCoverDb = new DatabaseSync(targetDbPath, { readOnly: true });
  const migratedCoverRow = migratedCoverDb.prepare("SELECT cover_path, cover_source FROM short_videos WHERE id = ?").get(legacyGeneratedId);
  migratedCoverDb.close();
  assert.equal(migratedCoverRow?.cover_path, "");
  assert.equal(migratedCoverRow?.cover_source, SQLITE_SHORT_VIDEO_COVER_SOURCE);
  assert.match(
    store.videoDetail(legacyGeneratedId)?.video?.coverUrl || "",
    /^\/media\/short-video-cover\/legacy-generated-cover\?v=/,
    "SQLite-backed generated covers must keep the public media contract"
  );
  const storedCoverDelete = await store.deleteVideos([legacyGeneratedId], { deleteFiles: false });
  assert.equal(storedCoverDelete.deletedStoredCovers, 1, "deleting a short video should delete its linked SQLite cover");
  assert.equal(store.coverStorageStatus().count, 0, "cover storage should not retain deleted-video orphans");
  fs.rmSync(legacyGeneratedVideo, { force: true });
  const gallery = store.videoDetail(galleryId)?.video;
  assert.equal(gallery?.mediaType, "gallery");
  assert.equal(gallery?.galleryCount, 3);
  assert.equal(gallery?.stats?.known, false, "all-zero placeholder statistics should be exposed as unknown");
  assert.deepEqual(gallery?.galleryItems.map((item) => item.type), ["image", "image", "image"]);
  assert.equal(store.galleryFile(galleryId, 2)?.path, galleryPaths[2]);
  const indexedTitleSuggestions = store.searchSuggestions({
    searchParams: new URLSearchParams("q=三张图片&media=gallery&limit=8")
  });
  assert.equal(indexedTitleSuggestions.suggestions[0]?.kind, "title", "trigram search should serve matching titles from the incremental index");
  const indexedTitleResults = store.listVideos({
    searchParams: new URLSearchParams("q=三张图片&source=all&sort=published&limit=10&stats=0&facets=0")
  });
  assert.equal(indexedTitleResults.videos[0]?.id, galleryId, "list search should use the same trigram index as suggestions");
  assert.equal(indexedTitleResults.videos[0]?.galleryCount, 3, "narrow list reads must retain gallery item metadata");
  assert.deepEqual(indexedTitleResults.videos[0]?.galleryItems.map((item) => item.type), ["image", "image", "image"]);
  const aggregateSearch = store.listVideos({
    searchParams: new URLSearchParams("q=测试作者&source=all&sort=published&limit=10&stats=0&facets=0")
  });
  assert.equal(aggregateSearch.usersTotal, 1, "aggregate search should report matching users with matching works");
  assert.equal(aggregateSearch.users[0]?.name, "测试作者");
  assert.equal(aggregateSearch.videos[0]?.id, galleryId);
  const aggregateAppend = store.listVideos({
    searchParams: new URLSearchParams("q=测试作者&source=all&sort=published&limit=10&stats=0&facets=0&users=0")
  });
  assert.deepEqual(aggregateAppend.users, [], "append requests should be able to skip repeated user matches");
  assert.equal(aggregateAppend.usersTotal, 0);
  const galleryWithoutRawMetadata = store.videoDetail(galleryId, {
    searchParams: new URLSearchParams("metadata=0&neighbors=1")
  })?.video;
  assert.equal(galleryWithoutRawMetadata?.galleryCount, 3, "metadata=0 details must still retain gallery playback structure");
  assert.equal(Object.prototype.hasOwnProperty.call(galleryWithoutRawMetadata || {}, "metadata"), false);
  const scannedLikes = store.listVideos({
    searchParams: new URLSearchParams("source=liked&limit=10&stats=0&facets=0")
  });
  assert.equal(scannedLikes.total, 0, "filesystem location must not imply a liked relationship");
  const firstAuthorPage = store.listAuthors({
    searchParams: new URLSearchParams("limit=1&offset=0")
  });
  assert.equal(firstAuthorPage.total, 1, "author pagination should report the complete matching author count");
  assert.equal(firstAuthorPage.authors.length, 1, "author pagination should return only the requested page");
  assert.equal(firstAuthorPage.authors[0]?.name, "测试作者");
  assert.equal(firstAuthorPage.hasMore, false);
  const compactFacets = store.facets();
  assert.equal(compactFacets.authors.length, 1, "facets should return a bounded author preview instead of the complete author catalog");
  assert.equal(compactFacets.authorsTotal, 1);
  assert.equal(compactFacets.authorsTruncated, false);
  const defaultListWithoutFacets = store.listVideos({
    searchParams: new URLSearchParams("source=all&limit=1&stats=0")
  });
  assert.equal(defaultListWithoutFacets.summary, null, "list requests should opt in before computing aggregate facets");
  assert.deepEqual(defaultListWithoutFacets.authors, []);
  const emptyFollowingAuthorPage = store.listAuthors({
    searchParams: new URLSearchParams("scope=following&limit=10")
  });
  assert.equal(emptyFollowingAuthorPage.scope, "following");
  assert.equal(emptyFollowingAuthorPage.total, 0, "My Following must not include authors without an active follow relation");
  store.setAuthorFollow(galleryId, { active: true });
  const followingDb = new DatabaseSync(targetDbPath);
  followingDb.prepare(`
    INSERT INTO short_video_users (
      id, platform, sec_uid, nickname, unique_id, short_id, signature,
      follower_count, following_count, aweme_count, profile_collected_at,
      created_at, updated_at
    )
    VALUES (
      'douyin:MS4wNoLikedVideos', 'douyin', 'MS4wNoLikedVideos', '零点赞关注',
      'zero_like_author', '10086', '@测试作者', 1234, 56, 78,
      '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'
    )
  `).run();
  followingDb.prepare(`
    INSERT INTO short_video_follows (local_user_id, target_user_id, active, followed_at, updated_at)
    VALUES ('local:self', 'douyin:MS4wNoLikedVideos', 1, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')
  `).run();
  followingDb.prepare(`
    UPDATE short_video_follows
    SET followed_at = '2026-07-10T00:00:00.000Z'
    WHERE local_user_id = 'local:self' AND target_user_id <> 'douyin:MS4wNoLikedVideos'
  `).run();
  followingDb.prepare(`
    INSERT INTO short_video_users (id, platform, sec_uid, nickname, unique_id, created_at, updated_at)
    VALUES (
      'douyin:MS4wRenamedMention', 'douyin', 'MS4wRenamedMention', '改名作者-', 'renamed_author',
      '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z'
    )
  `).run();
  followingDb.close();
  const mentionedAuthor = store.resolveAuthorMention("@零点赞关注");
  assert.equal(mentionedAuthor?.secUid, "MS4wNoLikedVideos", "@nickname should resolve through the author profile table");
  assert.equal(mentionedAuthor?.count, 0, "mentioned authors must resolve even when they have no local videos");
  assert.equal(mentionedAuthor?.following, true);
  assert.equal(mentionedAuthor?.followerCount, 1234);
  assert.equal(store.resolveAuthorMention("zero_like_author")?.name, "零点赞关注", "Douyin ID should resolve to the same local author");
  assert.equal(store.resolveAuthorMention("@改名作者")?.name, "改名作者-", "mentions should tolerate trailing nickname decorations added after the signature was saved");
  assert.equal(store.resolveAuthorMention("@不存在的作者"), null);
  const followingAuthorPage = store.listAuthors({
    searchParams: new URLSearchParams("scope=following&sort=followed&limit=10")
  });
  assert.equal(followingAuthorPage.total, 2, "My Following should include followed profiles that do not have local videos");
  assert.equal(followingAuthorPage.scopeTotal, 2);
  assert.equal(followingAuthorPage.unlikedTotal, 2);
  assert.equal(followingAuthorPage.authors[0]?.name, "零点赞关注", "recent follow sorting should use followed_at descending");
  assert.equal(followingAuthorPage.authors[0]?.count, 0);
  assert.equal(followingAuthorPage.authors[1]?.following, true);
  const followingVideoPage = store.listVideos({
    searchParams: new URLSearchParams("source=following&media=gallery&sort=likes&limit=10&stats=0&facets=0")
  });
  assert.deepEqual(
    followingVideoPage.videos.map((item) => item.id),
    [galleryId],
    "following-video metric pages must preserve the active author-follow relationship on the indexed path"
  );
  const followingByVideoCount = store.listAuthors({
    searchParams: new URLSearchParams("scope=following&sort=count&limit=10")
  });
  assert.equal(followingByVideoCount.authors[0]?.name, "测试作者", "video count sorting should be server-backed before pagination");
  store.setUserAction(galleryId, "like", { active: true });
  const followingByLikedCount = store.listAuthors({
    searchParams: new URLSearchParams("scope=following&sort=liked&limit=10")
  });
  assert.equal(followingByLikedCount.authors[0]?.name, "测试作者");
  assert.equal(followingByLikedCount.authors[0]?.likedCount, 1);
  assert.equal(followingByLikedCount.unlikedTotal, 1, "local like changes should invalidate the cached following statistics");
  const unlikedFollowing = store.listAuthors({
    searchParams: new URLSearchParams("scope=following&filter=unliked&limit=10")
  });
  assert.equal(unlikedFollowing.total, 1);
  assert.equal(unlikedFollowing.authors[0]?.name, "零点赞关注");
  const removedNoLikeAuthor = store.setAuthorFollowByUser("douyin:MS4wNoLikedVideos", { active: false });
  assert.equal(removedNoLikeAuthor.active, false);
  assert.equal(removedNoLikeAuthor.managerUpdated, true, "local cleanup should also update the download manager profile");
  const afterNoLikeRemoval = store.listAuthors({
    searchParams: new URLSearchParams("scope=following&limit=10")
  });
  assert.equal(afterNoLikeRemoval.total, 1, "removed authors should disappear from My Following without deleting media");
  const removedDownloadedAuthor = store.setAuthorFollowByUser("douyin:MS4wTestAuthor", { active: false });
  assert.equal(removedDownloadedAuthor.active, false);
  assert.equal(store.videoDetail(galleryId)?.video?.id, galleryId, "removing a follow must preserve downloaded videos");
  const managerCheck = new DatabaseSync(followingManagerDbPath, { readOnly: true });
  assert.equal(
    managerCheck.prepare("SELECT is_following FROM profiles WHERE sec_uid='MS4wNoLikedVideos' AND tab='post'").get()?.is_following,
    0
  );
  assert.equal(
    managerCheck.prepare("SELECT is_following FROM profiles WHERE sec_uid='MS4wTestAuthor' AND tab='post'").get()?.is_following,
    0
  );
  managerCheck.close();
  store.setUserAction(galleryId, "like", { active: false });
  const missingAuthorPage = store.listAuthors({
    searchParams: new URLSearchParams("q=不存在的作者&limit=1")
  });
  assert.equal(missingAuthorPage.total, 0, "author pagination should filter by author name or secUid");
  assert.deepEqual(missingAuthorPage.authors, []);

  fs.mkdirSync(liveDir, { recursive: true });
  const liveImage = path.join(liveDir, `live_${liveId}_1.jpg`);
  const liveImage2 = path.join(liveDir, `live_${liveId}_2.jpg`);
  const liveVideo = path.join(liveDir, `live_${liveId}_live_1.mp4`);
  const liveMusic = path.join(liveDir, `live_${liveId}_music.mp3`);
  const liveData = path.join(liveDir, `live_${liveId}_data.json`);
  fs.writeFileSync(liveImage, Buffer.from("live-photo-image"));
  fs.writeFileSync(liveImage2, Buffer.from("second-gallery-image"));
  fs.writeFileSync(liveVideo, Buffer.from("live-photo-video"));
  fs.writeFileSync(liveMusic, Buffer.from("gallery-background-music"));
  fs.writeFileSync(liveData, JSON.stringify({
    aweme_id: liveId,
    aweme_type: 68,
    create_time: Math.floor(Date.parse("2026-07-10T08:00:00.000Z") / 1000),
    desc: "实况视频测试",
    images: [{
      width: 1080,
      height: 1920,
      live_photo_type: 1,
      video: { duration: 3000, play_addr: { url_list: ["https://example.invalid/live.mp4"] } }
    }, { width: 1080, height: 1440 }],
    music: { id_str: "music-test", title: "测试背景音乐", author: "测试作者" },
    author: { sec_uid: "MS4wTestAuthor", nickname: "测试作者" }
  }));

  const sourceDb = new DatabaseSync(sourceDbPath);
  sourceDb.exec(`
    CREATE TABLE profiles (
      id INTEGER PRIMARY KEY,
      tab TEXT,
      sec_uid TEXT,
      url TEXT,
      nickname TEXT,
      following_count INTEGER,
      follower_count INTEGER,
      total_favorited INTEGER,
      nickname_history_json TEXT NOT NULL DEFAULT '[]',
      total_favorited_history_json TEXT NOT NULL DEFAULT '[]',
      aweme_count INTEGER,
      profile_collected_at TEXT,
      updated_at TEXT,
      account_status TEXT NOT NULL DEFAULT 'active',
      account_status_reason TEXT,
      account_status_detected_at TEXT
    );
    CREATE TABLE links (
      id INTEGER PRIMARY KEY,
      profile_id INTEGER,
      aweme_id TEXT,
      status TEXT,
      kind TEXT,
      media_type TEXT,
      output_dir TEXT,
      local_file_paths TEXT,
      local_cover_path TEXT,
      duration_ms INTEGER,
      downloaded_at TEXT,
      last_seen_at TEXT,
      digg_count INTEGER,
      comment_count INTEGER,
      collect_count INTEGER,
      share_count INTEGER,
      is_missing_from_profile INTEGER NOT NULL DEFAULT 0,
      missing_from_profile_at TEXT
    );
  `);
  sourceDb.prepare(`
    INSERT INTO profiles (
      id, tab, sec_uid, url, nickname, following_count, follower_count,
      total_favorited, aweme_count, profile_collected_at, updated_at
    ) VALUES (1, 'like', 'MS4wTestAuthor', '', '测试作者', 10, 20, 30, 1,
      '2026-07-10T00:00:00+08:00', '2026-07-10T00:00:00+08:00')
  `).run();
  sourceDb.prepare(`
    INSERT INTO profiles (
      id, tab, sec_uid, url, nickname, following_count, follower_count,
      total_favorited, aweme_count, profile_collected_at, updated_at
    ) VALUES (2, 'post', 'MS4wTestAuthor', '', '测试作者', 11, 21, 31, 2,
      '2026-07-11T00:00:00+08:00', '2026-07-11T00:00:00+08:00')
  `).run();
  sourceDb.prepare(`
    UPDATE profiles
    SET account_status = 'banned',
        account_status_reason = '该用户被禁言',
        account_status_detected_at = '2026-07-11T00:05:00+08:00'
    WHERE id = 2
  `).run();
  sourceDb.prepare(`
    INSERT INTO links (
      id, profile_id, aweme_id, status, kind, media_type, output_dir,
      local_file_paths, downloaded_at, last_seen_at, digg_count, comment_count, collect_count, share_count
    ) VALUES (1, 1, ?, 'downloaded', 'note', 'gallery', ?, ?,
      '2026-07-10T19:16:44+08:00', '2026-07-10T19:16:44+08:00', 0, 0, 0, 0)
  `).run(liveId, liveDir, JSON.stringify([liveImage, liveImage2, liveVideo, liveMusic, liveData]));
  sourceDb.prepare(`
    INSERT INTO links (
      id, profile_id, aweme_id, status, kind, media_type, output_dir,
      local_file_paths, downloaded_at, last_seen_at, digg_count, comment_count, collect_count, share_count
    ) VALUES (2, 2, ?, 'downloaded', 'note', 'gallery', ?, ?,
      '2026-07-11T10:00:00+08:00', '2026-07-11T10:00:00+08:00', 12840, 321, 456, 78)
  `).run(liveId, liveDir, JSON.stringify([liveImage, liveImage2, liveVideo, liveMusic, liveData]));
  sourceDb.close();

  store.importDownloadManagerDb(sourceDbPath, { incremental: true, includePosts: true });
  const bannedAuthorPage = store.listAuthors({
    searchParams: new URLSearchParams("filter=banned&q=测试作者&limit=10")
  });
  assert.equal(bannedAuthorPage.scopeTotal, 1);
  assert.equal(bannedAuthorPage.bannedTotal, 1, "download-manager account bans must reach the local author facet");
  assert.equal(bannedAuthorPage.total, 1, "banned authors must be independently searchable");
  assert.equal(bannedAuthorPage.authors[0]?.accountStatus, "banned");
  assert.equal(bannedAuthorPage.authors[0]?.accountStatusReason, "该用户被禁言");
  const live = store.videoDetail(liveId)?.video;
  assert.equal(live?.mediaType, "gallery", "a note with an image and live MP4 should stay an ordered mixed gallery");
  assert.equal(live?.galleryPresentation, "live-photo");
  assert.equal(live?.galleryCount, 2);
  assert.deepEqual(live?.galleryItems.map((item) => item.type), ["video", "image"]);
  assert.equal(live?.galleryItems[0]?.posterUrl, `/media/short-video-gallery/${liveId}/0`);
  const legacyStatsDb = new DatabaseSync(targetDbPath);
  legacyStatsDb.prepare("DELETE FROM short_video_meta WHERE key = 'download_manager_stats_seen_watermark'").run();
  legacyStatsDb.close();
  const legacyStatsSeed = store.importDownloadManagerDb(sourceDbPath, { incremental: true, includePosts: true });
  assert.equal(legacyStatsSeed.statsRefreshRows, 0, "legacy databases must seed the current watermark without replaying history");
  const seededStatsDb = new DatabaseSync(targetDbPath, { readOnly: true });
  assert.equal(
    seededStatsDb.prepare("SELECT value FROM short_video_meta WHERE key = 'download_manager_stats_seen_watermark'").get()?.value,
    "2026-07-11T10:00:00+08:00"
  );
  seededStatsDb.close();
  assert.equal(store.galleryFile(liveId, 0)?.path, liveImage);
  assert.equal(store.galleryFile(liveId, 0)?.type, "image");
  assert.equal(store.galleryFile(liveId, 1)?.path, liveVideo);
  assert.equal(store.galleryFile(liveId, 1)?.type, "video");
  assert.equal(store.galleryFile(liveId, 2)?.path, liveImage2);
  assert.equal(store.coverFile(liveId)?.path, liveImage);
  assert.equal(store.musicFile(liveId)?.path, liveMusic);
  assert.equal(live?.sound?.localAvailable, true);
  assert.equal(live?.sound?.previewUrl, `/media/short-video-music/${liveId}`);
  assert.equal(live?.stats?.likes, 12840, "duplicate profile rows should prefer complete statistics");
  assert.equal(live?.stats?.comments, 321);
  assert.equal(live?.stats?.known, true);
  const authorSuggestions = store.searchSuggestions({
    searchParams: new URLSearchParams("q=测试作者&media=gallery&limit=8")
  });
  assert.equal(authorSuggestions.suggestions[0]?.kind, "author", "indexed author suggestions should take the fast path");
  assert.equal(authorSuggestions.suggestions[0]?.label, "测试作者");
  const importedLikes = store.listVideos({
    searchParams: new URLSearchParams("source=liked&limit=10&stats=0&facets=0")
  });
  assert.equal(importedLikes.total, 1, "only the downloader like profile should populate My Likes");
  assert.equal(importedLikes.relationshipTotal, 1);
  assert.equal(importedLikes.videos[0]?.id, liveId);
  const refreshedSourceDb = new DatabaseSync(sourceDbPath);
  refreshedSourceDb.prepare(`
    UPDATE profiles
    SET nickname = '更新后的测试作者',
        following_count = 295,
        follower_count = 892000,
        total_favorited = 8439000,
        nickname_history_json = '[{"value":"测试作者","first_seen_at":"2026-07-11T00:00:00+08:00","last_seen_at":"2026-07-11T00:00:00+08:00"},{"value":"更新后的测试作者","first_seen_at":"2026-07-20T04:32:03+08:00","last_seen_at":"2026-07-20T04:32:03+08:00"}]',
        total_favorited_history_json = '[{"value":31,"first_seen_at":"2026-07-11T00:00:00+08:00","last_seen_at":"2026-07-11T00:00:00+08:00"},{"value":8439000,"first_seen_at":"2026-07-20T04:32:03+08:00","last_seen_at":"2026-07-20T04:32:03+08:00"}]',
        aweme_count = 509,
        profile_collected_at = '2026-07-20T04:32:03+08:00',
        updated_at = '2026-07-20T04:32:03+08:00',
        account_status = 'active',
        account_status_reason = NULL,
        account_status_detected_at = NULL
    WHERE id = 2
  `).run();
  refreshedSourceDb.prepare(`
    UPDATE links
    SET digg_count = 13840,
        comment_count = 421,
        collect_count = 556,
        share_count = 88,
        last_seen_at = '2026-07-20T04:32:03+08:00',
        is_missing_from_profile = 1,
        missing_from_profile_at = '2026-07-20T04:32:03+08:00'
    WHERE id = 2
  `).run();
  refreshedSourceDb.close();
  const zeroRowProfileSync = store.importDownloadManagerDb(sourceDbPath, { incremental: true, includePosts: true });
  assert.equal(zeroRowProfileSync.incrementalRows, 0, "full scans without new downloads should still synchronize profiles");
  assert.equal(zeroRowProfileSync.statsRefreshRows, 1, "refreshed statistics must sync without changing downloaded_at");
  assert.equal(zeroRowProfileSync.profilesSeen, 1);
  assert.ok(zeroRowProfileSync.profilesChanged > 0, "nickname and account-state edits must report real profile changes");
  assert.ok(zeroRowProfileSync.membershipsChanged > 0, "missing-from-profile metadata must report a membership change");
  assert.equal(zeroRowProfileSync.catalogChanged, true);
  const refreshedLive = store.videoDetail(liveId)?.video;
  assert.equal(refreshedLive?.stats?.likes, 13840, "existing works must receive refreshed likes");
  assert.equal(refreshedLive?.stats?.comments, 421, "existing works must receive refreshed comments");
  assert.equal(refreshedLive?.stats?.collects, 556, "existing works must receive refreshed collects");
  assert.equal(refreshedLive?.stats?.shares, 88, "existing works must receive refreshed shares");
  const refreshedAuthor = store.resolveAuthorMention("MS4wTestAuthor");
  assert.equal(refreshedAuthor?.name, "更新后的测试作者", "profile nickname changes must reach the local author page");
  assert.deepEqual(new Set(refreshedAuthor?.nameHistory.map((item) => item.name)), new Set(["更新后的测试作者", "测试作者"]), "author detail must retain current and previous profile names");
  assert.deepEqual(new Set(refreshedAuthor?.totalFavoritedHistory.map((item) => item.value)), new Set([8439000, 31]), "author detail must retain observed total-like values");
  assert.equal(store.resolveAuthorMention("测试作者")?.name, "更新后的测试作者", "a previous nickname must resolve to the current author identity");
  assert.equal(store.listAuthors({ searchParams: new URLSearchParams("q=测试作者&limit=10") }).total, 1, "author search must match previous nicknames");
  assert.equal(refreshedAuthor?.awemeCount, 509, "official profile work totals must refresh without a new download");
  assert.equal(refreshedAuthor?.followingCount, 295);
  assert.equal(refreshedAuthor?.profileCollectedAt, "2026-07-20T04:32:03+08:00");
  assert.equal(refreshedAuthor?.count, 2, "exact sec_uid resolution must count canonical-owner works through the indexed author scope");
  assert.equal(refreshedAuthor?.accountStatus, "active", "manual recovery in the manager must clear the local banned marker");
  assert.equal(
    store.listAuthors({ searchParams: new URLSearchParams("filter=banned&limit=10") }).total,
    0,
    "recovered authors must leave the banned-only author view"
  );
  const nicknameSyncDb = new DatabaseSync(targetDbPath, { readOnly: true });
  assert.equal(
    nicknameSyncDb.prepare("SELECT author_name FROM short_videos WHERE id=?").get(liveId)?.author_name,
    "更新后的测试作者",
    "profile-only sync must also replace stale per-work author names"
  );
  nicknameSyncDb.close();
  const unchangedStatsSync = store.importDownloadManagerDb(sourceDbPath, { incremental: true, includePosts: true });
  assert.equal(unchangedStatsSync.incrementalRows, 0);
  assert.equal(unchangedStatsSync.statsRefreshRows, 0, "statistics watermark must avoid replaying unchanged works");
  assert.equal(unchangedStatsSync.profilesSeen, 1);
  assert.equal(unchangedStatsSync.profilesChanged, 0, "identical profile rows must not rewrite users or per-video author names");
  assert.equal(unchangedStatsSync.membershipsChanged, 0, "identical memberships must not rewrite their timestamps");
  assert.equal(unchangedStatsSync.actionsChanged, 0, "identical imported likes must not rewrite user actions");
  assert.equal(unchangedStatsSync.originsChanged, 0, "identical memberships must not rewrite video origins");
  assert.equal(unchangedStatsSync.relationshipFlagsChanged, 0, "identical memberships must not rewrite relationship flags");
  assert.equal(unchangedStatsSync.catalogChanges, 0);
  assert.equal(unchangedStatsSync.catalogChanged, false);
  const authorAllWorks = store.listVideos({
    searchParams: new URLSearchParams("source=all&author=MS4wTestAuthor&limit=10&stats=0&facets=0")
  });
  assert.equal(authorAllWorks.total, 2, "indexed author pages must merge direct sec_uid and canonical owner matches without duplicates");
  assert.equal(authorAllWorks.deletedTotal, 1);
  const authorDeletedWorks = store.listVideos({
    searchParams: new URLSearchParams("source=all&author=MS4wTestAuthor&deleted=1&limit=10&stats=0&facets=0")
  });
  assert.equal(authorDeletedWorks.total, 1, "history minus the latest deduplicated full scan should be filterable");
  assert.equal(authorDeletedWorks.videos[0]?.deletedFromAuthor, true);
  store.recordWatch(galleryId, { progressMs: 600, completed: false });
  store.recordWatch(liveId, { progressMs: 1200, completed: false });
  const historyDb = new DatabaseSync(targetDbPath);
  historyDb.prepare("UPDATE short_video_watch_history SET last_watched_at='2026-07-12T00:00:00.000Z' WHERE video_id=?").run(galleryId);
  historyDb.prepare("UPDATE short_video_watch_history SET last_watched_at='2026-07-12T00:00:01.000Z' WHERE video_id=?").run(liveId);
  historyDb.close();
  const watchedHistory = store.listVideos({
    searchParams: new URLSearchParams("source=history&media=gallery&sort=watched&limit=10&stats=0&facets=0")
  });
  assert.deepEqual(
    watchedHistory.videos.map((item) => item.id),
    [liveId, galleryId],
    "watch-history pages must preserve recency order on the indexed history path"
  );
  const watchedHistoryDetail = store.videoDetail(liveId, {
    searchParams: new URLSearchParams("source=history&media=gallery&sort=watched&neighbors=2&metadata=0")
  });
  assert.equal(watchedHistoryDetail?.nextId, galleryId, "watch-history detail neighbors must reuse the indexed recency cursor");
  store.setUserAction(galleryId, "like", { active: true });
  const manualLikes = store.listVideos({
    searchParams: new URLSearchParams("source=liked&limit=10&stats=0&facets=0")
  });
  assert.equal(manualLikes.total, 2, "manual likes should remain visible alongside imported likes");
  assert.equal(manualLikes.relationshipTotal, 2);
  const targetDb = new DatabaseSync(targetDbPath);
  targetDb.prepare("UPDATE short_videos SET imported_at = '', liked_at = '' WHERE id = ?").run(galleryId);
  targetDb.prepare(`
    UPDATE short_video_source_memberships
    SET first_seen_at = '2026-07-10T19:16:44+08:00'
    WHERE aweme_id = ? AND source_type = 'like'
  `).run(liveId);
  targetDb.close();
  const likedByIngestDesc = store.listVideos({
    searchParams: new URLSearchParams("source=liked&sort=published&limit=10&stats=0&facets=0")
  });
  assert.equal(likedByIngestDesc.sort, "liked", "My Likes descending time should resolve to ingestion order");
  assert.deepEqual(
    likedByIngestDesc.videos.map((item) => item.id),
    [liveId, galleryId],
    "source ingestion time should sort first, with published time filling missing ingestion timestamps"
  );
  const likedByIngestAsc = store.listVideos({
    searchParams: new URLSearchParams("source=liked&sort=publishedAsc&limit=10&stats=0&facets=0")
  });
  assert.equal(likedByIngestAsc.sort, "likedAsc", "My Likes ascending time should use the same ingestion field");
  assert.deepEqual(
    likedByIngestAsc.videos.map((item) => item.id),
    [galleryId, liveId],
    "ascending My Likes order should be the exact reverse of descending ingestion order"
  );
  const likedGalleryDetail = store.videoDetail(liveId, {
    searchParams: new URLSearchParams("source=liked&media=gallery&sort=published&neighbors=2&metadata=0")
  });
  assert.equal(likedGalleryDetail?.nextId, galleryId, "published gallery detail navigation should keep the liked feed order");
  assert.deepEqual(
    likedGalleryDetail?.neighbors?.next?.map((item) => item.id),
    [galleryId],
    "fast gallery detail navigation should return the same visible neighbor records"
  );
  const likedGalleryAscendingDetail = store.videoDetail(galleryId, {
    searchParams: new URLSearchParams("source=liked&media=gallery&sort=publishedAsc&neighbors=2&metadata=0")
  });
  assert.equal(likedGalleryAscendingDetail?.nextId, liveId, "ascending detail navigation should match the liked list order");
  const likedByLikes = store.listVideos({
    searchParams: new URLSearchParams("source=liked&sort=likes&limit=10&stats=0&facets=0")
  });
  assert.deepEqual(
    likedByLikes.videos.map((item) => item.id),
    [liveId, galleryId],
    "likes-sorted My Likes should include imported and manual relationships in metric order"
  );
  const likedByLikesDetail = store.videoDetail(liveId, {
    searchParams: new URLSearchParams("source=liked&sort=likes&neighbors=2&metadata=0")
  });
  assert.equal(
    likedByLikesDetail?.nextId,
    galleryId,
    "likes-sorted My Likes detail navigation should use the same relationship filter and metric order"
  );
  const likedByLikesAdjacent = store.adjacentVideo(liveId, 1, {
    searchParams: new URLSearchParams("source=liked&sort=likes")
  });
  assert.equal(
    likedByLikesAdjacent?.id,
    galleryId,
    "background adjacent prefetch should reuse the fast My Likes metric order"
  );
  const likedByIngestAdjacent = store.adjacentVideo(liveId, 1, {
    searchParams: new URLSearchParams("source=liked&media=gallery&sort=published")
  });
  assert.equal(
    likedByIngestAdjacent?.id,
    galleryId,
    "background adjacent prefetch should reuse the fast My Likes ingestion order"
  );
  const related = store.relatedVideos(liveId, {
    searchParams: new URLSearchParams("limit=10")
  });
  assert.equal(related?.videos[0]?.id, galleryId, "related recommendations should hydrate selected narrow-index candidates");

  store.scan(root);
  const rescannedLive = store.videoDetail(liveId)?.video;
  assert.equal(rescannedLive?.stats?.likes, 13840, "filesystem scans must not replace known statistics with zero placeholders");
  assert.equal(rescannedLive?.stats?.comments, 421);
  const likesAscending = store.listVideos({
    searchParams: new URLSearchParams("source=all&sort=likesAsc&limit=10&stats=0&facets=0")
  });
  assert.equal(likesAscending.videos[0]?.id, liveId, "known low-like statistics should sort before unknown placeholders");
  assert.equal(likesAscending.videos.at(-1)?.id, galleryId, "unknown statistics should sort last instead of masquerading as zero likes");
  const likesDetail = store.videoDetail(liveId, {
    searchParams: new URLSearchParams("source=all&sort=likes&neighbors=2&metadata=0")
  });
  assert.equal(likesDetail?.nextId, galleryId, "likes-sorted detail navigation should use the same metric order as the list");
  const lowestLikesDetail = store.videoDetail(galleryId, {
    searchParams: new URLSearchParams("source=all&sort=likes&neighbors=2&metadata=0")
  });
  assert.equal(lowestLikesDetail?.prevId, liveId, "metric navigation must preserve the previous neighbor at the end of the feed");
  const likesAscendingDetail = store.videoDetail(liveId, {
    searchParams: new URLSearchParams("source=all&sort=likesAsc&neighbors=2&metadata=0")
  });
  assert.equal(likesAscendingDetail?.nextId, galleryId, "ascending likes navigation must keep unknown statistics after known values");
  const sizeDescending = store.listVideos({
    searchParams: new URLSearchParams("source=all&sort=size&limit=10&stats=0&facets=0")
  });
  const expectedSizeOrder = [gallery, live].sort((left, right) => right.size - left.size).map((item) => item.id);
  assert.equal(sizeDescending.sort, "size", "file-size sorting must survive request normalization");
  assert.deepEqual(sizeDescending.videos.map((item) => item.id), expectedSizeOrder, "file-size sorting must order aggregate gallery or video bytes from largest to smallest");
  const largestSizeDetail = store.videoDetail(expectedSizeOrder[0], {
    searchParams: new URLSearchParams("source=all&sort=size&neighbors=2&metadata=0")
  });
  assert.equal(largestSizeDetail?.nextId, expectedSizeOrder[1], "file-size detail navigation must match the list order");
  const publishedAscendingDetail = store.videoDetail(galleryId, {
    searchParams: new URLSearchParams("source=all&sort=publishedAsc&neighbors=2&metadata=0")
  });
  assert.equal(publishedAscendingDetail?.nextId, liveId, "ascending publication navigation must match the list chronology");

  const remoteImport = store.importRemoteComments(liveId, [{
    cid: "comment-1",
    text: "远程评论测试",
    create_time: Math.floor(Date.parse("2026-07-14T00:00:00.000Z") / 1000),
    digg_count: 12,
    reply_comment_total: 3,
    ip_label: "浙江",
    user: {
      uid: "user-1",
      sec_uid: "sec-user-1",
      nickname: "评论用户",
      avatar_thumb: { url_list: ["https://example.com/avatar.jpg"] }
    }
  }], { availableTotal: 321 });
  assert.equal(remoteImport.imported, 1, "remote comment sync should import fetched Douyin comments");
  assert.equal(remoteImport.remoteTotal, 1);
  assert.equal(remoteImport.remoteComments[0]?.body, "远程评论测试");
  assert.equal(remoteImport.remoteComments[0]?.likes, 12);
  assert.equal(remoteImport.remoteComments[0]?.replyCount, 3);
  assert.equal(remoteImport.remoteComments[0]?.userName, "评论用户");
  const localComment = store.createLocalComment(liveId, { body: "本地评论测试" });
  assert.equal(localComment.comments[0]?.body, "本地评论测试", "local comments must remain separate from synced Douyin comments");
  assert.equal(localComment.remoteTotal, 1);

  const distributionDb = new DatabaseSync(targetDbPath);
  distributionDb.prepare(`
    INSERT INTO short_videos (
      id, aweme_id, visibility, title, source_path, metadata_json,
      author_sec_uid, author_name, is_liked, size_bytes, duration_ms,
      digg_count, actual_width, actual_height, actual_codec, actual_frame_rate,
      actual_pixels, actual_long_edge
    ) VALUES (?, ?, 'local_only', '点赞分布测试视频', ?, '{}',
      'MS4wDistributionAuthor', '分布测试作者', 1, 4096, 12000,
      750000, 2160, 3840, 'hevc', 60, 8294400, 3840)
  `).run("distribution-video", "distribution-video", path.join(root, "distribution-video.mp4"));
  distributionDb.prepare(`
    INSERT INTO short_video_assets (id, video_id, asset_type, local_path)
    VALUES (?, ?, 'video', ?)
  `).run("distribution-video:video", "distribution-video", path.join(root, "distribution-video.mp4"));
  distributionDb.close();
  const videoOnly = store.listVideos({
    searchParams: new URLSearchParams("source=all&media=video&sort=published&limit=10&stats=0&facets=0")
  });
  assert.deepEqual(videoOnly.videos.map((item) => item.id), ["distribution-video"], "indexed video assets should drive the video-only filter");
  assert.equal(videoOnly.videos[0]?.actualVideo?.codec, "hevc", "stored codec must be exposed to the playback client");
  assert.equal(videoOnly.videos[0]?.actualVideo?.frameRate, 60, "stored frame rate must be exposed to the playback client");
  const distributionFile = store.videoFile("distribution-video", { allowMissing: true });
  assert.equal(distributionFile?.actualCodec, "hevc", "video file lookup must carry codec metadata into the smooth-cache queue");
  assert.equal(distributionFile?.actualFrameRate, 60, "video file lookup must carry frame rate metadata into the smooth-cache queue");
  store.updateActualVideoPlaybackMetadata("distribution-video", { codec: "h264", frameRate: 30, width: 2160, height: 3840, bitRate: 8000000 });
  assert.equal(store.videoDetail("distribution-video")?.video?.actualVideo?.codec, "h264", "runtime probe results must persist back to short_videos");
  const smoothCandidateDb = new DatabaseSync(targetDbPath);
  smoothCandidateDb.prepare(`
    INSERT INTO short_videos (
      id, aweme_id, visibility, media_type, title, source_path, metadata_json,
      digg_count, mtime_ms, size_bytes, actual_width, actual_height,
      actual_codec, actual_frame_rate, actual_pixels, actual_long_edge
    ) VALUES (?, ?, 'local_only', 'video', '长边平滑播放测试', ?, '{}', 800000, 1234, 4096, 1080, 2160, 'hevc', 60, 2332800, 2160)
  `).run("smooth-long-edge-video", "smooth-long-edge-video", path.join(root, "smooth-long-edge-video.mp4"));
  smoothCandidateDb.close();
  assert.equal(store.smoothPlaybackCandidateCount(), 0, "resolution and codec alone must not create transcode candidates");
  assert.equal(store.smoothPlaybackCandidates(10).length, 0, "unobserved videos must stay out of the transcode queue");
  assert.equal(store.reportSmoothPlaybackIssue("smooth-long-edge-video", "first-frame-timeout"), true);
  const smoothCandidates = store.smoothPlaybackCandidates(10);
  assert.deepEqual(smoothCandidates.map((item) => item.id), ["smooth-long-edge-video"], "only videos with an observed playback issue may enter the transcode queue");
  assert.equal(smoothCandidates[0]?.actualVideo?.longEdge, 2160);
  assert.match(smoothCandidates[0]?.streamUrl || "", /v=1234$/);
  assert.equal(store.smoothPlaybackCandidateCount(), 1);
  assert.equal(store.smoothPlaybackCandidates(1, 1).length, 0, "observed playback issue pages must remain bounded");
  const smoothCandidateCleanupDb = new DatabaseSync(targetDbPath);
  smoothCandidateCleanupDb.prepare("DELETE FROM short_videos WHERE id = ?").run("smooth-long-edge-video");
  smoothCandidateCleanupDb.close();
  const galleryOnly = store.listVideos({
    searchParams: new URLSearchParams("source=all&media=gallery&sort=published&limit=10&stats=0&facets=0")
  });
  assert.equal(galleryOnly.videos.some((item) => item.id === "distribution-video"), false, "gallery filtering must exclude indexed video assets");
  const unknownQualityVideos = store.listVideos({
    searchParams: new URLSearchParams("source=all&quality=unknown&sort=published&limit=10&stats=0&facets=0")
  });
  assert.equal(unknownQualityVideos.total, 0, "unknown video quality must not accidentally include galleries");
  const comparisonDb = new DatabaseSync(targetDbPath);
  comparisonDb.prepare(`
    INSERT INTO short_videos (
      id, aweme_id, visibility, media_type, title, source_path, metadata_json,
      author_sec_uid, author_name, is_liked, size_bytes, duration_ms,
      digg_count, comment_count, collect_count, share_count,
      actual_width, actual_height, actual_pixels, actual_long_edge
    ) VALUES (
      'distribution-other', 'distribution-other', 'local_only', 'video', '同作者其他作品', ?, '{}',
      'MS4wDistributionAuthor', '分布测试作者', 0, 2048, 20000,
      30000, 300, 3000, 1500, 1080, 1920, 2073600, 1920
    )
  `).run(path.join(root, "distribution-other.mp4"));
  comparisonDb.close();
  store.setUserAction("distribution-video", "like", { active: true });
  store.recordWatch("distribution-video", { progressMs: 12000, completed: true });
  const distribution = store.likeDistribution();
  assert.equal(distribution.total, 2, "like distribution must count videos but exclude galleries");
  assert.equal(Object.prototype.hasOwnProperty.call(distribution, "fourKTotal"), false, "likes density should no longer carry a redundant 4K total");
  assert.equal(distribution.bins.some((item) => Object.prototype.hasOwnProperty.call(item, "fourKCount")), false, "likes-density bins should not mix in file-quality counts");
  assert.equal(distribution.bins.length, 33, "multiscale like distribution should keep low-like detail without flooding the tail");
  assert.deepEqual(distribution.bins.slice(0, 10).map((item) => item.label), ["0-1千", "1-2千", "2-3千", "3-4千", "4-5千", "5-6千", "6-7千", "7-8千", "8-9千", "9千-1万"]);
  assert.deepEqual(distribution.bins.slice(10, 19).map((item) => item.label), ["1-2万", "2-3万", "3-4万", "4-5万", "5-6万", "6-7万", "7-8万", "8-9万", "9-10万"]);
  assert.equal(distribution.bins.find((item) => item.minLikes === 700000)?.videoCount, 1, "750k likes must land in the 70-80万 bin");
  assert.equal(distribution.shape, "right_skewed_long_tail");
  assert.equal(distribution.binning?.boundary, "[min,max)", "distribution boundaries must be explicit and non-overlapping");
  assert.equal(distribution.binning?.microBinWidth, 1000);
  assert.equal(distribution.binning?.lowBinWidth, 10000);
  assert.equal(distribution.binning?.denseBinWidth, 100000);
  assert.equal(distribution.binning?.tailBinWidth, 1000000);
  assert.equal(distribution.insights?.valueMap?.eligibleTotal, 2, "content insights must include every video with known interaction data");
  assert.equal(distribution.insights?.valueMap?.ratioComparableTotal, 2, "videos with likes must contribute to the interaction-structure comparison");
  assert.equal(
    distribution.insights?.valueMap?.cells?.reduce((total, item) => total + Number(item.count || 0), 0),
    2,
    "the structure-map cells must preserve the complete ratio-comparable sample"
  );
  assert.equal(distribution.insights?.valueMap?.types?.reduce((total, item) => total + Number(item.count || 0), 0), 2, "interaction-type totals must preserve the comparable sample");
  assert.equal(Object.prototype.hasOwnProperty.call(distribution.insights || {}, "highRes"), false, "content analytics must not infer quality-upgrade work from local pixel dimensions");
  assert.equal(distribution.insights?.personal?.authorEfficiency?.likedVideos, 1, "personal author efficiency must use explicit likes as hits");
  assert.equal(distribution.insights?.personal?.preferenceComparison?.comparableAuthorTotal, 1, "personal comparisons must stay within authors that have liked and other works");
  assert.equal(distribution.insights?.personal?.watch?.watchedTotal, 1);
  assert.equal(distribution.insights?.personal?.watch?.completedTotal, 1, "watch completion must mean at least one completed play");
  assert.equal(distribution.insights?.health?.likesCoverageRate, 1);
  assert.equal(distribution.insights?.health?.qualityCoverageRate, 1);
  assert.equal(distribution.insights?.health?.playCoverageRate, 0);
  assert.equal(distribution.insights?.health?.qualityAudit?.available, true);
  assert.equal(distribution.insights?.health?.qualityAudit?.alreadyHighest, 1);
  assert.equal(distribution.insights?.health?.qualityAudit?.upgradePassed, 1);
  assert.equal(distribution.insights?.method?.limitation, "当前没有播放量，不能计算官方口径的互动率、完播率或流量转化");
  const cursorDb = new DatabaseSync(targetDbPath);
  const insertCursorVideoSql = `
    INSERT INTO short_videos (
      id, aweme_id, visibility, media_type, title, source_path, metadata_json,
      digg_count, liked_at, actual_width, actual_height, actual_pixels, actual_long_edge
    ) VALUES (?, ?, 'local_only', 'video', ?, ?, '{}', ?, ?, 2160, 3840, 8294400, 3840)
  `;
  cursorDb.prepare(insertCursorVideoSql).run("cursor-high", "cursor-high", "游标高赞", path.join(root, "cursor-high.mp4"), 900000, "2026-07-15T00:00:00.000Z");
  cursorDb.prepare(insertCursorVideoSql).run("cursor-low", "cursor-low", "游标低赞", path.join(root, "cursor-low.mp4"), 700000, "2026-07-14T00:00:00.000Z");
  cursorDb.close();
  const cursorFirstPage = store.listVideos({
    searchParams: new URLSearchParams("source=all&media=video&quality=4k&sort=likes&limit=2&stats=0&facets=0")
  });
  assert.deepEqual(cursorFirstPage.videos.map((item) => item.id), ["cursor-high", "distribution-video"]);
  assert.equal(cursorFirstPage.total, 3);
  assert.ok(cursorFirstPage.nextCursor, "likes pagination must expose an opaque stable cursor");
  const cursorMutationDb = new DatabaseSync(targetDbPath);
  cursorMutationDb.prepare(`
    INSERT INTO short_videos (
      id, aweme_id, visibility, media_type, title, source_path, metadata_json,
      digg_count, liked_at, actual_width, actual_height, actual_pixels, actual_long_edge
    ) VALUES (?, ?, 'local_only', 'video', '游标期间新增高赞', ?, '{}', 950000, '2026-07-16T00:00:00.000Z', 2160, 3840, 8294400, 3840)
  `).run("cursor-new-top", "cursor-new-top", path.join(root, "cursor-new-top.mp4"));
  cursorMutationDb.close();
  const cursorSecondPage = store.listVideos({
    searchParams: new URLSearchParams(`source=all&media=video&quality=4k&sort=likes&limit=2&stats=0&facets=0&cursor=${encodeURIComponent(cursorFirstPage.nextCursor)}`)
  });
  assert.deepEqual(cursorSecondPage.videos.map((item) => item.id), ["cursor-low"], "a newly measured high-like video must not shift or duplicate the active pagination session");
  assert.equal(cursorSecondPage.total, 3, "cursor pages must retain the initial quality-filtered total");
  assert.equal(cursorSecondPage.hasMore, false);
  const cursorCleanupDb = new DatabaseSync(targetDbPath);
  cursorCleanupDb.prepare("DELETE FROM short_videos WHERE id IN ('cursor-high', 'cursor-low', 'cursor-new-top')").run();
  cursorCleanupDb.close();
  const workerSync = await runSyncWorker({
    dbPath: targetDbPath,
    ffmpegPath: "ffmpeg",
    roots: [root],
    sourceDbPath
  });
  assert.equal(workerSync?.ok, true, "download-manager synchronization should run outside the request thread");

  explicitStore = createShortVideoStore({
    dbPath: targetDbPath,
    downloadManagerDbPath: followingManagerDbPath,
    roots: [root],
    skipStartupMaintenance: true,
    trustExplicitInvalidation: true
  });
  explicitStore.warm({ recommendations: true });
  const explicitAuthorTotal = explicitStore.listAuthors({
    searchParams: new URLSearchParams("limit=240")
  }).total;
  const externalCatalogDb = new DatabaseSync(targetDbPath);
  externalCatalogDb.prepare(`
    INSERT INTO short_videos (
      id, aweme_id, visibility, media_type, title, author_sec_uid, author_name,
      source_path, metadata_json, digg_count
    ) VALUES (?, ?, 'local_only', 'video', '显式失效测试', ?, '显式失效作者', ?, '{}', 1)
  `).run("explicit-invalidation-video", "explicit-invalidation-video", "explicit-author", path.join(root, "explicit-invalidation-video.mp4"));
  externalCatalogDb.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('download_manager_imported_at', ?)")
    .run("2099-01-01T00:00:00.000Z");
  externalCatalogDb.close();
  assert.equal(explicitStore.listAuthors({ searchParams: new URLSearchParams("limit=240") }).total, explicitAuthorTotal, "explicitly invalidated stores must keep their coherent warm snapshot until reset");
  explicitStore.close();
  explicitStore = createShortVideoStore({
    dbPath: targetDbPath,
    downloadManagerDbPath: followingManagerDbPath,
    roots: [root],
    skipStartupMaintenance: true,
    trustExplicitInvalidation: true
  });
  explicitStore.warm({ recommendations: true });
  const refreshedAuthors = explicitStore.listAuthors({ searchParams: new URLSearchParams("q=显式失效作者&limit=240") });
  assert.equal(refreshedAuthors.total, 1, "closing and warming after an explicit reset must expose the new catalog snapshot");
  assert.equal(JSON.stringify(refreshedAuthors).includes("_searchText"), false, "normalized author search indexes must remain private in API payloads");

  const singleWriterRoot = path.join(tempDir, "single-writer");
  const singleWriterMedia = path.join(singleWriterRoot, "actual-video.mp4");
  const singleWriterSourceDbPath = path.join(tempDir, "single-writer-manager.sqlite");
  const singleWriterTargetDbPath = path.join(tempDir, "single-writer-fanhao.sqlite");
  fs.mkdirSync(singleWriterRoot, { recursive: true });
  fs.writeFileSync(singleWriterMedia, Buffer.from("actual-video"));
  const singleWriterSource = new DatabaseSync(singleWriterSourceDbPath);
  singleWriterSource.exec(`
    CREATE TABLE profiles (
      id INTEGER PRIMARY KEY,
      tab TEXT,
      sec_uid TEXT,
      url TEXT,
      nickname TEXT,
      profile_collected_at TEXT,
      updated_at TEXT,
      account_status TEXT NOT NULL DEFAULT 'active',
      account_status_reason TEXT,
      account_status_detected_at TEXT
    );
    CREATE TABLE links (
      id INTEGER PRIMARY KEY,
      profile_id INTEGER,
      aweme_id TEXT,
      status TEXT,
      kind TEXT,
      media_type TEXT,
      output_dir TEXT,
      local_file_paths TEXT,
      downloaded_at TEXT,
      actual_width INTEGER,
      actual_height INTEGER,
      actual_bit_rate INTEGER,
      actual_codec TEXT,
      actual_frame_rate REAL,
      actual_pixels INTEGER,
      actual_long_edge INTEGER,
      actual_probed_at TEXT,
      actual_probe_error TEXT,
      digg_count INTEGER,
      comment_count INTEGER,
      collect_count INTEGER,
      share_count INTEGER
    );
  `);
  singleWriterSource.prepare(`
    INSERT INTO profiles (
      id, tab, sec_uid, url, nickname, profile_collected_at, updated_at
    ) VALUES (
      1, 'like', 'single-writer-author', '', '单写作者',
      '2026-07-16T12:00:00+08:00', '2026-07-16T12:00:00+08:00'
    )
  `).run();
  singleWriterSource.prepare(`
    INSERT INTO links (
      id, profile_id, aweme_id, status, kind, media_type, output_dir,
      local_file_paths, downloaded_at, actual_width, actual_height, actual_bit_rate,
      actual_codec, actual_frame_rate, actual_pixels, actual_long_edge,
      actual_probed_at, actual_probe_error
    ) VALUES (1, 1, 'single-writer-video', 'downloaded', 'video', 'video', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')
  `).run(
    singleWriterRoot,
    JSON.stringify([singleWriterMedia]),
    "2026-07-16T12:00:00+08:00",
    2160,
    3840,
    8_000_000,
    "hevc",
    60,
    8_294_400,
    3840,
    "2026-07-16T12:00:01+08:00"
  );
  singleWriterSource.close();
  const singleWriterStore = createShortVideoStore({
    dbPath: singleWriterTargetDbPath,
    downloadManagerDbPath: singleWriterSourceDbPath,
    roots: [singleWriterRoot],
    skipStartupMaintenance: true
  });
  try {
    const importResult = singleWriterStore.importDownloadManagerDb(singleWriterSourceDbPath, { incremental: true });
    assert.equal(importResult.imported, 1, "the Node sync boundary must own manager-to-catalog writes");
    const importedActual = singleWriterStore.videoDetail("single-writer-video")?.video?.actualVideo;
    assert.deepEqual(
      importedActual,
      {
        width: 2160,
        height: 3840,
        bitRate: 8_000_000,
        codec: "hevc",
        frameRate: 60,
        pixels: 8_294_400,
        longEdge: 3840,
        probedAt: "2026-07-16T12:00:01+08:00",
        probeError: ""
      },
      "the manager-owned probe metadata must cross the single-writer import boundary intact"
    );

    let catalogChangeCalls = 0;
    let itemImportCalls = 0;
    const observedSync = createDownloadManagerSyncService({
      sourceDbPath: singleWriterSourceDbPath,
      intervalMs: 60_000,
      dbPath: singleWriterTargetDbPath,
      ffmpegPath: "ffmpeg",
      roots: [singleWriterRoot],
      onCatalogChanged: () => {
        catalogChangeCalls += 1;
      },
      onItemsImported: () => {
        itemImportCalls += 1;
      }
    });
    try {
      const noOpSync = await observedSync.sync({ force: true });
      assert.equal(noOpSync?.profilesSeen, 1);
      assert.equal(noOpSync?.profilesChanged, 0);
      assert.equal(noOpSync?.membershipsChanged, 0);
      assert.equal(noOpSync?.catalogChanges, 0);
      assert.equal(noOpSync?.catalogChanged, false);
      assert.equal(catalogChangeCalls, 0, "a forced no-op sync must not reset the catalog worker");
      assert.equal(itemImportCalls, 0);

      const changedProfileDb = new DatabaseSync(singleWriterSourceDbPath);
      changedProfileDb.prepare(`
        UPDATE profiles
        SET nickname = '刷新后的单写作者',
            profile_collected_at = '2026-07-17T12:00:00+08:00',
            updated_at = '2026-07-17T12:00:00+08:00',
            account_status = 'banned',
            account_status_reason = '测试封禁',
            account_status_detected_at = '2026-07-17T12:05:00+08:00'
        WHERE id = 1
      `).run();
      changedProfileDb.close();

      const changedProfileSync = await observedSync.sync({ force: true });
      assert.equal(changedProfileSync?.profilesSeen, 1);
      assert.ok(changedProfileSync?.profilesChanged > 0);
      assert.equal(changedProfileSync?.membershipsChanged, 0);
      assert.equal(changedProfileSync?.catalogChanged, true);
      assert.equal(catalogChangeCalls, 1, "nickname and account-state changes must reset the catalog exactly once");
      assert.equal(itemImportCalls, 0, "profile-only changes must not be reported as imported videos");

      const repeatedProfileSync = await observedSync.sync({ force: true });
      assert.equal(repeatedProfileSync?.profilesChanged, 0);
      assert.equal(repeatedProfileSync?.catalogChanged, false);
      assert.equal(catalogChangeCalls, 1, "repeating the same profile state must not reset the catalog again");

      const membershipOnlyDb = new DatabaseSync(singleWriterSourceDbPath);
      membershipOnlyDb.prepare(`
        INSERT INTO profiles (
          id, tab, sec_uid, url, nickname, profile_collected_at, updated_at
        ) VALUES (
          2, 'post', 'single-writer-author', '', '刷新后的单写作者',
          '2026-07-15T12:00:00+08:00', '2026-07-15T12:00:00+08:00'
        )
      `).run();
      membershipOnlyDb.prepare(`
        INSERT INTO links (id, profile_id, aweme_id, status, kind, media_type)
        VALUES (2, 2, 'single-writer-video', 'pending', 'video', 'video')
      `).run();
      membershipOnlyDb.close();

      const membershipOnlySync = await observedSync.sync({ force: true });
      assert.equal(membershipOnlySync?.incrementalRows, 0, "a pending membership must not masquerade as a downloaded video update");
      assert.equal(membershipOnlySync?.profilesChanged, 0);
      assert.ok(membershipOnlySync?.membershipsChanged > 0);
      assert.equal(membershipOnlySync?.catalogChanged, true);
      assert.equal(catalogChangeCalls, 2, "membership-only changes must still reset the catalog exactly once");
      assert.equal(itemImportCalls, 0);
    } finally {
      await observedSync.stop();
    }
  } finally {
    singleWriterStore.close();
  }

  console.log("short-video-store: ok");
} finally {
  explicitStore?.close();
  store?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
