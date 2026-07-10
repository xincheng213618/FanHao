import { fetchJson } from "../../js/api.js?v=20260706-mobile-web-sync-01";

export function createShortVideoApi({ getActiveUrl }) {
  return Object.freeze({
    fetch(baseUrl, routePath, options) {
      return fetchJson(baseUrl || getActiveUrl(), routePath, options);
    }
  });
}
