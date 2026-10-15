import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { createAccessAnalyticsService } from "../src/modules/system/server/access-analytics-service.js";
import { createIpRegionService, parseIp2Region } from "../src/modules/system/server/ip-region-service.js";
import { routeAdminApi } from "../src/modules/system/server/admin/routes.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_STATS_PAYLOAD = `  async function statsPayload(url) {
    await queueFlush();
    const filters = parseFilters(url);
    const { where, params } = buildWhere(filters);
    const source = \`FROM access_daily d LEFT JOIN access_ip_geo g ON g.ip = d.ip \${where}\`;
    const summaryRow = db.prepare(\`
      SELECT
        COUNT(DISTINCT d.ip) AS unique_ips,
        COALESCE(SUM(d.request_count), 0) AS requests,
        COALESCE(SUM(d.page_view_count), 0) AS page_views,
        COALESCE(SUM(d.denied_count), 0) AS denied_requests,
        COALESCE(SUM(d.error_count), 0) AS error_requests,
        COALESCE(SUM(CASE WHEN d.auth_reason = 'missing-password' THEN d.request_count ELSE 0 END), 0) AS missing_password_requests,
        COALESCE(SUM(CASE WHEN d.auth_reason = 'password' THEN d.request_count ELSE 0 END), 0) AS password_requests,
        COALESCE(SUM(CASE WHEN d.auth_reason = 'trusted-network' THEN d.request_count ELSE 0 END), 0) AS trusted_network_requests,
        COALESCE(SUM(CASE WHEN d.auth_reason IN ('app', 'app-cookie') THEN d.request_count ELSE 0 END), 0) AS injected_requests,
        MIN(d.first_seen) AS first_seen,
        MAX(d.last_seen) AS last_seen
      \${source}
    \`).get(...params) || {};

    const auth = db.prepare(\`
      SELECT d.auth_reason AS reason, COUNT(DISTINCT d.ip) AS unique_ips,
        SUM(d.request_count) AS requests, SUM(d.page_view_count) AS page_views,
        SUM(d.denied_count) AS denied_requests
      \${source}
      GROUP BY d.auth_reason
      ORDER BY requests DESC
    \`).all(...params).map(publicAggregateRow);

    const provinces = db.prepare(\`
      SELECT COALESCE(NULLIF(g.province, ''), '\${UNKNOWN}') AS province,
        COUNT(DISTINCT d.ip) AS unique_ips, SUM(d.request_count) AS requests,
        SUM(d.page_view_count) AS page_views
      \${source}
      GROUP BY COALESCE(NULLIF(g.province, ''), '\${UNKNOWN}')
      ORDER BY requests DESC, province
      LIMIT 20
    \`).all(...params).map(publicAggregateRow);

    const daily = db.prepare(\`
      SELECT d.day, COUNT(DISTINCT d.ip) AS unique_ips,
        SUM(d.request_count) AS requests, SUM(d.page_view_count) AS page_views,
        SUM(d.denied_count) AS denied_requests
      \${source}
      GROUP BY d.day
      ORDER BY d.day
    \`).all(...params).map(publicAggregateRow);

    const groupColumns = "d.ip, d.auth_reason, d.access_mode";
    const total = publicNumber(db.prepare(\`SELECT COUNT(*) AS count FROM (SELECT 1 \${source} GROUP BY \${groupColumns})\`).get(...params)?.count);
    const visitors = db.prepare(\`
      SELECT d.ip, d.auth_reason, d.access_mode,
        COALESCE(NULLIF(g.country, ''), '\${UNKNOWN}') AS country,
        COALESCE(NULLIF(g.province, ''), '\${UNKNOWN}') AS province,
        COALESCE(NULLIF(g.city, ''), '\${UNKNOWN}') AS city,
        COALESCE(NULLIF(g.isp, ''), '\${UNKNOWN}') AS isp,
        MAX(COALESCE(g.located, 0)) AS located,
        SUM(d.request_count) AS requests,
        SUM(d.page_view_count) AS page_views,
        SUM(d.api_count) AS api_requests,
        SUM(d.media_count) AS media_requests,
        SUM(d.denied_count) AS denied_requests,
        SUM(d.error_count) AS error_requests,
        SUM(d.response_bytes) AS response_bytes,
        MIN(d.first_seen) AS first_seen,
        MAX(d.last_seen) AS last_seen,
        MAX(d.last_path) AS last_path,
        MAX(d.user_agent) AS user_agent
      \${source}
      GROUP BY \${groupColumns}
      ORDER BY requests DESC, last_seen DESC
      LIMIT ? OFFSET ?
    \`).all(...params, filters.limit, filters.offset).map((row) => ({
      ...row,
      located: Boolean(row.located),
      requests: publicNumber(row.requests),
      pageViews: publicNumber(row.page_views),
      apiRequests: publicNumber(row.api_requests),
      mediaRequests: publicNumber(row.media_requests),
      deniedRequests: publicNumber(row.denied_requests),
      errorRequests: publicNumber(row.error_requests),
      responseBytes: publicNumber(row.response_bytes),
      authReason: row.auth_reason,
      accessMode: row.access_mode,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      lastPath: row.last_path,
      userAgent: row.user_agent
    }));

    const optionFilters = { ...filters, province: "", query: "" };
    const optionWhere = buildWhere(optionFilters);
    const provinceOptions = db.prepare(\`
      SELECT DISTINCT COALESCE(NULLIF(g.province, ''), '\${UNKNOWN}') AS province
      FROM access_daily d LEFT JOIN access_ip_geo g ON g.ip = d.ip
      \${optionWhere.where}
      ORDER BY province
    \`).all(...optionWhere.params).map((row) => row.province);

    return {
      generatedAt: new Date().toISOString(),
      filters,
      geo: ipRegionService.status(),
      summary: {
        uniqueIps: publicNumber(summaryRow.unique_ips),
        requests: publicNumber(summaryRow.requests),
        pageViews: publicNumber(summaryRow.page_views),
        deniedRequests: publicNumber(summaryRow.denied_requests),
        errorRequests: publicNumber(summaryRow.error_requests),
        missingPasswordRequests: publicNumber(summaryRow.missing_password_requests),
        passwordRequests: publicNumber(summaryRow.password_requests),
        trustedNetworkRequests: publicNumber(summaryRow.trusted_network_requests),
        injectedRequests: publicNumber(summaryRow.injected_requests),
        firstSeen: summaryRow.first_seen || "",
        lastSeen: summaryRow.last_seen || ""
      },
      auth,
      provinces,
      provinceOptions,
      daily,
      visitors,
      pagination: { total, limit: filters.limit, offset: filters.offset }
    };
  }`;


// The complete function before IP de-duplication, retaining the preceding
// conditional aggregate joins. It is derived only from the fixed old oracle.
const PRE_IP_OPTIONS_STATS_PAYLOAD = LEGACY_STATS_PAYLOAD
  .replace("    const summaryRow =", "    const aggregateSource = filters.province || filters.query ? source : \x60FROM access_daily d ${where}\x60;\n    const summaryRow =")
  .replace("      ${source}\n    \x60).get", "      ${aggregateSource}\n    \x60).get")
  .replace("      ${source}\n      GROUP BY d.auth_reason", "      ${aggregateSource}\n      GROUP BY d.auth_reason")
  .replace("      ${source}\n      GROUP BY d.day", "      ${aggregateSource}\n      GROUP BY d.day")
  .replace("(SELECT 1 ${source} GROUP BY ${groupColumns})", "(SELECT 1 ${aggregateSource} GROUP BY ${groupColumns})");

assert.ok(process.argv.slice(2).every((argument) =>
  argument === "--legacy-geo-joins" || argument === "--legacy-ip-options"), "known verification arguments");

function statsFunctionSource(source) {
  const start = source.indexOf("  async function statsPayload(url) {");
  const end = source.indexOf("\n  async function close()", start);
  assert.ok(start >= 0 && end > start, "locate the complete stats function");
  return source.slice(start, end).trimEnd();
}

function createStatsProbe(factory, configureSchema) {
  const db = new DatabaseSync(":memory:");
  let measuring = false;
  let probing = false;
  let lookupCount = 0;
  let calls = [];
  db.function("probe_geo", (ip) => {
    lookupCount += 1;
    return ip;
  });
  const observedDb = {
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    prepare(sql) {
      const executionSql = probing ? sql.replaceAll("g.ip = d.ip", "g.ip = probe_geo(d.ip)") : sql;
      const statement = db.prepare(executionSql);
      return new Proxy(statement, {
        get(target, key) {
          if (key === "get" || key === "all") return (...args) => {
            const before = lookupCount;
            const start = performance.now();
            const result = target[key](...args);
            if (measuring) calls.push({
              sql, executionSql, args, method: key,
              lookups: lookupCount - before, ms: performance.now() - start
            });
            return result;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        }
      });
    }
  };
  let service;
  try {
    configureSchema?.(db);
    service = factory({
      dbPath: ":memory:",
      createDatabase: () => observedDb,
      ipRegionService: {
        lookup: async () => ({
          country: "synthetic-country", province: "Lookup-Province", city: "Lookup-City",
          isp: "synthetic-isp", located: true
        }),
        status: () => ({ ready: true, database: "synthetic" }),
        close() {}
      },
      flushIntervalMs: 60_000
    });
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    db, service,
    reset(probe = false) { measuring = true; probing = probe; lookupCount = 0; calls = []; },
    snapshot() { measuring = false; return { lookupCount, calls }; }
  };
}

function analyticsDay(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0")
    + "-" + String(date.getDate()).padStart(2, "0");
}

function seedStatsRows(fixture, dense) {
  const { db } = fixture;
  const today = new Date();
  const geoInsert = db.prepare("INSERT INTO access_ip_geo(ip,country,province,city,isp,iso_code,located,ip_version,lookup_error,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
  const dailyInsert = db.prepare("INSERT INTO access_daily(day,ip,auth_reason,access_mode,request_count,page_view_count,api_count,media_count,denied_count,error_count,response_bytes,first_seen,last_seen,last_path,user_agent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  try {
    if (dense) {
      for (let p = 0; p < 5_000; p++) geoInsert.run(
        "synthetic-" + String(p).padStart(5, "0"), "synthetic-country",
        p % 29 === 0 ? "" : "Province-" + (p % 31), "City-" + (p % 50),
        "ISP-" + (p % 3), "XX", p % 7 === 0 ? 0 : 1, 4, "", today.toISOString()
      );
      for (let d = 0; d < 20; d++) {
        const date = new Date(today);
        date.setDate(today.getDate() - d);
        const day = analyticsDay(date);
        for (let p = 0; p < 5_000; p++) {
          const timestamp = day + "T12:" + String(p % 60).padStart(2, "0") + ":00.000Z";
          dailyInsert.run(
            day, "synthetic-" + String(p).padStart(5, "0"),
            ["password", "app", "missing-password", "app-cookie", "unknown"][(p + d) % 5],
            ["remote", "local", "lan"][(p + d) % 3],
            1 + p % 97, p % 2, p % 5, p % 7, p % 13 === 0 ? 1 : 0, p % 17 === 0 ? 1 : 0,
            100 + p % 10_000, timestamp, timestamp, "/synthetic/" + (p % 25), "synthetic-agent-" + (p % 12)
          );
        }
      }
    } else {
      const ips = ["synthetic-a", "synthetic-%", "synthetic-_", "synthetic-\\", "synthetic-空间",
        "synthetic-empty-geo", "synthetic-orphan", "", "synthetic-tie-1", "synthetic-tie-2"];
      for (let p = 0; p < ips.length; p++) {
        if (p === 6) continue;
        geoInsert.run(ips[p], p % 3 ? "synthetic-country" : "",
          p % 3 === 0 ? "" : p % 3 === 1 ? "Province-%" : "Province-_",
          p % 2 ? "City-空间" : "City-\\", "ISP-" + (p % 3), "XX", p % 2, 4, "", today.toISOString());
      }
      // SQLite permits multiple NULL TEXT primary keys; none can match the non-NULL daily IP.
      geoInsert.run(null, "null-geo-one", "synthetic-ignored", "", "", "XX", 0, 4, "", today.toISOString());
      geoInsert.run(null, "null-geo-two", "synthetic-ignored", "", "", "XX", 0, 4, "", today.toISOString());
      for (let d = 0; d < 6; d++) {
        const date = new Date(today);
        date.setDate(today.getDate() - d);
        const day = analyticsDay(date);
        for (let p = 0; p < ips.length; p++) {
          const timestamp = p % 5 === 0 ? "" : day + "T12:00:00.000Z";
          dailyInsert.run(day, ips[p],
            ["password", "app", "missing-password", "app-cookie", "unknown", "trusted-network"][(p + d) % 6],
            ["remote", "local", "lan", "unknown", ""][(p + d) % 5],
            p % 4 === 0 ? 0 : 1, p % 2, p % 5, p % 7, p % 3 === 0 ? 1 : 0,
            p % 4 === 0 ? 1 : 0, p % 2 === 0 ? 0 : 128, timestamp, timestamp,
            "/synthetic/%_" + p, "synthetic-agent-" + (p % 3));
        }
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function verifyProvinceOptionCompatibility(activeFactory, previousFactory, source) {
  const schemaSql = source.slice(source.indexOf("function initializeSchema(db)"), source.indexOf("function createStatements(db)"))
    .match(/db\.exec\(\x60([\s\S]*?)\x60\);/)?.[1].replaceAll("${UNKNOWN}", "未知");
  assert.ok(schemaSql, "use the actual owner's complete schema initializer");
  const cases = [
    { name: "binary", ip: "TEXT NOT NULL", values: [["A", "P-uppercase"], ["a", "P-lowercase"], ["A ", "P-space"], ["A", "P-uppercase"], ["", ""], ["missing", undefined]] },
    { name: "nocase", ip: "TEXT COLLATE NOCASE NOT NULL", values: [["A", "P-uppercase"], ["a", "P-lowercase"], ["A", "P-uppercase"]], options: ["P-lowercase", "P-uppercase"] },
    { name: "rtrim", ip: "TEXT COLLATE RTRIM NOT NULL", values: [["A", "P-uppercase"], ["A ", "P-space"], ["A", "P-uppercase"]], options: ["P-space", "P-uppercase"] },
    { name: "nullable", ip: "TEXT", province: "TEXT DEFAULT '未知'", values: [[null, undefined], [null, undefined], ["", ""], ["unknown", undefined], ["null-province", null]] },
    { name: "blob-storage", ip: "BLOB", mixedNumeric: true },
    { name: "none-storage", ip: "", mixedNumeric: true },
    { name: "geo-nocase", ip: "TEXT NOT NULL", geoIp: "TEXT COLLATE NOCASE", province: "TEXT COLLATE NOCASE NOT NULL DEFAULT '未知'", values: [["A", "Prov-A"], ["a", undefined], ["A", "Prov-A"], ["Z", "prov-a"]] },
    { name: "geo-rtrim", ip: "TEXT COLLATE NOCASE", geoIp: "TEXT COLLATE RTRIM", province: "TEXT DEFAULT '未知'", values: [["A", "AProvince"], ["A ", undefined], ["a", "OtherProvince"], ["missing", undefined], [null, undefined]] },
    { name: "blob-values", ip: "BLOB", province: "BLOB DEFAULT '未知'", values: [[Buffer.from("x"), "Blob-ip"], ["x", "String-ip"], [Buffer.from("y"), Buffer.from("Blob-province")], ["y", 0]] },
    { name: "numeric-daily", ip: "NUMERIC", province: "TEXT DEFAULT '未知'", values: [["1", "Numeric"], ["01", undefined], ["1.0", undefined], ["abc", "String"], [null, undefined]] },
    { name: "numeric-geo", ip: "TEXT", geoIp: "NUMERIC", province: "TEXT DEFAULT '未知'", values: [["1", "Numeric"], ["01", undefined], ["1.0", undefined], ["abc", "String"]] },
    { name: "integer-daily", ip: "INTEGER", geoIp: "BLOB", province: "TEXT DEFAULT '未知'", values: [[1, "integer"], ["abc", "String"], [null, undefined]] }
  ];
  let comparisons = 0;
  for (const scenario of cases) {
    const fixtures = [];
    try {
      const legacySchema = schemaSql
        .replace("      ip TEXT NOT NULL,", "      ip " + scenario.ip + ",")
        .replace("      ip TEXT PRIMARY KEY,", "      ip " + (scenario.geoIp || "TEXT") + " PRIMARY KEY,")
        .replace("      province TEXT NOT NULL DEFAULT '未知',", "      province " + (scenario.province || "TEXT NOT NULL DEFAULT '未知'") + ",");
      for (const factory of [activeFactory, previousFactory]) {
        const fixture = createStatsProbe(factory, (db) => db.exec(legacySchema));
        fixtures.push(fixture);
        if (scenario.mixedNumeric) {
          fixture.db.exec(`
            INSERT INTO access_ip_geo(ip,province,updated_at)
            VALUES('1','Integer-Province','2026'),('1.0','Real-Province','2026');
            INSERT INTO access_daily(day,ip,auth_reason,access_mode,first_seen,last_seen)
            VALUES('2026-10-01',1,'password','remote','2026','2026'),
                  ('2026-10-02',1.0,'password','remote','2026','2026');
          `);
          assert.deepEqual(fixture.db.prepare("SELECT typeof(ip) AS kind FROM access_daily ORDER BY day").all().map(row => row.kind),
            ["integer", "real"], "the legacy fixture retains both numeric storage classes");
        } else {
          const geoInsert = fixture.db.prepare("INSERT INTO access_ip_geo(ip,province,updated_at) VALUES(?,?,'2026')");
          const dailyInsert = fixture.db.prepare("INSERT INTO access_daily(day,ip,auth_reason,access_mode,request_count,first_seen,last_seen) VALUES(?,?,'password','remote',1,?,?)");
          const seen = new Set();
          scenario.values.forEach(([ip, province], index) => {
            if (province !== undefined && !seen.has(ip)) { geoInsert.run(ip, province); seen.add(ip); }
            const day = "2026-10-" + String(index + 1).padStart(2, "0");
            dailyInsert.run(day, ip, day, day);
          });
        }
      }
      const url = (query) => new URL("http://fixture.invalid/api/admin/access-stats?days=30&access=all&" + query);
      async function compare(query) {
        const values = await Promise.all(fixtures.map(fixture => fixture.service.statsPayload(url(query))));
        assert.deepEqual(values[0], values[1], scenario.name + ": " + query);
        assert.equal(JSON.stringify(values[0]), JSON.stringify(values[1]), scenario.name + ": complete ordered JSON");
        comparisons += 1;
        return values[0];
      }
      const baseline = await compare("");
      if (scenario.options) assert.deepEqual(baseline.provinceOptions, scenario.options, "keep both original province spellings");
      for (const query of ["days=1", "auth=password", "auth=none", "access=remote", "access=none",
        "q=x", "province=未知&q=%25", "limit=1&offset=1"]) await compare(query);
      for (const fixture of fixtures) {
        const originalPrepare = fixture.db.prepare;
        const sentinel = new Error("private province-option prepare sentinel");
        fixture.db.prepare = function (sql, ...args) {
          if (sql.includes("SELECT DISTINCT COALESCE(NULLIF(g.province")) throw sentinel;
          return originalPrepare.call(this, sql, ...args);
        };
        try { await assert.rejects(fixture.service.statsPayload(url("")), error => error === sentinel); }
        finally { fixture.db.prepare = originalPrepare; }
      }
      await compare("");
    } finally {
      const closed = await Promise.allSettled(fixtures.map(fixture => fixture.service.close()));
      const failure = closed.find(result => result.status === "rejected");
      if (failure) throw failure.reason;
      for (const fixture of fixtures) assert.equal(fixture.db.isOpen, false, "private owner closes its SQLite handle");
    }
  }
  return comparisons;
}

async function verifyStatsGeoJoins() {
  const sourcePath = path.join(projectRoot, "src/modules/system/server/access-analytics-service.js");
  const source = fs.readFileSync(sourcePath, "utf8").replaceAll("\r\n", "\n");
  const currentStats = statsFunctionSource(source);
  const legacySource = source.replace(currentStats, LEGACY_STATS_PAYLOAD);
  assert.equal(statsFunctionSource(legacySource), LEGACY_STATS_PAYLOAD, "restore the whole old stats function");
  const { createAccessAnalyticsService: legacyFactory } = await import(
    "data:text/javascript;base64," + Buffer.from(legacySource).toString("base64")
  );
  const previousSource = source.replace(currentStats, PRE_IP_OPTIONS_STATS_PAYLOAD);
  assert.equal(statsFunctionSource(previousSource), PRE_IP_OPTIONS_STATS_PAYLOAD, "restore the complete pre-IP-options function");
  const { createAccessAnalyticsService: previousFactory } = await import(
    "data:text/javascript;base64," + Buffer.from(previousSource).toString("base64")
  );
  const activeFactory = process.argv.includes("--legacy-geo-joins") ? legacyFactory
    : process.argv.includes("--legacy-ip-options") ? previousFactory : createAccessAnalyticsService;
  const RealDate = Date;
  const fixedNow = RealDate.UTC(2026, 9, 4, 12);
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  };
  const fixtures = [];
  let comparisons = 0;
  try {
    fixtures.push(createStatsProbe(activeFactory));
    fixtures.push(createStatsProbe(legacyFactory));
    for (const fixture of fixtures) {
      seedStatsRows(fixture, true);
      assert.equal(fixture.db.prepare("SELECT COUNT(*) count FROM access_daily").get().count, 100_000);
      const geoColumns = fixture.db.prepare("PRAGMA table_info(access_ip_geo)").all();
      assert.equal(geoColumns.find((column) => column.name === "ip").pk, 1);
      const dailyColumns = fixture.db.prepare("PRAGMA table_info(access_daily)").all();
      assert.equal(dailyColumns.find((column) => column.name === "ip").notnull, 1);
    }
    const statsUrl = (query) => new URL("http://fixture.invalid/api/admin/access-stats?" + query);
    async function compare(query) {
      const values = [];
      for (const fixture of fixtures) {
        fixture.reset();
        const start = performance.now();
        const payload = await fixture.service.statsPayload(statsUrl(query));
        values.push({ payload, ms: performance.now() - start, ...fixture.snapshot() });
      }
      assert.deepEqual(values[0].payload, values[1].payload, query);
      assert.equal(JSON.stringify(values[0].payload), JSON.stringify(values[1].payload), query);
      comparisons += 1;
      return values;
    }
    const diagnostic = [];
    const optionBudgets = [];
    for (const [query, matchedRows, needsGeo] of [
      ["days=30&access=all&limit=50", 100_000, false],
      ["days=30&limit=50", 33_333, false],
      ["days=3&access=lan&auth=app&limit=50", 999, false],
      ["days=30&access=all&province=Province-2&limit=50", 100_000, true],
      ["days=30&access=all&q=ISP-1&limit=50", 100_000, true],
      ["days=30&access=all&offset=100&limit=200", 100_000, false]
    ]) {
      const raw = await compare(query);
      const probed = [];
      for (let f = 0; f < fixtures.length; f++) {
        const fixture = fixtures[f];
        fixture.reset(true);
        const payload = await fixture.service.statsPayload(statsUrl(query));
        const snapshot = fixture.snapshot();
        assert.deepEqual(payload, raw[f].payload, "the lookup probe preserves the full payload");
        assert.equal(snapshot.calls.length, 7, "the request still executes seven stats statements");
        assert.deepEqual(snapshot.calls.map((call) => call.method), ["get", "all", "all", "all", "get", "all", "all"]);
        for (const call of snapshot.calls) {
          const rawPlan = fixture.db.prepare("EXPLAIN QUERY PLAN " + call.sql).all(...call.args).map((row) => row.detail);
          const probedPlan = fixture.db.prepare("EXPLAIN QUERY PLAN " + call.executionSql).all(...call.args).map((row) => row.detail);
          assert.deepEqual(probedPlan, rawPlan, "lookup instrumentation preserves every query plan");
        }
        probed.push(snapshot);
      }
      assert.equal(probed[1].lookupCount, matchedRows * 7, "whole old stats lookup oracle");
      assert.deepEqual(probed[0].calls.slice(0, 6).map((call) => call.lookups),
        needsGeo ? Array(6).fill(matchedRows) : [0, 0, matchedRows, 0, 0, matchedRows],
        "unfiltered aggregate geo lookup budget");
      const optionCall = probed[0].calls[6];
      const optionWhere = optionCall.sql.match(/WHERE d\.day >= \?[\s\S]*?(?=\n\s*\) d|\n\s*ORDER BY province)/)?.[0];
      assert.ok(optionWhere, "observe the original day/auth/access option filters");
      const distinctIps = fixtures[0].db.prepare(`
        SELECT COUNT(*) AS count FROM (
          SELECT DISTINCT d.ip COLLATE BINARY AS ip, typeof(d.ip) AS ip_type
          FROM access_daily d ${optionWhere}
        )
      `).get(...optionCall.args).count;
      optionBudgets.push({ query, actual: optionCall.lookups, expected: distinctIps });
      diagnostic.push({ query, geoLookups: [probed[1].lookupCount, probed[0].lookupCount],
        optionGeoLookups: [probed[1].calls[6].lookups, optionCall.lookups], distinctIps,
        milliseconds: [Number(raw[1].ms.toFixed(2)), Number(raw[0].ms.toFixed(2))] });
    }

    for (const fixture of fixtures) {
      fixture.db.exec("DELETE FROM access_daily; DELETE FROM access_ip_geo");
      seedStatsRows(fixture, false);
    }
    const queries = [];
    for (const days of [1, 30, 3650])
      for (const access of ["all", "remote", "local", "unknown"])
        for (const auth of ["", "password"])
          queries.push(new URLSearchParams({ days: String(days), access, auth, limit: "50" }).toString());
    for (const q of ["%", "_", "\\", "City-空间", " synthetic ", "   ", "synthetic".repeat(20), "no-match"])
      for (const access of ["all", "remote"])
        queries.push(new URLSearchParams({ days: "30", access, q, limit: "50" }).toString());
    for (const province of ["未知", "Province-%", "Province-_"])
      for (const auth of ["", "app"])
        queries.push(new URLSearchParams({ days: "30", access: "all", province, auth, limit: "50" }).toString());
    queries.push(
      "days=bad&access=all&limit=bad&offset=-1",
      "days=0&access=all&limit=999&offset=999999",
      "days=30&access=all&limit=3&offset=2",
      "days=30&access=all&province=未知&q=synthetic",
      "days=30&access=none&auth=none",
      "days=30&access=all&province=%20%20&q=%20%20"
    );
    for (const query of queries) await compare(query);

    const routeValues = [];
    for (const fixture of fixtures) {
      const captures = [];
      assert.equal(await routeAdminApi({ method: "GET" }, {}, statsUrl("days=30&access=all&limit=50"), {
        accessAnalyticsService: fixture.service, requireLocalAdmin: () => true,
        sendJson: (_res, status, payload) => captures.push({ status, payload })
      }), true);
      assert.equal(captures[0].status, 200);
      routeValues.push(captures[0].payload);
    }
    assert.deepEqual(routeValues[0], routeValues[1], "the actual admin route preserves the whole response");
    let deniedStatsCalls = 0;
    assert.equal(await routeAdminApi({ method: "GET" }, {}, statsUrl(""), {
      requireLocalAdmin: () => false,
      accessAnalyticsService: { statsPayload() { deniedStatsCalls += 1; } }
    }), true);
    assert.equal(deniedStatsCalls, 0, "the existing local admin guard still runs first");
    for (const fixture of fixtures) {
      fixture.db.prepare("UPDATE access_ip_geo SET province=?,city=? WHERE ip=?")
        .run("Updated-Province", "Updated-City", "synthetic-a");
      fixture.service.record({
        method: "GET", headers: { accept: "text/html", "user-agent": "synthetic-update" }
      }, { statusCode: 200, getHeader: () => 100 }, new URL("http://fixture.invalid/synthetic-updated"), {
        reason: "password", access: { clientAddress: "synthetic-a", mode: "remote" }
      });
      fixture.service.record({
        method: "GET", headers: { accept: "application/json" }
      }, { statusCode: 200, getHeader: () => 50 }, new URL("http://fixture.invalid/api/synthetic"), {
        reason: "app", access: { clientAddress: "synthetic-new", mode: "remote" }
      });
    }
    const refreshed = await compare("days=30&access=all&q=Updated-City&limit=50");
    assert.ok(refreshed[0].payload.visitors.every((visitor) => visitor.province === "Updated-Province"));
    assert.equal(refreshed[0].payload.summary.requests, 1, "the pending record is flushed before stats");
    const located = await compare("days=30&access=all&q=Lookup-City&limit=50");
    assert.equal(located[0].payload.summary.requests, 1, "a newly recorded IP uses the actual lookup/flush owner");

    for (const fixture of fixtures) fixture.db.exec("DELETE FROM access_daily; DELETE FROM access_ip_geo");
    const empty = await compare("days=30&access=all&limit=50");
    assert.equal(empty[0].payload.summary.requests, 0);
    assert.equal(empty[0].payload.pagination.total, 0);
    const compatibilityComparisons = await verifyProvinceOptionCompatibility(activeFactory, previousFactory, source);
    console.log(JSON.stringify({ verification: "access analytics complete response oracles",
      fullJsonComparisons: comparisons, compatibilityComparisons }));
    for (const budget of optionBudgets) {
      assert.equal(budget.actual, budget.expected,
        "province options geo lookup budget: one join per distinct raw IP and storage type; " + budget.query);
    }
    console.log(JSON.stringify({ verification: "access analytics conditional geo joins and distinct IP province options",
      fullJsonComparisons: comparisons, compatibilityComparisons, denseRows: 100_000, diagnostic }));
  } finally {
    try {
      const closed = await Promise.allSettled(fixtures.map((fixture) => fixture.service.close()));
      const failure = closed.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    } finally {
      globalThis.Date = RealDate;
    }
  }
}

await verifyStatsGeoJoins();


const xdbPath = path.join(projectRoot, "data", "ip2region_v4.xdb");

assert.deepEqual(parseIp2Region("中国|江苏省|南京市|电信|CN"), {
  country: "中国",
  province: "江苏省",
  city: "南京市",
  isp: "电信",
  isoCode: "CN",
  located: true
});

const ipRegion = createIpRegionService({ xdbPath });
assert.equal(ipRegion.status().ready, true);
const region = await ipRegion.lookup("114.114.114.114");
assert.equal(region.located, true);
assert.equal(region.country, "中国");
assert.notEqual(region.province, "未知");
assert.equal((await ipRegion.lookup("::1")).located, false);
ipRegion.close();

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-access-analytics-"));
const geo = {
  async lookup(ip) {
    return {
      country: "中国",
      province: ip === "1.2.3.4" ? "广东省" : "江苏省",
      city: "测试市",
      isp: "测试运营商",
      isoCode: "CN",
      located: true,
      ipVersion: 4,
      reason: ""
    };
  },
  status() {
    return { ready: true, database: "test.xdb", error: "", version: "IPv4" };
  },
  close() {}
};

const service = createAccessAnalyticsService({
  dbPath: path.join(tempDir, "access-analytics.sqlite"),
  ensureDataDir() {},
  ipRegionService: geo,
  flushIntervalMs: 60_000
});

function finishRequest({ ip, reason, pathname, status = 200, accept = "text/html", mode = "remote" }) {
  const req = {
    method: "GET",
    headers: {
      accept,
      "sec-fetch-dest": accept.includes("html") ? "document" : "",
      "user-agent": "FanHao access analytics verification"
    }
  };
  const res = new EventEmitter();
  res.statusCode = status;
  res.getHeader = () => 123;
  service.attach(req, res, new URL(pathname, "http://localhost"), {
    access: { clientAddress: ip, mode },
    reason
  });
  res.emit("finish");
}

finishRequest({ ip: "1.2.3.4", reason: "missing-password", pathname: "/fanhao" });
finishRequest({ ip: "1.2.3.4", reason: "password", pathname: "/fanhao" });
finishRequest({ ip: "1.2.3.4", reason: "password", pathname: "/api/library", accept: "application/json" });
finishRequest({ ip: "5.6.7.8", reason: "app", pathname: "/short-videos" });
finishRequest({ ip: "127.0.0.1", reason: "trusted-network", pathname: "/admin", mode: "local" });

const payload = await service.statsPayload(new URL("http://localhost/api/admin/access-stats?days=30&limit=10"));
assert.equal(payload.geo.ready, true);
assert.equal(payload.summary.uniqueIps, 2);
assert.equal(payload.summary.requests, 4);
assert.equal(payload.summary.pageViews, 3);
assert.equal(payload.summary.missingPasswordRequests, 1);
assert.equal(payload.summary.passwordRequests, 2);
assert.equal(payload.summary.injectedRequests, 1);
assert.equal(payload.visitors.length, 3);
assert.equal(payload.provinces[0].province, "广东省");

const passwordOnly = await service.statsPayload(new URL("http://localhost/api/admin/access-stats?days=30&auth=password"));
assert.equal(passwordOnly.summary.uniqueIps, 1);
assert.equal(passwordOnly.summary.requests, 2);
assert.ok(passwordOnly.visitors.every((visitor) => visitor.authReason === "password"));

const provinceOnly = await service.statsPayload(new URL("http://localhost/api/admin/access-stats?days=30&province=江苏省&q=5.6"));
assert.equal(provinceOnly.summary.uniqueIps, 1);
assert.equal(provinceOnly.visitors[0].ip, "5.6.7.8");

const allNetworks = await service.statsPayload(new URL("http://localhost/api/admin/access-stats?days=30&access=all"));
assert.equal(allNetworks.summary.uniqueIps, 3);
assert.equal(allNetworks.summary.trustedNetworkRequests, 1);

await service.close();

const historyPath = path.join(tempDir, "access.log");
fs.writeFileSync(historyPath, [
  JSON.stringify({
    time: new Date(Date.now() - 60_000).toISOString(),
    method: "GET",
    path: "/fanhao",
    status: 200,
    remote: "9.9.9.9",
    access: "remote",
    auth: "password",
    responseLength: 321,
    userAgent: "historical verification"
  }),
  JSON.stringify({
    time: "2999-01-01T00:00:00.000Z",
    method: "GET",
    path: "/future",
    status: 200,
    remote: "10.10.10.10",
    access: "remote",
    auth: "password"
  })
].join("\n"), "utf8");

const bootstrapService = createAccessAnalyticsService({
  dbPath: path.join(tempDir, "access-bootstrap.sqlite"),
  ensureDataDir() {},
  ipRegionService: geo,
  flushIntervalMs: 60_000
});
const firstBootstrap = await bootstrapService.bootstrapFromAccessLogs([historyPath]);
const secondBootstrap = await bootstrapService.bootstrapFromAccessLogs([historyPath]);
const bootstrapped = await bootstrapService.statsPayload(new URL("http://localhost/api/admin/access-stats?days=30"));
assert.equal(firstBootstrap.imported, 1);
assert.equal(secondBootstrap.skipped, true);
assert.equal(bootstrapped.summary.uniqueIps, 1);
assert.equal(bootstrapped.summary.requests, 1);
assert.equal(bootstrapped.visitors[0].ip, "9.9.9.9");
await bootstrapService.close();

fs.rmSync(tempDir, { recursive: true, force: true });
console.log("access analytics verification passed");
