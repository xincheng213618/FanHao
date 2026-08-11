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
    // This deliberately moves the one-time exact local code derivation into
    // readiness (before listen) so it cannot monopolize the shared HTTP event
    // loop later. It is startup latency, not free work. A transient read error
    // is logged and retried by the first request; failed batches are not cached.
    prewarmLocalMetadataBeforeListen(works);
    // The remaining response-cache warmups are optional and substantially
    // broader, so normal startup keeps them disabled.
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

export function prewarmLocalMetadataBeforeListen(works, warn = console.warn) {
  try {
    works.prewarmLocalMetadata();
    return true;
  } catch (error) {
    warn("[fanhao] local metadata prewarm failed:", error.message);
    return false;
  }
}
