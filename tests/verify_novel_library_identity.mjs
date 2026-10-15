import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { createNovelStore } from "../src/modules/novels/server/store.js";
import { routeNovelApi } from "../src/modules/novels/server/routes.js";

// Real SQLite and the actual Python scanner, exclusively synthetic temporary
// files. Deliberately does not invoke verify_novel_storage's real-library checks.
const root = path.resolve(import.meta.dirname, "..");
const storePath = path.join(root, "src/modules/novels/server/store.js");
const scannerPath = path.join(root, "tools/rescan_novel_library.py");
const storeSource = fs.readFileSync(storePath, "utf8");
const scannerSource = fs.readFileSync(scannerPath, "utf8");
const routeSource = fs.readFileSync(path.join(root, "src/modules/novels/server/routes.js"), "utf8");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-novel-identity-"));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const tests = [];
let sequence = 0;
const test = (name, run) => tests.push({ name, run });
function temporaryPath(name) {
  const value = path.resolve(temporary, name);
  assert(value.startsWith(path.resolve(temporary) + path.sep));
  return value;
}
function newStore(factory = createNovelStore) {
  const dbPath = temporaryPath(`library-${++sequence}.sqlite`);
  return { store: factory({ dbPath }), dbPath };
}
function sql(dbPath, action, readOnly = false) {
  assert(path.resolve(dbPath).startsWith(path.resolve(temporary) + path.sep));
  const db = new DatabaseSync(dbPath, { readOnly });
  try { return action(db); } finally { db.close(); }
}
function metadata(dbPath, key) {
  return sql(dbPath, db => db.prepare("SELECT value FROM novel_meta WHERE key = ?").get(key)?.value, true);
}
function snapshot(dbPath) {
  return sql(dbPath, db => {
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    return tables.map(table => ({ ...table, rows: db.prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}" ORDER BY rowid`).all() }));
  }, true);
}
const text = "第一章 开始\n\n仅用于合成测试的第一章正文。\n\n第二章 继续\n\n仅用于合成测试的第二章正文。";
const upload = { title: "合成书籍", author: "合成作者", fileName: "synthetic.txt", text };
const collected = { sourceUrl: "https://synthetic.invalid/book/one", title: "合成采集书", author: "合成作者", chapters: [{ title: "第一章", content: "合成正文甲" }, { title: "第二章", content: "合成正文乙" }] };
function sourceFixture() {
  const sourceRoot = temporaryPath(`source-${++sequence}`);
  fs.mkdirSync(sourceRoot);
  const file = path.join(sourceRoot, "synthetic.txt");
  fs.writeFileSync(file, text, "utf8");
  return { sourceRoot, file };
}
function scan(dbPath, args, { expectedFailure = false, source = null } = {}) {
  assert(args.includes("--root") || args.includes("--file"), "scanner must not use its real default roots");
  assert(args.filter((arg, index) => ["--root", "--file", "--source-root"].includes(args[index - 1])).every(value => path.resolve(value).startsWith(path.resolve(temporary) + path.sep)));
  const argv = ["--db", dbPath, ...args];
  const executable = process.env.PYTHON || "python";
  const command = source === null ? ["-B", scannerPath, ...argv] : ["-B", "-c",
    "import sys; source=sys.stdin.read(); target=sys.argv[1]; sys.path.insert(0,sys.argv[2]); sys.argv=[target]+sys.argv[3:]; exec(compile(source,target,'exec'),{'__name__':'__main__','__file__':target})",
    scannerPath, path.dirname(scannerPath), ...argv];
  const result = spawnSync(executable, command, { cwd: root, encoding: "utf8", input: source ?? undefined, windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" }, timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  if (expectedFailure) assert.notEqual(result.status, 0, "scanner unexpectedly accepted the rejected database");
  else assert.equal(result.status, 0, `synthetic scanner failed: ${result.stderr}\n${result.stdout}`);
  return result;
}

test("new empty library persists its UUID before exposing a realm; reopen and alternate URLs retain it", ({ factory }) => {
  const { store, dbPath } = newStore(factory);
  assert.equal(fs.existsSync(dbPath), false);
  const first = store.summary(), id = metadata(dbPath, "library_id");
  assert.match(id, uuid); assert.equal(first.sourceRealm, `server:${id}`); assert.equal(first.totals.books, 0);
  assert.equal(store.summary().sourceRealm, first.sourceRealm);
  store.invalidate();
  const reopened = factory({ dbPath });
  for (const address of ["http://127.0.0.1:1234/api/novels", "https://new-address.invalid/api/novels"]) {
    const list = reopened.listBooks(new URL(address));
    assert.equal(list.sourceRealm, first.sourceRealm); assert.equal(list.summary.sourceRealm, first.sourceRealm); assert.equal(list.books.length, 0);
  }
  assert.equal(metadata(dbPath, "library_id"), id);
  const independent = newStore(factory); assert.notEqual(independent.store.summary().sourceRealm, first.sourceRealm);
});

test("current-library reads remain available during an independent WAL writer transaction", ({ factory }) => {
  const { store, dbPath } = newStore(factory), detail = store.uploadBook(upload);
  const writer = new DatabaseSync(dbPath);
  try {
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("UPDATE novel_chapters SET content = 'uncommitted synthetic body' WHERE id = ?").run(detail.chapters[0].id);
    assert.equal(store.summary().totals.books, 1);
    assert.equal(store.listBooks(new URL("http://synthetic.invalid?limit=48")).books[0].id, detail.book.id);
    assert.equal(store.bookMeta(detail.book.id).catalogRevision, detail.catalogRevision);
    assert.equal(store.catalog(detail.book.id, new URL("http://synthetic.invalid?limit=20")).total, 2);
    const chapter = store.chapterDetail(detail.book.id, 1).chapter;
    assert.equal(chapter.content, "仅用于合成测试的第一章正文。");
  } finally {
    writer.exec("ROLLBACK"); writer.close(); store.invalidate();
  }
});

test("a schema upgrade immediately before the read snapshot is rejected without exposing a response", ({ factory }) => {
  const { store, dbPath } = newStore(factory); store.uploadBook(upload);
  const original = DatabaseSync.prototype.exec; let armed = true;
  DatabaseSync.prototype.exec = function(statement, ...args) {
    if (armed && statement === "BEGIN") {
      armed = false;
      sql(dbPath, db => db.prepare("UPDATE novel_meta SET value = '6' WHERE key = 'schema_version'").run());
    }
    return original.call(this, statement, ...args);
  };
  try { assert.throws(() => store.summary(), /更新版本/); assert.equal(armed, false); }
  finally { DatabaseSync.prototype.exec = original; }
});

test("every public book DTO and empty/list/catalog envelope carries the persistent realm", ({ factory }) => {
  const { store, dbPath } = newStore(factory), first = store.uploadBook(upload), id = first.book.id;
  const realm = `server:${metadata(dbPath, "library_id")}`;
  const assertBook = book => { assert(book); assert.equal(book.sourceRealm, realm); assert.equal(book.id, id); };
  assertBook(first.book); assert.equal(first.sourceRealm, realm);
  assertBook(store.bookMeta(id).book); assert.equal(store.bookMeta(id).sourceRealm, realm);
  assertBook(store.bookDetail(id).book); assert.equal(store.bookDetail(id).sourceRealm, realm);
  assertBook(store.chapterDetail(id, 1).book); assert.equal(store.chapterDetail(id, 1).sourceRealm, realm);
  assert.equal(store.catalog(id, new URL("http://synthetic.invalid?limit=20")).sourceRealm, realm);
  const list = store.listBooks(new URL("http://synthetic.invalid/api/novels")); assert.equal(list.sourceRealm, realm); list.books.forEach(assertBook);
  const authors = store.listAuthors(new URL("http://synthetic.invalid/api/novels/authors")); assert.equal(authors.sourceRealm, realm); assert.equal(authors.summary.sourceRealm, realm);
  const author = store.authorDetail("合成作者", new URL("http://synthetic.invalid/api/novels/authors/name")); assert.equal(author.sourceRealm, realm); author.books.forEach(assertBook);
  store.saveProgress(id, { chapterIndex: 1, scrollRatio: 0.4, sourceRealm: realm });
  const summary = store.summary(); assert.equal(summary.sourceRealm, realm); summary.recent.forEach(assertBook); assert.equal(summary.recent.length, 1);
  assertBook(store.updateBookMetadata(id, { title: "合成修改标题" }));
  assertBook(store.reimportBook(id, { text }).book);
  const fromCollection = store.importCollectedBook(collected); assert.equal(fromCollection.sourceRealm, realm); assert.equal(fromCollection.book.sourceRealm, realm);
});

test("existing v4 database receives one ID without changing books, progress or unknown metadata", ({ factory }) => {
  const { store, dbPath } = newStore(factory); const book = store.uploadBook(upload).book;
  store.saveProgress(book.id, { chapterIndex: 1, scrollRatio: 0.7 });
  sql(dbPath, db => { db.prepare("DELETE FROM novel_meta WHERE key = 'library_id'").run(); db.prepare("INSERT INTO novel_meta VALUES ('future_note', 'retain me')").run(); });
  const before = snapshot(dbPath), realm = factory({ dbPath }).summary().sourceRealm;
  assert.match(realm, /^server:/); const after = snapshot(dbPath);
  for (const table of after) if (table.name === "novel_meta") table.rows = table.rows.filter(row => row.key !== "library_id");
  assert.deepEqual(after, before);
  assert.equal(factory({ dbPath }).summary().sourceRealm, realm); assert.equal(metadata(dbPath, "future_note"), "retain me");
});

test("a closed database file copy retains identity while an independently initialized library differs", ({ factory }) => {
  const { store, dbPath } = newStore(factory); store.uploadBook(upload); const realm = store.summary().sourceRealm;
  const copyPath = temporaryPath(`copy-${++sequence}.sqlite`); fs.copyFileSync(dbPath, copyPath);
  const copy = factory({ dbPath: copyPath }); assert.equal(copy.summary().sourceRealm, realm);
  assert.equal(copy.listBooks(new URL("https://different-host.invalid/api/novels")).books[0].sourceRealm, realm);
  assert.notEqual(newStore(factory).store.summary().sourceRealm, realm);
});

test("wrong realm cannot write progress even when two libraries have exactly the same book ID", ({ factory }) => {
  const a = newStore(factory), b = newStore(factory);
  const old = a.store.importCollectedBook(collected), current = b.store.importCollectedBook(collected);
  assert.equal(old.book.id, current.book.id); assert.notEqual(old.sourceRealm, current.sourceRealm);
  b.store.saveProgress(current.book.id, { chapterIndex: 1, scrollRatio: 0.3, sourceRealm: current.sourceRealm });
  const before = snapshot(b.dbPath);
  assert.throws(() => b.store.saveProgress(current.book.id, { chapterIndex: 2, scrollRatio: 0.9, sourceRealm: old.sourceRealm }), error => error.statusCode === 409);
  assert.deepEqual(snapshot(b.dbPath), before);
  for (const sourceRealm of [null, "", "http://old-address.invalid", 4]) assert.throws(() => b.store.saveProgress(current.book.id, { sourceRealm }), error => error.statusCode === 409);
  assert.equal(b.store.saveProgress(current.book.id, { chapterIndex: 2, scrollRatio: 0.5 }).scrollRatio, 0.5, "legacy clients may omit the optional precondition");
  assert.equal(b.store.saveProgress(current.book.id, { chapterIndex: 2, scrollRatio: 0.8, sourceRealm: current.sourceRealm }).scrollRatio, 0.8);
});

test("wrong realm cannot delete rows or create a deletion tombstone; matching and legacy deletes still work", ({ factory }) => {
  const a = newStore(factory), b = newStore(factory);
  const old = a.store.importCollectedBook(collected), current = b.store.importCollectedBook(collected);
  const before = snapshot(b.dbPath);
  assert.throws(() => b.store.deleteBook(current.book.id, { sourceRealm: old.sourceRealm }), error => error.statusCode === 409);
  assert.deepEqual(snapshot(b.dbPath), before);
  assert.equal(b.store.deleteBook(current.book.id, { sourceRealm: current.sourceRealm }).id, current.book.id);
  assert.equal(b.store.bookMeta(current.book.id), null);
  const next = b.store.uploadBook(upload).book; assert.equal(b.store.deleteBook(next.id).id, next.id);
  assert.equal(b.store.summary().sourceRealm, current.sourceRealm);
});

async function deleteThroughRoute(store, bookId, sourceRealm, route = routeNovelApi) {
  const url = new URL(`http://synthetic.invalid/api/novels/${encodeURIComponent(bookId)}`);
  if (sourceRealm !== undefined) url.searchParams.set("sourceRealm", sourceRealm);
  const responses = [], response = {};
  let adminChecks = 0;
  const handled = await route({ method: "DELETE" }, response, url, {
    novelStore: store,
    requireLocalAdmin: () => { adminChecks++; return true; },
    sendJson: (res, status, body) => { assert.equal(res, response); responses.push({ status, body }); },
    notFound: () => responses.push({ status: 404 })
  });
  assert.equal(handled, true); assert.equal(adminChecks, 1); assert.equal(responses.length, 1);
  return responses[0];
}

test("actual DELETE route accepts a legacy request without a realm query", async ({ factory, route }) => {
  const { store } = newStore(factory), book = store.uploadBook(upload).book;
  const response = await deleteThroughRoute(store, book.id, undefined, route);
  assert.equal(response.status, 200); assert.equal(response.body.ok, true); assert.equal(response.body.deleted.id, book.id);
  assert.equal(store.bookMeta(book.id), null);
});

test("actual DELETE route rejects a mismatched realm and preserves every database row", async ({ factory, route }) => {
  const a = newStore(factory), b = newStore(factory);
  const old = a.store.importCollectedBook(collected), current = b.store.importCollectedBook(collected);
  assert.equal(old.book.id, current.book.id);
  const before = snapshot(b.dbPath);
  const response = await deleteThroughRoute(b.store, current.book.id, old.sourceRealm, route);
  assert.equal(response.status, 409); assert.equal(typeof response.body.error, "string"); assert(response.body.error.length > 0);
  assert.deepEqual(snapshot(b.dbPath), before); assert.equal(b.store.bookMeta(current.book.id).book.id, current.book.id);
});

test("actual DELETE route forwards the matching realm and deletes the intended book", async ({ factory, route }) => {
  const { store } = newStore(factory), current = store.importCollectedBook(collected);
  const response = await deleteThroughRoute(store, current.book.id, current.sourceRealm, route);
  assert.equal(response.status, 200); assert.equal(response.body.ok, true); assert.equal(response.body.deleted.id, current.book.id);
  assert.equal(store.bookMeta(current.book.id), null); assert.equal(store.summary().sourceRealm, current.sourceRealm);
});

test("legacy TXT downloads remain read-only and do not allocate a library identity", ({ factory }) => {
  const { store, dbPath } = newStore(factory), id = store.uploadBook(upload).book.id;
  sql(dbPath, db => db.prepare("DELETE FROM novel_meta WHERE key = 'library_id'").run());
  const before = snapshot(dbPath), download = factory({ dbPath }).openDownload(id);
  assert(download); assert.equal(download.book.sourceRealm, undefined); assert(download.nextChunk().includes("合成测试")); download.close();
  assert.deepEqual(snapshot(dbPath), before); assert.equal(metadata(dbPath, "library_id"), undefined);
  const missing = newStore(factory); assert.throws(() => missing.store.openDownload("not-there")); assert.equal(fs.existsSync(missing.dbPath), false);
});

for (const value of ["bad identity", "", "SERVER:11111111-1111-4111-8111-111111111111"]) test(`invalid existing ID is refused without reassignment (${JSON.stringify(value)})`, ({ factory }) => {
  const { store, dbPath } = newStore(factory); store.uploadBook(upload);
  sql(dbPath, db => db.prepare("UPDATE novel_meta SET value = ? WHERE key = 'library_id'").run(value));
  const before = snapshot(dbPath), rejected = factory({ dbPath });
  assert.throws(() => rejected.summary(), /身份/); assert.throws(() => rejected.summary(), /身份/, "failed initialization must not leave a usable cached connection");
  assert.deepEqual(snapshot(dbPath), before); assert.equal(metadata(dbPath, "library_id"), value);
});

test("future schema is refused before adding identity or performing DDL", ({ factory }) => {
  const { store, dbPath } = newStore(factory); store.uploadBook(upload);
  sql(dbPath, db => { db.prepare("DELETE FROM novel_meta WHERE key = 'library_id'").run(); db.prepare("UPDATE novel_meta SET value = '99' WHERE key = 'schema_version'").run(); db.exec("CREATE TABLE future_private (payload TEXT); INSERT INTO future_private VALUES ('synthetic future payload')"); });
  const before = snapshot(dbPath), rejected = factory({ dbPath });
  assert.throws(() => rejected.summary(), /更新版本/); assert.throws(() => rejected.summary(), /更新版本/); assert.deepEqual(snapshot(dbPath), before);
});

test("Python-created library keeps the same UUID through Node reads, full rescan and single-file reimport", ({ factory, pythonSource }) => {
  const { dbPath } = newStore(factory), fixture = sourceFixture();
  scan(dbPath, ["--root", fixture.sourceRoot], { source: pythonSource });
  const id = metadata(dbPath, "library_id"); assert.match(id, uuid);
  const store = factory({ dbPath }), realm = store.summary().sourceRealm; assert.equal(realm, `server:${id}`);
  const book = store.listBooks(new URL("http://synthetic.invalid/api/novels")).books[0]; assert.equal(book.sourceRealm, realm);
  scan(dbPath, ["--root", fixture.sourceRoot], { source: pythonSource }); assert.equal(metadata(dbPath, "library_id"), id);
  fs.writeFileSync(fixture.file, text + "\n\n第三章 末尾\n\n合成追加正文。", "utf8");
  scan(dbPath, ["--file", fixture.file, "--source-root", fixture.sourceRoot, "--book-id", book.id], { source: pythonSource });
  assert.equal(metadata(dbPath, "library_id"), id); assert.equal(store.bookMeta(book.id).book.sourceRealm, realm); assert.equal(store.bookMeta(book.id).book.chapterCount, 3);
});

test("a complete scan retires only missing files in its roots, preserving other sources and recovery anchors", ({ factory, pythonSource }) => {
  const { store, dbPath } = newStore(factory), first = sourceFixture(), other = sourceFixture();
  scan(dbPath, ["--root", first.sourceRoot, "--root", other.sourceRoot], { source: pythonSource });
  const local = store.listBooks(new URL("http://synthetic.invalid")).books;
  const missing = local.find(book => book.sourcePath === first.file), retained = local.find(book => book.sourcePath === other.file);
  store.saveProgress(missing.id, { chapterIndex: 1, scrollRatio: 0.4 });
  const uploaded = store.uploadBook(upload), imported = store.importCollectedBook(collected);
  const before = [retained.id, uploaded.book.id, imported.book.id].map(id => store.bookDetail(id));
  fs.unlinkSync(first.file);
  scan(dbPath, ["--root", first.sourceRoot], { source: pythonSource });
  assert.equal(store.bookMeta(missing.id), null);
  assert.deepEqual(before.map(detail => store.bookDetail(detail.book.id)), before);
  const recovery = sql(dbPath, db => db.prepare("SELECT status, reason, chapter_index, scroll_ratio FROM novel_reading_state WHERE book_id = ?").get(missing.id), true);
  assert.deepEqual({ ...recovery }, { status: "unresolved", reason: "book_missing", chapter_index: 1, scroll_ratio: 0.4 });
});

test("limited scans and unavailable roots never retire unobserved books", ({ factory, pythonSource }) => {
  const { store, dbPath } = newStore(factory), fixture = sourceFixture();
  const second = path.join(fixture.sourceRoot, "second.txt"); fs.writeFileSync(second, text, "utf8");
  scan(dbPath, ["--root", fixture.sourceRoot], { source: pythonSource });
  const ids = store.listBooks(new URL("http://synthetic.invalid")).books.map(book => book.id).sort();
  scan(dbPath, ["--root", fixture.sourceRoot, "--limit", "1"], { source: pythonSource });
  assert.deepEqual(store.listBooks(new URL("http://synthetic.invalid")).books.map(book => book.id).sort(), ids);
  fs.unlinkSync(fixture.file); fs.unlinkSync(second); fs.rmdirSync(fixture.sourceRoot);
  const before = ids.map(id => store.bookDetail(id));
  scan(dbPath, ["--root", fixture.sourceRoot], { source: pythonSource });
  assert.deepEqual(ids.map(id => store.bookDetail(id)), before);
});

test("an enumeration error preserves unseen files even when part of the root was readable", ({ factory }) => {
  const { store, dbPath } = newStore(factory), fixture = sourceFixture();
  const second = path.join(fixture.sourceRoot, "second.txt"); fs.writeFileSync(second, text, "utf8");
  scan(dbPath, ["--root", fixture.sourceRoot]);
  const before = store.summary().totals.books;
  const injected = scannerSource.replace(
    "for directory, _subdirectories, names in os.walk(root, onerror=errors.append):",
    'errors.append(PermissionError("synthetic unreadable subtree"))\n        for directory, _subdirectories, names in [(str(root), [], ["synthetic.txt"])]:'
  );
  assert.notEqual(injected, scannerSource);
  scan(dbPath, ["--root", fixture.sourceRoot], { source: injected });
  assert.equal(store.summary().totals.books, before);
  assert(store.listBooks(new URL("http://synthetic.invalid")).books.some(book => book.sourcePath === second));
});

test("Node-initialized identity survives a Python full rebuild, including rollback of a rejected import", ({ factory, pythonSource }) => {
  const { store, dbPath } = newStore(factory), realm = store.summary().sourceRealm, fixture = sourceFixture();
  scan(dbPath, ["--root", fixture.sourceRoot], { source: pythonSource }); assert.equal(store.summary().sourceRealm, realm);
  const before = snapshot(dbPath);
  const result = scan(dbPath, ["--root", fixture.sourceRoot, "--root", fixture.sourceRoot], { expectedFailure: true, source: pythonSource });
  assert(result.stderr.includes("UNIQUE constraint failed")); assert.deepEqual(snapshot(dbPath), before); assert.equal(store.summary().sourceRealm, realm);
});

test("Python adds identity once to an old v4 library and does not nest an initialization transaction", ({ factory, pythonSource }) => {
  const { store, dbPath } = newStore(factory); store.summary(); sql(dbPath, db => db.prepare("DELETE FROM novel_meta WHERE key = 'library_id'").run());
  const fixture = sourceFixture(); scan(dbPath, ["--root", fixture.sourceRoot], { source: pythonSource });
  const identity = metadata(dbPath, "library_id"); assert.match(identity, uuid);
  scan(dbPath, ["--root", fixture.sourceRoot], { source: pythonSource }); assert.equal(metadata(dbPath, "library_id"), identity);
});

for (const fault of ["identity", "future"]) test(`Python refuses ${fault} before clearing the existing library`, ({ factory, pythonSource }) => {
  const { store, dbPath } = newStore(factory); store.uploadBook(upload);
  sql(dbPath, db => db.prepare("UPDATE novel_meta SET value = ? WHERE key = ?").run(fault === "identity" ? "invalid" : "99", fault === "identity" ? "library_id" : "schema_version"));
  const before = snapshot(dbPath), fixture = sourceFixture();
  const result = scan(dbPath, ["--root", fixture.sourceRoot], { expectedFailure: true, source: pythonSource });
  assert(result.stderr.includes(fault === "identity" ? "身份" : "更新版本")); assert.deepEqual(snapshot(dbPath), before);
});

const mutants = [
  { name: "replace UUID on every initialization", test: "new empty library", edits: [['if (existingIdentity && Number(metaValue(db, "schema_version")) === 5) return;', ""], ["if (!existingIdentity) {", "if (true) {"], ["ON CONFLICT(key) DO NOTHING", "ON CONFLICT(key) DO UPDATE SET value = excluded.value"]] },
  { name: "book DTO omits realm", test: "every public book", edits: [['...(sourceRealm ? { sourceRealm } : {}),', "/* no realm */"]] },
  { name: "progress ignores realm precondition", test: "wrong realm cannot write", edits: [["if (body.sourceRealm !== undefined && body.sourceRealm !== sourceRealmFromDb(database)) {", "if (false) {"]] },
  { name: "delete ignores realm precondition", test: "wrong realm cannot delete", edits: [["if (sourceRealm !== undefined && sourceRealm !== sourceRealmFromDb(database)) {", "if (false) {"]] },
  { name: "future-version protection removed", test: "future schema is refused", edits: [['if (version > 5) throw new Error("小说库来自更新版本，当前程序不能修改");', "/* no future-version guard */"]] }
];

let passed = 0, negatives = 0;
try {
  for (const item of tests) { await item.run({ factory: createNovelStore, pythonSource: null }); passed++; console.log(`PASS ${item.name}`); }
  for (const mutant of mutants) {
    let altered = storeSource;
    altered = altered.replace('"./chapter-identity.js"', JSON.stringify(pathToFileURL(path.join(root, "src/modules/novels/server/chapter-identity.js")).href));
    altered = altered.replace('"./local-reimport-artifact.js"', JSON.stringify(pathToFileURL(path.join(root, "src/modules/novels/server/local-reimport-artifact.js")).href));
    for (const [from, to] of mutant.edits) { assert.equal(altered.split(from).length, 2, `non-unique mutation: ${mutant.name}`); altered = altered.replace(from, to); }
    // Loading outside the expected-failure block excludes syntax/module failures.
    const { createNovelStore: factory } = await import("data:text/javascript;base64," + Buffer.from(altered).toString("base64"));
    const scenario = tests.find(item => item.name.startsWith(mutant.test)); let failure;
    try { await scenario.run({ factory, pythonSource: null }); } catch (error) { failure = error; }
    assert(failure?.code === "ERR_ASSERTION", `mutant did not fail a behavioral assertion: ${mutant.name}: ${failure?.stack}`);
    negatives++; console.log(`CONTROL rejected ${mutant.name}`);
  }
  for (const mutant of [
    { name: "DELETE route drops realm query", test: "actual DELETE route rejects", replacement: "{}" },
    { name: "DELETE route passes absent query as null", test: "actual DELETE route accepts", replacement: "{ sourceRealm }" }
  ]) {
    const anchor = "sourceRealm === null ? {} : { sourceRealm }";
    assert.equal(routeSource.split(anchor).length, 2, `non-unique route mutation: ${mutant.name}`);
    const altered = routeSource.replace(anchor, mutant.replacement);
    const { routeNovelApi: route } = await import("data:text/javascript;base64," + Buffer.from(altered).toString("base64"));
    let failure;
    try { await tests.find(item => item.name.startsWith(mutant.test)).run({ factory: createNovelStore, route }); }
    catch (error) { failure = error; }
    assert(failure?.code === "ERR_ASSERTION", `route mutant did not fail a behavioral assertion: ${mutant.name}: ${failure?.stack}`);
    negatives++; console.log(`CONTROL rejected ${mutant.name}`);
  }
  let alteredPython = scannerSource;
  for (const [from, to] of [["if not identity:\n", "if True:\n"], ["ON CONFLICT(key) DO NOTHING", "ON CONFLICT(key) DO UPDATE SET value = excluded.value"]]) {
    // Preserve the working tree's native newline style when constructing a mutant.
    const needle = from.includes("\n") && alteredPython.includes("\r\n") ? from.replaceAll("\n", "\r\n") : from;
    const replacement = to.includes("\n") && alteredPython.includes("\r\n") ? to.replaceAll("\n", "\r\n") : to;
    assert.equal(alteredPython.split(needle).length, 2); alteredPython = alteredPython.replace(needle, replacement);
  }
  const parse = spawnSync(process.env.PYTHON || "python", ["-B", "-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: alteredPython, encoding: "utf8", windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" } });
  assert.ifError(parse.error); assert.equal(parse.status, 0, parse.stderr);
  let failure;
  try { await tests.find(item => item.name.startsWith("Python-created library")).run({ factory: createNovelStore, pythonSource: alteredPython }); }
  catch (error) { failure = error; }
  assert(failure?.code === "ERR_ASSERTION" && failure.operator === "strictEqual", `Python identity mutation did not fail the identity assertion: ${failure?.stack}`);
  negatives++; console.log("CONTROL rejected Python full-scan identity reassignment");
  console.log(`Novel library identity: ${passed} real SQLite/Python/route scenarios passed; ${negatives} behavioral mutation controls rejected.`);
  console.log("Boundary: only generated temporary SQLite databases and synthetic TXT; actual routeNovelApi with a response boundary double. No HTTP server, real library, Android storage or network was accessed.");
} finally {
  // Resolve and constrain the exact owned directory before a recursive cleanup.
  const resolved = fs.realpathSync(temporary), expectedParent = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(resolved).toLowerCase(), expectedParent.toLowerCase());
  assert(path.basename(resolved).startsWith("fanhao-novel-identity-"));
  if (process.platform === "win32") {
    const cleanup = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$target = (Resolve-Path -LiteralPath $env:FANHAO_IDENTITY_TEST_DIRECTORY).Path; $parent = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).Path.TrimEnd('\\'); if ([System.IO.Path]::GetDirectoryName($target) -ne $parent -or -not ([System.IO.Path]::GetFileName($target).StartsWith('fanhao-novel-identity-'))) { throw 'Unsafe temporary cleanup target' }; Remove-Item -LiteralPath $target -Recurse -Force"],
      { encoding: "utf8", windowsHide: true, env: { ...process.env, FANHAO_IDENTITY_TEST_DIRECTORY: resolved } });
    assert.ifError(cleanup.error); assert.equal(cleanup.status, 0, cleanup.stderr);
  } else fs.rmSync(resolved, { recursive: true, force: true });
}
