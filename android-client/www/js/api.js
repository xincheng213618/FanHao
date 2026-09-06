import { accountChangedError, captureAccountOwner, isAccountOwnerCurrent, observeAccountResponse, prepareAccountOwner, rememberAccountPayload } from "./account-owner.js";

export async function fetchJson(baseUrl, path, options = {}) {
  const startedAccount = captureAccountOwner(baseUrl);
  const { timeoutMs = 20000, signal = null, accountScope = null, ...requestOptions } = options;
  const effectiveTimeoutMs = requestTimeout(baseUrl, timeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  const abortFromExternal = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.("abort", abortFromExternal, { once: true });
  const timer = effectiveTimeoutMs > 0
    ? window.setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
    }, effectiveTimeoutMs)
    : null;

  try {
    const scope = accountScope || await prepareAccountOwner(baseUrl, { signal: controller.signal });
    if (controller.signal.aborted) throw new DOMException("Request aborted", "AbortError");
    if (startedAccount.tokenKnown && !isAccountOwnerCurrent(startedAccount)) throw accountChangedError();
    if (!isAccountOwnerCurrent(scope)) throw accountChangedError();
    const headers = {
      Accept: "application/json",
      ...(requestOptions.headers || {}),
      "X-FanHao-Client": "android"
    };
    if (scope.owner !== "pending" && !/^\/api\/(?:auth|accounts)(?:\/|$)/.test(path)) headers["X-FanHao-Account-Owner"] = scope.owner;
    const body = requestOptions.body && typeof requestOptions.body !== "string"
      ? JSON.stringify(requestOptions.body)
      : requestOptions.body;
    if (body) headers["Content-Type"] = headers["Content-Type"] || "application/json";
    const response = await fetch(`${baseUrl}${path}`, {
      ...requestOptions,
      headers: {
        ...headers
      },
      ...(body ? { body } : {}),
      signal: controller.signal
    });
    const payload = await response.json().catch((error) => {
      if (error?.name === "AbortError" || controller.signal.aborted) throw error;
      return {};
    });
    if (!isAccountOwnerCurrent(scope)) throw accountChangedError();
    const responseScope = observeAccountResponse(baseUrl, path, payload, response, scope);
    if (!response.ok) {
      const error = new Error(payload.error || `请求失败：${response.status}`);
      error.status = response.status;
      error.code = String(payload.code || "");
      error.retryable = response.status === 503 && payload.retryable === true;
      error.statusCode = response.status;
      error.payload = payload;
      throw error;
    }
    return rememberAccountPayload(payload, responseScope);
  } catch (error) {
    if (timedOut) throw new Error("请求超时，已保留本地缓存");
    throw error;
  } finally {
    if (timer) window.clearTimeout(timer);
    signal?.removeEventListener?.("abort", abortFromExternal);
  }
}

function requestTimeout(baseUrl, timeoutMs) {
  if (timeoutMs <= 0 || isLocalBaseUrl(baseUrl)) return timeoutMs;
  return Math.max(timeoutMs, 22000);
}

function isLocalBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export async function postJson(baseUrl, path, body = {}) {
  return fetchJson(baseUrl, path, {
    method: "POST",
    body,
    timeoutMs: 0
  });
}

export async function putJson(baseUrl, path, body = {}) {
  return fetchJson(baseUrl, path, {
    method: "PUT",
    body,
    timeoutMs: 0
  });
}

export async function deleteJson(baseUrl, path) {
  return fetchJson(baseUrl, path, {
    method: "DELETE",
    timeoutMs: 0
  });
}
