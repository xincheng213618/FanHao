import { routeCatalogApi } from "./routes.js";

export function createCatalogRuntime(deps) {
  async function routeApi(req, res, url) {
    return routeCatalogApi(req, res, url, deps);
  }

  function start() {
    deps.studioService.prewarm();
  }

  return {
    routeApi,
    start
  };
}
