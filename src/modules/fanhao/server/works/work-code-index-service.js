export function createWorkCodeIndexService({
  getLibrary,
  getStamp,
  looseWorkCodeKey,
  storedWorkCodeKey,
  workInfoRow
}) {
  let localWorkCodeKeyCache = null;
  let localWorkByCodeKeyCache = null;

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

  function localCodeKeys() {
    const library = getLibrary();
    const stamp = getStamp();
    if (localWorkCodeKeyCache?.stamp === stamp) return localWorkCodeKeyCache.keys;

    const keys = new Set();
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
        if (key) keys.add(key);
      }
    }
    localWorkCodeKeyCache = { stamp, keys };
    return keys;
  }

  function localWorkByCodeKey() {
    const library = getLibrary();
    const stamp = getStamp();
    if (localWorkByCodeKeyCache?.stamp === stamp) return localWorkByCodeKeyCache.rows;

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
        if (key && !rows.has(key)) rows.set(key, work);
      }
    }

    localWorkByCodeKeyCache = { stamp, rows };
    return rows;
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
    localWorkCodeKeyCache = null;
    localWorkByCodeKeyCache = null;
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
