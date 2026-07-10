import { routeContentIndexApi } from "./routes.js";

export function createContentIndexRuntime(deps) {
  return {
    routeApi(req, res, url) {
      return routeContentIndexApi(req, res, url, deps);
    }
  };
}
