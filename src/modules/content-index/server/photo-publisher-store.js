import { createHash } from "node:crypto";
import { PHOTO_COLLECTION_SORTS } from "./image-library-service.js";

const collectionLocales = ["zh-CN", "en-US"];
const defaultLocale = new Intl.Collator().resolvedOptions().locale;
const collectionMembership = `
  FROM photo_publisher_members AS member
  JOIN photo_library_collections AS collection ON json_extract(collection.data_json, '$.collectionId')=member.target_id
  WHERE member.publisher_id=? AND member.kind='collection'
    AND collection.category='all' AND collection.sort=? AND collection.locale=?`;

function projectionLocale(locale) {
  let resolved = defaultLocale;
  try { if (locale) resolved = new Intl.Collator(locale).resolvedOptions().locale; }
  catch { /* Keep the default locale for invalid input. */ }
  return collectionLocales.includes(resolved) ? resolved : "en-US";
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

export function createPhotoPublisherStore({ getDb }) {
  function publisherForCollection(id) {
    const row = getDb().prepare(`SELECT publisher.id, publisher.name, publisher.code, member.label
      FROM photo_publisher_members AS member JOIN photo_publishers AS publisher ON publisher.id=member.publisher_id
      WHERE member.kind='collection' AND member.target_id=? ORDER BY publisher.id LIMIT 1`).get(id);
    if (!row) return null;
    const { label, ...publisher } = row;
    return label ? { ...publisher, collectionLabel: label } : publisher;
  }

  function readPublisherPage(id, { sort = "updated", locale, limit = 80, offset = 0 } = {}) {
    const db = getDb();
    return readSnapshot(db, () => {
      const row = db.prepare("SELECT id, name, code FROM photo_publishers WHERE id=?").get(id);
      if (!row) return null;
      const publisher = { ...row };
      const args = [id, PHOTO_COLLECTION_SORTS.includes(sort) ? sort : "updated", projectionLocale(locale)];
      const { total, totalBytes, albumCount, membership } = db.prepare(`SELECT count(*) AS total,
        coalesce(sum(json_extract(collection.data_json, '$.size')), 0) AS totalBytes,
        coalesce(sum(json_extract(collection.data_json, '$.albumCount')), 0) AS albumCount,
        json_group_array(json_array(member.target_id, member.label, member.position) ORDER BY member.target_id) AS membership
        ${collectionMembership}`).get(...args);
      const order = sort === "curated" ? "member.position, collection.position" : "collection.position";
      const items = db.prepare(`SELECT collection.data_json, member.label ${collectionMembership}
        ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, limit, offset).map(({ data_json, label }) => {
        const item = JSON.parse(data_json);
        return label ? { ...item, title: label, publisherLabel: label } : item;
      });
      const relatedVideos = db.prepare(`SELECT member.target_id, member.label, coalesce(curated.data_json, indexed.data_json) AS data_json
        FROM photo_publisher_members AS member
        LEFT JOIN photo_publisher_video_items AS curated ON curated.id=member.target_id
        LEFT JOIN gallery_media_library_items AS indexed ON indexed.id=member.target_id
        WHERE member.publisher_id=? AND member.kind='video' AND (curated.id IS NOT NULL OR indexed.id IS NOT NULL)
        ORDER BY member.position, member.target_id`).all(id).map(({ target_id, label, data_json }) => {
        const { title, ext, size, updatedAt } = JSON.parse(data_json);
        return { id: target_id, title, ext, size, updatedAt, ...(label ? { label } : {}) };
      });
      const photo = db.prepare("SELECT revision, scanned_at FROM photo_library_snapshot WHERE id=1").get();
      const media = db.prepare("SELECT revision, scanned_at FROM gallery_media_library_snapshot WHERE id=1").get();
      const listRevision = createHash("sha256").update(JSON.stringify([
        publisher, photo?.revision, media?.revision, membership, relatedVideos
      ])).digest("hex");
      return {
        publisher, items, total, stats: { ratedCount: 0, totalBytes, albumCount },
        scannedAt: photo?.scanned_at || media?.scanned_at || "", listRevision, relatedVideos
      };
    });
  }

  function videoById(id) {
    const row = getDb().prepare(`SELECT video.data_json FROM photo_publisher_video_items AS video
      WHERE video.id=? AND EXISTS (SELECT 1 FROM photo_publisher_members AS member
        WHERE member.kind='video' AND member.target_id=video.id)`).get(id);
    return row ? JSON.parse(row.data_json) : null;
  }

  function savePublisher({ id, name, code = "" }, members, videos = []) {
    const db = getDb();
    db.exec("SAVEPOINT save_photo_publisher");
    try {
      db.prepare(`INSERT INTO photo_publishers (id, name, code) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code`).run(id, name, code);
      db.prepare("DELETE FROM photo_publisher_members WHERE publisher_id=?").run(id);
      const putMember = db.prepare(`INSERT INTO photo_publisher_members (publisher_id, kind, target_id, label, position)
        VALUES (?, ?, ?, ?, ?)`);
      for (const [index, member] of members.entries()) {
        putMember.run(id, member.kind, member.targetId, member.label ?? "", member.position ?? index);
      }
      const putVideo = db.prepare(`INSERT INTO photo_publisher_video_items (id, data_json) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json`);
      for (const item of videos) putVideo.run(item.id, JSON.stringify(item));
      db.exec(`DELETE FROM photo_publisher_video_items WHERE NOT EXISTS (
        SELECT 1 FROM photo_publisher_members WHERE kind='video' AND target_id=photo_publisher_video_items.id)`);
      db.exec("RELEASE save_photo_publisher");
    } catch (error) {
      db.exec("ROLLBACK TO save_photo_publisher; RELEASE save_photo_publisher;");
      throw error;
    }
  }

  return { publisherForCollection, readPublisherPage, savePublisher, videoById };
}
