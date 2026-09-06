export function personDetailPath(personId, options = {}) {
  const params = new URLSearchParams({
    limit: String(options.limit ?? 48),
    offset: String(options.offset ?? 0),
    filter: String(options.filter || "all"),
    year: String(options.year || "all"),
    sort: String(options.sort || "updated"),
    scope: String(options.scope || "main").toLowerCase() === "western" ? "western" : "main",
    includeMissingLocal: options.includeMissingLocal === false ? "0" : "1",
    includeCompilation: options.includeCompilation === false ? "0" : "1"
  });
  return `/api/people/${encodeURIComponent(personId)}?${params}`;
}
