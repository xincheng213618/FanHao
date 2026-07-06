import { createNovelStore } from "../novel-store.js";
import { routeNovelApi } from "../routes/novel-api.js";

export function createNovelsModule({
  dbPath,
  novelUploadMaxBodyBytes,
  notFound,
  readJsonBody,
  sendJson
}) {
  const store = createNovelStore({ dbPath });

  async function routeApi(req, res, url) {
    return routeNovelApi(req, res, url, {
      notFound,
      novelStore: store,
      novelUploadMaxBodyBytes,
      readJsonBody,
      sendJson
    });
  }

  function invalidate() {
    store.invalidate();
  }

  return {
    invalidate,
    routeApi,
    store
  };
}
