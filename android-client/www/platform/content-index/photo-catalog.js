export const PHOTO_COLLECTION_SORT_OPTIONS = [
  ["updated", "最近更新"],
  ["count", "期数最多"],
  ["size", "容量最大"],
  ["title", "名称排序"]
];

export const PHOTO_ALBUM_SORT_OPTIONS = [
  ["updated", "最近更新"],
  ["size", "容量最大"],
  ["title", "名称排序"]
];

export function photoCatalogCollections(categoryItems = [], sort = "updated") {
  const collections = new Map();
  for (const category of Array.isArray(categoryItems) ? categoryItems : []) {
    const categoryCollections = Array.isArray(category?.collections) ? category.collections : [];
    for (const collection of categoryCollections) {
      const id = String(collection?.collectionId || collection?.id || collection?.routePath || "").trim();
      if (!id || collections.has(id)) continue;
      collections.set(id, {
        ...collection,
        catalogCategory: collection.category || category.category || "",
        catalogRootLabel: collection.rootLabel || category.rootLabel || ""
      });
    }
  }
  return sortPhotoCatalogCollections([...collections.values()], sort);
}

export function sortPhotoCatalogCollections(items = [], sort = "updated") {
  const list = [...(Array.isArray(items) ? items : [])];
  const byTitle = (a, b) => String(a?.title || "").localeCompare(String(b?.title || ""), undefined, {
    numeric: true,
    sensitivity: "base"
  });
  if (sort === "count") {
    return list.sort((a, b) => Number(b?.albumCount || 0) - Number(a?.albumCount || 0) || Number(b?.size || 0) - Number(a?.size || 0) || byTitle(a, b));
  }
  if (sort === "size") {
    return list.sort((a, b) => Number(b?.size || 0) - Number(a?.size || 0) || byTitle(a, b));
  }
  if (sort === "title") return list.sort(byTitle);
  return list.sort((a, b) => new Date(b?.updatedAt || 0).getTime() - new Date(a?.updatedAt || 0).getTime() || byTitle(a, b));
}
