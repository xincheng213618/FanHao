import assert from "node:assert/strict";
import { createImageLibraryService } from "../../src/modules/content-index/server/image-library-service.js";
import { createImageGalleryDbService } from "../../src/modules/content-index/server/image-gallery-db-service.js";
import { createGalleryMetadataService } from "../../src/modules/media/server/gallery-metadata-service.js";

// A real query service with private, in-memory source owners. Browser fixtures
// use its public payload as the oracle; no scanner, database or media path runs.
export function createChannelOracle({ mode = "photo", count = 100, maxItemLimit = 12000 } = {}) {
  let generation = 1, metadataGeneration = 1;
  const timestamp = index => new Date(Date.UTC(2026, 9, 4) - index * 60000).toISOString();
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `O${index + 1}`, title: `Oracle ${String(index + 1).padStart(3, "0")}`,
    category: "fixture", subCategory: "fixture", personName: "Synthetic",
    mediaKind: "tv", seriesName: `Series ${index + 1}`, updatedAt: timestamp(index),
    size: 10000, imageCount: 2, playable: true, coverUrl: `/synthetic/O${index + 1}.svg`
  }));
  let snapshot = { scannedAt: timestamp(0), photoSets: mode === "photo" ? rows : [], mediaItems: mode === "tv" ? rows : [] };
  let metadata = new Map(rows.map((row, index) => [`${row.category}|${row.seriesName}`, { title: row.title, rating: 10 - index / 100, coverUrl: row.coverUrl }]));
  const service = createImageLibraryService({
    clampInteger(value, fallback, min, max) { const number = Number.parseInt(String(value ?? ""), 10); return Math.min(max, Math.max(min, Number.isFinite(number) ? number : fallback)); },
    getImageLibraryIndex: () => snapshot, getImageLibraryRevision: () => generation,
    galleryMediaRootStatuses: () => [], photoSetRootStatuses: () => [], imageReaderCacheStatus: () => ({}),
    mangaService: { cacheDirs: () => [], publicSummary: value => value, rootStatus: () => ({ root: "", exists: false }) },
    metadataService: {
      movieRowsMap: () => new Map(), tvSeriesRowsMap: () => metadata,
      movieRow: () => null, tvSeriesRow: key => metadata.get(key),
      publicMovie: value => value, publicTvSeries: value => value,
      tvSeriesKey: (category, name) => `${category}|${name}`, listRevision: () => metadataGeneration
    },
    photoSetService: { coverUrl: id => `/synthetic/${id}.svg` }, photoCollectionRootValue: "synthetic", maxItemLimit
  });
  function payload(options = {}) {
    const url = options instanceof URL ? options : new URL(`http://fixture/api/image-library/items?${new URLSearchParams({ mode, photoView: "albums", tvView: "episodes", sort: mode === "tv" ? "rating" : "updated", limit: String(count), ...options })}`);
    return service.itemsPayload(url);
  }
  function reorder(seenId) {
    if (mode === "photo") {
      snapshot = { ...snapshot, scannedAt: `private-rescan-${++generation}`, photoSets: snapshot.photoSets.map(row => row.id === seenId ? { ...row, updatedAt: "2000-01-01T00:00:00.000Z" } : row) };
    } else {
      metadata = new Map(metadata); const row = rows.find(value => value.id === seenId || `${value.category}|${value.seriesName}` === seenId); assert(row);
      const key = `${row.category}|${row.seriesName}`;
      metadata.set(key, { ...metadata.get(key), rating: 0.1, title: "Changed private TV metadata" }); metadataGeneration++;
    }
  }
  return { payload, reorder, summary: () => service.summaryPayload({ includeCache: false }), ids: options => payload(options).items.map(row => row.id) };
}

// The actual SQLite initializer and metadata owner, for table-write boundaries.
// In-memory database only; the paths below are DTO text and are never stat/read.
export function createMetadataChannelOracle({ mode = "movie", count = 1080, maxItemLimit = 12000, sort = "updated" } = {}) {
  assert(["movie", "tv"].includes(mode));
  const database = createImageGalleryDbService({ dbPath: ":memory:", ensureDataDir() {} });
  const db = database.getDb(), sql = [];
  const owner = { prepare(statement) {
    const prepared = db.prepare(statement);
    return {
      get(...args) { sql.push(statement); return prepared.get(...args); },
      all(...args) { sql.push(statement); return prepared.all(...args); }
    };
  } };
  const metadata = createGalleryMetadataService({ createId: (_prefix, key) => key, getImageGalleryDb: () => owner, notFound() {} });
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `O${index + 1}`, title: `Oracle ${String(index + 1).padStart(4, "0")}`,
    category: "fixture", subCategory: "fixture", personName: `Series ${index + 1}`, seriesName: `Series ${index + 1}`,
    mediaKind: mode, size: 10000, playable: true,
    updatedAt: new Date(Date.UTC(2026, 9, 4) - index * 60000).toISOString()
  }));
  const insert = db.prepare(mode === "movie"
    ? "INSERT INTO movie_metadata(media_id,movie_title,douban_title,status,cover_blob,rating,updated_at) VALUES(?,?,?,?,?,?,?)"
    : "INSERT INTO tv_series_metadata(series_key,series_name,douban_title,status,cover_blob,rating,updated_at) VALUES(?,?,?,?,?,?,?)");
  rows.forEach((row, index) => insert.run(mode === "movie" ? row.id : `fixture|${row.seriesName}`, mode === "movie" ? row.title : row.seriesName, row.title, "ok", Buffer.from("private synthetic JPEG"), 10 - index / (count + 1), row.updatedAt));
  const index = { scannedAt: "private-fixed-index", photoSets: [], mediaItems: rows };
  const service = createImageLibraryService({
    clampInteger(value, fallback, min, max) { const parsed = Number.parseInt(String(value ?? ""), 10); return Math.min(max, Math.max(min, Number.isFinite(parsed) ? parsed : fallback)); },
    getImageLibraryIndex: () => index, getImageLibraryRevision: () => 1,
    galleryMediaRootStatuses: () => [], photoSetRootStatuses: () => [], imageReaderCacheStatus: () => ({}),
    mangaService: { cacheDirs: () => [], publicSummary: value => value, rootStatus: () => ({ root: "", exists: false }) },
    metadataService: metadata, photoSetService: { coverUrl: () => "" }, photoCollectionRootValue: "synthetic", maxItemLimit
  });
  function payload(options = {}) {
    const url = options instanceof URL ? options : new URL(`http://fixture/api/image-library/items?${new URLSearchParams({ mode, sort, limit: String(count), ...options })}`);
    return service.itemsPayload(url);
  }
  function updateMetadata(id, { title = null, rating = null } = {}) {
    const table = mode === "movie" ? "movie_metadata" : "tv_series_metadata", key = mode === "movie" ? "media_id" : "series_key";
    if (title !== null) db.prepare(`UPDATE ${table} SET douban_title = ? WHERE ${key} = ?`).run(title, id);
    if (rating !== null) db.prepare(`UPDATE ${table} SET rating = ? WHERE ${key} = ?`).run(rating, id);
  }
  return {
    payload, ids: options => payload(options).items.map(row => row.id), close: () => database.close(), sql,
    coverWrite(id = "O1") { db.prepare("INSERT INTO gallery_media_covers(media_id,source_path,cover_blob,status,generated_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(media_id) DO UPDATE SET cover_blob=excluded.cover_blob,updated_at=excluded.updated_at").run(id, "synthetic-not-read.mp4", Buffer.from("private cover"), "ok", "private-now", "private-now"); },
    updateMetadata, reorder: id => updateMetadata(id, { rating: 0.1 }),
    mergeSeries(fromId, intoId) {
      assert.equal(mode, 'tv'); const target = rows.find(row => row.id === intoId); assert(target);
      index.mediaItems = index.mediaItems.map(row => row.id === fromId ? { ...row, seriesName: target.seriesName, personName: target.personName } : row);
    },
    otherKindWrite() {
      if (mode === "movie") db.prepare("INSERT INTO tv_series_metadata(series_key,series_name,status,updated_at) VALUES(?,?,?,?)").run("unrelated", "unrelated", "ok", "private-now");
      else db.prepare("INSERT INTO movie_metadata(media_id,movie_title,status,updated_at) VALUES(?,?,?,?)").run("unrelated", "unrelated", "ok", "private-now");
    }
  };
}

export async function restrictPrivateNetwork(page, base, unexpected) {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(base).origin || ["data:", "blob:"].includes(url.protocol)) return route.continue();
    unexpected.push(`blocked external request: ${url.origin}${url.pathname}`);
    await route.abort("blockedbyclient");
  });
}
