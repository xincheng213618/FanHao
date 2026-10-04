import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createNovelCollectionWorkerClient } from "./collection-worker-client.js";
import { createNovelCredentialService } from "./credential-service.js";
import { createNovelReimportService } from "./reimport-service.js";
import { createNovelSettingsProvider } from "./settings.js";
import { createNovelStore } from "./store.js";
import { NOVEL_WRITE_METHODS } from "./store.js";
import { createNovelWriteWorkerClient } from "./write-worker-client.js";
import { routeNovelApi } from "./routes.js";

export function createNovelsRuntime({
  dbPath,
  novelUploadMaxBodyBytes,
  notFound,
  projectRoot,
  pythonPath,
  readJsonBody,
  requireLocalAdmin = () => true,
  sendJson,
  writeWorkerOptions = {},
  collectionServiceOptions = {},
  reimportServiceOptions = {},
  collectionServiceFactory = createNovelCollectionWorkerClient
}) {
  const readStore = createNovelStore({ dbPath });
  const reimportArtifactRoot = reimportServiceOptions.artifactRoot || path.join(os.tmpdir(), `fanhao-novel-reimport-${crypto.randomUUID()}`);
  const writeService = createNovelWriteWorkerClient({ ...writeWorkerOptions, dbPath, reimportArtifactRoot, onCommitted: () => readStore.invalidate() });
  const store = { ...readStore, ...Object.fromEntries(NOVEL_WRITE_METHODS.map((method) => [method, writeService[method]])) };
  const credentialService = createNovelCredentialService({
    credentialRoot: path.join(path.dirname(dbPath), "novel-credentials"),
    pythonPath
  });
  const importCollectedBook = (book, options) => writeService.write("importCollectedBook", [book], options);
  const collectionService = collectionServiceFactory({
    ...collectionServiceOptions,
    credentialService,
    dbPath: path.join(path.dirname(dbPath), "novel-collection.sqlite"),
    credentialRoot: path.join(path.dirname(dbPath), "novel-credentials"),
    importCollectedBook,
    novelStore: { ...store, importCollectedBook },
    outputRoot: path.join(path.dirname(dbPath), "novel-collection"),
    projectRoot,
    pythonPath
  });
  const settings = createNovelSettingsProvider({ credentialService });
  const reimportService = createNovelReimportService({
    ...reimportServiceOptions,
    artifactRoot: reimportArtifactRoot,
    isWriterReleased: () => !writeService.diagnostics().unconfirmedClose,
    collectionService,
    dbPath,
    novelStore: store,
    projectRoot,
    pythonPath
  });
  let lifecycleGeneration = 0;

  function assertStarting(generation) {
    if (generation !== lifecycleGeneration) {
      throw Object.assign(new Error("小说后台正在停止"), { code: "NOVEL_RUNTIME_STOPPED", statusCode: 503 });
    }
  }

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

  async function stop() {
    lifecycleGeneration += 1;
    credentialService.beginStop?.();
    collectionService.beginStop?.();
    reimportService.beginStop();
    try {
      await drainImports();
    } finally {
      try { await writeService.stop(); }
      finally {
        try { await credentialService.stop?.(); }
        finally { store.invalidate(); }
      }
    }
  }

  async function drainImports() {
    const drained = await Promise.allSettled([collectionService.stop(), reimportService.stop()]);
    const failure = drained.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  return {
    invalidate,
    routeApi,
    settings,
    async start() {
      const generation = lifecycleGeneration;
      await credentialService.start?.();
      assertStarting(generation);
      await writeService.start();
      assertStarting(generation);
      await reimportService.start();
      assertStarting(generation);
      await collectionService.start();
      assertStarting(generation);
    },
    async beginStop() {
      lifecycleGeneration += 1;
      credentialService.beginStop?.();
      collectionService.beginStop?.();
      reimportService.beginStop();
      // An already dispatched collector import still needs the shared writer.
      try { await drainImports(); }
      finally { await writeService.beginStop(); }
    },
    stop,
    store,
    writeService,
    collectionService,
    reimportService
  };
}
