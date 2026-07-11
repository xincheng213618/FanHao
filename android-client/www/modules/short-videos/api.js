import { fetchJson } from "../../js/api.js?v=20260706-mobile-web-sync-01";
import { readCachedJson, writeCachedJson } from "../../js/cache.js?v=20260711-short-video-cache-08";

const DEFAULT_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

export function createShortVideoApi({ getActiveUrl }) {
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

      const refresh = () => fetchJson(requestBaseUrl, routePath, fetchOptions)
        .then((data) => {
          writeCachedJson(requestBaseUrl, routePath, data).catch(() => {});
          return data;
        });

      if (cached?.payload && staleWhileRevalidate) {
        refresh().catch(() => {});
        return cached.payload;
      }

      try {
        return await refresh();
      } catch (error) {
        if (cached?.payload) return cached.payload;
        throw error;
      }
    }
  });
}
