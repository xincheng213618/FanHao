export async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const error = new Error(response.ok ? "接口返回格式异常" : `请求失败：${response.status}`);
    error.status = response.status;
    error.code = "";
    throw error;
  }
  if (!response.ok || data.ok === false) {
    const error = new Error(data.message || `请求失败：${response.status}`);
    error.status = response.status;
    error.code = String(data.code || "");
    throw error;
  }
  return data;
}

export function post(path, payload = {}) {
  return api(path, { method: "POST", body: JSON.stringify(payload) });
}
