import { accountChangedError, captureAccountOwner, isAccountOwnerCurrent } from "../../../../js/account-owner.js";

const WARMED_RESULT_TTL_MS = 60 * 1000;
const WARMED_RESULT_LIMIT = 32;

export function createWorkPageDataService({ fetchJson, readCachedJson = async () => null, writeCachedJson }) {
  const inflight = new Map();
  const warmed = new Map();
  const warmedResults = new Map();
  const generations = new Map();

  function fetch(activeUrl, path, { signal, reuseWarmed, canCache = () => true, accountScope = captureAccountOwner(activeUrl) } = {}) {
    if (signal?.aborted) return Promise.reject(abortedRequest());
    if (!isAccountOwnerCurrent(accountScope)) return Promise.reject(accountChangedError());
    const key = requestKey(activeUrl, path, accountScope);
    if (reuseWarmed) {
      const warmedResult = warmedResults.get(key);
      if (warmedResult) warmedResults.delete(key);
      if (warmedResult?.expiresAt > Date.now() && isAccountOwnerCurrent(warmedResult.scope)) return Promise.resolve(warmedResult.data);
    }

    const request = currentRequest(key) || startRequest(activeUrl, path, key, accountScope, canCache);
    const subscriber = subscribe(key, request, signal);
    const attempt = warmed.get(key);
    if (!reuseWarmed || !attempt) return subscriber;
    return subscriber.then((data) => {
      if (warmed.get(key) === attempt) {
        attempt.consumed = true;
        warmedResults.delete(key);
      }
      return data;
    });
  }

  function currentRequest(key) {
    const request = inflight.get(key);
    return request && isAccountOwnerCurrent(request.scope) ? request : null;
  }

  function startRequest(activeUrl, path, key, scope, canCache) {
    const generation = generations.get(key) || 0;
    const controller = new AbortController();
    const request = { scope, controller, subscribers: 0, finished: false, promise: null };
    request.promise = fetchJson(activeUrl, path, { timeoutMs: 12000, signal: controller.signal, accountScope: scope })
      .then((data) => {
        if (controller.signal.aborted) throw abortedRequest();
        if (!isAccountOwnerCurrent(scope)) throw accountChangedError();
        if ((generations.get(key) || 0) === generation && canCache(data)) writeCachedJson(activeUrl, path, data).catch(() => {});
        return data;
      })
      .finally(() => {
        request.finished = true;
        if (inflight.get(key) === request) inflight.delete(key);
      });
    inflight.set(key, request);
    return request;
  }

  function subscribe(key, request, signal) {
    // A view or speculative warmup releases only its own share of the read.
    request.subscribers += 1;
    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", abort);
        request.subscribers -= 1;
        if (request.finished || request.subscribers) return;
        if (inflight.get(key) === request) inflight.delete(key);
        request.controller.abort();
      };
      const abort = () => {
        release();
        reject(abortedRequest());
      };
      signal?.addEventListener("abort", abort, { once: true });
      request.promise.then(
        (data) => { release(); resolve(data); },
        (error) => { release(); reject(error); }
      );
      if (signal?.aborted) abort();
    });
  }

  function warm(activeUrl, paths = [], { signal } = {}) {
    if (signal?.aborted) return Promise.resolve([]);
    const scope = captureAccountOwner(activeUrl);
    const requests = [];
    for (const path of paths) {
      const key = requestKey(activeUrl, path, scope);
      const previous = warmed.get(key);
      if (previous && !previous.signal?.aborted && isAccountOwnerCurrent(previous.scope)) continue;
      if (signal && currentRequest(key)) continue;
      const attempt = { scope, signal, consumed: false };
      warmed.set(key, attempt);
      const request = fetch(activeUrl, path, { signal, accountScope: scope }).then((data) => {
        if (warmed.get(key) !== attempt || !isAccountOwnerCurrent(scope)) return;
        if (signal?.aborted) {
          warmed.delete(key);
          return;
        }
        attempt.signal = null;
        if (attempt.consumed) return;
        warmedResults.set(key, { data, scope, expiresAt: Date.now() + WARMED_RESULT_TTL_MS });
        while (warmedResults.size > WARMED_RESULT_LIMIT) {
          warmedResults.delete(warmedResults.keys().next().value);
        }
      }).catch(() => {
        if (warmed.get(key) === attempt) warmed.delete(key);
      });
      requests.push(request);
    }
    return Promise.all(requests);
  }

  async function load(activeUrl, path, options = {}) {
    if (options.signal?.aborted) return null;
    const scope = captureAccountOwner(activeUrl);
    const isActive = options.isActive || (() => true);
    const signature = options.signature || JSON.stringify;
    const key = requestKey(activeUrl, path, scope);
    const generation = generations.get(key) || 0;
    const isCurrent = () => !options.signal?.aborted && isAccountOwnerCurrent(scope) && (generations.get(key) || 0) === generation;
    const freshRequest = fetch(activeUrl, path, { ...options, accountScope: scope }).then(
      (data) => ({ source: "fresh", data }),
      (error) => ({ source: "fresh", error })
    );
    const cacheRequest = readCachedJson(activeUrl, path).catch(() => null).then(async (cache) => {
      if (!cache && options.legacyCachePath && isActive() && isCurrent()) {
        cache = await readCachedJson(activeUrl, options.legacyCachePath).catch(() => null);
      }
      return { source: "cache", cache };
    });
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

  function requestKey(activeUrl, path, scope) {
    return `${activeUrl} ${scope.owner} ${path}`;
  }

  function invalidate(activeUrl, pathPrefix) {
    for (const key of new Set([...inflight.keys(), ...warmed.keys(), ...warmedResults.keys(), ...generations.keys()])) {
      if (!key.startsWith(`${activeUrl} `) || !key.slice(`${activeUrl} `.length).split(" ").slice(1).join(" ").startsWith(pathPrefix)) continue;
      generations.set(key, (generations.get(key) || 0) + 1);
      inflight.delete(key);
      warmed.delete(key);
      warmedResults.delete(key);
    }
  }

  return { fetch, invalidate, load, warm };
}

function abortedRequest() {
  return new DOMException("Request aborted", "AbortError");
}
