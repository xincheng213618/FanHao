export function createMissingCodeSearchService({
  dbBoolOrNull,
  getCoverStamp = () => "",
  getCoreDb,
  getSourceStamp = () => "",
  normalizeWorkCode,
  parseJsonTextArray,
  proxiedRemoteImageUrl,
  publicRemoteUrl,
  storedWorkCodeKey,
  warn = console.warn
}) {
  let coverWorkIdsCache = null;
  let missingWorkIndexCache = { stamp: "", prefixes: new Map() };

  function coverWorkIds() {
    const stamp = String(getCoverStamp() || "");
    if (coverWorkIdsCache?.stamp === stamp) return coverWorkIdsCache.ids;

    try {
      const rows = getCoreDb().prepare(`
        SELECT image.owner_id
        FROM fanhao_images.images image
        WHERE image.owner_type = 'work'
          AND image.kind = 'cover'
        GROUP BY image.owner_id
      `).all();
      const ids = new Set(rows.map((row) => String(row.owner_id)));
      coverWorkIdsCache = { stamp, ids };
      return ids;
    } catch (error) {
      warn("[fast-code-search-covers]", error?.message || error);
      return coverWorkIdsCache?.ids || new Set();
    }
  }

  function search(rawQuery) {
    const prefix = storedWorkCodeKey(rawQuery);
    if (!prefix) return [];

    try {
      const entries = missingWorkPrefix(prefix);
      const start = lowerBound(entries, prefix);
      const works = [];
      for (let index = start; index < entries.length && entries[index].key.startsWith(prefix); index += 1) {
        works.push(entries[index].work);
      }
      return works;
    } catch (error) {
      warn("[fast-code-search]", error?.message || error);
      return [];
    }
  }

  function missingWorkPrefix(prefix) {
    const stamp = `${getSourceStamp()}:${getCoverStamp()}`;
    if (missingWorkIndexCache.stamp !== stamp) {
      missingWorkIndexCache = { stamp, prefixes: new Map() };
    }
    for (let length = prefix.length; length > 0; length -= 1) {
      const cached = missingWorkIndexCache.prefixes.get(prefix.slice(0, length));
      if (cached) return cached;
    }

    const coverIds = coverWorkIds();
    const rows = getCoreDb().prepare(`
        SELECT
          CAST(w.id AS TEXT) AS work_id,
          w.code_search AS code_key,
          w.code,
          w.title,
          w.release_date,
          w.duration_minutes,
          w.rating,
          w.rating_count,
          w.has_magnet,
          w.is_streamable,
          w.has_subtitles,
          w.updated_at
        FROM works w
        WHERE w.status = 'ok'
          AND w.code_search LIKE ?
          AND NOT EXISTS (
            SELECT 1
            FROM works local_code
            JOIN local_works lw ON lw.work_id = local_code.id
            WHERE local_code.code_search = w.code_search
        )
        ORDER BY w.code_search, w.id
      `).all(`${prefix}%`);
    const entries = rows.map((row) => ({
      key: String(row.code_key || ""),
      work: lightweightMissingWork(row, coverIds.has(String(row.work_id)))
    }));
    missingWorkIndexCache.prefixes.set(prefix, entries);
    return entries;
  }

  function lowerBound(entries, prefix) {
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (entries[middle].key < prefix) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function hydrate(works = []) {
    const pending = (Array.isArray(works) ? works : []).filter((work) => work?.missingCodeSearchPending && /^\d+$/.test(String(work.id || "")));
    if (!pending.length) return works;

    try {
      const placeholders = pending.map(() => "?").join(", ");
      const rows = getCoreDb().prepare(`
        SELECT
          CAST(w.id AS TEXT) AS work_id,
          w.javdb_tags_json,
          CAST((
            SELECT wp.person_id
            FROM work_people wp
            WHERE wp.work_id = w.id AND wp.role = 'actor'
            ORDER BY wp.sort_order, wp.person_id
            LIMIT 1
          ) AS TEXT) AS person_id,
          (
            SELECT p.name
            FROM work_people wp
            JOIN people p ON p.id = wp.person_id
            WHERE wp.work_id = w.id AND wp.role = 'actor'
            ORDER BY wp.sort_order, wp.person_id
            LIMIT 1
          ) AS person_name,
          (
            SELECT ref.url
            FROM work_external_refs ref
            WHERE ref.work_id = w.id AND ref.provider = 'javdb-video'
            LIMIT 1
          ) AS detail_url,
          (
            SELECT image.remote_url
            FROM fanhao_images.images image
            WHERE image.owner_type = 'work'
              AND image.owner_id = w.id
              AND image.kind = 'cover'
            ORDER BY image.id
            LIMIT 1
          ) AS image_url
        FROM works w
        WHERE w.id IN (${placeholders})
      `).all(...pending.map((work) => Number(work.id)));
      const detailsById = new Map(rows.map((row) => [String(row.work_id), row]));
      for (const work of pending) hydrateWork(work, detailsById.get(String(work.id)) || null);
    } catch (error) {
      warn("[fast-code-search-hydrate]", error?.message || error);
    }
    return works;
  }

  function lightweightMissingWork(row, hasCover) {
    const code = normalizeWorkCode(row.code) || row.code || "";
    return {
      id: row.work_id,
      personId: "",
      personName: "",
      title: row.title && row.title !== row.code ? row.title : code || row.title || "未下载作品",
      directoryName: code,
      relativePath: "",
      coverId: null,
      remoteCoverUrl: "",
      videoCount: 0,
      playableCount: 0,
      imageCount: 0,
      infoCount: 0,
      videos: [],
      images: [],
      infos: [],
      modifiedAt: row.updated_at || "",
      missingLocal: true,
      missingCodeSearchPending: true,
      searchHasCover: hasCover,
      javdbUrl: "",
      actorUrl: "",
      infoSummary: {
        code,
        title: row.title || "",
        javdbUrl: "",
        releaseDate: row.release_date || "",
        durationMinutes: row.duration_minutes ?? null,
        rating: row.rating ?? null,
        ratingCount: row.rating_count ?? null,
        hasMagnet: dbBoolOrNull(row.has_magnet),
        isStreamable: dbBoolOrNull(row.is_streamable),
        hasSubtitles: dbBoolOrNull(row.has_subtitles),
        javdbTags: []
      }
    };
  }

  function hydrateWork(work, row) {
    delete work.missingCodeSearchPending;
    if (!row) return;
    const detailUrl = publicRemoteUrl(row.detail_url);
    work.personId = row.person_id || "";
    work.personName = row.person_name || "";
    work.remoteCoverUrl = proxiedRemoteImageUrl(row.image_url);
    work.javdbUrl = detailUrl;
    work.infoSummary.javdbUrl = detailUrl;
    work.infoSummary.javdbTags = parseJsonTextArray(row.javdb_tags_json);
  }

  function prewarm() {
    coverWorkIds();
  }

  return { hydrate, prewarm, search };
}
