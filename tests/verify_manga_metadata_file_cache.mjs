import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createMangaService } from "../src/modules/photos/server/manga-service.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";

const legacyRevision = "63c5fab243233e142cfd62c4eaf13812feb92405";
const relativeSource = "src/modules/photos/server/manga-service.js";
const sourceUrl = new URL("../" + relativeSource, import.meta.url);
const source = fs.readFileSync(sourceUrl, "utf8").replaceAll("\r\n", "\n");
const oldSource = execFileSync("git", ["show", `${legacyRevision}:${relativeSource}`], {
  cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", windowsHide: true
});
assert(oldSource.includes("function metadataForCache(cacheDir, dbComic = null) {"));
assert(!oldSource.includes("MANGA_METADATA_CACHE_MAX_ENTRIES"), "the immutable oracle predates this cache");
async function moduleFrom(text) {
  const resolved = text.replace(/from "(\.\.?\/[^"\n]+)"/gu, (_, relative) => "from " + JSON.stringify(new URL(relative, sourceUrl).href));
  return await import("data:text/javascript;base64," + Buffer.from(resolved).toString("base64"));
}
const previousFactory = (await moduleFrom(oldSource)).createMangaService;
const cacheBinding = "const metadataInputs = createMangaMetadataInputCache();";
assert.equal(source.split(cacheBinding).length, 2);
const disabledFactory = (await moduleFrom(source.replace(cacheBinding, "const metadataInputs = readMangaMetadataInputs;"))).createMangaService;
assert(process.argv.slice(2).every(value => value === "--disable-metadata-cache"));
const factory = process.argv.includes("--disable-metadata-cache") ? disabledFactory : createMangaService;
// Only expose the actual private owner for independent byte/count inspection.
// Production has no diagnostic export or extra mutable cache surface.
assert.equal(source.split("  return read;\n}").length, 2);
const inspected = await moduleFrom(source.replace("  return read;\n}",
  "  return Object.assign(read, { inspectCache: () => ({ entries, retainedBytes }) });\n}")
  + "\nexport { createMangaMetadataInputCache };\n");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-manga-metadata-cache-"));
const dbPath = path.join(root, "private.sqlite"), directories = new Set(), files = new Set(), handles = new Set();
const virtualRoot = path.join(root, "virtual"), virtual = new Map();
const originals = { read: fs.readFileSync, stat: fs.statSync, exists: fs.existsSync, dir: fs.readdirSync,
  parse: JSON.parse, exec: RegExp.prototype.exec, prepare: DatabaseSync.prototype.prepare,
  get: StatementSync.prototype.get, all: StatementSync.prototype.all };
const sqlByStatement = new WeakMap(), catalogTexts = new Set(), htmlTexts = new Set();
let measured = false, counts = null, fault = null, afterRead = null, comparisons = 0;
let virtualReads = 0;
const owned = file => typeof file === "string" && file.startsWith(root + path.sep);
const observedPath = file => file === root || owned(file);
fs.readFileSync = function (file, ...args) {
  const isCatalog = owned(file) && path.basename(file) === "catalog.json";
  const isHtml = owned(file) && path.basename(file) === "catalog.html";
  if (fault?.operation === "read" && file === fault.file) throw Object.assign(new Error("controlled metadata read failure"), { code: "EACCES" });
  let result;
  if (virtual.has(file)) { virtualReads++; result = virtual.get(file).text; }
  else result = originals.read.call(this, file, ...args);
  if (isCatalog) catalogTexts.add(result);
  if (isHtml) htmlTexts.add(result);
  if (measured && (isCatalog || isHtml)) { counts.reads++; counts.bytes += Buffer.byteLength(result); }
  if (afterRead?.file === file) { const pending = afterRead; afterRead = null; pending.run(); }
  return result;
};
fs.statSync = function (file, ...args) {
  if (measured && observedPath(file)) counts.stats++;
  if (fault?.operation === "stat" && file === fault.file) throw Object.assign(new Error("controlled metadata identity failure"), { code: "EACCES" });
  if (virtual.has(file)) {
    const entry = virtual.get(file), generation = BigInt(entry.generation || 1);
    return { isFile: () => true, dev: 1n, ino: generation, birthtimeNs: generation, ctimeNs: generation,
      mtimeNs: generation, size: BigInt(Buffer.byteLength(entry.text)) };
  }
  return originals.stat.call(this, file, ...args);
};
fs.existsSync = function (file, ...args) { if (measured && observedPath(file)) counts.exists++; return originals.exists.call(this, file, ...args); };
fs.readdirSync = function (file, ...args) { if (measured && observedPath(file)) counts.scans++; return originals.dir.call(this, file, ...args); };
JSON.parse = function (value, ...args) {
  if (measured && catalogTexts.has(value)) counts.catalogParses++;
  return originals.parse.call(this, value, ...args);
};
RegExp.prototype.exec = function (value) {
  if (measured && typeof value === "string" && htmlTexts.has(value) && this.source.includes("sp-book-tags")) counts.htmlParses++;
  return originals.exec.call(this, value);
};
DatabaseSync.prototype.prepare = function (sql, ...args) {
  handles.add(this);
  if (measured && /^SELECT\b/iu.test(sql.trim())) counts.prepares++;
  const statement = originals.prepare.call(this, sql, ...args); sqlByStatement.set(statement, sql); return statement;
};
for (const method of ["get", "all"]) StatementSync.prototype[method] = function (...args) {
  if (measured && /^SELECT\b/iu.test((sqlByStatement.get(this) || "").trim())) counts.sqlReads++;
  return originals[method].call(this, ...args);
};

let writer;
try {
  writer = new DatabaseSync(dbPath); handles.add(writer);
  const collector = fs.readFileSync(new URL("../tools/manga_collector.py", import.meta.url), "utf8");
  const schema = /    schema = """([\s\S]*?)    """/u.exec(collector)?.[1];
  assert(schema?.includes("CREATE TABLE IF NOT EXISTS manga_comics"));
  writer.exec("PRAGMA journal_mode=WAL"); writer.exec(schema);
  const current = service(factory), previous = service(previousFactory);
  const first = addBook("smtt6_cache_contract", 1);
  verifyContracts(current, previous, first);
  verifyFailures(current, previous, first);
  verifyIdentity(current, previous, first);
  verifyDirectoryIdentity(current, previous, first);
  verifyBudget();

  // Both complete library owners read the actual collector schema and actual
  // catalog/HTML files. No HTTP service, crawler, image or archive is opened.
  const listing = imageLibrary(service(factory)), oldListing = imageLibrary(previous);
  // Isolate file-input reuse from newer summary/statement optimizations while
  // preserving the immutable complete-response oracle as a separate check.
  const uncachedListing = imageLibrary(service(disabledFactory));
  writer.exec("BEGIN");
  for (let index = 2; index <= 1000; index++) addBook(`smtt6_cache_${String(index).padStart(5, "0")}`, index);
  writer.exec("COMMIT");
  const cold = sample(() => page(listing, 0));
  page(uncachedListing, 0);
  const before = [], after = [];
  for (const offset of [0, 48, 96]) {
    const expected = page(oldListing, offset);
    const old = sample(() => page(uncachedListing, offset));
    const fresh = sample(() => page(listing, offset));
    assert.deepEqual(withoutRevision(fresh.value), withoutRevision(expected), "complete preceding list contract except its per-owner opaque revision");
    assert.deepEqual(withoutRevision(old.value), withoutRevision(expected), "file-cache bypass preserves the same preceding complete response");
    comparisons++; before.push(old); after.push(fresh);
  }
  assert.equal(cold.value.total, 1000);
  const median = values => values.map(value => value.ms).sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const report = { ok: true, comparisons, legacyRevision, readBudgetBaseline: "current service with only file-input caching disabled", books: 1000, cold: metrics(cold),
    nativeDiagnosticMedianMs: { previous: +median(before).toFixed(2), current: +median(after).toFixed(2) },
    previousWarm: metrics(before[0]), currentWarm: metrics(after[0]) };
  console.log(JSON.stringify(report, null, 2));
  for (let index = 0; index < before.length; index++) {
    assert.equal(before[index].reads, 2000, "negative control exercises both metadata files of every book");
    assert.equal(before[index].catalogParses, 1000); assert.equal(before[index].htmlParses, 1000);
    assert.equal(after[index].reads, 0, "warm pages retain file-identity probes without rereading every catalog");
    assert.equal(after[index].bytes, 0); assert.equal(after[index].catalogParses, 0); assert.equal(after[index].htmlParses, 0);
    assert.equal(after[index].stats, before[index].stats + 2000, "two fresh identity probes per book remain visible");
    assert.equal(after[index].sqlReads, before[index].sqlReads, "DB rows and covers remain fresh reads");
  }
} finally {
  measured = false; fault = null; afterRead = null;
  fs.readFileSync = originals.read; fs.statSync = originals.stat; fs.existsSync = originals.exists; fs.readdirSync = originals.dir;
  JSON.parse = originals.parse; RegExp.prototype.exec = originals.exec;
  DatabaseSync.prototype.prepare = originals.prepare; StatementSync.prototype.get = originals.get; StatementSync.prototype.all = originals.all;
  for (const database of handles) try { database.close(); } catch {}
  // Named owned fixture files only; refuse recursive cleanup or unknown data.
  assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
  for (const suffix of ["", "-wal", "-shm"]) files.add(dbPath + suffix);
  for (const file of files) { assert(owned(file)); if (fs.existsSync(file)) fs.unlinkSync(file); }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    assert(owned(directory)); if (fs.existsSync(directory)) fs.rmdirSync(directory);
  }
  fs.rmdirSync(root);
}

function service(create) {
  return create({ root, databasePath: dbPath, mimeTypes: {}, normalizeExt: path.extname,
    safeStat(file) { try { return fs.statSync(file); } catch { return null; } },
    spawnProcess() { assert.fail("fixture must not start a collector"); } });
}
function write(file, value) { assert(owned(file)); files.add(file); fs.writeFileSync(file, value); }
function addBook(name, index) {
  const dir = path.join(root, name); assert(owned(dir)); fs.mkdirSync(dir); directories.add(dir);
  write(path.join(dir, "catalog.json"), JSON.stringify({ title: `Synthetic ${index}`, url: `https://synthetic.invalid/book/${index}`,
    author: "Catalog author", region: "Catalog region", chapters: Array.from({ length: 200 }, (_, chapter) => ({ index: chapter + 1, title: `Synthetic chapter ${chapter}`, url: `https://synthetic.invalid/chapter/${chapter}` })) }));
  write(path.join(dir, "manifest.json"), '{"chapters":[]}');
  write(path.join(dir, "catalog.html"), html("HTML description", "HTML author", "韩漫") + "<!-- synthetic -->".repeat(900));
  writer.prepare(`INSERT INTO manga_comics(cache_key,dir_name,site,title,source_url,chapter_count,done_chapter_count,image_count,downloaded_count,
    author,description,publication_status,cover_url,cover_path,region,tags_json,updated_at)
    VALUES(?,?,'smtt6',?,?,200,200,6000,6000,'DB author','DB description','DB status','https://synthetic.invalid/cover','cover.png','DB region','["DB tag"]','2026-01-01')`)
    .run(dir, name, `Synthetic ${index}`, `https://synthetic.invalid/book/${index}`);
  writer.prepare("INSERT INTO manga_chapters(cache_key,chapter_index,title) VALUES(?,1,'Synthetic chapter')").run(dir);
  writer.prepare("INSERT INTO manga_images(cache_key,chapter_index,image_index,local_path) VALUES(?,1,1,'synthetic.png')").run(dir);
  return dir;
}
function html(description, author, tag) {
  return `<meta name="description" content="${description}"><p class="sp-book-author">作者：${author}</p><div>状态：<span>HTML status</span></div><div class="sp-book-tags"><a>${tag}</a><a>Synthetic tag</a></div>`;
}
function outcome(read) { try { return { value: read() }; } catch (error) { return { error: [error.name, error.message] }; } }
function compare(current, previous, directory) {
  const actual = outcome(() => current.publicSummary(directory)), expected = outcome(() => previous.publicSummary(directory));
  assert.deepEqual(actual, expected, "complete preceding publicSummary or original exception"); comparisons++;
  return actual;
}
function sample(read) {
  counts = { reads: 0, bytes: 0, catalogParses: 0, htmlParses: 0, stats: 0, exists: 0, scans: 0, prepares: 0, sqlReads: 0 };
  measured = true; const start = performance.now();
  try { return { value: read(), ms: performance.now() - start, ...counts }; } finally { measured = false; }
}
function metrics({ value: _value, ...rest }) { return { ...rest, ms: +rest.ms.toFixed(2) }; }
function imageLibrary(mangaService) {
  const index = { scannedAt: "fixed", photoSets: [], mediaItems: [] };
  return createImageLibraryService({ cachePreparedQueries: true, maxItemLimit: 12000,
    clampInteger: (value, fallback, min, max) => value == null ? fallback : Math.max(min, Math.min(max, Number(value))),
    getImageLibraryIndex: () => index, getImageLibraryRevision: () => 1, metadataService: { listRevision: () => 1 }, mangaService,
    photoSetService: {}, galleryMediaRootStatuses: () => [], photoSetRootStatuses: () => [], imageReaderCacheStatus: () => ({}) });
}
function page(listing, offset) { return listing.itemsPayload(new URL(`http://fixture/?mode=manga&limit=48&offset=${offset}`)); }
function withoutRevision({ listRevision: _revision, ...response }) { return response; }

function verifyContracts(current, previous, directory) {
  const catalogFile = path.join(directory, "catalog.json"), htmlFile = path.join(directory, "catalog.html");
  const original = fs.readFileSync(catalogFile, "utf8"), originalHtml = fs.readFileSync(htmlFile, "utf8");
  const warm = compare(current, previous, directory).value;
  assert.equal(warm.author, "DB author"); assert.equal(warm.region, "韩国"); assert(!warm.tags.includes("DB tag"));
  warm.tags.push("caller mutation"); assert(!compare(current, previous, directory).value.tags.includes("caller mutation"));
  writer.prepare("UPDATE manga_comics SET author='Changed DB author',description='Changed DB description' WHERE cache_key=?").run(directory);
  assert.equal(compare(current, previous, directory).value.author, "Changed DB author");
  for (const catalog of ["null", "17", "false", '"primitive"', "[]", "1e999", '{"description":1e999}',
    '{"description":{"toString":"not callable"}}', '{"description":["legacy",null,1]}']) {
    write(catalogFile, catalog); compare(current, previous, directory);
    writer.prepare("UPDATE manga_comics SET description='' WHERE cache_key=?").run(directory);
    compare(current, previous, directory);
    writer.prepare("UPDATE manga_comics SET description='Changed DB description' WHERE cache_key=?").run(directory);
  }
  write(catalogFile, "null");
  writer.prepare("UPDATE manga_comics SET author='' WHERE cache_key=?").run(directory);
  assert.equal(compare(current, previous, directory).error?.[0], "TypeError", "valid JSON null is not a read-error fallback");
  write(catalogFile, original);
  writer.prepare("UPDATE manga_comics SET author='DB author',description='DB description' WHERE cache_key=?").run(directory);
  write(htmlFile, html("new description", "new author", "File category"));
  const altered = compare(current, previous, directory).value;
  assert.equal(altered.category, "File category"); assert.equal(altered.region, "Catalog region", "DB region/tags were never the former file fallback authority");
  write(htmlFile, originalHtml);
}

function verifyFailures(current, previous, directory) {
  for (const name of ["catalog.json", "catalog.html"]) for (const operation of ["stat", "read"]) {
    const file = path.join(directory, name);
    compare(current, previous, directory);
    // A read fault must run on a new signature, rather than a valid cache hit.
    if (operation === "read") write(file, fs.readFileSync(file, "utf8") + (name.endsWith("html") ? " " : "\n"));
    fault = { file, operation }; compare(current, previous, directory); fault = null;
    assert(sample(() => current.publicSummary(directory)).reads > 0, "failed metadata reads never become a permanent cache hit");
    compare(current, previous, directory);
  }
  const file = path.join(directory, "catalog.json"), original = fs.readFileSync(file, "utf8");
  write(file, "{"); compare(current, previous, directory);
  assert(sample(() => current.publicSummary(directory)).reads > 0, "invalid JSON fallback is retried");
  write(file, original); compare(current, previous, directory);
  for (const name of ["catalog.json", "catalog.html"]) {
    const missing = path.join(directory, name), content = fs.readFileSync(missing, "utf8");
    fs.unlinkSync(missing); compare(current, previous, directory); compare(current, previous, directory);
    write(missing, content);
    assert(sample(() => current.publicSummary(directory)).reads > 0, "a restored file must be read after repeated missing-source fallbacks");
    compare(current, previous, directory);
  }
}

function verifyIdentity(current, previous, directory) {
  const file = path.join(directory, "catalog.html"), original = fs.readFileSync(file, "utf8");
  const fixedTime = new Date("2026-01-01T00:00:00.000Z");
  fs.utimesSync(file, fixedTime, fixedTime); compare(current, previous, directory);
  const stat = fs.statSync(file, { bigint: true });
  write(file, original.replace("Synthetic tag", "Different tag")); fs.utimesSync(file, fixedTime, fixedTime);
  const rewritten = fs.statSync(file, { bigint: true });
  assert.equal(rewritten.size, stat.size); assert.equal(rewritten.mtimeNs, stat.mtimeNs);
  assert.notEqual(rewritten.ctimeNs, stat.ctimeNs, "same-mtime in-place writes have a fresh change time");
  assert(compare(current, previous, directory).value.tags.includes("Different tag"));
  const replacement = path.join(directory, "replacement.html"); write(replacement, original);
  fs.utimesSync(replacement, fixedTime, fixedTime);
  assert.equal(path.dirname(path.resolve(replacement)), path.resolve(directory));
  fs.unlinkSync(file); fs.renameSync(replacement, file);
  const replaced = fs.statSync(file, { bigint: true });
  assert.equal(replaced.size, stat.size); assert.equal(replaced.mtimeNs, stat.mtimeNs); assert.notEqual(replaced.ino, stat.ino);
  assert(compare(current, previous, directory).value.tags.includes("Synthetic tag"));
  write(file, original + " ");
  const beforeRewrite = previous.publicSummary(directory);
  afterRead = { file, run: () => write(file, original.replace("Synthetic tag", "Rewritten tag")) };
  assert.deepEqual(current.publicSummary(directory), beforeRewrite, "a mid-read rewrite retains the bytes actually read"); comparisons++;
  assert.equal(afterRead, null);
  assert(sample(() => current.publicSummary(directory)).reads > 0, "a file changing while read cannot publish a cache entry");
  compare(current, previous, directory); write(file, original); compare(current, previous, directory);
  const catalogFile = path.join(directory, "catalog.json"), catalog = fs.readFileSync(catalogFile, "utf8");
  writer.prepare("UPDATE manga_comics SET author='' WHERE cache_key=?").run(directory);
  fs.utimesSync(catalogFile, fixedTime, fixedTime); compare(current, previous, directory);
  const catalogStat = fs.statSync(catalogFile, { bigint: true });
  write(catalogFile, catalog.replace("Catalog author", "Changed author")); fs.utimesSync(catalogFile, fixedTime, fixedTime);
  const changedCatalog = fs.statSync(catalogFile, { bigint: true });
  assert.equal(changedCatalog.size, catalogStat.size); assert.equal(changedCatalog.mtimeNs, catalogStat.mtimeNs);
  assert.equal(compare(current, previous, directory).value.author, "Changed author");
  write(catalogFile, catalog); writer.prepare("UPDATE manga_comics SET author='DB author' WHERE cache_key=?").run(directory);
  compare(current, previous, directory);
}

function verifyDirectoryIdentity(current, previous, directory) {
  const moved = path.join(root, "smtt6_cache_moved_contract");
  const names = ["catalog.json", "catalog.html", "manifest.json"];
  const contents = names.map(name => fs.readFileSync(path.join(directory, name), "utf8"));
  for (const target of [directory, moved]) assert.equal(path.dirname(path.resolve(target)), path.resolve(root));
  assert.equal(fs.realpathSync(path.dirname(directory)), fs.realpathSync(root));
  if (process.platform === "win32") {
    const literal = value => "'" + value.replaceAll("'", "''") + "'";
    execFileSync("powershell.exe", ["-NoProfile", "-Command", `Move-Item -LiteralPath ${literal(directory)} -Destination ${literal(moved)} -ErrorAction Stop`], { windowsHide: true });
  } else fs.renameSync(directory, moved);
  directories.add(moved); for (const name of names) files.add(path.join(moved, name));
  compare(current, previous, directory); compare(current, previous, moved);
  fs.mkdirSync(directory);
  for (let index = 0; index < names.length; index++) write(path.join(directory, names[index]),
    names[index] === "catalog.html" ? contents[index].replace("Synthetic tag", "Directory tag") : contents[index]);
  assert(compare(current, previous, directory).value.tags.includes("Directory tag"), "a replacement directory cannot reuse the former files' metadata");
  for (const name of names) fs.unlinkSync(path.join(moved, name)); fs.rmdirSync(moved);
  compare(current, previous, moved);
  write(path.join(directory, "catalog.html"), contents[1]); compare(current, previous, directory);
}

function verifyBudget() {
  const read = inspected.createMangaMetadataInputCache();
  const put = (name, catalog = {}, markup = html("small", "small", "tag")) => {
    const dir = path.join(virtualRoot, name);
    virtual.set(path.join(dir, "catalog.json"), { text: JSON.stringify(catalog) });
    virtual.set(path.join(dir, "catalog.html"), { text: markup });
    return dir;
  };
  const first = put("first"); read(first);
  for (let index = 0; index < 2050; index++) read(put("entry-" + index));
  assert.equal(read.inspectCache().entries.size, 2048);
  assert(!read.inspectCache().entries.has(first), "count budget evicts old owners");
  for (let index = 0; index < 150; index++) read(put("large-" + index, { description: "x".repeat(100000) }));
  assert(read.inspectCache().retainedBytes <= 16 * 1024 * 1024, "total estimated bytes are independently bounded");
  const textBytes = value => typeof value === "string" ? 2 * value.length
    : value && typeof value === "object" ? Object.values(value).reduce((sum, child) => sum + textBytes(child), 0) : 0;
  const lowerBound = [...read.inspectCache().entries].reduce((sum, [key, entry]) => sum + textBytes(key) + textBytes(entry.signature) + textBytes(entry.inputs), 0);
  assert(lowerBound <= 16 * 1024 * 1024, "independent retained text accounting stays within the advertised budget");
  assert(read.inspectCache().retainedBytes >= lowerBound, "self-reported weights cannot omit actual retained strings");
  const longPath = put("path-" + "p".repeat(70000)); read(longPath);
  assert(!read.inspectCache().entries.has(longPath), "key and source-signature paths count against the per-entry budget");
  const oversized = put("oversized", { description: "x".repeat(300000) }); read(oversized);
  assert(!read.inspectCache().entries.has(oversized));
  const tags = Array.from({ length: 5000 }, (_, index) => `<a>${index}</a>`).join("");
  const many = put("many-tags", {}, `<div class="sp-book-tags">${tags}</div>`); read(many);
  assert(!read.inspectCache().entries.has(many), "array-slot costs count even for very short tags");
  const duplicate = put("duplicate-tags", {}, '<div class="sp-book-tags">' + "<a>tag</a>".repeat(5000) + "</div>"); read(duplicate);
  assert.equal(read.inspectCache().entries.get(duplicate).inputs.html.tags.length, 1, "retained tags are stably deduplicated");
  const giant = put("giant-unused-input", { author: "kept", chapters: ["x".repeat(1000000)] }, html("kept", "kept", "kept") + " ".repeat(2000000));
  read(giant);
  const saved = read.inspectCache().entries.get(giant);
  assert(saved && saved.bytes < 10000);
  assert(!Object.hasOwn(saved.inputs.catalog, "chapters")); assert.equal(typeof saved.inputs.html, "object");
  const reads = virtualReads; read(giant); assert.equal(virtualReads, reads, "large source text is not reread or retained on a warm hit");
}
