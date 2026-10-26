import fs from "node:fs";
import path from "node:path";
import { ensureRealPathWithinRoots } from "../../../../platform/server/library-path-safety.js";

const key = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const within = (value, root) => { const relative = path.relative(root, value); return relative === "" || !relative.startsWith("..") && !path.isAbsolute(relative); };
const conflict = message => Object.assign(new Error(message), { statusCode: 409, code: "DUPLICATE_INDEX_CHANGED" });

// Remove only stale local index references. Works, user state, cached metadata
// and physical files are never deleted by this service.
export function createDuplicateIndexCleanup({ getCoreDb, roots, onIndexChanged }) {
  function confirmedMissing(location) {
    if (!location || !path.isAbsolute(location)) return false;
    const allowed = roots.filter(root => within(key(location), key(root)));
    if (!allowed.length) return false;
    try {
      ensureRealPathWithinRoots(location, allowed, "失效索引");
      try { fs.lstatSync(location); return false; }
      catch (error) { if (error.code !== "ENOENT") return false; }
      return allowed.some(root => {
        try { return fs.statSync(root).isDirectory(); } catch { return false; }
      });
    } catch { return false; }
  }
  return function cleanup(rows) {
    const result = { removedFileIds: [], removedLocalWorkIds: [], warnings: [] };
    if (!rows.length) return result;
    const db = getCoreDb(), removed = new Set();
    const hasReservations = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_move_path_reservations'").get();
    const select = db.prepare("SELECT * FROM local_files WHERE id=?");
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        if (removed.has(String(row.id))) continue;
        const current = select.get(row.id);
        if (!current) continue; // An earlier committed cleanup is idempotent.
        if (current.file_type !== "video" || String(current.work_id) !== row.workId || current.file_id !== row.fileId
          || key(current.file_path) !== key(row.path) || Number(current.size) !== Number(row.size) || (current.modified_at || "") !== (row.modifiedAt || "")) {
          result.warnings.push({ fileId: row.id, error: "索引身份已变化，已跳过清理。" }); continue;
        }
        if (!confirmedMissing(current.file_path)) {
          result.warnings.push({ fileId: row.id, error: "路径已恢复或磁盘状态无法确认，已保留索引。" }); continue;
        }
        if (hasReservations && db.prepare("SELECT 1 FROM work_move_path_reservations WHERE work_id=? AND released_at='' LIMIT 1").get(String(current.work_id))) {
          throw conflict("作品正在整理或移动，请任务结束后再清理索引。");
        }
        const localWork = current.local_work_id == null ? null : db.prepare("SELECT * FROM local_works WHERE id=?").get(current.local_work_id);
        const siblings = localWork ? db.prepare("SELECT id,file_path,work_id FROM local_files WHERE local_work_id=?").all(localWork.id) : [];
        if (localWork && String(localWork.work_id) === row.workId && confirmedMissing(localWork.local_path)
          && siblings.every(file => String(file.work_id) === row.workId && within(key(file.file_path), key(localWork.local_path)))) {
          db.prepare("DELETE FROM local_files WHERE local_work_id=?").run(localWork.id);
          db.prepare("DELETE FROM local_works WHERE id=?").run(localWork.id);
          siblings.forEach(file => removed.add(String(file.id)));
          result.removedLocalWorkIds.push(String(localWork.id));
        } else {
          db.prepare("DELETE FROM local_files WHERE id=?").run(current.id);
          removed.add(String(current.id));
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* Preserve the mutation failure. */ }
      throw error;
    }
    result.removedFileIds = [...removed];
    if (removed.size) {
      try { if (onIndexChanged?.() === null) throw new Error("refresh failed"); }
      catch { result.warnings.push({ error: "数据库已清理，馆藏缓存刷新失败；请重新加载馆藏。" }); }
    }
    return result;
  };
}
