const VIDEO_PROBE_CACHE_SCHEMA_VERSION = 1;

export function createVideoProbeCacheService({
  getDb,
  now = () => new Date().toISOString(),
  warn = console.warn
}) {
  let initialized = false;
  let writeStatement = null;
  const rowsByFile = new Map();

  function initialize() {
    if (initialized) return true;
    try {
      const db = getDb();
      db.exec(`
        CREATE TABLE IF NOT EXISTS video_probe_cache (
          file_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          source_size INTEGER NOT NULL,
          source_mtime TEXT NOT NULL,
          schema_version INTEGER NOT NULL,
          status TEXT NOT NULL,
          probe_json TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (file_id, file_path)
        );
        CREATE INDEX IF NOT EXISTS idx_video_probe_cache_updated_at
          ON video_probe_cache(updated_at);
      `);
      const rows = db.prepare(`
        SELECT file_id, file_path, source_size, source_mtime, schema_version, status, probe_json
        FROM video_probe_cache
      `).all();
      rowsByFile.clear();
      for (const row of rows) rowsByFile.set(cacheKey(row.file_id, row.file_path), row);
      writeStatement = db.prepare(`
        INSERT INTO video_probe_cache (
          file_id, file_path, source_size, source_mtime,
          schema_version, status, probe_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_id, file_path) DO UPDATE SET
          source_size = excluded.source_size,
          source_mtime = excluded.source_mtime,
          schema_version = excluded.schema_version,
          status = excluded.status,
          probe_json = excluded.probe_json,
          updated_at = excluded.updated_at
      `);
      initialized = true;
      return true;
    } catch (error) {
      warn("[video-probe-cache]", error?.message || error);
      return false;
    }
  }

  function get(file, stat) {
    if (!file?.id || !file?.path || !stat || !initialize()) return { hit: false, value: null };
    try {
      const row = rowsByFile.get(cacheKey(file.id, file.path));
      if (!row || Number(row.schema_version) !== VIDEO_PROBE_CACHE_SCHEMA_VERSION) return { hit: false, value: null };
      if (Number(row.source_size) !== Number(stat.size) || String(row.source_mtime) !== sourceMtime(stat)) {
        return { hit: false, value: null };
      }
      if (row.status !== "ok") return { hit: true, value: null };
      const value = JSON.parse(String(row.probe_json || "null"));
      return value && typeof value === "object" ? { hit: true, value } : { hit: false, value: null };
    } catch (error) {
      warn("[video-probe-cache-read]", error?.message || error);
      return { hit: false, value: null };
    }
  }

  function set(file, stat, value) {
    if (!file?.id || !file?.path || !stat || !initialize()) return false;
    try {
      writeStatement.run(
        String(file.id),
        String(file.path),
        Number(stat.size) || 0,
        sourceMtime(stat),
        VIDEO_PROBE_CACHE_SCHEMA_VERSION,
        value ? "ok" : "unavailable",
        value ? JSON.stringify(value) : null,
        String(now())
      );
      rowsByFile.set(cacheKey(file.id, file.path), {
        source_size: Number(stat.size) || 0,
        source_mtime: sourceMtime(stat),
        schema_version: VIDEO_PROBE_CACHE_SCHEMA_VERSION,
        status: value ? "ok" : "unavailable",
        probe_json: value ? JSON.stringify(value) : null
      });
      return true;
    } catch (error) {
      warn("[video-probe-cache-write]", error?.message || error);
      return false;
    }
  }

  function sourceMtime(stat) {
    if (stat?.cacheMtime) return String(stat.cacheMtime);
    return String(Number(stat.mtimeMs) || 0);
  }

  function cacheKey(fileId, filePath) {
    return `${String(fileId || "")}\0${String(filePath || "")}`;
  }

  return { get, set, start: initialize };
}
