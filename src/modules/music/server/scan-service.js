import { normalizeRoots } from "./scan.js";
import { createMusicScanWorkerClient } from "./scan-worker-client.js";
import { clampInt, httpError } from "./helpers.js";

export function createMusicScanService(options = {}) {
  const configuredRoots = normalizeRoots(options.roots || []);
  const worker = options.scanWorker || createMusicScanWorkerClient({
    dbPath: options.dbPath,
    ffprobePath: options.ffprobePath,
    ffprobeTimeoutMs: options.ffprobeTimeoutMs,
    ffprobeArgsPrefix: options.ffprobeArgsPrefix,
    busyTimeoutMs: options.busyTimeoutMs,
    workerFactory: options.scanWorkerFactory,
    workerUrl: options.scanWorkerUrl,
    readyTimeoutMs: options.scanWorkerReadyTimeoutMs,
    extraWorkerData: options.scanWorkerData
  });

  async function scan(input = {}) {
    const roots = normalizeRoots(input.root ? [input.root] : input.roots?.length ? input.roots : configuredRoots);
    const limit = clampInt(input.limit, 0, 0, Number.MAX_SAFE_INTEGER);
    const dryRun = Boolean(input.dryRun || input.dry_run);
    if (!roots.length) throw httpError(400, "没有配置音乐目录");
    const result = await worker.scan({ roots, limit, dryRun });
    if (!dryRun) options.onPublished?.();
    return result;
  }

  async function stop() {
    await worker.stop();
    options.onPublished?.();
  }

  return {
    diagnostics: worker.diagnostics,
    scan,
    start: worker.start,
    stop
  };
}
