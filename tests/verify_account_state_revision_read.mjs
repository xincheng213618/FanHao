import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createUserStateService } from "../src/modules/fanhao/server/collections/user-state-service.js";
import { createVerifiedTempDir } from "./verified-temp-cleanup.mjs";

// Actual complete owners and native private SQLite only. Returned text/BLOB bytes
// are counted after native get(), independently of the query's advertised shape.
// No services, account credentials, application databases or media are opened.
const OWNER = "src/modules/fanhao/server/collections/account-user-state-service.js";
const ownerUrl = new URL(`../${OWNER}`, import.meta.url);
const BEFORE = "63c5fab243233e142cfd62c4eaf13812feb92405";
const BEFORE_SHA = "9b1fbf9cfa3522eb698b687d83e2444a5c284b454c5af0da01253aa664a479b2";
const oldSource = execFileSync("git", ["show", `${BEFORE}:${OWNER}`], { encoding: "utf8" }).replaceAll("\r\n", "\n");
assert.equal(createHash("sha256").update(oldSource).digest("hex"), BEFORE_SHA);
const currentSource = fs.readFileSync(ownerUrl, "utf8").replaceAll("\r\n", "\n");
const FULL = "SELECT revision, state_json FROM account_user_state WHERE account_id = ?";
const narrowMatch = /\? `(WITH body_policy AS MATERIALIZED[\s\S]+?)`\n        : "SELECT revision, state_json FROM account_user_state WHERE account_id = \?"/.exec(currentSource);
assert.ok(narrowMatch, "locate the complete actual warm SQL");
const NARROW = narrowMatch[1];
assert.equal(currentSource.split(NARROW).length, 2, "negative control has exactly one projection anchor");
const OMIT_BODY = "THEN CASE typeof(state_json) WHEN 'integer' THEN state_json ELSE NULL END";
assert.equal(NARROW.split(OMIT_BODY).length, 2);
// Keep the live provider proof, omit_body marker and conditional second read.
// Only return the full body at the ordinary-column omission point.
const WIDE_WARM = NARROW.replace(OMIT_BODY, "THEN state_json");
assert.ok(process.argv.slice(2).every(value => value === "--legacy-wide-read"));
const negative = process.argv.includes("--legacy-wide-read");
const load = async (source, name) => {
  const rebased = source.replace(/from "(\.\.?\/[^"\n]+)"/g, (_match, relative) => "from " + JSON.stringify(new URL(relative, ownerUrl).href));
  return (await import(`data:text/javascript;base64,${Buffer.from(`${rebased}\n//# sourceURL=${name}.js\n`).toString("base64")}`)).createAccountUserStateService;
};
const beforeFactory = await load(oldSource, "account-revision-before");
const currentFactory = await load(negative ? currentSource.replace(NARROW, WIDE_WARM) : currentSource, "account-revision-current");
const temp = createVerifiedTempDir("fanhao-account-revision-read-");
const fixtures = [];
let nextFixture = 0, comparisons = 0, errorComparisons = 0, raceCases = 0, fullReadFailures = 0, metadataShadowCases = 0;
let active = null;
const statementOwners = new WeakMap();
const originalPrepare = DatabaseSync.prototype.prepare;
const scratch = new DatabaseSync(":memory:");
const statementPrototype = Object.getPrototypeOf(scratch.prepare("SELECT 1"));
scratch.close();
const originalGet = statementPrototype.get;

DatabaseSync.prototype.prepare = function (sql, ...args) {
  const accountRead = sql === FULL || sql === NARROW || sql === WIDE_WARM;
  if (active && accountRead) active.fail?.("prepare", sql);
  const statement = originalPrepare.call(this, sql, ...args);
  if (accountRead) statementOwners.set(statement, { connection: this, sql });
  return statement;
};
statementPrototype.get = function (...args) {
  const metadata = statementOwners.get(this), observer = metadata && active;
  if (observer) {
    observer.stats.attempts++;
    observer.fail?.("get", metadata.sql);
  }
  const row = originalGet.apply(this, args);
  if (observer) {
    observer.connection = metadata.connection;
    const { stats } = observer;
    stats.reads++;
    stats[metadata.sql === NARROW ? "narrow" : "full"]++;
    const body = row?.state_json;
    stats.bodyBytes += typeof body === "string" ? Buffer.byteLength(body) : ArrayBuffer.isView(body) ? body.byteLength : 0;
    observer.afterRead?.(metadata, row, args);
  }
  return row;
};

const emptyStats = () => ({ attempts: 0, reads: 0, full: 0, narrow: 0, bodyBytes: 0 });
const tick = () => Promise.resolve();
function payload(label = "A", count = 2) {
  return {
    favoriteFolders: { default: { name: "默认收藏", createdAt: "" }, synthetic: { name: `Folder ${label}`, createdAt: "2026-01-01" } },
    favorites: { [`work-${label}`]: { folderId: "synthetic", createdAt: "2026-01-02" } },
    progress: Object.fromEntries(Array.from({ length: count }, (_, index) => [`video-${index}`, {
      workId: `work-${label}`, position: index + 0.5, duration: index + 100, updatedAt: "2026-11-05T00:00:00.000Z"
    }]))
  };
}
function fixture(factory, { schema = null, rows = [["alice", 1, JSON.stringify(payload())]], initializer = factory } = {}) {
  const id = ++nextFixture, dbPath = path.join(temp.tempDir, `${id}.sqlite`);
  const legacy = createUserStateService({ statePath: path.join(temp.tempDir, `${id}.json`), ensureDataDir: () => {},
    warn: (...args) => { throw new Error(args.join(" ")); } });
  if (!schema) {
    // The real production initializer owns the canonical schema; a fresh owner
    // then starts with no account cache entries for the seeded cold-read cases.
    const bootstrap = initializer({ dbPath, legacyStateService: legacy });
    bootstrap.runForUser({ id: "bootstrap" }, () => bootstrap.state());
    bootstrap.close();
  }
  const writer = new DatabaseSync(dbPath);
  writer.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
  if (schema) writer.exec(`${schema}; PRAGMA user_version = 1;`);
  const insert = writer.prepare("INSERT INTO account_user_state(account_id,revision,state_json) VALUES(?,?,?)");
  for (const row of rows) insert.run(...row);
  const service = factory({ dbPath, legacyStateService: legacy });
  const f = { service, writer, legacy, stats: emptyStats(), afterRead: null, fail: null,
    run(owner, callback) {
      const previous = active; active = f;
      try { return service.runForUser({ id: owner }, callback); } finally { active = previous; }
    },
    reference(owner = "alice") { return f.run(owner, () => service.state()); },
    read(owner = "alice") { return f.run(owner, () => ({ state: structuredClone(service.state()), revision: service.revision() })); },
    write(revision, body, owner = "alice") { writer.prepare("UPDATE account_user_state SET revision=?,state_json=? WHERE account_id=?").run(revision, body, owner); },
    reset() { f.stats = emptyStats(); }
  };
  fixtures.push(f);
  return f;
}
function pair(options) { return [fixture(beforeFactory, options), fixture(currentFactory, options)]; }
function compare(both, label, owner = "alice") {
  const [old, next] = both.map(f => f.read(owner));
  assert.deepEqual(next, old, label);
  assert.equal(JSON.stringify(next), JSON.stringify(old), `${label}: complete wire and field order`);
  comparisons++;
  return next;
}
function errorOf(f, owner = "alice") {
  try { f.read(owner); assert.fail("expected account read to fail"); }
  catch (error) { if (error.code === "ERR_ASSERTION") throw error; return { name: error.name, message: error.message, code: error.code || null }; }
}
function compareErrors(both, label, owner = "alice") {
  const old = errorOf(both[0], owner), next = errorOf(both[1], owner);
  assert.deepEqual(next, old, label); errorComparisons++;
  return next;
}
const looseSchema = "CREATE TABLE account_user_state(account_id TEXT PRIMARY KEY,revision,state_json)";

try {
  const both = pair();
  const initializedDdl = both.map(f => f.writer.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name='account_user_state'").get().sql);
  assert.equal(initializedDdl[1], initializedDdl[0], "the current initializer preserves the frozen old SQLite DDL byte for byte");
  compare(both, "cold complete row");
  for (const f of both) assert.equal(f.stats.reads, 1, "cold miss reads one full row");
  const references = both.map(f => f.reference());
  for (let index = 0; index < 12; index++) compare(both, "same-tick state/revision share the read");
  for (const f of both) assert.equal(f.stats.reads, 1);
  await tick();
  for (const f of both) f.reset();
  compare(both, "unchanged revision after microtask");
  for (let index = 0; index < 2; index++) assert.equal(both[index].reference(), references[index]);
  for (const f of both) assert.equal(f.stats.reads, 1);

  await tick();
  for (const f of both) f.write(2, JSON.stringify(payload("B")));
  compare(both, "external WAL update replaces all state fields");
  for (let index = 0; index < 2; index++) assert.equal(both[index].reference(), references[index], "reload preserves exposed state object");
  await tick();
  for (const f of both) f.write(2, JSON.stringify(payload("ignored")));
  assert.equal(compare(both, "same-revision body changes remain ignored").state.favoriteFolders.synthetic.name, "Folder B");
  await tick();
  for (const f of both) f.write(2, "malformed but unchanged revision");
  compare(both, "same-revision malformed body is not decoded");
  await tick();
  for (const f of both) f.writer.prepare("DELETE FROM account_user_state WHERE account_id=?").run("alice");
  assert.equal(JSON.parse(compare(both, "deleted row resets to empty state").revision)[1], 0);
  await tick();
  for (const f of both) f.writer.prepare("INSERT INTO account_user_state VALUES(?,?,?)").run("alice", 1, JSON.stringify(payload("reinserted")));
  compare(both, "reinsertion after deletion reloads complete row");
  for (const f of both) f.writer.prepare("INSERT INTO account_user_state VALUES(?,?,?)").run("bob", 1, JSON.stringify(payload("Bob")));
  assert.notDeepEqual(compare(both, "second owner is isolated", "bob").state, both[0].read().state);
  compare(both, "return to first owner");
  const missing = pair({ rows: [] });
  compare(missing, "missing cold account");
  for (const f of missing) assert.equal(f.stats.reads, 1);

  // Native decoding, JSON parsing and revision validation remain observable.
  for (const [label, revision, body] of [
    ["malformed JSON", 1, "not-json"], ["null JSON", 1, "null"], ["array JSON", 1, "[]"],
    ["primitive JSON", 1, "42"], ["missing state sections", 1, "{}"],
    ["array progress section", 1, '{"favoriteFolders":{},"favorites":{},"progress":[]}'],
    ["zero revision", 0, JSON.stringify(payload())], ["negative revision", -1, JSON.stringify(payload())],
    ["float revision", 1.5, JSON.stringify(payload())], ["text revision", "1", JSON.stringify(payload())],
    ["null revision", null, JSON.stringify(payload())], ["unsafe revision", 9223372036854775807n, JSON.stringify(payload())],
    ["unsafe integer body", 1, 9223372036854775807n], ["SQL null body", 1, null],
    ["integer body", 1, 123], ["float body", 1, 1.25], ["JSON-looking BLOB", 1, Buffer.from(JSON.stringify(payload()))],
    ["NUL within JSON", 1, '{"favoriteFolders":{},\0"favorites":{},"progress":{}}']
  ]) {
    const cases = pair({ schema: looseSchema, rows: [["alice", revision, body]] });
    compareErrors(cases, label);
  }
  const nul = pair({ rows: [["alice", 1, `${JSON.stringify(payload("NUL"))}\0ignored suffix`]] });
  compare(nul, "native text NUL truncation remains unchanged");
  const normalizations = pair({ rows: [["alice", 1, JSON.stringify({ ...payload(), progress: {
    valid: { workId: 4, position: 1, duration: 2 }, negative: { position: -1, duration: 2 }, invalid: { position: "1", duration: 2 }
  }, extra: "discarded" })]] });
  assert.deepEqual(Object.keys(compare(normalizations, "normalization and field order").state.progress), ["valid"]);

  for (const body of ["bad JSON", Buffer.from("BLOB"), null, 1.25, "with\0NUL"]) {
    const cases = pair({ schema: looseSchema });
    compare(cases, "seed native type case"); await tick();
    for (const f of cases) f.write(1, body);
    compare(cases, "same revision ignores non-integer body changes");
  }
  const unsafe = pair({ schema: looseSchema });
  compare(unsafe, "seed unsafe body case"); await tick();
  for (const f of unsafe) f.write(1, 9223372036854775807n);
  assert.equal(compareErrors(unsafe, "same revision still raises native unsafe-integer body error").name, "RangeError");
  await tick();
  for (const f of unsafe) f.write(2, JSON.stringify(payload("recovered")));
  compare(unsafe, "native read failure retries and recovers");

  // A version-1 nonstandard provider may be a view; it has the same visible
  // state/revision and native errors without relying on TEXT column affinity.
  const view = pair({ schema: looseSchema });
  for (const f of view) f.writer.exec("ALTER TABLE account_user_state RENAME TO backing; CREATE VIEW account_user_state AS SELECT account_id,revision,state_json FROM backing");
  compare(view, "legacy view cold row"); await tick();
  compare(view, "legacy view unchanged row"); await tick();
  for (const f of view) f.writer.exec("UPDATE backing SET state_json=9223372036854775807");
  compareErrors(view, "legacy view unsafe body is not hidden");

  const changedProvider = pair();
  compare(changedProvider, "ordinary stored provider before external DDL"); await tick();
  for (const f of changedProvider) {
    f.writer.exec("ALTER TABLE account_user_state RENAME TO backing; CREATE VIEW account_user_state AS SELECT account_id,revision,body_value(state_json) AS state_json FROM backing");
    f.evaluations = 0;
    f.connection.function("body_value", body => { f.evaluations++; return body; });
    f.reset();
  }
  compare(changedProvider, "external DDL switches a cached provider to a live view");
  for (const f of changedProvider) {
    assert.equal(f.evaluations, 1, "view expression retains one original evaluation");
    assert.ok(f.stats.bodyBytes > 0, "a view conservatively returns its original body");
  }
  await tick();
  for (const f of changedProvider) {
    f.writer.prepare("UPDATE backing SET revision=2,state_json=?").run(JSON.stringify(payload("view B")));
    f.evaluations = 0; f.reset();
    f.connection.function("body_value", body => {
      if (++f.evaluations > 1) throw new Error("view body must not be evaluated a second time");
      return body;
    });
  }
  compare(changedProvider, "changed-revision view body is decoded from its single full read");
  for (const f of changedProvider) { assert.equal(f.evaluations, 1); assert.equal(f.stats.reads, 1); }

  const generated = pair();
  compare(generated, "stored column before generated-column replacement"); await tick();
  for (const f of generated) {
    f.writer.exec("CREATE TABLE replacement(account_id TEXT PRIMARY KEY,revision,body,state_json GENERATED ALWAYS AS(body) VIRTUAL); INSERT INTO replacement(account_id,revision,body) SELECT account_id,revision,state_json FROM account_user_state; DROP TABLE account_user_state; ALTER TABLE replacement RENAME TO account_user_state");
    f.reset();
  }
  compare(generated, "generated body retains full read after same-revision DDL");
  for (const f of generated) assert.ok(f.stats.bodyBytes > 0);
  await tick();
  for (const f of generated) {
    f.writer.prepare("UPDATE account_user_state SET revision=2,body=?").run(JSON.stringify(payload("generated B")));
    f.reset();
  }
  compare(generated, "changed-revision generated body needs only one original read");
  for (const f of generated) assert.equal(f.stats.reads, 1);

  const shadow = pair();
  compare(shadow, "main provider before uppercase TEMP shadow"); await tick();
  for (const f of shadow) {
    f.connection.exec("CREATE TEMP TABLE ACCOUNT_USER_STATE(account_id TEXT PRIMARY KEY,revision,state_json)");
    f.connection.prepare("INSERT INTO temp.ACCOUNT_USER_STATE VALUES(?,?,?)").run("alice", 1, JSON.stringify(payload("ignored TEMP")));
    f.reset();
  }
  compare(shadow, "uppercase TEMP shadow preserves unchanged-revision ignore");
  for (const f of shadow) assert.ok(f.stats.bodyBytes > 0, "TEMP shadow must not borrow main storage qualification");
  await tick();
  for (const f of shadow) { f.connection.prepare("UPDATE temp.ACCOUNT_USER_STATE SET revision=2,state_json=?").run(JSON.stringify(payload("TEMP"))); f.reset(); }
  assert.equal(compare(shadow, "TEMP shadow changed revision reloads its own row").state.favoriteFolders.synthetic.name, "Folder TEMP");
  for (const f of shadow) assert.equal(f.stats.reads, 1, "TEMP fallback already returned the complete body");
  await tick();
  for (const f of shadow) f.connection.exec("DROP TABLE temp.ACCOUNT_USER_STATE");
  assert.equal(compare(shadow, "dropping TEMP shadow returns to main row").state.favoriteFolders.synthetic.name, "Folder A");

  // These ordinary names once shadowed the pragma TVFs used by an intermediate
  // implementation. They must be completely unrelated to account reads now,
  // including fake metadata columns that could otherwise spoof eligibility.
  for (const scope of ["main", "temp"]) for (const fakeColumns of [false, true]) {
    const cases = pair(); compare(cases, `${scope} pragma shadow seed`); await tick();
    for (const f of cases) f.reset();
    compare(cases, `${scope} pragma shadow baseline`);
    const unshadowed = cases.map(f => ({ ...f.stats }));
    await tick();
    for (const f of cases) {
      const db = scope === "main" ? f.writer : f.connection;
      if (fakeColumns) db.exec(`
        CREATE TABLE ${scope}.pragma_table_list(schema TEXT,name TEXT,type TEXT);
        INSERT INTO ${scope}.pragma_table_list VALUES('main','account_user_state','table');
        CREATE TABLE ${scope}.pragma_table_xinfo(name TEXT,hidden INTEGER);
        INSERT INTO ${scope}.pragma_table_xinfo VALUES('state_json',0);
      `);
      else db.exec(`CREATE TABLE ${scope}.pragma_table_list(unrelated TEXT); CREATE TABLE ${scope}.pragma_table_xinfo(unrelated TEXT);`);
      f.reset();
    }
    compare(cases, `${scope} pragma shadow ${fakeColumns ? "fake" : "missing"} metadata columns`);
    for (let index = 0; index < cases.length; index++) assert.deepEqual(cases[index].stats, unshadowed[index], "unrelated metadata names cannot change account reads or returned body bytes");
    metadataShadowCases++;
  }

  const oldCreated = [fixture(beforeFactory), fixture(currentFactory, { initializer: beforeFactory })];
  compare(oldCreated, "current owner opens a database initialized by the frozen old owner");
  assert.equal(oldCreated[1].writer.prepare("SELECT sql FROM main.sqlite_schema WHERE name='account_user_state'").get().sql, initializedDdl[0]);
  await tick();
  for (const f of oldCreated) f.reset();
  compare(oldCreated, "frozen-old-created canonical database supports the warm read");
  const oldCreatedWarm = { ...oldCreated[1].stats };

  for (const phase of ["prepare", "get"]) {
    const cases = pair(); compare(cases, `seed ${phase} fault`); await tick();
    for (const f of cases) f.fail = where => { if (where === phase) { f.fail = null; throw Object.assign(new Error(`controlled ${phase} failure`), { code: "SQLITE_BUSY" }); } };
    compareErrors(cases, `${phase} failure propagates`);
    compare(cases, `${phase} failure does not poison next retry`);
  }

  for (const [label, revision, body] of [
    ["changed-revision malformed body", 2, "not-json"],
    ["changed invalid revision", 0, JSON.stringify(payload("invalid revision"))]
  ]) {
    const cases = pair({ schema: looseSchema }); compare(cases, `${label}: seeded complete state`);
    const references = cases.map(f => f.reference()), committed = references.map(value => JSON.stringify(value));
    await tick();
    for (const f of cases) f.write(revision, body);
    compareErrors(cases, `${label}: exact frozen-owner error`);
    for (let index = 0; index < cases.length; index++) {
      assert.equal(JSON.stringify(references[index]), committed[index], `${label}: failed reload must not mutate exposed state`);
      cases[index].write(3, JSON.stringify(payload("repaired")));
    }
    assert.equal(compare(cases, `${label}: repaired row reloads on retry`).state.favoriteFolders.synthetic.name, "Folder repaired");
    for (let index = 0; index < cases.length; index++) assert.equal(cases[index].reference(), references[index]);
  }

  for (const phase of ["prepare", "get"]) {
    const f = fixture(currentFactory); f.read();
    const reference = f.reference(), committed = JSON.stringify(reference);
    await tick(); f.write(2, JSON.stringify(payload(`full ${phase} recovery`)));
    let faults = 0;
    f.fail = (where, sql) => {
      if (where === phase && sql === FULL) {
        faults++; f.fail = null;
        throw Object.assign(new Error(`controlled second full-read ${phase} failure`), { code: "SQLITE_BUSY" });
      }
    };
    assert.deepEqual(errorOf(f), { name: "Error", message: `controlled second full-read ${phase} failure`, code: "SQLITE_BUSY" });
    assert.equal(faults, 1, "the injected failure belongs to the complete second read, after the successful warm probe");
    assert.equal(JSON.stringify(reference), committed, "failed complete reload must not mutate the cached state object");
    const recovered = f.read();
    assert.equal(JSON.parse(recovered.revision)[1], 2);
    assert.equal(recovered.state.favoriteFolders.synthetic.name, `Folder full ${phase} recovery`);
    assert.equal(f.reference(), reference);
    fullReadFailures++;
  }

  // Different revisions require a second read. Inject an independent committed
  // write after native probe.get(), not a fabricated row: decode the second full
  // row's revision together with its body, even if the database changes again.
  for (const [label, finish] of [
    ["newer full row", f => f.write(3, JSON.stringify(payload("C")))],
    ["deleted full row", f => f.writer.exec("DELETE FROM account_user_state")],
    ["returned original revision", f => f.write(1, JSON.stringify(payload("ignored original revision")))]
  ]) {
    const f = fixture(currentFactory); f.read(); await tick();
    f.write(2, JSON.stringify(payload("B"))); f.reset();
    f.afterRead = () => { f.afterRead = null; finish(f); };
    const read = f.read(), revision = JSON.parse(read.revision)[1];
    assert.equal(f.stats.reads, 2, `${label}: probe then complete native row`);
    if (label === "newer full row") { assert.equal(revision, 3); assert.equal(read.state.favoriteFolders.synthetic.name, "Folder C"); }
    else if (label === "deleted full row") { assert.equal(revision, 0); assert.deepEqual(read.state.progress, {}); }
    else { assert.equal(revision, 1); assert.equal(read.state.favoriteFolders.synthetic.name, "Folder A"); }
    raceCases++;
    await tick();
    assert.deepEqual(f.read(), read, `${label}: next turn is consistent with the accepted full row`);
  }

  const large = JSON.stringify(payload("large", 10000));
  const scale = pair({ rows: [["alice", 1, large]] });
  const complete = compare(scale, "10k progress complete cold state");
  for (const f of scale) { assert.equal(f.stats.full, 1); assert.equal(f.stats.bodyBytes, Buffer.byteLength(large)); f.reset(); }
  const stateRefs = scale.map(f => f.reference());
  for (let turn = 0; turn < 32; turn++) {
    await tick();
    for (let index = 0; index < scale.length; index++) {
      const f = scale[index];
      f.run("alice", () => { assert.equal(f.service.state(), stateRefs[index]); assert.equal(f.service.revision(), complete.revision); });
    }
  }
  assert.equal(JSON.stringify(stateRefs[1]), JSON.stringify(complete.state), "warm reads return the complete unchanged state");
  console.log(JSON.stringify({ contractsPassed: true, completeDtoAndWireComparisons: comparisons, errorComparisons, raceCases, fullReadFailures,
    metadataShadowCases, initializedDdlUnchanged: true, oldCreatedWarm,
    progressRows: 10000, turns: 32, nativeReturnedBodyBytes: { before: scale[0].stats.bodyBytes, current: scale[1].stats.bodyBytes },
    reads: { before: scale[0].stats, current: scale[1].stats }, negativeControl: negative }));
  assert.equal(scale[0].stats.reads, 32);
  assert.equal(scale[0].stats.bodyBytes, Buffer.byteLength(large) * 32);
  assert.equal(scale[1].stats.bodyBytes, 0, "unchanged warm revision must not copy the persisted state body");
  assert.equal(scale[1].stats.narrow, 32, "each fresh microtask checks the native revision once");
  assert.equal(scale[1].stats.full, 0, "unchanged warm revisions must not reload full rows");
  assert.equal(scale[1].stats.reads, 32);
  assert.equal(oldCreatedWarm.reads, 1);
  assert.equal(oldCreatedWarm.bodyBytes, 0, "the frozen old initializer's actual table must qualify for body omission");
  console.log("Account revision reads passed: complete state/error contracts, real WAL races and native body-copy budget.");
} finally {
  DatabaseSync.prototype.prepare = originalPrepare;
  statementPrototype.get = originalGet;
  for (const f of fixtures) { f.service.close(); f.writer.close(); }
  temp.cleanup();
}
