import { prewarmCollectionWorkPage, routeUserStateApi } from "./routes.js";

const COLLECTION_PREWARM_PAGE_SIZE = 64;

export function createUserStateRuntime(deps) {
  function requestDeps() {
    return {
      ...deps,
      library: deps.getLibrary()
    };
  }

  async function routeApi(req, res, url) {
    return routeUserStateApi(req, res, url, requestDeps());
  }

  function start() {
    const active = requestDeps();
    const favoriteWorks = active.favoriteStateService.favoriteWorks().slice(0, COLLECTION_PREWARM_PAGE_SIZE);
    const historyWorks = active.playbackProgressService
      .historyEntries({ days: active.recentWatchedDays, limit: COLLECTION_PREWARM_PAGE_SIZE })
      .map((entry) => entry.work);
    const seen = new Set();
    const firstPageWorks = [...favoriteWorks, ...historyWorks].filter((work) => {
      if (!work?.id || seen.has(work.id)) return false;
      seen.add(work.id);
      return true;
    });
    prewarmCollectionWorkPage(firstPageWorks, active);
  }

  return {
    routeApi,
    start
  };
}
