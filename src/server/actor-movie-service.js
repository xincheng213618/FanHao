export function createActorMovieService({
  createId,
  dbBoolOrNull,
  getCoreDb,
  getLibrary,
  getSearchStamp,
  getStamp,
  localWorkCodeKeys,
  looseWorkCodeKey,
  mergedPersonMembers,
  normalizeWorkCode,
  parseJsonTextArray,
  proxiedRemoteImageUrl,
  publicRemoteUrl,
  storedWorkCodeKey,
  workCodeKeys
}) {
  let actorMovieCache = null;
  let actorMovieByCodeKeyCache = null;
  let actorMissingSearchCache = null;

  function rowsByPerson() {
    const stamp = getStamp();
    if (actorMovieCache?.stamp === stamp) return actorMovieCache.rows;

    const rowsByPersonMap = new Map();
    try {
      const db = getCoreDb();
      const rows = db
        .prepare(
          `
          SELECT
            CAST(p.id AS TEXT) AS person_id,
            p.name AS person_name,
            pref.external_key AS javdb_actor_id,
            pref.url AS actor_url,
            w.code,
            w.code_search AS code_key,
            w.title,
            wref.url AS detail_url,
            cover.remote_url AS image_url,
            w.release_date,
            w.rating,
            w.rating_count,
            w.has_magnet,
            w.is_streamable,
            w.has_subtitles,
            w.javdb_tags_json,
            0 AS page_index,
            wp.sort_order AS position_index,
            wp.created_at AS fetched_at,
            wp.updated_at
          FROM work_people wp
          JOIN people p ON p.id = wp.person_id
          JOIN works w ON w.id = wp.work_id
          LEFT JOIN person_external_refs pref
            ON pref.id = (
              SELECT pref2.id
              FROM person_external_refs pref2
              WHERE pref2.person_id = p.id
                AND pref2.provider = 'javdb-actor'
              ORDER BY pref2.id ASC
              LIMIT 1
            )
          LEFT JOIN work_external_refs wref
            ON wref.work_id = w.id
           AND wref.provider = 'javdb-video'
          LEFT JOIN images cover
            ON cover.id = (
              SELECT i.id
              FROM images i
              WHERE i.owner_type = 'work'
                AND i.owner_id = w.id
                AND i.kind = 'cover'
              ORDER BY CASE WHEN i.source = 'actor_movies' THEN 0 ELSE 1 END, i.id ASC
              LIMIT 1
            )
          WHERE wp.source = 'actor_movies'
          ORDER BY person_id, COALESCE(position_index, 999999), code
          `
        )
        .all();
      for (const row of rows) {
        const personId = String(row.person_id || "");
        if (!rowsByPersonMap.has(personId)) rowsByPersonMap.set(personId, []);
        rowsByPersonMap.get(personId).push({ ...row, person_id: personId });
      }
    } catch (error) {
      console.warn("[core-actor-movies]", error.message);
      if (actorMovieCache?.rows) return actorMovieCache.rows;
    }

    actorMovieCache = { stamp, rows: rowsByPersonMap };
    return rowsByPersonMap;
  }

  function rows(personId) {
    return rowsByPerson().get(personId) || [];
  }

  function mergedRows(personId) {
    const result = [];
    const seen = new Set();
    for (const person of mergedPersonMembers(personId)) {
      for (const row of rows(person.id)) {
        const key = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code) || row.detail_url || `${row.person_id}:${row.code}:${row.title}`;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        result.push(row);
      }
    }
    return result;
  }

  function rowsByCodeKey() {
    const stamp = getStamp();
    if (actorMovieByCodeKeyCache?.stamp === stamp) return actorMovieByCodeKeyCache.rows;

    const rowsByCode = new Map();
    for (const personRows of rowsByPerson().values()) {
      for (const row of personRows) {
        const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
        if (codeKey && !rowsByCode.has(codeKey)) rowsByCode.set(codeKey, row);
      }
    }

    actorMovieByCodeKeyCache = { stamp, rows: rowsByCode };
    return rowsByCode;
  }

  function rowsForWorks(works = []) {
    if (!works.length) return [];
    const byCodeKey = rowsByCodeKey();
    if (!byCodeKey.size) return [];

    const result = [];
    const seen = new Set();
    for (const work of works) {
      for (const codeKey of workCodeKeys(work)) {
        if (!codeKey || seen.has(codeKey)) continue;
        const row = byCodeKey.get(codeKey);
        if (!row) continue;
        seen.add(codeKey);
        result.push(row);
        break;
      }
    }
    return result;
  }

  function infoSummary(row, fallbackCode = "") {
    return {
      code: normalizeWorkCode(row?.code) || fallbackCode || row?.code || "",
      title: row?.title || "",
      javdbUrl: publicRemoteUrl(row?.detail_url),
      releaseDate: row?.release_date || "",
      durationMinutes: null,
      rating: row?.rating ?? null,
      ratingCount: row?.rating_count ?? null,
      hasMagnet: dbBoolOrNull(row?.has_magnet),
      isStreamable: dbBoolOrNull(row?.is_streamable),
      hasSubtitles: dbBoolOrNull(row?.has_subtitles),
      javdbTags: parseJsonTextArray(row?.javdb_tags_json)
    };
  }

  function enrichLocalWorks(localWorks, actorRows = []) {
    if (!actorRows.length || !localWorks.length) return localWorks;

    const localByCodeKey = new Map();
    for (const work of localWorks) {
      for (const codeKey of workCodeKeys(work)) {
        if (!localByCodeKey.has(codeKey)) localByCodeKey.set(codeKey, work);
      }
    }

    const fallbackByWorkId = new Map();
    for (const row of actorRows) {
      const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
      const work = codeKey ? localByCodeKey.get(codeKey) : null;
      if (!work || fallbackByWorkId.has(work.id)) continue;
      fallbackByWorkId.set(work.id, infoSummary(row, codeKey));
    }

    if (!fallbackByWorkId.size) return localWorks;
    return localWorks.map((work) => {
      const fallback = fallbackByWorkId.get(work.id);
      if (!fallback) return work;
      return {
        ...work,
        infoSummary: {
          ...fallback,
          ...(work.infoSummary || {})
        }
      };
    });
  }

  function enrichLocalWorksWithIndex(localWorks) {
    return enrichLocalWorks(localWorks, rowsForWorks(localWorks));
  }

  function missingWorkFromRow(person, row, codeKey = "") {
    const code = normalizeWorkCode(row.code) || row.code || "";
    const title = row.title && row.title !== row.code ? row.title : code || row.title || "未下载作品";
    return {
      id: createId("m", `${person.id}|${row.detail_url || codeKey}`),
      personId: person.id,
      personName: person.name,
      title,
      directoryName: code,
      relativePath: "",
      coverId: null,
      remoteCoverUrl: proxiedRemoteImageUrl(row.image_url),
      videoCount: 0,
      playableCount: 0,
      imageCount: 0,
      infoCount: 0,
      videos: [],
      images: [],
      infos: [],
      modifiedAt: "",
      missingLocal: true,
      javdbUrl: row.detail_url || "",
      actorUrl: row.actor_url || "",
      infoSummary: infoSummary(row, code)
    };
  }

  function combinedLocalCodeKeys(extraKeys = new Set()) {
    const keys = new Set(localWorkCodeKeys());
    for (const key of extraKeys || []) {
      const codeKey = storedWorkCodeKey(key);
      if (codeKey) keys.add(codeKey);
    }
    return keys;
  }

  function filterExcludedMissingWorks(works, excludedCodeKeys = new Set()) {
    if (!excludedCodeKeys?.size) return works;
    return works.filter((work) => {
      const codeKey = storedWorkCodeKey(work.infoSummary?.code || work.directoryName || work.title);
      return !codeKey || !excludedCodeKeys.has(codeKey);
    });
  }

  function missingSearchWorks(excludedCodeKeys = new Set()) {
    const stamp = getSearchStamp();
    if (actorMissingSearchCache?.stamp === stamp) {
      return filterExcludedMissingWorks(actorMissingSearchCache.works, excludedCodeKeys);
    }

    const library = getLibrary();
    const localKeys = localWorkCodeKeys();
    const seen = new Set();
    const works = [];
    const byPerson = rowsByPerson();

    for (const person of library.people) {
      const personRows = byPerson.get(person.id) || [];
      for (const row of personRows) {
        const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
        if (!codeKey || seen.has(codeKey) || localKeys.has(codeKey)) continue;
        seen.add(codeKey);
        works.push(missingWorkFromRow(person, row, codeKey));
      }
    }

    actorMissingSearchCache = { stamp, works };
    return filterExcludedMissingWorks(works, excludedCodeKeys);
  }

  function missingWorksForPerson(person, personRows = rows(person.id), excludedCodeKeys = new Set()) {
    const localKeys = combinedLocalCodeKeys(excludedCodeKeys);
    const seen = new Set();
    const missing = [];

    for (const row of personRows) {
      const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
      if (!codeKey || seen.has(codeKey) || localKeys.has(codeKey)) continue;
      seen.add(codeKey);
      missing.push(missingWorkFromRow(person, row, codeKey));
    }

    return missing;
  }

  function invalidate() {
    actorMovieCache = null;
    actorMovieByCodeKeyCache = null;
    actorMissingSearchCache = null;
  }

  function invalidateSearch() {
    actorMissingSearchCache = null;
  }

  function setRowsCache(value) {
    actorMovieCache = value;
    actorMovieByCodeKeyCache = null;
    actorMissingSearchCache = null;
  }

  return {
    enrichLocalWorks,
    enrichLocalWorksWithIndex,
    infoSummary,
    invalidate,
    invalidateSearch,
    missingSearchWorks,
    missingWorkFromRow,
    missingWorksForPerson,
    mergedRows,
    rows,
    rowsByCodeKey,
    rowsByPerson,
    rowsForWorks,
    setRowsCache
  };
}
