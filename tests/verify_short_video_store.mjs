import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createVerificationAdvisories } from "./verification_advisories.mjs";
import { installFixtureSyncJournal } from "./fixtures/short-video-sync-journal.mjs";

import { SQLITE_SHORT_VIDEO_COVER_SOURCE } from "../src/modules/short-videos/server/cover-database.js";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import { createDownloadManagerSyncService } from "../src/modules/short-videos/server/download-manager-sync-service.js";
import { createShortVideoPublicVideoMapper, shortVideoStatisticsKnown } from "../src/modules/short-videos/server/public-video-mapper.js";
import { createShortVideoListPageQueries } from "../src/modules/short-videos/server/list-page-queries.js";
import * as navigationQueries from "../src/modules/short-videos/server/navigation-queries.js";
import { videoFilter } from "../src/modules/short-videos/server/query-contract.js";

const shortVideoStoreSource = fs.readFileSync(new URL("../src/modules/short-videos/server/store.js", import.meta.url), "utf8");
const advisories = createVerificationAdvisories("short-video-store");
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
advisories.check(shortVideoStoreSource.split(/\r?\n/).length <= 4950, "short-video store is over 4950 lines; review its responsibilities");
advisories.check(shortVideoImportItemMapperSource.split(/\r?\n/).length <= 650, "short-video import item mapper is over 650 lines; review its responsibilities");
advisories.check(shortVideoPublicVideoMapperSource.split(/\r?\n/).length <= 280, "short-video public video mapper is over 280 lines; review its responsibilities");
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

await verifyNavigationListOrder();
if (process.argv.includes("--navigation-only")) {
  console.log("short-video-store: navigation-only ok");
  process.exit(0);
}
await verifySuggestionQueryBudget();
await verifyFallbackCountQueries();

async function verifySuggestionQueryBudget() {
  const moduleUrl = new URL("../src/modules/short-videos/server/store.js", import.meta.url);
  const normalizedSource = shortVideoStoreSource.replace(/\r\n/g, "\n");
  const start = normalizedSource.indexOf("  function searchSuggestions(");
  const end = normalizedSource.indexOf("\nfunction summary()", start);
  assert(start >= 0 && end > start, "actual suggestion implementation must be discoverable");
  const actualFunction = normalizedSource.slice(start, end);
  const fallbackStart = actualFunction.indexOf("    const authorWhere = author ?");
  assert(fallbackStart > 0, "restore only the LIKE fallback for the old response oracle");
  const prefix = actualFunction.slice(0, fallbackStart);
  let fallback = actualFunction.slice(fallbackStart);
  const guard = "    if (suggestions.length >= limit) return { query, media, author, suggestions };\n";
  assert.equal(fallback.split(guard).length, 3, "both deferred stages must be available for the old eager negative control");
  const tagStart = fallback.indexOf("    const tagRows = database.prepare(");
  const tagEnd = fallback.indexOf("    const tagCounts = new Map();", tagStart);
  const titleStart = fallback.indexOf("    const titleRows = database.prepare(");
  const titleEnd = fallback.indexOf("    for (const row of titleRows)", titleStart);
  assert(tagStart >= 0 && tagEnd > tagStart && titleStart > tagEnd && titleEnd > titleStart);
  const tagSql = fallback.slice(tagStart, tagEnd);
  const titleSql = fallback.slice(titleStart, titleEnd);
  fallback = fallback.replace(titleSql, "").replace(tagSql, "").replaceAll(guard, "");
  fallback = fallback.replace("    const suggestions = [];", `${tagSql}${titleSql}    const suggestions = [];`);
  const oldSource = normalizedSource.replace(actualFunction, prefix + fallback)
    .replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, relative) => `from ${JSON.stringify(new URL(relative, moduleUrl).href)}`);
  const { createShortVideoStore: createOldStore } = await import(`data:text/javascript;base64,${Buffer.from(oldSource).toString("base64")}`);
  const createTestedStore = process.argv.includes("--legacy-suggestion-eager") ? createOldStore : createShortVideoStore;
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalParse = JSON.parse;
  let capturedDatabase;
  let observing = false;
  let sqlReads = [];
  let parses = 0;
  DatabaseSync.prototype.prepare = function(sql) {
    capturedDatabase = this;
    const statement = originalPrepare.call(this, sql);
    if (!observing) return statement;
    const kind = sql.includes("short_video_search MATCH") ? "fts"
      : sql.includes("SELECT tags_json") ? "tags"
      : sql.includes("SELECT title, author_name") ? "titles"
      : sql.includes("author_name AS label") ? "authors"
      : sql.includes("SUM(video_count)") ? "indexedAuthors" : "other";
    return new Proxy(statement, {
      get(target, key) {
        const value = target[key];
        if (typeof value !== "function") return value;
        return (...args) => {
          const result = value.apply(target, args);
          if (key === "all" || key === "get") sqlReads.push({ kind, rows: Array.isArray(result) ? result.length : result ? 1 : 0 });
          return result;
        };
      }
    });
  };
  JSON.parse = function(...args) {
    if (observing) parses++;
    return originalParse.apply(this, args);
  };
  const unopenedCoverPath = path.join(os.tmpdir(), `fanhao-suggestions-unopened-${process.pid}.sqlite`);
  const options = { dbPath: ":memory:", coverDbPath: unopenedCoverPath, roots: [], skipStartupMaintenance: true, trustExplicitInvalidation: true, coverGenerateLimit: 0 };
  let store;
  let oldStore;
  let checks = 0;
  const count = 3000;
  try {
    assert(!fs.existsSync(unopenedCoverPath), "suggestion setup must never reuse an existing cover database");
    store = createTestedStore(options);
    store.prepareSchema();
    const db = capturedDatabase;
    oldStore = createOldStore(options);
    oldStore.prepareSchema();
    const oldDb = capturedDatabase;
    const databases = [db, oldDb];
    const insertSql = "INSERT INTO short_videos(id,aweme_id,owner_user_id,author_sec_uid,author_name,title,tags_json,tags_text,source_path,published_at,media_type,visibility) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)";
    function insertVideo(database, { id, author = "privateAuthor", name = "Legacy Creator", title = `美食 标题 ${id}`, tags = [], media = "video", published = "zzzzzzz", visibility = "local_only" }) {
      database.prepare(insertSql).run(id, `aw:${id}`, "private-user", author, name, title, JSON.stringify(tags), tags.join(" "), `synthetic-${id}.mp4`, published, media, visibility);
    }
    const tags = ["美食烹饪", "美食家常", "美食探店", "美食甜品", "美食烧烤", "美食面食", "美食素食", "美食汤饭"];
    for (const database of databases) {
      database.exec("BEGIN");
      database.prepare("INSERT INTO short_video_users(id,sec_uid,nickname) VALUES('private-user','privateAuthor','Current Creator')").run();
      for (let i = 0; i < count; i++) insertVideo(database, { id: `v${i}`, tags, media: i % 5 === 0 ? "gallery" : "video", published: String(i).padStart(6, "0") });
      insertVideo(database, { id: "pending", tags, published: "zzzzzzzzz", visibility: "download_pending" });
      database.exec("COMMIT");
    }
    function run(owner, params) {
      sqlReads = [];
      parses = 0;
      observing = true;
      try {
        const response = owner.searchSuggestions({ searchParams: new URLSearchParams(params) });
        return { response, json: JSON.stringify(response), reads: [...sqlReads], parses };
      } finally { observing = false; }
    }
    function compare(params, budget) {
      const old = run(oldStore, params);
      const current = run(store, params);
      assert.equal(current.json, old.json, `complete suggestion response must equal the old eager oracle: ${JSON.stringify(params)}`);
      if (budget) {
        assert.deepEqual(current.reads.map(row => [row.kind, row.rows]), budget.reads, `unused suggestion SQL budget: ${JSON.stringify(params)}`);
        assert.equal(current.parses, budget.parses, `suggestion JSON parse budget: ${JSON.stringify(params)}`);
      }
      checks++;
      return { old, current };
    }
    const normal = compare({ q: "美食", limit: "8" }, { reads: [["indexedAuthors", 0], ["authors", 0], ["tags", 160]], parses: 160 });
    assert.equal(normal.old.reads.at(-1).kind, "titles");
    assert.equal(normal.old.reads.at(-1).rows, 16);
    assert.equal(normal.current.response.suggestions.length, 8);
    assert(normal.current.response.suggestions.every(item => item.detail === "160 条相关作品"), "tag detail must retain the complete 160-row sample");
    compare({ q: "食", limit: "1" }, { reads: [["indexedAuthors", 0], ["authors", 0], ["tags", 160]], parses: 160 });
    compare({ q: "美食", limit: "8", author: "privateAuthor" }, { reads: [["authors", 0], ["tags", 160]], parses: 160 });
    compare({ q: "美食", limit: "8", author: "privateAuthor", media: "gallery" }, { reads: [["authors", 0], ["tags", 160]], parses: 160 });
    compare({ q: "美食", limit: "8", media: "gallery" }, { reads: [["indexedAuthors", 0], ["authors", 0], ["tags", 160]], parses: 160 });
    compare({ q: "美食", limit: "8", media: "video" }, { reads: [["indexedAuthors", 0], ["authors", 0], ["tags", 160]], parses: 160 });
    compare({ search: "美食", limit: "8", type: "gallery" });
    const shortage = compare({ q: "美食", limit: "12" }, { reads: [["indexedAuthors", 0], ["authors", 0], ["tags", 160], ["titles", 24]], parses: 160 });
    assert.equal(shortage.current.response.suggestions.length, 12);
    compare({ q: "NoSuchNeedle", limit: "8" }, { reads: [["indexedAuthors", 0], ["fts", 0], ["authors", 0], ["tags", 0], ["titles", 0]], parses: 0 });
    compare({ q: "   ", limit: "8" }, { reads: [], parses: 0 });
    compare({ q: "美食烹饪", limit: "8" }, { reads: [["indexedAuthors", 0], ["fts", 160]], parses: 160 });
    compare({ q: "美食烹饪", limit: "8", author: "privateAuthor", media: "gallery" }, { reads: [["fts", 160]], parses: 160 });
    for (const database of databases) database.exec("UPDATE short_videos SET author_name='美食作者 ' || (CAST(substr(id,2) AS INTEGER)%8) WHERE id LIKE 'v%'");
    const authorFilled = compare({ q: "美食", limit: "8" }, { reads: [["indexedAuthors", 0], ["authors", 8]], parses: 0 });
    assert.equal(authorFilled.old.parses, 160);
    assert.deepEqual(authorFilled.current.response.suggestions.map(item => item.kind), Array(8).fill("author"));
    compare({ q: "美食", limit: "1", media: "gallery" }, { reads: [["indexedAuthors", 0], ["authors", 1]], parses: 0 });
    compare({ q: "美食", limit: "12", author: "name:美食作者 0" }, { reads: [["authors", 1], ["tags", 160], ["titles", 24]], parses: 160 });
    for (const database of databases) {
      for (const [i, literal] of ["%", "_", "\\"].entries()) insertVideo(database, { id: `literal${i}`, author: "special-author", name: `Literal${literal}Author`, title: `Literal${literal}Title`, tags: [`Literal${literal}Tag`], media: i === 1 ? "gallery" : "video" });
      insertVideo(database, { id: "long-title", title: `${"长".repeat(120)} trailing`, tags: [] });
      insertVideo(database, { id: "long-author", author: "a".repeat(1000), title: "界面标题", tags: ["界面标签"] });
    }
    for (const q of ["%", "_", "\\"]) for (const media of ["all", "gallery"]) {
      const literal = compare({ q, limit: "8", media });
      const matches = media === "all" || q === "_";
      assert.equal(literal.current.response.suggestions.length, matches ? 3 : 0, "LIKE escape must match only the literal row within its media scope");
    }
    const longQuery = compare({ q: `  ${"长".repeat(140)}  `, limit: "8" }, { reads: [["indexedAuthors", 0], ["fts", 1]], parses: 1 });
    assert.equal(longQuery.current.response.query.length, 120);
    assert.equal(longQuery.current.response.suggestions[0].label, `${"长".repeat(56)}…`);
    const longAuthor = compare({ q: "界面", author: `  ${"a".repeat(1005)}  `, limit: "8" }, { reads: [["authors", 0], ["tags", 1], ["titles", 1]], parses: 1 });
    assert.equal(longAuthor.current.response.author.length, 1000);
    for (const database of databases) database.exec("UPDATE short_videos SET author_name=CASE WHEN CAST(substr(id,2) AS INTEGER)%2=0 THEN '美食Alias' ELSE '美食alias' END WHERE id LIKE 'v%'");
    const duplicate = compare({ q: "美食", limit: "2" }, { reads: [["indexedAuthors", 0], ["authors", 2], ["tags", 160]], parses: 160 });
    assert.deepEqual(duplicate.current.response.suggestions.map(item => item.kind), ["author", "tag"], "capacity must use appended unique suggestions, not author row count");
    for (const database of databases) {
      const update = database.prepare("UPDATE short_videos SET tags_json=?, tags_text=? WHERE id=?");
      for (let i = count - 160; i < count; i++) {
        const tag = i >= count - 10 ? "慢食先到" : "慢食后到";
        update.run(JSON.stringify([tag]), tag, `v${i}`);
      }
    }
    const lateTag = compare({ q: "慢食", limit: "1" }, { reads: [["indexedAuthors", 0], ["authors", 0], ["tags", 160]], parses: 160 });
    assert.equal(lateTag.current.response.suggestions[0].label, "#慢食后到");
    assert.equal(lateTag.current.response.suggestions[0].detail, "150 条相关作品", "rank and count must include later rows even when the first tag already fills the limit");
    for (const database of databases) {
      database.prepare("UPDATE short_video_users SET nickname='美食当前' WHERE id='private-user'").run();
      database.prepare("INSERT INTO short_video_users(id,sec_uid,nickname) VALUES('private-user-2','privateAuthor2','美食当前')").run();
      database.exec("UPDATE short_videos SET owner_user_id='private-user-2' WHERE id LIKE 'v%' AND CAST(substr(id,2) AS INTEGER)%2=0");
    }
    const indexed = compare({ q: "美食", limit: "8" }, { reads: [["indexedAuthors", 1]], parses: 0 });
    assert.equal(indexed.current.response.suggestions.length, 1, "nonempty indexed-author results retain their existing early return even below the limit");
    assert.equal(indexed.current.response.suggestions[0].detail, `${(count + 5).toLocaleString("zh-CN")} 条作品`);
    assert(!fs.existsSync(unopenedCoverPath), "suggestion verification must never open a cover database");
    console.log(`short-video-store: ${checks} suggestion response/query-budget cases ok (tags full: 4→3 SQL; author full: 4→2 SQL, 160→0 JSON parses)`);
  } finally {
    observing = false;
    DatabaseSync.prototype.prepare = originalPrepare;
    JSON.parse = originalParse;
    oldStore?.close();
    store?.close();
  }
}


async function verifyFallbackCountQueries() {
  const moduleUrl = new URL("../src/modules/short-videos/server/store.js", import.meta.url);
  const normalizedSource = shortVideoStoreSource.replace(/\r\n/g, "\n");
  const start = normalizedSource.indexOf("  function listVideos(");
  const end = normalizedSource.indexOf("\n  function videoDetail(", start);
  assert(start >= 0 && end > start, "the complete listVideos implementation must remain discoverable");
  const currentFunction = normalizedSource.slice(start, end);
  const countSource = '    const countSource = !filter.author && filter.deleted === "all" && filter.source !== "history"\n      ? "short_videos"\n      : "short_video_catalog";\n    // Preserve the catalog expression\'s affinity for legacy TEXT flags.\n    const countWhere = countSource === "short_videos" && filter.source === "following"\n      ? where.replace("author_following = 1", "COALESCE(author_following, 0) = 1")\n      : where;\n';
  const currentCount = "SELECT COUNT(*) AS count FROM " + String.fromCharCode(36) + "{countSource} " + String.fromCharCode(36) + "{countWhere}";
  const formerCount = "SELECT COUNT(*) AS count FROM short_video_catalog " + String.fromCharCode(36) + "{where}";
  assert.equal(currentFunction.split(countSource).length, 2, "restore the precise count-source condition");
  assert.equal(currentFunction.split(currentCount).length, 2, "restore the precise fallback COUNT");
  const previousFunction = currentFunction.replace(countSource, "").replace(currentCount, formerCount);
  const totalMarker = "    const total = recommendationIds\n";
  assert.equal(previousFunction.replace(formerCount, currentCount).replace(totalMarker, countSource + totalMarker),
    currentFunction, "the complete old list function differs only in this round's count source");
  const previousSource = normalizedSource.replace(currentFunction, previousFunction);
  assert.equal(previousSource.replace(previousFunction, currentFunction), normalizedSource,
    "the old full-function oracle preserves every other store implementation");
  const importableSource = previousSource.replace(/from "(\.\.?\/[^"\n]+)"/g,
    (_match, relative) => "from " + JSON.stringify(new URL(relative, moduleUrl).href));
  const { createShortVideoStore: createPreviousStore } = await import("data:text/javascript;base64," + Buffer.from(importableSource).toString("base64"));
  const createTestedStore = process.argv.includes("--legacy-fallback-count") ? createPreviousStore : createShortVideoStore;
  const originalPrepare = DatabaseSync.prototype.prepare;
  const originalParse = JSON.parse;
  const unopenedCoverPath = path.join(os.tmpdir(), "fanhao-fallback-count-unopened-" + process.pid + ".sqlite");
  const options = { dbPath: ":memory:", coverDbPath: unopenedCoverPath, roots: [],
    skipStartupMaintenance: true, trustExplicitInvalidation: true, coverGenerateLimit: 0 };
  const owners = [];
  let capturedDatabase;
  let observing = false;
  let probing = false;
  let injectedError = null;
  let reads = [];
  let parses = 0;
  let lookupCounts = {};
  let checks = 0;
  const selectionEvidence = [];
  const recommendationEvidence = [];
  const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
  const countQuery = /^SELECT COUNT\(\*\) AS count FROM (short_video_catalog|short_videos)\b/;
  const aliases = ["u", "s", "user_like", "user_collect", "user_dislike", "watch_history",
    "video_asset", "native_cover_asset", "ffmpeg_cover_asset", "legacy_cover_asset", "music_asset", "sound_index"];
  DatabaseSync.prototype.prepare = function(sql) {
    capturedDatabase = this;
    const count = countQuery.exec(sql);
    if (observing && count && injectedError) throw injectedError;
    const actualSql = observing && probing && count?.[1] === "short_video_catalog"
      ? sql.replace("FROM short_video_catalog", "FROM short_video_catalog_count_probe") : sql;
    const statement = originalPrepare.call(this, actualSql);
    if (!observing) return statement;
    return new Proxy(statement, {
      get(target, key) {
        const value = target[key];
        if (typeof value !== "function") return value;
        return (...args) => {
          const startedAt = performance.now();
          const result = value.apply(target, args);
          if (key === "all" || key === "get") reads.push({ sql, actualSql, args,
            elapsedMs: performance.now() - startedAt });
          return result;
        };
      }
    });
  };
  JSON.parse = function(...args) {
    if (observing) parses++;
    return originalParse.apply(this, args);
  };

  function createOwner(factory, { legacyNullable = false, followingType = "INTEGER" } = {}) {
    const owner = factory(options);
    owners.push(owner);
    owner.prepareSchema();
    const database = capturedDatabase;
    // The read scenarios use actual tables, indexes and views. Ingestion
    // triggers stay covered by the original disk fixture below this verifier.
    const schema = originalPrepare.call(database, "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid").all();
    for (const item of schema.filter(row => row.type === "trigger")) database.exec("DROP TRIGGER " + quote(item.name));
    if (legacyNullable) {
      database.exec("PRAGMA foreign_keys = OFF");
      for (const item of schema.filter(row => row.type === "view")) database.exec("DROP VIEW " + quote(item.name));
      database.exec("DROP TABLE short_videos");
      let tableSql = schema.find(row => row.type === "table" && row.name === "short_videos").sql;
      for (const column of ["visibility", "media_type", "is_liked", "author_following", "owner_user_id", "published_at", "liked_at"]) {
        tableSql = tableSql.replace(new RegExp("(" + column + " (?:TEXT|INTEGER)) NOT NULL"), "$1");
      }
      tableSql = tableSql.replace("author_following INTEGER", "author_following " + followingType);
      database.exec(tableSql);
      for (const item of schema.filter(row => row.type === "index" && /\bON short_videos\b/.test(row.sql))) database.exec(item.sql);
      for (const item of schema.filter(row => row.type === "view")) database.exec(item.sql);
      database.exec("PRAGMA foreign_keys = ON");
    }
    assert.equal(originalPrepare.call(database, "PRAGMA table_info(short_videos)").all()
      .find(row => row.name === "author_following").type, followingType, "exercise the actual legacy flag affinity");
    const baseSql = schema.find(row => row.type === "view" && row.name === "short_video_catalog_base").sql;
    let markers = 0;
    const probeSql = baseSql.replace("CREATE VIEW short_video_catalog_base", "CREATE VIEW short_video_catalog_base_count_probe")
      .replace(/ON ([a-z_]+)\.(id|video_id) = v\.(id|owner_user_id)/g, (_match, alias, key, field) => {
        markers++;
        assert(aliases.includes(alias), "every native lookup probe must correspond to an actual catalog join");
        return "ON " + alias + "." + key + " = fanhao_count_lookup('" + alias + "',v." + field + ")";
      });
    assert.equal(markers, aliases.length, "probe every actual catalog association");
    database.function("fanhao_count_lookup", { deterministic: true }, (alias, value) => {
      lookupCounts[alias] = (lookupCounts[alias] || 0) + 1;
      return value;
    });
    database.exec(probeSql);
    database.exec("CREATE VIEW short_video_catalog_count_probe AS SELECT short_video_catalog_base_count_probe.*, " +
      "1 AS recommendation_author_rank, recommendation_score AS recommendation_order_score FROM short_video_catalog_base_count_probe");
    return { owner, database };
  }

  function seed(database, count, { boundary = false, nullable = false, followingText = false } = {}) {
    database.exec("BEGIN");
    const user = database.prepare("INSERT INTO short_video_users(id,sec_uid,nickname) VALUES(?,?,?)");
    for (let index = 0; index < 24; index++) user.run("user" + index, "sec" + index, "作者 " + index);
    const video = database.prepare("INSERT INTO short_videos(id,aweme_id,owner_user_id,author_sec_uid,author_name,title,description,tags_json,tags_text,source_path,published_at,liked_at,media_type,visibility,is_liked,author_following,actual_pixels,digg_count,comment_count,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const search = database.prepare("INSERT INTO short_video_search(video_id,title,description,author_name,aweme_id,tags_text,visibility) VALUES(?,?,?,?,?,?,?)");
    const membership = database.prepare("INSERT INTO short_video_source_memberships(source_profile_id,source_type,aweme_id,is_missing_from_profile) VALUES(?,?,?,?)");
    const stats = database.prepare("INSERT INTO short_video_stats(video_id,digg_count,comment_count) VALUES(?,?,?)");
    const action = database.prepare("INSERT INTO short_video_user_actions(local_user_id,video_id,action_type,active) VALUES(?,?,?,?)");
    const watch = database.prepare("INSERT INTO short_video_watch_history(local_user_id,video_id,progress_ms,last_watched_at) VALUES(?,?,?,?)");
    const asset = database.prepare("INSERT INTO short_video_assets(id,video_id,asset_type,local_path,file_name,size_bytes) VALUES(?,?,?,?,?,?)");
    const sound = database.prepare("INSERT INTO short_video_sounds(video_id,sound_key,title) VALUES(?,?,?)");
    for (let index = 0; index < count; index++) {
      const id = boundary && index < 2 ? null : "V" + String(index).padStart(6, "0");
      const aweme = "A" + index;
      const title = index % 4 === 0 ? "目标测试 " + index % 27 : "普通_测试%\\ " + index % 27;
      const author = "作者 " + index % 24;
      const media = nullable && index % 13 === 0 ? null : index % 3 === 0 ? "gallery" : "video";
      const visibility = nullable && index % 11 === 0 ? null : index % 7 === 0 ? "download_pending" : "local_only";
      const owner = nullable && index % 13 === 0 ? null : boundary && index % 9 === 0 ? "orphan" : "user" + index % 24;
      const published = nullable && index % 10 === 0 ? null : index % 19 === 0 ? "" : String(index % 1000).padStart(6, "0");
      const likedAt = nullable && index % 4 === 0 ? null : "same-liked";
      const liked = nullable && index % 6 === 0 ? null : index % 2;
      const followingValues = [1, 0, null, "1", "0", "1.0", "01", "not-number", 1.5];
      const following = nullable ? followingValues[index % followingValues.length] : index % 3 ? 1 : 0;
      const storedFollowing = followingText && following !== null ? String(following) : following;
      const metadata = media === "gallery" ? '{"fanhaoMedia":{"type":"gallery","galleryCount":2,"galleryItems":["image","video"]}}' : "{}";
      video.run(id, aweme, owner, "sec" + index % 24, author, title, "描_述%\\", boundary && index % 5 === 0 ? "invalid" : '["tag"]',
        "tag", "", published, likedAt, media, visibility, liked, storedFollowing, index % 2 ? 8294400 : 0, index % 97, index % 3, metadata);
      search.run(id, title, "描_述%\\", author, aweme, "tag", visibility);
      if (index % 5 === 0) membership.run("private-profile", "post", aweme, index % 25 === 0 ? 1 : 0);
      if (id === null) continue;
      stats.run(id, index % 97, index % 3);
      for (const type of ["like", "collect", "dislike"]) action.run("local:self", id, type, 0);
      action.run("other-account", id, "like", 1);
      watch.run("local:self", id, 100, boundary && index % 3 === 0 ? "" : "2026-10-04");
      watch.run("other-account", id, 900, "2026-10-05");
      for (const type of ["video", "native_cover", "ffmpeg_cover", "cover", "music"]) asset.run(id + type, id, type, "synthetic-not-read.mp4", "synthetic.mp4", 1);
      sound.run(id, "private-key", "private sound");
    }
    if (boundary) {
      stats.run(null, 999999, 0);
      stats.run(null, 888888, 0);
    }
    database.exec("COMMIT");
  }

  function run(owner, params, { probe = false } = {}) {
    reads = [];
    parses = 0;
    lookupCounts = {};
    probing = probe;
    observing = true;
    const startedAt = performance.now();
    try {
      const response = owner.listVideos({ searchParams: new URLSearchParams({
        source: "all", stats: "0", facets: "0", users: "0", limit: "48", ...params
      }) });
      return { response, reads: [...reads], parses, lookups: { ...lookupCounts }, elapsedMs: performance.now() - startedAt };
    } finally { observing = false; probing = false; }
  }

  function compare(previous, current, params) {
    const before = run(previous, params), after = run(current, params);
    assert.deepEqual(after.response, before.response, "the complete former listVideos response remains unchanged");
    assert.equal(JSON.stringify(after.response), JSON.stringify(before.response), "complete response bytes and field order remain unchanged");
    const oldCount = before.reads.find(row => countQuery.test(row.sql));
    if (oldCount) selectionEvidence.push({ params, previous: oldCount,
      actual: after.reads.find(row => countQuery.test(row.sql)) });
    if (params.source === "recommended") recommendationEvidence.push({ total: after.response.total,
      countReads: [...before.reads, ...after.reads].filter(row => countQuery.test(row.sql)).length });
    checks++;
    return { before, after };
  }

  try {
    assert(!fs.existsSync(unopenedCoverPath), "fallback COUNT setup must never reuse a cover database");
    const previous = createOwner(createPreviousStore), current = createOwner(createTestedStore);
    const count = 6000;
    seed(previous.database, count);
    seed(current.database, count);
    const largeCases = [
      { q: "目标测试", sort: "published" }, { q: "目标测试", sort: "likes" }, { q: "目标测试", sort: "publishedAsc" },
      { q: "普通", sort: "likes" }, { q: "目标", sort: "likes", media: "gallery" },
      { q: "目标", sort: "comments", source: "liked" }, { q: "目标测试", sort: "size", includePending: "1" },
      { q: "目标测试", sort: "duration", quality: "4k" }, { q: "目标测试", sort: "likes", source: "posts" },
      { q: "目标测试", sort: "likes", source: "local" }, { q: "NoSuchMatch", sort: "size" },
      { q: "目标测试", sort: "likes", author: "sec0" }, { q: "目标测试", sort: "likes", author: "name:作者 0" },
      { q: "目标测试", sort: "likes", deleted: "deleted" }, { q: "目标测试", sort: "likes", source: "history" },
      { q: "目标测试", sort: "likes", source: "following" },
      { q: "目标测试", sort: "likes", source: "recommended" },
      { q: "NoSuchMatch", sort: "likes", source: "recommended" },
      { q: "目标测试", sort: "likes", stats: "1", facets: "1", users: "1" }
    ];
    for (const params of largeCases) for (const offset of ["0", "48", "999999"]) {
      compare(previous.owner, current.owner, { ...params, offset });
    }
    const boundaryCases = [
      { source: "all", sort: "watched" }, { source: "liked", sort: "watched" },
      { source: "following", sort: "watched" }, { source: "posts", sort: "watched" }, { source: "local", sort: "watched" },
      { q: "目标测试", sort: "likes" }, { q: "_", sort: "likes" }, { q: "%", sort: "likes" }, { q: "\\", sort: "likes" },
      { q: '"目标"', sort: "likes" }, { q: "目标测试", sort: "comments", media: "gallery" },
      { q: "目标测试", sort: "size", quality: "4k" }, { q: "目标测试", sort: "likes", users: "1" },
      { q: "目标测试", sort: "likes", author: "sec0" }, { q: "目标测试", sort: "likes", author: "name:作者 0" },
      { q: "目标测试", sort: "likes", deleted: "deleted" }, { q: "目标测试", sort: "likes", source: "history" },
      { q: "none", sort: "duration" }, { sort: "likes", topic: "tag" },
      { sort: "likes", sound: Buffer.from("no-key").toString("base64url") }
    ];
    for (const [nullable, followingType] of [[false, "INTEGER"], [true, "INTEGER"], [true, "TEXT"]]) {
      const oldBoundary = createOwner(createPreviousStore, { legacyNullable: nullable, followingType });
      const newBoundary = createOwner(createTestedStore, { legacyNullable: nullable, followingType });
      seed(oldBoundary.database, 84, { boundary: true, nullable, followingText: followingType === "TEXT" });
      seed(newBoundary.database, 84, { boundary: true, nullable, followingText: followingType === "TEXT" });
      for (const params of boundaryCases) for (const includePending of ["0", "1"]) for (const offset of ["0", "3", "999"]) {
        compare(oldBoundary.owner, newBoundary.owner, { ...params, includePending, offset, limit: "7" });
      }
    }
    const markerError = new Error("private fallback COUNT marker");
    injectedError = markerError;
    for (const owner of [previous.owner, current.owner]) assert.throws(() => run(owner, { q: "目标测试", sort: "likes" }),
      error => error === markerError, "native prepare failures retain their original Error object");
    injectedError = null;

    // Every response oracle runs before the budget, including the old-code
    // negative control. Instrument only native COUNT join keys, not the DTO.
    const params = { q: "目标测试", sort: "likes" };
    const raw = compare(previous.owner, current.owner, params);
    const oldProbe = run(previous.owner, params, { probe: true });
    const newProbe = run(current.owner, params, { probe: true });
    assert.deepEqual(oldProbe.response, raw.before.response);
    assert.deepEqual(newProbe.response, raw.after.response);
    const rawCount = raw.before.reads.find(row => countQuery.test(row.sql));
    const probeCount = oldProbe.reads.find(row => countQuery.test(row.sql));
    const plan = (database, sql, args) => originalPrepare.call(database, "EXPLAIN QUERY PLAN " + sql).all(...args).map(row => row.detail);
    assert.deepEqual(plan(previous.database, probeCount.actualSql, probeCount.args),
      plan(previous.database, rawCount.sql, rawCount.args), "the native probe preserves the original COUNT query plan");
    assert.equal(raw.before.response.total, 1285, "the synthetic visibility/search intersection stays fixed");
    assert.equal(raw.after.parses, raw.before.parses, "COUNT optimization does not change public JSON parsing");
    console.log("short-video-store: fallback COUNT response oracles passed (" + checks + " complete DTOs)");
    assert.equal(Object.values(newProbe.lookups).reduce((sum, value) => sum + value, 0), 0,
      "fallback COUNT must not read unrelated catalog joins");
    for (const alias of aliases) assert.equal(oldProbe.lookups[alias], 1285, "the original COUNT exercises every native catalog join");
    assert.equal(Object.values(oldProbe.lookups).reduce((sum, value) => sum + value, 0), 15420,
      "the original COUNT exceeds the exact native lookup budget");
    let bareCountQueries = 0, guardedCountQueries = 0;
    for (const { params, previous: oldCount, actual } of selectionEvidence) {
      const useBare = !params.author && params.deleted !== "deleted" && params.source !== "history";
      assert(actual, "fallback count queries must stay observable");
      assert(countQuery.exec(actual.sql)?.[1] === (useBare ? "short_videos" : "short_video_catalog"),
        "author/deleted/history counts must retain their required catalog source");
      let expectedSql = useBare ? oldCount.sql.replace("FROM short_video_catalog", "FROM short_videos") : oldCount.sql;
      if (useBare && params.source === "following") expectedSql = expectedSql.replace("author_following = 1", "COALESCE(author_following, 0) = 1");
      assert.equal(actual.sql, expectedSql, "only the COUNT source and following affinity expression may change");
      assert.deepEqual(actual.args, oldCount.args, "the original filter arguments remain unchanged");
      if (useBare) bareCountQueries++; else guardedCountQueries++;
    }
    assert(bareCountQueries > 0 && guardedCountQueries > 0, "both COUNT paths must be exercised");
    assert.equal(recommendationEvidence.length, 6, "exercise nonempty and empty recommended arrays across paging");
    assert(recommendationEvidence.some(row => row.total > 0) && recommendationEvidence.some(row => row.total === 0));
    assert(recommendationEvidence.every(row => row.countReads === 0),
      "recommended results, including an empty array, must never enter fallback COUNT");
    assert(!fs.existsSync(unopenedCoverPath), "fallback COUNT verification must never open a cover database");
    console.log("short-video-store: fallback COUNT native lookups 15420→0; guarded queries " + guardedCountQueries +
      "; bare queries " + bareCountQueries + "; diagnostic list ms " +
      raw.before.elapsedMs.toFixed(1) + "→" + raw.after.elapsedMs.toFixed(1));
  } finally {
    observing = false;
    probing = false;
    injectedError = null;
    DatabaseSync.prototype.prepare = originalPrepare;
    JSON.parse = originalParse;
    for (const owner of owners.reverse()) owner.close();
  }
}


async function verifyNavigationListOrder() {
  let module = navigationQueries;
  if (process.argv.includes("--legacy-navigation-order")) {
    const declaration = "function keyset(keys, movingNext) {";
    assert.equal(shortVideoNavigationQueriesSource.split(declaration).length, 2);
    const source = shortVideoNavigationQueriesSource.replace(declaration, `${declaration}\n    keys = keys.map(key => /(?:^|\\.)id$/.test(key.expression) ? { ...key, direction: keys[0].direction } : key);`)
      .replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, relative) => `from ${JSON.stringify(new URL(relative, new URL("../src/modules/short-videos/server/navigation-queries.js", import.meta.url)).href)}`);
    module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  }
  const normalizeSortSource = shortVideoStoreSource.slice(shortVideoStoreSource.indexOf("function normalizeSort("), shortVideoStoreSource.indexOf("function runSqliteBusyRetry("));
  const normalizeSort = new Function(`${normalizeSortSource}; return normalizeSort;`)();
  const listOrderSource = /const orderBy = (\{[\s\S]+?\}\[sort\] \|\| "published_at DESC, liked_at DESC");/.exec(shortVideoStoreSource.slice(shortVideoStoreSource.indexOf("  function listVideos(")))?.[1];
  assert(listOrderSource, "read the actual store's fallback list order");
  const listOrder = new Function("sort", `return ${listOrderSource};`);
  const columns = "id,published_at,liked_at,liked_sort_at,liked_sort_time,digg_count,comment_count,collect_count,share_count,duration_ms,size_bytes,last_watched_at";
  const originalPrepare = DatabaseSync.prototype.prepare;
  let schemaDatabase;
  DatabaseSync.prototype.prepare = function(sql) { schemaDatabase = this; return originalPrepare.call(this,sql); };
  const unopenedCoverPath = path.join(os.tmpdir(),`fanhao-navigation-unopened-${process.pid}.sqlite`);
  const schemaStore = createShortVideoStore({ dbPath: ":memory:", coverDbPath: unopenedCoverPath, roots: [], skipStartupMaintenance: true });
  let schema;
  try {
    schemaStore.prepareSchema();
    schema = originalPrepare.call(schemaDatabase,"SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid").all();
    assert(!fs.existsSync(unopenedCoverPath),"navigation setup must not create a cover database");
  } finally { DatabaseSync.prototype.prepare=originalPrepare; schemaStore.close(); }
  let checks = 0;
  for (const nullableLegacy of [false, true]) {
    const db = new DatabaseSync(":memory:");
    const queries = [];
    const observed = { prepare(sql) { queries.push(sql); return db.prepare(sql); } };
    const list = createShortVideoListPageQueries({ listVideoColumns: columns });
    const navigation = module.createShortVideoNavigationQueries({ listVideoColumns: columns, normalizeSort, statisticsKnown: shortVideoStatisticsKnown });
    try {
      for (const item of schema.filter(item=>item.type === "table")) {
        if (item.name.startsWith("sqlite_") || item.name.startsWith("short_video_search_")) continue;
        let sql=item.sql;
        if (nullableLegacy && item.name === "short_videos") for (const column of ["published_at","liked_at","liked_sort_at","size_bytes"]) {
          sql=sql.replace(new RegExp(`(${column} (?:TEXT|INTEGER)) NOT NULL`),"$1");
        }
        db.exec(sql);
      }
      for (const item of schema.filter(item=>item.type === "index" || item.type === "view")) db.exec(item.sql);
      // As in the quality fixture, ingestion/search maintenance triggers are
      // outside these read scenarios. Tables, indexes and views are actual.
      const seed = db.prepare("INSERT INTO short_videos(id,aweme_id,source_path,visibility,media_type,is_liked,author_following,author_sec_uid,author_name,published_at,liked_at,liked_sort_at,liked_sort_time,digg_count,comment_count,collect_count,share_count,duration_ms,size_bytes,actual_pixels) VALUES(?,?,'',?,?,1,1,'actor','actor',?,?,?,?,?,?,0,0,?,?,?)");
      const rows = [
        ["A","2026-01-02","2026-01-03",10,10,1,5,5], ["B","2026-01-02","2026-01-03",10,10,1,5,5], ["C","2026-01-02","2026-01-03",10,10,1,5,5],
        ["D","2026-01-01","2026-01-01",9,9,1,4,4], ["E","2026-01-03","2026-01-04",11,11,1,6,6],
        ["F","","",null,null,null,null,null], ["G","","",null,0,0,0,0], ["H",null,null,-1,null,null,null,null],
        ["I",null,null,null,0,0,0,0], ["J","2026-01-02",null,1000000000000,0,0,0,0],
        ["P","2026-01-02","2026-01-03",10,10,1,5,5], ["O","2026-01-02","2026-01-03",10,10,1,5,5]
      ];
      for (const [id,published,liked,time,likes,comments,duration,size] of rows) {
        seed.run(id,id,id === "P" ? "download_pending" : "local_only",["F","G"].includes(id) ? "gallery" : "video",nullableLegacy ? published : published ?? "",nullableLegacy ? liked : liked ?? "",nullableLegacy ? liked : liked ?? "",time,likes,comments,duration,nullableLegacy ? size : size ?? 0,id === "E" ? 8294400 : ["F","G"].includes(id) ? 0 : 921600);
        db.prepare("INSERT INTO short_video_watch_history(local_user_id,video_id,last_watched_at) VALUES('local:self',?,'2026-02-01')").run(id);
        db.prepare("INSERT INTO short_video_topics(video_id,topic,topic_key) VALUES(?,'chosen','chosen')").run(id);
        if (["A","B","D","F","H","O"].includes(id)) db.prepare("INSERT INTO short_video_source_memberships(aweme_id,source_type,source_profile_id) VALUES(?,'post','fixture')").run(id);
      }
      db.exec("INSERT INTO short_video_users(id,platform,sec_uid,nickname) VALUES('author:actor','douyin','actor','actor'); UPDATE short_videos SET owner_user_id='author:actor',author_sec_uid='',author_name='old name' WHERE id='O';");
      db.exec("INSERT INTO short_video_stats(video_id,digg_count,comment_count) VALUES('B',99,88); INSERT INTO short_video_assets(id,video_id,asset_type,local_path,size_bytes) VALUES('asset:B','B','video','',99);");
      db.exec("INSERT INTO short_video_search(video_id,title,author_name,visibility,published_at,author_sec_uid,media_type,tags_json) SELECT id,'xy xyz',author_name,visibility,published_at,author_sec_uid,media_type,'[]' FROM short_video_catalog;");
      const page = (filter, sort) => list.fastHistoryVideoPage(db,filter,sort,300,0)
        ?? list.fastShortQueryVideoPage(db,filter,sort,300,0)
        ?? list.fastFilteredVideoPage(db,filter,sort,300,0)
        ?? list.fastPublishedVideoPage(db,filter,sort,300,0)
        ?? { rows: db.prepare(`SELECT ${columns} FROM short_video_catalog WHERE ${filter.where} ORDER BY ${listOrder(sort)},id DESC`).all(...filter.args) };
      const scenarios = [
        ...["published","publishedAsc","likes","likesAsc","comments","duration","size"].map(sort => ({ source: "all", sort })),
        { source: "liked", sort: "published" }, { source: "liked", sort: "publishedAsc" }, { source: "history", sort: "watched" },
        { source: "following", sort: "publishedAsc" }, { source: "all", sort: "publishedAsc", author: "all" },
        ...["actor","name:actor"].flatMap(author=>["published","publishedAsc","likesAsc"].map(sort=>({source:"all",sort,author}))),
        ...["posts","local"].flatMap(source=>["published","publishedAsc","likesAsc"].map(sort=>({source,sort}))),
        ...["video","gallery"].flatMap(media=>["publishedAsc","likesAsc"].map(sort=>({source:"all",sort,media}))),
        ...["4k","unknown"].flatMap(quality=>["published","publishedAsc","likesAsc"].map(sort=>({source:"all",sort,quality}))),
        ...["x","xy","xyz"].flatMap(q=>["published","publishedAsc"].map(sort=>({source:"all",sort,q}))),
        {origin:"liked",sort:"publishedAsc"}, {source:"all",sort:"publishedAsc",search:"xy"},
        ...[{media:"video"},{author:"all"},{topic:"chosen"}].map(extra=>({source:"all",sort:"publishedAsc",q:"xy",...extra})),
        ...["published","publishedAsc","likes","likesAsc","duration","size"].map(sort => ({ source: "all", sort, topic: "chosen" })),
        { source: "liked", sort: "published", topic: "chosen" }, { source: "liked", sort: "publishedAsc", topic: "chosen" }
      ];
      for (const scenario of scenarios) {
        const params = new URLSearchParams(scenario), filter = videoFilter(params), order = navigation.adjacentOrder({ searchParams: params });
        const sort = filter.source === "liked" && scenario.sort === "published" ? "liked" : filter.source === "liked" && scenario.sort === "publishedAsc" ? "likedAsc" : scenario.sort;
        const visible = new Set(page(filter,sort).rows.map(row => row.id));
        const allFilter = videoFilter(new URLSearchParams({ ...scenario, includePending: "1" }));
        const all = page(allFilter,sort).rows;
        for (const anchor of all) for (const direction of [-1,1]) for (const limit of [1,6]) {
          const index = all.findIndex(row => row.id === anchor.id);
          const expected = (direction > 0 ? all.slice(index+1) : all.slice(0,index).reverse()).filter(row => visible.has(row.id)).slice(0,limit).map(row => row.id);
          const actual = navigation.fastHistoryAdjacentRows(observed,anchor,direction,filter,order,limit)
            ?? navigation.fastLikedAdjacentRows(observed,anchor,direction,filter,order,limit)
            ?? navigation.fastPublishedAdjacentRows(observed,anchor,direction,filter,order,limit)
            ?? navigation.fastMetricAdjacentRows(observed,anchor,direction,filter,order,limit)
            ?? navigation.adjacentRows(observed,anchor,direction,order,true,filter,limit);
          assert.deepEqual(actual.map(row => row.id),expected,`${nullableLegacy ? "nullable" : "current"} ${params} anchor=${anchor.id} direction=${direction} limit=${limit}`);
          checks++;
        }
      }
      assert.equal(queries.filter(sql => sql === "PRAGMA table_info(short_videos)").length,1,"column metadata is checked once per connection");
      if (!nullableLegacy) {
        const filter = videoFilter(new URLSearchParams({ source: "all", sort: "published" }));
        const order = navigation.adjacentOrder({ searchParams: new URLSearchParams({ source: "all", sort: "published" }) });
        queries.length=0; navigation.fastPublishedAdjacentRows(observed,page(filter,"published").rows[0],1,filter,order,6);
        assert.match(queries[0],/\(v\.published_at, v\.liked_at, v\.id\) < \(\?, \?, \?\)/,"normal DESC publication retains its tuple seek");
        const publishedPlan=db.prepare(`EXPLAIN QUERY PLAN ${queries[0]}`).all(...Array((queries[0].match(/\?/g)||[]).length).fill(0)).map(row=>row.detail).join("\n");
        assert.match(publishedPlan,/SEARCH v USING INDEX idx_short_videos_published \(published_at<\?\)/,"actual DESC publication retains its index range seek");
        assert(!queries.some(sql=>/AS value FROM short_videos/.test(sql)),"publication navigation has no extra scalar anchor read");
        const likedFilter=videoFilter(new URLSearchParams({ source: "liked" }));
        const likedOrder=navigation.adjacentOrder({ searchParams: new URLSearchParams({ source: "liked" }) });
        queries.length=0; navigation.fastLikedAdjacentRows(observed,page(likedFilter,"liked").rows[0],1,likedFilter,likedOrder,6);
        const select=queries.find(sql=>/SELECT v\.id/.test(sql));
        const paramsCount=(select.match(/\?/g)||[]).length;
        const plan=db.prepare(`EXPLAIN QUERY PLAN ${select}`).all(...Array(paramsCount).fill(0)).map(row=>row.detail).join("\n");
        assert.match(plan,/idx_short_videos_liked_sort_all/); assert.doesNotMatch(plan,/TEMP B-TREE/);
        assert(!queries.some(sql=>/AS value FROM short_videos/.test(sql)),"default liked navigation has no extra scalar anchor read");
        const metricParams=new URLSearchParams({source:"all",sort:"likes"});
        queries.length=0; navigation.fastMetricAdjacentRows(observed,db.prepare(`SELECT ${columns} FROM short_video_catalog WHERE id='B'`).get(),1,videoFilter(metricParams),navigation.adjacentOrder({searchParams:metricParams}),6);
        assert.equal(queries.filter(sql=>/AS value FROM short_videos/.test(sql)).length,1,"overlaid metric anchor needs one bounded scalar read");
      }
    } finally { db.close(); }
  }
  console.log(`short-video-store: ${checks} in-memory navigation/list order checks passed`);
}

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
  installFixtureSyncJournal(workerData.sourceDbPath);
  const service = createDownloadManagerSyncService({
    sourceDbPath: workerData.sourceDbPath,
    intervalMs: 60_000,
    dbPath: workerData.dbPath,
    ffmpegPath: workerData.ffmpegPath,
    roots: workerData.roots
  });
  try {
    let result;
    do { result = await service.sync({ force: true }); } while (result?.hasMore);
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
  const shortTitleResults = store.listVideos({
    searchParams: new URLSearchParams("q=图片&source=all&sort=published&limit=10&stats=0&facets=0")
  });
  assert.equal(shortTitleResults.videos[0]?.id, galleryId, "one- and two-character searches should use the compact search table without losing substring matches");
  assert.equal(shortTitleResults.total, 1, "short-query paging should preserve the exact total");
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
  const renamedAuthorSearch = store.listVideos({
    searchParams: new URLSearchParams("q=更新后的测试作者&source=all&sort=published&limit=10&stats=0&facets=0")
  });
  assert.equal(renamedAuthorSearch.usersTotal, 1, "aggregate search must find a current profile nickname without building the full author facet");
  assert.equal(renamedAuthorSearch.users[0]?.name, "更新后的测试作者");
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
    installFixtureSyncJournal(singleWriterSourceDbPath);
    while (singleWriterStore.importDownloadManagerDb(singleWriterSourceDbPath, {
      incremental: true, includePosts: true, skipSummary: true
    }).hasMore) {}
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
      assert.equal(noOpSync?.profilesSeen, 0, "an acknowledged journal must not read unchanged profiles");
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

  advisories.flush();
  console.log("short-video-store: ok");
} finally {
  explicitStore?.close();
  store?.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
