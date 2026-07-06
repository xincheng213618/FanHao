import { routeCatalogApi } from "../routes/catalog-api.js";

export function createCatalogModule(deps) {
  async function routeApi(req, res, url) {
    return routeCatalogApi(req, res, url, deps);
  }

  return {
    routeApi
  };
}
