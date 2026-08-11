export function createApiClient(options = {}) {
  const { isAndroidClient = false } = options;

  return async function api(path, requestOptions = {}) {
    const init = { ...requestOptions };
    const headers = { ...(init.headers || {}) };
    if (isAndroidClient) headers["X-FanHao-Client"] = "android";
    if (init.body && typeof init.body !== "string") {
      init.body = JSON.stringify(init.body);
      headers["Content-Type"] = "application/json";
    }
    init.headers = headers;

    const response = await fetch(path, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && payload.loginUrl) {
        window.location.assign(payload.loginUrl);
      }
      const error = new Error(payload.error || `请求失败：${response.status}`);
      error.status = response.status;
      error.retryable = response.status === 503 && payload.retryable === true;
      throw error;
    }
    return payload;
  };
}

export function addQueryParam(url, key, value) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}
