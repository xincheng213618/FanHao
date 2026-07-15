import { api, post } from "../core/api.js";
import { $, toast } from "../core/dom.js";
import { formatDateTime } from "../core/format.js";

export function createAuthFeature() {
  let previousAuthLoginStatus = "";

  function renderAuth(auth = {}) {
    const login = auth.login || {};
    const loginStatus = login.status || "idle";
    const effectiveStatus = login.active ? "running" : loginStatus === "failed" ? "failed" : auth.status || "missing";
    const labels = {
      ready: "已登录",
      success: "已登录",
      running: "等待登录",
      incomplete: "信息不完整",
      failed: "登录未完成",
      missing: "未设置",
    };
    const badgeStatus = Object.hasOwn(labels, effectiveStatus) ? effectiveStatus : "missing";
    const badge = $("authStatusBadge");
    badge.className = `auth-status ${badgeStatus}`;
    badge.textContent = labels[effectiveStatus] || "未设置";
    $("authSummary").textContent = login.active ? login.message : auth.message || "尚未设置抖音登录信息";
    $("authCookiePath").textContent = auth.path || "—";
    $("authCookiePath").title = auth.path || "";
    $("authUpdatedAt").textContent = auth.modified_at ? formatDateTime(auth.modified_at) : "—";
    const sessionText = auth.has_session ? " · 已检测登录凭证" : "";
    $("authCookieCount").textContent = `${Number(auth.cookie_count || 0)} 项${sessionText}`;
    $("authLoginStart").disabled = Boolean(login.active);
    $("authImportCookie").disabled = Boolean(login.active);
    $("authClear").disabled = Boolean(login.active) || !auth.exists;
    $("authLoginHint").textContent = login.active
      ? "请在刚打开的 Edge 窗口中完成抖音登录；成功后窗口会自动关闭。"
      : login.message || "登录成功后会自动保存；Cookie 只保存在当前电脑，不会打进安装包。";
    if (previousAuthLoginStatus === "running" && loginStatus === "success") {
      toast("抖音登录成功，Cookie 已自动保存");
    } else if (previousAuthLoginStatus === "running" && loginStatus === "failed") {
      toast(login.message || "登录未完成");
    }
    previousAuthLoginStatus = login.active ? "running" : loginStatus;
  }

  async function refreshAuthStatus() {
    const result = await api("/api/auth/status");
    renderAuth(result.auth || {});
    return result.auth || {};
  }

  async function startAuthLogin() {
    const result = await post("/api/auth/login/start");
    renderAuth(result.auth || {});
    toast(result.message || "已打开 Edge，请完成抖音登录");
  }

  async function importAuthCookie(file) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) throw new Error("Cookie 文件不能超过 2 MB");
    const content = await file.text();
    const result = await post("/api/auth/cookie/import", { content, name: file.name });
    renderAuth(result.auth || {});
    toast(result.auth?.has_session ? "Cookie 已导入，登录信息可用" : "Cookie 已导入，但未检测到登录凭证");
  }

  async function clearAuthCookie() {
    const ok = window.confirm("确定清除当前电脑上的抖音 Cookie 和登录缓存吗？之后需要重新登录才能采集关注、喜欢等内容。");
    if (!ok) return;
    const result = await post("/api/auth/cookie/clear");
    renderAuth(result.auth || {});
    toast(result.message || "抖音登录信息已清除");
  }

  function bind() {
    $("authLoginStart").addEventListener("click", () => startAuthLogin().catch((err) => toast(err.message)));
    $("authImportCookie").addEventListener("click", () => $("authCookieFile").click());
    $("authCookieFile").addEventListener("change", () => {
      const file = $("authCookieFile").files?.[0];
      importAuthCookie(file)
        .catch((err) => toast(err.message))
        .finally(() => {
          $("authCookieFile").value = "";
        });
    });
    $("authCheck").addEventListener("click", () =>
      refreshAuthStatus().then((auth) => toast(auth.message || "登录状态已刷新")).catch((err) => toast(err.message))
    );
    $("authOpenFolder").addEventListener("click", () =>
      post("/api/auth/cookie/open-folder").then((result) => toast(result.message)).catch((err) => toast(err.message))
    );
    $("authClear").addEventListener("click", () => clearAuthCookie().catch((err) => toast(err.message)));
  }

  function render(state) {
    renderAuth(state.auth || {});
  }

  return { bind, render, activate: refreshAuthStatus };
}
