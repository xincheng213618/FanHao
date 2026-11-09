import { routeContentIndexApi } from "./routes.js";
import { createMangaListWorkerClient } from "./manga-list-worker-client.js";

export function createContentIndexRuntime(deps) {
  const mangaListWorker = deps.mangaListConfig ? createMangaListWorkerClient(deps.mangaListConfig) : null;
  const routeDeps = mangaListWorker ? { ...deps, mangaListWorker } : deps;
  return {
    routeApi(req, res, url) {
      return routeContentIndexApi(req, res, url, routeDeps);
    },
    start: () => mangaListWorker?.start(),
    beginStop: () => mangaListWorker?.beginStop(),
    stop: () => mangaListWorker?.stop()
  };
}
