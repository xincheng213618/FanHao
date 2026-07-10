import { routeLocalOpenApi } from "./routes.js";
import { createLocalOpenService } from "./service.js";

export function createLocalOpenRuntime({ service: serviceDeps, ...routeDeps }) {
  const deps = {
    ...routeDeps,
    localOpenService: createLocalOpenService(serviceDeps)
  };

  async function routeApi(req, res, url) {
    return routeLocalOpenApi(req, res, url, deps);
  }

  return {
    routeApi
  };
}
