import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-video-store-"));
const root = path.join(tempDir, "likes");
const authorDir = path.join(root, "测试作者_MS4wTestAuthor");
const galleryId = "7660219617974484837";
const liveId = "7660744527430769851";
const galleryDir = path.join(authorDir, `2026-07-09_测试图集_${galleryId}`);
const liveDir = path.join(authorDir, `2026-07-10_测试实况_${liveId}`);
const targetDbPath = path.join(tempDir, "short-videos.sqlite");
const sourceDbPath = path.join(tempDir, "douyin-downloads.sqlite");
let store;

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

  store = createShortVideoStore({ dbPath: targetDbPath, roots: [root] });
  const scan = store.scan(root);
  assert.equal(scan.imported, 1, "pure image gallery should be imported by the filesystem scanner");
  const gallery = store.videoDetail(galleryId)?.video;
  assert.equal(gallery?.mediaType, "gallery");
  assert.equal(gallery?.galleryCount, 3);
  assert.equal(gallery?.stats?.known, false, "all-zero placeholder statistics should be exposed as unknown");
  assert.deepEqual(gallery?.galleryItems.map((item) => item.type), ["image", "image", "image"]);
  assert.equal(store.galleryFile(galleryId, 2)?.path, galleryPaths[2]);
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
  const importedLikes = store.listVideos({
    searchParams: new URLSearchParams("source=liked&limit=10&stats=0&facets=0")
  });
  assert.equal(importedLikes.total, 1, "only the downloader like profile should populate My Likes");
  assert.equal(importedLikes.relationshipTotal, 1);
  assert.equal(importedLikes.videos[0]?.id, liveId);
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

  store.scan(root);
  const rescannedLive = store.videoDetail(liveId)?.video;
  assert.equal(rescannedLive?.stats?.likes, 12840, "filesystem scans must not replace known statistics with zero placeholders");
  assert.equal(rescannedLive?.stats?.comments, 321);
  const likesAscending = store.listVideos({
    searchParams: new URLSearchParams("source=all&sort=likesAsc&limit=10&stats=0&facets=0")
  });
  assert.equal(likesAscending.videos[0]?.id, liveId, "known low-like statistics should sort before unknown placeholders");
  assert.equal(likesAscending.videos.at(-1)?.id, galleryId, "unknown statistics should sort last instead of masquerading as zero likes");

  console.log("short-video-store: ok");
} finally {
  store?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
