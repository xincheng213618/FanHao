import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import * as contracts from "../src/modules/fanhao/server/library/cache-contracts.js";
import { readTableStampRow, tableStampValue } from "../src/modules/fanhao/server/library/table-stamp-query.js";
import { createStudioService } from "../src/modules/fanhao/server/catalog/studio-service.js";
import { createCodePrefixService } from "../src/modules/fanhao/server/catalog/code-prefix-service.js";
import { routeCatalogApi } from "../src/modules/fanhao/server/catalog/routes.js";
import { createWorkFilterService } from "../src/modules/fanhao/server/works/work-filter-service.js";
import { createWorkClassificationService } from "../src/modules/fanhao/server/works/work-classification-service.js";
import { createWorkSorter } from "../src/modules/fanhao/server/works/work-sorter.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyRevision = "1f6ddf213f0fbab4d417fdf61636b957d1909338";
const dependencyTables = ["works", "makers", "work_makers", "maker_external_refs", "series", "series_external_refs", "work_series", "local_works"];
const currentServer = fs.readFileSync(path.join(repo, "server.js"), "utf8");

function sourceFunction(source, name) {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"));
  assert(match, `actual composition function ${name} must exist`);
  return match[0];
}

async function withDatabase(run, { legacyRefs = false, legacyAll = false } = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-studio-cache-"));
  const databasePath = path.join(tempDir, "catalog.sqlite");
  const writer = new DatabaseSync(databasePath);
  let reader;
  try {
    writer.exec(`
      CREATE TABLE works(id INTEGER PRIMARY KEY, title TEXT, status TEXT, release_date TEXT, updated_at TEXT);
      CREATE TABLE makers(id INTEGER PRIMARY KEY, name TEXT, name_search TEXT, source TEXT, updated_at TEXT);
      CREATE TABLE work_makers(id INTEGER PRIMARY KEY, work_id INTEGER, maker_id INTEGER, role TEXT, updated_at TEXT);
      CREATE TABLE maker_external_refs(id INTEGER PRIMARY KEY, maker_id INTEGER, url TEXT, updated_at TEXT);
      CREATE TABLE series(id INTEGER PRIMARY KEY, maker_id INTEGER, name TEXT, name_search TEXT, kind TEXT, source TEXT, updated_at TEXT);
      CREATE TABLE series_external_refs(id INTEGER PRIMARY KEY, series_id INTEGER, url TEXT, updated_at TEXT);
      CREATE TABLE work_series(id INTEGER PRIMARY KEY, work_id INTEGER, series_id INTEGER, updated_at TEXT);
      CREATE TABLE local_works(id INTEGER PRIMARY KEY, work_id INTEGER, updated_at TEXT);
      INSERT INTO works VALUES(1,'AB-001','ok','2025-01-01','2026'),(2,'AB-002','ok','2025-02-01','2026');
      INSERT INTO makers VALUES(10,'Alpha','alpha','fixture','2026'),(20,'Other','other','fixture','2026');
      INSERT INTO work_makers VALUES(1,1,10,'maker','2026'),(2,2,10,'maker','2026');
      INSERT INTO maker_external_refs VALUES(1,10,'https://fixture.invalid/maker-a','2026');
      INSERT INTO series VALUES(100,10,'Series A','series a','series','fixture','2026');
      INSERT INTO series_external_refs VALUES(1,100,'https://fixture.invalid/series-a','2026');
      INSERT INTO work_series VALUES(1,1,100,'2026');
      INSERT INTO local_works VALUES(1,1,'2026'),(2,2,'2026');
    `);
    for (const table of legacyAll ? dependencyTables.filter((table) => table !== "works") : legacyRefs ? ["maker_external_refs", "series_external_refs"] : []) {
      writer.exec(`ALTER TABLE ${table} DROP COLUMN updated_at`);
    }
    reader = new DatabaseSync(databasePath);
    return await run({ writer, reader, databasePath });
  } finally {
    reader?.close();
    writer.close();
    // This fixture owns a flat, synthetic directory; never recurse into an
    // existing artifact, media directory, or another fixture's temp files.
    const tempRoot = fs.realpathSync(os.tmpdir());
    const resolved = fs.realpathSync(tempDir);
    assert.equal(path.dirname(resolved), tempRoot);
    assert(path.basename(resolved).startsWith("fanhao-studio-cache-"));
    for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
      assert(entry.isFile() && !entry.isSymbolicLink(), "fixture cleanup accepts only its generated files");
      assert(["catalog.sqlite", "catalog.sqlite-journal", "catalog.sqlite-wal", "catalog.sqlite-shm"].includes(entry.name));
      fs.unlinkSync(path.join(resolved, entry.name));
    }
    fs.rmdirSync(resolved);
  }
}

function harness(reader, { legacyStamp = false } = {}) {
  const versions = new Map();
  const stampedTables = new Set();
  let stampRows = null;
  let materializations = 0;
  const worksById = new Map([1, 2].map((id) => [String(id), {
    id: String(id), code: `AB-00${id}`, title: `AB-00${id}`, modifiedAt: "2026", playableCount: 1
  }]));
  const library = { scannedAt: "stable-scan", worksById };
  const clampInteger = (value, fallback, min, max) => value === null || value === "" || !Number.isFinite(Number(value)) ? fallback : Math.max(min, Math.min(max, Math.trunc(Number(value))));
  const tableDataStamp = (table) => {
    stampedTables.add(table);
    return tableStampValue(table, versions.get(table) || 0, stampRows?.get(table) || readTableStampRow(reader, table));
  };
  const workFilterService = createWorkFilterService();
  const workClassificationService = createWorkClassificationService({ appConfigService: { current: () => ({}) } });
  const sharedWorkSorter = createWorkSorter({
    metadataForWork: (work) => ({ releaseDate: reader.prepare("SELECT release_date FROM works WHERE id=?").get(Number(work.id)).release_date, rating: null, ratingCount: 0, popularity: 0, duration: 0, code: work.code }),
    progressForWork: () => null
  });
  const legacyServer = legacyStamp ? execFileSync("git", ["show", `${legacyRevision}:server.js`], { cwd: repo, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }) : null;
  const functions = [
    sourceFunction(currentServer, "workInfoStamp"),
    sourceFunction(legacyServer || currentServer, "studioCatalogStamp"),
    ...["sortWorkList", "workFacets", "pagedWorksPayload"].map((name) => sourceFunction(currentServer, name))
  ].join("\n");
  const bindings = {
    ...contracts, library, tableDataStamp, clampInteger, sharedWorkSorter, workFilterService,
    DEFAULT_WORK_LIMIT: 48, MAX_WORK_LIMIT: 1000, allWorks: () => [...worksById.values()],
    prewarmCoreWorkCovers() {}, prewarmWorkInfoDetails() {}, prewarmRemoteImagesForWorks() {},
    publicWork: (work) => { materializations += 1; return { id: work.id, title: work.title }; }
  };
  const composition = new Function(...Object.keys(bindings), `${functions}\nreturn {studioCatalogStamp,sortWorkList,workFacets,pagedWorksPayload};`)(...Object.values(bindings));
  const common = {
    clampInteger, filterWorkList: workFilterService.filter, getCoreDb: () => reader,
    getLibrary: () => library, getStamp: composition.studioCatalogStamp,
    pagedWorksPayload: composition.pagedWorksPayload, publicRemoteUrl: (url) => url || "",
    sortWorkList: composition.sortWorkList, workFacets: composition.workFacets, workClassificationService,
    workQueryStamp: () => "stable-query", userStateStamp: () => "stable-user"
  };
  const studioService = createStudioService(common);
  const codePrefixService = createCodePrefixService({
    ...common, defaultWorkLimit: 48, maxWorkLimit: 1000, fastMissingCodeSearch: () => [],
    dedupeWorksForDisplay: (works) => [...new Map(works.map((work) => [work.id, work])).values()]
  });
  async function request(route) {
    const res = {};
    const handled = await routeCatalogApi({ method: "GET" }, res, new URL(route, "http://fixture.invalid"), {
      studioService, codePrefixService, rankingService: {},
      sendJson: (target, status, body) => Object.assign(target, { status, body }),
      notFound: (target) => Object.assign(target, { status: 404 })
    });
    assert(handled, `actual catalog route must handle ${route}`);
    assert.equal(res.status, 200, `${route}: ${JSON.stringify(res.body)}`);
    return res.body;
  }
  async function snapshot() {
    return {
      studios: await request("/api/studios"), studio: await request("/api/studios/10"),
      series: await request("/api/studios/10?seriesId=100"), prefixes: await request("/api/code-prefixes"),
      prefix: await request("/api/code-prefixes/AB")
    };
  }
  return {
    snapshot, request, stamp: composition.studioCatalogStamp,
    materializations: () => materializations,
    stampedTables: () => [...stampedTables],
    useStampRows: (rows) => { stampRows = rows; },
    invalidate: (table) => { for (const dependency of contracts.cacheDependencyTables(table)) versions.set(dependency, (versions.get(dependency) || 0) + 1); }
  };
}

const maker = (snapshot) => snapshot.studios.makers.find((row) => row.id === "10");
const prefixMaker = (snapshot) => snapshot.prefixes.prefixes.find((row) => row.prefix === "AB").makers.find((row) => row.id === "10");

function verifyLargeCatalogStamps() {
  const db = new DatabaseSync(":memory:");
  const statements = [];
  const recordedDb = {
    prepare(sql) {
      const entry = { sql, executions: 0 };
      statements.push(entry);
      const statement = db.prepare(sql);
      return { get(...args) { entry.executions += 1; return statement.get(...args); } };
    }
  };
  try {
    for (const table of dependencyTables.filter((table) => table !== "works")) {
      db.exec(`CREATE TABLE ${table}(id INTEGER PRIMARY KEY${table === "work_makers" ? ", updated_at TEXT" : ""});`);
    }
    db.exec(`
      INSERT INTO work_makers WITH RECURSIVE rows(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM rows WHERE id<300000) SELECT id,'2026' FROM rows;
      INSERT INTO work_series WITH RECURSIVE rows(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM rows WHERE id<300000) SELECT id FROM rows;
    `);
    const times = [];
    for (const table of dependencyTables.filter((table) => table !== "works")) {
      let revision;
      for (let index = 0; index < 20; index += 1) {
        const started = performance.now();
        const row = readTableStampRow(recordedDb, table);
        times.push(performance.now() - started);
        assert.deepEqual([row.row_count, row.max_rowid, row.max_updated_at], [0, 0, ""], "new catalog dependencies must not materialize row statistics");
        if (revision) assert.equal(row.content_revision, revision, "repeat reads must preserve the connection epoch");
        revision = row.content_revision;
      }
    }
    for (const entry of statements) {
      assert.equal(entry.executions, 1, "each recorded catalog stamp query must actually execute");
      assert(!/COUNT\s*\(|MAX\s*\(|GROUP_CONCAT|SELECT\s+\*/i.test(entry.sql), `catalog stamp must avoid aggregates/content scans: ${entry.sql}`);
      assert(/^SELECT 1 FROM [a-z_]+ LIMIT 0$|^PRAGMA main\.data_version$/.test(entry.sql), `catalog stamp must use only zero-row schema diagnostics and the commit counter: ${entry.sql}`);
    }
    db.exec("DROP TABLE makers");
    assert.throws(() => readTableStampRow(recordedDb, "makers"), /no such table/i, "missing catalog tables must retain diagnostics");
    db.exec("CREATE TABLE works(id INTEGER PRIMARY KEY, updated_at TEXT); INSERT INTO works VALUES(7,'old-table');");
    assert.deepEqual(readTableStampRow(db, "works"), { row_count: 1, max_rowid: 7, max_updated_at: "old-table", content_revision: "" }, "old work stamps must retain their row-stat semantics");
    times.sort((a, b) => a - b);
    console.log(`studio-cache-dependencies: 300000-row-links stamp-median=${times[Math.floor(times.length / 2)].toFixed(3)}ms queries=${statements.length} (diagnostic)`);
  } finally { db.close(); }
}

const cases = [
  { name: "maker-name", unchangedSql: "UPDATE makers SET name='Beta',name_search='beta',updated_at='2026' WHERE id=10", sql: "UPDATE makers SET name='Beta',name_search='beta',updated_at='2027' WHERE id=10", check(snapshot) {
    assert.equal(maker(snapshot).name, "Beta", "cached studio summary must see changed maker metadata");
    assert.equal(snapshot.studio.studio.name, "Beta");
    assert.equal(prefixMaker(snapshot).name, "Beta");
    assert.equal(snapshot.prefix.codePrefix.maker.name, "Beta");
  } },
  { name: "maker-ref-legacy", legacyRefs: true, modernSql: "UPDATE maker_external_refs SET url='https://fixture.invalid/maker-b',updated_at='2027' WHERE id=1", sql: "UPDATE maker_external_refs SET url='https://fixture.invalid/maker-b' WHERE id=1", check(snapshot) {
    assert.equal(maker(snapshot).url, "https://fixture.invalid/maker-b");
    assert.equal(snapshot.studio.studio.url, "https://fixture.invalid/maker-b");
  } },
  { name: "maker-membership", sql: "UPDATE work_makers SET maker_id=20,updated_at='2027' WHERE work_id=2", check(snapshot) {
    assert.equal(maker(snapshot).workCount, 1);
    assert.deepEqual(snapshot.studio.works.map((row) => row.id), ["1"]);
    assert.equal(prefixMaker(snapshot).localCount, 1);
    assert.equal(snapshot.prefix.codePrefix.makers.length, 2);
  } },
  { name: "series-name", sql: "UPDATE series SET name='Series B',name_search='series b',updated_at='2027' WHERE id=100", check(snapshot) {
    assert.equal(snapshot.studio.studio.series[0].name, "Series B");
  } },
  { name: "series-ref-legacy", legacyRefs: true, modernSql: "UPDATE series_external_refs SET url='https://fixture.invalid/series-b',updated_at='2027' WHERE id=1", sql: "UPDATE series_external_refs SET url='https://fixture.invalid/series-b' WHERE id=1", check(snapshot) {
    assert.equal(snapshot.studio.studio.series[0].url, "https://fixture.invalid/series-b");
  } },
  { name: "series-membership", sql: "INSERT INTO work_series VALUES(2,2,100,'2027')", check(snapshot) {
    assert.equal(snapshot.studio.studio.series[0].workCount, 2);
    assert.deepEqual(snapshot.series.works.map((row) => row.id), ["2", "1"]);
  } },
  { name: "local-membership", sql: "DELETE FROM local_works WHERE work_id=1", check(snapshot) {
    assert.equal(maker(snapshot).localWorkCount, 1);
    assert.deepEqual(snapshot.studio.works.map((row) => row.id), ["2"]);
    assert.equal(prefixMaker(snapshot).localCount, 1);
  } },
  { name: "work-metadata", sql: "UPDATE works SET release_date='2028-01-01',updated_at='2027' WHERE id=1", check(snapshot) {
    assert.equal(maker(snapshot).latestReleaseDate, "2028-01-01");
    assert.equal(snapshot.studio.studio.series[0].latestReleaseDate, "2028-01-01");
    assert.deepEqual(snapshot.studio.works.map((row) => row.id), ["1", "2"]);
    assert.deepEqual(snapshot.prefix.works.map((row) => row.id), ["1", "2"]);
  } },
  { name: "connection-handoff", legacyAll: true, async run({ reader, writer, databasePath }, options) {
    const h = harness(reader, options);
    await h.snapshot();
    const before = h.stamp();
    const readerVersion = reader.prepare("PRAGMA main.data_version").get().data_version;
    writer.exec("UPDATE maker_external_refs SET url='https://fixture.invalid/handoff' WHERE id=1");
    const worker = new Worker(new URL("../src/modules/fanhao/server/library/table-stamp-worker.js", import.meta.url), {
      workerData: { dbPath: databasePath, imageDbPath: null }
    });
    let requestId = 0;
    const readWorkerRow = (table) => new Promise((resolve, reject) => {
      const id = ++requestId;
      const timeout = setTimeout(() => { done(); reject(new Error(`worker stamp timeout: ${table}`)); }, 5000);
      const onError = (error) => { done(); reject(error); };
      const onMessage = (message) => {
        if (message.id !== id) return;
        done();
        if (message.ok) resolve(message.row);
        else reject(new Error(message.error));
      };
      function done() { clearTimeout(timeout); worker.off("message", onMessage); worker.off("error", onError); }
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.postMessage({ id, table });
    });
    const readWorkerRows = async () => {
      const rows = new Map();
      for (const table of dependencyTables) rows.set(table, await readWorkerRow(table));
      return rows;
    };
    try {
      const firstRows = await readWorkerRows();
      assert.equal(Number(firstRows.get("maker_external_refs").content_revision.split(":").at(-1)), readerVersion, "fresh worker counter must coincide with cold main counter for this regression");
      h.useStampRows(firstRows);
      const next = h.stamp();
      assert.notEqual(next, before, "connection-local equal data_version counters must not hide a commit at handoff");
      h.useStampRows(await readWorkerRows());
      assert.equal(h.stamp(), next, "stable worker reads must reuse their connection epoch");
      assert.equal(maker(await h.snapshot()).url, "https://fixture.invalid/handoff");
      writer.exec("UPDATE maker_external_refs SET url='https://fixture.invalid/worker-update' WHERE id=1");
      h.useStampRows(await readWorkerRows());
      assert.notEqual(h.stamp(), next, "persistent actual worker must observe the next external UPDATE");
      assert.equal(maker(await h.snapshot()).url, "https://fixture.invalid/worker-update");
    } finally { await worker.terminate(); }
  } },
  { name: "same-connection-invalidation", schemaVariants: true, async run({ reader }, options) {
    assert.deepEqual(contracts.cacheDependencyTables("studio_catalog"), dependencyTables);
    const h = harness(reader, options);
    await h.snapshot();
    const before = h.stamp();
    reader.exec("UPDATE maker_external_refs SET url='https://fixture.invalid/local-write' WHERE id=1");
    assert.equal(h.stamp(), before, "legacy data_version intentionally observes external commits; own writes require invalidation");
    h.invalidate("studio_catalog");
    assert.notEqual(h.stamp(), before);
    assert.equal(maker(await h.snapshot()).url, "https://fixture.invalid/local-write");
    for (const table of [...dependencyTables, "work_info"]) {
      const previous = h.stamp();
      h.invalidate(table);
      assert.notEqual(h.stamp(), previous, `actual composition must consume ${table}'s explicit revision independently`);
    }
    const beforeLocalDelete = h.stamp();
    reader.exec("DELETE FROM local_works WHERE work_id=1");
    assert.equal(h.stamp(), beforeLocalDelete, "own local membership changes also rely on explicit invalidation");
    h.invalidate("work_info");
    assert.notEqual(h.stamp(), beforeLocalDelete, "the existing work_info mutation alias must invalidate local catalog data immediately");
    const afterLocalDelete = await h.snapshot();
    assert.equal(maker(afterLocalDelete).localWorkCount, 1);
    assert.deepEqual(afterLocalDelete.studio.works.map((row) => row.id), ["2"]);
  } }
];

export async function runStudioCacheDependencyFixture({ legacyStamp = false, caseName = "" } = {}) {
  const selected = cases.filter((test) => !caseName || test.name === caseName);
  assert(selected.length, `unknown case: ${caseName}`);
  assert.deepEqual(contracts.STUDIO_CATALOG_CACHE_TABLES, dependencyTables);
  for (const test of selected) {
    if (test.name === "connection-handoff") verifyLargeCatalogStamps();
    // Await while the private connections remain open; cleanup happens only
    // after the actual route promises and SQLite reads have completed.
    const variants = test.modernSql
      ? [{ legacyRefs: false, sql: test.modernSql }, { legacyRefs: false }, { legacyRefs: true }]
      : test.unchangedSql ? [{}, { sql: test.unchangedSql }]
      : test.legacyAll ? [{ legacyAll: false }, { legacyAll: true }]
      : test.schemaVariants ? [{ legacyRefs: false }, { legacyRefs: true }]
      : [{}];
    for (const variant of variants) {
      await withDatabase(async (db) => {
        if (test.run) return test.run(db, { legacyStamp });
        const h = harness(db.reader, { legacyStamp });
        const warm = await h.snapshot();
        const materializations = h.materializations();
        const repeated = await h.snapshot();
        assert.strictEqual(repeated.studios, warm.studios, "warm studio aggregate payload must be reused");
        assert.strictEqual(repeated.studio, warm.studio, "warm studio detail page must be reused");
        assert.equal(h.materializations() - materializations, 2, "only the uncached prefix response serializes its two rows on repeat");
        const before = h.stamp();
        db.writer.exec(variant.sql || test.sql);
        test.check(await h.snapshot());
        assert.deepEqual(new Set(h.stampedTables()), new Set([...dependencyTables, "work_info"]), "actual composition must read every physical dependency and retain legacy work_info invalidation");
        assert.notEqual(h.stamp(), before, `${test.name} must change actual composition stamp`);
      }, { ...test, ...variant });
    }
    console.log(`studio-cache-dependencies: PASS ${test.name}`);
  }
  console.log(`studio-cache-dependencies: ${selected.length} cases PASS${legacyStamp ? ` (legacy stamp ${legacyRevision})` : ""}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const caseName = process.argv.find((value) => value.startsWith("--case="))?.slice(7) || "";
  await runStudioCacheDependencyFixture({ legacyStamp: process.argv.includes("--legacy-stamp"), caseName });
}
