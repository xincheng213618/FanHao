import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { setImmediate as immediate } from "node:timers/promises";
import { createWorkSearchIndexService } from "../src/modules/fanhao/server/works/work-search-index-service.js";

const args = process.argv.slice(2);
assert.ok(args.every(value => ["--legacy-postings", "--falsy-singleton", "--falsy-normalized", "--heap-child", "--baseline", "--diverse", "--diagnostic"].includes(value)));
const currentSource = readFileSync(new URL("../src/modules/fanhao/server/works/work-search-index-service.js", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const previousSource = readFileSync(new URL("./fixtures/work-search-postings-legacy.txt", import.meta.url), "utf8").replaceAll("\r\n", "\n");
assert.equal(createHash("sha256").update(previousSource).digest("hex"), "8bf43baff69723bde118cb12978218ba02310d615b14f545bb5091508f7bbc1a",
  "complete previous engine retains metadata compaction and operation-scoped SQL recovery");

function functionSource(source, name, indent = "") {
  const start = source.indexOf(`${indent}function ${name}(`);
  assert.ok(start >= 0, `source function ${name}`);
  const body = source.indexOf(") {", start) + 2;
  let depth = 0, end = body;
  for (; end < source.length; end++) {
    if (source[end] === "{") depth++;
    else if (source[end] === "}" && --depth === 0) { end++; break; }
  }
  return source.slice(start, end);
}
// Extract only pure helpers. Importing server.js would start real services.
const serverSource = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const helperNames = ["normalizeSearchValue", "parseJsonArray", "uniqueTextArray", "parseJsonTextArray"];
const helpers = new Function(helperNames.map(name => functionSource(serverSource, name)).join("\n") + "\nreturn {" + helperNames.join(",") + "};")();
function factory(source) {
  const slot = "  return { createMatcher, invalidate, prewarm, withReadStatus, readCacheable };";
  assert.equal(source.split(slot).length, 2, "single private observation slot");
  return new Function(source.replace("export function createWorkSearchIndexService", "function createWorkSearchIndexService")
    .replace(slot, slot.replace(" };", ", cacheState: () => ({ info: workInfoCache, text: workTextCache, grams: gramIndexCache, scope: readScope }) };"))
    + "\nreturn createWorkSearchIndexService;")();
}
let subjectSource = currentSource;
if (args.includes("--legacy-postings")) {
  const swaps = ["ensureGramIndex", "rarestPosting", "indexedCandidates"].map(name =>
    [functionSource(currentSource, name, "  "), functionSource(previousSource, name, "  ")]);
  swaps.push(["indexedCandidates(loweredQuery, normalizedQuery, gramIndex)", "indexedCandidates(loweredQuery, normalizedQuery, gramIndex.postings)"]);
  for (const [current, previous] of swaps) {
    assert.equal(subjectSource.split(current).length, 2);
    subjectSource = subjectSource.replace(current, previous);
  }
  assert.equal(subjectSource, previousSource, "only postings build, selection, and decoding differ from the complete pre-change engine");
  let restored = subjectSource;
  for (const [current, previous] of swaps) restored = restored.replace(previous, current);
  assert.equal(restored, currentSource, "precise negative control restores the current engine byte-for-byte");
}
for (const [flag, before, after] of [
  ["--falsy-singleton", "if (posting === undefined) return [];", "if (!posting) return [];"],
  ["--falsy-normalized", "if (normalizedPosting !== null && normalizedPosting !== rawPosting)", "if (normalizedPosting && normalizedPosting !== rawPosting)"]
]) if (args.includes(flag)) {
  assert.equal(subjectSource.split(before).length, 2);
  subjectSource = subjectSource.replace(before, after);
  assert.equal(subjectSource.replace(after, before), currentSource, `${flag} changes only the zero-ordinal condition`);
}
const oldFactory = factory(previousSource), currentFactory = factory(subjectSource);
const owners = [], warnings = [], oldWarn = console.warn;
console.warn = (...values) => warnings.push(values);
let booleanOracles = 0, entryOracles = 0, postingOracles = 0, failureOracles = 0;

function database(count = 9, label = "initial") {
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
  const insert = db.prepare("INSERT INTO works VALUES(?,?,?,?,?,?,?,?)"), local = db.prepare("INSERT INTO local_works VALUES(?)");
  db.exec("BEGIN");
  for (let id = 1; id <= count; id++) {
    insert.run(id, `AA-${id}`, `Core title ${id}`, "Director phrase",
      id === 2 ? '[{"label":[],"value":[]}]' : id === 3 ? "malformed JSON" : JSON.stringify([{ label: "Field label", value: `Field value ${id} ${label} ΩΣ İ 中文 𐐀` }]),
      `Raw phrase ${id} ${label} ΩΣ ΑΣ AΣ BΣ`, '["Tag phrase","标签",null,"",100]', id === count ? "pending" : "ok");
    local.run(id);
  }
  db.exec(`INSERT INTO work_people SELECT id,1,'actor' FROM works;
    INSERT INTO work_people SELECT id,2,'actor' FROM works;
    INSERT INTO work_makers SELECT id,1,'maker' FROM works;
    INSERT INTO work_makers SELECT id,2,'label' FROM works;
    INSERT INTO work_series SELECT id,1 FROM works; COMMIT;`);
  return db;
}
function work(id, extra = {}) {
  return { id: String(id), title: `Local title ${id}`, directoryName: `AA-${id}`, personId: "person", personName: "Person name",
    relativePath: `Relative/path/${id}`, videos: [{ name: `Video name ${id}`, title: "Video title", relativePath: "Video/path" }],
    images: [{ name: "Image name", title: "Image title" }], infos: [{ name: "Info name", title: "Info title" }], ...extra };
}
function open(create, count = 9, works = null) {
  const state = { db: database(count), source: "s1", info: "i1", counts: { text: 0, actors: 0, makers: 0, series: 0 }, fault: null, providerFault: false };
  const library = { scannedAt: "scan1", peopleById: new Map([["person", { name: "Library person" }]]),
    worksById: works || new Map(Array.from({ length: Math.max(0, count - 2) }, (_, index) => { const value = work(index + 1); return [value.id, value]; })) };
  const wrappers = new WeakMap();
  const getCoreDb = () => {
    if (state.providerFault) throw new Error("controlled database provider failure");
    if (wrappers.has(state.db)) return wrappers.get(state.db);
    const db = state.db;
    const wrapper = { prepare(sql) {
      const reader = sql.includes("FROM work_people wp") ? "actors" : sql.includes("FROM work_makers wm") ? "makers"
        : sql.includes("FROM work_series ws") ? "series" : "text";
      state.counts[reader]++;
      const fail = phase => {
        if (state.fault?.reader === reader && state.fault?.phase === phase) throw Object.assign(new Error(`controlled ${reader} ${phase}`), { code: "SQLITE_BUSY" });
      };
      fail("prepare");
      const statement = db.prepare(sql);
      return { all(...params) { fail("all"); return statement.all(...params); } };
    } };
    wrappers.set(db, wrapper); return wrapper;
  };
  const service = create({ ...helpers, getCoreDb, getLibrary: () => library, getSourceStamp: () => state.source, getWorkInfoStamp: () => state.info });
  const owner = { state, library, service, count, close() { if (state.db.isOpen) state.db.close(); } };
  owners.push(owner); return owner;
}
function pair(count = 9, createWorks = () => null) { return { old: open(oldFactory, count, createWorks()), current: open(currentFactory, count, createWorks()) }; }
function each(value, callback) { callback(value.old); callback(value.current); }
function probes(owner) { return [...owner.library.worksById.values(), work(owner.count - 1), work(owner.count), work("external", { title: "External phrase" }),
  work(1, { id: 1 }), work(0, { id: "", title: "Anonymous phrase" })]; }
const queries = ["", "n", "AA-1", "aa1", "local title", "core title", "person name", "library person", "director phrase", "actor phrase", "演员名字",
  "maker phrase", "label phrase", "series phrase", "tag phrase", "标签", "field label", "field value", "raw phrase", "ωσ", "ως", "i̇", "𐐨", "中文",
  "relative/path", "video name", "video title", "video/path", "image name", "image title", "info name", "info title", "external phrase", "anonymous phrase", "\n\n", "missing phrase"];
function decoded(index) {
  if (!index) return [];
  return [...index.postings].map(([gram, posting]) => [gram, index.workIds
    ? (typeof posting === "number" ? [index.workIds[posting]] : [...posting].map(ordinal => index.workIds[ordinal])) : [...posting]]);
}
function compareIndexes(current, previous, label) {
  assert.deepEqual(decoded(current), decoded(previous), `${label}: every ordered bigram and complete ID posting`);
  assert.equal(JSON.stringify(decoded(current)), JSON.stringify(decoded(previous)), `${label}: complete serialized inverted index`);
  assert.deepEqual([...current?.indexedWorkIds || []], [...previous?.indexedWorkIds || []], `${label}: original map keys`);
  postingOracles++;
}
function compare(value, selected = queries, label = "matcher") {
  for (const query of selected) {
    const actual = probes(value.current).map(value.current.service.createMatcher(query)), expected = probes(value.old).map(value.old.service.createMatcher(query));
    assert.deepEqual(actual, expected, `${label}: ${JSON.stringify(query)} entire boolean array`);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
    booleanOracles++;
  }
  const actual = value.current.service.cacheState(), expected = value.old.service.cacheState();
  assert.deepEqual([...actual.text?.rows || []], [...expected.text?.rows || []], `${label}: entire text and normalized entries`);
  assert.equal(JSON.stringify([...actual.text?.rows || []]), JSON.stringify([...expected.text?.rows || []]));
  entryOracles++;
  compareIndexes(actual.grams, expected.grams, label);
}
function storage(index) {
  let references = 0, singletonNumbers = 0, typedArrays = 0, ordinaryArrays = 0, bufferBytes = 0;
  for (const posting of index?.postings.values() || []) {
    if (typeof posting === "number") { singletonNumbers++; references++; }
    else { references += posting.length; if (posting instanceof Uint32Array) { typedArrays++; bufferBytes += posting.byteLength; } else ordinaryArrays++; }
  }
  return { works: index?.indexedWorkIds.size || 0, grams: index?.postings.size || 0, references, singletonNumbers, typedArrays, ordinaryArrays, bufferBytes };
}
function storageGate(index) {
  assert.ok(index.workIds, "storage gate: one ordinal-to-original-ID table");
  for (const posting of index.postings.values()) {
    assert.ok(typeof posting === "number" || posting instanceof Uint32Array, "storage gate: no retained ordinary posting arrays");
    const ordinals = typeof posting === "number" ? [posting] : posting;
    if (typeof posting !== "number") assert.ok(posting.length >= 2, "singleton grams allocate no typed array");
    for (const ordinal of ordinals) assert.ok(Number.isInteger(ordinal) && ordinal >= 0 && ordinal < index.workIds.length);
  }
}
async function heapChild() {
  assert.equal(typeof global.gc, "function");
  const count = 16000, works = new Map();
  let seed = 0x71234;
  const diverseTitle = () => Array.from({ length: 24 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return String.fromCharCode(0x4e00 + ((seed >>> 16) % 1024));
  }).join("");
  for (let id = 0; id < count; id++) {
    const value = work(`long-original-work-id-${String(id).padStart(7, "0")}`, { title: `Common searchable title document ${id} 中文内容`, directoryName: `CAT-${id}`,
      relativePath: `Library/Collection/Directory-${id}/Common searchable media path`, personName: "Common person display name" });
    if (args.includes("--diverse")) value.title += " " + diverseTitle();
    works.set(value.id, value);
  }
  const owner = open(args.includes("--baseline") ? oldFactory : currentFactory, 0, works);
  const collect = async () => { await immediate(); global.gc(); await immediate(); global.gc(); return process.memoryUsage(); };
  const before = await collect(), started = performance.now();
  owner.service.prewarm();
  const coldMs = performance.now() - started, after = await collect();
  const warmed = performance.now();
  for (let i = 0; i < 100; i++) owner.service.createMatcher("document 152")(works.values().next().value);
  const warmMs = performance.now() - warmed;
  const coldStorage = storage(owner.service.cacheState().grams);
  owner.state.source = "source-only-rebuild";
  works.values().next().value.title = "Revised source title";
  const rebuilding = performance.now();
  owner.service.prewarm();
  const rebuildMs = performance.now() - rebuilding, rebuilt = await collect();
  assert.deepEqual(owner.state.counts, { text: 1, actors: 1, makers: 1, series: 1 });
  const memoryDelta = value => ({ heapBytes: value.heapUsed - before.heapUsed, arrayBufferBytes: value.arrayBuffers - before.arrayBuffers,
    totalBytes: value.heapUsed + value.arrayBuffers - before.heapUsed - before.arrayBuffers });
  console.log(JSON.stringify({ workSearchPostingsProfile: args.includes("--baseline") ? "complete previous engine" : "current engine", count, diverse: args.includes("--diverse"),
    storage: coldStorage, rebuiltStorage: storage(owner.service.cacheState().grams), sql: owner.state.counts,
    retainedMemory: memoryDelta(after), rebuiltRetainedMemory: memoryDelta(rebuilt),
    timing: { coldMs, warm100MatchersMs: warmMs, rebuildMs }, peakRssKiB: process.resourceUsage().maxRSS }));
}
try {
  if (args.includes("--heap-child")) await heapChild();
  else {
    const healthy = pair();
    each(healthy, owner => { owner.service.prewarm(); assert.deepEqual(owner.state.counts, { text: 1, actors: 1, makers: 1, series: 1 }); });
    const cold = storage(healthy.current.service.cacheState().grams), previousCold = storage(healthy.old.service.cacheState().grams);
    compare(healthy);
    for (const extra of [work("extra-one"), work("extra-two")]) each(healthy, owner => owner.service.prewarm([extra]));
    compare(healthy, queries, "extra works and lazy probes");
    each(healthy, owner => assert.deepEqual(owner.state.counts, { text: 1, actors: 1, makers: 1, series: 1 }, "warm/extra/lazy zero additional SQL"));
    const held = [healthy.old.service.createMatcher("raw phrase"), healthy.current.service.createMatcher("raw phrase")];
    each(healthy, owner => { owner.state.source = "s2"; owner.library.worksById.get("1").title = "Revised local title ΩΣ"; });
    compare(healthy, [...queries, "revised local title"], "source-only rebuild");
    assert.deepEqual(probes(healthy.current).map(held[1]), probes(healthy.old).map(held[0]), "held original matcher after rebuild");
    each(healthy, owner => assert.deepEqual(owner.state.counts, { text: 1, actors: 1, makers: 1, series: 1 }));
    each(healthy, owner => { owner.state.source = "s3"; owner.state.info = "i2"; owner.state.db.exec("UPDATE works SET raw_text='Changed raw phrase' WHERE id=1"); });
    compare(healthy, [...queries, "changed raw phrase"], "metadata refresh");
    each(healthy, owner => assert.deepEqual(owner.state.counts, { text: 2, actors: 2, makers: 2, series: 2 }));
    each(healthy, owner => { owner.state.source = "s4"; owner.library.scannedAt = "scan2"; });
    compare(healthy, queries, "scan refresh");
    each(healthy, owner => assert.deepEqual(owner.state.counts, { text: 3, actors: 3, makers: 3, series: 3 }));
    each(healthy, owner => owner.service.invalidate());
    compare(healthy, queries, "explicit invalidation");
    each(healthy, owner => assert.deepEqual(owner.state.counts, { text: 4, actors: 4, makers: 4, series: 4 }));

    const empty = pair(0);
    each(empty, owner => { owner.service.prewarm(); assert.deepEqual(owner.state.counts, { text: 0, actors: 0, makers: 0, series: 0 }); });
    compare(empty, queries, "empty library and unindexed lazy probes");
    const edgeWorks = () => new Map([
      [0, work("zero", { id: 0, title: "qz", directoryName: "", personName: "", personId: null, relativePath: "", videos: [], images: [], infos: [] })],
      ["0", work("zero-string", { id: "0" })], ["not-the-work-id", work("1")],
      ["duplicate-a", work("duplicate", { title: "Duplicate first title" })], ["duplicate-b", work("duplicate", { title: "Duplicate second title" })],
      ["", work("empty-id", { id: "" })], [null, work("null-id", { id: null })], [undefined, work("undefined-id", { id: undefined })]
    ]);
    const edges = pair(0, edgeWorks);
    compare(edges, [...queries, "qz", "q-z", "duplicate first", "duplicate second", "zero-string"], "zero ordinals, normalized-only match, mixed IDs, distinct map keys, duplicate IDs");
    const zeroMatcher = edges.current.service.createMatcher("qz"), normalizedZeroMatcher = edges.current.service.createMatcher("q-z");
    assert.equal(zeroMatcher(edges.current.library.worksById.get(0)), true, "first-work singleton ordinal zero stays searchable");
    assert.equal(normalizedZeroMatcher(edges.current.library.worksById.get(0)), true, "normalized posting ordinal zero is not missing");

    const temporaryIndexes = [];
    for (const reader of ["text", "actors", "makers", "series"]) for (const phase of ["prepare", "all"]) {
      const failed = pair(); each(failed, owner => { owner.state.fault = { reader, phase }; });
      const read = owner => owner.service.withReadStatus(() => {
        const values = queries.map(query => probes(owner).map(owner.service.createMatcher(query)));
        const scope = owner.service.cacheState().scope;
        const index = [...scope.grams.values()][0];
        if (owner === failed.current) temporaryIndexes.push(index);
        assert.equal(scope.grams.size, 1, "failed operation reuses one temporary index");
        assert.equal(owner.service.cacheState().grams, null, "failed index never enters the persistent cache");
        return { values, postings: decoded(index), entries: [...index.entriesById], counts: { ...owner.state.counts }, cacheable: owner.service.readCacheable() };
      });
      assert.deepEqual(read(failed.current), read(failed.old), `${reader} ${phase}: entire partial fallback, postings, entries, SQL counts and status`);
      failureOracles++;
      each(failed, owner => { owner.state.fault = null; });
      compare(failed, queries, `${reader} ${phase} same-stamp recovery`);
    }
    const provider = pair(); each(provider, owner => { owner.state.providerFault = true; });
    const providerRead = owner => owner.service.withReadStatus(() => queries.map(query => probes(owner).map(owner.service.createMatcher(query))));
    assert.deepEqual(providerRead(provider.current), providerRead(provider.old), "provider failure scoped fallback"); failureOracles++;
    each(provider, owner => { owner.state.providerFault = false; }); compare(provider, queries, "provider same-stamp recovery");
    const replaced = pair();
    const replace = owner => owner.service.withReadStatus(() => {
      owner.state.db.close();
      const partial = probes(owner).map(owner.service.createMatcher("actor phrase"));
      owner.state.db = database(owner.count, "replacement");
      const repaired = probes(owner).map(owner.service.createMatcher("actor phrase"));
      return { partial, repaired, counts: owner.state.counts, cacheable: owner.service.readCacheable() };
    });
    assert.deepEqual(replace(replaced.current), replace(replaced.old), "closed and replacement owner inside the same failed scope"); failureOracles++;
    compare(replaced, [...queries, "replacement"], "replacement owner recovery");

    // Observe the imported production factory independently of the private instrumentation.
    const native = open(createWorkSearchIndexService), reference = open(oldFactory);
    for (const query of queries) {
      assert.deepEqual(probes(native).map(native.service.createMatcher(query)), probes(reference).map(reference.service.createMatcher(query)), "actual ESM factory oracle");
      booleanOracles++;
    }
    assert.equal(cold.grams, previousCold.grams); assert.equal(cold.references, previousCold.references);
    assert.ok(cold.references > cold.grams, "fixture covers shared grams");
    if (args.includes("--legacy-postings")) console.log(JSON.stringify({ negativeControl: "only ordinal postings disabled", booleanOracles, entryOracles, postingOracles, failureOracles, cold }));
    for (const value of [healthy, empty, edges, provider, replaced]) storageGate(value.current.service.cacheState().grams);
    for (const index of temporaryIndexes) storageGate(index);
    assert.ok(cold.singletonNumbers > 0 && cold.typedArrays > 0, "fixture covers both adaptive representations");
    assert.equal(cold.ordinaryArrays, 0);
    assert.equal(cold.bufferBytes, (cold.references - cold.singletonNumbers) * Uint32Array.BYTES_PER_ELEMENT);
    console.log(JSON.stringify({ workSearchPostings: "ok", booleanOracles, entryOracles, postingOracles, failureOracles, cold, previousCold,
      privateDatabases: owners.length, warnings: warnings.length }));
    if (args.includes("--diagnostic")) for (const childArgs of [["--heap-child", "--baseline"], ["--heap-child"], ["--heap-child", "--baseline", "--diverse"], ["--heap-child", "--diverse"]]) {
      execFileSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), ...childArgs], { stdio: "inherit" });
    }
  }
} finally {
  console.warn = oldWarn;
  for (const owner of owners) owner.close();
}
