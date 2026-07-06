import { routeToolsApi } from "../routes/tools-api.js";

export function createToolsModule(deps) {
  async function routeApi(req, res, url) {
    return routeToolsApi(req, res, url, deps);
  }

  return {
    routeApi
  };
}
