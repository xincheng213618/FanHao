import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  SHORT_VIDEO_COVER_GENERATION_VERSION,
  SQLITE_SHORT_VIDEO_COVER_SOURCE
} from "./cover-database.js";

export function createShortVideoCoverStorageService({
  coverDatabase,
  coverDbPath,
  legacyCoverDir,
  onCatalogChanged = () => {}
}) {
  const resolvedLegacyCoverDir = path.resolve(legacyCoverDir);

  function sourceFingerprint(row) {
    return crypto.createHash("sha1").update([
      row?.source_path || "",
      Math.max(0, Math.floor(Number(row?.size_bytes || 0))),
      Math.max(0, Math.floor(Number(row?.mtime_ms || 0))),
      SHORT_VIDEO_COVER_GENERATION_VERSION
    ].join(":"), "utf8").digest("hex");
  }

  function hasUsableCover(row, storedFingerprints = null) {
    if (!row) return false;
    if (row.cover_source === SQLITE_SHORT_VIDEO_COVER_SOURCE) {
      if (storedFingerprints) return storedFingerprints.get(String(row.id || "")) === sourceFingerprint(row);
      return coverDatabase.has(row.id, sourceFingerprint(row));
    }
    return Boolean(row.cover_path && safeFileSize(row.cover_path) > 0);
  }

  function missingCount(database) {
    const storedFingerprints = coverDatabase.fingerprints();
    return missingCandidates(database).reduce(
      (count, row) => count + Number(!hasUsableCover(row, storedFingerprints)),
      0
    );
  }

  function missingRows(database, limit) {
    const safeLimit = integerInRange(limit, 50, 0, 50000);
    if (safeLimit <= 0) return [];
    const storedFingerprints = coverDatabase.fingerprints();
    return missingCandidates(database)
      .filter((row) => !hasUsableCover(row, storedFingerprints))
      .slice(0, safeLimit);
  }

  function migrateLegacyCoverFiles(database, options = {}) {
    const rows = legacyGeneratedRows(database);
    const requestedLimit = Number(options.limit || 0);
    const selected = requestedLimit > 0 ? rows.slice(0, Math.floor(requestedLimit)) : rows;
    const batchSize = integerInRange(options.batchSize, 250, 1, 1000);
    const updateVideo = database.prepare(`
      UPDATE short_videos
      SET cover_path = '',
          cover_source = '${SQLITE_SHORT_VIDEO_COVER_SOURCE}',
          updated_at = ?
      WHERE id = ?
        AND COALESCE(cover_source, '') <> 'native'
    `);
    const deleteLegacyAsset = database.prepare(`
      DELETE FROM short_video_assets
      WHERE video_id = ?
        AND asset_type = 'ffmpeg_cover'
    `);
    let migrated = 0;
    let migratedBytes = 0;
    let missingFiles = 0;
    let invalidFiles = 0;
    let skippedNative = 0;

    for (let offset = 0; offset < selected.length; offset += batchSize) {
      const batchRows = selected.slice(offset, offset + batchSize);
      const records = [];
      for (const row of batchRows) {
        let buffer;
        try {
          buffer = fs.readFileSync(row.cover_path);
        } catch {
          missingFiles += 1;
          continue;
        }
        if (!isJpegBuffer(buffer)) {
          invalidFiles += 1;
          continue;
        }
        records.push({
          videoId: row.id,
          imageBuffer: buffer,
          sourceFingerprint: sourceFingerprint(row),
          sourceMtimeMs: row.mtime_ms,
          generationVersion: SHORT_VIDEO_COVER_GENERATION_VERSION
        });
      }
      if (!records.length) continue;
      coverDatabase.putMany(records);
      const now = new Date().toISOString();
      const rejectedIds = [];
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const record of records) {
          const result = updateVideo.run(now, record.videoId);
          if (Number(result?.changes || 0) <= 0) {
            rejectedIds.push(record.videoId);
            skippedNative += 1;
            continue;
          }
          deleteLegacyAsset.run(record.videoId);
          migrated += 1;
          migratedBytes += record.imageBuffer.length;
        }
        database.prepare("INSERT OR REPLACE INTO short_video_meta (key, value) VALUES ('cover_sqlite_migrated_at', ?)").run(now);
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {}
        throw error;
      }
      if (rejectedIds.length) coverDatabase.removeMany(rejectedIds);
      options.onProgress?.({
        processed: Math.min(selected.length, offset + batchRows.length),
        total: selected.length,
        migrated,
        migratedBytes,
        missingFiles,
        invalidFiles,
        skippedNative
      });
    }
    onCatalogChanged(database);
    return {
      ok: missingFiles === 0 && invalidFiles === 0,
      coverDbPath,
      legacyCoverDir,
      selected: selected.length,
      migrated,
      migratedBytes,
      missingFiles,
      invalidFiles,
      skippedNative,
      storage: status(database)
    };
  }

  function linkGeneratedCover(database, row, storedCover) {
    if (!row?.id || !storedCover) return false;
    const now = new Date().toISOString();
    const result = database.prepare(`
      UPDATE short_videos
      SET cover_path = '',
          cover_source = '${SQLITE_SHORT_VIDEO_COVER_SOURCE}',
          updated_at = ?
      WHERE id = ?
        AND COALESCE(cover_source, '') <> 'native'
    `).run(now, row.id);
    if (Number(result?.changes || 0) <= 0) {
      coverDatabase.remove(row.id);
      return false;
    }
    database.prepare(`
      DELETE FROM short_video_assets
      WHERE video_id = ?
        AND asset_type = 'ffmpeg_cover'
    `).run(row.id);
    row.cover_path = "";
    row.cover_source = SQLITE_SHORT_VIDEO_COVER_SOURCE;
    return true;
  }

  function status(database, options = {}) {
    const linkedIds = database.prepare(`
      SELECT id
      FROM short_videos
      WHERE cover_source = ?
    `).all(SQLITE_SHORT_VIDEO_COVER_SOURCE).map((row) => String(row.id || "")).filter(Boolean);
    const linkedSet = new Set(linkedIds);
    const storedIds = coverDatabase.ids();
    const storedSet = new Set(storedIds);
    const orphanIds = storedIds.filter((id) => !linkedSet.has(id));
    const missingLinkedIds = linkedIds.filter((id) => !storedSet.has(id));
    const pruned = options.pruneOrphans ? coverDatabase.removeMany(orphanIds) : 0;
    const legacyRows = legacyGeneratedRows(database);
    const legacyPathRows = legacyPathReferences(database);
    return {
      ...coverDatabase.status({ quickCheck: options.quickCheck !== false }),
      linked: linkedIds.length,
      missingLinked: missingLinkedIds.length,
      missingLinkedSample: missingLinkedIds.slice(0, 20),
      orphaned: Math.max(0, orphanIds.length - pruned),
      orphanedSample: options.pruneOrphans ? [] : orphanIds.slice(0, 20),
      pruned,
      legacyReferences: legacyRows.length,
      legacyPathReferences: legacyPathRows.length,
      legacyPathReferenceSample: legacyPathRows.slice(0, 20),
      legacyCoverDir
    };
  }

  function reconcile(database) {
    const linkedIds = new Set(database.prepare(`
      SELECT id
      FROM short_videos
      WHERE cover_source = ?
    `).all(SQLITE_SHORT_VIDEO_COVER_SOURCE).map((row) => String(row.id || "")).filter(Boolean));
    const orphanIds = coverDatabase.ids().filter((id) => !linkedIds.has(id));
    return { linked: linkedIds.size, pruned: coverDatabase.removeMany(orphanIds) };
  }

  function missingCandidates(database) {
    return database.prepare(`
      SELECT
        id, aweme_id, title, description, file_name, author_name,
        source_path, cover_path, cover_source, duration_ms, size_bytes, mtime_ms,
        liked_at, published_at
      FROM short_video_catalog
      WHERE COALESCE(TRIM(source_path), '') <> ''
        AND COALESCE(TRIM(cover_source), '') <> 'native'
      ORDER BY liked_at DESC, published_at DESC, id DESC
    `).all();
  }

  function legacyGeneratedRows(database) {
    return database.prepare(`
      SELECT id, source_path, cover_path, cover_source, size_bytes, mtime_ms
      FROM short_video_catalog
      WHERE cover_source = 'ffmpeg'
        AND COALESCE(TRIM(cover_path), '') <> ''
      ORDER BY id
    `).all().filter((row) => isInsideLegacyCoverDir(row.cover_path));
  }

  function legacyPathReferences(database) {
    return [
      ...database.prepare(`
        SELECT id AS owner_id, cover_path AS local_path
        FROM short_videos
        WHERE COALESCE(TRIM(cover_path), '') <> ''
      `).all(),
      ...database.prepare(`
        SELECT video_id AS owner_id, local_path
        FROM short_video_assets
        WHERE COALESCE(TRIM(local_path), '') <> ''
      `).all()
    ].filter((row) => isInsideLegacyCoverDir(row.local_path)).map((row) => ({
      id: String(row.owner_id || ""),
      path: String(row.local_path || "")
    }));
  }

  function isInsideLegacyCoverDir(filePath) {
    const resolved = path.resolve(String(filePath || ""));
    return resolved.startsWith(`${resolvedLegacyCoverDir}${path.sep}`);
  }

  return Object.freeze({
    hasUsableCover,
    linkGeneratedCover,
    migrateLegacyCoverFiles,
    missingCount,
    missingRows,
    reconcile,
    sourceFingerprint,
    status
  });
}

function integerInRange(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

function isJpegBuffer(buffer) {
  return buffer?.length >= 4
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[buffer.length - 2] === 0xff
    && buffer[buffer.length - 1] === 0xd9;
}

function safeFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
