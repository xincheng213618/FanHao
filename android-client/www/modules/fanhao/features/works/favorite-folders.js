import { fetchJson } from "../../../../js/api.js?v=assets-07b744082137";
import { clearCachedJsonByPrefix } from "../../../../js/cache.js?v=assets-07b744082137";
import { accountChangedError, captureAccountOwner, isAccountOwnerCurrent } from "../../../../js/account-owner.js";

export const FAVORITE_FOLDER_RETRY_DELAYS_MS = Object.freeze([180]);
// An old operation may restore its own object after navigation, but must not
// restore that object once another account or operation has reused it.
const optimisticWorkOwners = new WeakMap();

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
  let activeAccountScope = null;
  let mutationRevision = 0;
  let pendingMutations = 0;
  let folderRefresh = null;
  let refreshRequestedRevision = 0;
  let refreshedRevision = 0;
  let failedRefreshRevision = -1;
  let activeSheetClose = null;
  let folderMutationTail = Promise.resolve();
  const deletedFolderIds = new Set();
  const folderNameOverrides = new Map();
  const trackedWorks = new Set();
  const workMutationTails = new Map();

  function ensureScope(baseUrl = context.getActiveUrl()) {
    const normalized = String(baseUrl || "").replace(/\/+$/u, "");
    if (normalized === activeBaseUrl && isAccountOwnerCurrent(activeAccountScope)) return normalized;
    activeSheetClose?.();
    activeAccountScope = captureAccountOwner(normalized);
    activeBaseUrl = normalized;
    folders = [];
    listRequest = null;
    mutationRevision = 0;
    pendingMutations = 0;
    folderRefresh = null;
    refreshRequestedRevision = 0;
    refreshedRevision = 0;
    failedRefreshRevision = -1;
    folderMutationTail = Promise.resolve();
    deletedFolderIds.clear();
    folderNameOverrides.clear();
    trackedWorks.clear();
    workMutationTails.clear();
    return normalized;
  }

  function rememberFolders(nextFolders, options = {}) {
    ensureScope();
    if (!Array.isArray(nextFolders)) return folders;
    const nextById = new Map();
    for (const folder of nextFolders) {
      if (deletedFolderIds.has(String(folder?.id || ""))) continue;
      const normalized = {
        ...folder,
        count: Math.max(0, Number(folder?.count || 0)),
        id: String(folder?.id || ""),
        name: folderNameOverrides.get(String(folder?.id || "")) || String(folder?.name || "收藏夹")
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
    const accountScope = options.accountScope || activeAccountScope;
    const data = await retryFavoriteFolderRequest(() => {
      if (!isAccountOwnerCurrent(accountScope)) throw accountChangedError();
      if (String(context.getActiveUrl() || "").replace(/\/+$/u, "") !== requestBaseUrl) throw new Error("服务器已切换，请重新操作");
      return api(requestBaseUrl, path, {
      timeoutMs: 12000,
      accountScope,
      ...options
      });
    });
    if (!isAccountOwnerCurrent(accountScope)) throw accountChangedError();
    const currentBaseUrl = String(context.getActiveUrl() || "").replace(/\/+$/u, "");
    if (currentBaseUrl !== requestBaseUrl) {
      ensureScope(currentBaseUrl);
      throw new Error("服务器已切换，请重新操作");
    }
    return data;
  }

  async function loadFolderState(force = false) {
    const requestBaseUrl = ensureScope();
    const requestAccountScope = activeAccountScope;
    const isRequestCurrent = () => requestBaseUrl === String(context.getActiveUrl() || "").replace(/\/+$/u, "")
      && requestAccountScope === activeAccountScope && isAccountOwnerCurrent(requestAccountScope);
    if (folders.length && !force) return { applied: true, folders, revision: mutationRevision };
    while (isRequestCurrent()) {
      if (force && pendingMutations) return { applied: false, folders, revision: mutationRevision };
      if (listRequest) {
        const activeRequest = listRequest;
        const result = await activeRequest.promise;
        if (!isRequestCurrent()) throw accountChangedError();
        if (!force || (result.applied && result.revision === mutationRevision)) return result;
        continue;
      }

      const requestRevision = mutationRevision;
      let activeRequest;
      const promise = request("/api/favorite-folders").then((data) => {
        const applied = isRequestCurrent() && mutationRevision === requestRevision;
        if (applied) { folderNameOverrides.clear(); rememberFolders(data?.folders); }
        return { applied, folders, revision: requestRevision };
      }).finally(() => {
        if (isRequestCurrent() && listRequest === activeRequest) listRequest = null;
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
    return enqueueFolderMutation(mutation, async () => {
      const data = await request("/api/favorite-folders", { method: "POST", body: { name: cleanName }, accountScope: mutation.accountScope });
      assertMutationCurrent(mutation);
      deletedFolderIds.delete(String(data.folder?.id || ""));
      folderNameOverrides.delete(String(data.folder?.id || ""));
      rememberFolders(data?.folders || [...folders, data.folder].filter(Boolean));
      await invalidateCollections(mutation);
      assertMutationCurrent(mutation);
      return data?.folder;
    });
  }

  function renameFolder(folderId, name) {
    const id = editableFolderId(folderId);
    const cleanName = String(name || "").replace(/\s+/gu, " ").trim().slice(0, 32);
    if (!cleanName) return Promise.reject(new Error("请输入收藏夹名称"));
    const mutation = beginMutation();
    return enqueueFolderMutation(mutation, async () => {
      const data = await request(`/api/favorite-folders/${encodeURIComponent(id)}`, { method: "PATCH", body: { name: cleanName }, accountScope: mutation.accountScope });
      assertMutationCurrent(mutation);
      folderNameOverrides.set(id, String(data.folder.name));
      rememberFolders(data.folders);
      updateFolderWorks(id, data.folder);
      await invalidateFolderViews(mutation);
      assertMutationCurrent(mutation);
      return data;
    });
  }

  function deleteFolder(folderId) {
    const id = editableFolderId(folderId);
    const mutation = beginMutation();
    return enqueueFolderMutation(mutation, async () => {
      const data = await request(`/api/favorite-folders/${encodeURIComponent(id)}`, { method: "DELETE", accountScope: mutation.accountScope });
      assertMutationCurrent(mutation);
      deletedFolderIds.add(id);
      folderNameOverrides.delete(id);
      rememberFolders(data.folders);
      updateFolderWorks(id, data.defaultFolder);
      await invalidateFolderViews(mutation);
      assertMutationCurrent(mutation);
      return data;
    });
  }

  function editableFolderId(value) {
    const id = String(value || "");
    if (!id || id === "default") throw new Error("默认收藏夹不能改名或删除");
    return id;
  }

  function rememberWorks(works = []) {
    ensureScope();
    for (const work of works) {
      if (!work || typeof work !== "object") continue;
      const owner = optimisticWorkOwners.get(work);
      if (owner && (owner.scope !== activeBaseUrl || !isAccountOwnerCurrent(owner.accountScope))) optimisticWorkOwners.delete(work);
      trackedWorks.add(work);
    }
    while (trackedWorks.size > 1200) trackedWorks.delete(trackedWorks.values().next().value);
  }

  function updateFolderWorks(folderId, target) {
    for (const work of new Set([...trackedWorks, ...(context.getLibrary?.()?.works || [])])) {
      if (work.favorite && work.favoriteFolderId === folderId) {
        optimisticWorkOwners.delete(work);
        applyFavoriteFolder(work, { folderId: target.id, folderName: target.name });
      }
    }
  }

  async function toggleFavorite(work, onOptimisticChange = () => {}) {
    const mutation = beginMutation(work.id);
    rememberWorks([work]);
    return enqueueWorkMutation(mutation, async () => {
      const snapshot = favoriteSnapshot(work);
      optimisticWorkOwners.set(work, mutation);
      work.favorite = !snapshot.favorite;
      if (!work.favorite) applyFavoriteFolder(work, null);
      notifyWorkChange(mutation, work, onOptimisticChange);
      try {
        const data = await request(`/api/favorites/${encodeURIComponent(work.id)}`, { method: "POST", body: {}, accountScope: mutation.accountScope });
        assertMutationCurrent(mutation);
        applyFavoritePayload(work, data);
        syncLibraryWork(mutation, work);
        rememberFolders(data?.folders, { merge: true });
        await invalidateWork(work, mutation);
        assertWorkResultCurrent(mutation, work);
        return data;
      } catch (error) {
        if (optimisticWorkOwners.get(work) === mutation) restoreFavoriteSnapshot(work, snapshot);
        syncLibraryWork(mutation, work);
        notifyWorkChange(mutation, work, onOptimisticChange);
        throw error;
      } finally {
        if (optimisticWorkOwners.get(work) === mutation) optimisticWorkOwners.delete(work);
      }
    });
  }

  async function moveFavorite(work, folderId, onOptimisticChange = () => {}) {
    const mutation = beginMutation(work.id);
    rememberWorks([work]);
    return enqueueWorkMutation(mutation, async () => {
      const snapshot = favoriteSnapshot(work);
      optimisticWorkOwners.set(work, mutation);
      const target = folders.find((folder) => folder.id === String(folderId || ""));
      applyFavoriteFolder(work, target ? { folderId: target.id, folderName: target.name } : null);
      notifyWorkChange(mutation, work, onOptimisticChange);
      try {
        const data = await request(`/api/favorites/${encodeURIComponent(work.id)}/folder`, {
          method: "PUT",
          accountScope: mutation.accountScope,
          body: { folderId }
        });
        assertMutationCurrent(mutation);
        applyFavoritePayload(work, { favorite: true, favoriteFolder: data?.favorite });
        syncLibraryWork(mutation, work);
        rememberFolders(data?.folders, { merge: true });
        await invalidateWork(work, mutation);
        assertWorkResultCurrent(mutation, work);
        return data;
      } catch (error) {
        if (optimisticWorkOwners.get(work) === mutation) restoreFavoriteSnapshot(work, snapshot);
        syncLibraryWork(mutation, work);
        notifyWorkChange(mutation, work, onOptimisticChange);
        throw error;
      } finally {
        if (optimisticWorkOwners.get(work) === mutation) optimisticWorkOwners.delete(work);
      }
    });
  }

  function beginMutation(workId = "") {
    ensureScope();
    mutationRevision += 1;
    pendingMutations += 1;
    const mutation = { revision: mutationRevision, scope: activeBaseUrl, accountScope: activeAccountScope, workId: String(workId || "") };
    return mutation;
  }

  function enqueueWorkMutation(mutation, operation) {
    const key = `${mutation.scope}\n${mutation.workId}`;
    const previous = workMutationTails.get(key) || Promise.resolve();
    const barrier = folderMutationTail;
    const result = Promise.all([previous, barrier]).then(() => {
      if (String(context.getActiveUrl() || "").replace(/\/+$/u, "") !== mutation.scope) throw new Error("服务器已切换，请重新操作");
      if (!isMutationInActiveScope(mutation)) throw accountChangedError();
      return operation();
    }).finally(() => finishMutation(mutation));
    let tail;
    tail = result.catch(() => {}).finally(() => {
      if (workMutationTails.get(key) === tail) workMutationTails.delete(key);
    });
    workMutationTails.set(key, tail);
    return result;
  }

  function enqueueFolderMutation(mutation, operation) {
    // A structural edit follows existing work moves; subsequent work edits wait
    // for it, so their full folder snapshots cannot resurrect a deleted folder.
    const barriers = [folderMutationTail, ...workMutationTails.values()];
    context.pageDataService?.invalidate(mutation.scope, "/api/favorites");
    const result = Promise.all(barriers).then(() => {
      assertMutationCurrent(mutation);
      return operation();
    }).finally(() => finishMutation(mutation));
    folderMutationTail = result.catch(() => {});
    return result;
  }

  function assertMutationCurrent(mutation) {
    if (!isMutationInActiveScope(mutation)) throw accountChangedError();
  }

  function assertWorkResultCurrent(mutation, work) {
    // Once the response is accepted, cache cleanup belongs to its original
    // server even if navigation changes. Account changes and object reuse
    // still revoke that result before it can be returned to cache writers.
    if (!isAccountOwnerCurrent(mutation.accountScope) || optimisticWorkOwners.get(work) !== mutation) throw accountChangedError();
  }

  function finishMutation(mutation) {
    if (!isMutationInActiveScope(mutation)) return;
    pendingMutations = Math.max(0, pendingMutations - 1);
    refreshRequestedRevision = Math.max(refreshRequestedRevision, mutation.revision);
    scheduleFolderRefresh();
  }

  function scheduleFolderRefresh() {
    if (pendingMutations || folderRefresh) return;
    if (refreshRequestedRevision <= refreshedRevision || refreshRequestedRevision <= failedRefreshRevision) return;
    const refreshScope = activeBaseUrl;
    const refreshAccountScope = activeAccountScope;
    const requestedRevision = refreshRequestedRevision;
    let refresh;
    const isRefreshCurrent = () => folderRefresh === refresh && refreshAccountScope === activeAccountScope
      && isAccountOwnerCurrent(refreshAccountScope)
      && refreshScope === String(context.getActiveUrl() || "").replace(/\/+$/u, "");
    refresh = loadFolderState(true).then((result) => {
      if (!isRefreshCurrent() || !result.applied) return;
      refreshedRevision = Math.max(refreshedRevision, result.revision);
      failedRefreshRevision = -1;
    }).catch(() => {
      if (isRefreshCurrent()) failedRefreshRevision = Math.max(failedRefreshRevision, requestedRevision);
    }).finally(() => {
      if (!isRefreshCurrent()) return;
      folderRefresh = null;
      scheduleFolderRefresh();
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
    const manage = document.createElement("button");
    manage.type = "button";
    manage.textContent = "管理";
    manage.setAttribute("aria-label", "管理收藏夹");
    manage.addEventListener("click", () => openFolderSheet({ title: "管理收藏夹", manage: true, trigger: manage,
      selectedFolderId: selected, onChanged: handlers.onChanged }));
    strip.append(manage);
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
    ensureScope();
    activeSheetClose?.();
    const sheetScope = activeAccountScope;
    const sheetBase = activeBaseUrl;
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
    input.setAttribute("aria-label", options.manage ? "收藏夹新名称" : "收藏夹名称");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = options.manage ? "保存名称" : options.work ? "新建并移动" : "新建";
    form.append(input, submit);
    panel.append(header, status, list, form);
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "favorite-folder-delete";
    deleteButton.textContent = "删除收藏夹";
    const confirmation = document.createElement("div");
    confirmation.className = "favorite-folder-delete-confirm";
    confirmation.hidden = true;
    const confirmationText = document.createElement("p");
    const confirmDelete = document.createElement("button");
    confirmDelete.type = "button";
    confirmDelete.className = "favorite-folder-delete";
    confirmDelete.textContent = "确认删除并移回默认";
    const cancelDelete = document.createElement("button");
    cancelDelete.type = "button";
    cancelDelete.textContent = "取消";
    confirmation.append(confirmationText, confirmDelete, cancelDelete);
    if (options.manage) panel.append(deleteButton, confirmation);
    overlay.append(backdrop, panel);

    let closed = false;
    let pending = false;
    let selectedId = String(options.selectedFolderId || "");
    const selectedFolder = () => folders.find(folder => folder.id === selectedId && folder.id !== "default");
    const isSheetCurrent = () => !closed && isAccountOwnerCurrent(sheetScope) && String(context.getActiveUrl() || "").replace(/\/+$/u, "") === sheetBase;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", handleDocumentKeydown, true);
      overlay.remove();
      if (activeSheetClose === close) activeSheetClose = null;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
    const setPending = (value) => {
      pending = value;
      const moveFocus = pending && panel.contains(document.activeElement) && document.activeElement !== closeButton;
      input.disabled = pending;
      submit.disabled = pending;
      deleteButton.disabled = pending;
      confirmDelete.disabled = pending;
      cancelDelete.disabled = pending;
      for (const button of list.querySelectorAll("button")) button.disabled = pending || button.dataset.unavailable === "true";
      panel.setAttribute("aria-busy", pending ? "true" : "false");
      if (moveFocus || (pending && !panel.contains(document.activeElement))) closeButton.focus({ preventScroll: true });
    };
    const editFolder = folder => {
      if (!isSheetCurrent() || pending || folder.id === "default") return;
      selectedId = folder.id;
      input.value = folder.name;
      confirmation.hidden = true;
      form.hidden = false;
      deleteButton.hidden = false;
      status.textContent = `正在管理“${folder.name}”`;
      renderOptions();
      input.focus();
    };
    const renderOptions = () => {
      list.innerHTML = "";
      for (const folder of folders) {
        const button = document.createElement("button");
        button.type = "button";
        button.classList.toggle("active", (options.manage ? selectedId : options.work?.favoriteFolderId) === folder.id);
        const unavailable = options.manage ? folder.id === "default" : !options.work;
        button.dataset.unavailable = String(unavailable);
        button.disabled = pending || unavailable;
        const name = document.createElement("span");
        name.textContent = folder.name;
        const count = document.createElement("small");
        count.textContent = `${folder.count} 个作品${options.manage && folder.id === "default" ? " · 不可改名或删除" : ""}`;
        button.append(name, count);
        if (options.work) button.addEventListener("click", () => performMove(folder.id, button));
        if (options.manage) button.addEventListener("click", () => editFolder(folder));
        list.append(button);
      }
    };
    const performMove = async (folderId, focusTarget = null) => {
      if (!isSheetCurrent()) { close(); return; }
      setPending(true);
      status.textContent = "正在移动";
      try {
        await moveFavorite(options.work, folderId, options.onMoved);
        if (!isSheetCurrent()) { close(); return; }
        status.textContent = "已移动";
        close();
      } catch (error) {
        if (!isSheetCurrent()) { close(); return; }
        status.textContent = error?.message || "移动收藏失败";
        setPending(false);
        focusTarget?.focus();
      }
    };

    deleteButton.addEventListener("click", () => {
      if (!isSheetCurrent() || pending) return;
      const folder = selectedFolder();
      if (!folder) return;
      confirmationText.textContent = `删除“${folder.name}”？其中 ${folder.count} 个收藏会移回默认收藏，不会取消收藏。`;
      confirmation.hidden = false;
      confirmDelete.focus();
    });
    cancelDelete.addEventListener("click", () => {
      if (pending) return;
      confirmation.hidden = true;
      deleteButton.focus();
    });
    confirmDelete.addEventListener("click", async () => {
      if (!isSheetCurrent() || pending || confirmation.hidden) return;
      const folder = selectedFolder();
      if (!folder) return;
      setPending(true);
      status.textContent = "正在删除收藏夹";
      try {
        const result = await deleteFolder(folder.id);
        if (!isSheetCurrent()) { close(); return; }
        close();
        options.onChanged?.({ type: "deleted", folderId: folder.id, defaultFolderId: result.defaultFolder.id, movedCount: result.movedCount });
      } catch (error) {
        if (!isSheetCurrent()) { close(); return; }
        status.textContent = error?.message || "删除收藏夹失败";
        setPending(false);
      }
    });

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
      if (!isSheetCurrent() || pending) return;
      status.textContent = "";
      const name = input.value.trim();
      if (!name) {
        status.textContent = "请输入收藏夹名称";
        input.focus();
        return;
      }
      setPending(true);
      try {
        if (options.manage) {
          const folder = selectedFolder();
          if (!folder) throw new Error("请选择要管理的自建收藏夹");
          await renameFolder(folder.id, name);
          if (!isSheetCurrent()) { close(); return; }
          close();
          options.onChanged?.({ type: "renamed", folderId: folder.id });
          return;
        }
        const folder = await createFolder(name);
        if (!isSheetCurrent()) { close(); return; }
        if (options.work) {
          renderOptions();
          await performMove(folder.id);
          return;
        }
        options.onCreated?.(folder.id);
        close();
      } catch (error) {
        if (!isSheetCurrent()) { close(); return; }
        status.textContent = error?.message || "创建收藏夹失败";
        setPending(false);
        input.focus();
      }
    });
    document.addEventListener("keydown", handleDocumentKeydown, true);
    document.body.append(overlay);
    activeSheetClose = close;
    if (options.manage) { form.hidden = true; deleteButton.hidden = true; closeButton.focus(); }
    else input.focus({ preventScroll: true });
    status.textContent = "正在读取收藏夹";
    loadFolders(options.manage === true).then(() => {
      if (!isSheetCurrent()) { close(); return; }
      status.textContent = options.manage ? "选择自建收藏夹进行改名或删除，默认收藏夹会一直保留。" : "";
      renderOptions();
      if (options.manage) { const folder = selectedFolder(); if (folder) editFolder(folder); }
      else input.focus();
    }).catch((error) => {
      if (!isSheetCurrent()) { close(); return; }
      status.textContent = error?.message || "收藏夹读取失败";
      input.focus();
    });
    return { close, overlay, panel };
  }

  async function invalidateCollections(mutation) {
    await invalidatePrefixes(mutation, ["/api/favorites"]);
  }

  async function invalidateWork(work, mutation) {
    await invalidatePrefixes(mutation, ["/api/favorites", "/api/works", `/api/works/${encodeURIComponent(work.id)}`], () => assertWorkResultCurrent(mutation, work));
  }

  async function invalidateFolderViews(mutation) {
    await invalidatePrefixes(mutation, ["/api/favorite-folders", "/api/favorites", "/api/works", "/api/history", "/api/library", "/api/search", "/api/fanhao/search", "/api/people", "/api/studios", "/api/code-prefixes", "/api/rankings"]);
  }

  async function invalidatePrefixes(mutation, prefixes, assertCurrent = () => assertMutationCurrent(mutation)) {
    assertCurrent();
    for (const prefix of prefixes) context.pageDataService?.invalidate(mutation.scope, prefix);
    for (const prefix of prefixes) {
      assertCurrent();
      await clearCache(mutation.scope, prefix, { accountScope: mutation.accountScope }).catch(() => {});
    }
    assertCurrent();
  }

  function notifyWorkChange(mutation, work, onOptimisticChange) {
    if (isMutationInActiveScope(mutation)) onOptimisticChange(work);
  }

  function syncLibraryWork(mutation, work) {
    if (!isMutationInActiveScope(mutation)) return;
    const libraryWork = context.getLibrary?.()?.works?.find((item) => item.id === work.id);
    if (libraryWork && libraryWork !== work) {
      optimisticWorkOwners.delete(libraryWork);
      Object.assign(libraryWork, favoriteSnapshot(work));
    }
  }

  function isMutationInActiveScope(mutation) {
    return mutation.scope === ensureScope() && isAccountOwnerCurrent(mutation.accountScope);
  }

  function syncFavoriteCount() {
    const favoriteCount = folders.reduce((sum, folder) => sum + Math.max(0, Number(folder.count || 0)), 0);
    context.onUserStateChange?.({ favoriteCount });
  }

  return {
    reset: () => { activeAccountScope = null; ensureScope(); },
    createFolder,
    renameFolder,
    deleteFolder,
    createFolderStrip,
    folders: () => folders.map((folder) => ({ ...folder })),
    loadFolders,
    moveFavorite,
    openMovePicker,
    rememberFolders,
    rememberWorks,
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
