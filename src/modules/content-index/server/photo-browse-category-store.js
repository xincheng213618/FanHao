import { createHash } from "node:crypto";

const definitionColumns = "id, name, parent_id AS parentId, source_category AS sourceCategory";

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

function sourceCollection(db, category) {
  if (!category) return null;
  const row = db.prepare(`SELECT data_json FROM photo_library_collections
    WHERE category=? AND sort='count' AND locale='zh-CN' AND position=0`).get(category);
  return row ? JSON.parse(row.data_json) : null;
}

function siteCard(definition, parentName, counts, representative) {
  const { id, name, sourceCategory } = definition;
  return {
    id: `browse:${id}`, type: "photoCollection", title: name, category: sourceCategory,
    subCategory: "", personName: "", seriesName: "", rootLabel: "", ext: "",
    size: counts?.totalBytes || 0, updatedAt: representative?.updatedAt || "", imageCount: 0,
    albumCount: counts?.albumCount || 0, collectionId: "", collectionTitle: name, playable: false,
    coverUrl: representative?.coverUrl || "", routePath: "", catalogCategory: parentName,
    catalogRootLabel: "", browseCategoryId: id
  };
}

export function createPhotoBrowseCategoryStore({ getDb }) {
  function byId(id) {
    if (!id) return null;
    const row = getDb().prepare(`SELECT ${definitionColumns} FROM photo_browse_categories WHERE id=?`).get(id);
    return row ? { ...row } : null;
  }

  function bySourceCategory(sourceCategory) {
    if (!sourceCategory) return null;
    const row = getDb().prepare(`SELECT ${definitionColumns} FROM photo_browse_categories
      WHERE source_category=? ORDER BY position, id LIMIT 1`).get(sourceCategory);
    return row ? { ...row } : null;
  }

  function list() {
    const db = getDb();
    return readSnapshot(db, () => {
      const { scopes } = readState(db);
      const rows = db.prepare(`SELECT ${definitionColumns}, position FROM photo_browse_categories
        ORDER BY parent_id, position, id`).all();
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
        return { ...row, ...counts, ...(singleCollectionId ? { singleCollectionId } : {}) };
      });
    });
  }

  function children(id, { limit = 80, offset = 0 } = {}) {
    if (!id) return null;
    const db = getDb();
    return readSnapshot(db, () => {
      const parent = db.prepare("SELECT name FROM photo_browse_categories WHERE id=?").get(id);
      if (!parent) return null;
      const rows = db.prepare(`SELECT ${definitionColumns}, position FROM photo_browse_categories
        WHERE parent_id=? ORDER BY position, id`).all(id);
      if (!rows.length) return null;
      const { revision, scannedAt, scopes } = readState(db);
      const entries = rows.map(row => ({ row, counts: scopeCounts(scopes, row.sourceCategory) }));
      const stats = { ratedCount: 0, totalBytes: 0, albumCount: 0 };
      for (const { counts } of entries) {
        stats.totalBytes += counts?.totalBytes || 0;
        stats.albumCount += counts?.albumCount || 0;
      }
      const items = entries.slice(offset, offset + limit).map(({ row, counts }) =>
        siteCard(row, parent.name, counts, sourceCollection(db, row.sourceCategory)));
      const listRevision = createHash("sha256").update(JSON.stringify([revision, parent.name, rows])).digest("hex");
      return { items, total: rows.length, stats, scannedAt, listRevision };
    });
  }

  return { byId, bySourceCategory, children, list };
}
