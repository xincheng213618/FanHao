const WARMED_RESULT_TTL_MS = 60 * 1000;
const WARMED_RESULT_LIMIT = 32;

export function createWorkPageDataService({ fetchJson, readCachedJson = async () => null, writeCachedJson }) {
  const inflight = new Map();
  const warmed = new Set();
  const warmedResults = new Map();
  const generations = new Map();

  function fetch(activeUrl, path, options = {}) {
    const key = requestKey(activeUrl, path);
    const generation = generations.get(key) || 0;
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
        if ((generations.get(key) || 0) === generation) writeCachedJson(activeUrl, path, data).catch(() => {});
        return data;
      })
      .finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key);
      });
    inflight.set(key, promise);
    return promise;
  }

  function warm(activeUrl, paths = []) {
    const requests = [];
    for (const path of paths) {
      const key = requestKey(activeUrl, path);
      if (warmed.has(key)) continue;
      const generation = generations.get(key) || 0;
      warmed.add(key);
      const request = fetch(activeUrl, path).then((data) => {
        if ((generations.get(key) || 0) !== generation) return;
        warmedResults.set(key, { data, expiresAt: Date.now() + WARMED_RESULT_TTL_MS });
        while (warmedResults.size > WARMED_RESULT_LIMIT) {
          warmedResults.delete(warmedResults.keys().next().value);
        }
      }).catch(() => {
        if ((generations.get(key) || 0) === generation) warmed.delete(key);
      });
      requests.push(request);
    }
    return Promise.all(requests);
  }

  async function load(activeUrl, path, options = {}) {
    const isActive = options.isActive || (() => true);
    const signature = options.signature || JSON.stringify;
    const key = requestKey(activeUrl, path);
    const generation = generations.get(key) || 0;
    const isCurrent = () => (generations.get(key) || 0) === generation;
    const freshRequest = fetch(activeUrl, path, options).then(
      (data) => ({ source: "fresh", data }),
      (error) => ({ source: "fresh", error })
    );
    const cacheRequest = readCachedJson(activeUrl, path).then(
      (cache) => ({ source: "cache", cache }),
      () => ({ source: "cache", cache: null })
    );
    const first = await Promise.race([freshRequest, cacheRequest]);
    if (!isActive() || !isCurrent()) return null;
    if (first.source === "fresh" && !first.error) return { data: first.data, unchanged: false };

    const cached = first.source === "cache" ? first.cache : (await cacheRequest).cache;
    const cachedPayload = cached?.payload || null;
    const cachedSignature = cachedPayload ? signature(cachedPayload) : "";
    if (cachedPayload && isActive() && isCurrent()) options.onCached?.(cachedPayload, cached);
    const fresh = first.source === "fresh" ? first : await freshRequest;
    if (!isActive() || !isCurrent()) return null;
    if (fresh.error) throw fresh.error;
    return {
      data: fresh.data,
      unchanged: Boolean(cachedSignature && signature(fresh.data) === cachedSignature)
    };
  }

  function requestKey(activeUrl, path) {
    return `${activeUrl}:${path}`;
  }

  function invalidate(activeUrl, pathPrefix) {
    const prefix = requestKey(activeUrl, pathPrefix);
    for (const key of new Set([...inflight.keys(), ...warmed, ...warmedResults.keys(), ...generations.keys()])) {
      if (!key.startsWith(prefix)) continue;
      generations.set(key, (generations.get(key) || 0) + 1);
      inflight.delete(key);
      warmed.delete(key);
      warmedResults.delete(key);
    }
  }

  return { fetch, invalidate, load, warm };
}
