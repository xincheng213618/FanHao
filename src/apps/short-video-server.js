import fs from "node:fs";
import path from "node:path";
import { SERVER_CONFIG } from "../bootstrap/server-config.js";
import { discoverFanHaoModules } from "../fanhao/module-registry.js";
import { createAuthServices } from "../platform/server/auth.js";
import { createRequestHandler } from "../platform/server/http-app.js";
import { createServerHost } from "../platform/server/server-host.js";
import { createStaticFileServer } from "../platform/server/static-files.js";
import { readBodyText } from "../platform/server/request-io.js";
import { sendJson, sendText, sendHtml, redirect, notFound } from "../platform/server/responses.js";

export async function startShortVideoServer(config = SERVER_CONFIG) {
  const auth = createAuthServices({
    authSecretPath: config.AUTH_SECRET_PATH,
    accountsDbPath: path.join(config.DATA_DIR, "accounts.sqlite"),
    remoteWebPassword: config.REMOTE_WEB_PASSWORD,
    ensureDataDir: () => fs.mkdirSync(config.DATA_DIR, { recursive: true }),
    readBodyText, sendJson, sendHtml, redirect
  });
  function requireLocalAdmin(req, res) {
    const state = auth.requestAuthState(req, new URL(req.url || "/", "http://localhost"));
    const access = auth.requestAccess(req);
    if (state.reason === "expired-account" || (state.accountLoginRequired && !state.user)
      || (state.user && state.user.role !== "admin")
      || !auth.isTrustedNetworkAccess(access) || !auth.isSameTrustedNetworkOrigin(req, access)) {
      sendJson(res, 403, { error: "需要本机或局域网同源的管理员权限" });
      return false;
    }
    return true;
  }
  let registry, staticFiles;
  async function stopResources() {
    const results = await Promise.allSettled([
      () => staticFiles?.stop(), () => registry?.stop()
    ].map(stopResource => Promise.resolve().then(stopResource)));
    const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
    try { auth.closeAccounts(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Short-video server resources failed to stop");
  }
  try {
    registry = await discoverFanHaoModules({
      modulesDir: config.MODULES_DIR, enabledModules: ["short-videos"], product: config.PRODUCT, sendJson,
      context: { moduleDeps: { shortVideos: { config, requireLocalAdmin } } }
    });
    staticFiles = createStaticFileServer({ publicDir: config.PUBLIC_DIR, mimeTypes: config.MIME_TYPES,
      normalizeExt: (file) => path.extname(file).toLowerCase(), notFound });
    const handler = createRequestHandler({
      ...auth, attachAccessAnalytics() {}, attachAccessLogger() {}, sendJson, sendText, sendHtml,
      renderAndroidUpdatePage: () => "此独立产品未提供 Android 更新。",
      async routeApi(req, res, url) {
        if (req.method === "GET" && url.pathname === "/api/health") {
          sendJson(res, 200, { ok: true, product: "short-videos" }); return true;
        }
        return registry.routeApi(req, res, url);
      },
      routeMedia: registry.routeMedia,
      serveStatic(req, res, route) {
        if (route === "/") { redirect(res, "/short-videos"); return; }
        return staticFiles.serveStatic(req, res, route);
      }
    });
    await staticFiles.start();
    await registry.start();
    const host = createServerHost({
      requestHandler: handler, port: config.PORT, host: config.HOST,
      getLibraryState: () => ({ availableRoots: config.SHORT_VIDEO_ROOTS, missingRoots: [] }),
      beginStop() { staticFiles.beginStop(); return registry.beginStop(); },
      stop: stopResources
    });
    host.listen();
    return host;
  } catch (error) {
    try { await stopResources(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Short-video server startup and cleanup failed", { cause: error }); }
    throw error;
  }
}
