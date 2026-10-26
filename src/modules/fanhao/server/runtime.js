import { createCatalogRuntime } from "./catalog/runtime.js";
import { createDiskUsageRuntime } from "./disk-usage/runtime.js";
import { createLibraryRuntime } from "./library/runtime.js";
import { createFanhaoSettingsProvider } from "./settings/index.js";
import { createUserStateRuntime } from "./user-state/runtime.js";
import { createWorksRuntime } from "./works/runtime.js";
import { createFileWorkflowService } from "./workflows/file-workflow-service.js";
import { routeFileWorkflows } from "./workflows/routes.js";
import { createTasteRuntime } from "./taste/runtime.js";
import { createSubtitleRuntime } from "./playback/subtitle-runtime.js";
import { createDuplicateRuntime } from "./duplicates/runtime.js";

export function createFanhaoRuntime(deps) {
  const workflows = deps.workflows ? createFileWorkflowService(deps.workflows) : null;
  const taste = deps.taste ? createTasteRuntime(deps.taste) : null;
  const subtitles = deps.subtitles ? createSubtitleRuntime(deps.subtitles) : null;
  const duplicates = deps.duplicates ? createDuplicateRuntime(deps.duplicates) : null;
  const catalog = createCatalogRuntime(deps.catalog);
  const diskUsage = createDiskUsageRuntime(deps.diskUsage);
  const library = createLibraryRuntime(deps.library);
  const settings = createFanhaoSettingsProvider(deps.settings);
  const userState = createUserStateRuntime(deps.userState);
  const works = createWorksRuntime(deps.works);

  async function routeApi(req, res, url) {
    if (duplicates && await duplicates.routeApi(req, res, url)) return true;
    if (subtitles && await subtitles.routeApi(req, res, url)) return true;
    if (taste && await taste.routeApi(req, res, url)) return true;
    if (workflows && await routeFileWorkflows(req, res, url, { ...deps.workflows, service: workflows })) return true;
    if (await diskUsage.routeApi(req, res, url)) return true;
    if (await library.routeReadApi(req, res, url)) return true;
    if (await catalog.routeApi(req, res, url)) return true;
    if (await library.routeMutationApi(req, res, url)) return true;
    if (await userState.routeApi(req, res, url)) return true;
    return works.routeApi(req, res, url);
  }

  function start() {
    diskUsage.start();
    // This deliberately moves the one-time exact local code derivation into
    // readiness (before listen) so it cannot monopolize the shared HTTP event
    // loop later. It is startup latency, not free work. A transient read error
    // is logged and retried by the first request; failed batches are not cached.
    prewarmLocalMetadataBeforeListen(works);
    // Populate the visible people-index cover cache in the background. Keeping
    // this outside the broad eager-prewarm gate makes the default landing page
    // responsive without delaying the HTTP listener.
    library.prewarmPeopleIndexCovers();
    // The remaining response-cache warmups are optional and substantially
    // broader, so normal startup keeps them disabled.
    if (process.env.FANHAO_EAGER_PREWARM !== "1") return;
    library.start();
    catalog.start();
    works.start();
    userState.start();
  }

  function beginStop() {
    duplicates?.beginStop();
    subtitles?.beginStop();
    taste?.beginStop();
    workflows?.beginStop();
    diskUsage.beginStop();
  }

  async function stop() {
    const results = await Promise.allSettled([
      () => duplicates?.stop(), () => subtitles?.stop(), () => taste?.stop(), () => workflows?.close(), () => diskUsage.stop()
    ].map((close) => Promise.resolve().then(close)));
    const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    if (errors.length) throw new AggregateError(errors, "FanHao 服务未能完全停止");
  }

  async function routeMedia(req, res, url) {
    if (await diskUsage.routeMedia(req, res, url)) return true;
    return works.routeMedia(req, res, url);
  }

  return {
    beginStop,
    routeApi,
    routeMedia,
    start,
    stop,
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
