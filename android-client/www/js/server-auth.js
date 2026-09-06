import { accountChangedError, registerAccountSessionResolver, synchronizeAccountToken } from "./account-owner.js";

const sessions = new Map();
const registeredServers = new Set();

function nativeAuth() {
  return globalThis.Capacitor?.Plugins?.FanHaoAuth;
}

export function serverOrigin(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin : "";
  } catch { return ""; }
}

async function sessionFor(origin) {
  if (!sessions.has(origin)) {
    const plugin = nativeAuth();
    const pending = plugin
      ? Promise.resolve().then(() => plugin.getSession({ serverUrl: origin })).then((value) => {
          if (typeof value?.token !== "string") throw new Error("Invalid native session response");
          return value.token;
        })
        .catch(() => {
          if (sessions.get(origin) === pending) sessions.delete(origin);
          const error = new Error("无法读取手机保存的登录会话，请重试连接。");
          error.code = "NATIVE_AUTH_UNAVAILABLE";
          throw error;
        })
      : Promise.resolve("");
    sessions.set(origin, pending);
  }
  return sessions.get(origin);
}

export function registerServerAuthentication(serverUrl) {
  const origin = serverOrigin(serverUrl);
  if (origin) registeredServers.add(origin);
}

async function waitForSession(origin, signal) {
  if (!signal) return sessionFor(origin);
  if (signal.aborted) throw new DOMException("Request aborted", "AbortError");
  const lookup = sessionFor(origin);
  const entry = sessions.get(origin);
  let onAbort;
  try {
    return await Promise.race([
      lookup,
      new Promise((resolve, reject) => {
        onAbort = () => {
          if (sessions.get(origin) === entry) sessions.delete(origin);
          reject(new DOMException("Request aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })
    ]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

export function installServerAuthentication(getServerUrl, host = globalThis) {
  const originalFetch = host.fetch.bind(host);
  registerAccountSessionResolver(async (origin, signal) => {
    if (origin !== serverOrigin(getServerUrl()) && !registeredServers.has(origin) && !sessions.has(origin)) return;
    const lookup = waitForSession(origin, signal);
    const pending = sessions.get(origin);
    const token = await lookup;
    if (sessions.get(origin) !== pending) throw accountChangedError();
    await synchronizeAccountToken(origin, token);
  });
  host.fetch = async (input, options = {}) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const origin = serverOrigin(url);
    if (!origin || (origin !== serverOrigin(getServerUrl()) && !registeredServers.has(origin) && !sessions.has(origin))) return originalFetch(input, options);
    const token = await waitForSession(origin, options.signal || input?.signal);
    if (!token) return originalFetch(input, options);
    const headers = new Headers(options.headers || (typeof input === "object" ? input.headers : undefined));
    headers.set("Authorization", `Bearer ${token}`);
    // A server must not redirect a credentialed browser request to another origin.
    return originalFetch(input, { ...options, headers, redirect: "error" });
  };
}

export async function loginToServer(serverUrl, password) {
  const origin = serverOrigin(serverUrl);
  const plugin = nativeAuth();
  if (!plugin) throw new Error("请更新手机 App 后使用远程密码登录");
  const result = await plugin.login({ serverUrl: origin, password });
  if (!result?.token) throw new Error("服务器没有返回登录会话");
  sessions.set(origin, Promise.resolve(String(result.token)));
  await synchronizeAccountToken(origin, String(result.token));
}

export async function authenticateAccount(serverUrl, mode, fields) {
  const origin = serverOrigin(serverUrl);
  const plugin = nativeAuth();
  const method = mode === "register" ? "registerAccount" : "loginAccount";
  if (!origin) throw new Error("请先填写有效的服务地址");
  if (!plugin?.[method]) throw new Error("请更新手机 App 后使用用户账号");
  const result = await plugin[method]({ ...fields, serverUrl: origin });
  if (!result?.token) throw new Error("服务器没有返回登录会话");
  sessions.set(origin, Promise.resolve(String(result.token)));
  await synchronizeAccountToken(origin, String(result.token));
  return result;
}

export async function clearServerSession(serverUrl) {
  const origin = serverOrigin(serverUrl);
  const plugin = nativeAuth();
  if (!plugin?.clearSession) throw new Error("请更新手机 App 后退出账号");
  await plugin.clearSession({ serverUrl: origin });
  sessions.set(origin, Promise.resolve(""));
  await synchronizeAccountToken(origin, "");
}
