export function createWorkSearchDataService({ getActiveUrl, getWorksLimit, pageDataService, workListState }) {
  function path(query, limit = getWorksLimit(), filter = workListState.getFilterMode(), sort = workListState.getServerSortMode()) {
    const params = new URLSearchParams({
      q: String(query || "").trim(),
      limit: String(limit),
      offset: "0",
      sort,
      filter
    });
    return `/api/fanhao/search?${params}`;
  }

  function warm(query) {
    const text = String(query || "").trim();
    if (!text || globalThis.navigator?.connection?.saveData) return Promise.resolve([]);
    return pageDataService.warm(getActiveUrl(), [path(text)]);
  }

  function suggestions(query, options = {}) {
    const text = String(query || "").trim();
    if (!text) return Promise.resolve({ people: [], works: [] });
    return pageDataService.fetch(getActiveUrl(), path(text, 6, "all", "updated"), {
      signal: options.signal
    });
  }

  return { path, suggestions, warm };
}
