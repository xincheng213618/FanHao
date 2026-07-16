export function createWorkCodeIndexService({
  getLibrary,
  getStamp,
  looseWorkCodeKey,
  storedWorkCodeKey,
  workInfoRow
}) {
  let localWorkCodeIndexCache = null;
  let workCodeKeysCache = new WeakMap();
  let workCodeKeysCacheStamp = null;

  function currentWorkCodeKeysCache() {
    const stamp = getStamp();
    if (workCodeKeysCacheStamp !== stamp) {
      workCodeKeysCache = new WeakMap();
      workCodeKeysCacheStamp = stamp;
    }
    return workCodeKeysCache;
  }

  function workCodeKeys(work) {
    const cache = currentWorkCodeKeysCache();
    const cached = cache.get(work);
    if (cached) return cached;
    const info = work.infoSummary?.code ? null : workInfoRow(work.id);
    const values = [
      info?.code,
      work.infoSummary?.code,
      work.title,
      work.directoryName,
      work.relativePath,
      ...(work.videos || []).flatMap((video) => [video.name, video.title, video.relativePath]),
      ...(work.images || []).flatMap((image) => [image.name, image.title]),
      ...(work.infos || []).flatMap((infoFile) => [infoFile.name, infoFile.title])
    ];

    const keys = [];
    const seen = new Set();
    for (const value of values) {
      const key = looseWorkCodeKey(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    cache.set(work, keys);
    return keys;
  }

  function keySetForWorks(works = []) {
    const keys = new Set();
    for (const work of works || []) {
      for (const codeKey of workCodeKeys(work)) keys.add(codeKey);
    }
    return keys;
  }

  function localWorkCodeIndex() {
    const library = getLibrary();
    const stamp = getStamp();
    if (localWorkCodeIndexCache?.stamp === stamp) return localWorkCodeIndexCache;

    const keys = new Set();
    const rows = new Map();
    const searchRows = new Map();
    const prefixRows = [];
    for (const work of library.worksById.values()) {
      for (const key of workCodeKeys(work)) {
        keys.add(key);
        if (!rows.has(key)) rows.set(key, work);
      }
      const searchKeys = new Set([work.infoSummary?.code, work.directoryName, work.title]
        .map((value) => storedWorkCodeKey(value))
        .filter(Boolean));
      for (const key of searchKeys) {
        if (!searchRows.has(key)) searchRows.set(key, work);
        prefixRows.push({ key, work });
      }
    }
    prefixRows.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    localWorkCodeIndexCache = { stamp, keys, rows, searchRows, prefixRows };
    return localWorkCodeIndexCache;
  }

  function localCodeKeys() {
    return localWorkCodeIndex().keys;
  }

  function localWorkByCodeKey() {
    return localWorkCodeIndex().rows;
  }

  function localSearchWorkByCodeKey() {
    return localWorkCodeIndex().searchRows;
  }

  function localWorksByCodePrefix(value) {
    const prefix = storedWorkCodeKey(value);
    if (!prefix) return [];
    const { prefixRows } = localWorkCodeIndex();
    let low = 0;
    let high = prefixRows.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (prefixRows[middle].key < prefix) low = middle + 1;
      else high = middle;
    }

    const works = [];
    const seen = new Set();
    for (let index = low; index < prefixRows.length; index += 1) {
      const row = prefixRows[index];
      if (!row.key.startsWith(prefix)) break;
      const workId = String(row.work.id);
      if (seen.has(workId)) continue;
      seen.add(workId);
      works.push(row.work);
    }
    return works;
  }

  function combinedLocalCodeKeys(extraKeys = new Set()) {
    const keys = new Set(localCodeKeys());
    for (const key of extraKeys || []) {
      const codeKey = storedWorkCodeKey(key);
      if (codeKey) keys.add(codeKey);
    }
    return keys;
  }

  function invalidate() {
    localWorkCodeIndexCache = null;
    workCodeKeysCache = new WeakMap();
    workCodeKeysCacheStamp = null;
  }

  return {
    combinedLocalCodeKeys,
    invalidate,
    keySetForWorks,
    localCodeKeys,
    localSearchWorkByCodeKey,
    localWorkByCodeKey,
    localWorksByCodePrefix,
    workCodeKeys
  };
}
