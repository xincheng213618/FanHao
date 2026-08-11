export function hasSqliteTables(db, schema, tableNames) {
  const safeSchema = String(schema || "");
  if (!/^[A-Za-z0-9_]+$/.test(safeSchema)) throw new Error(`Invalid SQLite schema: ${schema}`);
  const names = [...new Set((tableNames || []).map(String).filter(Boolean))];
  if (!names.length) return true;
  const placeholders = names.map(() => "?").join(", ");
  const rows = db.prepare(`
    SELECT name FROM ${safeSchema}.sqlite_schema
    WHERE type = 'table' AND name IN (${placeholders})
  `).all(...names);
  return new Set(rows.map((row) => String(row.name || ""))).size === names.length;
}
