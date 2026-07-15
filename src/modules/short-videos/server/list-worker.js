import { parentPort, workerData } from "node:worker_threads";
import { createShortVideoStore } from "./store.js";

const store = createShortVideoStore({
  dbPath: workerData.dbPath,
  downloadManagerDbPath: workerData.downloadManagerDbPath,
  ffmpegPath: workerData.ffmpegPath,
  roots: workerData.roots,
  skipStartupMaintenance: true,
  trustExplicitInvalidation: true
});

function warmStore(notifyReady = false) {
  let ok = true;
  try {
    store.warm({ recommendations: true });
  } catch (error) {
    ok = false;
    console.warn("[short-video-list-worker-warmup]", error?.message || error);
  } finally {
    if (notifyReady) parentPort?.postMessage({ type: "ready", ok });
  }
}

warmStore(true);

parentPort?.on("message", (message) => {
  if (message?.type === "reset") {
    store.close();
    warmStore();
    return;
  }
  if (!["list", "authors", "facets"].includes(message?.type)) return;
  try {
    const url = new URL(message.url);
    const data = message.type === "authors"
      ? store.listAuthors(url)
      : message.type === "facets"
        ? store.facets()
        : store.listVideos(url);
    parentPort?.postMessage({ ok: true, id: message.id, data });
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      id: message.id,
      error: String(error?.message || error),
      stack: String(error?.stack || "")
    });
  }
});

process.once("beforeExit", () => store.close());
