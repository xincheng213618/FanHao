export const GALLERY_METADATA_CLOCK_TABLE = "image_gallery_metadata_revisions";

export const GALLERY_METADATA_CLOCK_SQL = `CREATE TABLE IF NOT EXISTS ${GALLERY_METADATA_CLOCK_TABLE} (
  kind TEXT PRIMARY KEY NOT NULL CHECK(kind IN ('movie', 'tv')),
  epoch TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))) CHECK(length(epoch) = 32),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision) = 'integer' AND revision >= 0)
)`;

export const GALLERY_METADATA_CLOCK_TRIGGERS = ["movie", "tv"].flatMap(kind => {
  const table = kind === "movie" ? "movie_metadata" : "tv_series_metadata";
  return ["INSERT", "UPDATE", "DELETE"].map(event => ({
    kind,
    table,
    name: `fanhao_metadata_revision_${kind}_${event.toLowerCase()}`,
    sql: `CREATE TRIGGER IF NOT EXISTS fanhao_metadata_revision_${kind}_${event.toLowerCase()}
      AFTER ${event} ON ${table}
      BEGIN UPDATE ${GALLERY_METADATA_CLOCK_TABLE} SET revision = revision + 1 WHERE kind = '${kind}'; END`
  }));
});

export const GALLERY_METADATA_CLOCK_CONTRACT_SQL = `SELECT type, name, tbl_name, sql FROM sqlite_schema
  WHERE name IN ('${GALLERY_METADATA_CLOCK_TABLE}', ${GALLERY_METADATA_CLOCK_TRIGGERS.map(trigger => `'${trigger.name}'`).join(", ")})`;

function normalizedSql(sql) {
  return String(sql || "").trim().replace(/^CREATE (TABLE|TRIGGER) IF NOT EXISTS /u, "CREATE $1 ")
    .replace(/;$/u, "").replace(/\s+/gu, " ");
}

function clockTableMatches(rows) {
  const table = rows.find(row => row.name === GALLERY_METADATA_CLOCK_TABLE);
  return table?.type === "table" && table.tbl_name === GALLERY_METADATA_CLOCK_TABLE
    && normalizedSql(table.sql) === normalizedSql(GALLERY_METADATA_CLOCK_SQL);
}

function triggerMatches(rows, trigger) {
  const row = rows.find(row => row.name === trigger.name);
  return row?.type === "trigger" && row.tbl_name === trigger.table
    && normalizedSql(row.sql) === normalizedSql(trigger.sql);
}

export function trustedGalleryMetadataClockKinds(rows) {
  if (!clockTableMatches(rows)) return new Set();
  return new Set(["movie", "tv"].filter(kind => GALLERY_METADATA_CLOCK_TRIGGERS
    .filter(trigger => trigger.kind === kind).every(trigger => triggerMatches(rows, trigger))));
}

export function galleryMetadataClockKinds(mode) {
  return mode === "movie" ? ["movie"] : mode === "tv" || mode === "anime" ? ["tv"] : ["movie", "tv"];
}

export function validGalleryMetadataClock(row) {
  return row && /^[0-9a-f]{32}$/u.test(row.epoch) && Number.isSafeInteger(row.revision) && row.revision >= 0;
}

export function ensureGalleryMetadataClocks(db) {
  const savepoint = "fanhao_metadata_clock_init";
  try {
    db.exec(`SAVEPOINT ${savepoint}`);
    db.exec(GALLERY_METADATA_CLOCK_SQL);
    if (!clockTableMatches(db.prepare(GALLERY_METADATA_CLOCK_CONTRACT_SQL).all())) throw new Error("legacy metadata clock schema");
    // Existing metadata needs no backfill: every committed change after this
    // installation is tracked, and the new schema establishes a new list epoch.
    db.exec(`INSERT OR IGNORE INTO ${GALLERY_METADATA_CLOCK_TABLE}(kind) VALUES ('movie'), ('tv')`);
    const row = db.prepare(`SELECT epoch, revision FROM ${GALLERY_METADATA_CLOCK_TABLE} WHERE kind = ?`);
    if (!["movie", "tv"].every(kind => validGalleryMetadataClock(row.get(kind)))) throw new Error("legacy metadata clock values");
    for (const trigger of GALLERY_METADATA_CLOCK_TRIGGERS) db.exec(trigger.sql);
    if (trustedGalleryMetadataClockKinds(db.prepare(GALLERY_METADATA_CLOCK_CONTRACT_SQL).all()).size !== 2) throw new Error("legacy metadata clock triggers");
    db.exec(`RELEASE ${savepoint}`);
    return true;
  } catch {
    try { db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); } catch {}
    // Optional clocks must not leave triggers pointing at a malformed clock
    // table and prevent the original metadata writes from succeeding.
    try {
      db.exec(`SAVEPOINT ${savepoint}`);
      const existing = db.prepare(GALLERY_METADATA_CLOCK_CONTRACT_SQL).all();
      for (const trigger of GALLERY_METADATA_CLOCK_TRIGGERS.filter(trigger => triggerMatches(existing, trigger))) {
        db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
      }
      db.exec(`RELEASE ${savepoint}`);
    } catch { try { db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); } catch {} }
    return false;
  }
}
