import { createHash } from "node:crypto";

const definitionColumns = `category.id, category.name, category.parent_id AS parentId,
  category.source_category AS sourceCategory, publisher.id AS publisherId,
  folder.source_category AS folderCategory, folder.sub_category AS folderSubCategory`;
const definitionTables = `FROM photo_browse_categories AS category
  LEFT JOIN photo_browse_category_publishers AS link ON link.category_id=category.id
  LEFT JOIN photo_publishers AS publisher ON publisher.id=link.publisher_id
  LEFT JOIN photo_browse_category_folders AS folder ON folder.category_id=category.id`;

function publicDefinition(row) {
  if (!row) return null;
  const { publisherId, folderCategory, folderSubCategory, ...definition } = row;
  return {
    ...definition,
    ...(publisherId ? { publisherId } : {}),
    ...(folderCategory ? { folder: { category: folderCategory, subCategory: folderSubCategory } } : {})
  };
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
  const { id, name, sourceCategory, publisherId, folderCategory } = definition;
  return {
    id: `browse:${id}`, type: "photoCollection", title: name, category: folderCategory || sourceCategory,
    subCategory: "", personName: "", seriesName: "", rootLabel: "", ext: "",
    size: counts?.totalBytes || 0, updatedAt: representative?.updatedAt || "", imageCount: 0,
    albumCount: counts?.albumCount || 0, collectionId: "", collectionTitle: name, playable: false,
    coverUrl: representative?.coverUrl || "", routePath: "", catalogCategory: parentName,
    catalogRootLabel: "", browseCategoryId: id,
    ...(publisherId ? { browsePublisherId: publisherId } : {})
  };
}

export function createPhotoBrowseCategoryStore({ getDb }) {
  let folderCache = null;

  function folderCounts(db, revision, category) {
    if (folderCache?.db !== db || folderCache?.revision !== revision) {
      folderCache = { db, revision, categories: new Map() };
    }
    let counts = folderCache.categories.get(category);
    if (!counts) {
      const rows = db.prepare(`SELECT coalesce(json_extract(data_json, '$.subCategory'), '') AS subCategory,
        count(*) AS albumCount, coalesce(sum(json_extract(data_json, '$.size')), 0) AS totalBytes,
        count(DISTINCT collection_id) AS collectionCount,
        count(DISTINCT coalesce(json_extract(data_json, '$.sourceRoot'), json_extract(data_json, '$.rootLabel'), '')) AS rootCount
        FROM photo_library_archives WHERE json_extract(data_json, '$.category')=? GROUP BY subCategory`).all(category);
      counts = new Map(rows.map(row => [row.subCategory, row]));
      folderCache.categories.set(category, counts);
    }
    return counts;
  }

  function categoryCounts(db, state, row, assignedFolders) {
    if (row.folderCategory) {
      const folder = folderCounts(db, state.revision, row.folderCategory).get(row.folderSubCategory);
      return folder ? { ...folder, total: folder.rootCount } : null;
    }
    const counts = scopeCounts(state.scopes, row.sourceCategory);
    const assigned = assignedFolders.get(row.sourceCategory);
    if (!counts || !assigned?.size) return counts;
    const folders = folderCounts(db, state.revision, row.sourceCategory);
    const remaining = { ...counts };
    for (const name of assigned) {
      const moved = folders.get(name);
      if (!moved) continue;
      remaining.albumCount -= moved.albumCount;
      remaining.totalBytes -= moved.totalBytes;
      remaining.total -= moved.collectionCount;
    }
    if (row.sourceCategory === "萝莉系列") {
      remaining.total = [...folders.values()].reduce((total, folder) =>
        total + (assigned.has(folder.subCategory) ? 0 : folder.rootCount), 0);
    }
    return remaining;
  }

  function assignedFoldersByCategory(db) {
    const scopes = new Map();
    for (const row of db.prepare("SELECT source_category, sub_category FROM photo_browse_category_folders").all()) {
      if (!scopes.has(row.source_category)) scopes.set(row.source_category, new Set());
      scopes.get(row.source_category).add(row.sub_category);
    }
    return scopes;
  }

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
    return publicDefinition(getDb().prepare(`SELECT ${definitionColumns} ${definitionTables}
      WHERE publisher.id=?`).get(publisherId));
  }

  function byFolder(category, subCategory) {
    if (!category || !subCategory) return null;
    return publicDefinition(getDb().prepare(`SELECT ${definitionColumns} ${definitionTables}
      WHERE folder.source_category=? AND folder.sub_category=?`).get(category, subCategory));
  }

  function folderSubCategories(category) {
    if (!category) return [];
    return getDb().prepare(`SELECT sub_category FROM photo_browse_category_folders WHERE source_category=?
      ORDER BY sub_category`).all(category).map(row => row.sub_category);
  }

  function hasChildren(id) {
    return Boolean(id && getDb().prepare("SELECT 1 FROM photo_browse_categories WHERE parent_id=? LIMIT 1").get(id));
  }

  function list() {
    const db = getDb();
    return readSnapshot(db, () => {
      const state = readState(db);
      const rows = db.prepare(`SELECT ${definitionColumns}, category.position ${definitionTables}
        ORDER BY category.parent_id, category.position, category.id`).all();
      const assignedFolders = assignedFoldersByCategory(db);
      const totals = new Map();
      for (const row of rows) {
        const counts = categoryCounts(db, state, row, assignedFolders);
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

  function children(id, { sort, direction, locale, limit = 80, offset = 0, loadSource, loadFolder } = {}) {
    if (!id) return null;
    const db = getDb();
    return readSnapshot(db, () => {
      const parent = db.prepare("SELECT name, source_category AS sourceCategory FROM photo_browse_categories WHERE id=?").get(id);
      if (!parent) return null;
      const rows = db.prepare(`SELECT ${definitionColumns}, category.position ${definitionTables}
        WHERE category.parent_id=? ORDER BY category.position, category.id`).all(id);
      if (!rows.length) return null;
      const state = readState(db);
      const assignedFolders = assignedFoldersByCategory(db);
      const entries = rows.map(row => ({ row, counts: categoryCounts(db, state, row, assignedFolders) }))
        .filter(({ row, counts }) => counts?.albumCount > 0 || hasPublisherContent(db, row.publisherId));
      const stats = { ratedCount: 0, totalBytes: 0, albumCount: 0 };
      for (const { counts } of entries) {
        stats.totalBytes += counts?.totalBytes || 0;
        stats.albumCount += counts?.albumCount || 0;
      }
      const items = entries.slice(offset, offset + limit).map(({ row, counts }) => {
        const representative = row.folderCategory
          ? loadFolder?.({ category: row.folderCategory, subCategory: row.folderSubCategory })?.items?.[0]
          : sourceCollection(db, row.sourceCategory);
        return siteCard(row, parent.name, counts, representative);
      });
      const source = parent.sourceCategory && loadSource?.({
        category: parent.sourceCategory, sort, direction, locale, limit: limit - items.length, offset: Math.max(0, offset - entries.length)
      });
      if (source) {
        items.push(...source.items);
        stats.totalBytes += source.stats.totalBytes;
        stats.albumCount += source.stats.albumCount;
      }
      const listRevision = createHash("sha256").update(JSON.stringify([state.revision, parent, entries, source?.listRevision])).digest("hex");
      return { items, total: entries.length + (source?.total || 0), stats, scannedAt: state.scannedAt, listRevision };
    });
  }

  return { byId, byPublisherId, bySourceCategory, byFolder, children, folderSubCategories, hasChildren, list };
}
