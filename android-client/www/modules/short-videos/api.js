import { fetchJson } from "../../js/api.js?v=20260812-collection-busy-01";
import { captureCachedJsonFence, isCachedJsonFenceCurrent, readCachedJson, writeCachedJson } from "../../js/cache.js?v=20260812-action-cold-revalidate-v2-5c293a6f8867";

const DEFAULT_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const AUTHORITATIVE_REFRESH_ATTEMPTS = 3;
const AUTHORITATIVE_REFRESH_RETRY_MS = [80, 180];

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
    const networkPath = authoritativeRefreshPath(routePath);
    const attempts = networkPath === routePath ? 1 : AUTHORITATIVE_REFRESH_ATTEMPTS;
    let staleError = null;
    let fallbackData = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let data;
      try {
        data = await fetchJson(baseUrl, networkPath, fetchOptions);
      } catch (error) {
        if (fallbackData) error.fallbackData = fallbackData;
        throw error;
      }
      assertRefreshFence(fence);
      if (isStaleResponseEnvelope(data)) {
        fallbackData ||= data;
        staleError = staleResponseError(data);
        if (attempt + 1 < attempts) {
          await waitForAuthoritativeRetry(AUTHORITATIVE_REFRESH_RETRY_MS[attempt] || 180, fence, fetchOptions?.signal);
          continue;
        }
        staleError.fallbackData = fallbackData;
        throw staleError;
      }
      try {
        // Cache under the canonical route, never under the transport-only
        // refresh=1 URL used to obtain an authoritative server snapshot.
        await writeResponseCache(baseUrl, routePath, data, { fence });
      } catch {}
      assertRefreshFence(fence);
      return data;
    }
    throw staleError || new Error("短视频列表暂未完成刷新");
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
        && !isStaleResponseEnvelope(cached.payload)
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
        if (error?.fallbackData) return error.fallbackData;
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
      try {
        return {
          data: await refresh(requestBaseUrl, routePath, fetchOptions),
          fromCache: false,
          nonAuthoritative: false,
          revalidation: null
        };
      } catch (error) {
        if (!error?.fallbackData) throw error;
        return {
          data: error.fallbackData,
          fromCache: false,
          nonAuthoritative: true,
          revalidation: null
        };
      }
    }
  });
}

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function authoritativeRefreshPath(routePath) {
  const url = new URL(String(routePath || ""), "http://fanhao.local");
  if (url.pathname !== "/api/short-videos") return routePath;
  url.searchParams.set("refresh", "1");
  return `${url.pathname}${url.search}`;
}

function isStaleResponseEnvelope(data) {
  const cacheState = String(data?.cacheState || "").trim().toLowerCase();
  return data?.stale === true
    || data?.offline === true
    || cacheState === "stale-refreshing"
    || cacheState === "offline";
}

function staleResponseError(data) {
  const error = new Error(data?.offline === true || String(data?.cacheState || "").toLowerCase() === "offline"
    ? "电脑端暂时离线，已保留本地缓存"
    : "电脑端列表仍在刷新，已保留本地缓存");
  error.code = "SHORT_VIDEO_REVALIDATION_STALE";
  error.retryable = true;
  return error;
}

function assertRefreshFence(fence) {
  if (!isCachedJsonFenceCurrent(fence)) throw new Error("缓存已失效，请重新读取");
}

async function waitForAuthoritativeRetry(delayMs, fence, signal) {
  if (signal?.aborted) throw new Error("请求已取消");
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new Error("请求已取消"));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, Math.max(0, Number(delayMs || 0)));
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
  assertRefreshFence(fence);
}
