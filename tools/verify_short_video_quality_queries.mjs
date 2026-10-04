import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createShortVideoStore } from "../src/modules/short-videos/server/store.js";

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
      .replace('"./constants.js"', JSON.stringify(new URL("constants.js", root).href));
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

// Initialize the actual store's schema in memory, then reuse its actual table,
// index and catalog-view definitions. No files, media paths or service exist.
function actualSchema() {
  const prepare = DatabaseSync.prototype.prepare;
  let database;
  DatabaseSync.prototype.prepare = function(sql) { database = this; return prepare.call(this, sql); };
  const coverPath = path.join(os.tmpdir(), `fanhao-quality-unopened-${crypto.randomUUID()}.sqlite`);
  const store = createShortVideoStore({ dbPath: ":memory:", coverDbPath: coverPath, roots: [], skipStartupMaintenance: true });
  try {
    store.prepareSchema();
    const schema = prepare.call(database, "SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid").all();
    assert(!fs.existsSync(coverPath), "unused cover database must not open");
    return schema;
  } finally { DatabaseSync.prototype.prepare = prepare; store.close(); }
}
const schema = actualSchema();

function database({ nullable = false, large = false } = {}) {
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
      if (!large || row.name === "idx_short_videos_actual_pixels") db.exec(row.sql);
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
  const indexed = queries.filter(item => item.sql.includes("FROM short_videos v INDEXED BY idx_short_videos_actual_pixels"));
  assert.equal(indexed.length, 2, `${message}: both actual COUNT and page queries inspected`);
  for (const query of indexed) {
    const plan = query.plan.map(row => row.detail).join("; ");
    assert.match(plan, /SEARCH v USING INDEX idx_short_videos_actual_pixels \(actual_pixels[><=?]/, `${message}: positive quality uses a range search: ${plan}`);
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

scenario("sparse-4k-range-plan-20-offsets", () => {
  const db = database({ large: true });
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

export function runShortVideoQualityQueries({ selected = caseName } = {}) {
  const chosen = selected ? cases.filter(item => item.name === selected) : cases;
  assert(chosen.length, "known case name");
  for (const item of chosen) { item.run(); console.log(`PASS ${item.name}`); }
  console.log(`Short-video quality queries: ${chosen.length} cases PASS`);
  return chosen.length;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) runShortVideoQualityQueries();
