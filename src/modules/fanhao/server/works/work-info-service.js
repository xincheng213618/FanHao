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

  function rowsById() {
    const stamp = getStamp();
    if (workInfoCache?.stamp === stamp) return workInfoCache.rows;

    const rows = new Map();
    try {
      const db = getCoreDb();
      for (const row of db
        .prepare(
          `
          SELECT
            CAST(w.id AS TEXT) AS work_id,
            CAST(p.id AS TEXT) AS person_id,
            COALESCE(p.name, '') AS person_name,
            lw.source_info_id,
            lw.source_name,
            lw.source_info_path AS source_path,
            lw.source_size,
            lw.source_mtime,
            w.code,
            w.title,
            w.release_date,
            w.duration_minutes,
            w.rating,
            w.rating_count,
            w.director,
            maker.name AS maker,
            label.name AS label,
            series.name AS series,
            vref.url AS javdb_url,
            cover.remote_url AS image_url,
            (
              SELECT json_group_array(i.remote_url)
              FROM images i
              WHERE i.owner_type = 'work'
                AND i.owner_id = w.id
                AND i.kind = 'preview'
                AND i.remote_url IS NOT NULL
                AND i.remote_url <> ''
            ) AS preview_images_json,
            NULL AS preview_video_url,
            (
              SELECT json_group_array(pp.name)
              FROM work_people wpa
              JOIN people pp ON pp.id = wpa.person_id
              WHERE wpa.work_id = w.id
                AND wpa.role = 'actor'
            ) AS actors_json,
            (
              SELECT json_group_array(json_object('name', pp.name, 'url', COALESCE(pref.url, '')))
              FROM work_people wpa
              JOIN people pp ON pp.id = wpa.person_id
              LEFT JOIN person_external_refs pref
                ON pref.person_id = pp.id
               AND pref.provider = 'javdb-actor'
              WHERE wpa.work_id = w.id
                AND wpa.role = 'actor'
            ) AS actor_links_json,
            '[]' AS tags_json,
            '[]' AS tag_links_json,
            maker_ref.url AS maker_url,
            label_ref.url AS label_url,
            series_ref.url AS series_url,
            w.fields_json,
            w.raw_text,
            0 AS raw_truncated,
            w.status,
            w.error,
            w.updated_at
          FROM works w
          LEFT JOIN local_works lw ON lw.work_id = w.id
          LEFT JOIN work_people wp ON wp.work_id = w.id AND wp.role = 'actor'
          LEFT JOIN people p ON p.id = wp.person_id
          LEFT JOIN work_external_refs vref ON vref.work_id = w.id AND vref.provider = 'javdb-video'
          LEFT JOIN images cover
            ON cover.id = (
              SELECT i.id
              FROM images i
              WHERE i.owner_type = 'work'
                AND i.owner_id = w.id
                AND i.kind = 'cover'
              ORDER BY CASE WHEN i.image_blob IS NOT NULL THEN 0 ELSE 1 END, i.id ASC
              LIMIT 1
            )
          LEFT JOIN work_makers maker_link ON maker_link.work_id = w.id AND maker_link.role = 'maker'
          LEFT JOIN makers maker ON maker.id = maker_link.maker_id
          LEFT JOIN maker_external_refs maker_ref ON maker_ref.maker_id = maker.id AND maker_ref.provider = 'javdb-maker'
          LEFT JOIN work_makers label_link ON label_link.work_id = w.id AND label_link.role = 'label'
          LEFT JOIN makers label ON label.id = label_link.maker_id
          LEFT JOIN maker_external_refs label_ref ON label_ref.maker_id = label.id AND label_ref.provider = 'javdb-maker'
          LEFT JOIN work_series ws ON ws.work_id = w.id
          LEFT JOIN series ON series.id = ws.series_id
          LEFT JOIN series_external_refs series_ref ON series_ref.series_id = series.id AND series_ref.provider = 'javdb-series'
          WHERE w.status = 'ok'
            AND lw.id IS NOT NULL
          GROUP BY w.id
          `
        )
        .all()) {
        rows.set(row.work_id, row);
      }
    } catch (error) {
      console.warn("[core-work-info]", error.message);
      if (workInfoCache?.rows) return workInfoCache.rows;
    }

    workInfoCache = { stamp, rows };
    return rows;
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
  }

  function setRowsCache(value) {
    workInfoCache = value;
  }

  return {
    entityLinks,
    firstPresentNumber,
    firstPresentText,
    firstPresentValue,
    publicMetadata,
    publicSummary,
    row,
    rowsById,
    setRowsCache,
    invalidate
  };
}
