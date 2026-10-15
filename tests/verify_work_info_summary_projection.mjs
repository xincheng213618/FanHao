import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createWorkInfoService } from "../src/modules/fanhao/server/works/work-info-service.js";
import { createWorkPresenterService } from "../src/modules/fanhao/server/works/presenter-service.js";

// Native SQLite, real query text, actual presenter and production wrappers.
// No service process or application database participates in this fixture.
assert.ok(process.argv.slice(2).every(value => value === "--legacy-projection"));
const legacy = process.argv.includes("--legacy-projection");
const presenterUrl = new URL("../src/modules/fanhao/server/works/presenter-service.js", import.meta.url);
let previousPresenterSource = fs.readFileSync(presenterUrl, "utf8");
for (const text of ["{ includeMetadata: false }", "{ includeMetadata: includeFiles }"]) {
  const call = `workInfoDetailRow(work.id, ${text})`;
  assert.equal(previousPresenterSource.split(call).length, 2);
  previousPresenterSource = previousPresenterSource.replace(call, "workInfoDetailRow(work.id)");
}
const { createWorkPresenterService: previousPresenter } = await import(`data:text/javascript;base64,${Buffer.from(previousPresenterSource).toString("base64")}`);
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const wrappers = server.slice(server.indexOf("function workInfoDetailRow("), server.indexOf("function studioCatalogStamp("));
assert.ok(wrappers.includes("function prewarmWorkInfoDetails("));
const connect = new Function("workInfoService", wrappers + "\nreturn { workInfoDetailRow, prewarmWorkInfoDetails };");
const db = new DatabaseSync(":memory:");
const ids = Array.from({ length: 900 }, (_, i) => String(i + 1));
let cards = 0, avatars = 0, details = 0;
try {
  db.exec(`
    ATTACH DATABASE ':memory:' AS fanhao_images;
    CREATE TABLE works(id INTEGER PRIMARY KEY,code TEXT,title TEXT,release_date TEXT,duration_minutes INTEGER,rating REAL,rating_count INTEGER,director TEXT,fields_json TEXT,raw_text TEXT,status TEXT,error TEXT,updated_at TEXT);
    CREATE TABLE local_works(id INTEGER PRIMARY KEY,work_id INTEGER,source_info_id INTEGER,source_name TEXT,source_info_path TEXT,source_size INTEGER,source_mtime INTEGER);
    CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE work_people(work_id INTEGER,person_id INTEGER,role TEXT);
    CREATE TABLE person_external_refs(person_id INTEGER,provider TEXT,url TEXT);
    CREATE TABLE work_external_refs(work_id INTEGER,provider TEXT,url TEXT);
    CREATE TABLE makers(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE work_makers(work_id INTEGER,maker_id INTEGER,role TEXT);
    CREATE TABLE maker_external_refs(maker_id INTEGER,provider TEXT,url TEXT);
    CREATE TABLE series(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE work_series(work_id INTEGER,series_id INTEGER);
    CREATE TABLE series_external_refs(series_id INTEGER,provider TEXT,url TEXT);
    CREATE TABLE fanhao_images.images(id INTEGER PRIMARY KEY,owner_type TEXT,owner_id INTEGER,kind TEXT,remote_url TEXT,image_blob BLOB);
    CREATE INDEX idx_lw ON local_works(work_id);
    CREATE INDEX idx_wp ON work_people(work_id);
    CREATE INDEX fanhao_images.idx_images ON images(owner_id);
    INSERT INTO people VALUES(1,'Actor 中文'),(2,'Another actor');
    INSERT INTO person_external_refs VALUES(1,'javdb-actor','https://example.test/actor');
    INSERT INTO makers VALUES(1,'Maker'),(2,'Label');
    INSERT INTO maker_external_refs VALUES(1,'javdb-maker','https://example.test/maker');
    INSERT INTO series VALUES(1,'Series');
    INSERT INTO series_external_refs VALUES(1,'javdb-series','https://example.test/series');
  `);
  const insert = db.prepare("INSERT INTO works VALUES(?,?,?,'2026',120,4.2,100,'Director',?,?,'ok','','2026')");
  const local = db.prepare("INSERT INTO local_works VALUES(?,?,1,'synthetic','synthetic',1,1)");
  const actor = db.prepare("INSERT INTO work_people VALUES(?,1,'actor')");
  const preview = db.prepare("INSERT INTO fanhao_images.images VALUES(?,'work',?,'preview','https://example.test/preview',NULL)");
  const fields = JSON.stringify([{ name: "Long field", value: "F".repeat(8192) }]);
  db.exec("BEGIN");
  for (let id = 1; id <= 903; id++) {
    insert.run(id, `CODE${id}`, `Title ${id}`, fields, "R".repeat(32768));
    if (id !== 903) local.run(id, id);
    actor.run(id); preview.run(id, id);
  }
  db.exec("DELETE FROM works WHERE id=901;UPDATE works SET status='missing' WHERE id=902;UPDATE works SET raw_text=NULL,fields_json=NULL WHERE id=898;UPDATE works SET raw_text=zeroblob(32768) WHERE id=899;");
  db.exec("INSERT INTO work_people VALUES(1,2,'actor');INSERT INTO work_makers VALUES(1,1,'maker'),(1,2,'label');INSERT INTO work_series VALUES(1,1);INSERT INTO work_external_refs VALUES(1,'javdb-video','https://example.test/work');COMMIT");
  const old = fixture(true), next = fixture(legacy);
  const works = ids.map(work);
  const previousRows = old.service.prewarmDetailRows(ids);
  next.adapter.prewarmWorkInfoDetails(works);
  const beforeBytes = old.returnedBytes, afterBytes = next.returnedBytes;
  assert.equal(old.reads, 5); assert.equal(next.reads, 5);
  for (const item of works) {
    assert.deepEqual(next.presenter.publicWork(item), old.presenter.publicWork(item)); cards++;
    assert.deepEqual(next.presenter.publicWorkCoverAvatar(item, "1"), old.presenter.publicWorkCoverAvatar(item, "1")); avatars++;
  }
  assert.equal(next.reads, 5, "900 cards and fallback avatars must consume five real SQL batches");
  assert.ok(beforeBytes > 70 * 1024 * 1024);
  assert.equal(next.metadataBytes, 0, "summary SQL must not materialize fields_json or raw_text");
  assert.ok(afterBytes < 1024 * 1024);
  for (const id of ["1", "450", "898", "899", "900", "901", "902", "903"]) {
    const item = work(id);
    assert.deepEqual(next.presenter.publicWork(item, true), old.presenter.publicWork(item, true)); details++;
    const reads = next.reads;
    assert.deepEqual(next.presenter.publicWork(item), old.presenter.publicWork(item)); cards++;
    assert.equal(next.reads, reads, "complete details satisfy later cards without reading again");
    if (previousRows.has(id)) assert.deepEqual(next.service.detailRow(id), previousRows.get(id));
  }
  const reads = next.reads;
  for (const options of [{ lightweightInfo: true }, { includeUserState: false }]) {
    assert.deepEqual(next.presenter.publicWork(work("1"), false, options), old.presenter.publicWork(work("1"), false, options)); cards++;
  }
  assert.equal(next.reads, reads);
  await Promise.resolve();
  for (const id of ["1", "898", "901"]) {
    assert.deepEqual(next.presenter.publicWork(work(id)), old.presenter.publicWork(work(id))); cards++;
  }
  console.log(JSON.stringify({ ok: true, cards, avatars, details, pageRows: 900, batchQueries: 5,
    previousReturnedBytes: beforeBytes, summaryReturnedBytes: afterBytes, summaryMetadataBytes: 0 }));
} finally { db.close(); }

function parse(value) { try { return JSON.parse(value || "[]"); } catch { return []; } }
function unique(value) { return [...new Set(value || [])]; }
function fixture(full) {
  const target = { reads: 0, returnedBytes: 0, metadataBytes: 0 };
  const service = createWorkInfoService({
    getStamp: () => "fixture", getCoreDb: () => ({ prepare(sql) {
      const statement = db.prepare(sql);
      return { all(...params) {
        target.reads++;
        const rows = statement.all(...params);
        for (const row of rows) {
          target.returnedBytes += Object.values(row).reduce((bytes, value) => bytes + weight(value), 0);
          target.metadataBytes += weight(row.raw_text) + weight(row.fields_json);
        }
        return rows;
      } };
    } }),
    displayWorkTitle: value => String(value || ""), parseJsonArray: parse, parseJsonTextArray: parse,
    proxiedRemoteImageUrl: value => value || "", proxiedRemoteImageUrlArray: value => value || [],
    publicRemoteUrl: value => value || "", renderInfoMetadataText: () => "Rendered fields", uniqueTextArray: unique
  });
  target.service = service;
  target.adapter = full ? {
    workInfoDetailRow: id => service.detailRow(id),
    prewarmWorkInfoDetails: works => service.prewarmDetailRows(works.map(item => item.id))
  } : connect(service);
  target.presenter = (full ? previousPresenter : createWorkPresenterService)({
    getLibrary: () => ({ peopleById: new Map() }), displayPersonForWork: () => ({ id: "1", name: "Actor" }),
    actorProfileRow: () => null, publicActorProfile: () => null, publicCoreWorkCover: () => null,
    manualCoverStateService: { manualCoverForWork: () => null }, favoriteStateService: { publicFavoriteForWork: () => null },
    playbackProgressService: { getWorkProgress: () => null, getVideoProgress: () => null }, localWorkMarkers: () => [],
    displayWorkTitle: value => String(value || ""), publicWorkInfoSummary: service.publicSummary,
    publicWorkInfoMetadata: service.publicMetadata, workInfoDetailRow: target.adapter.workInfoDetailRow,
    uniqueTextArray: unique, dbBoolOrNull: value => value == null ? null : Boolean(Number(value)),
    firstPresentValue: service.firstPresentValue, proxiedRemoteImageUrl: value => value || ""
  });
  return target;
}
function weight(value) { return typeof value === "string" ? value.length * 2 : ArrayBuffer.isView(value) ? value.byteLength : 0; }
function work(id) {
  return { id: String(id), title: `Local ${id}`, directoryName: "local", personId: "1", videos: [], images: [], infos: [],
    infoSummary: { imageUrl: "https://example.test/fallback", hasMagnet: true, hasSubtitles: false,
      javdbTags: ["fallback"], maker: "Fallback maker", actors: ["Fallback actor"], tags: ["Fallback tag"] } };
}
