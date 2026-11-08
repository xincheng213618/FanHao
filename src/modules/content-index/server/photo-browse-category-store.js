import { createHash } from "node:crypto";

const definitionColumns = `category.id, category.name, category.parent_id AS parentId,
  category.source_category AS sourceCategory, publisher.id AS publisherId`;
const definitionTables = `FROM photo_browse_categories AS category
  LEFT JOIN photo_browse_category_publishers AS link ON link.category_id=category.id
  LEFT JOIN photo_publishers AS publisher ON publisher.id=link.publisher_id`;

function publicDefinition(row) {
  if (!row) return null;
  const { publisherId, ...definition } = row;
  return publisherId ? { ...definition, publisherId } : definition;
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

function readState(db) {
  const row = db.prepare("SELECT revision, scanned_at, scopes_json FROM photo_library_snapshot WHERE id=1").get();
  return { revision: row?.revision || "", scannedAt: row?.scanned_at || "", scopes: JSON.parse(row?.scopes_json || "{}") };
}

function scopeCounts(scopes, category) {
  return category && Object.hasOwn(scopes, category) ? scopes[category]?.counts?.updated || null : null;
}

export function sourceCollection(db, category) {
  if (!category) return null;
  const row = db.prepare(`SELECT data_json FROM photo_library_collections
    WHERE category=? AND sort='count' AND locale='zh-CN' AND position=0`).get(category);
  return row ? JSON.parse(row.data_json) : null;
}

function hasPublisherContent(db, publisherId) {
  return Boolean(publisherId && db.prepare(`SELECT 1 FROM photo_publisher_members AS member
    WHERE publisher_id=? AND (
      (kind='collection' AND EXISTS (SELECT 1 FROM photo_library_archives WHERE collection_id=member.target_id))
      OR (kind='video' AND (EXISTS (SELECT 1 FROM photo_publisher_video_items WHERE id=member.target_id)
        OR EXISTS (SELECT 1 FROM gallery_media_library_items WHERE id=member.target_id)))
    ) LIMIT 1`).get(publisherId));
}

function siteCard(definition, parentName, counts, representative) {
  const { id, name, sourceCategory, publisherId } = definition;
  return {
    id: `browse:${id}`, type: "photoCollection", title: name, category: sourceCategory,
    subCategory: "", personName: "", seriesName: "", rootLabel: "", ext: "",
    size: counts?.totalBytes || 0, updatedAt: representative?.updatedAt || "", imageCount: 0,
    albumCount: counts?.albumCount || 0, collectionId: "", collectionTitle: name, playable: false,
    coverUrl: representative?.coverUrl || "", routePath: "", catalogCategory: parentName,
    catalogRootLabel: "", browseCategoryId: id,
    ...(publisherId ? { browsePublisherId: publisherId } : {})
  };
}

export function createPhotoBrowseCategoryStore({ getDb }) {
  function byId(id) {
    if (!id) return null;
    return publicDefinition(getDb().prepare(`SELECT ${definitionColumns} ${definitionTables} WHERE category.id=?`).get(id));
  }

  function bySourceCategory(sourceCategory) {
    if (!sourceCategory) return null;
    return publicDefinition(getDb().prepare(`SELECT ${definitionColumns} ${definitionTables}
      WHERE category.source_category=? ORDER BY category.position, category.id LIMIT 1`).get(sourceCategory));
  }

  function byPublisherId(publisherId) {
    if (!publisherId) return null;
    return publicDefinition(getDb().prepare(`SELECT ${definitionColumns} FROM photo_browse_category_publishers AS link
      JOIN photo_browse_categories AS category ON category.id=link.category_id
      JOIN photo_publishers AS publisher ON publisher.id=link.publisher_id
      WHERE link.publisher_id=?`).get(publisherId));
  }

  function hasChildren(id) {
    return Boolean(id && getDb().prepare("SELECT 1 FROM photo_browse_categories WHERE parent_id=? LIMIT 1").get(id));
  }

  function list() {
    const db = getDb();
    return readSnapshot(db, () => {
      const { scopes } = readState(db);
      const rows = db.prepare(`SELECT ${definitionColumns}, category.position ${definitionTables}
        ORDER BY category.parent_id, category.position, category.id`).all();
      const totals = new Map();
      for (const row of rows) {
        const counts = scopeCounts(scopes, row.sourceCategory);
        totals.set(row.id, { issueCount: counts?.albumCount || 0, collectionCount: counts?.total || 0 });
      }
      for (const row of rows) {
        const parent = totals.get(row.parentId);
        if (!parent) continue;
        const child = totals.get(row.id);
        parent.issueCount += child.issueCount;
        parent.collectionCount += child.collectionCount;
      }
      return rows.map(row => {
        const counts = totals.get(row.id);
        const singleCollectionId = counts.collectionCount === 1 ? sourceCollection(db, row.sourceCategory)?.collectionId : null;
        return { ...publicDefinition(row), ...counts, ...(singleCollectionId ? { singleCollectionId } : {}) };
      });
    });
  }

  function children(id, { sort, locale, limit = 80, offset = 0, loadSource } = {}) {
    if (!id) return null;
    const db = getDb();
    return readSnapshot(db, () => {
      const parent = db.prepare("SELECT name, source_category AS sourceCategory FROM photo_browse_categories WHERE id=?").get(id);
      if (!parent) return null;
      const rows = db.prepare(`SELECT ${definitionColumns}, category.position ${definitionTables}
        WHERE category.parent_id=? ORDER BY category.position, category.id`).all(id);
      if (!rows.length) return null;
      const { revision, scannedAt, scopes } = readState(db);
      const entries = rows.map(row => ({ row, counts: scopeCounts(scopes, row.sourceCategory) }))
        .filter(({ row, counts }) => counts?.albumCount > 0 || hasPublisherContent(db, row.publisherId));
      const stats = { ratedCount: 0, totalBytes: 0, albumCount: 0 };
      for (const { counts } of entries) {
        stats.totalBytes += counts?.totalBytes || 0;
        stats.albumCount += counts?.albumCount || 0;
      }
      const items = entries.slice(offset, offset + limit).map(({ row, counts }) =>
        siteCard(row, parent.name, counts, sourceCollection(db, row.sourceCategory)));
      const source = parent.sourceCategory && loadSource?.({
        category: parent.sourceCategory, sort, locale, limit: limit - items.length, offset: Math.max(0, offset - entries.length)
      });
      if (source) {
        items.push(...source.items);
        stats.totalBytes += source.stats.totalBytes;
        stats.albumCount += source.stats.albumCount;
      }
      const listRevision = createHash("sha256").update(JSON.stringify([revision, parent, entries, source?.listRevision])).digest("hex");
      return { items, total: entries.length + (source?.total || 0), stats, scannedAt, listRevision };
    });
  }

  return { byId, byPublisherId, bySourceCategory, children, hasChildren, list };
}
