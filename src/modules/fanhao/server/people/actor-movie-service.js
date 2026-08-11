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
  const LOCAL_CODE_BATCH_SIZE = 200;
  let actorMovieCache = null;
  let actorMovieByCodeKeyCache = null;
  let actorMissingSearchCache = null;
  let actorMoviePersonCache = null;
  let actorMoviePersonIdCache = null;

  function normalizePersonIds(personIds = []) {
    return [...new Set((personIds || [])
      .map((personId) => Number(personId))
      .filter((personId) => Number.isSafeInteger(personId) && personId > 0))]
      .map(String);
  }

  function actorMovieRowsSql(personCount = 0) {
    const personFilter = personCount > 0
      ? `AND wp.person_id IN (${Array.from({ length: personCount }, () => "?").join(", ")})`
      : "";
    return `
          SELECT
            CAST(p.id AS TEXT) AS person_id,
            p.name AS person_name,
            pref.external_key AS javdb_actor_id,
            pref.url AS actor_url,
            CAST(w.id AS TEXT) AS work_id,
            w.code,
            w.code_search AS code_key,
            w.title,
            wref.url AS detail_url,
            cover.id AS cover_image_id,
            cover.remote_url AS image_url,
            cover.local_path AS cover_local_path,
            cover.source AS cover_source,
            cover.updated_at AS cover_updated_at,
            cover.image_blob IS NOT NULL AS cover_has_image_blob,
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
          LEFT JOIN fanhao_images.images cover
            ON cover.id = (
              SELECT i.id
              FROM fanhao_images.images i
              WHERE i.owner_type = 'work'
                AND i.owner_id = w.id
                AND i.kind = 'cover'
              ORDER BY CASE WHEN i.image_blob IS NOT NULL THEN 0 ELSE 1 END, i.sort_order ASC, i.id ASC
              LIMIT 1
            )
          WHERE wp.source = 'actor_movies'
            ${personFilter}
          ORDER BY person_id, COALESCE(position_index, 999999), code
          `;
  }

  function groupRowsByPerson(rows = []) {
    const rowsByPersonMap = new Map();
    for (const row of rows) {
      const personId = String(row.person_id || "");
      if (!rowsByPersonMap.has(personId)) rowsByPersonMap.set(personId, []);
      rowsByPersonMap.get(personId).push({ ...row, person_id: personId });
    }
    return rowsByPersonMap;
  }

  function rowsByPerson() {
    const stamp = getStamp();
    if (actorMovieCache?.stamp === stamp) return actorMovieCache.rows;

    let rowsByPersonMap = new Map();
    try {
      const db = getCoreDb();
      rowsByPersonMap = groupRowsByPerson(db.prepare(actorMovieRowsSql()).all());
    } catch (error) {
      console.warn("[core-actor-movies]", error.message);
      if (actorMovieCache?.rows) return actorMovieCache.rows;
    }

    actorMovieCache = { stamp, rows: rowsByPersonMap };
    actorMoviePersonCache = { stamp, rows: new Map(rowsByPersonMap) };
    actorMoviePersonIdCache = { stamp, ids: new Set(rowsByPersonMap.keys()) };
    return rowsByPersonMap;
  }

  function rowsForPeople(personIds = []) {
    const ids = normalizePersonIds(personIds);
    if (!ids.length) return new Map();
    const stamp = getStamp();
    if (actorMovieCache?.stamp === stamp) {
      return new Map(ids.map((personId) => [personId, actorMovieCache.rows.get(personId) || []]));
    }
    if (actorMoviePersonCache?.stamp !== stamp) {
      actorMoviePersonCache = { stamp, rows: new Map() };
    }

    const missingIds = ids.filter((personId) => !actorMoviePersonCache.rows.has(personId));
    if (missingIds.length) {
      try {
        const loaded = groupRowsByPerson(
          getCoreDb()
            .prepare(actorMovieRowsSql(missingIds.length))
            .all(...missingIds.map(Number))
        );
        for (const personId of missingIds) {
          actorMoviePersonCache.rows.set(personId, loaded.get(personId) || []);
        }
      } catch (error) {
        console.warn("[core-actor-movies-person]", error.message);
      }
    }
    return new Map(ids.map((personId) => [personId, actorMoviePersonCache.rows.get(personId) || []]));
  }

  function rows(personId) {
    const id = normalizePersonIds([personId])[0];
    return id ? rowsForPeople([id]).get(id) || [] : [];
  }

  function mergedRows(personId) {
    const result = [];
    const seen = new Set();
    const members = mergedPersonMembers(personId);
    const memberRows = rowsForPeople(members.map((person) => person?.id));
    for (const person of members) {
      for (const row of memberRows.get(String(person.id || "")) || []) {
        const key = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code) || row.detail_url || `${row.person_id}:${row.code}:${row.title}`;
        if (key && seen.has(key)) continue;
        if (key) seen.add(key);
        result.push(row);
      }
    }
    return result;
  }

  function actorMoviePersonIds() {
    const stamp = getStamp();
    if (actorMoviePersonIdCache?.stamp === stamp) return actorMoviePersonIdCache.ids;
    if (actorMovieCache?.stamp === stamp) {
      actorMoviePersonIdCache = { stamp, ids: new Set(actorMovieCache.rows.keys()) };
      return actorMoviePersonIdCache.ids;
    }

    let ids = new Set();
    try {
      ids = new Set(getCoreDb()
        .prepare(`
          SELECT DISTINCT CAST(person_id AS TEXT) AS person_id
          FROM work_people
          WHERE source = 'actor_movies'
        `)
        .all()
        .map((row) => String(row.person_id || ""))
        .filter(Boolean));
    } catch (error) {
      console.warn("[core-actor-movie-people]", error.message);
      if (actorMoviePersonIdCache?.ids) return actorMoviePersonIdCache.ids;
    }
    actorMoviePersonIdCache = { stamp, ids };
    return ids;
  }

  function hasMergedRows(personId) {
    const ids = actorMoviePersonIds();
    return mergedPersonMembers(personId).some((person) => ids.has(String(person?.id || "")));
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
    const coverImageId = Number(row.cover_image_id);
    const sourceCoverUrl = row.image_url || row.cover_local_path || "";
    const cachedCoverUrl = Number.isSafeInteger(coverImageId) && coverImageId > 0 && Boolean(row.cover_has_image_blob)
      ? `/media/core-image/${encodeURIComponent(String(coverImageId))}?v=${encodeURIComponent(row.cover_updated_at || "")}`
      : proxiedRemoteImageUrl(row.image_url) || row.cover_local_path || "";
    const cachedCover = cachedCoverUrl ? {
      workId: String(row.work_id || ""),
      coverUrl: cachedCoverUrl,
      sourceCoverUrl,
      source: row.cover_source || "",
      updatedAt: row.cover_updated_at || ""
    } : null;
    return {
      id: createId("m", `${person.id}|${row.detail_url || codeKey}`),
      personId: person.id,
      personName: person.name,
      title,
      directoryName: code,
      relativePath: "",
      coverId: null,
      cachedCover,
      remoteCoverUrl: cachedCoverUrl || proxiedRemoteImageUrl(row.image_url),
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

  function localCodeKeysForRows(rows = [], extraKeys = new Set()) {
    const candidates = [...new Set(rows
      .map((row) => storedWorkCodeKey(row?.code_key) || looseWorkCodeKey(row?.code))
      .filter(Boolean))];
    const keys = new Set([...extraKeys]
      .map((value) => storedWorkCodeKey(value))
      .filter(Boolean));
    for (let offset = 0; offset < candidates.length; offset += LOCAL_CODE_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + LOCAL_CODE_BATCH_SIZE);
      try {
        const placeholders = batch.map(() => "?").join(", ");
        for (const row of getCoreDb()
          .prepare(`
            SELECT DISTINCT w.code_search AS code_key
            FROM works w
            WHERE w.code_search IN (${placeholders})
              AND EXISTS (
                SELECT 1
                FROM local_works lw
                WHERE lw.work_id = w.id
              )
          `)
          .all(...batch)) {
          const codeKey = storedWorkCodeKey(row.code_key);
          if (codeKey) keys.add(codeKey);
        }
      } catch (error) {
        console.warn("[core-actor-movies-local-codes]", error.message);
        return combinedLocalCodeKeys(extraKeys);
      }
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

  function missingSearchWorksForPeople(personIds = [], excludedCodeKeys = new Set()) {
    const ids = normalizePersonIds(personIds);
    if (!ids.length) return [];
    const library = getLibrary();
    const byPerson = rowsForPeople(ids);
    const personRows = ids.flatMap((personId) => byPerson.get(personId) || []);
    // Exact-person searches only need to test the selected filmography's codes.
    // Query those codes through the compact works/local_works indexes instead of
    // synchronously building the full filesystem-derived code index.
    const localKeys = localCodeKeysForRows(personRows);
    const seen = new Set();
    const works = [];

    for (const personId of ids) {
      const person = library.peopleById?.get(personId);
      if (!person) continue;
      for (const row of byPerson.get(personId) || []) {
        const codeKey = storedWorkCodeKey(row.code_key) || looseWorkCodeKey(row.code);
        if (!codeKey || seen.has(codeKey) || localKeys.has(codeKey)) continue;
        seen.add(codeKey);
        works.push(missingWorkFromRow(person, row, codeKey));
      }
    }
    return filterExcludedMissingWorks(works, excludedCodeKeys);
  }

  function missingWorksForPerson(person, personRows = rows(person.id), excludedCodeKeys = new Set()) {
    const localKeys = localCodeKeysForRows(personRows, excludedCodeKeys);
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
    actorMoviePersonCache = null;
    actorMoviePersonIdCache = null;
  }

  function invalidateSearch() {
    actorMissingSearchCache = null;
  }

  function setRowsCache(value) {
    actorMovieCache = value;
    actorMovieByCodeKeyCache = null;
    actorMissingSearchCache = null;
    actorMoviePersonCache = null;
    actorMoviePersonIdCache = null;
  }

  return {
    enrichLocalWorks,
    enrichLocalWorksWithIndex,
    infoSummary,
    invalidate,
    invalidateSearch,
    missingSearchWorks,
    missingSearchWorksForPeople,
    missingWorkFromRow,
    missingWorksForPerson,
    mergedRows,
    hasMergedRows,
    rows,
    rowsByCodeKey,
    rowsByPerson,
    rowsForPeople,
    rowsForWorks,
    setRowsCache
  };
}
