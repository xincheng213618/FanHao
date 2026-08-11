export function workDataSignature(data = {}) {
  const works = Array.isArray(data.works) ? data.works : [];
  return JSON.stringify({
    total: Number(data.total || works.length),
    facets: data.facets || null,
    folders: data.folders || null,
    selectedFolderId: data.selectedFolderId || "",
    works: works.map((work) => [
      work.id || "",
      work.title || "",
      work.directoryName || "",
      work.modifiedAt || "",
      work.favorite ? 1 : 0,
      work.favoriteFolderId || "",
      work.favoriteFolderName || "",
      work.progress || 0,
      work.missingLocal ? 1 : 0,
      work.infoSummary?.rating || "",
      work.infoSummary?.ratingCount || 0,
      work.infoSummary?.releaseDate || "",
      work.ranking?.rankNo || ""
    ])
  });
}
