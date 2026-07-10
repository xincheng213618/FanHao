import { routeUserStateApi } from "./routes.js";

export function createUserStateRuntime(deps) {
  function requestDeps() {
    return {
      ...deps,
      library: deps.getLibrary()
    };
  }

  async function routeApi(req, res, url) {
    return routeUserStateApi(req, res, url, requestDeps());
  }

  return {
    routeApi
  };
}
