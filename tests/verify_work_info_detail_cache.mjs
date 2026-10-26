import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Private SQLite rows and the real service. The fixture-only accessor measures
// retained payloads; it does not become part of the production service API.
const serviceUrl = new URL("../src/modules/fanhao/server/works/work-info-service.js", import.meta.url);
const source = fs.readFileSync(serviceUrl, "utf8").replaceAll("\r\n", "\n");
const formerPrewarm = `  function prewarmDetailRows(workIds = []) {
    const cache = ensureWorkInfoDetailCache();
    const pending = [...new Set((Array.isArray(workIds) ? workIds : [])
      .map(normalizeDetailWorkId).filter(workId => workId && !cache.rows.has(workId)))];
    for (let offset = 0; offset < pending.length; offset += DETAIL_BATCH_SIZE) {
      const batch = pending.slice(offset, offset + DETAIL_BATCH_SIZE);
      try {
        const rows = getCoreDb().prepare(workInfoDetailQuery(batch.length)).all(...batch.map(Number));
        for (const row of rows) cache.rows.set(row.work_id, row);
      } catch (error) { console.warn("[core-work-info-detail]", error.message); }
      for (const id of batch) if (!cache.rows.has(id)) cache.rows.set(id, null);
    }
    return cache.rows;
  }
`;
const start = source.indexOf("  function prewarmDetailRows("), end = source.indexOf("  function detailRow(");
assert.ok(start > 0 && end > start);
const rowEnd = source.indexOf("  function rowsById(");
const formerDetailRow = `  function detailRow(workId) {
    const id = normalizeDetailWorkId(workId);
    return id ? prewarmDetailRows([id]).get(id) || null : null;
  }
`;
const previous = await factory(source.slice(0, start) + formerPrewarm + formerDetailRow + source.slice(rowEnd));
const current = await factory(source);
const candidate = process.argv.includes("--legacy") ? previous : current;
assert.ok(process.argv.slice(2).every(value => value === "--legacy"));
const database = new DatabaseSync(":memory:");
database.exec("CREATE TABLE details(id INTEGER PRIMARY KEY, title TEXT, raw_text TEXT, fields_json TEXT)");
const insert = database.prepare("INSERT INTO details VALUES(?,?,?,?)");
database.exec("BEGIN");
for (let id = 1; id <= 1000; id++) insert.run(id, `Title ${id}`, `${id}:` + "x".repeat(32768), '[{"name":"field","value":"中文"}]');
database.exec("COMMIT");
const originalWarn = console.warn;
let warnings = 0;
console.warn = (...args) => {
  assert.equal(args[0], "[core-work-info-detail]");
  assert.match(args[1], /controlled/); warnings++;
};
try {
  const old = fixture(previous), next = fixture(candidate);
  const ids = Array.from({ length: 900 }, (_, index) => String(index + 1));
  const oldRows = old.service.prewarmDetailRows(ids), newRows = next.service.prewarmDetailRows(ids);
  for (const id of ids) assert.deepEqual(newRows.get(id), oldRows.get(id), "a request larger than the retention budget still returns every complete row");
  assert.equal(old.reads, 5); assert.equal(next.reads, 5, "prewarming remains batched at 200");
  for (const id of ids) assert.deepEqual(next.service.detailRow(id), oldRows.get(id));
  assert.equal(next.reads, 5, "synchronous presentation of an oversized page must not turn into N+1 queries");
  next.service.detailRow("20000");
  for (const id of ids) next.service.detailRow(id);
  assert.equal(next.reads, 6, "an unrelated single-row miss must not displace the prewarmed batch");
  await Promise.resolve();
  const oldSnapshot = old.service.fixtureSnapshot(), snapshot = next.service.fixtureSnapshot();
  assert.equal(oldSnapshot.entries, 900);
  assert.ok(snapshot.stringBytes <= 32 * 1024 * 1024, "retained strings must fit the byte budget");
  assert.ok(snapshot.entries < oldSnapshot.entries, "large metadata must trigger byte-based eviction");
  let reads = next.reads;
  assert.deepEqual(next.service.detailRow("900"), oldRows.get("900"));
  assert.deepEqual(next.service.detailRow("450"), oldRows.get("450"));
  assert.equal(next.reads, reads, "recent rows stay hot");
  next.service.prewarmDetailRows(Array.from({ length: 100 }, (_, index) => String(index + 901)));
  reads = next.reads;
  next.service.detailRow("450");
  assert.equal(next.reads, reads, "a touched row remains hot after older rows are evicted");
  assert.deepEqual(next.service.detailRow("1"), oldRows.get("1"));
  assert.equal(next.reads, reads + 1, "an evicted row is loaded again without truncation");
  for (const id of ["1", "450", "900"]) assert.deepEqual(next.service.publicMetadata(next.service.detailRow(id)), old.service.publicMetadata(oldRows.get(id)));

  const empty = fixture(candidate), missing = Array.from({ length: 2200 }, (_, index) => String(index + 10000));
  const missingRows = empty.service.prewarmDetailRows(missing);
  assert.equal(missingRows.size, 2200);
  assert.ok([...missingRows.values()].every(row => row === null));
  assert.ok(empty.service.fixtureSnapshot().entries <= 2048, "missing rows also have a bounded entry count");
  await Promise.resolve();
  reads = empty.reads; empty.service.detailRow(missing.at(-1)); assert.equal(empty.reads, reads);
  empty.service.detailRow(missing[0]); assert.equal(empty.reads, reads + 1);
  reads = empty.reads;
  for (const id of [null, "", "wrong", -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(empty.service.detailRow(id), null);
  assert.equal(empty.reads, reads, "invalid IDs never reach SQLite");

  const oversized = fixture(candidate);
  oversized.service.detailRow("1");
  const beforeOversized = oversized.service.fixtureSnapshot();
  insert.run(90001, "Oversized", "y".repeat(17 * 1024 * 1024), "[]");
  const huge = oversized.service.detailRow("90001");
  assert.equal(huge.raw_text.length, 17 * 1024 * 1024, "oversized metadata is returned in full");
  assert.deepEqual(oversized.service.fixtureSnapshot(), beforeOversized, "an oversized row must not displace the useful cache");
  reads = oversized.reads; oversized.service.detailRow("90001"); assert.equal(oversized.reads, reads + 1);
  reads = oversized.reads; oversized.service.detailRow("1"); assert.equal(oversized.reads, reads);

  // SQLite's dynamic typing can return binary values even from TEXT columns.
  // These must count toward the budget without changing the returned value.
  const blobs = fixture(candidate);
  database.exec("INSERT INTO details VALUES(90002,'Blob A',zeroblob(20971520),'[]'),(90003,'Blob B',zeroblob(20971520),'[]')");
  const blobRows = blobs.service.prewarmDetailRows(["90002", "90003"]);
  for (const id of ["90002", "90003"]) {
    assert.equal(blobRows.get(id).raw_text.byteLength, 20 * 1024 * 1024);
    assert.deepEqual(blobs.service.detailRow(id), blobRows.get(id));
  }
  assert.equal(blobs.reads, 1, "binary metadata also retains synchronous batch reuse");
  await Promise.resolve();
  assert.ok(blobs.service.fixtureSnapshot().binaryBytes <= 32 * 1024 * 1024);
  reads = blobs.reads; blobs.service.detailRow("90002"); assert.equal(blobs.reads, reads + 1);

  const summaries = fixture(candidate), summaryOptions = { includeMetadata: false };
  const summaryRows = summaries.service.prewarmDetailRows(ids, summaryOptions);
  for (const id of ids) {
    assert.equal(summaryRows.get(id).raw_text, null);
    assert.equal(summaryRows.get(id).fields_json, null);
    assert.deepEqual(summaries.service.detailRow(id, summaryOptions), summaryRows.get(id));
  }
  assert.equal(summaries.reads, 5, "summary presentation also stays batched");
  assert.equal(summaries.service.detailRow("1").raw_text, oldRows.get("1").raw_text);
  assert.equal(summaries.reads, 6, "a summary must upgrade before serving full metadata");
  summaries.service.detailRow("1", summaryOptions);
  assert.equal(summaries.reads, 6, "an old summary batch cannot downgrade the complete persistent row");
  summaries.service.prewarmDetailRows(["1", "2", "3"]);
  assert.equal(summaries.reads, 7, "only incomplete entries need one batch upgrade");
  summaries.service.prewarmDetailRows(["1", "2", "3"], summaryOptions);
  for (const id of ["1", "2", "3"]) assert.ok(summaries.service.detailRow(id).raw_text);
  assert.equal(summaries.reads, 7, "summary prewarm preserves completeness of reused rows");
  summaries.service.prewarmDetailRows(ids, summaryOptions);
  summaries.service.prewarmDetailRows(ids);
  const mixedBudget = summaries.service.fixtureSnapshot();
  assert.ok(mixedBudget.entries <= 2048 && mixedBudget.estimatedBytes <= 32 * 1024 * 1024,
    "both projections share one entry and byte budget");
  reads = summaries.reads;
  for (const id of ids) summaries.service.detailRow(id, summaryOptions);
  assert.equal(summaries.reads, reads, "a complete oversized batch also supplies every summary");
  await Promise.resolve();
  summaries.service.detailRow("1");
  assert.equal(summaries.reads, reads + 1, "expired full batches cannot leak through the summary mode");

  const upgrades = fixture(candidate);
  for (const phase of ["prepare", "read"]) {
    upgrades.service.invalidate();
    const savedSummary = upgrades.service.prewarmDetailRows(["1", "2"], summaryOptions).get("1");
    const before = upgrades.service.fixtureSnapshot();
    upgrades.fault = phase;
    assert.equal(upgrades.service.detailRow("1"), null);
    assert.deepEqual(upgrades.service.fixtureSnapshot(), before, "failed upgrades retain the existing useful summary");
    assert.deepEqual(upgrades.service.detailRow("1", summaryOptions), savedSummary);
    assert.ok(upgrades.service.detailRow("1").raw_text, "failed full upgrades retry instead of accepting a summary as complete");
    upgrades.service.prewarmDetailRows(["2"], summaryOptions);
    upgrades.service.setRowsCache({ stamp: upgrades.stamp, rows: new Map() });
    reads = upgrades.reads; upgrades.service.detailRow("2", summaryOptions); assert.equal(upgrades.reads, reads + 1);
    upgrades.service.prewarmDetailRows(["2"], summaryOptions);
    upgrades.stamp++;
    reads = upgrades.reads; upgrades.service.detailRow("2"); assert.equal(upgrades.reads, reads + 1);
  }
  const failedUpgradeWarnings = warnings;
  const hugeSummary = upgrades.service.prewarmDetailRows(["90001"], summaryOptions).get("90001");
  const beforeHugeUpgrade = upgrades.service.fixtureSnapshot();
  assert.equal(upgrades.service.detailRow("90001").raw_text.length, 17 * 1024 * 1024);
  assert.deepEqual(upgrades.service.fixtureSnapshot(), beforeHugeUpgrade, "oversized upgrades retain their cheap summary");
  reads = upgrades.reads;
  assert.deepEqual(upgrades.service.detailRow("90001", summaryOptions), hugeSummary);
  assert.equal(upgrades.reads, reads);
  const hugeFullBatch = upgrades.service.prewarmDetailRows(["90001"]);
  reads = upgrades.reads;
  assert.equal(upgrades.service.detailRow("90001"), hugeFullBatch.get("90001"), "an oversized complete batch satisfies full reads despite a summary in persistent cache");
  assert.deepEqual(upgrades.service.detailRow("90001", summaryOptions), hugeSummary);
  assert.equal(upgrades.reads, reads);
  upgrades.service.prewarmDetailRows(["90002", "90003"], summaryOptions);
  assert.ok(upgrades.service.detailRow("90002").raw_text instanceof Uint8Array);
  assert.ok(upgrades.service.detailRow("90003").raw_text instanceof Uint8Array);
  assert.ok(upgrades.service.fixtureSnapshot().estimatedBytes <= 32 * 1024 * 1024);
  upgrades.service.prewarmDetailRows(["999999"], summaryOptions);
  reads = upgrades.reads; assert.equal(upgrades.service.detailRow("999999"), null); assert.equal(upgrades.reads, reads, "confirmed absence is shared across projections");

  const retry = fixture(candidate);
  for (const phase of ["prepare", "read"]) {
    retry.service.invalidate(); retry.fault = phase;
    assert.equal(retry.service.detailRow("1"), null);
    assert.equal(retry.service.fixtureSnapshot().entries, 0, "failed reads must not become cached absence");
    assert.equal(retry.service.detailRow("1").title, "Title 1", "the next call retries transient failures");
  }
  assert.equal(warnings, failedUpgradeWarnings + 2);
  retry.service.invalidate(); retry.fault = "read";
  retry.service.prewarmDetailRows(["1"]);
  assert.equal(retry.service.detailRow("1").title, "Title 1", "a failed prewarm batch does not mask an immediate retry");
  assert.equal(warnings, failedUpgradeWarnings + 3);
  retry.service.prewarmDetailRows(["1"]);
  database.prepare("UPDATE details SET title='Changed' WHERE id=1").run();
  assert.equal(retry.service.detailRow("1").title, "Title 1");
  retry.stamp++;
  assert.equal(retry.service.detailRow("1").title, "Changed", "stamp changes reset retained details");
  database.prepare("UPDATE details SET title='Changed again' WHERE id=1").run();
  retry.service.setRowsCache({ stamp: retry.stamp, rows: new Map() });
  assert.equal(retry.service.detailRow("1").title, "Changed again", "replacing summary rows invalidates details too");
  console.log(JSON.stringify({ ok: true, rows: 900, before: oldSnapshot, after: snapshot, batchQueries: 5, entryLimit: 2048, transientRetries: 3 }));
} finally {
  console.warn = originalWarn;
  database.close();
}

function fixture(create) {
  const target = { reads: 0, stamp: 1, fault: null };
  target.service = create({
    getStamp: () => target.stamp,
    getCoreDb: () => ({ prepare(sql) {
      assert.match(sql, /FROM works w/);
      if (target.fault === "prepare") { target.fault = null; throw new Error("controlled prepare failure"); }
      const placeholders = /w\.id IN \(([^)]+)\)/u.exec(sql)?.[1]; assert.ok(placeholders);
      const summary = sql.includes("NULL AS raw_text");
      const query = database.prepare(`SELECT CAST(id AS TEXT) AS work_id, title, ${summary ? "NULL AS raw_text, NULL AS fields_json" : "raw_text, fields_json"} FROM details WHERE id IN (${placeholders})`);
      return { all(...ids) {
        target.reads++;
        if (target.fault === "read") { target.fault = null; throw new Error("controlled read failure"); }
        return query.all(...ids);
      } };
    } }),
    displayWorkTitle: value => value, publicRemoteUrl: value => value || "", proxiedRemoteImageUrl: value => value || "",
    proxiedRemoteImageUrlArray: value => value, parseJsonArray: value => JSON.parse(value || "[]"),
    parseJsonTextArray: value => JSON.parse(value || "[]"), renderInfoMetadataText: () => "rendered"
  });
  return target;
}
async function factory(input) {
  const anchor = "    detailRow,";
  assert.equal(input.split(anchor).length, 2);
  const instrumented = input.replace(anchor, `${anchor}
    fixtureSnapshot() {
      const entries = [...(workInfoDetailCache?.rows.values() || [])];
      return { entries: entries.length, estimatedBytes: workInfoDetailCache?.bytes || 0, stringBytes: entries.reduce((bytes, entry) => {
        const row = entry && Object.hasOwn(entry, "row") ? entry.row : entry;
        return bytes + Object.values(row || {}).reduce((size, value) => size + (typeof value === "string" ? value.length * 2 : 0), 0);
      }, 0), binaryBytes: entries.reduce((bytes, entry) => {
        const row = entry && Object.hasOwn(entry, "row") ? entry.row : entry;
        return bytes + Object.values(row || {}).reduce((size, value) => size + (ArrayBuffer.isView(value) ? value.byteLength : 0), 0);
      }, 0) };
    },`).replace(/from "(\.\.?\/[^"]+)"/gu, (_, relative) => `from "${new URL(relative, serviceUrl).href}"`);
  return (await import(`data:text/javascript;base64,${Buffer.from(instrumented).toString("base64")}`)).createWorkInfoService;
}
