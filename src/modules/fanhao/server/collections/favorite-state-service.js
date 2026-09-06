export function createFavoriteStateService({
  createId,
  defaultFavoriteFolderId,
  defaultFavoriteFolderName,
  getLibrary,
  maxFavoriteFolders,
  userState,
  getUserState = () => userState,
  userStateService
}) {
  function isFavoriteWork(workId) {
    const userState = getUserState();
    return Boolean(userState.favorites[workId]);
  }

  function favoriteRecord(workId) {
    const userState = getUserState();
    const favorite = userState.favorites[workId];
    return favorite ? userStateService.normalizeFavoriteRecord(favorite, userState.favoriteFolders) : null;
  }

  function favoriteFolderName(folderId) {
    const userState = getUserState();
    return userState.favoriteFolders?.[folderId]?.name || defaultFavoriteFolderName;
  }

  function normalizeFavoriteFolderId(folderId) {
    return userStateService.normalizeFavoriteFolderId(folderId);
  }

  function favoriteFolderCounts() {
    const userState = getUserState();
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
    const userState = getUserState();
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
    const userState = getUserState();
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

  function customFavoriteFolder(folderId, state) {
    const id = String(folderId || "");
    if (id === defaultFavoriteFolderId) throw folderError(400, "默认收藏夹不能改名或删除");
    if (!Object.hasOwn(state.favoriteFolders || {}, id)) throw folderError(404, "收藏夹不存在");
    return id;
  }

  function publicFavoriteFolder(folderId) {
    return publicFavoriteFolders().find((folder) => folder.id === folderId);
  }

  function saveFolderChanges(state, folders, favorites = state.favorites) {
    const previousFolders = state.favoriteFolders;
    const previousFavorites = state.favorites;
    state.favoriteFolders = folders;
    state.favorites = favorites;
    try {
      // Account persistence is transactional; the legacy store opts into an
      // atomic file replacement only for these new folder-management actions.
      userStateService.save({ strict: true });
    } catch (error) {
      state.favoriteFolders = previousFolders;
      state.favorites = previousFavorites;
      throw error;
    }
  }

  function renameFavoriteFolder(folderId, name) {
    const state = getUserState();
    const id = customFavoriteFolder(folderId, state);
    const cleanName = userStateService.cleanFavoriteFolderName(name);
    if (!cleanName) throw folderError(400, "请输入收藏夹名称");
    const previous = state.favoriteFolders[id];
    if (userStateService.cleanFavoriteFolderName(previous?.name) === cleanName) return publicFavoriteFolder(id);
    if (Object.entries(state.favoriteFolders).some(([otherId, folder]) => otherId !== id && userStateService.cleanFavoriteFolderName(folder?.name) === cleanName)) {
      throw folderError(409, "已存在同名收藏夹");
    }
    const folders = Object.fromEntries(Object.entries(state.favoriteFolders).map(([key, folder]) => [key, key === id ? { ...folder, name: cleanName } : folder]));
    saveFolderChanges(state, folders);
    return publicFavoriteFolder(id);
  }

  function deleteFavoriteFolder(folderId) {
    const state = getUserState();
    const id = customFavoriteFolder(folderId, state);
    const folders = Object.fromEntries(Object.entries(state.favoriteFolders).filter(([key]) => key !== id));
    if (!Object.hasOwn(folders, defaultFavoriteFolderId)) folders[defaultFavoriteFolderId] = userStateService.defaultFavoriteFolders()[defaultFavoriteFolderId];
    let movedCount = 0;
    const favorites = Object.fromEntries(Object.entries(state.favorites || {}).map(([workId, record]) => {
      if (record?.folderId !== id) return [workId, record];
      movedCount += 1;
      return [workId, { ...record, folderId: defaultFavoriteFolderId }];
    }));
    saveFolderChanges(state, folders, favorites);
    return { deletedFolderId: id, movedCount, defaultFolder: publicFavoriteFolder(defaultFavoriteFolderId) };
  }

  function moveFavoriteToFolder(workId, folderId) {
    const userState = getUserState();
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
    const userState = getUserState();
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
    const userState = getUserState();
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
    deleteFavoriteFolder,
    favoriteFolderCounts,
    favoriteRecord,
    favoriteWorks,
    isFavoriteWork,
    moveFavoriteToFolder,
    normalizeFavoriteFolderId,
    publicFavoriteFolders,
    publicFavoriteForWork,
    renameFavoriteFolder,
    toggleFavorite
  };
}

function folderError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
