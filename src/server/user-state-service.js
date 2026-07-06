import fs from "node:fs";

export function createUserStateService({
  defaultFavoriteFolderId = "default",
  defaultFavoriteFolderName = "默认收藏",
  ensureDataDir,
  statePath,
  warn = console.warn
}) {
  const state = emptyState();

  function emptyState() {
    return {
      version: 2,
      favoriteFolders: {
        [defaultFavoriteFolderId]: {
          name: defaultFavoriteFolderName,
          createdAt: ""
        }
      },
      favorites: {},
      manualCovers: {},
      progress: {}
    };
  }

  function replaceState(nextState) {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, nextState);
    return state;
  }

  function cleanFavoriteFolderName(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 32);
  }

  function defaultFavoriteFolders() {
    return {
      [defaultFavoriteFolderId]: {
        name: defaultFavoriteFolderName,
        createdAt: ""
      }
    };
  }

  function normalizeFavoriteFolders(value) {
    const folders = defaultFavoriteFolders();
    if (!value || typeof value !== "object") return folders;

    for (const [rawId, rawFolder] of Object.entries(value)) {
      const id = String(rawId || "").trim();
      if (!id || id.length > 96) continue;
      const folder = rawFolder && typeof rawFolder === "object" ? rawFolder : {};
      const name = cleanFavoriteFolderName(folder.name) || (id === defaultFavoriteFolderId ? defaultFavoriteFolderName : "");
      if (!name) continue;
      folders[id] = {
        name,
        createdAt: String(folder.createdAt || "")
      };
    }

    folders[defaultFavoriteFolderId].name = folders[defaultFavoriteFolderId].name || defaultFavoriteFolderName;
    return folders;
  }

  function normalizeFavoriteFolderId(value, folders = state.favoriteFolders) {
    const id = String(value || "").trim();
    return id && folders?.[id] ? id : defaultFavoriteFolderId;
  }

  function normalizeFavoriteRecord(value, folders = state.favoriteFolders) {
    const record = value && typeof value === "object" ? value : {};
    return {
      createdAt: String(record.createdAt || ""),
      folderId: normalizeFavoriteFolderId(record.folderId, folders)
    };
  }

  function normalizeFavorites(value, folders = state.favoriteFolders) {
    const favorites = {};
    if (!value || typeof value !== "object") return favorites;
    for (const [workId, favorite] of Object.entries(value)) {
      if (!workId) continue;
      favorites[workId] = normalizeFavoriteRecord(favorite, folders);
    }
    return favorites;
  }

  function normalizeManualCoverRecord(value) {
    const record = value && typeof value === "object" ? value : { imageId: value };
    const imageId = String(record.imageId || "").trim();
    if (!imageId || imageId.length > 1024) return null;
    return {
      imageId,
      updatedAt: String(record.updatedAt || "")
    };
  }

  function normalizeManualCovers(value) {
    const covers = {};
    if (!value || typeof value !== "object") return covers;
    for (const [workId, cover] of Object.entries(value)) {
      const id = String(workId || "").trim();
      const record = normalizeManualCoverRecord(cover);
      if (!id || !record) continue;
      covers[id] = record;
    }
    return covers;
  }

  function load() {
    try {
      if (!fs.existsSync(statePath)) {
        replaceState(emptyState());
        return state;
      }

      const data = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const favoriteFolders = normalizeFavoriteFolders(data.favoriteFolders);
      replaceState({
        version: 2,
        favoriteFolders,
        favorites: normalizeFavorites(data.favorites, favoriteFolders),
        manualCovers: normalizeManualCovers(data.manualCovers),
        progress: data.progress && typeof data.progress === "object" ? data.progress : {}
      });
    } catch (error) {
      warn("[state]", error.message);
      replaceState(emptyState());
    }
    return state;
  }

  function save() {
    try {
      ensureDataDir();
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
    } catch (error) {
      warn("[state]", error.message);
    }
    return state;
  }

  return {
    cleanFavoriteFolderName,
    defaultFavoriteFolderId,
    defaultFavoriteFolderName,
    defaultFavoriteFolders,
    emptyState,
    load,
    normalizeFavoriteFolderId,
    normalizeFavoriteFolders,
    normalizeFavoriteRecord,
    normalizeFavorites,
    normalizeManualCoverRecord,
    normalizeManualCovers,
    save,
    state
  };
}
