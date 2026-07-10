export function createFavoriteStateService({
  createId,
  defaultFavoriteFolderId,
  defaultFavoriteFolderName,
  getLibrary,
  maxFavoriteFolders,
  userState,
  userStateService
}) {
  function isFavoriteWork(workId) {
    return Boolean(userState.favorites[workId]);
  }

  function favoriteRecord(workId) {
    const favorite = userState.favorites[workId];
    return favorite ? userStateService.normalizeFavoriteRecord(favorite, userState.favoriteFolders) : null;
  }

  function favoriteFolderName(folderId) {
    return userState.favoriteFolders?.[folderId]?.name || defaultFavoriteFolderName;
  }

  function normalizeFavoriteFolderId(folderId) {
    return userStateService.normalizeFavoriteFolderId(folderId);
  }

  function favoriteFolderCounts() {
    const library = getLibrary();
    const counts = new Map(Object.keys(userState.favoriteFolders || userStateService.defaultFavoriteFolders()).map((folderId) => [folderId, 0]));
    for (const [workId, favorite] of Object.entries(userState.favorites || {})) {
      if (!library.worksById.has(workId)) continue;
      const folderId = userStateService.normalizeFavoriteFolderId(favorite?.folderId);
      counts.set(folderId, (counts.get(folderId) || 0) + 1);
    }
    return counts;
  }

  function publicFavoriteFolders() {
    const counts = favoriteFolderCounts();
    return Object.entries(userState.favoriteFolders || userStateService.defaultFavoriteFolders())
      .map(([id, folder]) => ({
        id,
        name: userStateService.cleanFavoriteFolderName(folder?.name) || defaultFavoriteFolderName,
        count: counts.get(id) || 0,
        createdAt: String(folder?.createdAt || "")
      }))
      .sort((a, b) => {
        if (a.id === defaultFavoriteFolderId) return -1;
        if (b.id === defaultFavoriteFolderId) return 1;
        return String(a.createdAt || "").localeCompare(String(b.createdAt || "")) || a.name.localeCompare(b.name, "zh-Hans-CN");
      });
  }

  function publicFavoriteForWork(workId) {
    const favorite = favoriteRecord(workId);
    if (!favorite) return null;
    const folderId = userStateService.normalizeFavoriteFolderId(favorite.folderId);
    return {
      createdAt: favorite.createdAt || "",
      folderId,
      folderName: favoriteFolderName(folderId)
    };
  }

  function createFavoriteFolder(name) {
    const cleanName = userStateService.cleanFavoriteFolderName(name);
    if (!cleanName) {
      const error = new Error("请输入收藏夹名称");
      error.statusCode = 400;
      throw error;
    }

    const folders = userState.favoriteFolders || userStateService.defaultFavoriteFolders();
    const existing = Object.entries(folders).find(([, folder]) => userStateService.cleanFavoriteFolderName(folder?.name) === cleanName);
    if (existing) return { id: existing[0], ...existing[1] };

    if (Object.keys(folders).length >= maxFavoriteFolders) {
      const error = new Error(`收藏夹最多 ${maxFavoriteFolders} 个`);
      error.statusCode = 400;
      throw error;
    }

    const baseId = createId("ff", cleanName).slice(0, 80);
    let id = baseId;
    let suffix = 2;
    while (folders[id]) {
      id = `${baseId}_${suffix}`;
      suffix += 1;
    }

    folders[id] = {
      name: cleanName,
      createdAt: new Date().toISOString()
    };
    userState.favoriteFolders = folders;
    userStateService.save();
    return { id, ...folders[id] };
  }

  function moveFavoriteToFolder(workId, folderId) {
    const favorite = userState.favorites[workId];
    if (!favorite) {
      const error = new Error("作品尚未收藏");
      error.statusCode = 400;
      throw error;
    }
    favorite.folderId = userStateService.normalizeFavoriteFolderId(folderId);
    userStateService.save();
    return publicFavoriteForWork(workId);
  }

  function toggleFavorite(workId, body = {}) {
    if (userState.favorites[workId]) {
      delete userState.favorites[workId];
    } else {
      userState.favorites[workId] = {
        createdAt: new Date().toISOString(),
        folderId: userStateService.normalizeFavoriteFolderId(body.folderId)
      };
    }

    userStateService.save();
    return {
      workId,
      favorite: Boolean(userState.favorites[workId]),
      favoriteFolder: publicFavoriteForWork(workId),
      folders: publicFavoriteFolders()
    };
  }

  function favoriteWorks(folderId = "") {
    const library = getLibrary();
    const selectedFolderId = folderId ? userStateService.normalizeFavoriteFolderId(folderId) : "";
    return Object.entries(userState.favorites)
      .map(([workId, favorite]) => ({ work: library.worksById.get(workId), favorite: userStateService.normalizeFavoriteRecord(favorite, userState.favoriteFolders) }))
      .filter((item) => item.work)
      .filter((item) => !selectedFolderId || userStateService.normalizeFavoriteFolderId(item.favorite.folderId) === selectedFolderId)
      .sort((a, b) => String(b.favorite.createdAt || "").localeCompare(String(a.favorite.createdAt || "")))
      .map((item) => item.work);
  }

  return {
    createFavoriteFolder,
    favoriteFolderCounts,
    favoriteRecord,
    favoriteWorks,
    isFavoriteWork,
    moveFavoriteToFolder,
    normalizeFavoriteFolderId,
    publicFavoriteFolders,
    publicFavoriteForWork,
    toggleFavorite
  };
}
