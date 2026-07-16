import { createLatestRequestGate } from "./latest-request.js?v=20260717-fanhao-latest-request-01";

export function createSearchRequestService({ api, filter, pageSize, sort }) {
  const requests = createLatestRequestGate();

  async function fetchPage(query, offset = 0) {
    const request = requests.begin();
    const params = new URLSearchParams({
      q: query,
      limit: String(pageSize()),
      offset: String(offset || 0),
      sort: sort(),
      filter: filter()
    });
    try {
      const data = await api(`/api/search?${params}`, { signal: request.signal });
      return request.isCurrent() ? data : null;
    } catch (error) {
      if (!request.isCurrent()) return null;
      throw error;
    } finally {
      request.finish();
    }
  }

  return { cancel: requests.cancel, fetchPage };
}
