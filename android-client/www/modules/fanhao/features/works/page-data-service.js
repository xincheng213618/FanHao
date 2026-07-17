const WARMED_RESULT_TTL_MS = 60 * 1000;
const WARMED_RESULT_LIMIT = 32;

export function createWorkPageDataService({ fetchJson, writeCachedJson }) {
  const inflight = new Map();
  const warmed = new Set();
  const warmedResults = new Map();

  function fetch(activeUrl, path, options = {}) {
    const key = requestKey(activeUrl, path);
    if (options.reuseWarmed) {
      const warmedResult = warmedResults.get(key);
      if (warmedResult?.expiresAt > Date.now()) {
        warmedResults.delete(key);
        return Promise.resolve(warmedResult.data);
      }
      if (warmedResult) warmedResults.delete(key);
    }
    if (inflight.has(key)) {
      const activeRequest = inflight.get(key);
      if (!options.reuseWarmed) return activeRequest;
      return activeRequest.then((data) => {
        warmedResults.delete(key);
        return data;
      });
    }
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
    const requests = [];
    for (const path of paths) {
      const key = requestKey(activeUrl, path);
      if (warmed.has(key)) continue;
      warmed.add(key);
      const request = fetch(activeUrl, path).then((data) => {
        warmedResults.set(key, { data, expiresAt: Date.now() + WARMED_RESULT_TTL_MS });
        while (warmedResults.size > WARMED_RESULT_LIMIT) {
          warmedResults.delete(warmedResults.keys().next().value);
        }
      }).catch(() => warmed.delete(key));
      requests.push(request);
    }
    return Promise.all(requests);
  }

  function requestKey(activeUrl, path) {
    return `${activeUrl}:${path}`;
  }

  return { fetch, warm };
}
