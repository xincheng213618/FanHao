export function createWorkPageDataService({ fetchJson, writeCachedJson }) {
  const inflight = new Map();
  const warmed = new Set();

  function fetch(activeUrl, path, options = {}) {
    const key = requestKey(activeUrl, path);
    if (inflight.has(key)) return inflight.get(key);
    const promise = fetchJson(activeUrl, path, { timeoutMs: 12000, signal: options.signal })
      .then((data) => {
        writeCachedJson(activeUrl, path, data).catch(() => {});
        return data;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  function warm(activeUrl, paths = []) {
    for (const path of paths) {
      const key = requestKey(activeUrl, path);
      if (warmed.has(key)) continue;
      warmed.add(key);
      fetch(activeUrl, path).catch(() => warmed.delete(key));
    }
  }

  function requestKey(activeUrl, path) {
    return `${activeUrl}:${path}`;
  }

  return { fetch, warm };
}
