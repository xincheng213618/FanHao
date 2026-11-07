import { randomUUID } from "node:crypto";
import { imageLibraryCacheIdentity } from "./image-library-index-contract.js";
import { PHOTO_COLLECTION_SORTS } from "./image-library-service.js";

const defaultLocale = new Intl.Collator().resolvedOptions().locale;
const collectionLocales = ["zh-CN", "en-US"];

export function createPhotoLibraryStore({ getDb, archiveExts, photoSetRoots, directVideoExts, galleryMediaSources, videoExts, project }) {
  const identity = imageLibraryCacheIdentity({ archiveExts, photoSetRoots });
  const mediaIdentity = imageLibraryCacheIdentity({ directVideoExts, galleryMediaSources, videoExts });
  let cachedIndex = null;
  let cachedCollection = null;
  let cachedMedia = null;

  function header(db) {
    return db.prepare("SELECT * FROM photo_library_snapshot WHERE id=1 AND identity=?").get(identity);
  }

  function readSnapshot(read) {
    const db = getDb();
    if (db.isTransaction) return read(db);
    db.exec("BEGIN");
    try {
      const result = read(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function hasSnapshot() {
    return Boolean(revision());
  }

  function revision() {
    return getDb().prepare("SELECT revision FROM photo_library_snapshot WHERE id=1 AND identity=?").get(identity)?.revision || "";
  }

  function mediaRevision() {
    return getDb().prepare("SELECT revision FROM gallery_media_library_snapshot WHERE id=1 AND identity=?").get(mediaIdentity)?.revision || "";
  }

  function publish(index, { expectedRevision, expectedMediaRevision, photo = true, media = false } = {}) {
    if (!photo && !media) return;
    const projection = photo ? project(index, collectionLocales) : null;
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      if ((photo && expectedRevision !== undefined && revision() !== expectedRevision)
        || (media && expectedMediaRevision !== undefined && mediaRevision() !== expectedMediaRevision)) {
        throw new Error("扫描期间图库索引已更新，请重新扫描");
      }
      const publication = randomUUID();
      if (photo) writePhotos(db, index, projection, publication);
      if (media) writeMedia(db, index, publication);
      db.exec("COMMIT");
      if (photo) cachedIndex = cachedCollection = null;
      if (media) cachedMedia = null;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function writePhotos(db, index, projection, publication) {
    db.exec("DELETE FROM photo_library_archives; DELETE FROM photo_library_collections;");
    const putArchive = db.prepare("INSERT INTO photo_library_archives(id, position, collection_id, data_json) VALUES (?, ?, ?, ?)");
    for (const [position, { album, collectionId }] of projection.archives.entries()) {
      putArchive.run(album.id, position, collectionId, JSON.stringify(album));
    }
    const putCollection = db.prepare(`INSERT INTO photo_library_collections
      (category, sort, locale, position, data_json) VALUES (?, ?, ?, ?, ?)`);
    for (const { category, sort, locale, items } of projection.pages) {
      for (const [position, item] of items.entries()) {
        putCollection.run(category, sort, locale, position, JSON.stringify(item));
      }
    }
    db.prepare(`INSERT OR REPLACE INTO photo_library_snapshot
      (id, identity, revision, scanned_at, roots_json, overview_json, facets_json, scopes_json)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)`).run(identity, publication, index.scannedAt || "", JSON.stringify(index.roots || []),
      JSON.stringify(projection.overview), JSON.stringify(projection.facets), JSON.stringify(projection.scopes));
  }

  function writeMedia(db, index, publication) {
    db.exec("DELETE FROM gallery_media_library_items");
    const put = db.prepare("INSERT INTO gallery_media_library_items(id, position, media_kind, data_json) VALUES (?, ?, ?, ?)");
    for (const [position, item] of index.mediaItems.entries()) {
      put.run(item.id, position, item.mediaKind, JSON.stringify(item));
    }
    db.prepare(`INSERT OR REPLACE INTO gallery_media_library_snapshot (id, identity, revision, scanned_at, roots_json)
      VALUES (1, ?, ?, ?, ?)`).run(mediaIdentity, publication, index.scannedAt || "", JSON.stringify(index.mediaRoots || []));
  }

  function summary() {
    const state = getDb().prepare(`SELECT scanned_at, roots_json, overview_json
      FROM photo_library_snapshot WHERE id=1 AND identity=?`).get(identity);
    return state ? {
      scannedAt: state.scanned_at,
      photoRoots: JSON.parse(state.roots_json),
      ...JSON.parse(state.overview_json)
    } : null;
  }

  function collectionPage({ category, sort, locale, limit, offset }) {
    if (!PHOTO_COLLECTION_SORTS.includes(sort)) return null;
    let resolvedLocale = defaultLocale;
    try { if (locale) resolvedLocale = new Intl.Collator(locale).resolvedOptions().locale; }
    catch { /* The list uses the default collation for invalid locales. */ }
    if (!collectionLocales.includes(resolvedLocale)) return null;
    return readSnapshot(db => {
      const state = header(db);
      if (!state) return null;
      const args = [category, sort, resolvedLocale];
      const items = db.prepare(`SELECT data_json FROM photo_library_collections WHERE category=? AND sort=? AND locale=?
        AND position>=? ORDER BY position LIMIT ?`).all(...args, offset, limit).map(row => JSON.parse(row.data_json));
      const scopes = JSON.parse(state.scopes_json);
      const scope = Object.hasOwn(scopes, category) ? scopes[category] : null;
      const counts = scope?.counts[sort];
      return {
        scannedAt: state.scanned_at, listRevision: state.revision, total: counts?.total || 0, items,
        facets: { ...JSON.parse(state.facets_json), subCategories: scope?.subCategories || [] },
        stats: { ratedCount: 0, totalBytes: counts?.totalBytes || 0, albumCount: counts?.albumCount || 0 }
      };
    });
  }

  function index(collectionId = "") {
    return readSnapshot(db => {
      const state = header(db);
      if (!state) return null;
      const cached = collectionId ? cachedCollection : cachedIndex;
      if (cached?.revision === state.revision && cached.collectionId === collectionId) return cached;
      const rows = collectionId
        ? db.prepare("SELECT data_json FROM photo_library_archives WHERE collection_id=? ORDER BY position").all(collectionId)
        : db.prepare("SELECT data_json FROM photo_library_archives ORDER BY position").all();
      const value = {
        revision: state.revision, collectionId, scannedAt: state.scanned_at, roots: JSON.parse(state.roots_json),
        photoSets: rows.map(row => JSON.parse(row.data_json))
      };
      if (collectionId) cachedCollection = value;
      else cachedIndex = value;
      return value;
    });
  }

  function mediaIndex() {
    return readSnapshot(db => {
      const state = db.prepare("SELECT revision, scanned_at, roots_json FROM gallery_media_library_snapshot WHERE id=1 AND identity=?").get(mediaIdentity);
      if (!state) return null;
      if (cachedMedia?.revision === state.revision) return cachedMedia;
      cachedMedia = {
        revision: state.revision, scannedAt: state.scanned_at, mediaRoots: JSON.parse(state.roots_json),
        mediaItems: db.prepare("SELECT data_json FROM gallery_media_library_items ORDER BY position").all().map(row => JSON.parse(row.data_json))
      };
      return cachedMedia;
    });
  }

  function byId(id) {
    const row = getDb().prepare(`SELECT a.data_json FROM photo_library_snapshot s
      LEFT JOIN photo_library_archives a ON a.id=? WHERE s.id=1 AND s.identity=?`).get(id, identity);
    if (!row) return undefined;
    return row.data_json ? JSON.parse(row.data_json) : null;
  }

  return { byId, collectionPage, hasSnapshot, index, mediaIndex, mediaRevision, publish, revision, summary };
}
