import { randomUUID } from "node:crypto";
import { STUDIO_CATALOG_CACHE_TABLES } from "./cache-contracts.js";

const CATALOG_COMMIT_TABLES = new Set(STUDIO_CATALOG_CACHE_TABLES.filter((table) => table !== "works"));
const connectionIds = new WeakMap();

const TABLE_MAP = Object.freeze({
  actor_profiles: "people",
  actor_movies: "work_people",
  actor_profile_publications: "actor_profile_publications",
  images: "fanhao_images.images",
  work_info: "works",
  work_covers: "fanhao_images.images",
  javdb_rankings: "collection_items",
  local_image_cache: "fanhao_images.local_image_cache",
  remote_image_cache: "fanhao_images.remote_image_cache"
});

export function readTableStampRow(db, table) {
  const safeTable = TABLE_MAP[table] || table;
  if (!/^(?:[A-Za-z0-9_]+\.)?[A-Za-z0-9_]+$/.test(safeTable)) throw new Error(`Invalid table: ${table}`);
  if (CATALOG_COMMIT_TABLES.has(table)) {
    // Resolve the target schema without reading its rows. These catalog-only
    // stamps rely on explicit revisions and external commit epochs, so link
    // counts/timestamp aggregates add cold-request cost without new coverage.
    db.prepare(`SELECT 1 FROM ${safeTable} LIMIT 0`).get();
    return { row_count: 0, max_rowid: 0, max_updated_at: "", content_revision: externalCommitRevision(db) };
  }
  const contentRevisionSql = table === "actor_profile_publications"
    ? `, (SELECT COALESCE(group_concat(pointer, '|'), '') FROM (
          SELECT CAST(person_id AS TEXT) || ':' || operation_id AS pointer
          FROM actor_profile_publications ORDER BY person_id
        )) AS content_revision`
    : "";
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM ${safeTable}) AS row_count,
      (SELECT COALESCE(MAX(rowid), 0) FROM ${safeTable}) AS max_rowid,
      (SELECT COALESCE(MAX(updated_at), '') FROM ${safeTable}) AS max_updated_at
      ${contentRevisionSql}
  `).get();
  return {
    row_count: Number(row?.row_count || 0),
    max_rowid: Number(row?.max_rowid || 0),
    max_updated_at: String(row?.max_updated_at || ""),
    content_revision: String(row?.content_revision || "")
  };
}

function externalCommitRevision(db) {
  // Catalog metadata may have no timestamp, or a timestamp can remain unchanged
  // across external updates. data_version observes other connections' commits
  // without reading every link/ref. Its counter is
  // connection-local, so main/worker/reopened connections need distinct epochs.
  // Writes through this connection retain the existing explicit invalidation.
  let connectionId = connectionIds.get(db);
  if (!connectionId) {
    connectionId = randomUUID();
    connectionIds.set(db, connectionId);
  }
  return `${connectionId}:${Number(db.prepare("PRAGMA main.data_version").get()?.data_version || 0)}`;
}

export function tableStampValue(table, version, row) {
  if (!row) return `${version}:${table}:unavailable`;
  return `${version}:${Number(row.row_count || 0)}:${Number(row.max_rowid || 0)}:${String(row.max_updated_at || "")}:${String(row.content_revision || "")}`;
}
