import { createLatestRequestGate } from "./latest-request.js?v=20260717-fanhao-latest-request-01";

const PREFETCH_TTL_MS = 60 * 1000;
const PREFETCH_LIMIT = 8;

export function createSearchRequestService({ api, filter, pageSize, sort }) {
  const requests = createLatestRequestGate();
  const prefetched = new Map();

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
    const cached = prefetched.get(request.key);
    if (cached?.expiresAt > Date.now()) return cached.promise;
    if (cached) prefetched.delete(request.key);

    const entry = {
      expiresAt: Date.now() + PREFETCH_TTL_MS,
      promise: null
    };
    entry.promise = api(request.path).catch(() => null).then((data) => {
      if (data === null && prefetched.get(request.key) === entry) prefetched.delete(request.key);
      return data;
    });
    prefetched.set(request.key, entry);
    while (prefetched.size > PREFETCH_LIMIT) prefetched.delete(prefetched.keys().next().value);
    return entry.promise;
  }

  function consumePrefetch(key) {
    const cached = prefetched.get(key);
    if (!cached) return null;
    prefetched.delete(key);
    return cached.expiresAt > Date.now() ? cached.promise : null;
  }

  async function fetchPage(query, offset = 0) {
    const request = requests.begin();
    const target = requestFor(query, offset);
    try {
      const warmed = Number(offset || 0) === 0 ? consumePrefetch(target.key) : null;
      const warmedData = warmed ? await warmed : null;
      const data = warmedData ?? await api(target.path, { signal: request.signal });
      return request.isCurrent() ? data : null;
    } catch (error) {
      if (!request.isCurrent()) return null;
      throw error;
    } finally {
      request.finish();
    }
  }

  return { cancel: requests.cancel, fetchPage, prefetch };
}
