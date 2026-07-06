import { routeLocalOpenApi } from "../routes/local-open-api.js";

export function createLocalOpenModule(deps) {
  async function routeApi(req, res, url) {
    return routeLocalOpenApi(req, res, url, deps);
  }

  return {
    routeApi
  };
}
