export function createWorkActions({
  api,
  beginFavoriteUi,
  onCollectionStateChanged = () => {},
  onCurrentWorkFavoriteChanged = () => {},
  renderFavoriteFolderControls,
  renderStatsForWorks,
  renderWorks,
  showError = (message) => globalThis.alert?.(message),
  state
}) {
  const favoriteWrites = new Set();
  const isFavoritePending = (workId) => favoriteWrites.has(String(workId));
  const favoriteFolderWrites = new Set();
  const isFavoriteFolderPending = (workId) => favoriteFolderWrites.has(String(workId));
  async function toggleFavorite(workId, control = null) {
    const writeKey = String(workId);
    if (isFavoritePending(writeKey)) return null;
    favoriteWrites.add(writeKey);
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      favoriteWrites.delete(writeKey);
    };
    let ui;
    try {
      const snapshot = captureFavoriteSnapshot(workId);
      const optimisticFavorite = !snapshot.works[0]?.favorite;
      ui = beginFavoriteUi?.({ workId, control, syncControl: syncFavoriteControl, showError });

      if (control) {
        updateWorkFavorite(workId, optimisticFavorite);
        updateCurrentWorkFavorite(workId, optimisticFavorite);
        syncFavoriteControl(control, optimisticFavorite, true);
      }

      try {
        const data = await api(`/api/favorites/${encodeURIComponent(workId)}`, { method: "POST" });
        state.favoriteFolders = data.folders || state.favoriteFolders;
        updateWorkFavorite(workId, data.favorite, data.favoriteFolder);
        updateCurrentWorkFavorite(workId, data.favorite, data.favoriteFolder);
        if (control) syncFavoriteControl(control, data.favorite, false);
        if (state.library) state.library.user = data.user;

        let removedWorkIds = [];
        if (state.activeView === "favorites" && !data.favorite) {
          removedWorkIds = [...new Set(state.works.filter((work) => work.id === workId).map((work) => String(work.id)))];
          state.works = state.works.filter((work) => work.id !== workId);
        }
        releaseOnce();
        onCollectionStateChanged({ removedWorkIds });
        if (ui?.settle({ error: null, removedWorkIds }) !== true) {
          if (state.activeView === "favorites") {
            renderStatsForWorks(state.works);
            renderFavoriteFolderControls();
          }
          renderWorks(state.activeView === "favorites" ? "还没有收藏。" : "没有匹配的作品。");
        }
        onCurrentWorkFavoriteChanged(state.currentWork);
        return data;
      } catch (error) {
        restoreFavoriteSnapshot(snapshot);
        if (control) syncFavoriteControl(control, snapshot.works[0]?.favorite, false);
        releaseOnce();
        if (ui?.settle({ error }) !== true) {
          renderWorks(state.activeView === "favorites" ? "还没有收藏。" : "没有匹配的作品。");
          showError(error.message);
        }
        return null;
      }
    } finally {
      releaseOnce();
      if (control && !isFavoritePending(writeKey)) {
        control.disabled = false;
        control.classList?.remove("pending");
      }
      ui?.finish();
    }
  }

  async function moveFavoriteToFolder(work, folderId, control) {
    if (isFavoriteFolderPending(work.id)) return null;
    const previous = work.favoriteFolderId || "default";
    const ui = beginFavoriteUi?.({ workId: work.id, control, syncControl: syncFavoriteControl, showError, kind: "folder", requestedFolderId: folderId });
    favoriteFolderWrites.add(String(work.id));
    control.disabled = true;
    try {
      const data = await api(`/api/favorites/${encodeURIComponent(work.id)}/folder`, { method: "PUT", body: { folderId } });
      state.favoriteFolders = data.folders || state.favoriteFolders;
      updateWorkFavoriteFolder(work.id, data.favorite);
      if (state.library) state.library.user = data.user;

      if (state.currentWork?.id === work.id) {
        state.currentWork.favoriteFolderId = data.favorite.folderId;
        state.currentWork.favoriteFolderName = data.favorite.folderName;
      }
      let removedWorkIds = [];
      if (state.activeView === "favorites" && state.selectedFavoriteFolderId !== "all" && data.favorite.folderId !== state.selectedFavoriteFolderId) {
        removedWorkIds = [...new Set(state.works.filter((item) => item.id === work.id).map((item) => String(item.id)))];
        state.works = state.works.filter((item) => item.id !== work.id);
      }
      onCollectionStateChanged({ removedWorkIds });
      favoriteFolderWrites.delete(String(work.id));
      if (ui?.settle({ error: null, removedWorkIds, favoriteFolderId: data.favorite.folderId }) !== true) {
        renderStatsForWorks(state.works);
        renderFavoriteFolderControls();
        renderWorks("还没有收藏。");
      }
      return data;
    } catch (error) {
      control.value = previous;
      favoriteFolderWrites.delete(String(work.id));
      if (ui?.settle({ error }) !== true) showError(error.message);
      return null;
    } finally {
      favoriteFolderWrites.delete(String(work.id));
      control.disabled = false;
      ui?.finish();
    }
  }

  function updateWorkFavorite(workId, favorite, favoriteFolder = null) {
    for (const work of state.works) {
      if (work.id !== workId) continue;
      work.favorite = favorite;
      if (favorite && favoriteFolder) {
        work.favoriteFolderId = favoriteFolder.folderId;
        work.favoriteFolderName = favoriteFolder.folderName;
      }
      if (!favorite) {
        work.favoriteFolderId = "";
        work.favoriteFolderName = "";
      }
    }
  }

  function updateCurrentWorkFavorite(workId, favorite, favoriteFolder = null) {
    if (state.currentWork?.id !== workId) return;
    state.currentWork.favorite = favorite;
    if (favorite && favoriteFolder) {
      state.currentWork.favoriteFolderId = favoriteFolder.folderId;
      state.currentWork.favoriteFolderName = favoriteFolder.folderName;
    }
    if (!favorite) {
      state.currentWork.favoriteFolderId = "";
      state.currentWork.favoriteFolderName = "";
    }
  }

  function updateWorkFavoriteFolder(workId, favoriteFolder) {
    for (const work of state.works) {
      if (work.id !== workId) continue;
      work.favoriteFolderId = favoriteFolder.folderId;
      work.favoriteFolderName = favoriteFolder.folderName;
    }
  }

  function updateWorkSnapshot(nextWork) {
    const index = state.works.findIndex((work) => work.id === nextWork.id);
    if (index >= 0) state.works[index] = { ...state.works[index], ...nextWork };
  }

  function captureFavoriteSnapshot(workId) {
    return {
      currentWork: state.currentWork?.id === workId
        ? { id: workId, ...pickFavoriteState(state.currentWork) }
        : null,
      works: state.works
        .filter((work) => work.id === workId)
        .map((work) => ({ work, ...pickFavoriteState(work) }))
    };
  }

  function restoreFavoriteSnapshot(snapshot) {
    for (const item of snapshot.works) Object.assign(item.work, pickFavoriteState(item));
    if (snapshot.currentWork && state.currentWork?.id === snapshot.currentWork.id) {
      Object.assign(state.currentWork, pickFavoriteState(snapshot.currentWork));
    }
  }

  return { isFavoriteFolderPending, isFavoritePending, moveFavoriteToFolder, toggleFavorite, updateWorkSnapshot };
}

function pickFavoriteState(work) {
  return {
    favorite: Boolean(work?.favorite),
    favoriteFolderId: work?.favoriteFolderId || "",
    favoriteFolderName: work?.favoriteFolderName || ""
  };
}

function syncFavoriteControl(control, favorite, pending) {
  const label = favorite ? "取消收藏" : "收藏";
  control.disabled = pending;
  control.classList?.toggle("active", favorite);
  control.classList?.toggle("pending", pending);
  control.title = label;
  control.setAttribute?.("aria-label", pending ? `${label}中` : label);
}
