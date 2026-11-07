import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ACTOR_MOVIE_CACHE_TABLES, ACTOR_MOVIE_INFO_CACHE_TABLES, ACTOR_PROFILE_CACHE_TABLES, cacheDependencyTables, compositeTableStamp } from "../src/modules/fanhao/server/library/cache-contracts.js";
import { createPeopleScopeService } from "../src/modules/fanhao/server/people/people-scope-service.js";
import { createImageLibraryIndexService } from "../src/modules/content-index/server/image-library-index-service.js";
import { createImageGalleryDbService } from "../src/modules/content-index/server/image-gallery-db-service.js";
import { createImageLibraryService } from "../src/modules/content-index/server/image-library-service.js";
import { createPhotoLibraryStore } from "../src/modules/content-index/server/photo-library-store.js";
import { CURRENT_INDEX_SCHEMA, PARSER_VERSION } from "../src/modules/content-index/server/image-library-index-contract.js";
import { createCoreDbService } from "../src/modules/fanhao/server/library/core-db-service.js";
import { removeVerifiedTempDir } from "./verified-temp-cleanup.mjs";

assert.deepEqual(
  cacheDependencyTables("actor_movies"),
  ACTOR_MOVIE_CACHE_TABLES,
  "actor movie invalidation must cover every table read by its SQL"
);
assert.deepEqual(
  ACTOR_MOVIE_INFO_CACHE_TABLES,
  ["work_people", "works", "work_external_refs"],
  "local metadata enrichment must ignore image/person presentation tables and invalidate for every selected metadata table"
);
const coreDbSource = fs.readFileSync(path.resolve("src/modules/fanhao/server/library/core-db-service.js"), "utf8");
for (const table of ["person_external_refs", "work_external_refs", "person_aliases"]) {
  assert(coreDbSource.includes(`idx_${table}_updated_at ON ${table}(updated_at)`), `${table} stamps must use an updated-at index`);
}
assert.deepEqual(
  cacheDependencyTables("actor_profiles"),
  ACTOR_PROFILE_CACHE_TABLES,
  "actor profile invalidation must cover refs, aliases, and avatars"
);
for (const table of ACTOR_MOVIE_CACHE_TABLES) {
  const before = compositeTableStamp((value) => `${value}:before`, ACTOR_MOVIE_CACHE_TABLES);
  const after = compositeTableStamp((value) => value === table ? `${value}:after` : `${value}:before`, ACTOR_MOVIE_CACHE_TABLES);
  assert.notEqual(after, before, `actor movie stamp must change when ${table} changes`);
}
for (const table of ACTOR_PROFILE_CACHE_TABLES) {
  const before = compositeTableStamp((value) => `${value}:before`, ACTOR_PROFILE_CACHE_TABLES);
  const after = compositeTableStamp((value) => value === table ? `${value}:after` : `${value}:before`, ACTOR_PROFILE_CACHE_TABLES);
  assert.notEqual(after, before, `actor profile stamp must change when ${table} changes`);
}

let synchronousStampReads = 0;
const stampedTables = [];
const stampDb = {
  exec() {},
  prepare(sql) {
    if (sql.startsWith("PRAGMA table_info")) {
      return { all: () => [
        { name: "gender" }, { name: "has_magnet" }, { name: "is_streamable" },
        { name: "has_subtitles" }, { name: "javdb_tags_json" }
      ] };
    }
    return {
      get: () => {
        synchronousStampReads += 1;
        stampedTables.push(sql);
        return { row_count: 1, max_rowid: 1, max_updated_at: "v1" };
      },
      all: () => [],
      run: () => ({ changes: 1 })
    };
  }
};
const stampService = createCoreDbService({
  createDatabase: () => stampDb, dbPath: "cache-contracts.sqlite", imageDbPath: "cache-contracts-images.sqlite",
  ensureDataDir() {}, now: () => 0, tableStampCacheMs: 5_000, warn() {}
});
compositeTableStamp(stampService.tableDataStamp, ACTOR_MOVIE_CACHE_TABLES);
compositeTableStamp(stampService.tableDataStamp, ACTOR_PROFILE_CACHE_TABLES);
assert.equal(synchronousStampReads, new Set([...ACTOR_MOVIE_CACHE_TABLES, ...ACTOR_PROFILE_CACHE_TABLES]).size, `combined stamps must establish one indexed baseline per unique dependency table: ${stampedTables.join(", ")}`);
const warmStampStart = performance.now();
for (let index = 0; index < 5_000; index += 1) {
  compositeTableStamp(stampService.tableDataStamp, ACTOR_MOVIE_CACHE_TABLES);
  compositeTableStamp(stampService.tableDataStamp, ACTOR_PROFILE_CACHE_TABLES);
}
const warmStampMs = performance.now() - warmStampStart;
assert.equal(synchronousStampReads, new Set([...ACTOR_MOVIE_CACHE_TABLES, ...ACTOR_PROFILE_CACHE_TABLES]).size, "warm combined stamps must not query SQLite again before the five-second background refresh window");
console.log(`cache-index-contracts: warm-stamps-5000=${warmStampMs.toFixed(1)}ms, sync-sql=${synchronousStampReads}`);

let scopeRevision = "merge-1";
const scopeLibrary = {
  scannedAt: "scan-1",
  people: [{ id: "person-1", works: ["work-1"] }],
  worksById: new Map([["work-1", { id: "work-1", relativePath: "D:/main/item" }]]),
  totals: { videos: 1, images: 0, infoFiles: 0 }
};
const scope = createPeopleScopeService({
  getLibrary: () => scopeLibrary,
  getRevision: () => scopeRevision,
  mergedPersonRecord: (person) => person,
  pathWithinRoot: (value, root) => String(value).toLowerCase().startsWith(String(root).toLowerCase()),
  sourcePathToAbsolute: (value) => value,
  westernRoots: ["R:/"]
});
const firstScopeKey = scope.cacheKey();
assert.equal(scope.workMatches(scopeLibrary.worksById.get("work-1"), "western"), false);
scopeLibrary.worksById.set("work-1", { id: "work-1", relativePath: "R:/western/item" });
scope.invalidate();
assert.equal(scope.workMatches(scopeLibrary.worksById.get("work-1"), "western"), true, "same-count path changes must publish through the cheap explicit revision");
scopeRevision = "merge-2";
assert.notEqual(scope.cacheKey(), firstScopeKey, "merge revision must participate in the scope cache identity");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fanhao-index-contract-"));
const galleryDb = createImageGalleryDbService({ dbPath: path.join(tempDir, "gallery.sqlite"), ensureDataDir() {} });
try {
  const rootA = path.join(tempDir, "root-a");
  const rootB = path.join(tempDir, "root-b");
  fs.mkdirSync(rootA, { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  fs.writeFileSync(path.join(rootA, "a.zip"), "a");
  fs.writeFileSync(path.join(rootB, "b.zip"), "b");
  const serviceFor = (photoSetRoots, archiveExts = new Set([".zip"]), photoLibraryStore) => createImageLibraryIndexService({
    archiveExts, createId: (prefix, value) => `${prefix}:${value}`,
    directVideoExts: new Set([".mp4"]), galleryMediaSources: [], photoLibraryStore,
    isExcludedDirName: () => false, isVideo: () => false, normalizeExt: (value) => path.extname(value).toLowerCase(),
    photoSetCoverUrl: () => "", photoSetRoots,
    safeStat: (value) => { try { return fs.statSync(value); } catch { return null; } }, videoExts: new Set([".mp4"])
  });
  const project = createImageLibraryService({ photoCollectionRootValue: "__root__", photoSetService: { coverUrl: () => "" } }).projectPhotoIndex;
  const storeFor = (photoSetRoots, archiveExts = [".zip"]) => createPhotoLibraryStore({
    getDb: galleryDb.getDb, photoSetRoots, archiveExts, project
  });
  const first = serviceFor([rootA]).scanImageLibrary();
  assert.equal(first.schemaVersion, CURRENT_INDEX_SCHEMA);
  assert.equal(first.parserVersion, PARSER_VERSION);
  assert.equal(first.photoSets[0].title, "a");
  const store = storeFor([rootA]);
  store.publish(first);
  assert.equal(serviceFor([rootA], undefined, store).getIndex().photoSets[0].title, "a");
  assert.equal(storeFor([rootB]).index(), null, "different configured roots reject the published index");
  assert.equal(storeFor([rootA], [".cbz"]).index(), null, "archive extension changes reject cached parser output");
  galleryDb.getDb().prepare("UPDATE photo_library_snapshot SET identity=json_set(identity,'$.parserVersion',?) WHERE id=1").run(PARSER_VERSION - 1);
  assert.equal(store.index(), null, "an older parser publication is rejected");
  assert.deepEqual(serviceFor([rootA], undefined, store).getIndex().photoSets, [], "an invalid snapshot waits for a background publication");
  console.log("cache-index-contracts: ok");
} finally {
  galleryDb.close();
  removeVerifiedTempDir(tempDir);
}
