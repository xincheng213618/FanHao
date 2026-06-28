export async function fetchJson(baseUrl, path, options = {}) {
  const { timeoutMs = 20000, signal = null } = options;
  const effectiveTimeoutMs = requestTimeout(baseUrl, timeoutMs);
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.("abort", abortFromExternal, { once: true });
  const timer = effectiveTimeoutMs > 0
    ? window.setTimeout(() => controller.abort(), effectiveTimeoutMs)
    : null;

  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      headers: {
        Accept: "application/json",
        "X-FanHao-Client": "android"
      },
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("请求超时，已保留本地缓存");
    throw error;
  } finally {
    if (timer) window.clearTimeout(timer);
    signal?.removeEventListener?.("abort", abortFromExternal);
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload;
}

function requestTimeout(baseUrl, timeoutMs) {
  if (timeoutMs <= 0 || !isRemoteBaseUrl(baseUrl)) return timeoutMs;
  return Math.max(timeoutMs, 22000);
}

function isRemoteBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.endsWith(".local")) return false;
    const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!ipv4) return true;

    const first = Number(ipv4[1]);
    const second = Number(ipv4[2]);
    if (first === 10) return false;
    if (first === 172 && second >= 16 && second <= 31) return false;
    if (first === 192 && second === 168) return false;
    if (first === 169 && second === 254) return false;
    return true;
  } catch {
    return false;
  }
}

export async function postJson(baseUrl, path, body = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-FanHao-Client": "android"
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败：${response.status}`);
  return payload;
}
