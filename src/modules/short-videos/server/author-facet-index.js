export function ensureAuthorFacetIndex(database) {
  // Group by the same author key as the public query. All aggregate inputs
  // live in this index, including following and SQLite-cover metadata.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_short_videos_author_facet_covering
      ON short_videos(
        COALESCE(NULLIF(author_sec_uid, ''), NULLIF(author_name, ''), 'unknown'),
        author_sec_uid, author_name, author_avatar_url, owner_user_id,
        author_following, cover_source, cover_path, mtime_ms, id
      ) WHERE visibility = 'local_only';
  `);
}

export function authorFacetIndexHint(database) {
  // A read-only connection may still see a pre-upgrade catalogue. Select the
  // covering index explicitly when present; retain the older index otherwise.
  const name = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'index' AND name IN ('idx_short_videos_author_facet_covering', 'idx_short_videos_author_facet')
    ORDER BY name = 'idx_short_videos_author_facet_covering' DESC LIMIT 1
  `).get()?.name;
  return name ? `INDEXED BY ${name}` : "";
}
