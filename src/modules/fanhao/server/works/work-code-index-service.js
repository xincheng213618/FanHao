export function createWorkCodeIndexService({
  getLibrary,
  getStamp,
  looseWorkCodeKey,
  storedWorkCodeKey,
  workInfoRow
}) {
  let localWorkCodeIndexCache = null;

  function workCodeKeys(work) {
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
    for (const work of library.worksById.values()) {
      const values = [
        work.infoSummary?.code,
        work.title,
        work.directoryName,
        work.relativePath,
        ...(work.videos || []).flatMap((video) => [video.name, video.title, video.relativePath]),
        ...(work.images || []).flatMap((image) => [image.name, image.title]),
        ...(work.infos || []).flatMap((infoFile) => [infoFile.name, infoFile.title])
      ];

      for (const value of values) {
        const key = looseWorkCodeKey(value);
        if (!key) continue;
        keys.add(key);
        if (!rows.has(key)) rows.set(key, work);
      }
    }
    localWorkCodeIndexCache = { stamp, keys, rows };
    return localWorkCodeIndexCache;
  }

  function localCodeKeys() {
    return localWorkCodeIndex().keys;
  }

  function localWorkByCodeKey() {
    return localWorkCodeIndex().rows;
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
  }

  return {
    combinedLocalCodeKeys,
    invalidate,
    keySetForWorks,
    localCodeKeys,
    localWorkByCodeKey,
    workCodeKeys
  };
}
