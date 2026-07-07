import { routeVideoLibraryApi } from "../routes/video-library-api.js";
import { routeVideoLibraryMedia } from "../routes/video-library-media.js";
import { createPersonDetailService } from "../person-detail-service.js";
import { createWorkDetailService } from "../work-detail-service.js";
import { createWorkMutationService } from "../work-mutation-service.js";
import { createWorkQueryService } from "../work-query-service.js";

export function createVideoLibraryModule(deps) {
  function requestDeps() {
    const library = deps.getLibrary();
    const workQueryService = createWorkQueryService({ ...deps, library });
    return {
      ...deps,
      library,
      personDetailService: createPersonDetailService({ ...deps, library, workQueryService }),
      workDetailService: createWorkDetailService({ ...deps, library }),
      workMutationService: createWorkMutationService(deps),
      workQueryService
    };
  }

  async function routeApi(req, res, url) {
    return routeVideoLibraryApi(req, res, url, requestDeps());
  }

  async function routeMedia(req, res, url) {
    return routeVideoLibraryMedia(req, res, url, requestDeps());
  }

  return {
    routeApi,
    routeMedia
  };
}
