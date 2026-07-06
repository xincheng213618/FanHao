import { routeAdminApi } from "../routes/admin-api.js";

export function createAdminModule(deps) {
  function requestDeps() {
    return {
      ...deps,
      library: deps.getLibrary()
    };
  }

  async function routeApi(req, res, url) {
    return routeAdminApi(req, res, url, requestDeps());
  }

  return {
    routeApi
  };
}
