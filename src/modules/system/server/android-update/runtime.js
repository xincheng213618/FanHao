import { routeAndroidUpdateApi } from "./routes.js";
import { createAndroidUpdateService } from "./service.js";

export function createAndroidUpdateRuntime({ sendJson, ...serviceDeps }) {
  const androidUpdateService = createAndroidUpdateService(serviceDeps);
  const deps = { androidUpdateService, sendJson };

  async function routeApi(req, res, url) {
    return routeAndroidUpdateApi(req, res, url, deps);
  }

  return {
    renderPage: androidUpdateService.renderPage,
    routeApi
  };
}
