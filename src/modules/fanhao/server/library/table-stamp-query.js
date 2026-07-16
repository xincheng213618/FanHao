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
  const dataVersion = Number(db.prepare("PRAGMA data_version").get()?.data_version || 0);
  const row = db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS max_rowid FROM ${safeTable}`).get();
  return { data_version: dataVersion, max_rowid: Number(row?.max_rowid || 0) };
}

export function tableStampValue(table, version, row) {
  if (!row) return `${version}:${table}:unavailable`;
  return `${version}:${Number(row.data_version || 0)}:${Number(row.max_rowid || 0)}`;
}
