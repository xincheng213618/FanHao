import { createHash, randomUUID } from "node:crypto";
import { sourceCollection } from "./photo-browse-category-store.js";

export const PHOTO_CATEGORY_COVER_MAX_BYTES = 5 * 1024 * 1024;
export const PHOTO_CATEGORY_COVER_ROUTE = "/api/image-library/photo-category-cover";

const albumCategory = "json_extract(archive.data_json, '$.category')";
const archiveTitle = "json_extract(archive.data_json, '$.title')";
const collectionPrefix = "collection:";
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");

function requestError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function validSelector(value) {
  if (typeof value !== "string" || !value || value === "all" || value.includes("\0")) return false;
  if (!value.startsWith(collectionPrefix)) return value.length <= 256;
  // Bound the percent-encoded selector so it fits in a normal HTTP request line.
  return value.length > collectionPrefix.length && Buffer.byteLength(value, "utf8") <= 4096;
}

function readUpload(data) {
  if (typeof data !== "string" || !data.length) throw requestError(400, "缺少封面图片");
  if (data.length > 4 * Math.ceil(PHOTO_CATEGORY_COVER_MAX_BYTES / 3)) throw requestError(413, "封面图片不能超过 5 MiB");
  if (data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) throw requestError(400, "封面图片编码无效");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > PHOTO_CATEGORY_COVER_MAX_BYTES) throw requestError(413, "封面图片不能超过 5 MiB");
  if (bytes.toString("base64") !== data) throw requestError(400, "封面图片编码无效");

  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, mime: "image/jpeg" };
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(pngSignature)
    && bytes.readUInt32BE(8) === 13 && bytes.toString("latin1", 12, 16) === "IHDR") return { bytes, mime: "image/png" };
  if (bytes.length >= 20 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.readUInt32LE(4) + 8 === bytes.length
    && bytes.toString("latin1", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("latin1", 12, 16))) {
    return { bytes, mime: "image/webp" };
  }
  throw requestError(415, "封面图片必须是 JPEG、PNG 或 WebP");
}

function readSnapshot(db, read) {
  if (db.isTransaction) return read();
  db.exec("BEGIN");
  try {
    const result = read();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function boundedInteger(value, fallback, min, max) {
  const number = value == null || value === "" ? NaN : Number(value);
  return Number.isSafeInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function canonicalSelectors(db, selectors) {
  return db.prepare(`SELECT input.value AS selector, CASE
    WHEN substr(input.value, 1, 8)='catalog:' OR substr(input.value, 1, 10)='publisher:'
      OR substr(input.value, 1, 11)='collection:' THEN input.value
    ELSE coalesce((SELECT 'catalog:' || category.id FROM photo_browse_categories AS category
      WHERE category.source_category=input.value ORDER BY category.position, category.id LIMIT 1), input.value)
    END AS category_key FROM json_each(?) AS input`).all(JSON.stringify(selectors));
}

function categoryScope(db, key, activePhotoRevision) {
  if (key.startsWith("catalog:")) {
    const id = key.slice("catalog:".length);
    const definition = db.prepare("SELECT source_category FROM photo_browse_categories WHERE id=?").get(id);
    if (!definition) return null;
    const categories = db.prepare(`WITH RECURSIVE scope(id, source_category) AS (
      SELECT id, source_category FROM photo_browse_categories WHERE id=?
      UNION SELECT child.id, child.source_category FROM photo_browse_categories AS child
        JOIN scope ON scope.id=child.parent_id
    ) SELECT DISTINCT source_category FROM scope WHERE source_category<>''`).all(id).map(row => row.source_category);
    return { sourceCategory: definition.source_category, where: `${albumCategory} IN (SELECT value FROM json_each(?))`,
      args: [JSON.stringify(categories)] };
  }
  if (key.startsWith("publisher:")) {
    const id = key.slice("publisher:".length);
    if (!db.prepare("SELECT 1 FROM photo_publishers WHERE id=?").get(id)) return null;
    return { where: `archive.collection_id IN (SELECT target_id FROM photo_publisher_members
      WHERE publisher_id=? AND kind='collection')`, args: [id] };
  }
  if (key.startsWith(collectionPrefix)) {
    const collectionId = key.slice(collectionPrefix.length);
    if (!activePhotoRevision || !db.prepare(`SELECT 1 FROM photo_library_archives WHERE collection_id=? LIMIT 1`).get(collectionId)) return null;
    return { collectionId, where: "archive.collection_id=?", args: [collectionId] };
  }
  if (!activePhotoRevision || !db.prepare(`SELECT 1 FROM photo_library_archives AS archive WHERE ${albumCategory}=? LIMIT 1`).get(key)) return null;
  return { sourceCategory: key, where: `${albumCategory}=?`, args: [key] };
}

function collectionCoverUrl(db, collectionId, category) {
  return db.prepare(`SELECT json_extract(data_json, '$.coverUrl') AS coverUrl FROM photo_library_collections
    WHERE category IN (?, 'all') AND sort='count' AND locale='zh-CN' AND json_extract(data_json, '$.collectionId')=?
      AND nullif(json_extract(data_json, '$.coverUrl'), '') IS NOT NULL
    ORDER BY category='all', position LIMIT 1`).get(category || "", collectionId)?.coverUrl || "";
}

export function createPhotoCategoryCoverStore({ getDb, getPhotoRevision, photoSetCoverUrl }) {
  function albumChoice(row) {
    const album = JSON.parse(row.data_json);
    const coverPath = photoSetCoverUrl(row.id);
    const coverUrl = typeof album.coverUrl === "string" && (album.coverUrl === coverPath || album.coverUrl.startsWith(`${coverPath}?`))
      ? album.coverUrl : photoSetCoverUrl(row.id, album.updatedAt);
    return { id: row.id, title: album.title || row.id, coverUrl };
  }

  function albumInScope(db, scope, id, activePhotoRevision) {
    if (!activePhotoRevision || !scope) return null;
    const row = db.prepare(`SELECT archive.id, archive.data_json FROM photo_library_archives AS archive
      WHERE archive.id=? AND ${scope.where}`).get(id, ...scope.args);
    return row ? albumChoice(row) : null;
  }

  function uploadedCoverUrl(key, version) {
    return `${PHOTO_CATEGORY_COVER_ROUTE}/image?${new URLSearchParams({ category: key, v: version })}`;
  }

  function publicOverride(db, key, row, scope, activePhotoRevision) {
    if (row?.source === "upload") return { source: "upload", coverUrl: uploadedCoverUrl(key, row.version) };
    if (row?.source === "album") {
      const album = albumInScope(db, scope, row.album_id, activePhotoRevision);
      if (album) return { source: "album", coverUrl: album.coverUrl, albumId: album.id };
    }
    return null;
  }

  function defaultSettings(db, scope, activePhotoRevision) {
    let coverUrl = "";
    if (activePhotoRevision) {
      coverUrl = sourceCollection(db, scope.sourceCategory)?.coverUrl || "";
      if (!coverUrl) {
        const row = db.prepare(`SELECT archive.id, archive.data_json, ${albumCategory} AS category FROM photo_library_archives AS archive
          WHERE ${scope.where} ORDER BY archive.position LIMIT 1`).get(...scope.args);
        if (row) coverUrl = (scope.collectionId && collectionCoverUrl(db, scope.collectionId, row.category)) || albumChoice(row).coverUrl;
      }
    }
    return { source: "default", coverUrl };
  }

  function requireScope(db, selector, activePhotoRevision) {
    if (!validSelector(selector)) throw requestError(400, "分类或合集编号无效");
    const key = canonicalSelectors(db, [selector])[0].category_key;
    const scope = categoryScope(db, key, activePhotoRevision);
    if (!scope) throw requestError(404, "分类或合集不存在");
    return { key, scope };
  }

  function read(selector, { offset, limit, q } = {}) {
    const db = getDb();
    return readSnapshot(db, () => {
      const activePhotoRevision = getPhotoRevision();
      const { key, scope } = requireScope(db, selector, activePhotoRevision);
      const row = db.prepare("SELECT source, version, album_id FROM photo_category_covers WHERE category_key=?").get(key);
      const settings = publicOverride(db, key, row, scope, activePhotoRevision) || defaultSettings(db, scope, activePhotoRevision);
      if (!activePhotoRevision) return { settings, choices: [], total: 0, nextOffset: null };
      const start = boundedInteger(offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const count = boundedInteger(limit, 16, 1, 48);
      const query = typeof q === "string" ? q.trim().slice(0, 200) : "";
      const filter = query ? ` AND instr(lower(${archiveTitle}), lower(?))>0` : "";
      const args = query ? [...scope.args, query] : scope.args;
      const from = `FROM photo_library_archives AS archive WHERE ${scope.where}${filter}`;
      const { total } = db.prepare(`SELECT count(*) AS total ${from}`).get(...args);
      const choices = start < total ? db.prepare(`SELECT archive.id, archive.data_json ${from}
        ORDER BY archive.position LIMIT ? OFFSET ?`).all(...args, count, start).map(albumChoice) : [];
      return { settings, choices, total, nextOffset: start + choices.length < total ? start + choices.length : null };
    });
  }

  function save(selector, body) {
    const source = body?.source;
    if (!["default", "album", "upload"].includes(source)) throw requestError(400, "封面来源无效");
    const albumId = body?.albumId;
    if (source === "album" && (typeof albumId !== "string" || !albumId || albumId.length > 4096)) {
      throw requestError(400, "缺少有效的套图编号");
    }
    const upload = source === "upload" ? readUpload(body.data) : null;
    const db = getDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const activePhotoRevision = getPhotoRevision();
      const { key, scope } = requireScope(db, selector, activePhotoRevision);
      let settings;
      if (source === "default") {
        db.prepare("DELETE FROM photo_category_covers WHERE category_key=?").run(key);
        settings = defaultSettings(db, scope, activePhotoRevision);
      } else {
        const album = source === "album" ? albumInScope(db, scope, albumId, activePhotoRevision) : null;
        if (source === "album" && !album) throw requestError(400, scope.collectionId ? "只能选择此合集内的套图" : "只能选择此分类内的套图");
        const version = randomUUID();
        db.prepare(`INSERT INTO photo_category_covers(category_key, source, version, album_id, mime, image)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(category_key) DO UPDATE SET source=excluded.source,
          version=excluded.version, album_id=excluded.album_id, mime=excluded.mime, image=excluded.image`)
          .run(key, source, version, album?.id ?? null, upload?.mime ?? null, upload?.bytes ?? null);
        settings = album ? { source, coverUrl: album.coverUrl, albumId: album.id }
          : { source, coverUrl: uploadedCoverUrl(key, version) };
      }
      db.exec("COMMIT");
      return settings;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function image(selector, version) {
    if (!validSelector(selector) || !/^[\da-f-]{36}$/u.test(version || "")) return null;
    const db = getDb();
    const key = canonicalSelectors(db, [selector])[0].category_key;
    return db.prepare(`SELECT mime, image FROM photo_category_covers
      WHERE category_key=? AND source='upload' AND version=?`).get(key, version) || null;
  }

  function overrides(selectors) {
    const wanted = [...new Set([...selectors].filter(validSelector))];
    if (!wanted.length) return new Map();
    const db = getDb();
    return readSnapshot(db, () => {
      const categories = canonicalSelectors(db, wanted);
      const keys = [...new Set(categories.map(row => row.category_key))];
      const rows = db.prepare(`SELECT category_key, source, version, album_id FROM photo_category_covers
        WHERE category_key IN (SELECT value FROM json_each(?))`).all(JSON.stringify(keys));
      if (!rows.length) return new Map();
      const activePhotoRevision = getPhotoRevision();
      const settings = new Map(rows.map(row => {
        const scope = row.source === "album" ? categoryScope(db, row.category_key, activePhotoRevision) : null;
        return [row.category_key, publicOverride(db, row.category_key, row, scope, activePhotoRevision)];
      }));
      return new Map(categories.map(row => [row.selector, settings.get(row.category_key)]).filter(([, setting]) => setting));
    });
  }

  function revision() {
    const rows = getDb().prepare("SELECT category_key, version FROM photo_category_covers ORDER BY category_key").all();
    return rows.length ? createHash("sha256").update(JSON.stringify(rows)).digest("hex") : "";
  }

  return { image, overrides, read, revision, save };
}
