import { mountAccountPanel } from "./account-ui.js";
import { captureWebAccount, checkWebAccountResponse, invalidateWebAccount, publishWebAccountChange } from "./session-context.js";

async function request(path, { method = "GET", body } = {}) {
  const account = captureWebAccount();
  const response = await fetch(path, { method, headers: { Accept: "application/json", ...(account.owner ? { "X-FanHao-Account-Owner": account.owner } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal: AbortSignal.timeout(25000), redirect: "error" });
  const payload = await response.json();
  checkWebAccountResponse(response, account);
  if (payload.code === "ACCOUNT_CHANGED") invalidateWebAccount();
  if (!response.ok) throw Object.assign(new Error(payload.error || "请求失败"), { statusCode: response.status });
  if (/^\/api\/accounts\/(?:login|register|setup)$/.test(path)) publishWebAccountChange(`account:${payload.user.id}`);
  else if (/^\/api\/accounts\/(?:logout|password(?:\/reset)?)$/.test(path) || (path.includes("/sessions/") && payload.current)) publishWebAccountChange("guest");
  else if (path === "/api/accounts/status") checkWebAccountResponse(response, account, payload.user?.id ? `account:${payload.user.id}` : "guest");
  return payload;
}
function nextPath() {
  const raw = new URLSearchParams(location.search).get("next");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  const url = new URL(raw, location.origin);
  return url.origin === location.origin && !/^\/(?:auth|login|register|account)(?:\/|$)/.test(url.pathname) ? url.pathname + url.search + url.hash : null;
}
mountAccountPanel(document.getElementById("accountRoot"), {
  request, initialMode: location.pathname === "/register" ? "register" : "login",
  onSignedIn: () => { const next = nextPath(); if (next) location.assign(next); },
  legacyLogin: async (password) => { await request("/auth/login", { method: "POST", body: { password } }); publishWebAccountChange(); location.assign(nextPath() || "/"); }
});
