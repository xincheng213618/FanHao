import { createDiskUsageRoutes } from "./routes.js";
import { createDiskUsageStore } from "./store.js";

export function createDiskUsageRuntime(options) {
  const store = createDiskUsageStore(options);
  const routes = createDiskUsageRoutes({ ...options, store });

  return {
    routeApi: routes.routeApi,
    routeMedia: routes.routeMedia,
    start: () => store.start(),
    beginStop: () => store.beginStop(),
    stop: () => store.stop()
  };
}
