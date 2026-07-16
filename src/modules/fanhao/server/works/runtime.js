import { createPersonDetailService } from "../people/person-detail-service.js";
import { createWorkDetailService } from "./work-detail-service.js";
import { createWorkMutationService } from "./work-mutation-service.js";
import { createWorkQueryService } from "./work-query-service.js";
import { routeWorksApi } from "./routes-api.js";
import { routeWorksMedia } from "./routes-media.js";

export function createWorksRuntime(deps) {
  let activeLibrary = null;
  let activeRequestDeps = null;

  function requestDeps() {
    const library = deps.getLibrary();
    if (library === activeLibrary && activeRequestDeps) return activeRequestDeps;
    const workQueryService = createWorkQueryService({ ...deps, library });
    activeLibrary = library;
    activeRequestDeps = {
      ...deps,
      library,
      personDetailService: createPersonDetailService({ ...deps, library, workQueryService }),
      workDetailService: createWorkDetailService({ ...deps, library }),
      workMutationService: createWorkMutationService(deps),
      workQueryService
    };
    return activeRequestDeps;
  }

  async function routeApi(req, res, url) {
    return routeWorksApi(req, res, url, requestDeps());
  }

  async function routeMedia(req, res, url) {
    return routeWorksMedia(req, res, url, requestDeps());
  }

  function start() {
    requestDeps().workQueryService.prewarm();
  }

  return {
    routeApi,
    routeMedia,
    start
  };
}
