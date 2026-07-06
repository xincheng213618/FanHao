import { routeStatusApi } from "../routes/status-api.js";

export function createStatusModule(deps) {
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
