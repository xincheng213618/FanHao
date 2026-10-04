import { createLatestRequestGate } from "./latest-request.js?v=20260717-fanhao-latest-request-01";
import { createPrefetchCache } from "./prefetch-cache.js?v=20261004-fanhao-requests-01";

const PREFETCH_TTL_MS = 60 * 1000;
const PREFETCH_LIMIT = 8;

export function createSearchRequestService({ api, filter, pageSize, sort }) {
  const requests = createLatestRequestGate();
  const prefetchCache = createPrefetchCache({ limit: PREFETCH_LIMIT, ttlMs: PREFETCH_TTL_MS });

  function requestFor(query, offset = 0) {
    const params = new URLSearchParams({
      q: String(query || "").trim(),
      limit: String(pageSize()),
      offset: String(offset || 0),
      sort: sort(),
      filter: filter()
    });
    const path = `/api/search?${params}`;
    return { key: path, path };
  }

  function prefetch(query) {
    const normalized = String(query || "").trim();
    if (!normalized) return Promise.resolve(null);
    const request = requestFor(normalized, 0);
    return prefetchCache.prefetch(request.key, (signal) => api(request.path, { signal }))
      .then((result) => result.data);
  }

  function consumePrefetch(key, signal) {
    return prefetchCache.consume(key, signal);
  }

  async function fetchPage(query, offset = 0) {
    const request = requests.begin();
    const target = requestFor(query, offset);
    try {
      const warmed = Number(offset || 0) === 0 ? consumePrefetch(target.key, request.signal) : null;
      prefetchCache.clear();
      const warmedData = warmed ? (await warmed).data : null;
      if (!request.isCurrent()) return null;
      const data = warmedData ?? await api(target.path, { signal: request.signal });
      return request.isCurrent() ? data : null;
    } catch (error) {
      if (!request.isCurrent()) return null;
      throw error;
    } finally {
      request.finish();
    }
  }

  function cancel() {
    requests.cancel();
    prefetchCache.clear();
  }

  return { cancel, fetchPage, prefetch };
}
