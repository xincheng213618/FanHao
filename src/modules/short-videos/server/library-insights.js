import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LOCAL_SHORT_VIDEO_USER_ID } from "./constants.js";

function count(value) {
  return Math.max(0, Number(value || 0));
}

function rate(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function localLibraryRows(database) {
  return database.prepare(`
    SELECT
      v.id,
      TRIM(COALESCE(v.author_sec_uid, '')) AS sec_uid,
      TRIM(COALESCE(v.author_name, '')) AS author_name,
      CASE WHEN v.is_liked = 1 THEN 1 ELSE 0 END AS liked,
      COALESCE(v.size_bytes, 0) AS size_bytes,
      COALESCE(v.duration_ms, 0) AS duration_ms,
      COALESCE(v.actual_width, 0) AS actual_width,
      COALESCE(v.actual_height, 0) AS actual_height,
      TRIM(COALESCE(v.actual_probe_error, '')) AS probe_error,
      COALESCE(s.digg_count, v.digg_count, 0) AS likes,
      COALESCE(s.comment_count, v.comment_count, 0) AS comments,
      COALESCE(s.collect_count, v.collect_count, 0) AS collects,
      COALESCE(s.share_count, v.share_count, 0) AS shares,
      COALESCE(s.play_count, v.play_count, 0) AS plays,
      COALESCE(w.progress_ms, 0) AS progress_ms,
      COALESCE(w.completed_count, 0) AS completed_count,
      COALESCE(w.last_watched_at, '') AS last_watched_at
    FROM short_videos v
    LEFT JOIN short_video_stats s ON s.video_id = v.id
    LEFT JOIN short_video_watch_history w
      ON w.video_id = v.id AND w.local_user_id = ?
    WHERE v.visibility = 'local_only'
      AND v.media_type = 'video'
  `).all(LOCAL_SHORT_VIDEO_USER_ID).map((row) => ({
    ...row,
    authorKey: String(row.sec_uid || "").trim()
      ? `sec:${String(row.sec_uid).trim()}`
      : `name:${String(row.author_name || "").trim().toLocaleLowerCase()}`
  }));
}

function authorEfficiency(libraryRows) {
  const authorMap = new Map();
  let likedVideos = 0;
  let sizeBytes = 0;
  for (const row of libraryRows) {
    const liked = Number(row.liked || 0) === 1;
    if (liked) likedVideos += 1;
    sizeBytes += count(row.size_bytes);
    if (!row.authorKey || row.authorKey === "name:") continue;
    const author = authorMap.get(row.authorKey) || {
      key: row.authorKey,
      secUid: String(row.sec_uid || ""),
      name: String(row.author_name || "").trim() || "未知作者",
      videoCount: 0,
      likedCount: 0,
      sizeBytes: 0
    };
    author.videoCount += 1;
    if (liked) author.likedCount += 1;
    author.sizeBytes += count(row.size_bytes);
    authorMap.set(row.authorKey, author);
  }
  const rows = [...authorMap.values()].map((row) => ({
    ...row,
    hitRate: rate(row.likedCount, row.videoCount)
  }));
  const totalVideos = libraryRows.length;
  const baselineHitRate = rate(likedVideos, totalVideos);
  const minSamples = 20;
  const lowYieldMinSamples = 50;
  const lowYieldHitRate = Math.max(0.01, baselineHitRate * 0.55);
  const authors = rows
    .filter((row) => row.videoCount >= minSamples)
    .sort((left, right) => right.sizeBytes - left.sizeBytes || left.hitRate - right.hitRate || right.videoCount - left.videoCount);
  const highHit = rows
    .filter((row) => row.videoCount >= minSamples && row.likedCount >= 2 && row.likedCount < row.videoCount)
    .sort((left, right) => right.hitRate - left.hitRate || right.likedCount - left.likedCount || right.videoCount - left.videoCount)
    .slice(0, 8);
  const lowYieldAuthors = authors
    .filter((row) => row.videoCount >= lowYieldMinSamples && row.hitRate < lowYieldHitRate);
  return {
    authorTotal: rows.length,
    eligibleAuthorTotal: rows.filter((row) => row.videoCount >= minSamples && row.likedCount > 0 && row.likedCount < row.videoCount).length,
    totalVideos,
    likedVideos,
    sizeBytes,
    baselineHitRate,
    minSamples,
    lowYieldMinSamples,
    lowYieldHitRate,
    authors,
    highHit,
    lowYield: lowYieldAuthors.slice(0, 8),
    lowYieldAuthors
  };
}

function preferenceComparison(libraryRows) {
  const rows = libraryRows.filter((row) => count(row.likes) > 0 && row.authorKey && row.authorKey !== "name:");
  const authorMembership = new Map();
  for (const row of rows) {
    const authorKey = row.authorKey;
    const membership = authorMembership.get(authorKey) || { liked: false, other: false };
    if (Number(row.liked || 0) === 1) membership.liked = true;
    else membership.other = true;
    authorMembership.set(authorKey, membership);
  }
  const comparableAuthors = new Set([...authorMembership.entries()]
    .filter(([, membership]) => membership.liked && membership.other)
    .map(([authorKey]) => authorKey));
  const groups = {
    liked: { likes: [], collectRates: [], shareRates: [], commentRates: [], count: 0 },
    other: { likes: [], collectRates: [], shareRates: [], commentRates: [], count: 0 }
  };
  const authors = new Set();
  for (const row of rows) {
    if (!comparableAuthors.has(row.authorKey)) continue;
    const likes = count(row.likes);
    if (!likes) continue;
    const group = Number(row.liked || 0) === 1 ? groups.liked : groups.other;
    group.count += 1;
    group.likes.push(likes);
    group.collectRates.push(count(row.collects) / likes);
    group.shareRates.push(count(row.shares) / likes);
    group.commentRates.push(count(row.comments) / likes);
    authors.add(row.authorKey);
  }
  const summarize = (group) => ({
    sampleCount: group.count,
    medianLikes: median(group.likes),
    medianCollectRate: median(group.collectRates),
    medianShareRate: median(group.shareRates),
    medianCommentRate: median(group.commentRates)
  });
  return {
    comparableAuthorTotal: authors.size,
    liked: summarize(groups.liked),
    other: summarize(groups.other)
  };
}

function preferenceSignals(database, baselineHitRate) {
  const signalRows = (table, keyColumn, labelColumn, minSamples) => {
    const knownTotal = count(database.prepare(`
      SELECT COUNT(DISTINCT index_row.video_id) AS total
      FROM ${table} index_row
      JOIN short_videos v ON v.id = index_row.video_id
      WHERE v.visibility = 'local_only' AND v.media_type = 'video'
    `).get()?.total);
    const items = database.prepare(`
      SELECT
        index_row.${keyColumn} AS signal_key,
        MAX(index_row.${labelColumn}) AS signal_label,
        COUNT(*) AS sample_count,
        SUM(CASE WHEN v.is_liked = 1 THEN 1 ELSE 0 END) AS liked_count
      FROM ${table} index_row
      JOIN short_videos v ON v.id = index_row.video_id
      WHERE v.visibility = 'local_only'
        AND v.media_type = 'video'
        AND index_row.${keyColumn} <> ''
      GROUP BY index_row.${keyColumn}
      HAVING COUNT(*) >= ?
        AND SUM(CASE WHEN v.is_liked = 1 THEN 1 ELSE 0 END) >= 2
    `).all(minSamples).map((row) => {
      const sampleCount = count(row.sample_count);
      const likedCount = count(row.liked_count);
      const hitRate = rate(likedCount, sampleCount);
      const lift = baselineHitRate > 0 ? hitRate / baselineHitRate : 0;
      return {
        key: String(row.signal_key || ""),
        label: String(row.signal_label || row.signal_key || "").trim(),
        sampleCount,
        likedCount,
        hitRate,
        lift,
        score: lift * Math.min(1, Math.log1p(sampleCount) / Math.log(101))
      };
    }).filter((row) => row.lift > 1)
      .sort((left, right) => right.score - left.score || right.likedCount - left.likedCount)
      .slice(0, 8);
    return { items, knownTotal };
  };
  const topics = signalRows("short_video_topics", "topic_key", "topic", 20);
  const sounds = signalRows("short_video_sounds", "sound_key", "title", 15);
  return {
    baselineHitRate,
    topics: topics.items,
    topicKnown: topics.knownTotal,
    sounds: sounds.items,
    soundKnown: sounds.knownTotal
  };
}

function watchInsights(libraryRows) {
  const labels = new Map([
    ["under_10", "少于 10 秒"],
    ["10_20", "10–20 秒"],
    ["20_30", "20–30 秒"],
    ["30_60", "30–60 秒"],
    ["60_plus", "60 秒以上"]
  ]);
  const order = [...labels.keys()];
  const watchedRows = libraryRows.filter((row) => String(row.last_watched_at || "").trim());
  const completedTotal = watchedRows.reduce((total, row) => total + (count(row.completed_count) > 0 ? 1 : 0), 0);
  const progressRates = watchedRows
    .filter((row) => count(row.duration_ms) > 0)
    .map((row) => Math.min(1, count(row.progress_ms) / count(row.duration_ms)));
  const watchedTimes = watchedRows.map((row) => String(row.last_watched_at || "")).filter(Boolean).sort();
  const bandMap = new Map();
  for (const row of watchedRows) {
    const durationMs = count(row.duration_ms);
    if (!durationMs) continue;
    const id = durationMs < 10000 ? "under_10"
      : durationMs < 20000 ? "10_20"
        : durationMs < 30000 ? "20_30"
          : durationMs < 60000 ? "30_60"
            : "60_plus";
    const band = bandMap.get(id) || { id, watched: 0, completed: 0 };
    band.watched += 1;
    if (count(row.completed_count) > 0) band.completed += 1;
    bandMap.set(id, band);
  }
  const watchedTotal = watchedRows.length;
  const libraryTotal = libraryRows.length;
  return {
    libraryTotal,
    watchedTotal,
    completedTotal,
    completionRate: rate(completedTotal, watchedTotal),
    coverageRate: rate(watchedTotal, libraryTotal),
    averageProgressRate: progressRates.length ? progressRates.reduce((total, value) => total + value, 0) / progressRates.length : 0,
    firstWatchedAt: watchedTimes[0] || "",
    lastWatchedAt: watchedTimes.at(-1) || "",
    durationBands: [...bandMap.values()].map((row) => {
      const watched = row.watched;
      const completed = row.completed;
      return {
        id: row.id,
        label: labels.get(row.id) || row.id,
        watched,
        completed,
        completionRate: rate(completed, watched)
      };
    }).sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id))
  };
}

function managerQualityAudit(downloadManagerDbPath, currentLibraryTotal) {
  const unavailable = { available: false };
  if (!downloadManagerDbPath || !fs.existsSync(downloadManagerDbPath)) return unavailable;
  let managerDb = null;
  try {
    managerDb = new DatabaseSync(downloadManagerDbPath, { readOnly: true });
    managerDb.exec("PRAGMA busy_timeout = 5000");
    const tables = new Set(managerDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (!tables.has("video_quality_audit_runs") || !tables.has("video_quality_audit_items")) return unavailable;
    const latest = managerDb.prepare(`
      SELECT id, generated_at, downloaded_count, probe_error_count
      FROM video_quality_audit_runs
      ORDER BY generated_at DESC, id DESC
      LIMIT 1
    `).get();
    if (!latest?.id) return unavailable;
    const status = managerDb.prepare(`
      SELECT
        COUNT(*) AS audited_total,
        SUM(CASE WHEN audit_status = 'skipped_threshold' THEN 1 ELSE 0 END) AS already_highest,
        SUM(CASE WHEN audit_status = 'up_to_date' THEN 1 ELSE 0 END) AS up_to_date,
        SUM(CASE WHEN audit_status = 'source_unavailable' THEN 1 ELSE 0 END) AS source_unavailable,
        SUM(CASE WHEN audit_status = 'upgrade_available' THEN 1 ELSE 0 END) AS upgrade_available,
        SUM(CASE WHEN audit_status = 'probe_failed' THEN 1 ELSE 0 END) AS audit_probe_failed,
        SUM(CASE WHEN verification_status = 'passed' THEN 1 ELSE 0 END) AS verification_passed,
        SUM(CASE WHEN verification_status = 'failed' THEN 1 ELSE 0 END) AS verification_failed,
        SUM(CASE WHEN verification_status = 'probe_failed' THEN 1 ELSE 0 END) AS verification_probe_failed,
        SUM(CASE WHEN redownload_status IN ('queued', 'downloading') THEN 1 ELSE 0 END) AS upgrade_pending
      FROM video_quality_audit_items
      WHERE run_id = ?
    `).get(latest.id) || {};
    let failedQueue = 0;
    if (tables.has("links")) {
      const linkColumns = new Set(managerDb.prepare("PRAGMA table_info(links)").all().map((row) => row.name));
      if (["download_intent", "status"].every((column) => linkColumns.has(column))) {
        failedQueue = count(managerDb.prepare(`
          SELECT COUNT(*) AS total
          FROM links
          WHERE download_intent = 'quality_upgrade' AND status = 'failed'
        `).get()?.total);
      }
    }
    const auditedTotal = count(status.audited_total);
    const downloadedAtAudit = count(latest.downloaded_count);
    const currentLibraryCount = count(currentLibraryTotal);
    return {
      available: true,
      runId: Number(latest.id),
      generatedAt: String(latest.generated_at || ""),
      auditedTotal,
      downloadedAtAudit,
      currentLibraryTotal: currentLibraryCount,
      catalogDeltaFromAudit: Math.max(0, currentLibraryCount - downloadedAtAudit),
      alreadyHighest: count(status.already_highest),
      upToDate: count(status.up_to_date),
      sourceUnavailable: count(status.source_unavailable),
      upgradeAvailable: count(status.upgrade_available),
      upgradePassed: count(status.verification_passed),
      verificationFailed: count(status.verification_failed),
      probeFailed: count(status.audit_probe_failed) + count(status.verification_probe_failed),
      upgradePending: count(status.upgrade_pending),
      failedQueue,
      healthyTotal: count(status.already_highest) + count(status.up_to_date) + count(status.verification_passed)
    };
  } catch {
    return unavailable;
  } finally {
    try {
      managerDb?.close();
    } catch {}
  }
}

function dataHealth(libraryRows, watch, signals, downloadManagerDbPath) {
  const total = libraryRows.length;
  const likesKnown = libraryRows.reduce((sum, row) => sum + (count(row.likes) > 0 ? 1 : 0), 0);
  const playKnown = libraryRows.reduce((sum, row) => sum + (count(row.plays) > 0 ? 1 : 0), 0);
  const qualityKnown = libraryRows.reduce((sum, row) => sum + (count(row.actual_width) > 0 && count(row.actual_height) > 0 ? 1 : 0), 0);
  const probeErrors = libraryRows.reduce((sum, row) => sum + (String(row.probe_error || "").trim() ? 1 : 0), 0);
  const topicKnown = count(signals.topicKnown);
  const soundKnown = count(signals.soundKnown);
  return {
    total,
    likesKnown,
    likesUnknown: Math.max(0, total - likesKnown),
    likesCoverageRate: rate(likesKnown, total),
    playKnown,
    playCoverageRate: rate(playKnown, total),
    qualityKnown,
    qualityUnknown: Math.max(0, total - qualityKnown),
    qualityCoverageRate: rate(qualityKnown, total),
    probeErrors,
    topicKnown,
    topicCoverageRate: rate(topicKnown, total),
    soundKnown,
    soundCoverageRate: rate(soundKnown, total),
    watchKnown: watch.watchedTotal,
    watchCoverageRate: watch.coverageRate,
    qualityAudit: managerQualityAudit(downloadManagerDbPath, total)
  };
}

export function shortVideoLibraryInsights(database, options = {}) {
  const timings = {};
  const timed = (name, task) => {
    const startedAt = performance.now();
    const result = task();
    timings[name] = Math.round(performance.now() - startedAt);
    return result;
  };
  const libraryRows = timed("libraryRowsMs", () => localLibraryRows(database));
  const efficiency = timed("authorEfficiencyMs", () => authorEfficiency(libraryRows));
  const comparison = timed("preferenceComparisonMs", () => preferenceComparison(libraryRows));
  const signals = timed("preferenceSignalsMs", () => preferenceSignals(database, efficiency.baselineHitRate));
  const watch = timed("watchInsightsMs", () => watchInsights(libraryRows));
  const health = timed("dataHealthMs", () => dataHealth(libraryRows, watch, signals, options.downloadManagerDbPath));
  const result = {
    personal: {
      authorEfficiency: efficiency,
      preferenceComparison: comparison,
      preferenceSignals: signals,
      watch
    },
    health
  };
  if (typeof options.onTiming === "function") options.onTiming(timings);
  return result;
}
