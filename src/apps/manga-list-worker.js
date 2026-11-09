import fs from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { createMangaCatalogueReader } from "../modules/photos/server/manga-service.js";
import { createImageLibraryService } from "../modules/content-index/server/image-library-service.js";

const { root, databasePath, maxItemLimit } = workerData;
const mangaService = createMangaCatalogueReader({ root, databasePath, safeStat });
const imageLibrary = createImageLibraryService({ mangaService, maxItemLimit, clampInteger });
const encoder = new TextEncoder();

parentPort.on("message", ({ id, query }) => {
  try {
    const url = new URL("http://localhost/api/image-library/items");
    url.search = query;
    if (String(url.searchParams.get("mode") || "").trim().toLowerCase() !== "manga") {
      throw new Error("Invalid manga list mode");
    }
    const body = encoder.encode(JSON.stringify(imageLibrary.itemsPayload(url)));
    parentPort.postMessage({ id, body }, [body.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, statusCode: error.statusCode, code: error.code } });
  }
});

function safeStat(filePath) {
  try { return fs.statSync(filePath); } catch { return null; }
}

function clampInteger(value, fallback, min, max) {
  if (value === null || value === undefined || String(value).trim() === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}
