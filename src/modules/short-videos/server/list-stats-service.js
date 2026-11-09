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
    const workerOptions = { signal: options.signal, background: options.background };
    if (filter.source === "recommended" || params.get("stats") === "0") {
      try {
        ensureCatalogSchema?.();
        return await catalogWorker.query(workerListUrl(urlOrOptions), "list", workerOptions);
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        const admissionError = shortVideoCatalogAdmissionError(error);
        if (admissionError) throw admissionError;
        const recommended = filter.source === "recommended";
        logger?.warn?.(recommended ? "[short-video-recommended-worker]" : "[short-video-list-worker]", error?.message || error);
        throw listWorkerError(error, { recommended });
      }
    }

    ensureCatalogSchema?.();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const statsController = new AbortController();
      const statsPromise = catalogWorker.queryStats(filter, {
        ...workerOptions,
        signal: options.signal ? AbortSignal.any([options.signal, statsController.signal]) : statsController.signal,
        catalogStamp: store.catalogStamp()
      });
      // List construction now also awaits a worker. Observe a stats rejection
      // immediately while retaining it for the stale-generation retry below.
      void statsPromise.catch(() => undefined);
      const listParams = new URLSearchParams(params);
      listParams.set("stats", "0");
      let data;
      try {
        data = await catalogWorker.query(workerListUrl({ searchParams: listParams }), "list", workerOptions);
      } catch (error) {
        statsController.abort();
        if (error?.name === "AbortError") throw error;
        throw shortVideoCatalogAdmissionError(error) || listWorkerError(error);
      }
      try {
        return { ...data, stats: await statsPromise };
      } catch (error) {
        if (error?.code !== "SHORT_VIDEO_STATS_STALE" || attempt > 0) {
          throw shortVideoCatalogAdmissionError(error) || error;
        }
      }
    }
    throw new Error("短视频列表正在更新，请稍后重试");
  }

  return { list };
}

const CATALOG_ADMISSION_MESSAGES = {
  SHORT_VIDEO_CATALOG_QUEUE_FULL: "短视频目录服务正忙，请稍后重试",
  SHORT_VIDEO_WORKER_TIMEOUT: "短视频目录服务响应超时，请稍后重试",
  SHORT_VIDEO_STATS_WORKER_STOPPED: "短视频目录服务正在停止，请稍后重试"
};

export function shortVideoCatalogAdmissionError(cause) {
  const code = cause?.code;
  if (!Object.hasOwn(CATALOG_ADMISSION_MESSAGES, code)) return null;
  return Object.assign(new Error(CATALOG_ADMISSION_MESSAGES[code]), {
    code,
    statusCode: 503,
    retryable: true,
    expose: true
  });
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
