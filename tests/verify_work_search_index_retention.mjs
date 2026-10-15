import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { setImmediate as immediate } from "node:timers/promises";
import { createWorkSearchIndexService } from "../src/modules/fanhao/server/works/work-search-index-service.js";

const args = process.argv.slice(2);
assert.ok(args.every(value => ["--legacy-metadata-retention", "--heap-child", "--baseline", "--diagnostic"].includes(value)));
const negative = args.includes("--legacy-metadata-retention");
const currentSource = readFileSync(new URL("../src/modules/fanhao/server/works/work-search-index-service.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const previousSource = readFileSync(new URL("./fixtures/work-search-index-retention-legacy.txt", import.meta.url), "utf8").replaceAll("\r\n", "\n");
assert.equal(createHash("sha256").update(previousSource).digest("hex"), "dbe8c2839aab5d2a531f775beb99c124c5152ce8a941a2685af000ceeca685ac",
  "complete previous engine includes the SQL failure and operation-scope fixes");

// Read only the actual pure server helpers; importing server.js would start
// the real application. All database reads below target private :memory: DBs.
const serverSource = readFileSync(new URL("../server.js", import.meta.url), "utf8");
function serverFunction(name) {
  const start = serverSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const body = serverSource.indexOf(") {", start) + 2;
  let depth = 0, end = body;
  for (; end < serverSource.length; end++) {
    if (serverSource[end] === "{") depth++;
    else if (serverSource[end] === "}" && --depth === 0) { end++; break; }
  }
  return serverSource.slice(start, end);
}
const helperNames = ["normalizeSearchValue", "parseJsonArray", "uniqueTextArray", "parseJsonTextArray"];
const helpers = new Function(helperNames.map(serverFunction).join("\n") + "\nreturn {" + helperNames.join(",") + "};")();
function factory(source) {
  const slot = "  return { createMatcher, invalidate, prewarm, withReadStatus, readCacheable };";
  assert.equal(source.split(slot).length, 2, "single test-only cache observation slot");
  return new Function(source.replace("export function createWorkSearchIndexService", "function createWorkSearchIndexService")
    .replace(slot, slot.replace(" };", ", cacheState: () => ({ info: workInfoCache, text: workTextCache, grams: gramIndexCache, scope: readScope }) };"))
    + "\nreturn createWorkSearchIndexService;")();
}
const compactionGuard = "if (cacheable && info) {";
let subjectSource = currentSource;
if (negative) {
  assert.equal(currentSource.split(compactionGuard).length, 2, "negative control disables only new successful-row metadata compaction");
  subjectSource = currentSource.replace(compactionGuard, "if (false && cacheable && info) {");
  assert.equal(subjectSource.replace("if (false && cacheable && info) {", compactionGuard), currentSource,
    "the negative control restores the current source byte-for-byte");
}
const oldFactory = factory(previousSource), currentFactory = factory(subjectSource);
const owners = [], warnings = [], oldWarn = console.warn;
console.warn = (...values) => warnings.push(values);
let booleanOracles = 0, byteOracles = 0;

function database(count = 8, width = 1, owner = "initial") {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE works(id INTEGER PRIMARY KEY,code TEXT,title TEXT,director TEXT,fields_json TEXT,raw_text TEXT,javdb_tags_json TEXT,status TEXT);
    CREATE TABLE local_works(work_id INTEGER PRIMARY KEY);
    CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE work_people(work_id INTEGER,person_id INTEGER,role TEXT);
    CREATE TABLE makers(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE work_makers(work_id INTEGER,maker_id INTEGER,role TEXT);
    CREATE TABLE series(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE work_series(work_id INTEGER,series_id INTEGER);
    INSERT INTO people VALUES(1,'Actor phrase'),(2,'演员名字');
    INSERT INTO makers VALUES(1,'Maker phrase'),(2,'Label phrase');
    INSERT INTO series VALUES(1,'Series phrase');`);
  const insert = db.prepare("INSERT INTO works VALUES(?,?,?,?,?,?,?,?)");
  const local = db.prepare("INSERT INTO local_works VALUES(?)");
  const actors = db.prepare("INSERT INTO work_people VALUES(?,?,'actor')");
  const makers = db.prepare("INSERT INTO work_makers VALUES(?,?,?)");
  const series = db.prepare("INSERT INTO work_series VALUES(?,1)");
  db.exec("BEGIN");
  for (let id = 1; id <= count; id++) {
    const fields = id === 2 ? '[{"label":[],"value":[]},{"label":false,"value":0}]'
      : id === 3 ? "malformed JSON"
        : id === 4 ? '{"label":"not an array"}'
          : JSON.stringify([{ label: `Field label ${id}`, value: `Field value ${id} ${owner} ` + "Wide Fields ΩΣ İ 中文 𐐀 ".repeat(width) },
            { label: null, value: ["Nested", "Array"] }, { label: 7, value: true }, { label: {}, value: { key: "object" } }]);
    const raw = id === 2 ? "" : `Raw phrase ${id} ${owner} ` + "RAW ΩΣ İ 𐐀 中文 ΑΣ AΣ BΣ ".repeat(width * 3);
    insert.run(id, `AA-${id}`, `Core title ${id}`, "Director phrase", fields, raw,
      '["Tag phrase"," tag phrase ","标签",null,"",100]', id === count ? "pending" : "ok");
    local.run(id); actors.run(id, 1); actors.run(id, 2); makers.run(id, 1, "maker"); makers.run(id, 2, "label"); series.run(id);
  }
  db.exec("COMMIT");
  return db;
}
function work(id, extra = {}) {
  return { id: String(id), title: `Local title ${id}`, directoryName: `AA-${id}`, personId: "person", personName: "Person name",
    relativePath: `Relative/path/${id}`, videos: [{ name: `Video name ${id}`, title: "Video title", relativePath: "Video/path" }],
    images: [{ name: "Image name", title: "Image title" }], infos: [{ name: "Info name", title: "Info title" }], ...extra };
}
function open(create, { count = 8, width = 1, indexedCount = count - 2 } = {}) {
  const state = { db: database(count, width), source: "s1", info: "i1", counts: { text: 0, actors: 0, makers: 0, series: 0 }, fault: null };
  const library = { scannedAt: "scan1", peopleById: new Map([["person", { name: "Library person" }]]),
    worksById: new Map(Array.from({ length: Math.max(0, indexedCount) }, (_, index) => { const value = work(index + 1); return [value.id, value]; })) };
  const wrappers = new WeakMap();
  const getCoreDb = () => {
    if (wrappers.has(state.db)) return wrappers.get(state.db);
    const db = state.db;
    const wrapper = { prepare(sql) {
      const reader = sql.includes("FROM work_people wp") ? "actors" : sql.includes("FROM work_makers wm") ? "makers"
        : sql.includes("FROM work_series ws") ? "series" : "text";
      state.counts[reader]++;
      const fail = phase => {
        if (state.fault?.reader !== reader || state.fault?.phase !== phase) return;
        throw Object.assign(new Error(`controlled ${reader} ${phase}`), { code: "SQLITE_BUSY" });
      };
      fail("prepare");
      const statement = db.prepare(sql);
      return { all(...params) { fail("all"); return statement.all(...params); } };
    } };
    wrappers.set(db, wrapper); return wrapper;
  };
  const dependencies = { ...helpers, getCoreDb, getLibrary: () => library, getSourceStamp: () => state.source, getWorkInfoStamp: () => state.info };
  const service = create(dependencies);
  const owner = { state, library, dependencies, service, count, close() { if (state.db.isOpen) state.db.close(); } };
  owners.push(owner); return owner;
}
function pair(options) { return { old: open(oldFactory, options), current: open(currentFactory, options) }; }
function each(value, callback) { callback(value.old); callback(value.current); }
function probes(owner) {
  return [...owner.library.worksById.values(), work(owner.count - 1), work(owner.count), work("external", { title: "External phrase" }),
    work(1, { id: 1 }), work(0, { id: "", personId: "person", title: "Anonymous phrase" })];
}
const queries = ["", "n", "AA-1", "aa1", "local title", "core title", "person name", "library person", "director phrase", "actor phrase",
  "演员名字", "maker phrase", "label phrase", "series phrase", "tag phrase", "标签", "field label", "field value", "raw phrase", "wide fields",
  "ωσ", "ως", "i̇", "𐐨", "中文", "7\ntrue", "nested,array", "[object object]", "relative/path", "video name", "video title", "video/path", "image name",
  "image title", "info name", "info title", "external phrase", "anonymous phrase", "\n\n", "missing phrase"];
function compare(value, selected = queries, label = "complete matcher") {
  for (const query of selected) {
    const actual = value.current.service.createMatcher(query), expected = value.old.service.createMatcher(query);
    const actualValues = probes(value.current).map(actual), expectedValues = probes(value.old).map(expected);
    assert.deepEqual(actualValues, expectedValues, `${label}: ${JSON.stringify(query)} boolean array`);
    assert.equal(JSON.stringify(actualValues), JSON.stringify(expectedValues), `${label}: serialized entire array`);
    booleanOracles++;
  }
  const current = value.current.service.cacheState().text, previous = value.old.service.cacheState().text;
  assert.deepEqual([...current?.rows || []], [...previous?.rows || []], `${label}: complete text/normalized entries`);
  assert.equal(JSON.stringify([...current?.rows || []]), JSON.stringify([...previous?.rows || []]), `${label}: serialized complete entries`);
  byteOracles++;
}
function retention(owner) {
  const state = owner.service.cacheState(), rows = state.info?.rows || new Map(), texts = new Set([...state.text?.rows.values() || []].map(entry => entry.text));
  let originalRows = 0, originalCharacters = 0, compactRows = 0, sharedBackingRows = 0;
  for (const info of rows.values()) {
    if (Object.hasOwn(info, "fields_json") || Object.hasOwn(info, "raw_text")) originalRows++;
    originalCharacters += (info.fields_json?.length || 0) + (info.raw_text?.length || 0);
    if (info.searchMetadata) {
      compactRows++;
      if (texts.has(info.searchMetadata.text)) sharedBackingRows++;
    }
  }
  return { infoRows: rows.size, textRows: state.text?.rows.size || 0, originalRows, originalCharacters, compactRows, sharedBackingRows,
    sql: { ...owner.state.counts } };
}
async function heapChild() {
  assert.equal(typeof global.gc, "function", "diagnostic child needs --expose-gc");
  const owner = open(args.includes("--baseline") ? oldFactory : currentFactory, { count: 1800, indexedCount: 1800, width: 120 });
  await immediate(); global.gc(); await immediate(); global.gc();
  const before = process.memoryUsage().heapUsed, started = performance.now();
  owner.service.prewarm();
  const coldMs = performance.now() - started;
  await immediate(); global.gc(); await immediate(); global.gc();
  const after = process.memoryUsage().heapUsed;
  const warmed = performance.now();
  for (let index = 0; index < 100; index++) owner.service.createMatcher("field value")(work(index + 1));
  const warmMs = performance.now() - warmed;
  const coldRetention = retention(owner);
  owner.state.source = "source-only-rebuild";
  owner.library.worksById.get("1").title = "Revised source title";
  const rebuilding = performance.now();
  owner.service.prewarm();
  const rebuildMs = performance.now() - rebuilding;
  await immediate(); global.gc(); await immediate(); global.gc();
  const rebuiltHeap = process.memoryUsage().heapUsed;
  console.log(JSON.stringify({ scenario: args.includes("--baseline") ? "complete previous engine" : negative ? "only new compaction disabled" : "current engine",
    deterministic: coldRetention, afterSourceOnlyRebuild: retention(owner),
    heap: { baselineBytes: before, retainedBytes: after - before, afterSourceOnlyRebuildBytes: rebuiltHeap - before },
    timing: { coldMs, warm100MatchersMs: warmMs, sourceOnlyRebuildMs: rebuildMs } }));
}
try {
  if (args.includes("--heap-child")) {
    await heapChild();
  } else {
    const healthy = pair();
    each(healthy, owner => owner.service.prewarm());
    each(healthy, owner => assert.deepEqual(owner.state.counts, { text: 1, actors: 1, makers: 1, series: 1 }, "healthy cold keeps four exact SQL reads"));
    const cold = retention(healthy.current), oldCold = retention(healthy.old);
    compare(healthy);
    each(healthy, owner => owner.service.prewarm([work("extra-one", { title: "External phrase one" })]));
    each(healthy, owner => owner.service.prewarm([work("extra-two", { title: "External phrase two" })]));
    compare(healthy, queries, "extraWorks rebuild and lazy/unindexed rows");
    each(healthy, owner => assert.deepEqual(owner.state.counts, { text: 1, actors: 1, makers: 1, series: 1 }, "warm/extraWorks/lazy expansions add zero SQL"));
    const populated = retention(healthy.current);
    // Every successful info row was consumed by a text entry, including the
    // deliberately omitted library row. The pending-status row has no info.
    assert.equal(populated.infoRows, healthy.current.count - 1);
    assert.equal(oldCold.originalRows, oldCold.infoRows);
    assert.ok(oldCold.originalCharacters > 0);
    const retentionGate = () => {
      assert.equal(populated.originalRows, 0, "retention gate: no consumed row keeps a raw metadata property");
      assert.equal(populated.originalCharacters, 0, "retention gate: no duplicate fields_json/raw_text characters survive");
      assert.equal(populated.compactRows, populated.infoRows);
      assert.equal(populated.sharedBackingRows, populated.infoRows, "all metadata descriptors reuse an already cached text string");
      assert.equal(cold.originalRows, 1, "not-yet-consumed local metadata stays available without another SQL projection");
    };

    const identity = healthy.current.service.cacheState().text.rows.get("1");
    healthy.current.service.createMatcher("raw phrase")(work(1));
    assert.equal(healthy.current.service.cacheState().text.rows.get("1"), identity, "healthy text-entry identity is retained");
    // Confirm the instrumented factory and the imported actual module agree.
    const native = open(createWorkSearchIndexService);
    for (const query of queries) assert.deepEqual(probes(native).map(native.service.createMatcher(query)),
      probes(healthy.current).map(healthy.current.service.createMatcher(query)), "actual ESM module matcher oracle");

    // A source-only change rebuilds text/grams using compact metadata, with no
    // metadata SQL. Existing held matchers retain the complete old behavior.
    const held = [healthy.old.service.createMatcher("raw phrase"), healthy.current.service.createMatcher("raw phrase")];
    each(healthy, owner => {
      owner.state.source = "s2";
      owner.library.peopleById.get("person").name = "Revised library person";
      owner.library.worksById.get("1").title = "Revised local title ΩΣ";
    });
    compare(healthy, [...queries, "revised library person", "revised local title"], "source-only rebuild");
    const rebuilt = retention(healthy.current);
    assert.deepEqual(probes(healthy.current).map(held[1]), probes(healthy.old).map(held[0]), "held old matcher closure after source-only rebuild");
    each(healthy, owner => assert.deepEqual(owner.state.counts, { text: 1, actors: 1, makers: 1, series: 1 }, "source-only/held matcher still add zero metadata SQL"));

    each(healthy, owner => {
      owner.state.info = "i2"; owner.state.source = "s3";
      owner.state.db.exec("UPDATE works SET raw_text='Changed raw phrase', fields_json='[{\"label\":\"Changed field label\",\"value\":\"Changed field value\"}]' WHERE id=1");
    });
    compare(healthy, [...queries, "changed raw phrase", "changed field label", "changed field value"], "metadata stamp rebuild");
    each(healthy, owner => assert.deepEqual(owner.state.counts, { text: 2, actors: 2, makers: 2, series: 2 }, "info/source stamp change has one four-query refresh"));
    each(healthy, owner => { owner.library.scannedAt = "scan2"; owner.state.source = "s4"; });
    compare(healthy, queries, "scan stamp rebuild");
    each(healthy, owner => assert.deepEqual(owner.state.counts, { text: 3, actors: 3, makers: 3, series: 3 }, "scan/source stamp refresh retains SQL projection counts"));

    const empty = pair({ count: 0, indexedCount: 0 });
    each(empty, owner => { owner.service.prewarm(); owner.service.createMatcher(""); owner.service.createMatcher("absent phrase");
      assert.deepEqual(owner.state.counts, { text: 0, actors: 0, makers: 0, series: 0 }, "empty library builds no metadata SQL"); });
    compare(empty, queries, "empty lazy matcher");

    const edges = pair({ count: 3, indexedCount: 3 });
    each(edges, owner => {
      owner.state.db.exec("UPDATE works SET code=NULL,title=NULL,director=NULL,javdb_tags_json='[]',fields_json='[{\"label\":[],\"value\":[]}]',raw_text=NULL WHERE id=1;"
        + "DELETE FROM work_people WHERE work_id=1;DELETE FROM work_makers WHERE work_id=1;DELETE FROM work_series WHERE work_id=1;"
        + "UPDATE works SET fields_json='[]',raw_text=NULL WHERE id=2");
      owner.library.worksById.set("1", work(1, { title: [], directoryName: false, personName: null, personId: "unknown", relativePath: 0,
        videos: [], images: [], infos: [] }));
    });
    compare(edges, [...queries, "\n", "\n\n"], "empty metadata and truthy-empty field/prefix values");
    each(edges, owner => { owner.state.source = "edge-source-only"; });
    compare(edges, [...queries, "\n", "\n\n"], "empty metadata source-only rebuild");
    const emptyMetadata = edges.current.service.cacheState().info.rows.get("2")?.searchMetadata;

    let failedOracles = 0;
    for (const reader of ["text", "actors", "makers", "series"]) for (const phase of ["prepare", "all"]) {
      const failed = pair(); each(failed, owner => { owner.state.fault = { reader, phase }; });
      const result = owner => owner.service.withReadStatus(() => {
        const matcher = owner.service.createMatcher("raw phrase");
        const values = probes(owner).map(matcher);
        const partials = [...owner.service.cacheState().scope.failures.values()].flatMap(map => [...map.values()]);
        for (const partial of partials) for (const row of partial.rows.values()) {
          assert.ok(Object.hasOwn(row, "fields_json") && Object.hasOwn(row, "raw_text"), "failed partial maps preserve original metadata and fallback scope");
          assert.equal(row.searchMetadata, undefined);
        }
        return values;
      });
      assert.deepEqual(result(failed.current), result(failed.old), "entire old partial-map fallback and status DTO");
      assert.equal(failed.current.service.cacheState().info, null, "a failed metadata read never gains a compact global cache");
      failedOracles++;
      each(failed, owner => { owner.state.fault = null; });
      compare(failed, queries, `${reader} ${phase} same-stamp recovery`);
    }

    const replaced = pair();
    const replace = owner => owner.service.withReadStatus(() => {
      owner.state.db.close();
      const partial = probes(owner).map(owner.service.createMatcher("actor phrase"));
      owner.state.db = database(owner.count, 1, "replacement");
      const repaired = probes(owner).map(owner.service.createMatcher("actor phrase"));
      return { partial, repaired };
    });
    assert.deepEqual(replace(replaced.current), replace(replaced.old), "replacement private DB owner retries in the same failed synchronous scope");
    compare(replaced, [...queries, "replacement"], "replacement owner recovery");
    each(replaced, owner => owner.service.invalidate());
    compare(replaced, queries, "invalidation frees compact rows and recreates complete metadata");
    if (negative) console.log(JSON.stringify({ negativeControl: "only successful-row metadata compaction disabled", booleanOracles, byteOracles,
      failedOracles, retainedBeforeGate: populated }));
    retentionGate();
    assert.equal(rebuilt.originalCharacters, 0, "source-only rebuild keeps released metadata released");
    assert.equal(rebuilt.sharedBackingRows, rebuilt.infoRows, "source-only rebuild reanchors descriptors to current text entries");
    assert.equal(emptyMetadata?.present, false);
    assert.equal(emptyMetadata?.text, "", "metadata-free rows do not retain an entire unrelated media/text backing string");
    console.log(JSON.stringify({ workSearchIndexRetention: "ok", booleanOracles, byteOracles, failedOracles, cold, populated,
      previousCold: oldCold, privateDatabases: owners.length, warnings: warnings.length }));

    if (args.includes("--diagnostic")) {
      for (const childArgs of [["--heap-child", "--baseline"], ["--heap-child"]]) {
        execFileSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), ...childArgs], { stdio: "inherit" });
      }
    }
  }
} finally {
  console.warn = oldWarn;
  for (const owner of owners) owner.close();
}
