import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createWorkInfoDatabase } from "./fixtures/work-info-cache-recovery.mjs";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";
import { renderInfoMetadataText } from "../lib/info-metadata.js";

// Complete production factories, native SQLite and synthetic rows only. The
// detail-only isolation policy is asserted separately from historical equality.
const BEFORE = "63c5fab243233e142cfd62c4eaf13812feb92405";
const owners = {
  info: ["work-info-service.js", "createWorkInfoService", "a0249777518c76d12f0fd1e0ac074a4c9eb5eaba296a6523eca0f4ad2bbaa0b3"],
  presenter: ["presenter-service.js", "createWorkPresenterService", "a3511223178769fa14b8f645c6a4bb9ed76bdcc0b1f6147a813814fbefa1439c"],
  detail: ["work-detail-service.js", "createWorkDetailService", "7816d1e1c93a25428301a692c99c8ed22d84aa6c24fef8eb875df51f5eea34be"]
};
const serverSource = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const helperSource = serverSource.slice(serverSource.indexOf("function parseJsonArray("), serverSource.indexOf("function publicRemoteUrl("));
const serverHelpers = new Function(`${helperSource}\nreturn {parseJsonArray,uniqueTextArray,parseJsonTextArray};`)();
assert.ok(process.argv.slice(2).every(value => value === "--legacy-detail-facets"));
const negative = process.argv.includes("--legacy-detail-facets");
const previous = {}, current = {}, production = {};
async function load(source, url, exported, label) {
  source = source.replace(/from (["'])(\.[^"']+)\1/g, (_all, quote, relative) => `from ${quote}${new URL(relative, url).href}${quote}`);
  source += `\n//# sourceURL=work-detail-facet-${label}.js\n`;
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`))[exported];
}
for (const [key, [file, exported, hash]] of Object.entries(owners)) {
  const relative = `src/modules/fanhao/server/works/${file}`, url = new URL(`../${relative}`, import.meta.url);
  const old = execFileSync("git", ["show", `${BEFORE}:${relative}`], { encoding: "utf8" }).replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(old).digest("hex"), hash);
  previous[key] = await load(old, url, exported, `before-${key}`);
  let source = fs.readFileSync(url, "utf8").replaceAll("\r\n", "\n");
  if (key === "info") {
    assert.equal(source.split("    detailFacetRow,").length, 2);
    source = source.replace("    detailFacetRow,", `    fixturePointCache: () => workInfoDetailFacetCache && ({ entries: workInfoDetailFacetCache.rows.size,
      bytes: workInfoDetailFacetCache.bytes, rows: [...workInfoDetailFacetCache.rows.values()].map(value => value.row) }),\n    detailFacetRow,`);
  }
  production[key] = await load(source, url, exported, `current-${key}`);
  if (key === "detail") {
    assert.equal(source.split("{ detailFacets: true }").length, 2);
    if (negative) source = source.replace("{ detailFacets: true }", "{ detailFacets: false }");
  }
  current[key] = await load(source, url, exported, `candidate-${key}`);
}
const temp = createVerifiedTempDir("fanhao-work-detail-facets-");
const databases = [];
let active = null, comparisons = 0, policyCases = 0, warnings = 0;
const nativePrepare = DatabaseSync.prototype.prepare, nativeExec = DatabaseSync.prototype.exec;
const scratch = new DatabaseSync(":memory:");
const statementPrototype = Object.getPrototypeOf(scratch.prepare("SELECT 1")), nativeAll = statementPrototype.all;
scratch.close();
const statements = new WeakMap();
const warn = console.warn;
console.warn = (...args) => { assert.match(String(args[0]), /^\[core-work-info-(?:facets|detail)\]$/); warnings++; };
const stats = () => ({ facetReads: 0, pointReads: 0, facetRows: 0, facetBytes: 0, metadataReads: 0, detailReads: 0, fieldsInputBytes: 0 });
DatabaseSync.prototype.prepare = function (sql, ...args) {
  if (active) active.fault?.("prepare", sql);
  const statement = nativePrepare.call(this, sql, ...args);
  statements.set(statement, { sql, db: this });
  return statement;
};
statementPrototype.all = function (...args) {
  const metadata = statements.get(this), f = active;
  if (f && metadata) f.fault?.("all", metadata.sql);
  const rows = nativeAll.apply(this, args);
  if (f && metadata) {
    const sql = metadata.sql;
    if (sql.includes("CAST(w.id AS TEXT) AS work_id") && !sql.includes("w.title")) {
      f.stats.facetReads++; f.stats.pointReads += Number(sql.includes("AND w.id = ?")); f.stats.facetRows += rows.length;
      for (const row of rows) for (const value of Object.values(row)) if (typeof value === "string") f.stats.facetBytes += Buffer.byteLength(value);
    } else if (/^PRAGMA /i.test(sql)) f.stats.metadataReads++;
    else if (sql.includes("source_info_id")) f.stats.detailReads++;
    f.afterRead?.(metadata, rows);
  }
  return rows;
};
DatabaseSync.prototype.exec = function (sql, ...args) {
  active?.fault?.("exec", sql);
  return nativeExec.call(this, sql, ...args);
};
const parse = serverHelpers.parseJsonArray, unique = serverHelpers.uniqueTextArray;
function database(count = 2) { const db = createWorkInfoDatabase({ count }); db.exec("CREATE INDEX fixture_local_work_id ON local_works(work_id)"); databases.push(db); return db; }
function fixture(factories = current, { db = database(), person = false, provider = null } = {}) {
  const f = { db, stamp: "initial", stats: stats(), fault: null, afterRead: null, parseFault: null };
  f.run = callback => { const prior = active; active = f; try { return callback(); } finally { active = prior; } };
  f.reset = () => { f.stats = stats(); };
  f.info = factories.info({ getCoreDb: () => provider ? provider() : db, getStamp: () => { f.onStamp?.(); return f.stamp; },
    displayWorkTitle: value => value || "", parseJsonArray: value => { f.parseFault?.(value); if (typeof value === "string") f.stats.fieldsInputBytes += Buffer.byteLength(value); return parse(value); },
    parseJsonTextArray: serverHelpers.parseJsonTextArray, uniqueTextArray: unique, publicRemoteUrl: value => value || "",
    proxiedRemoteImageUrl: value => value || "", proxiedRemoteImageUrlArray: value => value || [], renderInfoMetadataText });
  f.works = new Map(["1", "2", "3"].map(id => [id, { id, personId: person ? "1" : "", title: `Local ${id}`, directoryName: `AA-${id}`,
    relativePath: `Synthetic/AA-${id}`, videos: [], images: [], infos: [], videoCount: 0, playableCount: 0, imageCount: 0, infoCount: 0, modifiedAt: "2026" }]));
  const actor = { id: "1", name: "Synthetic", works: ["1", "2"], sourcePaths: ["Synthetic"], workCount: 2 };
  f.library = { scannedAt: "scan", peopleById: new Map(person ? [["1", actor]] : []), worksById: f.works, filesById: new Map() };
  const progress = { getWorkProgress: () => null, getVideoProgress: () => null };
  f.presenter = factories.presenter({ getLibrary: () => f.library, displayPersonForWork: () => person ? actor : null,
    actorProfileRow: () => null, publicActorProfile: () => null, publicActorProfileSnapshot: () => ({ profile: null, avatar: { avatarUrl: "/synthetic/avatar.svg" } }),
    publicCoreWorkCover: () => null, manualCoverStateService: { manualCoverForWork: () => null }, favoriteStateService: { publicFavoriteForWork: () => null },
    playbackProgressService: progress, localWorkMarkers: () => [], isGPerson: () => false, displayWorkTitle: value => value || "",
    publicWorkInfoSummary: f.info.publicSummary, publicWorkInfoMetadata: f.info.publicMetadata,
    workInfoDetailRow: f.info.detailRow, workInfoFacetRow: f.info.facetRow, workInfoDetailFacetRow: f.info.detailFacetRow || f.info.facetRow,
    uniqueTextArray: unique, firstPresentValue: f.info.firstPresentValue, dbBoolOrNull: value => value == null ? null : Boolean(Number(value)), proxiedRemoteImageUrl: value => value || "" });
  f.detail = factories.detail({ library: f.library, playbackProgressService: progress, peoplePayloadStamp: () => "", workQueryStamp: () => f.stamp, userStateStamp: () => "",
    prewarmCoreWorkCovers: () => {}, prewarmRemoteImagesForWorks: () => {}, publicWork: f.presenter.publicWork, publicPerson: f.presenter.publicPerson,
    resolveLibraryWorkByPublicId: id => f.works.get(String(id)) || null, withWorkInfoReadStatus: f.info.withReadStatus, workInfoReadCacheable: f.info.readCacheable });
  f.read = (id = "1") => f.run(() => f.detail.detailPayload(id));
  f.point = (id = "1") => f.run(() => f.info.withReadStatus(() => f.info.detailFacetRow(id)));
  return f;
}
function equal(old, next, label) { assert.deepEqual(next, old, label); assert.equal(JSON.stringify(next), JSON.stringify(old), `${label}: complete wire/field order`); comparisons++; return next; }
function compare(db, label, options = {}) { const old = fixture(previous, { db, ...options }), next = fixture(current, { db, ...options }); equal(old.read(), next.read(), label); return [old, next]; }
function compareFacet(db, id, label, options = {}) {
  const old = fixture(previous, { db, ...options }), next = fixture(production, { db, ...options });
  equal(old.run(() => old.info.facetRow(id)), next.point(id).value, label);
  assert.equal(db.isTransaction, false);
  return next;
}
function replaceWorks(db, idDefinition, tail = "") {
  const columns = db.prepare("PRAGMA main.table_info(works)").all();
  db.exec(`ALTER TABLE works RENAME TO original_works; CREATE TABLE works(${columns.map(column => `${column.name} ${column.name === "id" ? idDefinition : column.type}`).join(",")}) ${tail}; INSERT INTO works SELECT * FROM original_works; DROP TABLE original_works`);
}
const tags = JSON.stringify([{ label: "类别", value: "單體作品 / 眼鏡" }, { name: "genres", value: ["恋爱", "眼鏡"] }, { label: "类别", value: "高清" }]);

// One isolated native heap graph follows the actual retained row's tag elements
// to V8 sliced-string parents. Visible string length alone cannot prove this
// memory bound: 128 short tags could otherwise retain a multi-megabyte source.
async function detachedTagHeap() {
  const assert = (await import("node:assert/strict")).default;
  const { DatabaseSync } = await import("node:sqlite"), { getHeapSnapshot } = await import("node:v8");
  const { createWorkInfoService } = await import(process.argv[1]);
  const helpers = new Function(`${process.argv[2]}\nreturn {parseJsonArray,uniqueTextArray,parseJsonTextArray};`)();
  function build() {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE works(id INTEGER PRIMARY KEY,code TEXT,release_date TEXT,duration_minutes INTEGER,rating REAL,rating_count INTEGER,fields_json TEXT,javdb_tags_json TEXT,status TEXT); CREATE TABLE local_works(work_id INTEGER); INSERT INTO local_works VALUES(1)");
    const longTags = Array.from({ length: 50000 }, (_, index) => `retained_tag_marker_${String(index).padStart(8, "0")}_abcdefghijklmnopqrstuvwxyz`).join(",");
    db.prepare("INSERT INTO works VALUES(1,?,?,?,?,?,?,?,?)").run("SYN", "2026", 10, 4, 1, JSON.stringify([{ label: "类别", value: longTags }]), "[]", "ok");
    const info = createWorkInfoService({ getCoreDb: () => db, getStamp: () => "fixture", ...helpers });
    const row = info.detailFacetRow("1");
    assert.equal(row.trait_tags.length, 128); assert.equal(row.trait_tags.join("").length, 7040);
    assert.equal(info.detailFacetRow("1"), row);
    return { db, info, row };
  }
  const marker = "__fanhaoDetailFacetHeapFixture";
  try {
    globalThis[marker] = build(); globalThis.gc(); globalThis.gc();
    const chunks = []; for await (const chunk of getHeapSnapshot()) chunks.push(chunk);
    const heap = JSON.parse(Buffer.concat(chunks));
    const fields = heap.snapshot.meta.node_fields, edgeFields = heap.snapshot.meta.edge_fields;
    const ni = Object.fromEntries(fields.map((name, index) => [name, index])), ei = Object.fromEntries(edgeFields.map((name, index) => [name, index]));
    const { nodes, edges, strings } = heap, nodeStride = fields.length, edgeStride = edgeFields.length;
    const nodeTypes = heap.snapshot.meta.node_types[ni.type], edgeTypes = heap.snapshot.meta.edge_types[ei.type];
    const outgoing = new Map(); let offset = 0;
    for (let node = 0; node < nodes.length; node += nodeStride) { outgoing.set(node, offset); offset += nodes[node + ni.edge_count] * edgeStride; }
    function nodeEdges(node) {
      const result = [];
      for (let k = 0, at = outgoing.get(node); k < nodes[node + ni.edge_count]; k++, at += edgeStride) {
        const type = edgeTypes[edges[at + ei.type]], key = type === "element" || type === "hidden" ? edges[at + ei.name_or_index] : strings[edges[at + ei.name_or_index]];
        result.push({ type, key, target: edges[at + ei.to_node] });
      }
      return result;
    }
    let root;
    for (let node = 0; node < nodes.length && root === undefined; node += nodeStride) root = nodeEdges(node).find(edge => edge.type === "property" && edge.key === marker)?.target;
    assert.notEqual(root, undefined);
    const row = nodeEdges(root).find(edge => edge.type === "property" && edge.key === "row")?.target;
    const array = nodeEdges(row).find(edge => edge.type === "property" && edge.key === "trait_tags")?.target;
    const tags = nodeEdges(array).filter(edge => edge.type === "element" && edge.key < 128);
    assert.equal(tags.length, 128);
    let largeParentEdges = 0;
    for (const tag of tags) if (nodeTypes[nodes[tag.target + ni.type]] === "sliced string") {
      for (const edge of nodeEdges(tag.target)) if (edge.key === "parent" && nodes[edge.target + ni.self_size] > 2 * 1024 * 1024
        && strings[nodes[edge.target + ni.name]].startsWith("retained_tag_marker_")) largeParentEdges++;
    }
    assert.equal(largeParentEdges, 0, "the returned and cached tags must not retain the multi-megabyte source backing string");
    console.log(JSON.stringify({ tags: tags.length, largeParentEdges }));
  } finally { globalThis[marker]?.db.close(); delete globalThis[marker]; }
}

try {
  const presenterWiring = /const workPresenterService = createWorkPresenterService\(\{([\s\S]*?)\n\}\);/.exec(serverSource);
  assert.ok(presenterWiring && /\bworkInfoDetailFacetRow\s*[,}]/.test(presenterWiring[1]), "the actual server composition injects the point reader");
  const wrapper = /function workInfoDetailFacetRow\(workId\) \{[\s\S]*?\n\}/.exec(serverSource)?.[0];
  assert.ok(wrapper);
  const connected = fixture(production), calls = [];
  const actualWrapper = new Function("workInfoService", `${wrapper}\nreturn workInfoDetailFacetRow;`)({
    detailFacetRow(id) { calls.push(id); return connected.info.detailFacetRow(id); }, facetRow() { assert.fail("detail wrapper invoked the global reader"); }
  });
  assert.equal(connected.run(() => actualWrapper("1")).work_id, "1"); assert.deepEqual(calls, ["1"]); assert.equal(connected.stats.pointReads, 1);
  const heap = JSON.parse(execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "--eval", `(${detachedTagHeap.toString()})()`,
    new URL("../src/modules/fanhao/server/works/work-info-service.js", import.meta.url).href, helperSource], { encoding: "utf8", timeout: 30000 }).trim());
  for (const value of [tags, "invalid JSON", "null", "[]", '[{"label":"__proto__","value":"safe"},{"key":"类别","value":"恋爱"}]']) {
    const db = database(); db.prepare("UPDATE works SET fields_json=?,javdb_tags_json=?").run(value, '["JavDB-only","高清"]');
    const [old, next] = compare(db, "healthy/full metadata and tags", { person: true });
    equal(old.read("2"), next.read("2"), "second same-stamp work");
    const before = { ...next.stats }; assert.equal(next.read("2"), next.read("2")); assert.deepEqual(next.stats, before, "detail DTO LRU remains effective");
  }
  for (const id of [null, false, 0, "0", 1, 1n, "1", "+1", "01", "1.0", " 1 ", "-1", "9223372036854775807", "-9223372036854775808", "100000000000000000000", { toString: () => "1" }]) {
    compareFacet(database(), id, "exact JS Map key lookup");
  }
  const integerKeys = database();
  for (const [index, id] of ["9223372036854775807", "-9223372036854775808"].entries()) {
    integerKeys.exec(`INSERT INTO works SELECT ${id},code,code_search,title,release_date,duration_minutes,rating,rating_count,director,fields_json,raw_text,status,error,updated_at,has_magnet,is_streamable,has_subtitles,javdb_tags_json FROM works WHERE id=1; INSERT INTO local_works(id,work_id) VALUES(${100 + index},${id})`);
    assert.equal(compareFacet(integerKeys, id, "full int64 CAST key is bound without Number rounding").point(id).value.work_id, id);
  }
  for (const missing of [[], ["fields_json"], ["javdb_tags_json"], ["fields_json", "javdb_tags_json"]]) {
    const db = database();
    for (const name of missing) db.exec(`ALTER TABLE works DROP COLUMN ${name}`);
    compareFacet(db, "1", "optional older metadata columns");
  }
  for (const change of [
    db => replaceWorks(db, "INTEGER PRIMARY KEY DESC"),
    db => replaceWorks(db, "INTEGER PRIMARY KEY", "WITHOUT ROWID"),
    db => replaceWorks(db, "TEXT PRIMARY KEY COLLATE NOCASE"),
    db => db.exec("ALTER TABLE works RENAME TO backing; CREATE VIEW works AS SELECT * FROM backing"),
    db => db.exec("CREATE TEMP TABLE WORKS AS SELECT * FROM main.works"),
    db => db.exec("CREATE TEMP TABLE LOCAL_WORKS AS SELECT * FROM main.local_works"),
    db => db.exec("ALTER TABLE local_works RENAME TO backing_local; CREATE VIRTUAL TABLE local_works USING fts5(work_id); INSERT INTO local_works SELECT work_id FROM backing_local")
  ]) {
    const db = database(); change(db);
    const f = compareFacet(db, "1", "legacy/view/TEMP/non-rowid schema retains original bulk plan");
    assert.equal(f.stats.pointReads, 0);
  }
  const collision = database(); replaceWorks(collision, "INTEGER PRIMARY KEY DESC");
  collision.exec("INSERT INTO works SELECT x'31',code,code_search,title,release_date,duration_minutes,rating,rating_count,director,fields_json,raw_text,status,error,updated_at,has_magnet,is_streamable,has_subtitles,javdb_tags_json FROM works WHERE id=1; UPDATE works SET code='Blob collision' WHERE typeof(id)='blob'; INSERT INTO local_works(id,work_id) VALUES(3,x'31')");
  assert.equal(compareFacet(collision, "1", "non-rowid CAST collisions keep old last-wins").info.facetRow("1").code, "Blob collision");
  const facadeDb = database(); let providerCalls = 0;
  const facade = { prepare: sql => facadeDb.prepare(sql) };
  const fFacade = fixture(production, { db: facadeDb, provider: () => { providerCalls++; return providerCalls === 1 ? facade : database(); } });
  assert.equal(fFacade.point().value.work_id, "1"); assert.equal(providerCalls, 1, "qualification fallback uses the already captured provider"); assert.equal(fFacade.stats.pointReads, 0);

  const hot = fixture(production); hot.run(() => hot.info.facetRowsById()); hot.reset();
  const hotRow = hot.info.facetRow("1"); assert.equal(hot.point().value, hotRow); assert.equal(hot.stats.facetReads, 0); assert.equal(hot.stats.metadataReads, 0);
  const absent = fixture(production); assert.equal(absent.point("99").value, null); absent.reset();
  assert.equal(absent.point("99").value, null); assert.equal(absent.stats.facetReads, 0, "a confirmed missing target is negatively cached");
  absent.db.exec("UPDATE works SET status='error' WHERE id=1"); absent.stamp = "status"; assert.equal(absent.point().value, null);
  absent.db.exec("UPDATE works SET status='ok' WHERE id=1; DELETE FROM local_works WHERE work_id=1"); absent.stamp = "no-local"; assert.equal(absent.point().value, null);
  absent.db.exec("INSERT INTO local_works(id,work_id) VALUES(10,1)"); absent.stamp = "local-again"; assert.equal(absent.point().value.work_id, "1");

  for (const phase of ["prepare", "all"]) {
    const f = fixture(production); const oldGlobal = f.run(() => f.info.facetRowsById()).get("1"); f.stamp = "new";
    let failures = 0;
    f.fault = (where, sql) => { if (where === phase && sql.includes("AND w.id = ?")) { failures++; throw new Error(`controlled point ${phase}`); } };
    const result = f.run(() => f.info.withReadStatus(() => {
      for (let index = 0; index < 10; index++) assert.equal(f.info.detailFacetRow("1"), oldGlobal);
    }));
    assert.equal(result.cacheable, false); assert.equal(failures, 1, "a failed point is shared only inside the current read scope");
    f.fault = null;
    assert.equal(f.point().cacheable, true, "a new read scope retries the same-stamp failure");
  }
  const failedDto = fixture(production);
  failedDto.db.prepare("UPDATE works SET fields_json=?").run(tags);
  let blocked = true;
  failedDto.fault = (_phase, sql) => { if (blocked && sql.includes("AND w.id = ?")) throw new Error("controlled target failure"); };
  const fallbackDto = failedDto.read(); blocked = false;
  const recoveredDto = failedDto.read();
  assert.notEqual(recoveredDto, fallbackDto, "a failed target read cannot enter the outer detail DTO cache");
  assert.ok(recoveredDto.work.traits.tags.includes("眼镜"));
  const targetNative = fixture(production);
  targetNative.db.exec("UPDATE works SET rating_count=9223372036854775807 WHERE id=1");
  assert.deepEqual(targetNative.point(), { value: null, cacheable: false });
  assert.equal(targetNative.db.isTransaction, false);
  targetNative.db.exec("UPDATE works SET rating_count=5 WHERE id=1");
  assert.equal(targetNative.point().cacheable, true, "a native target decode error does not install a false negative cache entry");

  // Explicit new policy: ordinary native detail reads isolate unrelated bad
  // rows; ordinary list facets retain the historical whole-map failure policy.
  for (const kind of ["native", "parser"]) {
    const db = database(); db.prepare("UPDATE works SET fields_json=?").run(tags);
    if (kind === "native") db.exec("UPDATE works SET rating_count=9223372036854775807 WHERE id=2");
    else db.prepare("UPDATE works SET fields_json=? WHERE id=2").run("controlled suffix parser input");
    const old = fixture(previous, { db }), next = fixture(production, { db });
    if (kind === "parser") for (const f of [old, next]) f.parseFault = value => { if (value === "controlled suffix parser input") throw new TypeError("controlled parser failure"); };
    const point = next.point(); assert.equal(point.cacheable, true); assert.ok(point.value.trait_tags.includes("眼鏡"));
    assert.equal(old.run(() => old.info.withReadStatus(() => old.info.facetRow("1"))).cacheable, false);
    assert.equal(next.run(() => next.info.withReadStatus(() => next.info.facetRow("1"))).cacheable, false);
    policyCases++;
  }

  const bounded = fixture(production, { db: database(80) });
  for (let id = 1; id <= 80; id++) bounded.point(String(id));
  assert.equal(bounded.info.fixturePointCache().entries, 64);
  assert.ok(bounded.info.fixturePointCache().bytes <= 2 * 1024 * 1024);
  assert.ok(bounded.info.fixturePointCache().rows.every(row => !Object.hasOwn(row, "fields_json") && !Object.hasOwn(row, "javdb_tags_json")));
  const oversized = fixture(production);
  oversized.db.prepare("UPDATE works SET code=? WHERE id=1").run("x".repeat(2 * 1024 * 1024));
  assert.equal(oversized.point().value.code.length, 2 * 1024 * 1024);
  assert.equal(oversized.info.fixturePointCache().entries, 0, "oversized compact scalar payloads cannot enter the point LRU");
  const inTransaction = fixture(production); inTransaction.point();
  inTransaction.db.exec("BEGIN; UPDATE works SET code='uncommitted' WHERE id=1");
  assert.equal(inTransaction.point().value.code, "uncommitted"); assert.equal(inTransaction.point().cacheable, false); assert.equal(inTransaction.db.isTransaction, true);
  inTransaction.db.exec("ROLLBACK"); assert.notEqual(inTransaction.point().value.code, "uncommitted");

  for (const sql of ["PRAGMA table_list", "PRAGMA main.table_xinfo(works)", "PRAGMA main.index_list(works)"]) {
    const f = fixture(production); let once = true;
    f.fault = (phase, text) => { if (once && phase === "prepare" && text === sql) { once = false; throw new Error("controlled qualification failure"); } };
    assert.equal(f.point().value.work_id, "1"); assert.equal(f.stats.pointReads, 0, "a failed capability proof retains the original bulk plan");
    assert.equal(f.db.isTransaction, false);
  }
  const stampFailure = fixture(production); let stampCalls = 0;
  stampFailure.onStamp = () => { if (++stampCalls === 2) throw new Error("controlled admission stamp failure"); };
  const admitted = stampFailure.point(); assert.equal(admitted.cacheable, false); assert.equal(admitted.value.work_id, "1"); assert.equal(stampFailure.info.fixturePointCache().entries, 0);
  const initialStamp = fixture(production); initialStamp.onStamp = () => { throw new Error("controlled initial stamp failure"); };
  assert.throws(() => initialStamp.point(), /controlled initial stamp failure/);

  for (const persistent of [false, true]) {
    const f = fixture(production); let failures = 0;
    f.fault = (phase, sql) => {
      if (phase === "exec" && (sql.startsWith("RELEASE SAVEPOINT") || persistent && sql.startsWith("ROLLBACK TO SAVEPOINT"))) {
        failures++; throw new Error("controlled snapshot cleanup failure");
      }
    };
    if (persistent) {
      assert.throws(() => f.point(), error => error instanceof AggregateError && /transaction state is uncertain/.test(error.message));
      assert.equal(f.info.fixturePointCache().entries, 0);
      // Only this private fixture's failed owned transaction is cleaned here.
      f.fault = null; nativeExec.call(f.db, "ROLLBACK");
    } else {
      const result = f.point(); assert.equal(result.cacheable, false); assert.equal(result.value, null);
    }
    assert.ok(failures > 0); assert.equal(f.db.isTransaction, false);
  }

  const walPath = path.join(temp.tempDir, "wal.sqlite"), sourceDb = database();
  sourceDb.prepare("VACUUM main INTO ?").run(walPath);
  const reader = new DatabaseSync(walPath), writer = new DatabaseSync(walPath); databases.push(reader, writer);
  reader.exec("PRAGMA journal_mode=WAL"); writer.exec("PRAGMA journal_mode=WAL");
  const wal = fixture(production, { db: reader }); let committed = false;
  wal.afterRead = ({ sql }) => {
    if (sql !== "PRAGMA table_list") return;
    wal.afterRead = null;
    writer.exec("BEGIN IMMEDIATE; ALTER TABLE works RENAME TO backing; UPDATE backing SET code='committed after proof' WHERE id=1; CREATE VIEW works AS SELECT * FROM backing; COMMIT");
    wal.stamp = "after-writer"; committed = true;
  };
  const oldSnapshot = wal.point();
  assert.equal(committed, true); assert.equal(oldSnapshot.value.code, "AA-001", "schema proof and the selected facet use one real WAL read snapshot");
  assert.equal(oldSnapshot.cacheable, false, "a controlled stamp change after release rejects admission");
  assert.equal(reader.isTransaction, false); assert.equal(wal.info.fixturePointCache().entries, 0);
  assert.equal(wal.point().value.code, "committed after proof", "the next request sees the external schema publication and uses its original bulk plan");

  const scaleDb = database(10000);
  const fields = JSON.stringify([{ label: "类别", value: ["單體作品", "眼鏡", "高清"] }, { label: "简介", value: "Synthetic description ".repeat(128) }]);
  scaleDb.prepare("UPDATE works SET fields_json=?,javdb_tags_json=?").run(fields, '["JavDB-only"]');
  const [oldScale, nextScale] = compare(scaleDb, "10k cold detail is complete");
  console.log(JSON.stringify({ commonContractsPassed: true, comparisons, policyCases, warnings, heap, actualServerPointWiring: true, negativeControl: negative,
    cold: { before: oldScale.stats, current: nextScale.stats } }));
  assert.equal(oldScale.stats.facetRows, 10000);
  assert.equal(nextScale.stats.facetRows, 1, "one cold detail must not transfer the whole facet catalog");
  assert.ok(nextScale.stats.facetBytes < oldScale.stats.facetBytes / 1000, "cold detail transfers only the required wide metadata row");
  assert.equal(nextScale.stats.pointReads, 1);
  assert.equal(nextScale.stats.metadataReads, 3);
  assert.equal(scaleDb.isTransaction, false);
} finally {
  DatabaseSync.prototype.prepare = nativePrepare; DatabaseSync.prototype.exec = nativeExec; statementPrototype.all = nativeAll; console.warn = warn;
  for (const db of databases) if (db.isOpen) db.close();
  temp.cleanup();
}
