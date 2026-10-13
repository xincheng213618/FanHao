// The downloader owns the journal schema and writes. This module only reads a
// source snapshot and persists its acknowledgement with the target transaction.
export const DOWNLOAD_MANAGER_CHANGE_CURSOR = "download_manager_change_cursor_v1";
export const DOWNLOAD_MANAGER_SYNC_BATCH_SIZE = 500;

export function readDownloadManagerChangeBatch(sourceDb, targetDb, sourcePath, options = {}) {
  if (!sourceDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_sync_state'").get()) return null;
  const state = sourceDb.prepare("SELECT version,generation FROM library_sync_state WHERE id=1").get();
  if (state?.version !== 1 || !state.generation) throw new Error("下载器增量同步日志版本不可用");
  let previous;
  try { previous = JSON.parse(targetDb.prepare("SELECT value FROM short_video_meta WHERE key=?").get(DOWNLOAD_MANAGER_CHANGE_CURSOR)?.value || "null"); } catch {}
  const highWater = Number(sourceDb.prepare("SELECT MAX(revision) AS value FROM library_sync_changes").get()?.value || 0);
  const sameSource = previous?.sourcePath === sourcePath && previous?.generation === state.generation
    && previous?.includePosts === Boolean(options.includePosts)
    && Number.isSafeInteger(previous.revision) && previous.revision >= 0 && previous.revision <= highWater;
  const cursor = sameSource ? { ...previous } : {
    sourcePath, generation: state.generation, includePosts: Boolean(options.includePosts),
    revision: 0, repaired: false, afterAweme: ""
  };
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(options.batchSize) || DOWNLOAD_MANAGER_SYNC_BATCH_SIZE)));
  const memberships = new Set(), works = new Set(), authors = new Set();
  let repairCount = 0;
  if (!cursor.repaired) {
    // Reconcile pre-journal tombstones once. Both branches use ordered covering
    // indexes; the cursor prevents a whole target scan on every batch/restart.
    const existing = targetDb.prepare(`
      SELECT aweme_id FROM short_videos WHERE aweme_id > ?
      UNION SELECT aweme_id FROM short_video_source_memberships WHERE aweme_id > ?
      ORDER BY aweme_id LIMIT ?
    `).all(cursor.afterAweme, cursor.afterAweme, limit);
    for (const row of existing) memberships.add(row.aweme_id);
    repairCount = existing.length;
    if (existing.length) cursor.afterAweme = existing.at(-1).aweme_id;
    if (existing.length < limit) cursor.repaired = true;
  }
  const rows = cursor.repaired && repairCount < limit ? sourceDb.prepare(`
    SELECT revision,entity,entity_key FROM library_sync_changes
    WHERE revision > ? AND revision <= ? ORDER BY revision LIMIT ?
  `).all(cursor.revision, highWater, limit - repairCount) : [];
  for (const row of rows) {
    if (row.entity === "work") { works.add(row.entity_key); memberships.add(row.entity_key); }
    else if (row.entity === "membership") memberships.add(row.entity_key);
    else if (row.entity === "author") authors.add(row.entity_key);
    else throw new Error(`未知的下载器同步记录类型：${row.entity}`);
    cursor.revision = row.revision;
  }
  const advanced = JSON.stringify(cursor) !== JSON.stringify(previous);
  return {
    cursor, advanced, hasMore: !cursor.repaired || cursor.revision < highWater,
    changesRead: rows.length, repairCount,
    membershipIds: [...memberships], workIds: [...works], authorIds: [...authors]
  };
}

export function installDownloadManagerBatchScope(sourceDb, targetDb, batch) {
  for (const db of [sourceDb, targetDb]) {
    for (const [name, values] of [
      ["membership", batch.membershipIds], ["work", batch.workIds], ["author", batch.authorIds]
    ]) {
      db.exec(`CREATE TEMP TABLE IF NOT EXISTS short_video_sync_${name}(id TEXT PRIMARY KEY) WITHOUT ROWID;
        DELETE FROM temp.short_video_sync_${name};`);
      const insert = db.prepare(`INSERT INTO temp.short_video_sync_${name}(id) VALUES(?)`);
      for (const id of values) insert.run(id);
    }
  }
}

export function commitDownloadManagerChangeCursor(targetDb, batch) {
  if (batch.advanced) targetDb.prepare("INSERT OR REPLACE INTO short_video_meta(key,value) VALUES(?,?)")
    .run(DOWNLOAD_MANAGER_CHANGE_CURSOR, JSON.stringify(batch.cursor));
}

export function emptyDownloadManagerChangeResult(batch) {
  return {
    ok: true, incremental: true, changeJournal: true, advanced: batch.advanced,
    hasMore: batch.hasMore, changesRead: batch.changesRead, repairCount: batch.repairCount,
    imported: 0, updated: 0, skipped: 0, incrementalRows: 0, statsRefreshRows: 0,
    membershipsSeen: 0, membershipsChanged: 0, actionsChanged: 0, originsChanged: 0,
    relationshipFlagsChanged: 0, profilesSeen: 0, profilesChanged: 0,
    profileUsersChanged: 0, accountStatesChanged: 0, videoAuthorsChanged: 0, profileHistoriesChanged: 0,
    catalogChanges: 0, catalogChanged: false, summary: null
  };
}
