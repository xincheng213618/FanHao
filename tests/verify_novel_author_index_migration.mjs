import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { createNovelStore } from "../src/modules/novels/server/store.js";

// Immutable complete v5 owners create real old databases. No default scanner
// roots are used: the Python collector only imports the one owned TXT fixture.
const project = path.resolve(import.meta.dirname, ".."), commit = "63c5fab243233e142cfd62c4eaf13812feb92405";
const scannerPath = path.join(project, "tools/rescan_novel_library.py");
const storeUrl = pathToFileURL(path.join(project, "src/modules/novels/server/store.js"));
const frozen = {};
for (const [name, hash] of [
  ["src/modules/novels/server/store.js", "f9ffae913d0efc7aa245ed5b3d8108af9c043b542c77e30fe704f4af6219a6fa"],
  ["tools/rescan_novel_library.py", "42e717d924a2dd41b59c6370dc1e77353f8c47eba8fff76823d74d1b2b8781a1"]
]) {
  const source = execFileSync("git", ["show", `${commit}:${name}`], { cwd: project, encoding: "utf8" }).replaceAll("\r\n", "\n");
  assert.equal(createHash("sha256").update(source).digest("hex"), hash); frozen[name] = source;
}
async function moduleFrom(source) {
  const resolved = source.replace(/from "(\.\.?\/[^"\n]+)"/gu, (_, relative) => "from " + JSON.stringify(new URL(relative, storeUrl).href));
  return import("data:text/javascript;base64," + Buffer.from(resolved + "\nexport { ensureSchema };\n").toString("base64"));
}
const previous = await moduleFrom(frozen["src/modules/novels/server/store.js"]);
const current = await moduleFrom(fs.readFileSync(storeUrl, "utf8"));
const indexName = "idx_novel_books_author_updated";
const expectedIndex = "CREATE INDEX idx_novel_books_author_updated ON novel_books(TRIM(COALESCE(author,'')),updated_at ASC,title COLLATE NOCASE DESC) WHERE status='ok' AND author COLLATE BINARY <> ''";
const compactSql = value => value?.replace(/'(?:''|[^'])*'|\s+/gu, token => token.startsWith("'") ? token : "");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-novel-author-migration-")), files = new Set(), handles = new Set();
let sequence = 0, assertions = 0;
const checks = [];
const collected = { sourceUrl: "https://fixture.invalid/migration", title: "Synthetic migration book", author: "Synthetic author",
  chapters: [{ title: "Chapter one", content: "Synthetic first body." }, { title: "Chapter two", content: "Synthetic second body." }] };
function file(name) { const value = path.join(root, `${++sequence}-${name}`); files.add(value); return value; }
function sql(dbPath, run, readOnly = false) {
  assert(path.resolve(dbPath).startsWith(path.resolve(root) + path.sep));
  const db = new DatabaseSync(dbPath, { readOnly }); handles.add(db);
  try { return run(db); } finally { db.close(); }
}
function metadata(dbPath, key) { return sql(dbPath, db => db.prepare("SELECT value FROM novel_meta WHERE key=?").get(key)?.value, true); }
function indexSql(dbPath) { return sql(dbPath, db => db.prepare("SELECT sql FROM main.sqlite_schema WHERE name=?").get(indexName)?.sql, true); }
function snapshot(dbPath, { dataOnly = false, normalizeVersion = false } = {}) {
  return sql(dbPath, db => {
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables = schema.filter(row => row.type === "table").map(row => ({ name: row.name,
      rows: db.prepare('SELECT * FROM "' + row.name.replaceAll('"', '""') + '"').all().map(value => {
        if (normalizeVersion && row.name === "novel_meta" && value.key === "schema_version") return { ...value, value: "version-policy" };
        return { ...value };
      }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) }));
    return dataOnly ? tables : { schema, tables };
  }, true);
}
function oldLibrary(name = "old.sqlite") {
  const dbPath = file(name), store = previous.createNovelStore({ dbPath });
  const detail = store.importCollectedBook(collected); store.invalidate();
  assert.equal(metadata(dbPath, "schema_version"), "5"); assert.equal(indexSql(dbPath), undefined);
  return { dbPath, detail };
}
function ensureNode(dbPath, options = {}) {
  return sql(dbPath, db => {
    const trace = [], execute = db.exec.bind(db), prepare = db.prepare.bind(db); let armed = true;
    for (const statement of options.setup || []) execute(statement);
    db.exec = function (statement, ...args) {
      trace.push(statement);
      if (armed && (options.future || options.loseIdentity) && statement === "BEGIN IMMEDIATE") {
        armed = false; sql(dbPath, writer => writer.exec(options.future
          ? "UPDATE novel_meta SET value='7' WHERE key='schema_version'" : "DELETE FROM novel_meta WHERE key='library_id'"));
      }
      const value = execute(statement, ...args);
      if (options.failIndex && statement.includes(indexName) && /CREATE\s+INDEX/iu.test(statement)) throw new Error("controlled index failure");
      return value;
    };
    db.prepare = function (statement, ...args) {
      const prepared = prepare(statement, ...args);
      if (options.failMarker && /INSERT|UPDATE/iu.test(statement) && statement.includes("schema_version")) {
        const run = prepared.run.bind(prepared);
        prepared.run = (...parameters) => { const result = run(...parameters); throw new Error("controlled marker failure"); };
      }
      return prepared;
    };
    if (options.begin) db.exec("BEGIN");
    let error;
    try { (options.previous ? previous : current).ensureSchema(db); } catch (value) { error = { name: value.name, message: value.message }; }
    const transaction = db.isTransaction;
    if (db.isTransaction) db.exec("ROLLBACK");
    return { ok: !error, error, transaction, trace };
  }, options.readOnly === true);
}
const pythonDriver = String.raw`
import json,sys,sqlite3,types
from pathlib import Path
p=json.load(sys.stdin)
sys.path.insert(0,str(Path(p['scanner']).parent))
m=types.ModuleType('fixture_novel_scanner');m.__file__=p['scanner'];sys.modules[m.__name__]=m
source=p.get('source') or Path(p['scanner']).read_text(encoding='utf-8')
exec(compile(source,p['scanner'],'exec'),m.__dict__)
trace=[]
class Controlled(sqlite3.Connection):
    armed=True
    def execute(self,statement,*args):
        if self.armed and (p.get('future') or p.get('loseIdentity')) and statement=='BEGIN IMMEDIATE':
            self.armed=False
            with sqlite3.connect(p['dbPath']) as w:w.execute("UPDATE novel_meta SET value='7' WHERE key='schema_version'" if p.get('future') else "DELETE FROM novel_meta WHERE key='library_id'")
        result=super().execute(statement,*args)
        if p.get('failIndex') and 'idx_novel_books_author_updated' in statement and 'CREATE INDEX' in statement:
            raise sqlite3.OperationalError('controlled index failure')
        if p.get('failMarker') and 'schema_version' in statement and ('INSERT' in statement or 'UPDATE' in statement):
            raise sqlite3.OperationalError('controlled marker failure')
        return result
c=sqlite3.connect(Path(p['dbPath']).as_uri()+'?mode=ro',uri=True,factory=Controlled) if p.get('readOnly') else sqlite3.connect(p['dbPath'],factory=Controlled)
c.set_trace_callback(trace.append)
result={}
try:
    for statement in p.get('setup',[]):c.execute(statement)
    if p.get('begin'):c.execute('BEGIN')
    if p.get('write'):
        m.write_record(Path(p['dbPath']),m.build_book(Path(p['sourceRoot']),Path(p['sourceFile'])))
    else:m.ensure_schema(c)
    result['ok']=True
except Exception as e:result.update(ok=False,error={'name':type(e).__name__,'message':str(e)})
finally:
    result.update(transaction=c.in_transaction,trace=trace)
    if c.in_transaction:c.rollback()
    c.close()
print('__MIGRATION_RESULT__'+json.dumps(result,ensure_ascii=False))
`;
function python(dbPath, options = {}) {
  const result = spawnSync(process.env.PYTHON || "python", ["-B", "-c", pythonDriver], { cwd: project, windowsHide: true, encoding: "utf8",
    input: JSON.stringify({ scanner: scannerPath, dbPath, ...options }), timeout: 20000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" } });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr + result.stdout);
  const line = result.stdout.split(/\r?\n/u).findLast(value => value.startsWith("__MIGRATION_RESULT__"));
  assert(line, result.stdout); return JSON.parse(line.slice("__MIGRATION_RESULT__".length));
}
function ok(result) { assert.equal(result.ok, true, JSON.stringify(result)); assertions++; }
function migrated(dbPath, before) {
  assert.equal(metadata(dbPath, "schema_version"), "6");
  assert.equal(compactSql(indexSql(dbPath)), compactSql(expectedIndex));
  assert.deepEqual(snapshot(dbPath, { dataOnly: true, normalizeVersion: true }), before, "index migration preserves every data row/identity/catalog/body"); assertions++;
}
function check(name, run) { checks.push({ name, run }); }

// Cases are registered below; all data paths are explicitly within this root.
check("frozen Node v5 upgrades in Python and reopens in Node without changing data", () => {
  const { dbPath, detail } = oldLibrary(), before = snapshot(dbPath, { dataOnly: true, normalizeVersion: true });
  ok(python(dbPath)); migrated(dbPath, before);
  ok(ensureNode(dbPath));
  assert.equal(createNovelStore({ dbPath }).bookDetail(detail.book.id).catalogRevision, detail.catalogRevision);
  const stable = snapshot(dbPath); ok(python(dbPath)); ok(ensureNode(dbPath)); assert.deepEqual(snapshot(dbPath), stable);
});
check("frozen Python v5 producer upgrades in Node and remains writable by the actual Python collector", () => {
  const dbPath = file("python-v5.sqlite"), sourceFile = file("synthetic.txt");
  fs.writeFileSync(sourceFile, "第一章 Synthetic\n\nOnly an owned synthetic chapter body.\n\n第二章 Next\n\nSecond private body.");
  ok(python(dbPath, { source: frozen["tools/rescan_novel_library.py"], write: true, sourceRoot: root, sourceFile }));
  assert.equal(metadata(dbPath, "schema_version"), "5");
  const before = snapshot(dbPath, { dataOnly: true, normalizeVersion: true });
  ok(ensureNode(dbPath)); migrated(dbPath, before);
  ok(python(dbPath, { write: true, sourceRoot: root, sourceFile }));
  assert.equal(metadata(dbPath, "schema_version"), "6"); assert.equal(compactSql(indexSql(dbPath)), compactSql(expectedIndex));
  const books = createNovelStore({ dbPath }).listBooks(new URL("http://fixture.invalid/api/novels?limit=10"));
  assert.equal(books.books.length, 1); assert.equal(createNovelStore({ dbPath }).catalog(books.books[0].id, new URL("http://fixture.invalid/catalog")).total, 2);
});
check("both new initializers create interoperable v6 databases", () => {
  for (const language of ["Node", "Python"]) {
    const dbPath = file("fresh-" + language + ".sqlite");
    ok(language === "Node" ? ensureNode(dbPath) : python(dbPath));
    assert.equal(metadata(dbPath, "schema_version"), "6"); assert.equal(compactSql(indexSql(dbPath)), compactSql(expectedIndex));
    ok(language === "Node" ? python(dbPath) : ensureNode(dbPath));
  }
});

check("v4 still runs the chapter migration while v5 never replaces chapter identities", () => {
  for (const language of ["Node", "Python"]) {
    const { dbPath, detail } = oldLibrary();
    sql(dbPath, db => {
      for (const column of ["catalog_revision", "legacy_write_allowed"]) db.exec(`ALTER TABLE novel_books DROP COLUMN ${column}`);
      for (const column of ["catalog_revision", "status", "reason", "anchor_json", "candidate_json"]) db.exec(`ALTER TABLE novel_reading_state DROP COLUMN ${column}`);
      db.exec("UPDATE novel_meta SET value='4' WHERE key='schema_version'");
    });
    const before = sql(dbPath, db => db.prepare("SELECT id,book_id,title,content FROM novel_chapters ORDER BY chapter_index").all());
    ok(language === "Node" ? ensureNode(dbPath) : python(dbPath));
    assert.equal(metadata(dbPath, "schema_version"), "6"); assert.equal(compactSql(indexSql(dbPath)), compactSql(expectedIndex));
    assert.deepEqual(sql(dbPath, db => db.prepare("SELECT id,book_id,title,content FROM novel_chapters ORDER BY chapter_index").all()), before);
    assert.match(createNovelStore({ dbPath }).bookMeta(detail.book.id).catalogRevision, /^[0-9a-f-]{36}$/u);
  }
});

check("index and marker failures roll back v5 and fresh initialization, then retry succeeds", () => {
  for (const language of ["Node", "Python"]) for (const fault of ["failIndex", "failMarker"]) for (const fresh of [false, true]) {
    const dbPath = fresh ? file("failed-fresh.sqlite") : oldLibrary().dbPath;
    if (fresh) sql(dbPath, () => {});
    const before = snapshot(dbPath), invoke = options => language === "Node" ? ensureNode(dbPath, options) : python(dbPath, options);
    const result = invoke({ [fault]: true });
    assert.equal(result.ok, false); assert.match(result.error.message, /controlled (?:index|marker) failure/u);
    assert.equal(result.transaction, false); assert.deepEqual(snapshot(dbPath), before, "DDL, UUID and version commit atomically");
    ok(invoke({})); assert.equal(metadata(dbPath, "schema_version"), "6"); assert.equal(compactSql(indexSql(dbPath)), compactSql(expectedIndex));
  }
});

check("invalid metadata and future7 preserve each frozen authority's original error", () => {
  for (const language of ["Node", "Python"]) for (const [key, value] of [["schema_version", "bad"], ["schema_version", "-1"], ["schema_version", "1.5"], ["schema_version", "7"], ["library_id", "invalid"]]) {
    const { dbPath } = oldLibrary(); sql(dbPath, db => db.prepare("UPDATE novel_meta SET value=? WHERE key=?").run(value, key));
    const before = snapshot(dbPath);
    const old = language === "Node" ? ensureNode(dbPath, { previous: true }) : python(dbPath, { source: frozen["tools/rescan_novel_library.py"] });
    const result = language === "Node" ? ensureNode(dbPath) : python(dbPath);
    assert.equal(old.ok, false); assert.deepEqual(result.error, old.error); assert.deepEqual(snapshot(dbPath), before); assertions++;
  }
});

check("writer-lock revalidation refuses future7 and retains each authority's missing-identity behavior", () => {
  for (const language of ["Node", "Python"]) {
    const { dbPath } = oldLibrary(), identity = metadata(dbPath, "library_id");
    const future = language === "Node" ? ensureNode(dbPath, { future: true }) : python(dbPath, { future: true });
    assert.equal(future.ok, false); assert.match(future.error.message, /来自更新版本/u);
    assert.equal(metadata(dbPath, "schema_version"), "7"); assert.equal(indexSql(dbPath), undefined); assert.equal(metadata(dbPath, "library_id"), identity);
    sql(dbPath, db => db.exec("UPDATE novel_meta SET value='5' WHERE key='schema_version'"));
    const lost = language === "Node" ? ensureNode(dbPath, { loseIdentity: true }) : python(dbPath, { loseIdentity: true });
    if (language === "Node") {
      assert.equal(lost.ok, false); assert.match(lost.error.message, /缺少有效的持久来源身份/u);
      assert.equal(metadata(dbPath, "schema_version"), "5"); assert.equal(metadata(dbPath, "library_id"), undefined); assert.equal(indexSql(dbPath), undefined);
    } else {
      ok(lost); assert.equal(metadata(dbPath, "schema_version"), "6"); assert.notEqual(metadata(dbPath, "library_id"), identity);
      assert.match(metadata(dbPath, "library_id"), /^[0-9a-f-]{36}$/u);
      const oldFile = oldLibrary().dbPath;
      ok(python(oldFile, { source: frozen["tools/rescan_novel_library.py"], loseIdentity: true }));
      assert.equal(metadata(oldFile, "schema_version"), "5"); assert.match(metadata(oldFile, "library_id"), /^[0-9a-f-]{36}$/u);
    }
  }
});

check("Node savepoints preserve caller rollback and v6 readonly initializers avoid a held writer lock", () => {
  const { dbPath, detail } = oldLibrary(), before = snapshot(dbPath);
  const nested = ensureNode(dbPath, { begin: true }); ok(nested); assert(nested.transaction); assert.deepEqual(snapshot(dbPath), before);
  ok(ensureNode(dbPath));
  const lock = new DatabaseSync(dbPath); handles.add(lock); lock.exec("BEGIN IMMEDIATE");
  try {
    lock.exec("UPDATE novel_chapters SET content='uncommitted' WHERE chapter_index=1");
    for (const result of [ensureNode(dbPath, { readOnly: true }), python(dbPath, { readOnly: true })]) {
      ok(result); assert(!result.trace.some(statement => /^(?:BEGIN|CREATE|ALTER|INSERT|UPDATE|DELETE)/iu.test(statement.trim())), "v6 fast return remains read-only");
    }
    assert.equal(createNovelStore({ dbPath }).chapterDetail(detail.book.id, 1).chapter.content, "Synthetic first body.");
  } finally { lock.exec("ROLLBACK"); lock.close(); }
  for (const result of [ensureNode(dbPath, { begin: true }), python(dbPath, { begin: true })]) { ok(result); assert(result.transaction, "v6 must not commit its caller's transaction"); }
});

function rebuildBooks(dbPath, transform) {
  sql(dbPath, db => {
    const table = db.prepare("SELECT sql FROM main.sqlite_schema WHERE name='novel_books'").get().sql;
    const indexes = db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='index' AND tbl_name='novel_books' AND sql IS NOT NULL").all();
    db.exec("ALTER TABLE novel_books RENAME TO saved_books");
    db.exec(transform(table)); db.exec("INSERT INTO novel_books SELECT * FROM saved_books; DROP TABLE saved_books");
    for (const index of indexes) db.exec(index.sql);
  });
}
check("unsupported v5 schemas skip the optional index without rerunning old DDL", () => {
  const changes = [
    ["missing-author", dbPath => sql(dbPath, db => db.exec("DROP INDEX idx_novel_books_author; ALTER TABLE novel_books DROP COLUMN author"))],
    ["updated-desc", dbPath => sql(dbPath, db => db.exec("DROP INDEX idx_novel_books_updated; CREATE INDEX idx_novel_books_updated ON novel_books(updated_at DESC)"))],
    ["extra-index", dbPath => sql(dbPath, db => db.exec("CREATE INDEX fixture_extra ON novel_books(title)"))],
    ["rowid-alias", dbPath => sql(dbPath, db => db.exec("ALTER TABLE novel_books ADD COLUMN rowid TEXT"))],
    ["generated", dbPath => sql(dbPath, db => db.exec("ALTER TABLE novel_books ADD COLUMN fixture_generated INTEGER GENERATED ALWAYS AS (1) VIRTUAL"))],
    ["statusTEXT", dbPath => rebuildBooks(dbPath, ddl => ddl.replace("status TEXT", "statusTEXT"))],
    ["idTEXT", dbPath => rebuildBooks(dbPath, ddl => ddl.replace("id TEXT", "idTEXT"))],
    ["view", dbPath => sql(dbPath, db => db.exec("ALTER TABLE novel_books RENAME TO saved_books; CREATE VIEW novel_books AS SELECT * FROM saved_books"))],
    ["wrong-index", dbPath => sql(dbPath, db => db.exec(`CREATE INDEX ${indexName} ON novel_books(author)`))]
  ];
  for (const language of ["Node", "Python"]) for (const [name, change] of changes) {
    const { dbPath } = oldLibrary(); change(dbPath);
    const before = snapshot(dbPath, { dataOnly: true, normalizeVersion: true }), oldIndex = indexSql(dbPath);
    ok(language === "Node" ? ensureNode(dbPath) : python(dbPath));
    assert.equal(metadata(dbPath, "schema_version"), "6", name);
    assert.equal(indexSql(dbPath), oldIndex, name + " does not install/drop/replace an index");
    assert.deepEqual(snapshot(dbPath, { dataOnly: true, normalizeVersion: true }), before, name + " preserves legacy data");
    ok(language === "Node" ? ensureNode(dbPath) : python(dbPath));
  }
});
check("TEMP table/view shadows skip installation but a TEMP index name cannot suppress main installation", () => {
  for (const language of ["Node", "Python"]) for (const setup of [
    ["CREATE TEMP TABLE NOVEL_BOOKS(unrelated TEXT)"],
    ["CREATE TEMP VIEW NOVEL_READING_STATE AS SELECT * FROM main.novel_reading_state"]
  ]) {
    const { dbPath } = oldLibrary(), before = snapshot(dbPath, { dataOnly: true, normalizeVersion: true });
    ok(language === "Node" ? ensureNode(dbPath, { setup }) : python(dbPath, { setup }));
    assert.equal(metadata(dbPath, "schema_version"), "6"); assert.equal(indexSql(dbPath), undefined);
    assert.deepEqual(snapshot(dbPath, { dataOnly: true, normalizeVersion: true }), before);
  }
  for (const language of ["Node", "Python"]) {
    const { dbPath } = oldLibrary(), setup = ["CREATE TEMP TABLE fixture_temp(value TEXT)", `CREATE INDEX temp.${indexName} ON fixture_temp(value)`];
    ok(language === "Node" ? ensureNode(dbPath, { setup }) : python(dbPath, { setup }));
    assert.equal(compactSql(indexSql(dbPath)), compactSql(expectedIndex), "the CREATE INDEX target is explicitly main");
  }
});

try {
  for (const entry of checks) { entry.run(); console.log("PASS " + entry.name); }
  console.log(JSON.stringify({ ok: true, groups: checks.length, assertions, scope: "frozen complete v5 owners and actual Node/Python v6 initializers; private SQLite/TXT only" }));
} finally {
  for (const db of handles) try { db.close(); } catch {}
  assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
  for (const dbPath of files) {
    assert(path.resolve(dbPath).startsWith(path.resolve(root) + path.sep));
    for (const suffix of ["", "-wal", "-shm", "-journal"]) if (fs.existsSync(dbPath + suffix)) fs.unlinkSync(dbPath + suffix);
  }
  fs.rmdirSync(root);
}
