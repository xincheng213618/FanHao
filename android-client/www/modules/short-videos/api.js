import { fetchJson } from "../../js/api.js?v=20260812-collection-busy-01";
import { captureCachedJsonFence, isCachedJsonFenceCurrent, readCachedJson, writeCachedJson } from "../../js/cache.js?v=20260812-action-restart-sync-01";

const DEFAULT_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

export function createShortVideoApi({ getActiveUrl, writeResponseCache = writeCachedJson }) {
  const refreshes = new Map();
  const refresh = (baseUrl, routePath, fetchOptions) => {
    const fence = captureCachedJsonFence(baseUrl);
    const key = `${normalizeBaseUrl(baseUrl)} ${fence.epoch}:${fence.generation} ${routePath}`;
    const existing = refreshes.get(key);
    if (existing) return existing;
    const request = refreshOnce(baseUrl, routePath, fetchOptions, fence).finally(() => {
      if (refreshes.get(key) === request) refreshes.delete(key);
    });
    refreshes.set(key, request);
    return request;
  };

  const refreshOnce = async (baseUrl, routePath, fetchOptions, fence) => {
    const data = await fetchJson(baseUrl, routePath, fetchOptions);
    if (!isCachedJsonFenceCurrent(fence)) throw new Error("缓存已失效，请重新读取");
    try {
      await writeResponseCache(baseUrl, routePath, data, { fence });
    } catch {}
    if (!isCachedJsonFenceCurrent(fence)) throw new Error("缓存已失效，请重新读取");
    return data;
  };

  return Object.freeze({
    fetch(baseUrl, routePath, options) {
      return fetchJson(baseUrl || getActiveUrl(), routePath, options);
    },
    async fetchCached(baseUrl, routePath, options = {}) {
      const requestBaseUrl = baseUrl || getActiveUrl();
      const {
        cacheMaxAgeMs = DEFAULT_CACHE_MAX_AGE_MS,
        staleWhileRevalidate = false,
        ...fetchOptions
      } = options || {};
      const cached = await readCachedJson(requestBaseUrl, routePath).catch(() => null);
      const updatedAt = cached?.updatedAt ? new Date(cached.updatedAt).getTime() : 0;
      const fresh = Boolean(cached?.payload)
        && updatedAt > 0
        && Date.now() - updatedAt <= Math.max(0, Number(cacheMaxAgeMs || 0));
      if (fresh) return cached.payload;

      const refreshRequest = () => refresh(requestBaseUrl, routePath, fetchOptions);

      if (cached?.payload && staleWhileRevalidate) {
        refreshRequest().catch(() => {});
        return cached.payload;
      }

      try {
        return await refreshRequest();
      } catch (error) {
        if (cached?.payload) return cached.payload;
        throw error;
      }
    },
    async fetchCachedRevalidated(baseUrl, routePath, options = {}) {
      const requestBaseUrl = baseUrl || getActiveUrl();
      const { cacheMaxAgeMs: _cacheMaxAgeMs, staleWhileRevalidate: _staleWhileRevalidate, ...fetchOptions } = options || {};
      const cached = await readCachedJson(requestBaseUrl, routePath).catch(() => null);
      if (cached?.payload) {
        return {
          data: cached.payload,
          fromCache: true,
          revalidation: refresh(requestBaseUrl, routePath, fetchOptions)
        };
      }
      return {
        data: await refresh(requestBaseUrl, routePath, fetchOptions),
        fromCache: false,
        revalidation: null
      };
    }
  });
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}
