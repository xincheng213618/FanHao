import { DatabaseSync } from "node:sqlite";
import { buildDuplicateGroups } from "./model.js";

export function readDuplicateRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=3000; BEGIN");
    const columns = new Set(db.prepare("PRAGMA table_info(works)").all().map(row => row.name));
    const tags = columns.has("javdb_tags_json") ? "w.javdb_tags_json" : "'[]' AS javdb_tags_json";
    const hasProbe = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='video_probe_cache'").get());
    const probes = hasProbe ? new Map(db.prepare("SELECT file_id,file_path,source_size,source_mtime,status,probe_json FROM video_probe_cache WHERE schema_version=1 AND status='ok'").all()
      .map(row => [JSON.stringify([row.file_id, row.file_path]), row])) : new Map();
    const rows = db.prepare(`SELECT f.id,f.work_id,f.file_id,f.file_path,f.name,f.size,f.modified_at,w.code,w.title,${tags}
      FROM local_files f JOIN works w ON w.id=f.work_id
      WHERE f.file_type='video' ORDER BY f.id`).all().map(row => {
      const cached = probes.get(JSON.stringify([row.file_id, row.file_path]));
      let probe = null;
      let labels = [];
      try { const parsed = JSON.parse(row.javdb_tags_json || "[]"); if (Array.isArray(parsed)) labels = parsed; } catch {}
      if (cached && Number(cached.source_size) === Number(row.size) && cached.source_mtime === `library:${row.modified_at}`) {
        try { probe = JSON.parse(cached.probe_json); } catch {}
      }
      return { id: String(row.id), workId: String(row.work_id), fileId: row.file_id, videoId: row.file_id,
        path: row.file_path, name: row.name, size: Number(row.size), modifiedAt: row.modified_at,
        code: row.code, title: row.title, tags: labels, probe };
    });
    db.exec("COMMIT");
    return rows;
  } finally { db.close(); }
}

export function duplicateSnapshot(dbPath) { return buildDuplicateGroups(readDuplicateRows(dbPath)); }
