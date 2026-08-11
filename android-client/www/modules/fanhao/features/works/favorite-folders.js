import { fetchJson } from "../../../../js/api.js?v=20260811-favorite-folders-02";
import { clearCachedJsonByPrefix } from "../../../../js/cache.js?v=20260811-favorite-folders-02";

export const FAVORITE_FOLDER_RETRY_DELAYS_MS = Object.freeze([180]);

export function syncFavoriteButton(button, work) {
  const favorite = Boolean(work?.favorite);
  button.textContent = favorite ? "已收藏" : "收藏";
  button.title = favorite && work.favoriteFolderName ? `收藏于 ${work.favoriteFolderName}` : (favorite ? "取消收藏" : "收藏作品");
  button.setAttribute("aria-label", button.title);
  button.setAttribute("aria-pressed", favorite ? "true" : "false");
  button.classList.toggle("active", favorite);
}

export async function retryFavoriteFolderRequest(request, options = {}) {
  if (typeof request !== "function") throw new TypeError("favorite folder request must be a function");
  const delays = Array.isArray(options.delaysMs) ? options.delaysMs : FAVORITE_FOLDER_RETRY_DELAYS_MS;
  const sleep = typeof options.sleep === "function" ? options.sleep : wait;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request(attempt + 1);
    } catch (error) {
      if (Number(error?.status) !== 503 || error?.retryable !== true || attempt >= delays.length) throw error;
      await sleep(Math.max(0, Number(delays[attempt] || 0)));
    }
  }
}

export function createFavoriteFolderFeature(context = {}) {
  const api = context.api || fetchJson;
  const clearCache = context.clearCachedJsonByPrefix || clearCachedJsonByPrefix;
  let folders = [];
  let listRequest = null;
  let activeBaseUrl = "";
  let mutationRevision = 0;
  let pendingMutations = 0;
  let folderRefresh = null;
  let refreshRequestedRevision = 0;
  let refreshedRevision = 0;
  let failedRefreshRevision = -1;
  let activeSheetClose = null;
  const workMutationTails = new Map();

  function ensureScope(baseUrl = context.getActiveUrl()) {
    const normalized = String(baseUrl || "").replace(/\/+$/u, "");
    if (normalized === activeBaseUrl) return normalized;
    activeBaseUrl = normalized;
    folders = [];
    listRequest = null;
    mutationRevision = 0;
    pendingMutations = 0;
    folderRefresh = null;
    refreshRequestedRevision = 0;
    refreshedRevision = 0;
    failedRefreshRevision = -1;
    workMutationTails.clear();
    return normalized;
  }

  function rememberFolders(nextFolders, options = {}) {
    ensureScope();
    if (!Array.isArray(nextFolders)) return folders;
    const nextById = new Map();
    for (const folder of nextFolders) {
      const normalized = {
        ...folder,
        count: Math.max(0, Number(folder?.count || 0)),
        id: String(folder?.id || ""),
        name: String(folder?.name || "收藏夹")
      };
      if (normalized.id) nextById.set(normalized.id, normalized);
    }
    const next = [...nextById.values()];
    if (!options.merge) {
      folders = next;
      syncFavoriteCount();
      return folders;
    }
    const currentById = new Map(folders.map((folder) => [folder.id, folder]));
    const nextIds = new Set(next.map((folder) => folder.id));
    folders = [
      ...next.map((folder) => ({ ...currentById.get(folder.id), ...folder })),
      ...folders.filter((folder) => !nextIds.has(folder.id))
    ];
    return folders;
  }

  async function request(path, options = {}) {
    const requestBaseUrl = ensureScope();
    const data = await retryFavoriteFolderRequest(() => api(requestBaseUrl, path, {
      timeoutMs: 12000,
      ...options
    }));
    const currentBaseUrl = String(context.getActiveUrl() || "").replace(/\/+$/u, "");
    if (currentBaseUrl !== requestBaseUrl) {
      ensureScope(currentBaseUrl);
      throw new Error("服务器已切换，请重新操作");
    }
    return data;
  }

  async function loadFolderState(force = false) {
    const requestBaseUrl = ensureScope();
    if (folders.length && !force) return { applied: true, folders, revision: mutationRevision };
    while (activeBaseUrl === requestBaseUrl) {
      if (force && pendingMutations) return { applied: false, folders, revision: mutationRevision };
      if (listRequest) {
        const activeRequest = listRequest;
        const result = await activeRequest.promise;
        if (!force || (result.applied && result.revision === mutationRevision)) return result;
        continue;
      }

      const requestRevision = mutationRevision;
      let activeRequest;
      const promise = request("/api/favorite-folders").then((data) => {
        const applied = activeBaseUrl === requestBaseUrl && mutationRevision === requestRevision;
        if (applied) rememberFolders(data?.folders);
        return { applied, folders, revision: requestRevision };
      }).finally(() => {
        if (listRequest === activeRequest) listRequest = null;
      });
      activeRequest = { promise, revision: requestRevision, scope: requestBaseUrl };
      listRequest = activeRequest;
      const result = await promise;
      if (!force || result.applied) return result;
    }
    return { applied: false, folders, revision: mutationRevision };
  }

  async function loadFolders(force = false) {
    return (await loadFolderState(force)).folders;
  }

  async function createFolder(name) {
    const cleanName = String(name || "").replace(/\s+/gu, " ").trim().slice(0, 32);
    if (!cleanName) throw new Error("请输入收藏夹名称");
    const mutation = beginMutation();
    try {
      const data = await request("/api/favorite-folders", { method: "POST", body: { name: cleanName } });
      rememberFolders([...(data?.folders || []), ...(data?.folder ? [data.folder] : [])], { merge: true });
      await invalidateCollections();
      return data?.folder;
    } finally {
      finishMutation(mutation);
    }
  }

  async function toggleFavorite(work, onOptimisticChange = () => {}) {
    const mutation = beginMutation(work.id);
    return enqueueWorkMutation(mutation, async () => {
      const snapshot = favoriteSnapshot(work);
      work.favorite = !snapshot.favorite;
      if (!work.favorite) applyFavoriteFolder(work, null);
      notifyWorkChange(mutation, work, onOptimisticChange);
      try {
        const data = await request(`/api/favorites/${encodeURIComponent(work.id)}`, { method: "POST", body: {} });
        applyFavoritePayload(work, data);
        syncLibraryWork(mutation, work);
        rememberFolders(data?.folders, { merge: true });
        await invalidateWork(work.id);
        return data;
      } catch (error) {
        restoreFavoriteSnapshot(work, snapshot);
        syncLibraryWork(mutation, work);
        notifyWorkChange(mutation, work, onOptimisticChange);
        throw error;
      }
    });
  }

  async function moveFavorite(work, folderId, onOptimisticChange = () => {}) {
    const mutation = beginMutation(work.id);
    return enqueueWorkMutation(mutation, async () => {
      const snapshot = favoriteSnapshot(work);
      const target = folders.find((folder) => folder.id === String(folderId || ""));
      applyFavoriteFolder(work, target ? { folderId: target.id, folderName: target.name } : null);
      notifyWorkChange(mutation, work, onOptimisticChange);
      try {
        const data = await request(`/api/favorites/${encodeURIComponent(work.id)}/folder`, {
          method: "PUT",
          body: { folderId }
        });
        applyFavoritePayload(work, { favorite: true, favoriteFolder: data?.favorite });
        syncLibraryWork(mutation, work);
        rememberFolders(data?.folders, { merge: true });
        await invalidateWork(work.id);
        return data;
      } catch (error) {
        restoreFavoriteSnapshot(work, snapshot);
        syncLibraryWork(mutation, work);
        notifyWorkChange(mutation, work, onOptimisticChange);
        throw error;
      }
    });
  }

  function beginMutation(workId = "") {
    ensureScope();
    mutationRevision += 1;
    pendingMutations += 1;
    const mutation = { revision: mutationRevision, scope: activeBaseUrl, workId: String(workId || "") };
    return mutation;
  }

  function enqueueWorkMutation(mutation, operation) {
    const key = `${mutation.scope}\n${mutation.workId}`;
    const previous = workMutationTails.get(key) || Promise.resolve();
    const result = previous.then(() => {
      if (mutation.scope !== activeBaseUrl) throw new Error("服务器已切换，请重新操作");
      return operation();
    }).finally(() => finishMutation(mutation));
    let tail;
    tail = result.catch(() => {}).finally(() => {
      if (workMutationTails.get(key) === tail) workMutationTails.delete(key);
    });
    workMutationTails.set(key, tail);
    return result;
  }

  function finishMutation(mutation) {
    if (mutation.scope !== activeBaseUrl) return;
    pendingMutations = Math.max(0, pendingMutations - 1);
    refreshRequestedRevision = Math.max(refreshRequestedRevision, mutation.revision);
    scheduleFolderRefresh();
  }

  function scheduleFolderRefresh() {
    if (pendingMutations || folderRefresh) return;
    if (refreshRequestedRevision <= refreshedRevision || refreshRequestedRevision <= failedRefreshRevision) return;
    const refreshScope = activeBaseUrl;
    const requestedRevision = refreshRequestedRevision;
    let refresh;
    refresh = loadFolderState(true).then((result) => {
      if (refreshScope !== activeBaseUrl || !result.applied) return;
      refreshedRevision = Math.max(refreshedRevision, result.revision);
      failedRefreshRevision = -1;
    }).catch(() => {
      if (refreshScope === activeBaseUrl) failedRefreshRevision = Math.max(failedRefreshRevision, requestedRevision);
    }).finally(() => {
      if (folderRefresh === refresh) folderRefresh = null;
      if (refreshScope === activeBaseUrl) scheduleFolderRefresh();
    });
    folderRefresh = refresh;
  }

  function createFolderStrip(selectedFolderId = "all", handlers = {}) {
    ensureScope();
    const strip = document.createElement("nav");
    strip.className = "favorite-folder-strip";
    strip.setAttribute("aria-label", "收藏夹筛选");
    const selected = String(selectedFolderId || "all");
    const total = folders.reduce((sum, folder) => sum + folder.count, 0);
    for (const folder of [{ id: "all", name: "全部", count: total }, ...folders]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = folder.id === selected ? "active" : "";
      button.setAttribute("aria-pressed", folder.id === selected ? "true" : "false");
      button.setAttribute("aria-label", `${folder.name}，${folder.count} 个作品`);
      button.textContent = `${folder.name} ${folder.count}`;
      button.addEventListener("click", () => handlers.onSelect?.(folder.id));
      strip.append(button);
    }
    const create = document.createElement("button");
    create.type = "button";
    create.className = "favorite-folder-create";
    create.textContent = "＋ 新建";
    create.setAttribute("aria-label", "新建收藏夹");
    create.addEventListener("click", () => openFolderSheet({
      title: "新建收藏夹",
      trigger: create,
      onCreated: handlers.onSelect
    }));
    strip.append(create);
    return strip;
  }

  function openMovePicker(work, options = {}) {
    return openFolderSheet({
      title: "移动到收藏夹",
      trigger: options.trigger || document.activeElement,
      work,
      onMoved: options.onMoved
    });
  }

  function openFolderSheet(options = {}) {
    activeSheetClose?.();
    const trigger = options.trigger;
    const overlay = document.createElement("div");
    overlay.className = "favorite-folder-overlay";
    const backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "favorite-folder-backdrop";
    backdrop.setAttribute("aria-label", `关闭${options.title || "收藏夹"}`);
    const panel = document.createElement("section");
    panel.className = "favorite-folder-sheet";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", options.title || "收藏夹");
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = options.title || "收藏夹";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "关闭";
    header.append(title, closeButton);
    const status = document.createElement("div");
    status.className = "favorite-folder-status";
    status.setAttribute("aria-live", "polite");
    const list = document.createElement("div");
    list.className = "favorite-folder-options";
    list.setAttribute("aria-label", "可用收藏夹");
    const form = document.createElement("form");
    form.className = "favorite-folder-form";
    const input = document.createElement("input");
    input.maxLength = 32;
    input.placeholder = "收藏夹名称";
    input.setAttribute("aria-label", "收藏夹名称");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = options.work ? "新建并移动" : "新建";
    form.append(input, submit);
    panel.append(header, status, list, form);
    overlay.append(backdrop, panel);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", handleDocumentKeydown, true);
      overlay.remove();
      if (activeSheetClose === close) activeSheetClose = null;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
    const setPending = (pending) => {
      const moveFocus = pending && panel.contains(document.activeElement) && document.activeElement !== closeButton;
      input.disabled = pending;
      submit.disabled = pending;
      for (const button of list.querySelectorAll("button")) button.disabled = pending;
      panel.setAttribute("aria-busy", pending ? "true" : "false");
      if (moveFocus || (pending && !panel.contains(document.activeElement))) closeButton.focus({ preventScroll: true });
    };
    const renderOptions = () => {
      list.innerHTML = "";
      for (const folder of folders) {
        const button = document.createElement("button");
        button.type = "button";
        button.classList.toggle("active", options.work?.favoriteFolderId === folder.id);
        button.disabled = !options.work;
        const name = document.createElement("span");
        name.textContent = folder.name;
        const count = document.createElement("small");
        count.textContent = `${folder.count} 个作品`;
        button.append(name, count);
        if (options.work) button.addEventListener("click", () => performMove(folder.id, button));
        list.append(button);
      }
    };
    const performMove = async (folderId, focusTarget = null) => {
      setPending(true);
      status.textContent = "正在移动";
      try {
        await moveFavorite(options.work, folderId, options.onMoved);
        if (closed) return;
        status.textContent = "已移动";
        close();
      } catch (error) {
        if (closed) return;
        status.textContent = error?.message || "移动收藏失败";
        setPending(false);
        focusTarget?.focus();
      }
    };

    closeButton.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    const handleDocumentKeydown = (event) => {
      if (!overlay.isConnected) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      trapFocus(event, panel);
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      status.textContent = "";
      const name = input.value.trim();
      if (!name) {
        status.textContent = "请输入收藏夹名称";
        input.focus();
        return;
      }
      setPending(true);
      try {
        const folder = await createFolder(name);
        if (closed) return;
        if (options.work) {
          renderOptions();
          await performMove(folder.id);
          return;
        }
        options.onCreated?.(folder.id);
        close();
      } catch (error) {
        if (closed) return;
        status.textContent = error?.message || "创建收藏夹失败";
        setPending(false);
        input.focus();
      }
    });
    document.addEventListener("keydown", handleDocumentKeydown, true);
    document.body.append(overlay);
    activeSheetClose = close;
    input.focus({ preventScroll: true });
    status.textContent = "正在读取收藏夹";
    loadFolders().then(() => {
      if (!overlay.isConnected) return;
      status.textContent = "";
      renderOptions();
      input.focus();
    }).catch((error) => {
      if (!overlay.isConnected) return;
      status.textContent = error?.message || "收藏夹读取失败";
      input.focus();
    });
    return { close, overlay, panel };
  }

  async function invalidateCollections() {
    const activeUrl = context.getActiveUrl();
    context.pageDataService?.invalidate(activeUrl, "/api/favorites");
    await clearCache(activeUrl, "/api/favorites").catch(() => {});
  }

  async function invalidateWork(workId) {
    const activeUrl = context.getActiveUrl();
    for (const prefix of ["/api/favorites", "/api/works", `/api/works/${encodeURIComponent(workId)}`]) {
      context.pageDataService?.invalidate(activeUrl, prefix);
      await clearCache(activeUrl, prefix).catch(() => {});
    }
  }

  function notifyWorkChange(mutation, work, onOptimisticChange) {
    if (isMutationInActiveScope(mutation)) onOptimisticChange(work);
  }

  function syncLibraryWork(mutation, work) {
    if (!isMutationInActiveScope(mutation)) return;
    const libraryWork = context.getLibrary?.()?.works?.find((item) => item.id === work.id);
    if (libraryWork && libraryWork !== work) Object.assign(libraryWork, favoriteSnapshot(work));
  }

  function isMutationInActiveScope(mutation) {
    return mutation.scope === ensureScope();
  }

  function syncFavoriteCount() {
    const favoriteCount = folders.reduce((sum, folder) => sum + Math.max(0, Number(folder.count || 0)), 0);
    context.onUserStateChange?.({ favoriteCount });
  }

  return {
    createFolder,
    createFolderStrip,
    folders: () => folders.map((folder) => ({ ...folder })),
    loadFolders,
    moveFavorite,
    openMovePicker,
    rememberFolders,
    toggleFavorite
  };
}

function favoriteSnapshot(work = {}) {
  return {
    favorite: Boolean(work.favorite),
    favoriteFolderId: String(work.favoriteFolderId || ""),
    favoriteFolderName: String(work.favoriteFolderName || "")
  };
}

function restoreFavoriteSnapshot(work, snapshot) {
  Object.assign(work, snapshot);
}

function applyFavoritePayload(work, data = {}) {
  work.favorite = Boolean(data.favorite);
  applyFavoriteFolder(work, data.favoriteFolder);
}

function applyFavoriteFolder(work, favoriteFolder) {
  work.favoriteFolderId = String(favoriteFolder?.folderId || "");
  work.favoriteFolderName = String(favoriteFolder?.folderName || "");
}

function trapFocus(event, panel) {
  if (event.key !== "Tab") return;
  const focusable = [...panel.querySelectorAll("button:not([disabled]), input:not([disabled])")]
    .filter((element) => element.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!panel.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function wait(delayMs) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
}
