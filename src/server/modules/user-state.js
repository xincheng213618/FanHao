import { routeUserStateApi } from "../routes/user-state-api.js";

export function createUserStateModule(deps) {
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
