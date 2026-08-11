import { fetchJson } from "../../../../js/api.js?v=20260811-favorite-folders-01";
import { clearCachedJsonByPrefix } from "../../../../js/cache.js?v=20260811-favorite-folders-01";

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

  function ensureScope(baseUrl = context.getActiveUrl()) {
    const normalized = String(baseUrl || "").replace(/\/+$/u, "");
    if (normalized === activeBaseUrl) return normalized;
    activeBaseUrl = normalized;
    folders = [];
    listRequest = null;
    mutationRevision = 0;
    return normalized;
  }

  function rememberFolders(nextFolders) {
    ensureScope();
    if (!Array.isArray(nextFolders)) return folders;
    folders = nextFolders.map((folder) => ({
      ...folder,
      count: Math.max(0, Number(folder?.count || 0)),
      id: String(folder?.id || ""),
      name: String(folder?.name || "收藏夹")
    })).filter((folder) => folder.id);
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

  async function loadFolders(force = false) {
    const requestBaseUrl = ensureScope();
    if (folders.length && !force) return folders;
    if (listRequest) return listRequest;
    const requestRevision = mutationRevision;
    const activeRequest = request("/api/favorite-folders").then((data) => {
      if (activeBaseUrl !== requestBaseUrl || mutationRevision !== requestRevision) return folders;
      return rememberFolders(data?.folders);
    });
    listRequest = activeRequest;
    try {
      return await activeRequest;
    } finally {
      if (listRequest === activeRequest) listRequest = null;
    }
  }

  async function createFolder(name) {
    const cleanName = String(name || "").replace(/\s+/gu, " ").trim().slice(0, 32);
    if (!cleanName) throw new Error("请输入收藏夹名称");
    const data = await request("/api/favorite-folders", { method: "POST", body: { name: cleanName } });
    mutationRevision += 1;
    rememberFolders(data?.folders);
    if (data?.user) context.onUserStateChange?.(data.user);
    await invalidateCollections();
    return data?.folder;
  }

  async function toggleFavorite(work, onOptimisticChange = () => {}) {
    const snapshot = favoriteSnapshot(work);
    work.favorite = !snapshot.favorite;
    if (!work.favorite) applyFavoriteFolder(work, null);
    onOptimisticChange(work);
    try {
      const data = await request(`/api/favorites/${encodeURIComponent(work.id)}`, { method: "POST", body: {} });
      mutationRevision += 1;
      applyFavoritePayload(work, data);
      rememberFolders(data?.folders);
      if (data?.user) context.onUserStateChange?.(data.user);
      syncLibraryWork(work);
      await invalidateWork(work.id);
      return data;
    } catch (error) {
      restoreFavoriteSnapshot(work, snapshot);
      syncLibraryWork(work);
      onOptimisticChange(work);
      throw error;
    }
  }

  async function moveFavorite(work, folderId, onOptimisticChange = () => {}) {
    const snapshot = favoriteSnapshot(work);
    const target = folders.find((folder) => folder.id === String(folderId || ""));
    applyFavoriteFolder(work, target ? { folderId: target.id, folderName: target.name } : null);
    onOptimisticChange(work);
    try {
      const data = await request(`/api/favorites/${encodeURIComponent(work.id)}/folder`, {
        method: "PUT",
        body: { folderId }
      });
      mutationRevision += 1;
      applyFavoritePayload(work, { favorite: true, favoriteFolder: data?.favorite });
      rememberFolders(data?.folders);
      if (data?.user) context.onUserStateChange?.(data.user);
      syncLibraryWork(work);
      await invalidateWork(work.id);
      return data;
    } catch (error) {
      restoreFavoriteSnapshot(work, snapshot);
      syncLibraryWork(work);
      onOptimisticChange(work);
      throw error;
    }
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
    document.querySelector(".favorite-folder-overlay")?.remove();
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
      overlay.remove();
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    };
    const setPending = (pending) => {
      input.disabled = pending;
      submit.disabled = pending;
      for (const button of list.querySelectorAll("button")) button.disabled = pending;
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
        status.textContent = "已移动";
        close();
      } catch (error) {
        status.textContent = error?.message || "移动收藏失败";
        setPending(false);
        focusTarget?.focus();
      }
    };

    closeButton.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      trapFocus(event, panel);
    });
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
        if (options.work) {
          renderOptions();
          await performMove(folder.id);
          return;
        }
        options.onCreated?.(folder.id);
        close();
      } catch (error) {
        status.textContent = error?.message || "创建收藏夹失败";
        setPending(false);
        input.focus();
      }
    });
    document.body.append(overlay);
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

  function syncLibraryWork(work) {
    const libraryWork = context.getLibrary?.()?.works?.find((item) => item.id === work.id);
    if (libraryWork && libraryWork !== work) Object.assign(libraryWork, favoriteSnapshot(work));
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
  if (event.shiftKey && document.activeElement === first) {
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
