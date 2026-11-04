import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

// Complete historical/current factories and real private SQLite. Counters only
// observe actual code-parser entry and native rows; timing is diagnostic.
const BEFORE = "63c5fab243233e142cfd62c4eaf13812feb92405";
const paths = {
  info: "src/modules/fanhao/server/works/work-info-service.js",
  metadata: "lib/info-metadata.js",
  codes: "lib/code-parser.js",
  nfo: "lib/nfo-metadata.js"
};
const hashes = {
  info: "a0249777518c76d12f0fd1e0ac074a4c9eb5eaba296a6523eca0f4ad2bbaa0b3",
  metadata: "f9a7e5490bd2a8526df6e8c443f1882512f4e5e1f9ba62605c3f1dbb460e22f7",
  codes: "22a4589dd0868c41a92b36dc8acf4d7d97aabefbe8bce44cbb62f5fa796e4dcc",
  nfo: "77097fbd5d0967ab93dc50c1a794fb05c9e5f9a48d68edf7c87025c85c754ec5"
};
const heapChild = process.argv[2] === "--heap-child";
assert.ok(heapChild || process.argv.slice(2).every(arg => arg === "--legacy-facet-tags"));
const negative = process.argv.includes("--legacy-facet-tags");
const old = {}, sources = {}, urls = {};
for (const [key, relative] of Object.entries(paths)) {
  urls[key] = new URL(`../${relative}`, import.meta.url);
  old[key] = execFileSync("git", ["show", `${BEFORE}:${relative}`], { encoding: "utf8" }).replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(old[key]).digest("hex"), hashes[key]);
  sources[key] = fs.readFileSync(urls[key], "utf8").replaceAll("\r\n", "\n");
}
assert.equal(sources.codes, old.codes, "the historical code parser dependency is unchanged");
assert.equal(sources.nfo, old.nfo, "the historical NFO dependency is unchanged");
const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
function imports(source, url, overrides = {}) {
  return source.replace(/from (["'])(\.[^"']+)\1/g, (_all, quote, relative) => {
    const absolute = new URL(relative, url).href;
    return `from ${quote}${overrides[absolute] || absolute}${quote}`;
  });
}
const codeSlot = "export function extractWorkCodes(value) {";
assert.equal(sources.codes.split(codeSlot).length, 2);
const codeUrl = dataUrl(sources.codes.replace(codeSlot, `${codeSlot}
  const fixture = globalThis.__workFacetTagCost;
  if (fixture) { fixture.codeScans++; if (typeof value === "string") fixture.codeChars += value.length; }`));
const beforeMetadataUrl = dataUrl(imports(old.metadata, urls.metadata, { [urls.codes.href]: codeUrl }));
const currentMetadataUrl = dataUrl(imports(sources.metadata, urls.metadata, { [urls.codes.href]: codeUrl }));
const beforeMetadata = await import(beforeMetadataUrl), currentMetadata = await import(currentMetadataUrl);
const beforeFactory = (await import(dataUrl(imports(old.info, urls.info, { [urls.metadata.href]: beforeMetadataUrl })))).createWorkInfoService;
let candidateSource = sources.info;
if (negative) {
  const call = "parseInfoMetadataTags(JSON.stringify(fields))";
  assert.equal(candidateSource.split(call).length, 2);
  candidateSource = candidateSource.replace("import { parseInfoMetadataTags }", "import { parseInfoMetadata, parseInfoMetadataTags }")
    .replace(call, "parseInfoMetadata(JSON.stringify(fields)).tags");
}
const currentFactory = (await import(dataUrl(imports(candidateSource, urls.info, { [urls.metadata.href]: currentMetadataUrl })))).createWorkInfoService;
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const helperSource = server.slice(server.indexOf("function parseJsonArray("), server.indexOf("function publicRemoteUrl("));
const helpers = new Function(`${helperSource}\nreturn {parseJsonArray, parseJsonTextArray, uniqueTextArray};`)();

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE works(id INTEGER PRIMARY KEY,code TEXT,release_date TEXT,duration_minutes INTEGER,rating REAL,rating_count INTEGER,fields_json TEXT,javdb_tags_json TEXT,status TEXT); CREATE TABLE local_works(work_id INTEGER PRIMARY KEY)");
  return db;
}
function insert(db, id, fields, javdb = '["JavDB-only"]') {
  db.prepare("INSERT INTO works VALUES(?,?,?,?,?,?,?,?,?)").run(id, `SYN-${id}`, "2026-01-01", 120, 4.2, 15, fields, javdb, "ok");
  db.prepare("INSERT INTO local_works VALUES(?)").run(id);
}
function fixture(factory, db) {
  const f = { stamp: "initial", fail: false };
  f.info = factory({ getCoreDb: () => db, getStamp: () => f.stamp, ...helpers,
    parseJsonArray(value) {
      if (f.fail) throw new TypeError("controlled field reader failure");
      return helpers.parseJsonArray(value);
    } });
  f.read = () => f.info.withReadStatus(() => [...f.info.facetRowsById()]);
  f.point = id => f.info.withReadStatus(() => (f.info.detailFacetRow || f.info.facetRow)(id));
  return f;
}
let comparisons = 0, errors = 0, warnings = 0;
function same(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${label}: complete wire/field order`);
  comparisons++;
}
function compareDatabase(db, label) {
  const before = fixture(beforeFactory, db), current = fixture(currentFactory, db);
  same(current.read(), before.read(), label);
  same(current.point("1"), before.point("1"), `${label}: detail uses the common compact tags`);
  return { before, current };
}

async function retainedTagsHeap(factoryName, reader) {
  const { getHeapSnapshot } = await import("node:v8");
  const db = database();
  const marker = "__workFacetTagsRetainedFixture";
  try {
    function build() {
      const value = Array.from({ length: 50000 }, (_, i) => `retained_tag_marker_${String(i).padStart(8, "0")}_abcdefghijklmnopqrstuvwxyz`).join(",");
      insert(db, 1, JSON.stringify([{ label: "类别", value }]));
      const info = fixture(factoryName === "before" ? beforeFactory : currentFactory, db).info;
      const row = reader === "point" ? info.detailFacetRow("1") : info.facetRow("1");
      assert.equal(row.trait_tags.length, 128);
      assert.equal(row.trait_tags.join("").length, 7040);
      return { info, row };
    }
    globalThis[marker] = build(); global.gc(); global.gc();
    const chunks = []; for await (const chunk of getHeapSnapshot()) chunks.push(chunk);
    const heap = JSON.parse(Buffer.concat(chunks));
    const fields = heap.snapshot.meta.node_fields, edgeFields = heap.snapshot.meta.edge_fields;
    const ni = Object.fromEntries(fields.map((name, index) => [name, index]));
    const ei = Object.fromEntries(edgeFields.map((name, index) => [name, index]));
    const { nodes, edges, strings } = heap, stride = fields.length, edgeStride = edgeFields.length;
    const types = heap.snapshot.meta.node_types[ni.type], edgeTypes = heap.snapshot.meta.edge_types[ei.type];
    const offsets = new Map(); let at = 0;
    for (let node = 0; node < nodes.length; node += stride) { offsets.set(node, at); at += nodes[node + ni.edge_count] * edgeStride; }
    function outgoing(node) {
      const result = [];
      for (let count = 0, edge = offsets.get(node); count < nodes[node + ni.edge_count]; count++, edge += edgeStride) {
        const type = edgeTypes[edges[edge + ei.type]];
        const key = type === "element" || type === "hidden" ? edges[edge + ei.name_or_index] : strings[edges[edge + ei.name_or_index]];
        result.push({ type, key, target: edges[edge + ei.to_node] });
      }
      return result;
    }
    let root;
    for (let node = 0; node < nodes.length && root === undefined; node += stride) root = outgoing(node).find(edge => edge.type === "property" && edge.key === marker)?.target;
    assert.notEqual(root, undefined);
    const row = outgoing(root).find(edge => edge.key === "row").target;
    const array = outgoing(row).find(edge => edge.key === "trait_tags").target;
    const tags = outgoing(array).filter(edge => edge.type === "element" && edge.key < 128);
    assert.equal(tags.length, 128);
    let largeParentEdges = 0;
    for (const tag of tags) if (types[nodes[tag.target + ni.type]] === "sliced string") {
      for (const edge of outgoing(tag.target)) if (edge.key === "parent" && nodes[edge.target + ni.self_size] > 2 * 1024 * 1024
        && strings[nodes[edge.target + ni.name]].startsWith("retained_tag_marker_")) largeParentEdges++;
    }
    assert.equal(largeParentEdges, factoryName === "before" ? 128 : 0);
    return { factory: factoryName, reader, tags: tags.length, largeParentEdges };
  } finally { delete globalThis[marker]; db.close(); }
}
if (heapChild) {
  assert.ok(global.gc);
  console.log(JSON.stringify(await retainedTagsHeap(process.argv[3], process.argv[4])));
} else {
  const warn = console.warn;
  console.warn = (...args) => { assert.equal(args[0], "[core-work-info-facets]"); warnings++; };
  try {
    const rawInputs = ["", "null", "false", "[1]", '[["x"]]', "类别: a / b；c\n番号: SYN-123", '\ufeff类别：a,b\r\n标题：Synthetic',
      '{"tags":["a","a","b"]}', '{"tags":1e999}', '{"tags":["a",1e999]}',
      '{"tags":"a,<b>visible</b>"}', '{"tags":"a","description":"<br>line"}',
      '{"tags":"a,<broken","other":">tail"}', '<movie><title>Synthetic</title><genre>NFO</genre><tag>Tag</tag></movie>',
      '<movie><genre></genre></movie>', '<?xml version="1.0"?><root></root>', '<movie/>',
      '{"tags":"original","description":"<movie><genre>NFO</genre></movie>"}',
      '{"_":{"tags":["nested","A"]},"类别":"B"}', '{"tags":"a\\u0000b,\\ud800","__proto__":{"tags":"safe"}}'];
    for (const raw of rawInputs) {
      same(currentMetadata.parseInfoMetadata(raw), beforeMetadata.parseInfoMetadata(raw), "the complete metadata parser remains unchanged");
      same(currentMetadata.parseInfoMetadataTags(raw), beforeMetadata.parseInfoMetadata(raw).tags, "text tags retain historical parsing");
    }
    const fields = [[], [{ label: "类别", value: "a,b/高清" }, { name: "genres", value: ["B", "眼鏡"] }, { key: "类别", value: "c" }],
      [{ label: "简介", value: "<movie><genre>NFO</genre></movie>" }, { label: "类别", value: "original" }],
      [{ label: "类别", value: "a,<broken" }, { label: "其他", value: ">tail" }],
      [{ label: "__proto__", value: "safe" }, { label: "类别", value: "a\0b,\ud800" }],
      [{ label: "genres", value: { nested: "unrecognized" } }], [{ label: "类别", value: ["x", Infinity] }]];
    for (const raw of [...fields.map(JSON.stringify), "bad JSON", "null", "[1,2]", '[{"label":"类别","value":1e999}]']) {
      const db = database(); try { insert(db, 1, raw); compareDatabase(db, "full native facet row"); } finally { db.close(); }
    }
    const bad = { toString: null };
    for (const input of [
      { actors: [bad], tags: ["normal"] }, { preview_images: [bad], tags: ["normal"] },
      { preview_video_url: [bad], tags: ["normal"] }, { _: { actors: bad }, tags: ["normal"] },
      { trailer: [bad], preview_video_url: "https://fixture.invalid/ok.mp4", tags: ["normal"] }
    ]) {
      const raw = JSON.stringify(input);
      for (const parse of [beforeMetadata.parseInfoMetadata, currentMetadata.parseInfoMetadataTags]) {
        assert.throws(() => parse(raw), error => error instanceof TypeError && /primitive value/.test(error.message)); errors++;
      }
      const db = database(); try {
        const pairs = Object.entries(input).map(([label, value]) => ({ label, value })); insert(db, 1, JSON.stringify(pairs));
        const { current, before } = compareDatabase(db, "non-tag coercion failure is not converted into successful tags");
        assert.equal(current.read().cacheable, false); assert.equal(before.read().cacheable, false);
        db.prepare("UPDATE works SET fields_json=?").run('[{"label":"类别","value":"recovered"}]');
        same(current.read(), before.read(), "same-stamp failures recover");
        assert.deepEqual(current.point("1").value.trait_tags, ["recovered", "JavDB-only"]);
      } finally { db.close(); }
    }
    for (const input of [
      { preview_video_url: "https://fixture.invalid/ok.mp4", trailer: [bad], tags: ["normal"] },
      { preview_video_url: "invalid URL", trailer: "https://fixture.invalid/ok.mp4", sample_video: [bad], tags: ["normal"] }
    ]) {
      const db = database(); try { insert(db, 1, JSON.stringify(Object.entries(input).map(([label, value]) => ({ label, value })))); compareDatabase(db, "first valid preview video preserves its shortcut"); } finally { db.close(); }
    }
    const oversizedActors = Array(150000).fill("A");
    for (const parse of [beforeMetadata.parseInfoMetadata, currentMetadata.parseInfoMetadataTags]) {
      assert.throws(() => parse(JSON.stringify({ actors: oversizedActors, tags: ["normal"] })), RangeError); errors++;
    }
    const large = database(); try {
      insert(large, 1, JSON.stringify([{ label: "actors", value: oversizedActors }, { label: "类别", value: "normal" }]));
      const { before, current } = compareDatabase(large, "raw non-tag spread keeps the historical call-argument error");
      assert.equal(current.read().cacheable, false); assert.equal(before.read().cacheable, false);
    } finally { large.close(); }
    for (const missing of ["fields_json", "javdb_tags_json"]) {
      const db = database(); try { insert(db, 1, "[]"); db.exec(`ALTER TABLE works DROP COLUMN ${missing}`); compareDatabase(db, "optional metadata column downgrade"); } finally { db.close(); }
    }
    const failing = database(); try {
      insert(failing, 1, '[{"label":"类别","value":"cached"}]');
      const before = fixture(beforeFactory, failing), current = fixture(currentFactory, failing); same(current.read(), before.read(), "initial complete cache");
      for (const f of [before, current]) { f.stamp = "new"; f.fail = true; }
      same(current.read(), before.read(), "parser failure retains the previous complete index");
      assert.equal(current.read().cacheable, false);
      for (const f of [before, current]) f.fail = false;
      same(current.read(), before.read(), "failure is not a negative cache entry");
      for (const f of [before, current]) f.stamp = "unsafe";
      failing.exec("UPDATE works SET rating_count=9223372036854775807");
      same(current.read(), before.read(), "native integer decode errors retain complete fallback/read status");
      assert.equal(current.read().cacheable, false); errors++;
    } finally { failing.close(); }

    const heap = [];
    for (const [factory, reader] of [["before", "global"], ["current", "global"], ["current", "point"]]) {
      heap.push(JSON.parse(execFileSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--heap-child", factory, reader,
        ...(negative ? ["--legacy-facet-tags"] : [])], { encoding: "utf8", timeout: 30000 }).trim()));
    }
    const nativePrepare = DatabaseSync.prototype.prepare;
    const scratch = new DatabaseSync(":memory:");
    const prototype = Object.getPrototypeOf(scratch.prepare("SELECT 1")), nativeAll = prototype.all; scratch.close();
    const statements = new WeakMap();
    DatabaseSync.prototype.prepare = function (sql, ...args) { const statement = nativePrepare.call(this, sql, ...args); statements.set(statement, sql); return statement; };
    prototype.all = function (...args) {
      const rows = nativeAll.apply(this, args), sql = statements.get(this), metric = globalThis.__workFacetTagCost;
      if (metric && sql?.includes("CAST(w.id AS TEXT) AS work_id")) {
        metric.sqlReads++; metric.sqlRows += rows.length;
        for (const row of rows) if (typeof row.fields_json === "string") metric.fieldsBytes += Buffer.byteLength(row.fields_json);
      }
      return rows;
    };
    const budgets = [];
    try {
      for (const shape of ["collector-code-present", "sparse-description"]) {
        const db = database(); let bytes = 0;
        try {
          db.exec("BEGIN");
          for (let id = 1; id <= 10000; id++) {
            const tags = Array.from({ length: 16 }, (_, index) => `retained_tag_${String(id).padStart(5, "0")}_${index}_abcdefghijklmnop`).join(",");
            // Same 13 public_fields labels as tools/backfill_javdb_metadata.py.
            const fields = shape === "collector-code-present" ? [
              ["番号", `SYN-${String(id).padStart(6, "0")}`], ["标题", `合成作品 ${id} ${"普通标题文字".repeat(12)}`], ["日期", "2026-01-01"], ["时长", "120 分钟"],
              ["导演", "Synthetic Director"], ["片商", "Synthetic Studio"], ["发行商", "Synthetic Label"], ["系列", "Synthetic Series"], ["评分", "4.2 分，123 人评价"],
              ["类别", tags], ["演员", "Synthetic Actor A, Synthetic Actor B"],
              ["预览图", Array.from({ length: 12 }, (_, index) => `https://synthetic.invalid/preview/${id}/${index}/sample.jpg?token=abcdefghijklmnopqrstuvwxyz0123456789abcdefghijkl`).join(", ")],
              ["预览视频", `https://synthetic.invalid/sample/${id}/preview.mp4`]
            ] : [["类别", tags], ["简介", `desc_marker_${id} ${"Synthetic description text. ".repeat(80)}`], ["片商", "Synthetic Studio"]];
            const raw = JSON.stringify(fields.map(([label, value]) => ({ label, value }))); bytes += Buffer.byteLength(raw); insert(db, id, raw);
          }
          db.exec("COMMIT");
          const measure = factory => {
            const f = fixture(factory, db), metric = { codeScans: 0, codeChars: 0, sqlReads: 0, sqlRows: 0, fieldsBytes: 0 };
            globalThis.__workFacetTagCost = metric;
            try { const start = performance.now(), result = f.read(); return { result, metric, instrumentedDiagnosticMs: performance.now() - start }; }
            finally { delete globalThis.__workFacetTagCost; }
          };
          const baseline = measure(beforeFactory), candidate = measure(currentFactory);
          same(candidate.result, baseline.result, `${shape}: all 10k compact rows and wire`);
          assert.equal(candidate.metric.sqlReads, 1); assert.equal(candidate.metric.sqlRows, 10000); assert.equal(candidate.metric.fieldsBytes, bytes);
          assert.equal(baseline.metric.fieldsBytes, bytes, "this change does not reduce SQLite's metadata input");
          assert.ok(baseline.metric.codeScans >= 10000, "the historical complete parser really executes the expensive code parser");
          budgets.push({ shape, rows: 10000, averageFieldsBytes: bytes / 10000, before: { ...baseline.metric, instrumentedDiagnosticMs: baseline.instrumentedDiagnosticMs }, current: { ...candidate.metric, instrumentedDiagnosticMs: candidate.instrumentedDiagnosticMs } });
        } finally { db.close(); }
      }
    } finally { DatabaseSync.prototype.prepare = nativePrepare; prototype.all = nativeAll; delete globalThis.__workFacetTagCost; }
    console.log(JSON.stringify({ comparisons, errors, warnings, heap, budgets, negativeControl: negative, contractsPassed: true }));
    for (const budget of budgets) assert.equal(budget.current.codeScans, 0, `${budget.shape}: tag facets must not run unrelated code extraction`);
  } finally { console.warn = warn; }
}
