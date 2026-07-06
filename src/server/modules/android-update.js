import { routeAndroidUpdateApi } from "../routes/android-update-api.js";

export function createAndroidUpdateModule(deps) {
  async function routeApi(req, res, url) {
    return routeAndroidUpdateApi(req, res, url, deps);
  }

  return {
    routeApi
  };
}
