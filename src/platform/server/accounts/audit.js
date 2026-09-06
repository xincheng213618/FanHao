export const ACCOUNT_AUDIT_SCHEMA = `CREATE TABLE account_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, actor_username TEXT NOT NULL,
  target_username TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL
);`;

export function createAccountAudit({ database, now, accountError }) {
  // Callers record only explicit, non-secret summaries inside their mutation transaction.
  function record(action, actorId, targetId, summary) {
    const connection = database();
    const username = (id) => id ? connection.prepare("SELECT username FROM account_users WHERE id=?").get(id)?.username || "" : "";
    const result = connection.prepare("INSERT INTO account_audit(action,actor_username,target_username,summary,created_at) VALUES(?,?,?,?,?)")
      .run(action, username(actorId), username(targetId), summary, Number(now()));
    connection.prepare("DELETE FROM account_audit WHERE id<=?").run(Number(result.lastInsertRowid) - 10000);
  }
  function list(query = {}) {
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isInteger(offset) || offset < 0 || offset > 10000000) throw accountError(400, "分页位置无效");
    const search = `%${String(query.search || "").trim().slice(0, 100).replace(/[\\%_]/g, "\\$&")}%`;
    const where = "WHERE actor_username LIKE ? ESCAPE '\\' OR target_username LIKE ? ESCAPE '\\'";
    const connection = database();
    return { events: connection.prepare(`SELECT id,action,actor_username AS actorUsername,target_username AS targetUsername,
      summary,created_at AS createdAt FROM account_audit ${where} ORDER BY id DESC LIMIT 50 OFFSET ?`).all(search, search, offset),
      total: connection.prepare(`SELECT count(*) AS n FROM account_audit ${where}`).get(search, search).n, offset, limit: 50 };
  }
  return { record, list };
}
