import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as current from "../src/modules/fanhao/server/people/person-identity.js";

// Preserve the former two functions as a behavioral oracle; both paths use
// real private in-memory SQLite connections. No production data is accessed.
const originals = String.raw`
export function hasIdentityTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name));
}
export function canonicalPersonId(db, personId) {
  let id = Number(personId);
  if (!Number.isSafeInteger(id) || id <= 0) return "";
  if (!hasIdentityTable(db, "person_redirects")) return String(id);
  const seen = new Set();
  const query = db.prepare("SELECT target_id FROM person_redirects WHERE source_id = ?");
  while (true) {
    if (seen.has(id)) throw identityError("人物合并关系存在循环", "PERSON_REDIRECT_CYCLE");
    seen.add(id);
    const row = query.get(id);
    if (!row) return String(id);
    id = Number(row.target_id);
  }
}`;
const sourceUrl = new URL("../src/modules/fanhao/server/people/person-identity.js", import.meta.url);
const source = fs.readFileSync(sourceUrl, "utf8");
const identityErrorSource = source.slice(source.indexOf("export function identityError("), source.indexOf("export function hasIdentityTable("));
const previous = await import(`data:text/javascript;base64,${Buffer.from(identityErrorSource + originals).toString("base64")}`);
const candidate = process.argv.includes("--legacy") ? previous : current;
const handles = new Set();
const schema = "CREATE TABLE person_redirects(source_id INTEGER PRIMARY KEY, target_id INTEGER NOT NULL)";

function database({ redirects = true } = {}) {
  const db = new DatabaseSync(":memory:"); handles.add(db);
  if (redirects) db.exec(`${schema}; INSERT INTO person_redirects VALUES(1,2),(2,3)`);
  let prepares = 0, reads = 0, prepareFault = null, readFault = null;
  const originalPrepare = db.prepare.bind(db);
  db.prepare = sql => {
    prepares++;
    if (prepareFault && sql.includes(prepareFault.match)) {
      const fault = prepareFault; prepareFault = null; throw fault.error;
    }
    const statement = originalPrepare(sql), get = statement.get.bind(statement);
    statement.get = (...args) => {
      reads++;
      if (readFault && sql.includes(readFault.match)) {
        const fault = readFault; readFault = null; throw fault.error;
      }
      return get(...args);
    };
    return statement;
  };
  return {
    db,
    counts: () => ({ prepares, reads }),
    failPrepare(match) { prepareFault = { match, error: Object.assign(new Error("controlled prepare failure"), { code: "SQLITE_BUSY" }) }; },
    failRead(match) { readFault = { match, error: Object.assign(new Error("controlled read failure"), { code: "SQLITE_BUSY" }) }; }
  };
}
function outcome(run) {
  try { return { value: run() }; }
  catch (error) { return { error: { name: error.name, message: error.message, code: error.code, statusCode: error.statusCode } }; }
}
function pair(options) {
  const old = database(options), next = database(options);
  return {
    old, next,
    exec(sql) { old.db.exec(sql); next.db.exec(sql); },
    check(id, expected) {
      const before = outcome(() => previous.canonicalPersonId(old.db, id));
      const after = outcome(() => candidate.canonicalPersonId(next.db, id));
      assert.deepEqual(after, before, `identity ${String(id)} preserves its value or complete error`);
      if (expected !== undefined) assert.equal(after.value, expected);
      return after;
    },
    table(name, expected) {
      const before = outcome(() => previous.hasIdentityTable(old.db, name));
      const after = outcome(() => candidate.hasIdentityTable(next.db, name));
      assert.deepEqual(after, before);
      if (expected !== undefined) assert.equal(after.value, expected);
      return after;
    }
  };
}

try {
  const measured = pair();
  for (let index = 0; index < 2000; index++) measured.check(index % 2 ? 1 : 4, index % 2 ? "3" : "4");
  assert.equal(measured.old.counts().prepares, 4000);
  assert.equal(measured.next.counts().prepares, 2, "only two fixed read statements may be compiled per connection");
  assert.equal(measured.next.counts().reads, measured.old.counts().reads, "all live identity reads must remain");

  const live = pair();
  live.check(1, "3");
  live.exec("UPDATE person_redirects SET target_id=4 WHERE source_id=2"); live.check(1, "4");
  live.exec("DELETE FROM person_redirects WHERE source_id=1"); live.check(1, "1");
  live.exec("INSERT INTO person_redirects VALUES(1,2); ALTER TABLE person_redirects ADD COLUMN extra TEXT"); live.check(1, "4");
  live.exec("UPDATE person_redirects SET target_id=1 WHERE source_id=2");
  assert.equal(live.check(1).error.code, "PERSON_REDIRECT_CYCLE");
  live.exec("DROP TABLE person_redirects"); live.check(1, "1"); live.table("person_redirects", false);
  live.exec(`${schema}; INSERT INTO person_redirects VALUES(1,9)`); live.check(1, "9");
  live.exec("DROP TABLE person_redirects; CREATE TABLE person_redirects(source_id INTEGER PRIMARY KEY)");
  assert(live.check(1).error, "an incompatible schema must retain its error");
  live.exec("ALTER TABLE person_redirects ADD COLUMN target_id INTEGER; INSERT INTO person_redirects VALUES(1,7)"); live.check(1, "7");
  live.table("person_redirects", true); live.table("unknown", false); live.table("unknown' OR 1=1 --", false);

  const missing = pair({ redirects: false });
  for (const value of [1, "001", 4]) missing.check(value, String(Number(value)));
  assert.equal(missing.next.counts().prepares, 1, "missing identity schema must not eagerly prepare its redirect query");
  missing.exec(`${schema}; INSERT INTO person_redirects VALUES(1,8)`); missing.check(1, "8");

  const invalid = pair();
  for (const id of [null, undefined, "", "abc", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, Symbol("invalid")]) invalid.check(id);
  assert.deepEqual(invalid.next.counts(), { prepares: 0, reads: 0 });

  for (const match of ["sqlite_schema", "SELECT target_id"]) {
    const retry = pair();
    retry.old.failPrepare(match); retry.next.failPrepare(match);
    assert.equal(retry.check(1).error.message, "controlled prepare failure");
    retry.check(1, "3"); retry.check(1, "3");
    assert.equal(retry.next.counts().prepares, 3, "a failed preparation is retried without retaining a partial entry");
    retry.old.failRead(match); retry.next.failRead(match);
    assert.equal(retry.check(1).error.message, "controlled read failure");
    retry.check(1, "3");
  }

  const first = pair(), replacement = pair();
  first.check(1, "3"); replacement.exec("UPDATE person_redirects SET target_id=8 WHERE source_id=2"); replacement.check(1, "8"); first.check(1, "3");
  for (const f of [first.old, first.next]) f.db.close();
  assert.equal(first.check(1).error.message, "database is not open");
  assert.equal(first.table("person_redirects").error.message, "database is not open");
  replacement.check(1, "8");

  // Node allows reusing the same DatabaseSync object after close/open. Existing
  // prepared statements are finalized; they must not poison the reopened DB.
  for (const inspectClosed of [false, true]) {
    const reopened = pair(); reopened.check(1, "3");
    reopened.old.db.close(); reopened.next.db.close();
    if (inspectClosed) reopened.check(1);
    reopened.old.db.open(); reopened.next.db.open();
    reopened.exec(`${schema}; INSERT INTO person_redirects VALUES(1,6)`); reopened.check(1, "6");
  }
  const reopenRetry = pair(); reopenRetry.check(1, "3");
  reopenRetry.old.db.close(); reopenRetry.next.db.close();
  reopenRetry.old.db.open(); reopenRetry.next.db.open();
  reopenRetry.exec(`${schema}; INSERT INTO person_redirects VALUES(1,6)`);
  reopenRetry.old.failPrepare("sqlite_schema"); reopenRetry.next.failPrepare("sqlite_schema");
  assert.equal(reopenRetry.check(1).error.message, "controlled prepare failure");
  reopenRetry.check(1, "6");

  // A facade can remain stable while its underlying connection changes. Only
  // known open connections can be cached; retain the existing duck-typed API.
  const facadeFirst = database(), facadeNext = database();
  facadeNext.db.exec("UPDATE person_redirects SET target_id=8 WHERE source_id=2");
  for (const withIsOpen of [false, true]) {
    let backing = facadeFirst.db;
    const facade = { prepare: sql => backing.prepare(sql) };
    if (withIsOpen) Object.defineProperty(facade, "isOpen", { get: () => backing.isOpen });
    assert.equal(candidate.canonicalPersonId(facade, 1), "3");
    backing = facadeNext.db;
    assert.equal(candidate.canonicalPersonId(facade, 1), "8");
  }
  // A Proxy of a native connection also passes instanceof DatabaseSync, while
  // its forwarded methods may switch to a different backing connection.
  let proxyBacking = facadeFirst.db;
  const proxy = new Proxy(facadeFirst.db, {
    get(_target, key) {
      const value = Reflect.get(proxyBacking, key, proxyBacking);
      return typeof value === "function" ? value.bind(proxyBacking) : value;
    }
  });
  assert.ok(proxy instanceof DatabaseSync);
  for (const [backing, expected] of [[facadeFirst.db, "3"], [facadeNext.db, "8"], [facadeFirst.db, "3"]]) {
    proxyBacking = backing;
    assert.equal(previous.canonicalPersonId(proxy, 1), expected);
    assert.equal(candidate.canonicalPersonId(proxy, 1), expected, "a native Proxy must read its current backing connection");
  }
  console.log(`person-identity-statement-reuse: ok (2000 lookups, prepares ${measured.old.counts().prepares}->${measured.next.counts().prepares}, ${measured.next.counts().reads} live reads, schema/row changes, cycle errors, failed prepare/read retries, connection isolation, close/reopen, facade/proxy switching)`);
} finally {
  for (const db of handles) if (db.isOpen) db.close();
}
