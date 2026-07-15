import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import { createDownloadManagerSyncService } from "../src/modules/short-videos/server/download-manager-sync-service.js";

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
assert.ok(shortVideoStoreSource.split(/\r?\n/).length <= 5200, "short-video store exceeded its refactored 5200-line budget");
assert.ok(shortVideoImportItemMapperSource.split(/\r?\n/).length <= 650, "short-video import item mapper exceeded its 650-line budget");
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
  `);
  followingManagerDb.prepare(`
    INSERT INTO profiles (id, sec_uid, tab, is_following, following_discovered_at, updated_at)
    VALUES (1, 'MS4wTestAuthor', 'post', 1, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `).run();
  followingManagerDb.prepare(`
    INSERT INTO profiles (id, sec_uid, tab, is_following, following_discovered_at, updated_at)
    VALUES (2, 'MS4wNoLikedVideos', 'post', 1, '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z')
  `).run();
  followingManagerDb.close();

  store = createShortVideoStore({
    dbPath: targetDbPath,
    downloadManagerDbPath: followingManagerDbPath,
    roots: [root]
  });
  const scan = store.scan(root);
  assert.equal(scan.imported, 1, "pure image gallery should be imported by the filesystem scanner");
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
    images: [{ width: 1080, height: 1920, live_photo_type: 1 }, { width: 1080, height: 1440 }],
    music: { id_str: "music-test", title: "测试背景音乐", author: "测试作者" },
    author: { sec_uid: "MS4wTestAuthor", nickname: "测试作者" }
  }));

  const sourceDb = new DatabaseSync(sourceDbPath);
  sourceDb.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY, tab TEXT, sec_uid TEXT, url TEXT);
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
      digg_count INTEGER,
      comment_count INTEGER,
      collect_count INTEGER,
      share_count INTEGER
    );
  `);
  sourceDb.prepare("INSERT INTO profiles (id, tab, sec_uid, url) VALUES (1, 'like', 'MS4wTestAuthor', '')").run();
  sourceDb.prepare("INSERT INTO profiles (id, tab, sec_uid, url) VALUES (2, 'post', 'MS4wTestAuthor', '')").run();
  sourceDb.prepare(`
    INSERT INTO links (
      id, profile_id, aweme_id, status, kind, media_type, output_dir,
      local_file_paths, downloaded_at, digg_count, comment_count, collect_count, share_count
    ) VALUES (1, 1, ?, 'downloaded', 'note', 'gallery', ?, ?, '2026-07-10T19:16:44+08:00', 0, 0, 0, 0)
  `).run(liveId, liveDir, JSON.stringify([liveImage, liveImage2, liveVideo, liveMusic, liveData]));
  sourceDb.prepare(`
    INSERT INTO links (
      id, profile_id, aweme_id, status, kind, media_type, output_dir,
      local_file_paths, downloaded_at, digg_count, comment_count, collect_count, share_count
    ) VALUES (2, 2, ?, 'downloaded', 'note', 'gallery', ?, ?, '2026-07-11T10:00:00+08:00', 12840, 321, 456, 78)
  `).run(liveId, liveDir, JSON.stringify([liveImage, liveImage2, liveVideo, liveMusic, liveData]));
  sourceDb.close();

  store.importDownloadManagerDb(sourceDbPath, { incremental: true, includePosts: true });
  const live = store.videoDetail(liveId)?.video;
  assert.equal(live?.mediaType, "gallery", "a note with an image and live MP4 should stay an ordered mixed gallery");
  assert.equal(live?.galleryCount, 3);
  assert.deepEqual(live?.galleryItems.map((item) => item.type), ["image", "video", "image"]);
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
  assert.equal(rescannedLive?.stats?.likes, 12840, "filesystem scans must not replace known statistics with zero placeholders");
  assert.equal(rescannedLive?.stats?.comments, 321);
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
      digg_count, actual_width, actual_height, actual_codec, actual_frame_rate,
      actual_pixels, actual_long_edge
    ) VALUES (?, ?, 'local_only', '点赞分布测试视频', ?, '{}', 750000, 2160, 3840, 'hevc', 60, 8294400, 3840)
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
  const smoothCandidates = store.smoothPlaybackCandidates(10);
  assert.deepEqual(smoothCandidates.slice(0, 2).map((item) => item.id), ["smooth-long-edge-video", "distribution-video"], "smooth playback candidates must include non-4K pixel bands using the same long-edge threshold and preserve like order");
  assert.equal(smoothCandidates[0]?.actualVideo?.longEdge, 2160);
  assert.match(smoothCandidates[0]?.streamUrl || "", /v=1234$/);
  assert.equal(store.smoothPlaybackCandidateCount(), 2);
  assert.equal(store.smoothPlaybackCandidates(1, 1)[0]?.id, "distribution-video", "smooth playback candidate pagination must continue past the bounded runtime backlog");
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
  const distribution = store.likeDistribution();
  assert.equal(distribution.total, 1, "like distribution must count videos but exclude galleries");
  assert.equal(distribution.fourKTotal, 1);
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
  assert.equal(distribution.insights?.valueMap?.eligibleTotal, 1, "content insights must include every video with known interaction data");
  assert.equal(distribution.insights?.valueMap?.ratioComparableTotal, 1, "videos with likes must contribute to the interaction-structure comparison");
  assert.equal(
    distribution.insights?.valueMap?.cells?.reduce((total, item) => total + Number(item.count || 0), 0),
    1,
    "the structure-map cells must preserve the complete ratio-comparable sample"
  );
  assert.equal(distribution.insights?.valueMap?.types?.reduce((total, item) => total + Number(item.count || 0), 0), 1, "interaction-type totals must preserve the comparable sample");
  assert.equal(Object.prototype.hasOwnProperty.call(distribution.insights || {}, "highRes"), false, "content analytics must not infer quality-upgrade work from local pixel dimensions");
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
    CREATE TABLE profiles (id INTEGER PRIMARY KEY, tab TEXT, sec_uid TEXT, url TEXT);
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
  singleWriterSource.prepare("INSERT INTO profiles (id, tab, sec_uid, url) VALUES (1, 'like', 'single-writer-author', '')").run();
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
  } finally {
    singleWriterStore.close();
  }

  console.log("short-video-store: ok");
} finally {
  explicitStore?.close();
  store?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
