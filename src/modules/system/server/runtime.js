import { createAdminRuntime } from "./admin/runtime.js";
import { createAndroidUpdateRuntime } from "./android-update/runtime.js";
import { createLocalOpenRuntime } from "./local-open/runtime.js";
import { createStatusRuntime } from "./status/runtime.js";

export function createSystemRuntime(deps) {
  const admin = createAdminRuntime(deps.admin);
  const androidUpdate = createAndroidUpdateRuntime(deps.androidUpdate);
  const localOpen = createLocalOpenRuntime(deps.localOpen);
  const status = createStatusRuntime(deps.status);

  async function routeApi(req, res, url) {
    if (await status.routeApi(req, res, url)) return true;
    if (await androidUpdate.routeApi(req, res, url)) return true;
    if (await admin.routeApi(req, res, url)) return true;
    return localOpen.routeApi(req, res, url);
  }

  async function routeMedia(req, res, url) {
    if (url.pathname !== "/media/remote-image" || req.method !== "GET") return false;
    await deps.mediaResponseService.serveCachedRemoteImage(req, res, url);
    return true;
  }

  return {
    renderAndroidUpdatePage: androidUpdate.renderPage,
    routeApi,
    routeMedia
  };
}
