import { createCollectionQueryService } from "./collection-query-service.js";
import { routeUserStateApi } from "./routes.js";

export function createUserStateRuntime(deps) {
  const collectionQueryService = createCollectionQueryService(deps);

  function requestDeps() {
    return {
      ...deps,
      collectionQueryService,
      library: deps.getLibrary()
    };
  }

  async function routeApi(req, res, url) {
    return routeUserStateApi(req, res, url, requestDeps());
  }

  function start() {
    collectionQueryService.prewarm();
  }

  return {
    routeApi,
    start
  };
}
