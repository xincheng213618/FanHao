import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWorkInfoService } from "../src/modules/fanhao/server/works/work-info-service.js";
import { createWorkPresenterService } from "../src/modules/fanhao/server/works/presenter-service.js";

// Only private in-memory catalogs participate. Source category labels survive
// the lightweight index without retaining descriptions, fields JSON or raw text.
const catalogs = [];
const warnings = [];
const warn = console.warn;
console.warn = (...args) => warnings.push(args);
try {
  const target = fixture();
  const labels = JSON.stringify([
    { label: "类别", value: "單體作品 / 眼鏡" },
    { name: "genres", value: ["恋爱", "眼鏡"] },
    { key: "description", value: "Long description ".repeat(8192) }
  ]);
  target.db.prepare("UPDATE works SET fields_json=?,javdb_tags_json=? WHERE id=1")
    .run(labels, '["高清","恋爱"]');
  const row = target.info.facetRow("1");
  assert.deepEqual(row.trait_tags, ["單體作品", "眼鏡", "恋爱", "高清"]);
  assert.equal(Object.hasOwn(row, "fields_json"), false);
  assert.equal(Object.hasOwn(row, "javdb_tags_json"), false);
  assert.equal(Object.hasOwn(row, "raw_text"), false);
  assert.ok(JSON.stringify(row).length < 512, "a large description cannot become retained facet payload");
  for (let i = 0; i < 1000; i++) assert.equal(target.info.facetRow("1"), row);
  assert.equal(target.state.all, 1, "all facet consumers reuse one compact metadata query");
  assert.ok(target.state.sql.every(sql => !sql.includes("raw_text")), "facet SQL never selects raw text");

  const work = { id: "1", personId: "1", title: "Fixture", directoryName: "AB-001",
    relativePath: "Actor/AB-001", videos: [], infoSummary: { tags: ["source summary"] } };
  const presenter = createWorkPresenterService({
    getLibrary: () => ({ peopleById: new Map() }),
    displayPersonForWork: () => null, actorProfileRow: () => null, publicActorProfile: () => null,
    publicCoreWorkCover: () => null, manualCoverStateService: { manualCoverForWork: () => null },
    favoriteStateService: { publicFavoriteForWork: () => null },
    playbackProgressService: { getWorkProgress: () => null }, localWorkMarkers: () => [],
    displayWorkTitle: String, publicWorkInfoSummary: (_row, fallback) => fallback,
    workInfoDetailRow: () => null, workInfoFacetRow: target.info.facetRow,
    proxiedRemoteImageUrl: value => value || "", uniqueTextArray: unique,
    firstPresentValue: target.info.firstPresentValue, dbBoolOrNull: () => null
  });
  for (const missingLocal of [false, true]) {
    const projected = presenter.publicWork({ ...work, missingLocal });
    assert.ok(projected.traits.tags.includes("单体作品"));
    assert.ok(projected.traits.tags.includes("眼镜"));
    assert.ok(projected.traits.tags.includes("恋爱"));
  }
  assert.equal(target.state.all, 1, "direct presenter paths share the same facet index");

  target.db.prepare("UPDATE works SET fields_json=?,javdb_tags_json='[]' WHERE id=1")
    .run('[{"label":"类别","value":"新标签"}]');
  target.state.stamp = "refresh";
  target.state.failAll = true;
  const stale = target.info.withReadStatus(() => target.info.facetRow("1"));
  assert.equal(stale.cacheable, false);
  assert.equal(stale.value, row, "a transient refresh error retains the previous complete source tags");
  target.state.failAll = false;
  const recovered = target.info.withReadStatus(() => target.info.facetRow("1"));
  assert.equal(recovered.cacheable, true);
  assert.deepEqual(recovered.value.trait_tags, ["新标签"], "same-stamp recovery replaces the fallback");

  for (const columns of [[], ["fields_json"], ["javdb_tags_json"]]) {
    const old = fixture(columns);
    const result = old.info.withReadStatus(() => old.info.facetRow("1"));
    assert.equal(result.cacheable, true, "a confirmed absent optional column is a valid older catalog");
    assert.deepEqual(result.value.trait_tags, columns.includes("fields_json") ? ["旧标签"]
      : columns.includes("javdb_tags_json") ? ["外部标签"] : []);
    assert.equal(old.state.all, 1, "compatibility chooses a valid projection before reading rows");
  }

  const busy = fixture();
  busy.state.failPrepare = true;
  assert.deepEqual(busy.info.withReadStatus(() => busy.info.facetRow("1")), { value: null, cacheable: false });
  assert.equal(busy.state.sql.length, 1, "a transient error cannot be treated as an absent optional column");
  busy.state.failPrepare = false;
  assert.deepEqual(busy.info.withReadStatus(() => busy.info.facetRow("1")).value.trait_tags, ["旧标签", "外部标签"]);

  const malformed = fixture();
  malformed.db.exec("UPDATE works SET fields_json='invalid json',javdb_tags_json='[\"可用标签\"]'");
  assert.deepEqual(malformed.info.facetRow("1").trait_tags, ["可用标签"]);
  console.log(JSON.stringify({ ok: true, sourceCategoryProjection: true, compactRetainedPayload: true,
    directLocalAndMissingWorkProjection: true, metadataQueriesFor1000Consumers: 1,
    optionalColumnSchemas: 4, transientReadRecovery: true, warnings: warnings.length }));
} finally {
  console.warn = warn;
  for (const db of catalogs) db.close();
}

function parse(value) { try { const data = JSON.parse(value || "[]"); return Array.isArray(data) ? data : []; } catch { return []; } }
function unique(value) { return [...new Set(value || [])]; }
function fixture(columns = ["fields_json", "javdb_tags_json"]) {
  const db = new DatabaseSync(":memory:");
  catalogs.push(db);
  db.exec(`CREATE TABLE works(id INTEGER PRIMARY KEY,code TEXT,release_date TEXT,duration_minutes INTEGER,rating REAL,rating_count INTEGER,status TEXT${columns.map(name => `,${name} TEXT`).join("")});
    CREATE TABLE local_works(id INTEGER PRIMARY KEY,work_id INTEGER);
    INSERT INTO works(id,code,rating,status) VALUES(1,'AB-001',4.2,'ok');
    INSERT INTO local_works VALUES(1,1);`);
  if (columns.includes("fields_json")) db.prepare("UPDATE works SET fields_json=?").run('[{"label":"类别","value":"旧标签"}]');
  if (columns.includes("javdb_tags_json")) db.prepare("UPDATE works SET javdb_tags_json=?").run('["外部标签"]');
  const state = { stamp: "initial", sql: [], all: 0, failAll: false, failPrepare: false };
  const owner = { prepare(sql) {
    state.sql.push(sql);
    if (state.failPrepare) throw Object.assign(new Error("controlled prepare failure"), { code: "SQLITE_BUSY" });
    const statement = db.prepare(sql);
    return { all(...params) {
      state.all++;
      if (state.failAll) throw Object.assign(new Error("controlled read failure"), { code: "SQLITE_BUSY" });
      return statement.all(...params);
    } };
  } };
  const info = createWorkInfoService({ getCoreDb: () => owner, getStamp: () => state.stamp,
    parseJsonArray: parse, parseJsonTextArray: parse, uniqueTextArray: unique });
  return { db, info, state };
}
