import path from "node:path";
import { createNovelCollectionService } from "./collection-service.js";
import { createNovelStore } from "./store.js";
import { routeNovelApi } from "./routes.js";

export function createNovelsRuntime({
  dbPath,
  novelUploadMaxBodyBytes,
  notFound,
  projectRoot,
  pythonPath,
  readJsonBody,
  requireLocalAdmin = () => true,
  sendJson
}) {
  const store = createNovelStore({ dbPath });
  const collectionService = createNovelCollectionService({
    dbPath: path.join(path.dirname(dbPath), "novel-collection.sqlite"),
    novelStore: store,
    outputRoot: path.join(path.dirname(dbPath), "novel-collection"),
    projectRoot,
    pythonPath
  });

  async function routeApi(req, res, url) {
    return routeNovelApi(req, res, url, {
      collectionService,
      notFound,
      novelStore: store,
      novelUploadMaxBodyBytes,
      readJsonBody,
      requireLocalAdmin,
      sendJson
    });
  }

  function invalidate() {
    store.invalidate();
  }

  return {
    invalidate,
    routeApi,
    start: collectionService.start,
    stop: collectionService.stop,
    store,
    collectionService
  };
}
