import path from "node:path";
import { createNovelCollectionService } from "./collection-service.js";
import { createNovelCredentialService } from "./credential-service.js";
import { createNovelReimportService } from "./reimport-service.js";
import { createNovelSettingsProvider } from "./settings.js";
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
  const credentialService = createNovelCredentialService({
    credentialRoot: path.join(path.dirname(dbPath), "novel-credentials"),
    pythonPath
  });
  const collectionService = createNovelCollectionService({
    credentialService,
    dbPath: path.join(path.dirname(dbPath), "novel-collection.sqlite"),
    novelStore: store,
    outputRoot: path.join(path.dirname(dbPath), "novel-collection"),
    projectRoot,
    pythonPath
  });
  const settings = createNovelSettingsProvider({ credentialService });
  const reimportService = createNovelReimportService({
    collectionService,
    dbPath,
    novelStore: store,
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
      reimportService,
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
    settings,
    start: collectionService.start,
    stop: collectionService.stop,
    store,
    collectionService
  };
}
