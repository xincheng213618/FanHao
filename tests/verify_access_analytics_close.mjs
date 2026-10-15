import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createAccessAnalyticsService } from "../src/modules/system/server/access-analytics-service.js";

// Actual service and native in-memory SQLite; no logs, library or live server.
const args = process.argv.slice(2);
assert.ok(args.every(value => ["--legacy-close", "--concurrent-only"].includes(value)));
let createService = createAccessAnalyticsService;
if (args.includes("--legacy-close")) {
  const url = new URL("../src/modules/system/server/access-analytics-service.js", import.meta.url);
  const source = fs.readFileSync(url, "utf8");
  const start = source.indexOf("  async function close() {");
  const end = source.indexOf("\n  return { attach,", start);
  assert.ok(start > 0 && end > start);
  const previous = source.slice(0, start) + `  async function close() {
    if (closed) return;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    await queueFlush();
    closed = true;
    ipRegionService.close?.();
    db.close();
    db = null;
  }
` + source.slice(end);
  createService = (await import(`data:text/javascript;base64,${Buffer.from(previous).toString("base64")}`)).createAccessAnalyticsService;
}
const RealDate = globalThis.Date;
globalThis.Date = class extends RealDate {
  constructor(...values) { super(...(values.length ? values : ["2026-10-13T04:00:00.000Z"])); }
  static now() { return RealDate.parse("2026-10-13T04:00:00.000Z"); }
};
const owners = [], warnings = [], warn = console.warn;
console.warn = (...values) => warnings.push(values);
let comparisons = 0, cases = 0;
try {
  if (!args.includes("--concurrent-only")) {
    for (const flushAlreadyRunning of [false, true]) {
      const first = gate(), second = gate();
      const target = fixture(async ip => {
        const held = ip.endsWith(".1") ? first : ip.endsWith(".2") ? second : null;
        if (held) { held.started.resolve(); await held.released.promise; }
        return geo(ip);
      });
      const expected = fixture();
      record(target, 1); record(expected, 1);
      const flushing = flushAlreadyRunning ? target.service.flush() : null;
      const closing = target.service.close();
      await first.started.promise;
      record(target, 2); record(expected, 2);
      first.released.resolve();
      assert.equal(await Promise.race([second.started.promise.then(() => true), closing.then(() => false)]), true,
        "shutdown must drain the records accepted while its first flush was pending");
      record(target, 3); record(expected, 3);
      second.released.resolve();
      await Promise.all([closing, flushing]); await expected.service.close();
      assert.deepEqual(target.snapshot, expected.snapshot, "shutdown must persist every record accepted during an in-flight flush"); comparisons++;
      assert.equal(target.snapshot.daily.reduce((sum, row) => sum + row.request_count, 0), 3);
      assert.equal(target.dbCloses, 1); assert.equal(target.geoCloses, 1);
      assert.equal(target.lookups, 3);
      await target.service.close(); record(target, 4);
      assert.equal(target.dbCloses, 1); assert.equal(target.lookups, 3);
      cases++;
    }
  }
  for (const withRecord of [false, true]) {
    const held = gate();
    const target = fixture(async ip => { held.started.resolve(); await held.released.promise; return geo(ip); });
    const expected = fixture();
    if (withRecord) { record(target, 1); record(expected, 1); }
    const closing = [target.service.close(), target.service.close(), target.service.close()];
    if (withRecord) await held.started.promise;
    held.released.resolve();
    const results = await Promise.allSettled(closing);
    assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled", "fulfilled"], "concurrent shutdown shares one successful resource close");
    await expected.service.close();
    assert.deepEqual(target.snapshot, expected.snapshot); comparisons++;
    assert.equal(target.dbCloses, 1); assert.equal(target.geoCloses, 1);
    assert.equal(target.db.isOpen, false); cases++;
  }
  if (!args.includes("--concurrent-only")) {
    for (const failure of ["lookup", "lookup-empty", "write"]) {
      const failureError = failure === "lookup-empty" ? undefined : new Error("controlled lookup failure");
      let failLookup = failure.startsWith("lookup");
      const target = fixture(async ip => { if (failLookup) throw failureError; return geo(ip); });
      const expected = fixture();
      if (failure === "write") target.db.exec("CREATE TRIGGER fixture_write_failure BEFORE INSERT ON access_daily BEGIN SELECT RAISE(ABORT, 'controlled access write failure'); END;");
      record(target, 1); record(expected, 1);
      const results = await Promise.allSettled([target.service.close(), target.service.close()]);
      assert.deepEqual(results.map(result => result.status), ["rejected", "rejected"], "a failed flush cannot report completed shutdown");
      assert.equal(results[0].reason, results[1].reason);
      assert.equal(target.lookups, 1, "a failed shutdown flush must not loop indefinitely");
      assert.equal(target.db.isOpen, true); assert.equal(target.dbCloses, 0); assert.equal(target.geoCloses, 0);
      assert.equal(target.db.prepare("SELECT COUNT(*) AS n FROM access_daily").get().n, 0);
      assert.equal(target.db.prepare("SELECT COUNT(*) AS n FROM access_ip_geo").get().n, 0, "failed writes retain transaction atomicity");
      if (failure.startsWith("lookup")) failLookup = false;
      else target.db.exec("DROP TRIGGER fixture_write_failure");
      await target.service.close(); await expected.service.close();
      assert.deepEqual(target.snapshot, expected.snapshot, "explicit shutdown retry preserves all pending counters without duplicates"); comparisons++;
      assert.equal(target.dbCloses, 1); assert.equal(target.geoCloses, 1); cases++;
    }
    for (const flags of [{ geo: true }, { db: "before" }, { geo: true, db: "before" }, { db: "after" }]) {
      const target = fixture(undefined, flags), expected = fixture();
      record(target, 1); record(expected, 1);
      const results = await Promise.allSettled([target.service.close(), target.service.close()]);
      assert.deepEqual(results.map(result => result.status), ["rejected", "rejected"]);
      assert.equal(results[0].reason, results[1].reason);
      if (flags.geo && flags.db) assert.deepEqual(results[0].reason.errors, [target.geoError, target.dbError]);
      else assert.equal(results[0].reason, flags.geo ? target.geoError : target.dbError);
      assert.equal(target.geoCloses, 1); assert.equal(target.dbCloses, 1, "a failed geo closer cannot skip the DB closer");
      assert.equal(target.db.isOpen, flags.db === "before");
      record(target, 2); // Admission is closed after the successful final flush.
      await target.service.close(); await expected.service.close();
      assert.deepEqual(target.snapshot, expected.snapshot, "cleanup retries preserve the fully committed counters"); comparisons++;
      assert.equal(target.dbCloses, flags.db === "before" ? 2 : 1);
      assert.equal(target.geoCloses, flags.geo ? 2 : 1);
      await target.service.close();
      assert.equal(target.dbCloses, flags.db === "before" ? 2 : 1, "retry only resources that did not close");
      assert.equal(target.geoCloses, flags.geo ? 2 : 1); cases++;
    }
  }
  console.log(JSON.stringify({ ok: true, cases, completeDatabaseComparisons: comparisons,
    recordsDuringFlushPreserved: true, concurrentCloseOnce: true, failureRetryAndRollback: !args.includes("--concurrent-only") }));
} finally {
  globalThis.Date = RealDate; console.warn = warn;
  for (const owner of owners) if (owner.db.isOpen) await owner.service.close();
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function gate() { return { started: deferred(), released: deferred() }; }
function geo(ip) { return { country: "Fixture", province: "Synthetic " + ip, city: "Private", isp: "Fixture", located: true, ipVersion: 4 }; }
function fixture(lookup = async ip => geo(ip), flags = {}) {
  const db = new DatabaseSync(":memory:");
  const target = { db, snapshot: null, dbCloses: 0, geoCloses: 0, lookups: 0,
    geoError: new Error("controlled geo close failure"), dbError: new Error("controlled DB close failure"),
    failGeo: flags.geo, failDb: flags.db };
  const close = db.close.bind(db);
  db.close = () => {
    target.dbCloses++;
    target.snapshot = {
      daily: db.prepare("SELECT * FROM access_daily ORDER BY day, ip, auth_reason, access_mode").all(),
      geo: db.prepare("SELECT * FROM access_ip_geo ORDER BY ip").all()
    };
    if (target.failDb === "before") { target.failDb = null; throw target.dbError; }
    close();
    if (target.failDb === "after") { target.failDb = null; throw target.dbError; }
  };
  target.service = createService({ dbPath: ":memory:", createDatabase: () => db, flushIntervalMs: 60_000,
    ipRegionService: {
      lookup: async ip => { target.lookups++; return lookup(ip); },
      close: () => { target.geoCloses++; if (target.failGeo) { target.failGeo = false; throw target.geoError; } },
      status: () => ({ ready: true })
    } });
  owners.push(target); return target;
}
function record(target, index) {
  target.service.record({ method: "GET", headers: { accept: index === 1 ? "text/html" : "application/json", "user-agent": "Synthetic fixture" } },
    { statusCode: index === 2 ? 401 : 200, getHeader: () => index * 10 }, new URL(`http://fixture/${index === 1 ? "page" : "api/test"}`),
    { access: { clientAddress: `192.0.2.${index}`, mode: "fixture" }, reason: index === 2 ? "missing-password" : "password" });
}
