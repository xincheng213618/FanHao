import { normalizeShortVideoStatsFilter } from "./stats-query.js";

export function createShortVideoListStatsService({ store, catalogWorker, logger = console }) {
  if (!store || typeof store.listVideos !== "function" || typeof store.catalogStamp !== "function") {
    throw new Error("short-video list stats service requires a catalog-aware store");
  }
  if (!catalogWorker || typeof catalogWorker.query !== "function" || typeof catalogWorker.queryStats !== "function") {
    throw new Error("short-video list stats service requires a stats worker");
  }

  async function list(urlOrOptions = {}, options = {}) {
    const params = urlOrOptions?.searchParams || new URLSearchParams();
    const filter = normalizeShortVideoStatsFilter(params);
    if (filter.source === "recommended") {
      try {
        return await catalogWorker.query(workerListUrl(urlOrOptions), "list");
      } catch (error) {
        logger?.warn?.("[short-video-recommended-worker]", error?.message || error);
        throw recommendedWorkerError(error);
      }
    }
    if (params.get("stats") === "0") {
      return store.listVideos(urlOrOptions);
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

function recommendedWorkerError(cause) {
  const error = new Error("短视频推荐后台线程暂时不可用");
  error.code = "SHORT_VIDEO_CATALOG_UNAVAILABLE";
  error.statusCode = 503;
  error.retryable = true;
  error.cause = cause;
  return error;
}

function workerListUrl(urlOrOptions = {}) {
  if (urlOrOptions?.href) return urlOrOptions;
  const url = new URL("http://short-video.local/api/short-videos");
  url.search = String(urlOrOptions?.searchParams || "");
  return url;
}
