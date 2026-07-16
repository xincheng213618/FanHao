const TABLE_MAP = Object.freeze({
  actor_profiles: "people",
  actor_movies: "work_people",
  work_info: "works",
  work_covers: "images",
  javdb_rankings: "collection_items",
  local_image_cache: "local_image_cache",
  remote_image_cache: "remote_image_cache"
});

export function readTableStampRow(db, table) {
  const safeTable = TABLE_MAP[table] || table;
  if (!/^[A-Za-z0-9_]+$/.test(safeTable)) throw new Error(`Invalid table: ${table}`);
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM ${safeTable}) AS row_count,
      (SELECT COALESCE(MAX(rowid), 0) FROM ${safeTable}) AS max_rowid,
      (SELECT COALESCE(MAX(updated_at), '') FROM ${safeTable}) AS max_updated_at
  `).get();
  return {
    row_count: Number(row?.row_count || 0),
    max_rowid: Number(row?.max_rowid || 0),
    max_updated_at: String(row?.max_updated_at || "")
  };
}

export function tableStampValue(table, version, row) {
  if (!row) return `${version}:${table}:unavailable`;
  return `${version}:${Number(row.row_count || 0)}:${Number(row.max_rowid || 0)}:${String(row.max_updated_at || "")}`;
}
