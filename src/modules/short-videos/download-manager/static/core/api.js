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
    throw new Error(response.ok ? "接口返回格式异常" : `请求失败：${response.status}`);
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || `请求失败：${response.status}`);
  }
  return data;
}

export function post(path, payload = {}) {
  return api(path, { method: "POST", body: JSON.stringify(payload) });
}
