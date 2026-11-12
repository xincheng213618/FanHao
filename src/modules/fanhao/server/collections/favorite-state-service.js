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
      const folderId = userStateService.normalizeFavoriteFolderId(favorite?.folderId, userState.favoriteFolders);
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
      // Guest writes must surface persistence errors so we can restore these
      // folder changes in memory. Account persistence already rolls back.
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

  function transferFavoriteFolder(state, id, destinationId) {
    const folders = Object.fromEntries(Object.entries(state.favoriteFolders).filter(([key]) => key !== id));
    if (!Object.hasOwn(folders, defaultFavoriteFolderId)) folders[defaultFavoriteFolderId] = userStateService.defaultFavoriteFolders()[defaultFavoriteFolderId];
    let movedCount = 0;
    const favorites = Object.fromEntries(Object.entries(state.favorites || {}).map(([workId, record]) => {
      if (record?.folderId !== id) return [workId, record];
      movedCount += 1;
      return [workId, { ...record, folderId: destinationId }];
    }));
    saveFolderChanges(state, folders, favorites);
    return { deletedFolderId: id, movedCount, destinationFolder: publicFavoriteFolder(destinationId) };
  }

  function deleteFavoriteFolder(folderId) {
    const state = getUserState();
    const id = customFavoriteFolder(folderId, state);
    const { deletedFolderId, movedCount, destinationFolder } = transferFavoriteFolder(state, id, defaultFavoriteFolderId);
    return { deletedFolderId, movedCount, defaultFolder: destinationFolder };
  }

  function mergeFavoriteFolder(folderId, destinationId, { sourceCreatedAt, destinationCreatedAt } = {}) {
    const state = getUserState();
    if (folderId === defaultFavoriteFolderId) throw folderError(400, "默认收藏夹不能作为合并源");
    const id = customFavoriteFolder(folderId, state);
    if (typeof destinationId !== "string" || !Object.hasOwn(state.favoriteFolders, destinationId)) {
      throw folderError(404, "目标收藏夹不存在");
    }
    if (id === destinationId) throw folderError(400, "请选择另一个目标收藏夹");
    if (sourceCreatedAt !== undefined && sourceCreatedAt !== String(state.favoriteFolders[id].createdAt || "")
      || destinationCreatedAt !== undefined && destinationCreatedAt !== String(state.favoriteFolders[destinationId].createdAt || "")) {
      throw folderError(409, "收藏夹已重新创建，请刷新列表后再合并");
    }
    return transferFavoriteFolder(state, id, destinationId);
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

  function favoriteBatchIds(workIds) {
    if (!Array.isArray(workIds) || !workIds.length || workIds.length > 500
      || workIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw folderError(400, "请选择 1 至 500 部已收藏的作品");
    }
    return [...new Set(workIds)];
  }

  function moveFavoritesToFolder(workIds, folderId) {
    const state = getUserState();
    const ids = favoriteBatchIds(workIds);
    if (typeof folderId !== "string" || !Object.hasOwn(state.favoriteFolders || {}, folderId)) {
      throw folderError(404, "目标收藏夹不存在");
    }
    const library = getLibrary();
    if (ids.some((id) => !library.worksById.has(id) || !Object.hasOwn(state.favorites, id))) {
      throw folderError(409, "部分作品已移出馆藏或取消收藏，请刷新收藏后重新选择");
    }
    const changes = ids.map((id) => [id, userStateService.normalizeFavoriteRecord(state.favorites[id], state.favoriteFolders)])
      .filter(([, favorite]) => favorite.folderId !== folderId);
    if (changes.length) {
      const favorites = { ...state.favorites };
      for (const [id, favorite] of changes) favorites[id] = { ...favorite, folderId };
      saveFolderChanges(state, state.favoriteFolders, favorites);
    }
    return { workIds: ids, folderId, movedCount: changes.length };
  }

  function removeFavorites(workIds) {
    const ids = favoriteBatchIds(workIds);
    const state = getUserState();
    const removed = ids.filter((id) => Object.hasOwn(state.favorites, id));
    if (removed.length) {
      const favorites = { ...state.favorites };
      for (const id of removed) delete favorites[id];
      saveFolderChanges(state, state.favoriteFolders, favorites);
    }
    return { workIds: ids, removedCount: removed.length };
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

  function saveFavoriteToFolder(workId, folderId) {
    const state = getUserState();
    const folders = state.favoriteFolders || userStateService.defaultFavoriteFolders();
    if (typeof folderId !== "string" || !Object.hasOwn(folders, folderId)) {
      throw folderError(404, "目标收藏夹不存在");
    }
    const previous = favoriteRecord(workId);
    if (previous?.folderId !== folderId) {
      const favorite = { createdAt: previous?.createdAt || new Date().toISOString(), folderId };
      saveFolderChanges(state, folders, { ...state.favorites, [workId]: favorite });
    }
    return { workId, favorite: true, favoriteFolder: publicFavoriteForWork(workId), folders: publicFavoriteFolders() };
  }

  function favoriteWorks(folderId = "") {
    const userState = getUserState();
    const library = getLibrary();
    const selectedFolderId = folderId ? userStateService.normalizeFavoriteFolderId(folderId) : "";
    return Object.entries(userState.favorites)
      .map(([workId, favorite]) => ({ work: library.worksById.get(workId), favorite: userStateService.normalizeFavoriteRecord(favorite, userState.favoriteFolders) }))
      .filter((item) => item.work)
      .filter((item) => !selectedFolderId || userStateService.normalizeFavoriteFolderId(item.favorite.folderId, userState.favoriteFolders) === selectedFolderId)
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
    mergeFavoriteFolder,
    moveFavoriteToFolder,
    moveFavoritesToFolder,
    normalizeFavoriteFolderId,
    publicFavoriteFolders,
    publicFavoriteForWork,
    removeFavorites,
    renameFavoriteFolder,
    saveFavoriteToFolder,
    toggleFavorite
  };
}

function folderError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
