// Read-only production comparison. Index experiments run only in memory.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { authorFacet, searchAuthorFacet } from "../src/modules/short-videos/server/author-facets.js";
import { ensureAuthorFacetIndex } from "../src/modules/short-videos/server/author-facet-index.js";
import { createShortVideoListPageQueries } from "../src/modules/short-videos/server/list-page-queries.js";
import { videoFilter } from "../src/modules/short-videos/server/query-contract.js";

const argument = process.argv.indexOf("--real-db");
assert(argument >= 0 && process.argv[argument + 1], "pass --real-db with a short-video SQLite path");
const source = new DatabaseSync(path.resolve(process.argv[argument + 1]), { readOnly: true });
const memory = new DatabaseSync(":memory:");
try {
  source.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 250; PRAGMA mmap_size = 268435456; PRAGMA temp_store = MEMORY; BEGIN");
  const pageQueries = createShortVideoListPageQueries({ listVideoColumns: "id, published_at, liked_at" });
  const legacyPageDb = { prepare: (sql) => source.prepare(sql.replaceAll("INDEXED BY idx_short_videos_published", "")) };
  const pageResults = [];
  for (const offset of [0, 480, 10000]) {
    const filter = videoFilter(new URLSearchParams("source=all"));
    const baseline = timed(() => pageQueries.fastFilteredVideoPage(legacyPageDb, filter, "published", 48, offset));
    const optimized = timed(() => pageQueries.fastFilteredVideoPage(source, filter, "published", 48, offset));
    assert.deepEqual(optimized.result, baseline.result, `published page and total must agree at offset ${offset}`);
    pageResults.push({ offset, baselineMs: baseline.ms, optimizedMs: optimized.ms, rows: optimized.result.rows.length });
  }
  const legacyAuthorDb = { prepare: (sql) => source.prepare(sql.replace(/FROM short_videos v(?: INDEXED BY \w+)?/, "FROM short_videos v INDEXED BY idx_short_videos_author_facet")) };
  const originalAuthors = timed(() => authorFacet(legacyAuthorDb));
  // Copy only the author query's inputs, never media files or credentials.
  copyInputs("short_videos", ["id", "visibility", "author_sec_uid", "author_name", "author_avatar_url", "owner_user_id", "author_following", "cover_source", "cover_path", "mtime_ms"]);
  copyInputs("short_video_users", ["id", "sec_uid", "nickname", "avatar_url", "profile_url", "unique_id", "total_favorited", "nickname_history_json", "total_favorited_history_json", "account_status", "account_status_reason", "account_status_detected_at"]);
  memory.exec("CREATE UNIQUE INDEX idx_fixture_users_id ON short_video_users(id)");
  const beforeIndex = timed(() => authorFacet(memory));
  ensureAuthorFacetIndex(memory);
  const indexedAuthors = timed(() => authorFacet(memory));
  assert.deepEqual(indexedAuthors.result, originalAuthors.result, "all real author fields, counts and ordering must agree on the snapshot");
  assert.deepEqual(indexedAuthors.result, beforeIndex.result, "the index must preserve the copied-data result");
  const searches = [];
  for (const query of ["音乐", "%", "_"]) {
    const baseline = timed(() => searchAuthorFacet(legacyAuthorDb, query));
    const optimized = timed(() => searchAuthorFacet(memory, query));
    assert.deepEqual(optimized.result, baseline.result, `real author search must agree: ${query}`);
    searches.push({ query, baselineMs: baseline.ms, memoryIndexedMs: optimized.ms, authors: optimized.result.length });
  }
  console.log(JSON.stringify({
    ok: true, mode: "production-read-only-and-memory-index-experiment", pages: pageResults,
    authors: { count: originalAuthors.result.length, productionLegacyMs: originalAuthors.ms, memoryBeforeIndexMs: beforeIndex.ms, memoryIndexedMs: indexedAuthors.ms },
    searches,
    limitation: "Author index timings use a narrower in-memory copy; they are not deployed HTTP or production disk measurements."
  }, null, 2));
} finally {
  memory.close();
  source.close();
}

function copyInputs(table, columns) {
  const rows = source.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all();
  memory.exec(`CREATE TABLE ${table} (${columns.join(", ")}); BEGIN`);
  const insert = memory.prepare(`INSERT INTO ${table} VALUES (${columns.map(() => "?").join(", ")})`);
  for (const row of rows) insert.run(...columns.map((column) => row[column]));
  memory.exec("COMMIT");
}

function timed(run) {
  const start = performance.now();
  const result = run();
  return { result, ms: Number((performance.now() - start).toFixed(2)) };
}
