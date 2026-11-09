import { fetchJson } from "../../js/api.js?v=assets-76f4b0fadf4d";
import { captureCachedJsonFence, isCachedJsonFenceCurrent, readCachedJson, writeCachedJson } from "../../js/cache.js?v=assets-76f4b0fadf4d";

const DEFAULT_CACHE_MAX_AGE_MS = 5 * 60 * 1000;
const AUTHORITATIVE_REFRESH_ATTEMPTS = 3;
const AUTHORITATIVE_REFRESH_RETRY_MS = [80, 180];

export function createShortVideoApi({ getActiveUrl, writeResponseCache = writeCachedJson }) {
  const refreshes = new Map();
  const refresh = (baseUrl, routePath, fetchOptions, fence = captureCachedJsonFence(baseUrl)) => {
    const signal = fetchOptions?.signal;
    assertRefreshFence(fence, signal);
    // A replaceable read belongs to its caller. Sharing its transport would
    // let an obsolete intent abort the current one.
    if (signal) return refreshOnce(baseUrl, routePath, fetchOptions, fence);
    const key = JSON.stringify([fence.baseUrl, fence.account.owner, fence.account.revision, fence.epoch, fence.generation, routePath]);
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
    const signal = fetchOptions?.signal;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let data;
      try {
        data = await fetchJson(baseUrl, networkPath, fetchOptions);
      } catch (error) {
        assertRefreshFence(fence, signal, error);
        if (fallbackData) error.fallbackData = fallbackData;
        throw error;
      }
      assertRefreshFence(fence, signal);
      if (isStaleResponseEnvelope(data)) {
        fallbackData ||= data;
        staleError = staleResponseError(data);
        if (!isOfflineResponseEnvelope(data) && attempt + 1 < attempts) {
          await waitForAuthoritativeRetry(AUTHORITATIVE_REFRESH_RETRY_MS[attempt] || 180, fence, signal);
          continue;
        }
        staleError.fallbackData = fallbackData;
        throw staleError;
      }
      try {
        // Cache under the canonical route, never under the transport-only
        // refresh=1 URL used to obtain an authoritative server snapshot.
        await writeResponseCache(baseUrl, routePath, data, { fence, signal });
      } catch {}
      assertRefreshFence(fence, signal);
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
        forceRefresh = false,
        requireAuthoritative = false,
        withSource = false,
        ...fetchOptions
      } = options || {};
      const result = (data, source) => withSource ? { data, source } : data;
      if (requireAuthoritative) return result(await refresh(requestBaseUrl, routePath, fetchOptions), "network");
      const { signal } = fetchOptions;
      const { cached, fence } = await readCachedRequest(requestBaseUrl, routePath, signal);
      assertRefreshFence(fence, signal);
      const updatedAt = cached?.updatedAt ? new Date(cached.updatedAt).getTime() : 0;
      const fresh = Boolean(cached?.payload)
        && !isStaleResponseEnvelope(cached.payload)
        && updatedAt > 0
        && Date.now() - updatedAt <= Math.max(0, Number(cacheMaxAgeMs || 0));
      if (fresh && !forceRefresh) return result(cached.payload, "cache");

      const refreshRequest = () => refresh(requestBaseUrl, routePath, fetchOptions, fence);

      if (cached?.payload && staleWhileRevalidate) {
        refreshRequest().catch(() => {});
        return result(cached.payload, "cache");
      }

      try {
        return result(await refreshRequest(), "network");
      } catch (error) {
        assertRefreshFence(fence, signal, error);
        if (cached?.payload) return result(cached.payload, "fallback");
        if (error?.fallbackData) return result(error.fallbackData, "fallback");
        throw error;
      }
    },
    async fetchCachedRevalidated(baseUrl, routePath, options = {}) {
      const requestBaseUrl = baseUrl || getActiveUrl();
      const { cacheMaxAgeMs: _cacheMaxAgeMs, staleWhileRevalidate: _staleWhileRevalidate, ...fetchOptions } = options || {};
      const { signal } = fetchOptions;
      const { cached, fence } = await readCachedRequest(requestBaseUrl, routePath, signal);
      assertRefreshFence(fence, signal);
      if (cached?.payload) {
        return {
          data: cached.payload,
          fromCache: true,
          revalidation: refresh(requestBaseUrl, routePath, fetchOptions, fence)
        };
      }
      try {
        return {
          data: await refresh(requestBaseUrl, routePath, fetchOptions, fence),
          fromCache: false,
          nonAuthoritative: false,
          revalidation: null
        };
      } catch (error) {
        assertRefreshFence(fence, signal, error);
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

async function readCachedRequest(baseUrl, routePath, signal) {
  const before = captureCachedJsonFence(baseUrl);
  assertRefreshFence(before, signal);
  const cached = await readCachedJson(baseUrl, routePath).catch(() => null);
  const fence = captureCachedJsonFence(baseUrl);
  // The initial cache read can establish a previously unknown account.
  // Keep its cache generation and any already established account owner.
  assertRefreshFence({ ...before, account: before.account.tokenKnown ? before.account : fence.account }, signal);
  return { cached, fence };
}

function authoritativeRefreshPath(routePath) {
  const url = new URL(String(routePath || ""), "http://fanhao.local");
  if (url.pathname !== "/api/short-videos") return routePath;
  url.searchParams.set("refresh", "1");
  return `${url.pathname}${url.search}`;
}

export function isStaleResponseEnvelope(data) {
  const cacheState = String(data?.cacheState || "").trim().toLowerCase();
  return data?.stale === true
    || data?.offline === true
    || cacheState === "stale-refreshing"
    || cacheState === "offline";
}

function isOfflineResponseEnvelope(data) {
  return data?.offline === true || String(data?.cacheState || "").trim().toLowerCase() === "offline";
}

function staleResponseError(data) {
  const error = new Error(isOfflineResponseEnvelope(data)
    ? "电脑端暂时离线，已保留本地缓存"
    : "电脑端列表仍在刷新，已保留本地缓存");
  error.code = "SHORT_VIDEO_REVALIDATION_STALE";
  error.retryable = true;
  return error;
}

function assertRefreshFence(fence, signal, error) {
  if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
  if (error?.name === "AbortError" || error?.code === "ACCOUNT_CHANGED") throw error;
  if (!isCachedJsonFenceCurrent(fence)) throw new Error("缓存已失效，请重新读取");
}

async function waitForAuthoritativeRetry(delayMs, fence, signal) {
  assertRefreshFence(fence, signal);
  await new Promise((resolve, reject) => {
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("请求已取消", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, Math.max(0, Number(delayMs || 0)));
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
  assertRefreshFence(fence, signal);
}
