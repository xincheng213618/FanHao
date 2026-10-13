import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createGalleryMetadataService } from "../src/modules/media/server/gallery-metadata-service.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createGalleryMediaService } from "../src/modules/media/server/gallery-media-service.js";

// Real publication/detail services and private SQLite only. The former path
// ignores the new publication option and retains the original raw point reads.
const legacy = process.argv.includes("--legacy-point-projection");
assert(process.argv.slice(2).every(value => value === "--legacy-point-projection"));
const owners = [];
const columns = "media_id TEXT,series_key TEXT,category TEXT,series_name TEXT,movie_title TEXT,douban_title TEXT,status TEXT,cover_blob,json_ld_json,info_json TEXT,updated_at TEXT";
const sql = { movie: "SELECT * FROM movie_metadata WHERE media_id = ?", tv: "SELECT * FROM tv_series_metadata WHERE series_key = ?" };
const key = "tvs:drama|Series";

function open(old = false, initialize = true) {
  let db = new DatabaseSync(":memory:"); owners.push(db);
  const metrics = { queries: 0, pointPrepares: 0, schemaReads: 0, blobBytes: 0, tvJsonBytes: 0 };
  let readFault = null;
  function instrument(connection) {
    const prepare = connection.prepare.bind(connection);
    connection.prepare = query => {
      const statement = prepare(query), get = statement.get.bind(statement);
      const point = /^SELECT .* FROM "?(?:movie_metadata|tv_series_metadata)"? WHERE/u.test(query);
      if (point) metrics.pointPrepares++;
      statement.get = (...args) => {
        if (query === "PRAGMA schema_version") metrics.schemaReads++;
        if (point && readFault) { const error = readFault; readFault = null; throw error; }
        const row = get(...args);
        if (point) {
          metrics.queries++;
          metrics.blobBytes += row?.cover_blob?.byteLength || 0;
          if (query.includes("tv_series_metadata")) metrics.tvJsonBytes += Buffer.byteLength(row?.json_ld_json || "");
        }
        return row;
      };
      return statement;
    };
  }
  function seed(connection = db) {
    for (const table of ["movie_metadata", "tv_series_metadata"]) connection.exec(`CREATE TABLE ${table}(${columns})`);
    const blob = Buffer.alloc(2 * 1024 * 1024, 65), ld = JSON.stringify({ description: "x".repeat(1024 * 1024) });
    connection.prepare("INSERT INTO movie_metadata VALUES('movie',NULL,'film',NULL,'Movie','Movie','ok',?,'{}','{}','v1')").run(blob);
    connection.prepare("INSERT INTO tv_series_metadata VALUES(NULL,?,'drama','Series',NULL,'Series','ok',?,?,'{}','v1')").run(key, blob, ld);
  }
  instrument(db);
  if (initialize) seed();
  const metadata = createGalleryMetadataService({ createId: (prefix, value) => `${prefix}:${value}`, getImageGalleryDb: () => db,
    notFound: res => { res.status = 404; } });
  if (old) {
    // Keep the whole old point behavior independent of the new projection helper.
    for (const [name, table, query] of [["movieRow", "movie", sql.movie], ["tvSeriesRow", "tv-series", sql.tv]]) {
      metadata[name] = id => {
        if (!id) return null;
        try { return db.prepare(query).get(id) || null; }
        catch (error) { console.warn(`[${table}-metadata-db]`, error.message || error); return null; }
      };
    }
  }
  const raw = [{ id: "movie", mediaKind: "movie", category: "film", title: "Movie" },
    { id: "tv", mediaKind: "tv", category: "drama", seriesName: "Series", title: "Series E1" }]
    .map(row => ({ ...row, sourceRoot: "synthetic", relativePath: `${row.id}.mkv`, size: 42 }));
  const index = { photoSets: [], mediaItems: raw };
  const library = createImageLibraryService({ getImageLibraryIndex: () => index, metadataService: metadata });
  const gallery = createGalleryMediaService({ getImageLibraryIndex: () => index, publicGalleryMediaItem: library.publicGalleryMediaItem,
    playbackProgressService: { getVideoProgress: () => ({ positionMs: 12 }) }, safeChildPath: (root, file) => `${root}/${file}`,
    safeStat: () => ({ size: 42, mtimeMs: 0, isFile: () => true }), normalizeExt: () => ".mkv" });
  return { get db() { return db; }, metadata, metrics, seed,
    detail: i => gallery.publicDetail(raw[i]),
    fault: error => { readFault = error; },
    replace() { db = new DatabaseSync(":memory:"); owners.push(db); instrument(db); seed(); }
  };
}
function compare(before, after) {
  for (const index of [0, 1]) assert.deepEqual(after.detail(index), before.detail(index));
}
function pair(initialize = true) { return { before: open(true, initialize), after: open(legacy, initialize) }; }
function exec(pair, statement) { pair.before.db.exec(statement); pair.after.db.exec(statement); }
function response() { return { status: null, headers: null, body: null,
  writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } }; }

function verifyMutableConnections() {
  for (const kind of ["facade", "facade-isOpen", "native-proxy"]) {
    const a = new DatabaseSync(":memory:"), b = new DatabaseSync(":memory:"); owners.push(a, b);
    for (const [database, title] of [[a, "A"], [b, "B"]]) {
      database.exec(`CREATE TABLE movie_metadata(${columns}); CREATE TABLE tv_series_metadata(${columns})`);
      database.prepare("INSERT INTO movie_metadata(media_id,status,douban_title,cover_blob) VALUES('movie','ok',?,x'0102')").run(title);
      database.prepare("INSERT INTO tv_series_metadata(series_key,status,douban_title,cover_blob,json_ld_json) VALUES(?,'ok',?,x'0304','retained raw text')").run(key, title);
    }
    assert.equal(a.prepare("PRAGMA schema_version").get().schema_version, b.prepare("PRAGMA schema_version").get().schema_version);
    let active = a;
    const prepared = [];
    const prepare = query => { prepared.push(query); return active.prepare(query); };
    const connection = kind === "native-proxy"
      ? new Proxy(a, { get(_target, property) {
        if (property === "prepare") return prepare;
        const value = Reflect.get(active, property, active);
        return typeof value === "function" ? value.bind(active) : value;
      } })
      : { prepare };
    if (kind === "facade-isOpen") Object.defineProperty(connection, "isOpen", { get: () => active.isOpen });
    if (kind === "native-proxy") assert(connection instanceof DatabaseSync, "native proxies also pass instanceof");
    const metadata = createGalleryMetadataService({ getImageGalleryDb: () => connection });
    for (const database of [a, b]) {
      active = database;
      assert.deepEqual(metadata.movieRow("movie", { forPublication: true }), active.prepare(sql.movie).get("movie"), `${kind} must keep the live raw movie read`);
      assert.deepEqual(metadata.tvSeriesRow(key, { forPublication: true }), active.prepare(sql.tv).get(key), `${kind} must keep the live raw TV read`);
    }
    a.close();
    assert.deepEqual(metadata.movieRow("movie", { forPublication: true }), b.prepare(sql.movie).get("movie"));
    assert.deepEqual(metadata.tvSeriesRow(key, { forPublication: true }), b.prepare(sql.tv).get(key));
    assert.deepEqual(prepared, [sql.movie, sql.tv, sql.movie, sql.tv, sql.movie, sql.tv], "facades must not retain statements or introduce schema probes");
  }
}

try {
  const measured = pair();
  assert(measured.after.detail(0).movieMetadata);
  assert(measured.after.detail(1).tvSeries, "the TV fixture must hit its real metadata row");
  for (const name of Object.keys(measured.after.metrics)) measured.after.metrics[name] = 0;
  for (let i = 0; i < 20; i++) compare(measured.before, measured.after);
  assert.equal(measured.before.metrics.blobBytes, 80 * 1024 * 1024);
  assert.equal(measured.before.metrics.queries, 40);
  assert.equal(measured.after.metrics.queries, 40);
  assert.equal(measured.after.metrics.blobBytes, 0, "detail publication must not materialize cover bytes");
  assert.equal(measured.after.metrics.tvJsonBytes, 0, "TV detail must not read unused JSON-LD");
  assert.equal(measured.after.metrics.schemaReads, 40, "every point read must still observe schema changes");

  const live = pair();
  compare(live.before, live.after);
  for (const value of [null, Buffer.alloc(0), Buffer.from([7, 8]), "", "text", "\0tail", "head\0tail", 0, 5, -5, 0.5, -0.5]) {
    for (const side of [live.before, live.after]) for (const table of ["movie_metadata", "tv_series_metadata"])
      side.db.prepare(`UPDATE ${table} SET cover_blob=?`).run(value);
    compare(live.before, live.after);
  }
  for (const json of ['{"@type":"TVSeries"}', '{"@graph":[{"@type":"TVEpisode"}]}', '{"@type":"Movie"}', "broken"] ) {
    for (const side of [live.before, live.after]) side.db.prepare("UPDATE movie_metadata SET json_ld_json=?").run(json);
    compare(live.before, live.after);
  }
  exec(live, "UPDATE movie_metadata SET json_ld_json='{}',info_json='{\"集数\":\"7\"}'"); compare(live.before, live.after);
  assert.equal(live.after.detail(0).movieMetadata, null, "movie/TV identity guard remains live");
  exec(live, "UPDATE movie_metadata SET info_json='{}'; UPDATE tv_series_metadata SET status='error'"); compare(live.before, live.after);
  exec(live, "UPDATE tv_series_metadata SET status='ok'; ALTER TABLE movie_metadata ADD COLUMN extra TEXT"); compare(live.before, live.after);
  exec(live, "ALTER TABLE tv_series_metadata DROP COLUMN json_ld_json; ALTER TABLE movie_metadata DROP COLUMN cover_blob"); compare(live.before, live.after);
  exec(live, "DROP TABLE tv_series_metadata; CREATE TABLE tv_series_metadata(series_key TEXT PRIMARY KEY,status TEXT,douban_title TEXT); INSERT INTO tv_series_metadata VALUES('tvs:drama|Series','ok','Old schema')"); compare(live.before, live.after);
  exec(live, "DELETE FROM movie_metadata; DELETE FROM tv_series_metadata"); compare(live.before, live.after);
  live.before.replace(); live.after.replace(); compare(live.before, live.after);

  // Existing raw access and cover responses keep full bytes and identity guards.
  assert.equal(live.after.metadata.movieRow("movie").cover_blob.byteLength, 2 * 1024 * 1024);
  assert.equal(live.after.metadata.tvSeriesRow(key).json_ld_json.length, 1024 * 1024 + 18);
  for (const [method, id] of [["serveMovieCover", "movie"], ["serveTvSeriesCover", key]]) {
    const a = response(), b = response(); live.before.metadata[method](a, id); live.after.metadata[method](b, id);
    assert.deepEqual({ status: b.status, headers: b.headers, body: b.body }, { status: a.status, headers: a.headers, body: a.body });
    assert.equal(b.body.length, 2 * 1024 * 1024);
  }

  const originalWarn = console.warn, logs = [];
  console.warn = (...args) => logs.push(args);
  try {
    const missing = pair(false);
    compare(missing.before, missing.after);
    assert(logs.some(args => String(args[1]).includes("no such table")), "uninitialized schemas retain SQL failure warnings");
    missing.before.seed(); missing.after.seed(); compare(missing.before, missing.after);
    for (const side of [missing.before, missing.after]) side.fault(new Error("controlled read failure"));
    compare(missing.before, missing.after); compare(missing.before, missing.after);
    for (const side of [missing.before, missing.after]) side.db.close();
    compare(missing.before, missing.after);
    assert.equal(logs.filter(args => args[1] === "database is not open").length, 4);
    for (const side of [missing.before, missing.after]) { side.db.open(); side.seed(); }
    compare(missing.before, missing.after);
    for (const side of [missing.before, missing.after]) { side.db.close(); side.db.open(); side.seed(); }
    compare(missing.before, missing.after);
  } finally { console.warn = originalWarn; }
  verifyMutableConnections();
  console.log(JSON.stringify({ ok: true, requests: 40, before: measured.before.metrics, current: measured.after.metrics }));
} finally { for (const db of owners) if (db.isOpen) db.close(); }
