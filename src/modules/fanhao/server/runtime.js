import { createCatalogRuntime } from "./catalog/runtime.js";
import { createLibraryRuntime } from "./library/runtime.js";
import { createUserStateRuntime } from "./user-state/runtime.js";
import { createVideoLibraryRuntime } from "./video-library/runtime.js";

export function createFanhaoRuntime(deps) {
  const catalog = createCatalogRuntime(deps.catalog);
  const library = createLibraryRuntime(deps.library);
  const userState = createUserStateRuntime(deps.userState);
  const videoLibrary = createVideoLibraryRuntime(deps.videoLibrary);

  async function routeApi(req, res, url) {
    if (await library.routeReadApi(req, res, url)) return true;
    if (await catalog.routeApi(req, res, url)) return true;
    if (await library.routeMutationApi(req, res, url)) return true;
    if (await userState.routeApi(req, res, url)) return true;
    return videoLibrary.routeApi(req, res, url);
  }

  return {
    routeApi,
    routeMedia: videoLibrary.routeMedia
  };
}
