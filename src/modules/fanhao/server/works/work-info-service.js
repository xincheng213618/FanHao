import { workInfoDetailQuery } from "./work-info-detail-query.js";
import { parseInfoMetadata } from "../../../../../lib/info-metadata.js";

const DETAIL_BATCH_SIZE = 200;
const DETAIL_CACHE_MAX_ENTRIES = 2048;
const DETAIL_CACHE_MAX_BYTES = 32 * 1024 * 1024;

function detailRowWeight(row) {
  // Bound retained payloads, including raw metadata text, with a conservative
  // UTF-16 estimate plus fixed row/field overhead. This is not a heap census.
  return 64 + Object.values(row || {}).reduce((bytes, value) =>
    bytes + 16 + (typeof value === "string" ? value.length * 2
      : ArrayBuffer.isView(value) || value instanceof ArrayBuffer ? value.byteLength : 8), 0);
}

export function createWorkInfoService({
  displayWorkTitle,
  getCoreDb,
  getStamp,
  parseJsonArray,
  parseJsonTextArray,
  proxiedRemoteImageUrl,
  proxiedRemoteImageUrlArray,
  publicRemoteUrl,
  renderInfoMetadataText,
  uniqueTextArray
}) {
  let workInfoCache = null;
  let workInfoDetailCache = null;
  let workInfoFacetCache = null;
  let detailBatch = null;
  let detailBatchCleanupScheduled = false;
  let readScope = null;

  function withReadStatus(callback) {
    // Synchronous consumers share failed index reads only for this operation.
    // Each child tracks its own dependencies before propagating failures up.
    const previous = readScope;
    const scope = { cacheable: true, failures: previous?.failures || new Map() };
    readScope = scope;
    try {
      const value = callback();
      return { value, cacheable: scope.cacheable };
    } catch (error) {
      scope.cacheable = false;
      throw error;
    } finally {
      readScope = previous;
      if (previous && !scope.cacheable) previous.cacheable = false;
    }
  }

  function readCacheable() {
    return readScope?.cacheable !== false;
  }

  function markReadFailure() {
    if (readScope) readScope.cacheable = false;
  }

  function indexFailure(reader, stamp, owner) {
    const cached = readScope?.failures.get(reader)?.get(stamp)?.get(owner);
    if (cached) markReadFailure();
    return cached;
  }

  function rememberIndexFailure(reader, stamp, owner, rows) {
    if (!readScope) return;
    let stamps = readScope.failures.get(reader);
    if (!stamps) readScope.failures.set(reader, stamps = new Map());
    let owners = stamps.get(stamp);
    if (!owners) stamps.set(stamp, owners = new Map());
    owners.set(owner, { rows });
  }

  function firstPresentValue(...values) {
    for (const value of values) {
      if (value === null || value === undefined) continue;
      if (typeof value === "string" && !value.trim()) continue;
      return value;
    }
    return null;
  }

  function firstPresentText(...values) {
    const value = firstPresentValue(...values);
    return value === null ? "" : String(value);
  }

  function firstPresentNumber(...values) {
    const value = firstPresentValue(...values);
    if (value === null) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function dbBoolOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    return Boolean(Number(value));
  }

  function ensureWorkInfoDetailCache() {
    const stamp = getStamp();
    if (workInfoDetailCache?.stamp !== stamp) {
      workInfoDetailCache = { stamp, rows: new Map(), bytes: 0 };
      detailBatch = null;
    }
    return workInfoDetailCache;
  }

  function normalizeDetailWorkId(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? String(number) : "";
  }

  function rememberDetailRow(cache, workId, row, metadataComplete = true) {
    const bytes = detailRowWeight(row);
    // An oversized upgrade must not evict the useful summary of this row.
    if (bytes > DETAIL_CACHE_MAX_BYTES) return;
    const previous = cache.rows.get(workId);
    if (previous) {
      cache.bytes -= previous.bytes;
      cache.rows.delete(workId);
    }
    cache.rows.set(workId, { row, bytes, metadataComplete });
    cache.bytes += bytes;
    while (cache.rows.size > DETAIL_CACHE_MAX_ENTRIES || cache.bytes > DETAIL_CACHE_MAX_BYTES) {
      const oldest = cache.rows.keys().next().value;
      cache.bytes -= cache.rows.get(oldest).bytes;
      cache.rows.delete(oldest);
    }
  }

  function prewarmDetailRows(workIds = [], { includeMetadata = true } = {}) {
    const cache = ensureWorkInfoDetailCache();
    return loadDetailRows(workIds, cache, true, includeMetadata);
  }

  function cachedDetailEntry(cache, workId, includeMetadata) {
    const cached = cache.rows.get(workId);
    if (cached && (!includeMetadata || cached.metadataComplete)) return cached;
    const batched = detailBatch?.cache === cache ? detailBatch.entries.get(workId) : null;
    return batched && (!includeMetadata || batched.metadataComplete) ? batched : null;
  }

  function loadDetailRows(workIds, cache, keepBatch = false, includeMetadata = true) {
    const requested = [...new Set((Array.isArray(workIds) ? workIds : [])
      .map(normalizeDetailWorkId).filter(Boolean))];
    // Keep this call's complete result even when a large batch exceeds the
    // retention budget. Oversized rows must still reach their caller intact.
    const result = new Map();
    const entries = new Map();
    const pending = [];
    for (const workId of requested) {
      const cached = cachedDetailEntry(cache, workId, includeMetadata);
      if (!cached) { pending.push(workId); continue; }
      rememberDetailRow(cache, workId, cached.row, cached.metadataComplete);
      result.set(workId, cached.row);
      entries.set(workId, cached);
    }

    for (let offset = 0; offset < pending.length; offset += DETAIL_BATCH_SIZE) {
      const batch = pending.slice(offset, offset + DETAIL_BATCH_SIZE);
      try {
        const rows = getCoreDb()
          .prepare(workInfoDetailQuery(batch.length, { includeMetadata }))
          .all(...batch.map(Number));
        for (const row of rows) result.set(row.work_id, row);
        for (const workId of batch) {
          const row = result.get(workId) || null;
          // A confirmed absent row is equally absent for both projections.
          const metadataComplete = includeMetadata || row === null;
          result.set(workId, row);
          entries.set(workId, { row, metadataComplete });
          rememberDetailRow(cache, workId, row, metadataComplete);
        }
      } catch (error) {
        console.warn("[core-work-info-detail]", error.message);
        markReadFailure();
        // A transient read failure is not evidence that these records are absent.
        for (const workId of batch) { result.set(workId, null); entries.delete(workId); }
      }
    }

    if (keepBatch) {
      // Presentation immediately consumes a prewarmed page synchronously. Keep
      // that page intact even if it exceeds the persistent LRU; otherwise the
      // following row-by-row presentation would requery every evicted record.
      // Only one cleanup is queued, so earlier pages are not held by closures.
      detailBatch = { cache, entries };
      if (!detailBatchCleanupScheduled) {
        detailBatchCleanupScheduled = true;
        queueMicrotask(() => { detailBatch = null; detailBatchCleanupScheduled = false; });
      }
    }
    return result;
  }

  function detailRow(workId, { includeMetadata = true } = {}) {
    const normalizedId = normalizeDetailWorkId(workId);
    if (!normalizedId) return null;
    const cache = ensureWorkInfoDetailCache();
    const cached = cachedDetailEntry(cache, normalizedId, includeMetadata);
    if (cached) {
      rememberDetailRow(cache, normalizedId, cached.row, cached.metadataComplete);
      return cached.row;
    }
    return loadDetailRows([normalizedId], cache, false, includeMetadata).get(normalizedId) || null;
  }

  function rowsById() {
    const stamp = getStamp();
    if (workInfoCache?.stamp === stamp) return workInfoCache.rows;

    const rows = new Map();
    let owner;
    try {
      owner = getCoreDb();
      const failed = indexFailure("rows", stamp, owner);
      if (failed) return failed.rows;
      for (const row of owner
        .prepare(
          `
          SELECT
            CAST(w.id AS TEXT) AS work_id,
            w.code,
            w.title,
            w.release_date,
            w.duration_minutes,
            w.rating,
            w.rating_count,
            w.director,
            w.has_magnet,
            w.is_streamable,
            w.has_subtitles,
            w.javdb_tags_json,
            w.status,
            w.error,
            w.updated_at
          FROM works w
          WHERE w.status = 'ok'
            AND EXISTS (
              SELECT 1
              FROM local_works lw
              WHERE lw.work_id = w.id
            )
          `
        )
        .all()) {
        rows.set(row.work_id, row);
      }
    } catch (error) {
      console.warn("[core-work-info-index]", error.message);
      markReadFailure();
      const fallback = workInfoCache?.rows || rows;
      rememberIndexFailure("rows", stamp, owner, fallback);
      return fallback;
    }

    workInfoCache = { stamp, rows };
    return rows;
  }

  function facetRowsById() {
    const stamp = getStamp();
    if (workInfoFacetCache?.stamp === stamp) return workInfoFacetCache.rows;

    const rows = new Map();
    let owner;
    try {
      owner = getCoreDb();
      const failed = indexFailure("facets", stamp, owner);
      if (failed) return failed.rows;
      // Older catalogs and isolated consumers may omit these optional metadata
      // columns. Only a confirmed missing-column error permits a projection
      // downgrade; busy, closed or missing-table failures still reach read status.
      const metadataColumns = new Set(["fields_json", "javdb_tags_json"]);
      let statement;
      while (!statement) {
        try {
          statement = owner.prepare(`
          SELECT
            CAST(w.id AS TEXT) AS work_id,
            w.code,
            w.release_date,
            w.duration_minutes,
            w.rating,
            w.rating_count,
            ${metadataColumns.has("fields_json") ? "w.fields_json" : "NULL AS fields_json"},
            ${metadataColumns.has("javdb_tags_json") ? "w.javdb_tags_json" : "NULL AS javdb_tags_json"}
          FROM works w
          WHERE w.status = 'ok'
            AND EXISTS (
              SELECT 1
              FROM local_works lw
              WHERE lw.work_id = w.id
            )
          `);
        } catch (error) {
          const missing = /no such column:\s+(?:w\.)?(fields_json|javdb_tags_json)\b/i.exec(String(error?.message || ""))?.[1];
          if (!missing || !metadataColumns.delete(missing)) throw error;
        }
      }
      for (const row of statement.all()) {
        const { fields_json, javdb_tags_json, ...compact } = row;
        const fields = Object.create(null);
        for (const field of parseJsonArray(fields_json)) {
          const key = String(field?.label || field?.name || field?.key || "").trim();
          if (!key || field?.value === null || field?.value === undefined) continue;
          fields[key] = Object.hasOwn(fields, key) ? [fields[key], field.value].flat() : field.value;
        }
        // Reuse the sidecar parser's field aliases and list syntax. Retain just
        // the small tag array, never the complete fields payload or raw text.
        compact.trait_tags = uniqueTextArray([
          ...parseInfoMetadata(JSON.stringify(fields)).tags,
          ...parseJsonTextArray(javdb_tags_json)
        ], { maxLength: 80, maxItems: 128 });
        rows.set(compact.work_id, compact);
      }
    } catch (error) {
      console.warn("[core-work-info-facets]", error.message);
      markReadFailure();
      const fallback = workInfoFacetCache?.rows || rows;
      rememberIndexFailure("facets", stamp, owner, fallback);
      return fallback;
    }

    workInfoFacetCache = { stamp, rows };
    return rows;
  }

  function facetRow(workId) {
    return facetRowsById().get(String(workId || "")) || null;
  }

  function row(workId) {
    return rowsById().get(workId) || null;
  }

  function entityLinks(rows, fallback = []) {
    const candidates = Array.isArray(rows) && rows.length ? rows : Array.isArray(fallback) ? fallback : [];
    const seen = new Set();
    const links = [];
    for (const item of candidates) {
      const name = String(item?.name || item?.label || item?.text || "").trim();
      const url = publicRemoteUrl(item?.url || item?.href || "");
      const key = `${name.toLowerCase()}\n${url.toLowerCase()}`;
      if (!name || !url || seen.has(key)) continue;
      seen.add(key);
      links.push({ name, url });
    }
    return links;
  }

  function publicSummary(infoRow, fallback = null) {
    if (!infoRow && !fallback) return null;
    const actors = parseJsonTextArray(infoRow?.actors_json);
    const tags = parseJsonTextArray(infoRow?.tags_json);
    const previewImages = proxiedRemoteImageUrlArray(parseJsonArray(infoRow?.preview_images_json));
    return {
      code: firstPresentText(infoRow?.code, fallback?.code),
      title: displayWorkTitle(firstPresentText(infoRow?.title, fallback?.title)),
      javdbUrl: publicRemoteUrl(firstPresentValue(infoRow?.javdb_url, fallback?.javdbUrl)),
      releaseDate: firstPresentText(infoRow?.release_date, fallback?.releaseDate),
      durationMinutes: firstPresentNumber(infoRow?.duration_minutes, fallback?.durationMinutes),
      rating: firstPresentNumber(infoRow?.rating, fallback?.rating),
      ratingCount: firstPresentNumber(infoRow?.rating_count, fallback?.ratingCount),
      hasMagnet: firstPresentValue(dbBoolOrNull(infoRow?.has_magnet), fallback?.hasMagnet),
      isStreamable: firstPresentValue(dbBoolOrNull(infoRow?.is_streamable), fallback?.isStreamable),
      hasSubtitles: firstPresentValue(dbBoolOrNull(infoRow?.has_subtitles), fallback?.hasSubtitles),
      javdbTags: uniqueTextArray([...parseJsonTextArray(infoRow?.javdb_tags_json), ...(fallback?.javdbTags || [])], { maxLength: 40, maxItems: 16 }),
      director: firstPresentText(infoRow?.director, fallback?.director),
      maker: firstPresentText(infoRow?.maker, fallback?.maker),
      makerUrl: publicRemoteUrl(firstPresentValue(infoRow?.maker_url, fallback?.makerUrl)),
      label: firstPresentText(infoRow?.label, fallback?.label),
      labelUrl: publicRemoteUrl(firstPresentValue(infoRow?.label_url, fallback?.labelUrl)),
      series: firstPresentText(infoRow?.series, fallback?.series),
      seriesUrl: publicRemoteUrl(firstPresentValue(infoRow?.series_url, fallback?.seriesUrl)),
      actors: actors.length ? actors : uniqueTextArray(fallback?.actors),
      actorLinks: entityLinks(parseJsonArray(infoRow?.actor_links_json), fallback?.actorLinks),
      tags: tags.length ? tags : uniqueTextArray(fallback?.tags),
      tagLinks: entityLinks(parseJsonArray(infoRow?.tag_links_json), fallback?.tagLinks),
      imageUrl: proxiedRemoteImageUrl(firstPresentValue(infoRow?.image_url, fallback?.imageUrl)),
      previewImages: previewImages.length ? previewImages : proxiedRemoteImageUrlArray(fallback?.previewImages),
      previewVideoUrl: publicRemoteUrl(firstPresentValue(infoRow?.preview_video_url, fallback?.previewVideoUrl))
    };
  }

  function publicMetadata(infoRow) {
    if (!infoRow) return null;
    const info = {
      code: infoRow.code || "",
      title: displayWorkTitle(infoRow.title || ""),
      releaseDate: infoRow.release_date || "",
      durationMinutes: infoRow.duration_minutes ?? null,
      rating: infoRow.rating ?? null,
      ratingCount: infoRow.rating_count ?? null,
      director: infoRow.director || "",
      maker: infoRow.maker || "",
      makerUrl: publicRemoteUrl(infoRow.maker_url),
      label: infoRow.label || "",
      labelUrl: publicRemoteUrl(infoRow.label_url),
      series: infoRow.series || "",
      seriesUrl: publicRemoteUrl(infoRow.series_url),
      javdbUrl: infoRow.javdb_url || "",
      imageUrl: proxiedRemoteImageUrl(infoRow.image_url),
      previewImages: proxiedRemoteImageUrlArray(parseJsonArray(infoRow.preview_images_json)),
      previewVideoUrl: publicRemoteUrl(infoRow.preview_video_url),
      actors: parseJsonTextArray(infoRow.actors_json),
      actorLinks: entityLinks(parseJsonArray(infoRow.actor_links_json)),
      tags: parseJsonTextArray(infoRow.tags_json),
      tagLinks: entityLinks(parseJsonArray(infoRow.tag_links_json)),
      fields: parseJsonArray(infoRow.fields_json),
      rawText: infoRow.raw_text || "",
      rawTextTruncated: Boolean(infoRow.raw_truncated),
      sourceName: infoRow.source_name || "",
      updatedAt: infoRow.updated_at || ""
    };
    if (!info.rawText && info.fields?.length) info.rawText = renderInfoMetadataText(info);
    return info;
  }

  function invalidate() {
    readScope?.failures.clear();
    workInfoCache = null;
    workInfoDetailCache = null;
    workInfoFacetCache = null;
    detailBatch = null;
  }

  function setRowsCache(value) {
    readScope?.failures.clear();
    workInfoCache = value;
    workInfoDetailCache = null;
    workInfoFacetCache = null;
    detailBatch = null;
  }

  return {
    withReadStatus,
    readCacheable,
    entityLinks,
    firstPresentNumber,
    firstPresentText,
    firstPresentValue,
    detailRow,
    facetRow,
    facetRowsById,
    publicMetadata,
    publicSummary,
    prewarmDetailRows,
    row,
    rowsById,
    setRowsCache,
    invalidate
  };
}
