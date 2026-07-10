import { routeStatusApi } from "./routes.js";

export function createStatusRuntime(deps) {
  function requestDeps() {
    return {
      ...deps,
      library: deps.getLibrary()
    };
  }

  async function routeApi(req, res, url) {
    return routeStatusApi(req, res, url, requestDeps());
  }

  return {
    routeApi
  };
}
