const projectionsByDatabase = new WeakMap();
const FULL_PROJECTIONS = Object.freeze({ video: "video.*", candidate: "candidate.*", catalog: "*" });

// Keep the catalog's column order and unknown legacy columns. In particular,
// appending a second metadata_json after alias.* would still copy the wide value.
export function collectionVideoProjections(db) {
  try {
    const mainVersion = db.prepare("PRAGMA main.schema_version").get()?.schema_version;
    const tempVersion = db.prepare("PRAGMA temp.schema_version").get()?.schema_version;
    if (!Number.isSafeInteger(mainVersion) || !Number.isSafeInteger(tempVersion)) {
      projectionsByDatabase.delete(db);
      return FULL_PROJECTIONS;
    }
    const version = `${mainVersion}:${tempVersion}`;
    const cached = projectionsByDatabase.get(db);
    if (cached?.version === version) return cached.projections;
    const shadow = db.prepare("SELECT 1 FROM temp.sqlite_schema WHERE name = 'short_video_catalog' COLLATE NOCASE").get();
    const catalog = db.prepare("SELECT type FROM main.sqlite_schema WHERE name = 'short_video_catalog' COLLATE NOCASE").get();
    const columns = !shadow && catalog && ["table", "view"].includes(catalog.type)
      ? db.prepare("PRAGMA main.table_xinfo('short_video_catalog')").all()
        .filter((column) => Number(column.hidden) !== 1).map((column) => column.name)
      : [];
    const projections = columns.includes("media_type") && columns.includes("metadata_json")
      ? Object.freeze(Object.fromEntries([
        ["video", "video"], ["candidate", "candidate"], ["catalog", "short_video_catalog"]
      ].map(([key, alias]) => [
        key,
        columns.map((column) => column === "metadata_json"
          ? `${collectionMetadataProjection(alias)} AS "metadata_json"`
          : `${alias}.${quoteIdentifier(column)}`).join(", ")
      ])))
      : FULL_PROJECTIONS;
    projectionsByDatabase.set(db, { version, projections });
    return projections;
  } catch {
    // A failed probe must not poison later requests or replace the original
    // query's missing-schema/closed-database errors with a new failure mode.
    projectionsByDatabase.delete(db);
    return FULL_PROJECTIONS;
  }
}

function collectionMetadataProjection(alias) {
  const metadata = `${alias}."metadata_json"`;
  // Collection DTOs need only cover fallbacks for canonical videos. Preserve
  // fanhaoMedia too: the mapper eagerly coerces its fields even for videos,
  // and historical object values can throw. Raw JSON tokens preserve those
  // coercions, escaped strings, lone surrogates and large JSON numbers.
  // JSON.parse uses the last duplicate property; SQLite paths use the first.
  // NUL-bearing keys can also alias a shorter SQLite path. Both keep raw JSON.
  return `CASE
    WHEN ${alias}."media_type" COLLATE BINARY = 'video' AND typeof(${metadata}) = 'text' THEN CASE
      WHEN json_valid(${metadata}) THEN CASE
        WHEN json_type(${metadata}) = 'object' THEN CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM json_each(${metadata})
            WHERE key COLLATE BINARY IN ('cover_url', 'coverUrl', 'fanhaoMedia')
              OR instr(key, char(0)) > 0
            GROUP BY key COLLATE BINARY
            HAVING COUNT(*) > 1 OR instr(key, char(0)) > 0
          ) THEN '{"cover_url":' || COALESCE(${metadata} -> '$.cover_url', 'null')
            || ',"coverUrl":' || COALESCE(${metadata} -> '$.coverUrl', 'null')
            || ',"fanhaoMedia":' || COALESCE(${metadata} -> '$.fanhaoMedia', 'null') || '}'
          ELSE ${metadata} END
        ELSE ${metadata} END
      ELSE ${metadata} END
    ELSE ${metadata} END`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}
