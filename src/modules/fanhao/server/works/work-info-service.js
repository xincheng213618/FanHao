import { workInfoDetailQuery } from "./work-info-detail-query.js";

const DETAIL_BATCH_SIZE = 200;

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
      workInfoDetailCache = { stamp, rows: new Map() };
    }
    return workInfoDetailCache;
  }

  function normalizeDetailWorkId(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? String(number) : "";
  }

  function prewarmDetailRows(workIds = []) {
    const cache = ensureWorkInfoDetailCache();
    const pending = [...new Set((Array.isArray(workIds) ? workIds : [])
      .map(normalizeDetailWorkId)
      .filter((workId) => workId && !cache.rows.has(workId)))];
    if (!pending.length) return cache.rows;

    for (let offset = 0; offset < pending.length; offset += DETAIL_BATCH_SIZE) {
      const batch = pending.slice(offset, offset + DETAIL_BATCH_SIZE);
      try {
        const rows = getCoreDb()
          .prepare(workInfoDetailQuery(batch.length))
          .all(...batch.map(Number));
        for (const row of rows) cache.rows.set(row.work_id, row);
      } catch (error) {
        console.warn("[core-work-info-detail]", error.message);
      }
      for (const workId of batch) {
        if (!cache.rows.has(workId)) cache.rows.set(workId, null);
      }
    }

    return cache.rows;
  }

  function detailRow(workId) {
    const normalizedId = normalizeDetailWorkId(workId);
    if (!normalizedId) return null;
    return prewarmDetailRows([normalizedId]).get(normalizedId) || null;
  }

  function rowsById() {
    const stamp = getStamp();
    if (workInfoCache?.stamp === stamp) return workInfoCache.rows;

    const rows = new Map();
    try {
      for (const row of getCoreDb()
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
      if (workInfoCache?.rows) return workInfoCache.rows;
    }

    workInfoCache = { stamp, rows };
    return rows;
  }

  function facetRowsById() {
    const stamp = getStamp();
    if (workInfoFacetCache?.stamp === stamp) return workInfoFacetCache.rows;

    const rows = new Map();
    try {
      for (const row of getCoreDb()
        .prepare(
          `
          SELECT
            CAST(w.id AS TEXT) AS work_id,
            w.code,
            w.release_date,
            w.duration_minutes,
            w.rating,
            w.rating_count
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
      console.warn("[core-work-info-facets]", error.message);
      if (workInfoFacetCache?.rows) return workInfoFacetCache.rows;
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
    workInfoCache = null;
    workInfoDetailCache = null;
    workInfoFacetCache = null;
  }

  function setRowsCache(value) {
    workInfoCache = value;
    workInfoDetailCache = null;
    workInfoFacetCache = null;
  }

  return {
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
