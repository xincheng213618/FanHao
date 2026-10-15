export function createWorkSearchIndexService({
  getCoreDb,
  getLibrary,
  getSourceStamp,
  getWorkInfoStamp,
  normalizeSearchValue,
  parseJsonArray,
  parseJsonTextArray
}) {
  let workInfoCache = null;
  let workTextCache = null;
  let gramIndexCache = null;

  function workInfoRows() {
    const library = getLibrary();
    const stamp = `${library.scannedAt || ""}:${getWorkInfoStamp()}`;
    if (workInfoCache?.stamp === stamp) return workInfoCache.rows;

    const rows = new Map();
    try {
      const db = getCoreDb();
      for (const row of db.prepare(`
        SELECT CAST(id AS TEXT) AS work_id, code, title, director,
               fields_json, raw_text, javdb_tags_json AS tags_json
        FROM works
        WHERE status = 'ok'
          AND EXISTS (
            SELECT 1
            FROM local_works lw
            WHERE lw.work_id = works.id
          )
      `).all()) {
        rows.set(row.work_id, { ...row, actors: [] });
      }

      for (const row of db.prepare(`
        SELECT CAST(wp.work_id AS TEXT) AS work_id, p.name
        FROM work_people wp
        JOIN people p ON p.id = wp.person_id
        WHERE wp.role = 'actor'
          AND EXISTS (
            SELECT 1
            FROM local_works lw
            WHERE lw.work_id = wp.work_id
          )
      `).all()) {
        const info = rows.get(row.work_id);
        if (info && row.name) info.actors.push(row.name);
      }

      for (const row of db.prepare(`
        SELECT CAST(wm.work_id AS TEXT) AS work_id, wm.role, m.name
        FROM work_makers wm
        JOIN makers m ON m.id = wm.maker_id
        WHERE wm.role IN ('maker', 'label')
          AND EXISTS (
            SELECT 1
            FROM local_works lw
            WHERE lw.work_id = wm.work_id
          )
      `).all()) {
        const info = rows.get(row.work_id);
        if (info && row.name && !info[row.role]) info[row.role] = row.name;
      }

      for (const row of db.prepare(`
        SELECT CAST(ws.work_id AS TEXT) AS work_id, s.name
        FROM work_series ws
        JOIN series s ON s.id = ws.series_id
        WHERE EXISTS (
          SELECT 1
          FROM local_works lw
          WHERE lw.work_id = ws.work_id
        )
      `).all()) {
        const info = rows.get(row.work_id);
        if (info && row.name && !info.series) info.series = row.name;
      }
    } catch (error) {
      console.warn("[work-search-index]", error.message || error);
    }

    workInfoCache = { stamp, rows };
    return rows;
  }

  function buildWorkEntry(work) {
    const library = getLibrary();
    const person = library.peopleById.get(work.personId);
    const info = workInfoRows().get(String(work.id || "")) || null;
    const infoFields = parseJsonArray(info?.fields_json).flatMap((field) => [field?.label, field?.value]);
    const normalizedValues = [
      work.title,
      work.directoryName,
      work.personName,
      person?.name,
      info?.code,
      info?.title,
      info?.person_name,
      info?.director,
      info?.maker,
      info?.label,
      info?.series,
      ...(info?.actors || []),
      ...parseJsonTextArray(info?.tags_json)
    ].filter(Boolean);
    const text = [
      ...normalizedValues,
      work.relativePath,
      ...infoFields,
      info?.raw_text,
      ...(work.videos || []).flatMap((video) => [video.name, video.title, video.relativePath]),
      ...(work.images || []).flatMap((image) => [image.name, image.title]),
      ...(work.infos || []).flatMap((infoFile) => [infoFile.name, infoFile.title])
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    return {
      text,
      normalized: normalizeSearchValue(normalizedValues.join("\n"))
    };
  }

  function workTextEntry(work, stamp = getSourceStamp()) {
    if (workTextCache?.stamp !== stamp) {
      workTextCache = { stamp, rows: new Map() };
    }

    const key = work?.id || `${work?.personId || ""}:${work?.directoryName || ""}:${work?.title || ""}`;
    const cached = workTextCache.rows.get(key);
    if (cached) return cached;

    const entry = buildWorkEntry(work);
    workTextCache.rows.set(key, entry);
    return entry;
  }

  function addBigrams(target, value) {
    const text = String(value || "");
    for (let index = 0; index + 1 < text.length; index += 1) {
      target.add(text.slice(index, index + 2));
    }
  }

  function ensureGramIndex(extraWorks = []) {
    const stamp = getSourceStamp();
    if (gramIndexCache?.stamp === stamp) {
      let coversExtraWorks = true;
      for (const work of extraWorks || []) {
        if (work?.id && !gramIndexCache.indexedWorkIds.has(work.id)) {
          coversExtraWorks = false;
          break;
        }
      }
      if (coversExtraWorks) return gramIndexCache;
    }

    const postings = new Map();
    const worksById = new Map(getLibrary().worksById);
    for (const work of extraWorks || []) {
      if (work?.id) worksById.set(work.id, work);
    }
    for (const work of worksById.values()) {
      const entry = workTextEntry(work, stamp);
      const grams = new Set();
      addBigrams(grams, entry.text);
      addBigrams(grams, entry.normalized);
      for (const gram of grams) {
        const existing = postings.get(gram);
        if (existing) existing.push(work.id);
        else postings.set(gram, [work.id]);
      }
    }

    gramIndexCache = { stamp, indexedWorkIds: new Set(worksById.keys()), postings };
    return gramIndexCache;
  }

  function rarestPosting(value, postings) {
    const text = String(value || "");
    if (text.length < 2) return null;
    let rarest = null;
    for (let index = 0; index + 1 < text.length; index += 1) {
      const posting = postings.get(text.slice(index, index + 2));
      if (!posting) return [];
      if (!rarest || posting.length < rarest.length) rarest = posting;
    }
    return rarest || [];
  }

  function indexedCandidates(loweredQuery, normalizedQuery, postings) {
    if (loweredQuery.length < 2) return null;
    const rawPosting = rarestPosting(loweredQuery, postings);
    const normalizedPosting = normalizedQuery.length >= 2
      ? rarestPosting(normalizedQuery, postings)
      : null;
    if (!normalizedPosting || normalizedPosting === rawPosting) return new Set(rawPosting);
    return new Set([...rawPosting, ...normalizedPosting]);
  }

  function createMatcher(query) {
    const normalizedQuery = normalizeSearchValue(query);
    const loweredQuery = String(query || "").toLowerCase();
    const stamp = getSourceStamp();
    const gramIndex = ensureGramIndex();
    const candidateIds = indexedCandidates(loweredQuery, normalizedQuery, gramIndex.postings);

    return (work) => {
      if (!loweredQuery) return true;
      const isIndexedWork = gramIndex.indexedWorkIds.has(work.id);
      if (candidateIds && isIndexedWork && !candidateIds.has(work.id)) return false;
      const { text, normalized } = workTextEntry(work, stamp);
      return text.includes(loweredQuery) || (normalizedQuery.length >= 2 && normalized.includes(normalizedQuery));
    };
  }

  function prewarm(extraWorks = []) {
    ensureGramIndex(extraWorks);
  }

  function invalidate() {
    workInfoCache = null;
    workTextCache = null;
    gramIndexCache = null;
  }

  return { createMatcher, invalidate, prewarm };
}
