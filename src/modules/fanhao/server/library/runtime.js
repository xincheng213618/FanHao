import { routeLibraryApi, routeLibraryMutationApi, routeLibraryReadApi } from "./routes.js";

export function createLibraryRuntime(deps) {
  function requestDeps() {
    return {
      ...deps,
      library: deps.getLibrary()
    };
  }

  async function routeApi(req, res, url) {
    return routeLibraryApi(req, res, url, requestDeps());
  }

  async function routeReadApi(req, res, url) {
    return routeLibraryReadApi(req, res, url, requestDeps());
  }

  async function routeMutationApi(req, res, url) {
    return routeLibraryMutationApi(req, res, url, requestDeps());
  }

  return {
    routeApi,
    routeMutationApi,
    routeReadApi
  };
}
