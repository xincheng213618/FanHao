import { routeAdminApi } from "./routes.js";

export function createAdminRuntime(deps) {
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
