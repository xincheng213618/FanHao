export function workCollectionPath(view, {
  filter = "all",
  folderId = "",
  limit = 48,
  offset = 0,
  sort = "updated"
} = {}) {
  const endpoint = view === "favorites" ? "favorites" : "history";
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    filter: String(filter || "all"),
    sort: String(sort || "updated")
  });
  if (endpoint === "favorites" && folderId && folderId !== "all") params.set("folder", String(folderId));
  return `/api/${endpoint}?${params}`;
}
