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
  let readScope = null;

  function withReadStatus(callback) {
    const previous = readScope;
    const scope = { cacheable: true, failures: previous?.failures || new Map(), grams: previous?.grams || new Map() };
    readScope = scope;
    try {
      return { value: callback(), cacheable: scope.cacheable };
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

  function workInfoRows() {
    const library = getLibrary();
    const stamp = `${library.scannedAt || ""}:${getWorkInfoStamp()}`;
    if (workInfoCache?.stamp === stamp) return { rows: workInfoCache.rows, cacheable: true };

    const rows = new Map();
    let db;
    try {
      db = getCoreDb();
      const failed = readScope?.failures.get(stamp)?.get(db);
      if (failed) {
        markReadFailure();
        return failed;
      }
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
      markReadFailure();
      const failed = { rows, cacheable: false };
      if (readScope) {
        let owners = readScope.failures.get(stamp);
        if (!owners) readScope.failures.set(stamp, owners = new Map());
        owners.set(db, failed);
      }
      // Preserve this read's partial map, but retry on the next operation.
      return failed;
    }

    workInfoCache = { stamp, rows };
    return { rows, cacheable: true };
  }

  function buildWorkEntry(work, infoRows, cacheable) {
    const library = getLibrary();
    const person = library.peopleById.get(work.personId);
    const info = infoRows.get(String(work.id || "")) || null;
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
    const prefixValues = [...normalizedValues, work.relativePath].filter(Boolean);
    const metadataValues = info?.searchMetadata
      ? info.searchMetadata.present ? [info.searchMetadata.text.slice(info.searchMetadata.start, info.searchMetadata.end)] : []
      : [...parseJsonArray(info?.fields_json).flatMap((field) => [field?.label, field?.value]), info?.raw_text].filter(Boolean);
    const mediaValues = [
      ...(work.videos || []).flatMap((video) => [video.name, video.title, video.relativePath]),
      ...(work.images || []).flatMap((image) => [image.name, image.title]),
      ...(work.infos || []).flatMap((infoFile) => [infoFile.name, infoFile.title])
    ].filter(Boolean);
    const entry = {
      text: [...prefixValues, ...metadataValues, ...mediaValues].join("\n").toLowerCase(),
      normalized: normalizeSearchValue(normalizedValues.join("\n"))
    };
    if (cacheable && info) {
      // Keep metadata as a range of the text string already owned by its
      // cached entry. Lazy and source-only rebuilds can reuse it without
      // retaining a second wide JSON/raw payload or reading SQLite again.
      const start = prefixValues.join("\n").toLowerCase().length + (prefixValues.length && metadataValues.length ? 1 : 0);
      info.searchMetadata = { text: metadataValues.length ? entry.text : "", start,
        end: entry.text.length - mediaValues.join("\n").toLowerCase().length
          - (mediaValues.length && (prefixValues.length || metadataValues.length) ? 1 : 0), present: metadataValues.length > 0 };
      delete info.fields_json;
      delete info.raw_text;
    }
    return entry;
  }

  function workTextEntry(work, stamp = getSourceStamp(), loadedInfo = null) {
    if (workTextCache?.stamp !== stamp) {
      workTextCache = { stamp, rows: new Map() };
    }

    const key = work?.id || `${work?.personId || ""}:${work?.directoryName || ""}:${work?.title || ""}`;
    const cached = workTextCache.rows.get(key);
    if (cached) return { entry: cached, cacheable: true };

    const loaded = loadedInfo || workInfoRows();
    const entry = buildWorkEntry(work, loaded.rows, loaded.cacheable);
    if (loaded.cacheable) workTextCache.rows.set(key, entry);
    return { entry, cacheable: loaded.cacheable };
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

    const worksById = new Map(getLibrary().worksById);
    for (const work of extraWorks || []) {
      if (work?.id) worksById.set(work.id, work);
    }
    const loaded = worksById.size ? workInfoRows() : { rows: new Map(), cacheable: true };
    const temporary = readScope?.grams.get(loaded.rows);
    if (temporary?.stamp === stamp && (extraWorks || []).every(work => !work?.id || temporary.indexedWorkIds.has(work.id))) {
      return temporary;
    }
    const postings = new Map();
    const workIds = [];
    const entriesById = new Map();
    for (const work of worksById.values()) {
      const ordinal = workIds.length;
      workIds.push(work.id);
      const { entry } = workTextEntry(work, stamp, loaded);
      if (!loaded.cacheable) entriesById.set(work.id, entry);
      const grams = new Set();
      addBigrams(grams, entry.text);
      addBigrams(grams, entry.normalized);
      for (const gram of grams) {
        const existing = postings.get(gram);
        if (existing === undefined) postings.set(gram, ordinal);
        else if (typeof existing === "number") postings.set(gram, [existing, ordinal]);
        else existing.push(ordinal);
      }
    }
    // Single-work grams need no array. Shared grams retain four-byte ordinals
    // instead of repeating ID references; decode only the query's candidates.
    for (const [gram, posting] of postings) {
      if (Array.isArray(posting)) postings.set(gram, Uint32Array.from(posting));
    }

    const index = { stamp, indexedWorkIds: new Set(worksById.keys()), postings, workIds, cacheable: loaded.cacheable };
    if (loaded.cacheable) gramIndexCache = index;
    else {
      index.entriesById = entriesById;
      readScope?.grams.set(loaded.rows, index);
    }
    return index;
  }

  function rarestPosting(value, postings) {
    const text = String(value || "");
    if (text.length < 2) return null;
    let rarest;
    let rarestLength = Infinity;
    for (let index = 0; index + 1 < text.length; index += 1) {
      const posting = postings.get(text.slice(index, index + 2));
      if (posting === undefined) return [];
      const length = typeof posting === "number" ? 1 : posting.length;
      if (length < rarestLength) {
        rarest = posting;
        rarestLength = length;
      }
    }
    return rarest ?? [];
  }

  function indexedCandidates(loweredQuery, normalizedQuery, { postings, workIds }) {
    if (loweredQuery.length < 2) return null;
    const rawPosting = rarestPosting(loweredQuery, postings);
    const normalizedPosting = normalizedQuery.length >= 2
      ? rarestPosting(normalizedQuery, postings)
      : null;
    const candidates = new Set();
    const addPosting = (posting) => {
      if (typeof posting === "number") candidates.add(workIds[posting]);
      else for (const ordinal of posting) candidates.add(workIds[ordinal]);
    };
    addPosting(rawPosting);
    if (normalizedPosting !== null && normalizedPosting !== rawPosting) addPosting(normalizedPosting);
    return candidates;
  }

  function createMatcher(query) {
    return withReadStatus(() => loadMatcher(query)).value;
  }

  function loadMatcher(query) {
    const normalizedQuery = normalizeSearchValue(query);
    const loweredQuery = String(query || "").toLowerCase();
    const stamp = getSourceStamp();
    const gramIndex = ensureGramIndex();
    const candidateIds = indexedCandidates(loweredQuery, normalizedQuery, gramIndex);

    return (work) => {
      if (gramIndex.cacheable === false) markReadFailure();
      if (!loweredQuery) return true;
      const isIndexedWork = gramIndex.indexedWorkIds.has(work.id);
      if (candidateIds && isIndexedWork && !candidateIds.has(work.id)) return false;
      const { text, normalized } = gramIndex.entriesById?.get(work.id) || workTextEntry(work, stamp).entry;
      return text.includes(loweredQuery) || (normalizedQuery.length >= 2 && normalized.includes(normalizedQuery));
    };
  }

  function prewarm(extraWorks = []) {
    withReadStatus(() => ensureGramIndex(extraWorks));
  }

  function invalidate() {
    workInfoCache = null;
    workTextCache = null;
    gramIndexCache = null;
    readScope?.failures.clear();
    readScope?.grams.clear();
  }

  return { createMatcher, invalidate, prewarm, withReadStatus, readCacheable };
}
