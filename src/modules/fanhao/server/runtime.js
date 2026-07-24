import { createCatalogRuntime } from "./catalog/runtime.js";
import { createLibraryRuntime } from "./library/runtime.js";
import { createFanhaoSettingsProvider } from "./settings/index.js";
import { createUserStateRuntime } from "./user-state/runtime.js";
import { createWorksRuntime } from "./works/runtime.js";

export function createFanhaoRuntime(deps) {
  const catalog = createCatalogRuntime(deps.catalog);
  const library = createLibraryRuntime(deps.library);
  const settings = createFanhaoSettingsProvider(deps.settings);
  const userState = createUserStateRuntime(deps.userState);
  const works = createWorksRuntime(deps.works);

  async function routeApi(req, res, url) {
    if (await library.routeReadApi(req, res, url)) return true;
    if (await catalog.routeApi(req, res, url)) return true;
    if (await library.routeMutationApi(req, res, url)) return true;
    if (await userState.routeApi(req, res, url)) return true;
    return works.routeApi(req, res, url);
  }

  function start() {
    // These are optional response-cache warmups, not service dependencies.
    // Large libraries can spend many seconds here, so keep normal startup lazy.
    if (process.env.FANHAO_EAGER_PREWARM !== "1") return;
    library.start();
    catalog.start();
    works.start();
    userState.start();
  }

  return {
    routeApi,
    routeMedia: works.routeMedia,
    start,
    settings
  };
}
