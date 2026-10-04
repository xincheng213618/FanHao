import { mountAccountPanel } from "../platform/accounts/account-ui.js";
import { authenticateAccount, clearServerSession, serverOrigin } from "./server-auth.js";
import { fetchJson } from "./api.js?v=assets-07b744082137";

export function createAccountSettings(root, { serverUrl, onSignedIn, onSignedOut }) {
  const origin = serverOrigin(serverUrl);
  return mountAccountPanel(root, {
    request: async (path, options) => {
      if (!origin) throw new Error("请先填写有效的内容服务地址");
      const payload = await fetchJson(origin, path, { ...options, cache: "no-store" });
      // Initial administrator setup belongs to the server computer, never the app.
      if (path === "/api/accounts/status") payload.setupAvailable = false;
      return payload;
    },
    authenticate: (mode, fields) => authenticateAccount(origin, mode, fields),
    clearSession: () => clearServerSession(origin),
    onSignedIn, onSignedOut
  });
}
