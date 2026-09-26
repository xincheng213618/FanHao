import { normalizeShortVideoStatsFilter } from "./stats-query.js";

export function createShortVideoListStatsService({ store, catalogWorker, ensureCatalogSchema = null, logger = console }) {
  if (!store || typeof store.listVideos !== "function" || typeof store.catalogStamp !== "function") {
    throw new Error("short-video list stats service requires a catalog-aware store");
  }
  if (!catalogWorker || typeof catalogWorker.query !== "function" || typeof catalogWorker.queryStats !== "function") {
    throw new Error("short-video list stats service requires a stats worker");
  }

  async function list(urlOrOptions = {}, options = {}) {
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const filter = normalizeShortVideoStatsFilter(params);
    if (filter.source === "recommended" || params.get("stats") === "0") {
      try {
        ensureCatalogSchema?.();
        return await catalogWorker.query(workerListUrl(urlOrOptions), "list");
      } catch (error) {
        const recommended = filter.source === "recommended";
        logger?.warn?.(recommended ? "[short-video-recommended-worker]" : "[short-video-list-worker]", error?.message || error);
        throw listWorkerError(error, { recommended });
      }
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const statsPromise = catalogWorker.queryStats(filter, {
        catalogStamp: store.catalogStamp(),
        signal: options.signal
      });
      const listParams = new URLSearchParams(params);
      listParams.set("stats", "0");
      let data;
      try {
        data = store.listVideos({ searchParams: listParams });
      } catch (error) {
        void statsPromise.catch(() => undefined);
        throw error;
      }
      try {
        data.stats = await statsPromise;
        return data;
      } catch (error) {
        if (error?.code !== "SHORT_VIDEO_STATS_STALE" || attempt > 0) throw error;
      }
    }
    throw new Error("短视频列表正在更新，请稍后重试");
  }

  return { list };
}

function listWorkerError(cause, { recommended = false } = {}) {
  const error = new Error(recommended ? "短视频推荐后台线程暂时不可用" : "短视频列表后台线程暂时不可用");
  error.code = recommended ? "SHORT_VIDEO_CATALOG_UNAVAILABLE" : "SHORT_VIDEO_LIST_UNAVAILABLE";
  error.statusCode = 503;
  error.retryable = true;
  error.expose = true;
  error.cause = cause;
  return error;
}

function workerListUrl(urlOrOptions = {}) {
  if (urlOrOptions?.href) return urlOrOptions;
  const url = new URL("http://short-video.local/api/short-videos");
  url.search = String(urlOrOptions?.searchParams || "");
  return url;
}
