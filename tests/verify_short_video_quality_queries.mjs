import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { routeShortVideoApi } from "../src/modules/short-videos/server/routes.js";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";
import { createShortVideoCatalogWorkerClient } from "../src/modules/short-videos/server/catalog-worker-client.js";
import { createShortVideoListStatsService } from "../src/modules/short-videos/server/list-stats-service.js";

const args = process.argv.slice(2);
const caseName = args.find(arg => arg.startsWith("--case="))?.slice(7);
const legacyPredicate = args.includes("--legacy-quality-predicate");
const legacyMedia = args.includes("--legacy-media-branch");
assert(args.every(arg => arg.startsWith("--case=") || ["--legacy-quality-predicate", "--legacy-media-branch"].includes(arg)), "known arguments");
const root = new URL("../src/modules/short-videos/server/", import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), "utf8").replace(/\r\n/g, "\n");
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

// The old quality predicate is a controlled dependency negative, retaining the
// fixed media intersection. Both controls execute SQL and fail behavior/plan
// assertions; neither uses a source-marker assertion as its failure evidence.
function oldQualityWhere(quality, prefix = "") {
  const pixels = `${prefix}actual_pixels`;
  return {
    "4k": `COALESCE(${pixels}, 0) >= 8294400`,
    "1440p": `COALESCE(${pixels}, 0) >= 3686400 AND COALESCE(${pixels}, 0) < 8294400`,
    "1080p": `COALESCE(${pixels}, 0) >= 2073600 AND COALESCE(${pixels}, 0) < 3686400`,
    "720p": `COALESCE(${pixels}, 0) >= 921600 AND COALESCE(${pixels}, 0) < 2073600`,
    "below720p": `COALESCE(${pixels}, 0) > 0 AND COALESCE(${pixels}, 0) < 921600`,
    unknown: `COALESCE(${pixels}, 0) <= 0`
  }[quality] || "";
}

async function modules({ oldPredicate = false, oldMedia = false } = {}) {
  let contract = read("query-contract.js");
  if (oldPredicate) {
    const start = contract.indexOf("export function actualVideoQualityWhere(");
    const end = contract.indexOf("export function formatSuggestionCount(", start);
    assert(start >= 0 && end > start, "quality dependency boundary exists");
    contract = contract.slice(0, start) + oldQualityWhere.toString()
      .replace("function oldQualityWhere", "export function actualVideoQualityWhere") + "\n\n" + contract.slice(end);
  }
  const contractUrl = dataUrl(contract);
  const moduleUrl = (name, pageUrl = null) => {
    let source = read(name).replace('"./query-contract.js"', JSON.stringify(contractUrl))
      .replace('"./constants.js"', JSON.stringify(new URL("constants.js", root).href))
      .replace('"./schema.js"', JSON.stringify(new URL("schema.js", root).href));
    if (pageUrl) source = source.replace('"./list-page-queries.js"', JSON.stringify(pageUrl));
    if (oldMedia) source = source.replaceAll('    }\n    if (filter.media !== "all") {', '    } else if (filter.media !== "all") {');
    return dataUrl(source);
  };
  const pageUrl = moduleUrl("list-page-queries.js");
  return { contract: await import(contractUrl), page: await import(pageUrl), navigation: await import(moduleUrl("navigation-queries.js", pageUrl)) };
}

const actual = await modules({ oldPredicate: legacyPredicate, oldMedia: legacyMedia });
const oldPredicateModules = await modules({ oldPredicate: true });
const COLUMNS = "id, media_type, actual_pixels, digg_count, comment_count, collect_count, share_count, duration_ms, size_bytes, liked_at, published_at, liked_sort_time, liked_sort_at, last_watched_at";
const qualityNames = ["4k", "1440p", "1080p", "720p", "below720p", "unknown"];
const points = [null, -1, 0, 1, 921599, 921600, 2073599, 2073600, 3686399, 3686400, 8294399, 8294400, 12000000];
const createPage = module => module.page.createShortVideoListPageQueries({ listVideoColumns: COLUMNS });
const createNavigation = module => module.navigation.createShortVideoNavigationQueries({ listVideoColumns: COLUMNS,
  normalizeSort: sort => sort || "published", statisticsKnown: row => Number(row.digg_count || 0) > 0 });

function openActualStore({ factory = createShortVideoStore, dbPath = ":memory:", readOnly = false } = {}) {
  const prepare = DatabaseSync.prototype.prepare;
  let database;
  DatabaseSync.prototype.prepare = function(sql) { database = this; return prepare.call(this, sql); };
  const coverPath = path.join(os.tmpdir(), `fanhao-quality-unopened-${crypto.randomUUID()}.sqlite`);
  const store = factory({ dbPath, coverDbPath: coverPath, roots: [], skipStartupMaintenance: true, readOnly });
  try {
    store.prepareSchema();
    assert(!fs.existsSync(coverPath), "unused cover database must not open");
    return { store, database };
  } catch (error) { store.close(); throw error; }
  finally { DatabaseSync.prototype.prepare = prepare; }
}

// Reuse the actual table, index and catalog-view definitions in the focused fixtures.
const schema = (() => {
  const { store, database } = openActualStore();
  try { return database.prepare("SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid").all(); }
  finally { store.close(); }
})();

function database({ nullable = false, indexes = null } = {}) {
  const db = new DatabaseSync(":memory:");
  try {
    for (const row of schema.filter(row => row.type === "table")) {
      if (row.name.startsWith("sqlite_") || row.name.startsWith("short_video_search_")) continue;
      let sql = row.sql;
      // An existing nullable actual_pixels column remains nullable in supported
      // old schemas; ensureShortVideoColumns only adds a missing column.
      if (nullable && row.name === "short_videos") sql = sql.replace("actual_pixels INTEGER NOT NULL DEFAULT 0", "actual_pixels INTEGER");
      db.exec(sql);
    }
    for (const row of schema.filter(row => row.type === "index")) {
      if (!indexes || indexes.includes(row.name)) db.exec(row.sql);
    }
    for (const row of schema.filter(row => row.type === "view")) db.exec(row.sql);
    // Search/topic/sound update triggers are outside these query scenarios.
    // Bulk population does not run their unrelated ingestion work.
    return db;
  } catch (error) { db.close(); throw error; }
}

function seed(db, nullable = true) {
  const video = db.prepare(`INSERT INTO short_videos
    (id, aweme_id, source_path, actual_pixels, media_type, visibility, is_liked, author_following,
     author_sec_uid, author_name, published_at, liked_at, liked_sort_at, liked_sort_time,
     digg_count, comment_count, duration_ms, size_bytes)
    VALUES (?, ?, '', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1, 2000, 3000)`);
  const watch = db.prepare("INSERT INTO short_video_watch_history(local_user_id,video_id,last_watched_at) VALUES ('local:self',?,?)");
  const membership = db.prepare(`INSERT INTO short_video_source_memberships
    (aweme_id,source_type,source_profile_id,is_missing_from_profile,first_seen_at,last_seen_at,updated_at)
    VALUES (?,'post','fixture',?,'2026','2026','2026')`);
  let index = 0;
  db.exec("BEGIN");
  try {
    for (const media of ["video", "gallery"]) for (const visibility of ["local_only", "pending"]) for (const pixels of points) {
      if (!nullable && pixels === null) continue;
      const id = `fixture-${String(index).padStart(3, "0")}`;
      const date = `2026-01-${String(index % 28 + 1).padStart(2, "0")}`;
      video.run(id, id, pixels, media, visibility, index % 2, `author-${index % 2}`, `作者 ${index % 2}`,
        date, date, date, index % 28, 1000 - index);
      watch.run(id, date);
      if (index % 3 === 0) membership.run(id, index % 2);
      index++;
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function oldFilter(params) { return oldPredicateModules.contract.videoFilter(params); }
function genericPage(db, filter, sort, limit, offset = 0) {
  const order = {
    published: "published_at DESC, liked_at DESC, id DESC",
    publishedAsc: "COALESCE(NULLIF(published_at, ''), '9999-12-31T23:59:59.999Z') ASC, liked_at ASC, id DESC",
    liked: "liked_sort_time DESC, liked_sort_at DESC, published_at DESC, id DESC",
    likedAsc: "COALESCE(liked_sort_time,1000000000000) ASC, liked_sort_at ASC, published_at ASC, id DESC",
    likes: "digg_count DESC, liked_at DESC, id DESC",
    watched: "last_watched_at DESC, published_at DESC, id DESC"
  }[sort];
  assert(order, "known generic sort");
  const where = filter.where ? `WHERE ${filter.where}` : "";
  return { total: Number(db.prepare(`SELECT COUNT(*) AS total FROM short_video_catalog ${where}`).get(...filter.args).total),
    rows: db.prepare(`SELECT ${COLUMNS} FROM short_video_catalog ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...filter.args, limit, offset) };
}
function compareRows(actualRows, expectedRows, name) { assert.deepEqual(actualRows, expectedRows, name); assert.equal(JSON.stringify(actualRows), JSON.stringify(expectedRows), `${name}: JSON order`); }
function recordedDatabase(db, queries) {
  return { prepare(sql) {
    const statement = db.prepare(sql);
    return { get(...args) { const data = statement.get(...args); queries.push({ sql, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) }); return data; },
      all(...args) { const data = statement.all(...args); queries.push({ sql, plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) }); return data; } };
  } };
}
function assertRangePlans(queries, message) {
  const indexed = queries.filter(item => item.sql.includes("FROM short_videos v"));
  assert.equal(indexed.length, 2, `${message}: both actual COUNT and page queries inspected`);
  for (const query of indexed) {
    const plan = query.plan.map(row => row.detail).join("; ");
    assert.match(plan, /SEARCH v USING (?:COVERING )?INDEX idx_short_videos_(?:actual_pixels|distribution) \([^)]*actual_pixels[><=?]/, `${message}: positive quality uses a range search: ${plan}`);
    assert.doesNotMatch(plan, /SCAN v USING INDEX idx_short_videos_actual_pixels/);
  }
  return indexed.length;
}
function paramsFor(quality, media, source, pending = false, deleted = false) {
  return new URLSearchParams({ quality, media, source, includePending: pending ? "1" : "0", deleted: deleted ? "deleted" : "all" });
}
const cases = [];
const scenario = (name, run) => cases.push({ name, run });
function withTruth(run, nullable = true) { const db = database({ nullable }); try { seed(db, nullable); return run(db); } finally { db.close(); } }

scenario("boundary-null-and-prefix-equivalence", () => withTruth(db => {
  for (const quality of [...qualityNames, "all", "invalid"]) for (const prefix of ["", "v."]) {
    const next = actual.contract.actualVideoQualityWhere(quality, prefix), old = oldQualityWhere(quality, prefix);
    const query = where => db.prepare(`SELECT id FROM short_videos v ${where ? `WHERE ${where}` : ""} ORDER BY id`).all();
    compareRows(query(next), query(old), `${quality}/${prefix || "unqualified"}`);
    if (["unknown", "all", "invalid"].includes(quality)) assert.equal(next, old, "unknown and unrestricted SQL unchanged");
  }
  const unknown = actual.contract.videoFilter(paramsFor("unknown", "all", "all", true));
  const rows = genericPage(db, unknown, "published", 100).rows;
  assert(rows.some(row => row.actual_pixels === null)); assert(rows.some(row => row.actual_pixels < 0)); assert(rows.some(row => row.actual_pixels === 0));
  assert(rows.every(row => row.media_type === "video"));
  const page = createPage(actual);
  let rangePlans = 0;
  for (const quality of qualityNames.filter(quality => quality !== "unknown")) for (const media of ["all", "video"]) {
    const filter = actual.contract.videoFilter(paramsFor(quality, media, "all"));
    const queries = [];
    const result = page.fastFilteredVideoPage(recordedDatabase(db, queries), filter, "published", 5, 0);
    const expected = genericPage(db, filter, "published", 5);
    assert.equal(result.total, expected.total); compareRows(result.rows, expected.rows, `${quality}/${media} range page`);
    rangePlans += assertRangePlans(queries, `${quality}/${media}`);
  }
  assert.equal(rangePlans, 20, "all five positive ranges search in both all and video scopes");
  console.log(`  positive-range COUNT/page plans: ${rangePlans}`);
}));

scenario("generic-filter-combinations-equivalence", () => withTruth(db => {
  let combinations = 0;
  for (const quality of qualityNames) for (const media of ["all", "video", "gallery"])
    for (const source of ["all", "liked", "following", "history", "posts", "local"])
      for (const pending of [false, true]) for (const deleted of [false, true]) {
        const params = paramsFor(quality, media, source, pending, deleted);
        const filter = actual.contract.videoFilter(params), old = oldFilter(params);
        assert.deepEqual({ ...filter, where: old.where }, old, "non-quality filter fields remain unchanged");
        for (const offset of [0, 3]) {
          const next = genericPage(db, filter, "published", 5, offset), before = genericPage(db, old, "published", 5, offset);
          assert.equal(next.total, before.total); compareRows(next.rows, before.rows, params.toString());
        }
        combinations++;
      }
  console.log(`  generic combinations: ${combinations}`);
}));

scenario("filtered-and-history-pages-match-generic", () => withTruth(db => {
  const page = createPage(actual), beforePage = createPage(oldPredicateModules);
  let pages = 0;
  for (const quality of qualityNames) for (const media of ["all", "video", "gallery"])
    for (const source of ["all", "liked", "following", "history", "posts", "local"]) for (const pending of [false, true])
      for (const requestedSort of ["published", "likes"]) for (const offset of [0, 3]) {
        const params = paramsFor(quality, media, source, pending);
        const filter = actual.contract.videoFilter(params), old = oldFilter(params);
        const sort = source === "history" ? "watched" : source === "liked" && requestedSort === "published" ? "liked" : requestedSort;
        const run = (queries, input) => source === "history" ? queries.fastHistoryVideoPage(db, input, sort, 5, offset)
          : queries.fastFilteredVideoPage(db, input, sort, 5, offset);
        const result = run(page, filter), oldResult = run(beforePage, old);
        assert(result); assert.deepEqual(result, oldResult, "bare predicate preserves fixed-media fast payload");
        const expected = genericPage(db, filter, sort, 5, offset);
        assert.equal(result.total, expected.total); compareRows(result.rows, expected.rows, params.toString());
        pages++;
      }
  for (const source of ["all", "history"]) {
    const filter = actual.contract.videoFilter(paramsFor("4k", "video", source, true, true));
    assert.equal(source === "history" ? page.fastHistoryVideoPage(db, filter, "watched", 5, 0)
      : page.fastFilteredVideoPage(db, filter, "published", 5, 0), null, "deleted scope retains generic fallback");
  }
  console.log(`  fast pages: ${pages}`);
}));

scenario("quality-cursor-pagination-no-kind-leaks", () => withTruth(db => {
  const page = createPage(actual);
  for (const quality of qualityNames) for (const media of ["all", "video", "gallery"]) for (const source of ["all", "liked", "posts", "local"]) {
    const filter = actual.contract.videoFilter(paramsFor(quality, media, source, true));
    const expected = genericPage(db, filter, "likes", 100);
    const rows = []; let cursor = null;
    for (let count = 0; count < 100; count++) {
      const result = page.fastFilteredVideoPage(db, filter, "likes", 3, 0, undefined, cursor);
      assert.equal(result.total, expected.total); rows.push(...result.rows);
      if (!result.hasMore) break;
      assert(result.nextCursor, "more data supplies an actual cursor");
      cursor = page.decodeShortVideoListCursor(result.nextCursor, "likes"); assert(cursor);
      assert(count < 99, "pagination bounded");
    }
    compareRows(rows, expected.rows, `${quality}/${media}/${source} cursor`);
    assert.equal(new Set(rows.map(row => row.id)).size, rows.length);
  }
}));

scenario("likes-cursor-seeks-composite-index", () => {
  const indexes = ["idx_short_videos_media_digg", "idx_short_videos_following_media_digg"];
  const db = database({ indexes });
  const tuple = "(v.digg_count, v.liked_at, v.id) < (?, ?, ?)";
  const legacy = "(v.digg_count < ? OR (v.digg_count = ? AND v.liked_at < ?) OR (v.digg_count = ? AND v.liked_at = ? AND v.id < ?))";
  const legacyDb = {
    prepare(sql) {
      if (!sql.includes(tuple)) return db.prepare(sql);
      const statement = db.prepare(sql.replace(tuple, legacy));
      return {
        all(likes, likedAt, id, limit, offset) {
          return statement.all(likes, likes, likedAt, likes, likedAt, id, limit, offset);
        }
      };
    }
  };
  try {
    db.exec(`WITH RECURSIVE sample(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM sample WHERE i<200000)
      INSERT INTO short_videos (id, source_path, media_type, visibility, liked_at, digg_count, author_following)
      SELECT printf('seek-%06d',i), '', 'video', CASE WHEN i%101=0 THEN 'pending' ELSE 'local_only' END,
        CASE WHEN i%7=0 THEN '' ELSE printf('2026-01-%02d',i%7) END,
        CASE WHEN i%200=0 THEN NULL ELSE i/30 END, i%5<>0 FROM sample;`);
    const page = createPage(actual);
    for (const [source, index] of [["all", indexes[0]], ["following", indexes[1]]]) {
      const filter = actual.contract.videoFilter(paramsFor("all", "video", source));
      const first = page.fastFilteredVideoPage(db, filter, "likes", 1, 0);
      for (const offset of [48, 10000, 100000]) {
        const previous = page.fastFilteredVideoPage(db, filter, "likes", 1, offset - 1, first.total);
        const cursor = page.decodeShortVideoListCursor(previous.nextCursor, "likes");
        const queries = [];
        const result = page.fastFilteredVideoPage(recordedDatabase(db, queries), filter, "likes", 48, 0, undefined, cursor);
        const expected = page.fastFilteredVideoPage(legacyDb, filter, "likes", 48, 0, undefined, cursor);
        assert.deepEqual(result, expected, `${source}/${offset}: existing cursor payload`);
        const offsetPage = page.fastFilteredVideoPage(db, filter, "likes", 48, offset, first.total);
        assert.deepEqual(result, offsetPage, `${source}/${offset}: ties preserve the full offset-page result`);
        assert.equal(queries.length, 2, "only seek and hydrate; cursor already contains the total");
        const plan = queries[0].plan.map(row => row.detail).join("; ");
        assert(plan.includes(`INDEX ${index}`) && plan.includes("(digg_count,liked_at,id)<(?,?,?)"), plan);
        assert.doesNotMatch(plan, /TEMP B-TREE/);
        if (offset === 100000) {
          const medianMs = database => {
            const samples = Array.from({ length: 11 }, () => {
              const started = performance.now();
              page.fastFilteredVideoPage(database, filter, "likes", 48, 0, undefined, cursor);
              return performance.now() - started;
            }).sort((a, b) => a - b);
            return Number(samples[5].toFixed(3));
          };
          console.log(JSON.stringify({ source, offset, cursorPageMedianMs: medianMs(db), legacyMedianMs: medianMs(legacyDb) }));
        }
      }
      // Raw NULL likes and the numeric zero projected by the catalog are both
      // present near the end. Compare continuation to the existing SQL rules.
      const zero = { likes: 0, likedAt: "", id: "seek-000014", total: first.total, seen: first.total - 1000 };
      assert.deepEqual(page.fastFilteredVideoPage(db, filter, "likes", 48, 0, undefined, zero),
        page.fastFilteredVideoPage(legacyDb, filter, "likes", 48, 0, undefined, zero));
    }
  } finally { db.close(); }
});

scenario("navigation-fast-paths-match-generic", () => withTruth(db => {
  const navigation = createNavigation(actual), prior = createNavigation(oldPredicateModules);
  const anchor = db.prepare("SELECT * FROM short_video_catalog WHERE id='fixture-020'").get();
  const modes = [
    ["history", "watched", "fastHistoryAdjacentRows"], ["liked", "published", "fastLikedAdjacentRows"],
    ["liked", "publishedAsc", "fastLikedAdjacentRows"], ["all", "published", "fastPublishedAdjacentRows"],
    ["all", "publishedAsc", "fastPublishedAdjacentRows"], ["posts", "published", "fastPublishedAdjacentRows"],
    ["local", "published", "fastPublishedAdjacentRows"], ["all", "likes", "fastMetricAdjacentRows"],
    ["liked", "likes", "fastMetricAdjacentRows"], ["following", "likes", "fastMetricAdjacentRows"],
    ["posts", "likes", "fastMetricAdjacentRows"], ["local", "likes", "fastMetricAdjacentRows"]
  ];
  let reads = 0;
  for (const quality of qualityNames) for (const media of ["all", "video", "gallery"]) for (const pending of [false, true])
    for (const [source, sort, method] of modes) for (const direction of [-1, 1]) {
      const params = paramsFor(quality, media, source, pending); params.set("sort", sort);
      const filter = actual.contract.videoFilter(params), old = oldFilter(params);
      const order = navigation.adjacentOrder({ searchParams: params });
      const rows = navigation[method](db, anchor, direction, filter, order, 5);
      assert(rows); compareRows(rows, prior[method](db, anchor, direction, old, order, 5), "old predicate navigation equivalence");
      const expected = navigation.adjacentRows(db, anchor, direction, order, true, filter, 5);
      assert.deepEqual(rows.map(row => row.id), expected.map(row => row.id), `${method}/${quality}/${media}/${direction}`);
      reads++;
    }
  console.log(`  navigation reads: ${reads}`);
}));

scenario("history-neighbors-seek-watched-time", async () => {
  const { store, database: db } = openActualStore();
  try {
    const populate = (first, last) => db.exec(`WITH RECURSIVE sample(i) AS (SELECT ${first} UNION ALL SELECT i+1 FROM sample WHERE i<${last})
      INSERT INTO short_videos (id, aweme_id, source_path, published_at, visibility, media_type, actual_pixels)
      SELECT printf('seek-%06d',i), printf('seek-%06d',i), '', printf('2026-%06d',i/4),
        CASE WHEN i%43=0 THEN 'pending' ELSE 'local_only' END,
        CASE WHEN i%11=0 THEN 'gallery' ELSE 'video' END,
        CASE WHEN i%13=0 THEN 8294400 ELSE 2073600 END FROM sample;
      INSERT INTO short_video_watch_history (local_user_id, video_id, last_watched_at)
      SELECT 'local:self', id, printf('%06d',CAST(substr(id,6) AS INTEGER)/3) FROM short_videos
      WHERE id BETWEEN printf('seek-%06d',${first}) AND printf('seek-%06d',${last});`);
    populate(1, 120);
    db.exec(`UPDATE short_video_watch_history SET last_watched_at='' WHERE video_id='seek-000120';
      INSERT INTO short_videos (id, source_path) VALUES ('unwatched','');
      INSERT INTO short_video_watch_history (local_user_id, video_id, last_watched_at)
        VALUES ('local:other','unwatched','999999'),('local:self','orphan','000020');`);

    const prepare = db.prepare.bind(db);
    const historyIndex = "idx_short_video_watch_history_recent_video";
    const bound = / AND w\.last_watched_at [<>]= \?/u;
    let legacy = false, diagnostics = null, visits = 0;
    db.function("fixture_history_visit", value => { visits++; return value; });
    db.prepare = (sql) => {
      if (!sql.includes(`FROM short_video_watch_history w INDEXED BY ${historyIndex}`)) return prepare(sql);
      const removeBound = legacy && bound.test(sql);
      const query = removeBound ? sql.replace(bound, "") : sql;
      const statement = prepare(query);
      return { all(...args) {
        if (removeBound) args.shift();
        const result = statement.all(...args);
        if (diagnostics) {
          const probe = query.replace("w.last_watched_at <> ''", "fixture_history_visit(w.last_watched_at) <> '' AND w.last_watched_at <> ''");
          const plan = query => prepare(`EXPLAIN QUERY PLAN ${query}`).all(...args).map(row => row.detail);
          const nativePlan = plan(query);
          assert.deepEqual(plan(probe), nativePlan, "the visit probe retains the uninstrumented native plan");
          visits = 0;
          assert.deepEqual(prepare(probe).all(...args), result);
          diagnostics.push({ visits, search: nativePlan.find(line => line.includes(historyIndex)) });
        }
        return result;
      } };
    };
    async function route(id, extra = "", before = false) {
      legacy = before;
      const result = {};
      const url = new URL(`http://fixture/api/short-videos/videos/${id}?source=history&sort=watched&neighbors=6&${extra}`);
      assert(await routeShortVideoApi({ method: "GET" }, result, url, {
        shortVideoStore: store, sendJson: (response, status, data) => Object.assign(response, { status, data })
      }));
      assert.equal(result.status, 200);
      return result;
    }
    for (const id of ["seek-000001", "seek-000060", "seek-000061", "seek-000119", "seek-000120", "unwatched"])
      for (const query of ["", "metadata=0", "quality=4k&media=video", "includePending=1&media=gallery"])
        assert.equal(JSON.stringify(await route(id, query)), JSON.stringify(await route(id, query, true)), `${id}/${query}: exact detail and neighbors`);

    populate(121, 100000);
    const before = [], after = [];
    diagnostics = before; const baseline = await route("seek-050000", "metadata=0", true);
    diagnostics = after; assert.deepEqual(await route("seek-050000", "metadata=0"), baseline);
    diagnostics = null;
    assert.equal(before.length, 2); assert.equal(after.length, 2);
    assert(before.every(item => item.visits >= 49000 && !item.search.includes("last_watched_at")));
    assert(after.every(item => item.visits <= 16 && item.search.includes("last_watched_at")));
    const oldSamples = [], newSamples = [];
    for (let round = 0; round < 7; round++) for (const previous of (round % 2 ? [false, true] : [true, false])) {
      const started = performance.now();
      await route("seek-050000", "metadata=0", previous);
      (previous ? oldSamples : newSamples).push(performance.now() - started);
    }
    const median = values => +values.sort((a, b) => a - b)[3].toFixed(3);
    console.log(JSON.stringify({ watchedVideos: 100000, completeDetailOracles: 25, before, after,
      beforeMedianMs: median(oldSamples), afterMedianMs: median(newSamples) }));
  } finally { store.close(); }
});

scenario("history-page-uses-watch-key-for-quality-filter", async () => {
  const { store, database: db } = openActualStore();
  try {
    db.exec(`WITH RECURSIVE sample(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM sample WHERE i<100000)
      INSERT INTO short_videos(id,aweme_id,source_path,visibility,media_type,actual_pixels,published_at)
      SELECT 'v'||i, 'v'||i, '', CASE WHEN i%47=0 THEN 'download_pending' ELSE 'local_only' END,
        CASE WHEN i%19=0 THEN 'gallery' ELSE 'video' END,
        CASE WHEN i%13=0 THEN 8294400 ELSE 2073600 END, printf('%06d',i%4) FROM sample;
      INSERT INTO short_video_watch_history(local_user_id,video_id,last_watched_at)
      SELECT 'local:self',id,printf('%06d',CAST(substr(id,2) AS INTEGER)/4000)
      FROM short_videos WHERE CAST(substr(id,2) AS INTEGER)%397=0;
      INSERT INTO short_video_watch_history(local_user_id,video_id,last_watched_at)
      VALUES ('local:self','orphan','999999'),('local:self','v1',''),('local:other','v13','999999');`);
    const prepare = db.prepare.bind(db);
    const historyJoin = /(FROM short_video_watch_history w)(\s+JOIN short_videos v ON v\.id = w\.video_id)/u;
    let legacy = false, plans = null;
    db.prepare = sql => {
      if (!historyJoin.test(sql)) return prepare(sql);
      const query = legacy ? sql.replace(historyJoin, "$1 INDEXED BY idx_short_video_watch_history_recent_video$2") : sql;
      const statement = prepare(query);
      if (!plans) return statement;
      const method = /SELECT COUNT\(\*\)/u.test(sql) ? "get" : "all";
      return { [method](...args) {
        plans.push(prepare(`EXPLAIN QUERY PLAN ${query}`).all(...args).map(row => row.detail));
        return statement[method](...args);
      } };
    };
    async function route(query, before = false) {
      legacy = before;
      const response = {};
      const url = new URL(`http://fixture/api/short-videos?source=history&sort=watched&limit=24&${query}`);
      assert(await routeShortVideoApi({ method: "GET" }, response, url, {
        shortVideoStore: store, sendJson: (res, status, data) => Object.assign(res, { status, data })
      }));
      assert.equal(response.status, 200);
      return response;
    }
    const filtered = "quality=4k&media=video";
    const queries = ["stats=0", "stats=0&offset=11", `stats=0&${filtered}`, `stats=1&${filtered}`,
      `stats=0&offset=2&${filtered}`, `stats=0&offset=500&${filtered}`, "stats=0&quality=1080p&media=gallery&includePending=1"];
    for (const query of queries) assert.equal(JSON.stringify(await route(query)), JSON.stringify(await route(query, true)), query);

    const before = [], after = [];
    plans = before; const old = await route(`stats=0&${filtered}`, true);
    plans = after; assert.deepEqual(await route(`stats=0&${filtered}`), old);
    plans = null;
    assert.equal(before.length, 2); assert.equal(after.length, 2);
    for (const plan of before) assert.match(plan[1], /idx_short_video_watch_history_recent_video \(local_user_id=\?\)/u);
    for (const plan of after) assert.match(plan[1], /sqlite_autoindex_short_video_watch_history_1 \(local_user_id=\? AND video_id=\?\)/u);
    const unfiltered = [];
    plans = unfiltered; await route("stats=0"); plans = null;
    assert.equal(unfiltered.length, 2);
    for (const plan of unfiltered) assert.match(plan[0], /idx_short_video_watch_history_recent_video/u);

    const timings = {};
    for (const stats of [0, 1]) {
      const samples = [[], []];
      for (let round = 0; round < 7; round++) for (const previous of (round % 2 ? [false, true] : [true, false])) {
        const started = performance.now();
        await route(`stats=${stats}&${filtered}`, previous);
        samples[previous ? 0 : 1].push(performance.now() - started);
      }
      timings[stats] = samples.map(values => +values.sort((a, b) => a - b)[3].toFixed(3));
    }

    db.exec(`UPDATE short_videos SET actual_pixels=CASE WHEN id IN ('v397','v794') THEN 8294400 ELSE 0 END;
      INSERT OR IGNORE INTO short_video_watch_history(local_user_id,video_id,last_watched_at)
      SELECT 'local:self',id,'000001' FROM short_videos;`);
    const dense = await route(`stats=0&${filtered}`);
    assert.equal(dense.data.total, 2);
    assert.deepEqual(dense, await route(`stats=0&${filtered}`, true), "dense history with a very selective quality filter");
    console.log(JSON.stringify({ check: "history-page-watch-key", videos: 100000, retainedHistory: 253,
      completeListOracles: queries.length + 2, before, after, wholeRouteMedianMs: timings }));
  } finally { store.close(); }
});

scenario("dense-quality-page-uses-bounded-publication-prefix", async () => {
  const oldPageSource = read("list-page-queries.js");
  const guard = /const publishedQuality = Boolean\(qualityWhere\)[\s\S]*?sort === "published";/u;
  assert.match(oldPageSource, guard);
  const previousPage = dataUrl(oldPageSource.replace(guard, "const publishedQuality = false;")
    .replace('"./query-contract.js"', JSON.stringify(new URL("query-contract.js", root).href))
    .replace('"./schema.js"', JSON.stringify(new URL("schema.js", root).href)));
  const previousStore = (await import(dataUrl(read("store.js").replace(/from "(\.\.?\/[^"\n]+)"/gu,
    (_match, relative) => `from ${JSON.stringify(relative === "./list-page-queries.js" ? previousPage : new URL(relative, root).href)}`)))).createShortVideoStore;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-quality-prefix-"));
  const dbPath = path.join(directory, "catalog.sqlite"), owners = [];
  const query = "source=all&media=video&sort=published&quality=1080p&limit=48&stats=0";
  let observe = false, failPage = false;
  function open(factory, readOnly = true) {
    const owner = openActualStore({ factory, dbPath, readOnly });
    owners.push(owner);
    const db = owner.database, prepare = db.prepare.bind(db);
    owner.plans = [];
    db.prepare = sql => {
      const statement = prepare(sql);
      const text = sql.replace(/\s+/gu, " ").trim();
      const kind = text.startsWith("WITH prefix AS MATERIALIZED (") ? "prefix"
        : text.startsWith("SELECT v.id FROM short_videos v INDEXED BY idx_short_videos_actual_pixels") ? "page"
          : text.startsWith("SELECT COUNT(*) AS count FROM short_videos v") ? "count" : "";
      if (!kind || (!observe && !failPage)) return statement;
      const method = kind === "count" ? "get" : "all";
      return { [method](...args) {
        if (failPage && kind !== "count") throw new Error("private synthetic read failure");
        owner.plans.push({ kind, plan: prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail) });
        return statement[method](...args);
      } };
    };
    return owner;
  }
  async function route(owner, params = query, status = 200) {
    const result = {};
    assert(await routeShortVideoApi({ method: "GET" }, result, new URL(`http://fixture/api/short-videos?${params}`), {
      shortVideoStore: owner.store, sendJson: (res, code, data) => Object.assign(res, { status: code, data })
    }));
    assert.equal(result.status, status);
    return result;
  }
  const median = values => +values.sort((a, b) => a - b)[Math.floor(values.length / 2)].toFixed(3);
  try {
    const writer = open(createShortVideoStore, false);
    writer.database.exec(`WITH RECURSIVE sample(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM sample WHERE i<100000)
      INSERT INTO short_videos(id,aweme_id,source_path,visibility,media_type,actual_pixels,published_at,liked_at)
      SELECT 'v'||i, 'v'||i, '', CASE WHEN i%41=0 THEN 'download_pending' ELSE 'local_only' END,
        CASE WHEN i%19=0 THEN 'gallery' ELSE 'video' END, CASE WHEN i%5=0 THEN 8294400 ELSE 2073600 END,
        printf('%06d',i%4000),printf('%06d',i%3) FROM sample;`);
    writer.store.close();
    const cold = [[], []], warm = [[], []], factories = [previousStore, createShortVideoStore];
    for (let round = 0; round < 3; round++) {
      const responses = [];
      for (const index of (round % 2 ? [1, 0] : [0, 1])) {
        const owner = open(factories[index]), started = performance.now();
        responses[index] = await route(owner); cold[index].push(performance.now() - started); owner.store.close();
      }
      assert.equal(JSON.stringify(responses[1]), JSON.stringify(responses[0]));
    }
    const previous = open(previousStore), current = open(createShortVideoStore);
    observe = true;
    assert.deepEqual(await route(current), await route(previous));
    observe = false;
    assert.deepEqual(previous.plans.map(row => row.kind), ["count", "page"]);
    assert.deepEqual(current.plans.map(row => row.kind), ["count", "prefix"]);
    assert.match(current.plans[0].plan[0], /COVERING INDEX idx_short_videos_distribution.*actual_pixels/u);
    assert(current.plans[1].plan.some(line => /idx_short_videos_media_published \(media_type=\? AND visibility=\?\)/u.test(line)));
    const cases = ["offset=137", "offset=450", "offset=600", "offset=99999", "stats=1", "quality=4k", "includePending=1", "media=gallery"];
    for (const variation of cases) {
      const params = new URLSearchParams(query);
      for (const [key, value] of new URLSearchParams(variation)) params.set(key, value);
      assert.equal(JSON.stringify(await route(current, params)), JSON.stringify(await route(previous, params)), variation);
    }
    for (let round = 0; round < 7; round++) for (const index of (round % 2 ? [1, 0] : [0, 1])) {
      const started = performance.now(); await route([previous, current][index]); warm[index].push(performance.now() - started);
    }
    const log = console.error;
    try {
      console.error = () => {}; failPage = true;
      assert.deepEqual(await route(current, query, 500), await route(previous, query, 500));
    } finally { failPage = false; console.error = log; }

    const mutation = new DatabaseSync(dbPath);
    try {
      for (const [sql, expected] of [
        ["UPDATE short_videos SET actual_pixels=8294400 WHERE published_at>'003900'", ["count", "prefix", "page"]],
        ["DROP INDEX idx_short_videos_media_published", ["count", "page"]],
        ["CREATE INDEX idx_short_videos_media_published ON short_videos(media_type, visibility)", ["count", "page"]]
      ]) {
        mutation.exec(sql);
        current.plans.length = 0; observe = true;
        const after = await route(current);
        observe = false;
        assert.deepEqual(after, await route(previous));
        assert.deepEqual(current.plans.map(row => row.kind), expected, "thin prefix and legacy indexes retain the original page");
      }
      mutation.exec("DROP INDEX idx_short_videos_actual_pixels");
      const log = console.error;
      try {
        console.error = () => {};
        assert.deepEqual(await route(current, query, 500), await route(previous, query, 500));
      } finally { console.error = log; }
    } finally { mutation.close(); }
    console.log(JSON.stringify({ check: "dense-quality-published-prefix", videos: 100000, completeListOracles: 15, errorOracles: 2,
      coldConnectionMedianMs: cold.map(median), warmMedianMs: warm.map(median), boundedPrefix: 1024 }));
  } finally {
    for (const { store } of owners) store.close();
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
});

scenario("broad-fts-hydrates-only-the-published-page", async () => {
  const source = read("store.js");
  const choice = "fastFtsPublishedRows(database, filter, sort, total, limit, offset) ?? ";
  assert.equal(source.split(choice).length, 2);
  const previous = (await import(dataUrl(source.replace(choice, "").replace(/from "(\.\.?\/[^"\n]+)"/gu,
    (_match, relative) => `from ${JSON.stringify(new URL(relative, root).href)}`)))).createShortVideoStore;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-fts-page-"));
  const dbPath = path.join(directory, "catalog.sqlite"), owners = [];
  const query = "source=all&sort=published&q=common+term&limit=48&stats=0&users=0";
  let inspect = false, failPage = false;
  function open(factory = createShortVideoStore, readOnly = true) {
    const owner = openActualStore({ factory, dbPath, readOnly });
    owners.push(owner);
    const db = owner.database, prepare = db.prepare.bind(db);
    db.prepare = sql => {
      const statement = prepare(sql), text = sql.trim();
      if (!(inspect || failPage) || !text.includes("LIMIT ? OFFSET ?") || !text.includes("short_video_search MATCH ?")
        || !(text.startsWith("WITH fts_page AS MATERIALIZED") || text.startsWith("SELECT id,"))) return statement;
      return { all(...args) {
        if (failPage) throw new Error("private synthetic page read failure");
        owner.plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
        return statement.all(...args);
      } };
    };
    return owner;
  }
  async function route(owner, params = query, status = 200) {
    const response = {};
    assert(await routeShortVideoApi({ method: "GET" }, response, new URL(`http://fixture/api/short-videos?${params}`), {
      shortVideoStore: owner.store, sendJson: (res, code, data) => Object.assign(res, { status: code, data })
    }));
    assert.equal(response.status, status);
    return response;
  }
  const median = samples => +samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)].toFixed(3);
  try {
    const writer = open(createShortVideoStore, false);
    writer.database.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000)
      INSERT INTO short_video_users(id,sec_uid,nickname) SELECT 'u'||i,'sec'||i,'Author '||i FROM n;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<100000)
      INSERT INTO short_videos(id,aweme_id,owner_user_id,title,description,source_path,visibility,media_type,published_at,liked_at)
      SELECT 'v'||i,'v'||i,'u'||(i%1000+1),CASE WHEN i%4=0 THEN 'other ' ELSE 'common term ' END||i,'Synthetic text','',
        CASE WHEN i%41=0 THEN 'download_pending' ELSE 'local_only' END,CASE WHEN i%19=0 THEN 'gallery' ELSE 'video' END,
        printf('%06d',i%4000),printf('%06d',i%3) FROM n;
      INSERT INTO short_video_stats(video_id,digg_count) SELECT id,length(id)*100 FROM short_videos WHERE substr(id,-1)='0';
      INSERT INTO short_video_assets(id,video_id,asset_type,size_bytes) SELECT 'asset-'||id,id,'video',100 FROM short_videos WHERE substr(id,-1)='1';
      INSERT INTO short_video_search(video_id,title) VALUES('v1','common term duplicate'),('orphan','common term orphan');`);
    writer.store.close();
    const factories = [previous, createShortVideoStore], cold = [[], []], warm = [[], []];
    for (let round = 0; round < 3; round++) {
      const responses = [];
      for (const i of (round % 2 ? [1, 0] : [0, 1])) {
        const owner = open(factories[i]), started = performance.now();
        responses[i] = await route(owner); cold[i].push(performance.now() - started); owner.store.close();
      }
      assert.equal(JSON.stringify(responses[1]), JSON.stringify(responses[0]));
    }
    const before = open(previous), after = open();
    inspect = true;
    const original = await route(before);
    assert.deepEqual(await route(after), original);
    inspect = false;
    assert.equal(original.data.total, 73170);
    assert(before.plan.filter(row => row.detail.endsWith("LEFT-JOIN")).length >= 10);
    const rank = after.plan.find(row => row.detail === "MATERIALIZE fts_page");
    assert(rank && after.plan.some(row => row.detail.includes("sqlite_autoindex_short_videos_1 (id=?)")));
    assert(!after.plan.some(row => row.parent === rank.id && row.detail.endsWith("LEFT-JOIN")));
    for (const [key, value] of [["offset",45],["offset",70000],["offset",90000],["includePending",1],["q","missing-query"],["stats",1]]) {
      const params = new URLSearchParams(query); params.set(key, value);
      assert.equal(JSON.stringify(await route(after, params)), JSON.stringify(await route(before, params)));
    }
    for (let round = 0; round < 7; round++) for (const i of (round % 2 ? [1, 0] : [0, 1])) {
      const start = performance.now(); await route([before, after][i]); warm[i].push(performance.now() - start);
    }
    const log = console.error;
    try {
      console.error = () => {}; failPage = true;
      assert.deepEqual(await route(after, query, 500), await route(before, query, 500));
      assert.equal(after.database.isTransaction, false);
    } finally { failPage = false; console.error = log; }
    const mutation = new DatabaseSync(dbPath);
    try {
      const definition = name => mutation.prepare("SELECT sql FROM sqlite_schema WHERE name=?").get(name).sql;
      const view = definition("short_video_catalog"), baseView = definition("short_video_catalog_base");
      mutation.exec("DROP VIEW short_video_catalog; " + view.replace("1 AS recommendation_author_rank", "(1) AS recommendation_author_rank"));
      inspect = true;
      assert.deepEqual(await route(after), await route(before));
      assert(!after.plan.some(row => row.detail === "MATERIALIZE fts_page"), "older view uses the original full page");
      const assets = definition("short_video_assets").replace(/,\s*UNIQUE\(video_id, asset_type\)/u, "");
      mutation.exec(`DROP VIEW short_video_catalog; DROP VIEW short_video_catalog_base;
        ALTER TABLE short_video_assets RENAME TO old_assets; ${assets};
        INSERT INTO short_video_assets SELECT * FROM old_assets; DROP TABLE old_assets;
        CREATE INDEX fixture_assets_video ON short_video_assets(video_id,asset_type);
        INSERT INTO short_video_assets(id,video_id,asset_type,size_bytes) VALUES('dup1','v3999','video',11),('dup2','v3999','video',22);
        ${baseView}; ${view};`);
      const legacy = await route(after);
      assert.deepEqual(legacy, await route(before));
      assert(!after.plan.some(row => row.detail === "MATERIALIZE fts_page"), "nonunique legacy assets use the original full page");
      assert.equal(legacy.data.videos.filter(row => row.id === "v3999").length, 2);
    } finally { mutation.close(); }
    console.log(JSON.stringify({ check: "broad-fts-published-page", videos: 100000, matched: original.data.total, completeListOracles: 12, errorOracles: 1,
      coldConnectionMedianMs: cold.map(median), warmMedianMs: warm.map(median) }));
  } finally {
    for (const { store } of owners) store.close();
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  }
});

scenario("topic-sound-likes-hydrates-only-the-visible-page", async () => {
  const source = read("store.js");
  const choice = "fastTopicSoundLikesRows(database, filter, sort, total, limit, offset)\n        ?? ";
  assert.equal(source.split(choice).length, 2);
  const absolute = text => text.replace(/from "(\.\.?\/[^"\n]+)"/gu,
    (_match, relative) => `from ${JSON.stringify(new URL(relative, root).href)}`);
  const baseline = absolute(source.replace(choice, ""));
  const previous = (await import(dataUrl(baseline))).createShortVideoStore;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-short-topic-page-"));
  const dbPath = path.join(directory, "catalog.sqlite");
  const owners = [], clients = [];
  const common = "source=all&sort=likes&limit=36&facets=0&stats=0&users=0&";
  const topic = "topic=dense";
  const sound = "sound=" + Buffer.from("sound:fixture").toString("base64url");
  let mutation, inspect = false, fault = null, interleave = null;
  function open(factory = createShortVideoStore, readOnly = true) {
    const owner = openActualStore({ factory, dbPath, readOnly });
    owners.push(owner);
    const db = owner.database, nativePrepare = db.prepare.bind(db), nativeExec = db.exec.bind(db);
    db.exec = sql => {
      if (fault === "savepoint" && sql.startsWith("SAVEPOINT short_video_topic_sound_page")) throw new Error("fixture savepoint unavailable");
      return nativeExec(sql);
    };
    db.prepare = sql => {
      const text = sql.trim();
      if (fault === "probe" && text.startsWith("EXPLAIN QUERY PLAN SELECT id AS rank_id")) throw new Error("fixture plan unavailable");
      const statement = nativePrepare(sql);
      const projected = text.startsWith("WITH topic_sound_page AS MATERIALIZED");
      if (!(inspect || fault || interleave) || !text.includes("LIMIT ? OFFSET ?")
        || !(projected || text.startsWith("SELECT id,"))) return statement;
      return { all(...args) {
        if (fault === "page") throw new Error("fixture topic page read failed");
        if (projected && interleave) { const write = interleave; interleave = null; write(); }
        owner.plan = nativePrepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args);
        return statement.all(...args);
      } };
    };
    return owner;
  }
  async function route(owner, query, expected = 200) {
    const response = {};
    assert(await routeShortVideoApi({ method: "GET" }, response, new URL(`http://fixture/api/short-videos?${common}${query}`), {
      shortVideoStore: owner.store, listVideos: owner.list,
      sendJson: (res, status, data) => Object.assign(res, { status, data })
    }));
    assert.equal(response.status, expected);
    return response;
  }
  const hasProjection = owner => owner.plan.some(row => row.detail === "MATERIALIZE topic_sound_page");
  try {
    const writer = open(createShortVideoStore, false);
    writer.database.exec(`PRAGMA synchronous=OFF; BEGIN IMMEDIATE;
      WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<80000)
      INSERT INTO short_videos(id,aweme_id,author_sec_uid,author_name,title,description,tags_json,tags_text,
        visibility,media_type,published_at,liked_at,source_path,digg_count,mtime_ms)
      SELECT 'v-'||i,'aw-'||i,'author-'||(i%2000),'Author '||(i%2000),'Title '||i,'Synthetic media fixture',
        CASE WHEN i%997=0 THEN '["small"]' WHEN i%3=0 THEN '[]' ELSE '["dense"]' END,
        CASE WHEN i%997=0 THEN 'small' WHEN i%3=0 THEN '' ELSE 'dense' END,
        CASE WHEN i%53=0 THEN 'download_pending' ELSE 'local_only' END,CASE WHEN i%5=0 THEN 'gallery' ELSE 'video' END,
        printf('%08d',i/7),printf('%08d',i/7),'synthetic/'||i,i%1700,i FROM n;
      INSERT OR REPLACE INTO short_video_sounds(video_id,sound_key,sound_id,title)
        SELECT id,'sound:fixture','snd','Sound Fixture' FROM short_videos WHERE mtime_ms%2=0;
      INSERT INTO short_video_stats(video_id,digg_count) SELECT id,70000-mtime_ms FROM short_videos WHERE mtime_ms%10=0;
      COMMIT`);
    writer.store.close();
    const before = open(previous), after = open();
    inspect = true;
    for (const query of [topic, topic + "&offset=12000", topic + "&offset=80000", sound,
      `${topic}&${sound}`, topic + "&includePending=1", topic + "&media=video"]) {
      assert.deepEqual(await route(after, query), await route(before, query));
      assert(hasProjection(after), query);
    }
    const rank = after.plan.find(row => row.detail === "MATERIALIZE topic_sound_page");
    assert.deepEqual(after.plan.filter(row => row.parent === rank.id && row.detail.endsWith("LEFT-JOIN")).map(row => row.detail),
      ["SEARCH s USING INDEX sqlite_autoindex_short_video_stats_1 (video_id=?) LEFT-JOIN"]);
    assert(after.plan.some(row => row.detail.includes("sqlite_autoindex_short_videos_1 (id=?)")));
    assert.deepEqual(await route(after, "topic=small"), await route(before, "topic=small"));
    assert(!hasProjection(after));
    for (fault of ["probe", "savepoint"]) {
      assert.deepEqual(await route(after, topic), await route(before, topic));
      assert(!hasProjection(after));
      assert.equal(after.database.isTransaction, false);
    }
    const log = console.error;
    try {
      console.error = () => {}; fault = "page";
      assert.deepEqual(await route(after, topic, 500), await route(before, topic, 500));
      assert.equal(after.database.isTransaction, false);
    } finally { console.error = log; fault = null; inspect = false; }

    const oldStoreUrl = pathToFileURL(path.join(directory, "baseline-store.mjs"));
    const oldWorkerUrl = pathToFileURL(path.join(directory, "baseline-worker.mjs"));
    fs.writeFileSync(oldStoreUrl, baseline);
    fs.writeFileSync(oldWorkerUrl, absolute(read("list-worker.js").replace('"./store.js"', JSON.stringify(oldStoreUrl.href))));
    clients.push(createShortVideoCatalogWorkerClient({ dbPath, workerUrl: oldWorkerUrl }), createShortVideoCatalogWorkerClient({ dbPath }));
    const workers = clients.map(catalogWorker => {
      const service = createShortVideoListStatsService({ catalogWorker, store: {
        catalogStamp: () => "fixture", listVideos() { assert.fail("fixture must use the actual Worker"); }
      } });
      return { list: url => service.list(url) };
    });
    const metrics = {};
    for (const [name, query] of [["topic", topic], ["topicDeep", topic + "&offset=12000"], ["sound", sound]]) {
      assert.deepEqual(await route(workers[0], query), await route(workers[1], query));
      const samples = [[], []];
      for (let pair = 0; pair < 5; pair++) {
        const replies = [];
        for (const mode of pair % 2 ? [1, 0] : [0, 1]) {
          const started = performance.now(); replies[mode] = await route(workers[mode], query);
          samples[mode].push(performance.now() - started);
        }
        assert.deepEqual(replies[0], replies[1]);
      }
      metrics[name] = samples.map(values => +values.sort((a, b) => a - b)[2].toFixed(2));
    }
    await Promise.all(clients.map(client => client.stop()));
    mutation = new DatabaseSync(dbPath);
    const pinned = await route(before, topic);
    interleave = () => mutation.exec("UPDATE short_video_stats SET digg_count=1000000 WHERE video_id='v-80000'");
    assert.deepEqual(await route(after, topic), pinned);
    assert.equal(interleave, null);
    const committed = await route(after, topic);
    assert.deepEqual(committed, await route(before, topic));
    assert.equal(committed.data.videos[0].id, "v-80000");
    mutation.exec(`DROP TABLE short_video_stats;
      CREATE TABLE short_video_stats(video_id TEXT,digg_count INTEGER,comment_count INTEGER,collect_count INTEGER,
        share_count INTEGER,play_count INTEGER,snapshot_at TEXT,updated_at TEXT);
      INSERT INTO short_video_stats(video_id,digg_count) VALUES('v-80000',1000000),('v-80000',999999)`);
    inspect = true;
    const legacy = await route(after, topic);
    assert.deepEqual(legacy, await route(before, topic));
    assert(!hasProjection(after));
    assert.equal(legacy.data.videos.filter(row => row.id === "v-80000").length, 2);
    console.log(JSON.stringify({ check: "short-video-topic-sound-likes-page", videos: 80000, workerRouteMedianMs: metrics,
      legacyDuplicateStats: true, concurrentMetricSnapshot: true }));
  } finally {
    await Promise.all(clients.map(client => client.stop()));
    mutation?.close();
    for (const { store } of owners) store.close();
    const owned = fs.realpathSync(directory);
    assert.equal(path.dirname(owned), fs.realpathSync(os.tmpdir()));
    assert(path.basename(owned).startsWith("fanhao-short-topic-page-"));
    for (const item of fs.readdirSync(owned, { withFileTypes: true })) {
      assert(item.isFile());
      fs.unlinkSync(path.join(owned, item.name));
    }
    fs.rmdirSync(owned);
  }
});

scenario("sparse-4k-range-plan-20-offsets", () => {
  const db = database({ indexes: ["idx_short_videos_actual_pixels"] });
  try {
    db.exec(`WITH RECURSIVE sample(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM sample WHERE i<300000)
      INSERT INTO short_videos (id,aweme_id,source_path,actual_pixels,media_type,visibility,published_at,liked_at,digg_count)
      SELECT printf('large-%06d',i),printf('large-%06d',i),'',CASE WHEN i%1000=0 THEN 8294400 ELSE 2073600 END,
        'video',CASE WHEN i%101=0 THEN 'pending' ELSE 'local_only' END,printf('2026-01-%02d',i%28+1),'2026-01-01',i FROM sample;`);
    const page = createPage(actual), oldPage = createPage(oldPredicateModules);
    const params = paramsFor("4k", "video", "all"), filter = actual.contract.videoFilter(params), old = oldFilter(params);
    const samples = { current: [], old: [] }; let plansChecked = 0;
    for (let offset = 0; offset < 20; offset++) {
      const queries = [];
      let start = performance.now(); const result = page.fastFilteredVideoPage(recordedDatabase(db, queries), filter, "published", 12, offset * 12);
      samples.current.push(performance.now() - start);
      start = performance.now(); const previous = oldPage.fastFilteredVideoPage(db, old, "published", 12, offset * 12);
      samples.old.push(performance.now() - start); assert.deepEqual(result, previous);
      assert.equal(result.total, 298); assert.equal(result.rows.length, 12); assert.equal(queries.length, 3, "COUNT, ID page, bounded hydration");
      plansChecked += assertRangePlans(queries, `offset ${offset * 12}`);
    }
    const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)];
    console.log(JSON.stringify({ rows: 300000, matches: 298, offsets: 20, rangePlans: plansChecked,
      medianMs: { current: Number(median(samples.current).toFixed(3)), oldCoalesce: Number(median(samples.old).toFixed(3)) } }));
  } finally { db.close(); }
});

export async function runShortVideoQualityQueries({ selected = caseName } = {}) {
  const chosen = selected ? cases.filter(item => item.name === selected) : cases;
  assert(chosen.length, "known case name");
  for (const item of chosen) { await item.run(); console.log(`PASS ${item.name}`); }
  console.log(`Short-video quality queries: ${chosen.length} cases PASS`);
  return chosen.length;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await runShortVideoQualityQueries();
