import { randomUUID } from "node:crypto";
import path from "node:path";
import { ARCHIVE_IMAGE_INDEXER_VERSION } from "../../../platform/server/archive-image-service.js";
import { safeChildPath } from "../../../platform/server/request-io.js";
import { imageLibraryCacheIdentity } from "./image-library-index-contract.js";
import { PHOTO_COLLECTION_SORTS, photoShelfCollectionScope, photoSortIsReversed } from "./image-library-service.js";
import { BOBO_SOCKS_CATEGORY } from "./photo-album-number.js";
import { PHOTO_PERSON_SHELF_CATEGORY } from "../../../../lib/photo-person-shelf.js";

const defaultLocale = new Intl.Collator().resolvedOptions().locale;
const collectionLocales = ["zh-CN", "en-US"];

function contentImageCount(row) {
  if (!Number.isSafeInteger(row.image_count) || row.image_count < 0 || !Number.isFinite(row.archive_mtime_ms)) return null;
  try {
    const signature = JSON.parse(row.archive_identity);
    if (!Array.isArray(signature) || signature.length !== 5 || signature[0] !== row.archive_path
      || signature[1] !== row.archive_size || signature[2] !== row.archive_mtime_ms
      || typeof signature[3] !== "string" || typeof signature[4] !== "string") return null;

    const images = JSON.parse(row.images_json);
    if (!Array.isArray(images) || images.length !== row.image_count) return null;
    let count = images.length;
    for (const image of images) {
      if (typeof image?.path !== "string" || image.path.includes("\0")) return null;
      const basename = image.path.split(/[\\/]/).at(-1);
      if (!basename?.trim() || basename === "." || basename === "..") return null;
      if (basename.toLowerCase() === "cover.jpg") count--;
    }
    return count;
  } catch {
    return null;
  }
}

export function createPhotoLibraryStore({ getDb, archiveExts, photoSetRoots, directVideoExts, galleryMediaSources, videoExts, project }) {
  const identity = imageLibraryCacheIdentity({ archiveExts, photoSetRoots });
  const mediaIdentity = imageLibraryCacheIdentity({ directVideoExts, galleryMediaSources, videoExts });
  let cachedIndex = null;
  let cachedCollection = null;
  let cachedCategory = null;
  let cachedPerson = null;
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

  function summary({ allCategories = false } = {}) {
    const state = getDb().prepare(`SELECT scanned_at, roots_json, overview_json${allCategories ? ", facets_json" : ""}
      FROM photo_library_snapshot WHERE id=1 AND identity=?`).get(identity);
    if (!state) return null;
    const overview = JSON.parse(state.overview_json);
    if (allCategories) overview.facets.categories = JSON.parse(state.facets_json).categories;
    return {
      scannedAt: state.scanned_at,
      photoRoots: JSON.parse(state.roots_json),
      ...overview
    };
  }

  function collectionPage({ category, sort, direction, locale, limit, offset, excludedSubCategories = [] }) {
    if (!PHOTO_COLLECTION_SORTS.includes(sort)) return null;
    let resolvedLocale = defaultLocale;
    try { if (locale) resolvedLocale = new Intl.Collator(locale).resolvedOptions().locale; }
    catch { /* The list uses the default collation for invalid locales. */ }
    if (!collectionLocales.includes(resolvedLocale)) return null;
    return readSnapshot(db => {
      const state = header(db);
      if (!state) return null;
      const args = [category, sort, resolvedLocale];
      const scopes = JSON.parse(state.scopes_json);
      const scope = Object.hasOwn(scopes, category) ? scopes[category] : null;
      let counts = scope?.counts[sort];
      const reverse = photoSortIsReversed(sort, direction);
      const source = "FROM photo_library_collections WHERE category=? AND sort=? AND locale=?";
      let rows;
      if (excludedSubCategories.length) {
        const remaining = `${source} AND coalesce(json_extract(data_json, '$.subCategory'), '') NOT IN (SELECT value FROM json_each(?))`;
        const scopeArgs = [...args, JSON.stringify(excludedSubCategories)];
        counts = db.prepare(`SELECT count(*) total, sum(json_extract(data_json, '$.size')) totalBytes,
          sum(json_extract(data_json, '$.albumCount')) albumCount ${remaining}`).get(...scopeArgs);
        rows = db.prepare(`SELECT data_json ${remaining} ORDER BY position ${reverse ? "DESC" : "ASC"} LIMIT ? OFFSET ?`)
          .all(...scopeArgs, limit, offset);
      } else {
        const position = reverse ? (counts?.total || 0) - offset - 1 : offset;
        const positionOrder = reverse ? "position<=? ORDER BY position DESC" : "position>=? ORDER BY position";
        rows = db.prepare(`SELECT data_json ${source} AND ${positionOrder} LIMIT ?`).all(...args, position, limit);
      }
      const items = rows.map(row => JSON.parse(row.data_json));
      return {
        scannedAt: state.scanned_at, listRevision: excludedSubCategories.length ? `${state.revision}:${JSON.stringify(excludedSubCategories)}` : state.revision,
        total: counts?.total || 0, items,
        facets: { ...JSON.parse(state.facets_json), subCategories: (scope?.subCategories || [])
          .filter(entry => !excludedSubCategories.includes(entry.value)) },
        stats: { ratedCount: 0, totalBytes: counts?.totalBytes || 0, albumCount: counts?.albumCount || 0 }
      };
    });
  }

  function coverWarmPlan() {
    return readSnapshot(db => {
      if (!header(db)) return null;
      const groups = new Map(db.prepare(`SELECT json_extract(data_json, '$.id') AS id,
        json_extract(data_json, '$.title') AS title FROM photo_library_collections
        WHERE category='all' AND sort='count' AND locale='zh-CN' ORDER BY position`).all()
        .map(({ id, title }) => [id, { title, albums: [] }]));
      for (const row of db.prepare(`SELECT id, collection_id, json_extract(data_json, '$.subCategory') AS sub_category,
        json_extract(data_json, '$.category') AS category FROM photo_library_archives ORDER BY position`).iterate()) {
        if (!groups.has(row.collection_id)) {
          groups.set(row.collection_id, { title: row.sub_category || row.category || "未归类套图", albums: [] });
        }
        groups.get(row.collection_id).albums.push(row.id);
      }
      return [...groups.values()].filter(group => group.albums.length);
    });
  }

  function index(collectionId = "") {
    return readSnapshot(db => {
      const state = header(db);
      if (!state) return null;
      const cached = collectionId ? cachedCollection : cachedIndex;
      if (cached?.revision === state.revision && cached.collectionId === collectionId) return cached;
      const shelf = photoShelfCollectionScope(collectionId);
      const rows = shelf ? db.prepare(`SELECT data_json FROM photo_library_archives
        WHERE json_extract(data_json, '$.category')=? AND json_extract(data_json, '$.subCategory')=?
          AND json_extract(data_json, '$.sourceRoot')=? ORDER BY position`).all(shelf.category, shelf.subCategory, shelf.sourceRoot)
        : collectionId
        ? db.prepare("SELECT data_json FROM photo_library_archives WHERE collection_id=? ORDER BY position").all(collectionId)
        : db.prepare("SELECT data_json FROM photo_library_archives ORDER BY position").all();
      const value = {
        revision: state.revision, collectionId, scannedAt: state.scanned_at, roots: JSON.parse(state.roots_json),
        photoSets: rows.map(row => {
          const album = JSON.parse(row.data_json);
          return shelf ? { ...album, collectionId } : album;
        })
      };
      if (collectionId) cachedCollection = value;
      else cachedIndex = value;
      return value;
    });
  }

  function indexForCategory(category) {
    return readSnapshot(db => {
      const state = header(db);
      if (!state) return null;
      if (cachedCategory?.revision === state.revision && cachedCategory.category === category) return cachedCategory;
      const photoSets = db.prepare(`SELECT data_json FROM photo_library_archives
        WHERE json_extract(data_json, '$.category')=? ORDER BY position`).all(category).map(row => JSON.parse(row.data_json));
      const scopes = JSON.parse(state.scopes_json);
      const subCategories = Object.hasOwn(scopes, category) ? scopes[category].subCategories : [];
      cachedCategory = { category, revision: state.revision, scannedAt: state.scanned_at, photoSets,
        facets: { ...JSON.parse(state.facets_json), subCategories } };
      return cachedCategory;
    });
  }

  function indexForPerson(person) {
    return readSnapshot(db => {
      const state = header(db);
      if (!state) return null;
      if (cachedPerson?.revision === state.revision && cachedPerson.person === person) return cachedPerson;
      const facets = JSON.parse(state.facets_json);
      const subCategories = JSON.parse(state.scopes_json)?.all?.subCategories;
      if (!Array.isArray(facets?.categories) || !Array.isArray(facets.people) || !Array.isArray(subCategories)) return null;

      // Only these categories can derive other names from the folder or title.
      // Keep them as candidates and leave the exact person match to the service.
      const rows = db.prepare(`SELECT data_json FROM photo_library_archives
        WHERE instr(json_extract(data_json, '$.personName'), ?) > 0
          OR json_type(data_json, '$.personName') NOT IN ('text', 'null')
          OR json_extract(data_json, '$.category') IN (?, ?) ORDER BY position`)
        .all(person, BOBO_SOCKS_CATEGORY, PHOTO_PERSON_SHELF_CATEGORY);
      cachedPerson = { person, collectionId: "", revision: state.revision, scannedAt: state.scanned_at,
        photoSets: rows.map(row => JSON.parse(row.data_json)), personFacets: { ...facets, subCategories } };
      return cachedPerson;
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

  function archiveMarks(ids) {
    if (!ids.length) return new Set();
    const rows = getDb().prepare(`SELECT mark.album_id FROM json_each(?) requested
      CROSS JOIN photo_library_archive_marks mark ON mark.album_id=requested.value`);
    return new Set(rows.all(JSON.stringify(ids)).map(row => row.album_id));
  }

  function setArchiveMarkedA(id, markedA) {
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const exists = db.prepare(`SELECT a.id FROM photo_library_snapshot s
        CROSS JOIN photo_library_archives a ON a.id=? WHERE s.id=1 AND s.identity=?`).get(id, identity);
      if (exists) {
        const sql = markedA
          ? "INSERT OR IGNORE INTO photo_library_archive_marks(album_id) VALUES(?)"
          : "DELETE FROM photo_library_archive_marks WHERE album_id=?";
        db.prepare(sql).run(id);
      }
      db.exec("COMMIT");
      return exists ? { id, markedA } : null;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function contentImageCounts(ids, expectedRevision = null) {
    const counts = new Map();
    const wanted = [...new Set(ids)].filter(id => typeof id === "string" && id.length > 0);
    if (!wanted.length) return counts;

    return readSnapshot(db => {
      const archives = db.prepare(`SELECT a.id, a.data_json FROM photo_library_snapshot s
        CROSS JOIN json_each(?) requested JOIN photo_library_archives a ON a.id=requested.value
        WHERE s.id=1 AND s.identity=? AND (? IS NULL OR s.revision=?)`);
      const targets = [];
      for (const row of archives.iterate(JSON.stringify(wanted), identity, expectedRevision, expectedRevision)) {
        let album;
        try { album = JSON.parse(row.data_json); } catch { continue; }
        const { sourceRoot, relativePath, archiveIdentity, size, updatedAt } = album ?? {};
        if (typeof sourceRoot !== "string" || !path.isAbsolute(sourceRoot) || typeof relativePath !== "string"
          || !relativePath || path.isAbsolute(relativePath) || !Number.isSafeInteger(size) || size < 0
          || (archiveIdentity != null && typeof archiveIdentity !== "string") || typeof updatedAt !== "string") continue;
        const archivePath = safeChildPath(sourceRoot, relativePath);
        const modifiedAt = Date.parse(updatedAt);
        if (archivePath && !archivePath.includes("\0") && Number.isFinite(modifiedAt)) {
          targets.push([row.id, archivePath, archiveIdentity || "", size, modifiedAt]);
        }
      }
      if (!targets.length) return counts;

      // Both joins are key lookups for the current page. The fallback is for
      // imported snapshots that only recorded file size and an ISO mtime.
      const indexed = db.prepare(`SELECT json_extract(target.value,'$[0]') AS id,
          i.archive_path, i.archive_identity, i.archive_size, i.archive_mtime_ms, i.image_count, i.images_json
        FROM json_each(?) target JOIN photo_set_image_indexes i ON i.archive_path=json_extract(target.value,'$[1]')
        WHERE i.indexer_version=? AND i.archive_size=json_extract(target.value,'$[3]')
          AND cast(i.archive_mtime_ms AS INTEGER)=json_extract(target.value,'$[4]')
          AND (json_extract(target.value,'$[2]')='' OR i.archive_identity=json_extract(target.value,'$[2]'))`);
      for (const row of indexed.iterate(JSON.stringify(targets), ARCHIVE_IMAGE_INDEXER_VERSION)) {
        const count = contentImageCount(row);
        if (count !== null) counts.set(row.id, count);
      }
      return counts;
    });
  }

  return { archiveMarks, byId, collectionPage, contentImageCounts, coverWarmPlan, hasSnapshot, index, indexForCategory, indexForPerson, mediaIndex, mediaRevision, publish, revision, setArchiveMarkedA, summary };
}
