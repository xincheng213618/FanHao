import {
  captureCollectionFeedWindow,
  captureCollectionWindow,
  collectionFeedRouteSignature,
  restoreCollectionFeedWindow,
  restoreCollectionPosition,
  restoreCollectionWindow
} from "./collection-navigation.js?v=20261027-collection-lifecycle-01";
import { retryShortVideoCollectionRequest } from "./collection-request.js?v=20261027-detail-lifecycle-01";
import { runShortVideoRead } from "./read-request.js?v=20261027-detail-lifecycle-01";

const COLLECTION_PAGE_SIZE = 48;

export function createShortVideoCollectionsController(dependencies) {
  const {
    api,
    createIcon,
    ensureListCards,
    getListCards,
    interactionState,
    onNavigationChange,
    onScopeChange,
    onOpenVideo,
    loadFeed,
    pushRoute,
    replaceRoute,
    render,
    setMainHeader,
    showToast,
    state
  } = dependencies;
  let collectionsRequest = null;
  let collectionRequestId = 0;
  let collectionPageRequest = null;
  let collectionViewGeneration = 0;
  let collectionVideoRequestId = 0;
  let collectionsRevision = 0;
  const collectionRevisions = new Map();
  const deletedVideos = new Set();
  let collectionVideoEnteredWithinApp = false;
  let collectionVideoReturnWindow = null;
  let collectionPageEnteredWithinApp = false;
  let collectionFeedReturnWindow = null;
  let collectionsReadController = null;
  let collectionVideoRequest = null;
  const collectionApi = (path, options = {}) => options.method && options.method.toUpperCase() !== "GET"
    ? retryShortVideoCollectionRequest(() => api(path, options))
    : runShortVideoRead(signal => retryShortVideoCollectionRequest(() => api(path, { ...options, signal }), { signal }), { signal: options.signal });

  function cancelReads() {
    collectionRequestId += 1;
    collectionVideoRequestId += 1;
    collectionPageRequest?.controller.abort();
    collectionPageRequest = null;
    collectionVideoRequest?.controller.abort();
    collectionVideoRequest = null;
    collectionsReadController?.abort();
    collectionsReadController = null;
    collectionsRequest = null;
    state.shortVideo.collectionLoading = false;
    state.shortVideo.collectionsLoading = false;
  }

  function captureViewOwner({ video = false } = {}) {
    return { generation: collectionViewGeneration, activeView: state.activeView, mode: state.shortVideo.mode,
      collectionId: String(state.shortVideo.collectionId || ""), scope: collectionFeedRouteSignature(state.shortVideo),
      videoId: video ? String(state.shortVideo.current?.id || "") : null };
  }

  function ownsView(owner) {
    return owner.generation === collectionViewGeneration && state.activeView === owner.activeView
      && (state.activeView == null || state.activeView === "shortVideos") && state.shortVideo.mode === owner.mode
      && String(state.shortVideo.collectionId || "") === owner.collectionId
      && collectionFeedRouteSignature(state.shortVideo) === owner.scope
      && (owner.videoId === null || String(state.shortVideo.current?.id || "") === owner.videoId);
  }

  function changeViewIntent() {
    cancelReads();
    collectionViewGeneration += 1;
    collectionVideoRequestId += 1;
    collectionRequestId += 1;
    collectionPageRequest = null;
    state.shortVideo.collectionLoading = false;
    onScopeChange?.();
  }

  function positionRestoreOptions() {
    const generation = collectionViewGeneration, activeView = state.activeView;
    return { isCurrent: () => generation === collectionViewGeneration && activeView === state.activeView
      && (state.activeView == null || state.activeView === "shortVideos") };
  }

  function collectionRevision(id) { return collectionRevisions.get(String(id)) || 0; }

  function invalidateCollection(id) {
    collectionRevisions.set(String(id), collectionRevision(id) + 1);
    collectionsRevision += 1;
  }

  function ensureState() {
    const shortVideo = state.shortVideo;
    shortVideo.collections = Array.isArray(shortVideo.collections) ? shortVideo.collections : [];
    shortVideo.collectionsLoaded = Boolean(shortVideo.collectionsLoaded);
    shortVideo.collectionsLoading = Boolean(shortVideo.collectionsLoading);
    shortVideo.collectionId = String(shortVideo.collectionId || "");
    shortVideo.collectionData = shortVideo.collectionData && typeof shortVideo.collectionData === "object"
      ? shortVideo.collectionData
      : null;
    shortVideo.collectionLoading = Boolean(shortVideo.collectionLoading);
    shortVideo.collectionError = String(shortVideo.collectionError || "");
  }

  async function loadCollections(options = {}) {
    ensureState();
    if (collectionsRequest && !options.force) return collectionsRequest;
    if (state.shortVideo.collectionsLoaded && !options.force) return state.shortVideo.collections;
    const revision = collectionsRevision;
    collectionsReadController?.abort();
    const controller = new AbortController();
    collectionsReadController = controller;
    state.shortVideo.collectionsLoading = true;
    const request = collectionApi("/api/short-videos/collections", { signal: controller.signal })
      .then((data) => {
        if (collectionsRequest !== request || collectionsRevision !== revision) return state.shortVideo.collections;
        state.shortVideo.collections = Array.isArray(data?.collections) ? data.collections : [];
        state.shortVideo.collectionsLoaded = true;
        return state.shortVideo.collections;
      })
      .catch((error) => {
        if (collectionsRequest !== request || collectionsRevision !== revision) return state.shortVideo.collections;
        throw error;
      })
      .finally(() => {
        if (collectionsRequest !== request) return;
        state.shortVideo.collectionsLoading = false;
        if (collectionsReadController === controller) collectionsReadController = null;
        collectionsRequest = null;
      });
    collectionsRequest = request;
    return request;
  }

  async function loadCollection(collectionId, options = {}) {
    ensureState();
    const id = String(collectionId || "").trim();
    if (!id) throw new Error("缺少清单 ID");
    const append = Boolean(options.append);
    if (append && (state.shortVideo.collectionId !== id || state.shortVideo.collectionData?.collection?.id !== id)) return null;
    if (append && collectionPageRequest && !collectionPageRequest.append && ownsView(collectionPageRequest.owner)) {
      const pending = collectionPageRequest;
      const loaded = await pending.promise;
      if (!loaded || !ownsView(pending.owner)) return null;
      return loadCollection(id, options);
    }
    if (append && !state.shortVideo.collectionData?.hasMore) return state.shortVideo.collectionData;
    const cursor = append ? String(state.shortVideo.collectionData?.nextCursor || "") : "";
    if (collectionPageRequest?.id === id && collectionPageRequest.append === append && collectionPageRequest.cursor === cursor
      && collectionPageRequest.revision === collectionRevision(id) && ownsView(collectionPageRequest.owner)) return collectionPageRequest.promise;
    const requestId = ++collectionRequestId;
    collectionPageRequest?.controller.abort();
    state.shortVideo.collectionId = id;
    state.shortVideo.collectionLoading = true;
    state.shortVideo.collectionError = "";
    const request = { id, append, cursor, requestId, revision: collectionRevision(id), owner: captureViewOwner(),
      previous: append ? state.shortVideo.collectionData : null, promise: null, controller: new AbortController() };
    const ownsRequest = () => requestId === collectionRequestId && ownsView(request.owner)
      && request.revision === collectionRevision(id)
      && (!append || state.shortVideo.collectionData === request.previous);
    collectionPageRequest = request;
    request.promise = (async () => {
    try {
      const params = new URLSearchParams({ limit: String(COLLECTION_PAGE_SIZE) });
      if (cursor) params.set("cursor", cursor);
      const data = await collectionApi(`/api/short-videos/collections/${encodeURIComponent(id)}/videos?${params}`, { signal: request.controller.signal });
      if (!ownsRequest()) return null;
      if (String(data.collection?.id || "") !== id) throw new Error("清单内容不匹配，请重试");
      const videos = mergeUniqueVideos(request.previous?.videos, data.videos).filter(video => !deletedVideos.has(String(video.id)));
      state.shortVideo.collectionData = { ...data, videos };
      state.shortVideo.data = {
        videos,
        total: Number(data.total ?? videos.length),
        hasMore: Boolean(data.hasMore),
        nextCursor: data.nextCursor || null
      };
      syncCollectionSummary(data.collection);
      return state.shortVideo.collectionData;
    } catch (error) {
      if (!ownsRequest()) return null;
      state.shortVideo.collectionError = error?.message || "清单读取失败";
      throw error;
    } finally {
      if (collectionPageRequest === request) {
        collectionPageRequest = null;
        if (requestId === collectionRequestId && ownsView(request.owner)) state.shortVideo.collectionLoading = false;
      }
    }
    })();
    return request.promise;
  }

  function renderSidebar() {
    ensureState();
    const sidebar = document.createElement("aside");
    sidebar.className = "short-video-collection-sidebar";
    sidebar.setAttribute("aria-label", "我的清单");
    const heading = document.createElement("div");
    heading.className = "short-video-collection-sidebar-heading";
    const title = document.createElement("strong");
    title.textContent = "我的清单";
    const create = document.createElement("button");
    create.type = "button";
    create.className = "short-video-collection-create";
    create.append(createIcon("plusBadge"), document.createTextNode("新建"));
    create.addEventListener("click", () => showPicker(null, { createOnly: true }));
    heading.append(title, create);
    sidebar.append(heading);

    if (!state.shortVideo.collectionsLoaded) {
      const status = document.createElement("span");
      status.className = "short-video-collection-sidebar-status";
      status.textContent = state.shortVideo.collectionsLoading ? "读取中…" : "正在读取清单…";
      sidebar.append(status);
      if (!state.shortVideo.collectionsLoading) {
        const owner = captureViewOwner({ video: true });
        loadCollections().then(() => { if (ownsView(owner) && sidebar.isConnected) render(); }).catch((error) => {
          if (!ownsView(owner) || !sidebar.isConnected) return;
          status.textContent = error?.message || "清单读取失败";
        });
      }
      return sidebar;
    }

    const list = document.createElement("div");
    list.className = "short-video-collection-sidebar-list";
    if (!state.shortVideo.collections.length) {
      const empty = document.createElement("span");
      empty.className = "short-video-collection-sidebar-status";
      empty.textContent = "还没有清单";
      list.append(empty);
    }
    for (const collection of state.shortVideo.collections) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-collection-sidebar-item";
      button.classList.toggle("active", state.shortVideo.mode === "collection" && state.shortVideo.collectionId === collection.id);
      if (state.shortVideo.mode === "collection" && state.shortVideo.collectionId === collection.id) {
        button.setAttribute("aria-current", "page");
      }
      button.dataset.collectionId = collection.id;
      const name = document.createElement("span");
      name.textContent = collection.name;
      const count = document.createElement("small");
      count.textContent = String(Math.max(0, Number(collection.itemCount || 0)));
      button.append(name, count);
      button.addEventListener("click", () => openCollection(collection.id).catch((error) => showToast(error?.message || "清单读取失败")));
      list.append(button);
    }
    sidebar.append(list);
    return sidebar;
  }

  async function showPicker(video = null, options = {}) {
    const owner = captureViewOwner({ video: true });
    const existing = document.querySelector(".short-video-collection-picker");
    if (existing?._closeCollectionPicker) existing._closeCollectionPicker();
    else existing?.remove();
    const returnFocus = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "short-video-collection-picker";
    const dialog = document.createElement("section");
    dialog.className = "short-video-collection-picker-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", video ? "加入清单" : "新建清单");
    dialog.tabIndex = -1;
    const closePicker = () => {
      if (!overlay.isConnected) return;
      overlay.remove();
      if (!ownsView(owner)) return;
      const fallback = document.querySelector(".short-video-rail-button.is-collection")
        || document.querySelector(".short-video-collection-create");
      (returnFocus?.isConnected ? returnFocus : fallback)?.focus?.({ preventScroll: true });
    };
    overlay._closeCollectionPicker = closePicker;
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closePicker();
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePicker();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")]
        .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    });
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = video ? "加入清单" : "我的清单";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "short-video-collection-picker-close";
    close.setAttribute("aria-label", "关闭");
    close.append(createIcon("close"));
    close.addEventListener("click", closePicker);
    header.append(title, close);

    const form = document.createElement("form");
    form.className = "short-video-collection-quick-create";
    const input = document.createElement("input");
    input.name = "collectionName";
    input.maxLength = 40;
    input.placeholder = "新清单名称";
    input.setAttribute("aria-label", "新清单名称");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = video ? "创建并加入" : "创建";
    form.append(input, submit);
    const status = document.createElement("div");
    status.className = "short-video-collection-picker-status";
    status.setAttribute("role", "status");
    const list = document.createElement("div");
    list.className = "short-video-collection-picker-list";
    if (!options.createOnly) dialog.append(header, form, status, list);
    else dialog.append(header, form, status);
    overlay.append(dialog);
    document.body.append(overlay);
    const ownsPicker = () => ownsView(owner) && overlay.isConnected;

    const busy = (enabled) => {
      input.disabled = enabled;
      submit.disabled = enabled;
      dialog.setAttribute("aria-busy", String(enabled));
    };
    const addToCollection = async (collection) => {
      if (!video?.id) return;
      const result = await collectionApi(`/api/short-videos/collections/${encodeURIComponent(collection.id)}/videos/${encodeURIComponent(video.id)}`, {
        method: "PUT"
      });
      invalidateCollection(collection.id);
      if (result.added) collection.itemCount = Math.max(0, Number(collection.itemCount || 0)) + 1;
      syncCollectionSummary(collection);
      if (ownsPicker()) showToast(result.added ? `已加入“${collection.name}”` : `已经在“${collection.name}”中`);
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!ownsPicker() || dialog.getAttribute("aria-busy") === "true") return;
      busy(true);
      status.textContent = "";
      try {
        const result = await collectionApi("/api/short-videos/collections", {
          method: "POST",
          body: { name: input.value }
        });
        const collection = result.collection;
        collectionsRevision += 1;
        syncCollectionSummary(collection);
        state.shortVideo.collectionsLoaded = true;
        if (video) await addToCollection(collection);
        if (!ownsPicker()) return;
        closePicker();
        render();
        if (!video) openCollection(collection.id).catch((error) => showToast(error?.message || "清单读取失败"));
      } catch (error) {
        if (!ownsPicker()) return;
        status.textContent = error?.message || "清单创建失败";
        busy(false);
        input.focus();
      }
    });

    if (video && !options.createOnly) {
      status.textContent = "正在读取清单…";
      try {
        const collections = await loadCollections();
        if (!ownsPicker()) return;
        status.textContent = collections.length ? "选择一个清单" : "先快速创建一个清单";
        for (const collection of collections) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "short-video-collection-picker-item";
          button.dataset.collectionId = collection.id;
          button.innerHTML = `<span></span><small></small>`;
          button.querySelector("span").textContent = collection.name;
          button.querySelector("small").textContent = `${Math.max(0, Number(collection.itemCount || 0))} 条`;
          button.addEventListener("click", async () => {
            if (!ownsPicker() || !button.isConnected) return;
            button.disabled = true;
            try {
              await addToCollection(collection);
              if (!ownsPicker()) return;
              closePicker();
              render();
            } catch (error) {
              if (!ownsPicker() || !button.isConnected) return;
              status.textContent = error?.message || "加入清单失败";
              button.disabled = false;
            }
          });
          list.append(button);
        }
      } catch (error) {
        if (!ownsPicker()) return;
        status.textContent = error?.message || "清单读取失败";
      }
    }
    if (ownsPicker()) input.focus({ preventScroll: true });
  }

  function renderCollectionPage() {
    ensureState();
    const shell = document.createElement("section");
    shell.className = "short-video-home short-video-collection-page";
    const layout = document.createElement("div");
    layout.className = "short-video-home-layout";
    const main = document.createElement("section");
    main.className = "short-video-home-main";
    layout.append(renderSidebar(), main);
    shell.append(layout);

    const data = state.shortVideo.collectionData;
    const header = document.createElement("header");
    header.className = "short-video-collection-page-header";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "short-video-collection-back";
    back.textContent = "返回短视频";
    back.addEventListener("click", returnToFeed);
    const copy = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = data?.collection?.name || "我的清单";
    const meta = document.createElement("p");
    meta.textContent = `${Math.max(0, Number(data?.total || 0))} 条 · 按加入时间排列`;
    copy.append(title, meta);
    const actions = document.createElement("div");
    actions.className = "short-video-collection-page-actions";
    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "重命名";
    rename.disabled = !data?.collection?.id;
    rename.addEventListener("click", renameActiveCollection);
    const removeCollection = document.createElement("button");
    removeCollection.type = "button";
    removeCollection.className = "is-danger";
    removeCollection.textContent = "删除清单";
    removeCollection.disabled = !data?.collection?.id;
    removeCollection.addEventListener("click", deleteActiveCollection);
    actions.append(rename, removeCollection);
    header.append(back, copy, actions);
    main.append(header);

    if (state.shortVideo.collectionLoading && !data) {
      const status = document.createElement("div");
      status.className = "short-video-status";
      status.textContent = "正在读取清单…";
      main.append(status);
      return shell;
    }
    if (state.shortVideo.collectionError && !data) {
      const status = document.createElement("div");
      status.className = "short-video-status is-error";
      status.textContent = state.shortVideo.collectionError;
      main.append(status);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新加载";
      const owner = captureViewOwner({ video: true });
      retry.addEventListener("click", () => {
        if (!retry.isConnected || !ownsView(owner)) return;
        openCollection(owner.collectionId, { skipRoute: true }).catch(error => {
          if (ownsView(owner)) showToast(error?.message || "清单读取失败");
        });
      });
      main.append(retry);
      return shell;
    }

    if (!getListCards() && (data?.videos || []).length) {
      const status = document.createElement("div");
      status.className = "short-video-status";
      status.textContent = "正在准备清单内容…";
      main.append(status);
      const owner = captureViewOwner({ video: true });
      ensureListCards().then(() => { if (ownsView(owner) && shell.isConnected) render(); })
        .catch((error) => { if (ownsView(owner) && shell.isConnected) showToast(error?.message || "短视频列表模块加载失败"); });
      return shell;
    }
    const grid = document.createElement("div");
    grid.className = "short-video-grid short-video-collection-grid";
    const videos = Array.isArray(data?.videos) ? data.videos : [];
    if (!videos.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-empty";
      empty.textContent = "这个清单还没有视频";
      grid.append(empty);
    }
    const pageOwner = captureViewOwner({ video: true });
    videos.forEach((video, index) => {
      const card = getListCards()?.renderVideoCard(video, index);
      if (!card) return;
      card.dataset.collectionVideoId = video.id;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "short-video-collection-remove";
      remove.dataset.videoId = video.id;
      remove.textContent = "移出清单";
      remove.addEventListener("click", () => removeVideo(video, remove));
      card.append(remove);
      card.querySelector(".short-video-thumb-open")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!shell.isConnected || !ownsView(pageOwner)) return;
        const button = event.currentTarget;
        if (button.disabled) return;
        button.disabled = true;
        button.setAttribute("aria-busy", "true");
        openCollectionVideo(video).catch((error) => {
          if (shell.isConnected && ownsView(pageOwner) && error?.name !== "AbortError") showToast(error?.message || "清单视频读取失败");
        }).finally(() => {
          if (button.isConnected) { button.disabled = false; button.removeAttribute("aria-busy"); }
        });
      }, { capture: true });
      grid.append(card);
    });
    main.append(grid);
    if (data?.hasMore) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "short-video-collection-load-more";
      more.textContent = "加载更多";
      more.addEventListener("click", async () => {
        const owner = captureViewOwner({ video: true });
        if (!ownsView(owner) || !more.isConnected || more.disabled) return;
        more.disabled = true;
        try {
          await loadCollection(state.shortVideo.collectionId, { append: true });
          if (ownsView(owner) && more.isConnected) render();
        } catch (error) {
          if (!ownsView(owner) || !more.isConnected) return;
          showToast(error?.message || "加载更多失败");
          more.disabled = false;
        }
      });
      main.append(more);
    }
    return shell;
  }

  async function removeVideo(video, button) {
    const collectionId = state.shortVideo.collectionId;
    const owner = captureViewOwner({ video: true }), data = state.shortVideo.collectionData;
    if (!ownsView(owner) || data?.collection?.id !== collectionId || button.disabled) return;
    button.disabled = true;
    try {
      await collectionApi(`/api/short-videos/collections/${encodeURIComponent(collectionId)}/videos/${encodeURIComponent(video.id)}`, {
        method: "DELETE"
      });
      invalidateCollection(collectionId);
      pruneCollectionVideos(collectionId, new Set([String(video.id)]), data);
      const collection = state.shortVideo.collections.find((item) => item.id === collectionId);
      if (collection) collection.itemCount = data.total;
      if (ownsView(owner) && button.isConnected !== false) { showToast("已移出清单"); render(); }
    } catch (error) {
      if (!ownsView(owner) || button.isConnected === false) return;
      showToast(error?.message || "移出清单失败");
      button.disabled = false;
    }
  }

  async function renameActiveCollection() {
    const data = state.shortVideo.collectionData;
    const owner = captureViewOwner({ video: true });
    if (!data?.collection?.id) return;
    const name = window.prompt("清单名称", data.collection.name);
    if (name == null) return;
    try {
      const result = await collectionApi(`/api/short-videos/collections/${encodeURIComponent(data.collection.id)}`, {
        method: "PATCH",
        body: { name }
      });
      invalidateCollection(data.collection.id);
      data.collection = result.collection;
      syncCollectionSummary(result.collection);
      if (ownsView(owner)) { showToast("清单已重命名"); render(); }
    } catch (error) {
      if (!ownsView(owner)) return;
      showToast(error?.message || "重命名失败");
    }
  }

  async function deleteActiveCollection() {
    const collection = state.shortVideo.collectionData?.collection;
    const owner = captureViewOwner();
    if (!collection?.id || !window.confirm(`删除清单“${collection.name}”？视频文件不会被删除。`)) return;
    try {
      await collectionApi(`/api/short-videos/collections/${encodeURIComponent(collection.id)}`, { method: "DELETE" });
      invalidateCollection(collection.id);
      state.shortVideo.collections = state.shortVideo.collections.filter((item) => item.id !== collection.id);
      if (collectionFeedReturnWindow?.state) {
        const feed = collectionFeedReturnWindow.state;
        feed.collections = (feed.collections || []).filter(item => item.id !== collection.id);
        if (feed.collectionData?.collection?.id === collection.id) feed.collectionData = null;
      }
      if (collectionVideoReturnWindow?.collectionId === collection.id) collectionVideoReturnWindow = null;
      if (!ownsView(owner)) return;
      state.shortVideo.collectionData = null;
      state.shortVideo.collectionId = "";
      showToast("清单已删除");
      returnToFeed();
    } catch (error) {
      if (!ownsView(owner)) return;
      showToast(error?.message || "删除清单失败");
    }
  }

  function loadCollectionVideoDetail(videoId, options = {}) {
    const collectionId = String(state.shortVideo.collectionId || "").trim();
    const id = String(videoId || "").trim();
    if (!collectionId || !id) return Promise.reject(new Error("缺少清单视频 ID"));
    const readEpoch = interactionState?.captureRead();
    return collectionApi(`/api/short-videos/collections/${encodeURIComponent(collectionId)}/videos/${encodeURIComponent(id)}`, { signal: options.signal }).then(data => {
      if (deletedVideos.has(id) || deletedVideos.has(String(data?.video?.id || ""))) return null;
      if (data?.video && interactionState) data.video = interactionState.mergeVideo(data.video, readEpoch);
      return data;
    });
  }

  async function openCollectionVideo(video, options = {}) {
    const videoId = String(video?.id || video || "").trim();
    if (!videoId) return false;
    if (collectionVideoRequest?.id === videoId && ownsView(collectionVideoRequest.owner)) return collectionVideoRequest.promise;
    const requestId = ++collectionVideoRequestId, owner = captureViewOwner({ video: true });
    collectionVideoRequest?.controller.abort();
    const request = { id: videoId, owner, controller: new AbortController(), promise: null };
    collectionVideoRequest = request;
    if (!options.deepLink) {
      collectionVideoEnteredWithinApp = true;
      collectionVideoReturnWindow = captureCollectionWindow(
        state.shortVideo,
        window.scrollY,
        videoId,
        document.activeElement
      );
    }
    request.promise = (async () => {
      try {
        const detail = options.detail || await loadCollectionVideoDetail(videoId, { signal: request.controller.signal });
        if (requestId !== collectionVideoRequestId || !ownsView(owner) || !detail?.video || deletedVideos.has(String(detail.video.id))) return false;
        return onOpenVideo(detail.video, { ...options, detailData: detail, deepLink: undefined });
      } catch (error) {
        if (requestId !== collectionVideoRequestId || !ownsView(owner) || request.controller.signal.aborted) return false;
        throw error;
      } finally {
        if (collectionVideoRequest === request) collectionVideoRequest = null;
      }
    })();
    return request.promise;
  }

  function collectionNavigation(videoId) {
    if (state.shortVideo.mode !== "collection") return null;
    if (state.shortVideo.collectionData?.collection?.id && state.shortVideo.collectionData.collection.id !== state.shortVideo.collectionId) return null;
    const videos = state.shortVideo.collectionData?.videos || [];
    const index = videos.findIndex((video) => String(video.id) === String(videoId));
    if (index < 0) return null;
    return {
      prevId: String(videos[index - 1]?.id || ""),
      nextId: String(videos[index + 1]?.id || ""),
      prevVideo: videos[index - 1] || null,
      nextVideo: videos[index + 1] || null
    };
  }

  async function prepareCollectionNavigation(videoId, options = {}) {
    let navigation = collectionNavigation(videoId);
    if (!navigation || navigation.nextId || !state.shortVideo.collectionData?.hasMore) return navigation;
    while (navigation && !navigation.nextId && state.shortVideo.collectionData?.hasMore) {
      if (options.isCurrent && !options.isCurrent()) return null;
      const cursor = String(state.shortVideo.collectionData.nextCursor || "");
      const data = await loadCollection(state.shortVideo.collectionId, { append: true });
      if ((options.isCurrent && !options.isCurrent()) || !data) return null;
      navigation = collectionNavigation(videoId);
      if (navigation && !navigation.nextId && data.hasMore && String(data.nextCursor || "") === cursor) {
        throw new Error("清单分页没有前进，请重试");
      }
    }
    if (navigation) {
      state.shortVideo.prevId = navigation.prevId;
      state.shortVideo.nextId = navigation.nextId;
      state.shortVideo.prevVideo = navigation.prevVideo;
      state.shortVideo.nextVideo = navigation.nextVideo;
      onNavigationChange?.();
    }
    return navigation;
  }

  async function openCollection(collectionId, options = {}) {
    const id = String(collectionId || "").trim();
    if (!id) return;
    changeViewIntent();
    if (!options.skipRoute && state.shortVideo.mode !== "collection") {
      collectionPageEnteredWithinApp = true;
      collectionFeedReturnWindow = captureCollectionFeedWindow(state.shortVideo, window.scrollY, document.activeElement);
    }
    if (state.shortVideo.collectionData?.collection?.id !== id) state.shortVideo.collectionData = null;
    state.shortVideo.mode = "collection";
    state.shortVideo.collectionId = id;
    state.shortVideo.current = null;
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    state.shortVideo.prevId = "";
    state.shortVideo.nextId = "";
    state.shortVideo.data = null;
    const owner = captureViewOwner({ video: true });
    setMainHeader("我的清单", "短视频 / 自定义清单");
    if (!options.skipRoute) {
      pushRoute({
        view: "shortVideos",
        shortVideoId: "",
        shortVideoMode: "collection",
        shortVideoCollectionId: id
      });
    }
    if (!options.videoId && options.skipRoute && restoreCollectionWindow(
      state.shortVideo,
      collectionVideoReturnWindow,
      render,
      positionRestoreOptions()
    )) {
      collectionVideoReturnWindow = null;
      collectionVideoEnteredWithinApp = false;
      loadCollections().catch(() => []);
      return;
    }
    state.shortVideo.collectionLoading = true;
    state.shortVideo.collectionError = "";
    render();
    loadCollections().then(() => { if (ownsView(owner) && !state.shortVideo.collectionLoading) render(); }).catch(() => []);
    try {
    const loaded = await loadCollection(id);
    if (!ownsView(owner) || !loaded) return false;
    if (options.videoId) {
      collectionVideoEnteredWithinApp = false;
      collectionVideoReturnWindow = captureCollectionWindow(state.shortVideo, 0, options.videoId);
      await openCollectionVideo(options.videoId, { deepLink: true, skipRoute: true });
      return;
    }
    render();
    } catch (error) {
      if (!ownsView(owner)) return false;
      render();
      throw error;
    }
  }

  function returnFromCollectionVideo() {
    if (state.shortVideo.mode !== "collection" || !state.shortVideo.collectionId) return false;
    changeViewIntent();
    if (collectionVideoEnteredWithinApp && window.history.length > 1) {
      window.history.back();
      return true;
    }
    state.shortVideo.current = null;
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    state.shortVideo.prevId = "";
    state.shortVideo.nextId = "";
    state.shortVideo.slideDirection = 0;
    state.shortVideo.loading = false;
    state.shortVideo.status = "";
    replaceRoute({
      view: "shortVideos",
      shortVideoId: "",
      shortVideoMode: "collection",
      shortVideoCollectionId: state.shortVideo.collectionId
    });
    const restored = restoreCollectionWindow(state.shortVideo, collectionVideoReturnWindow, render, positionRestoreOptions());
    if (!restored) {
      render();
      const owner = captureViewOwner({ video: true });
      restoreCollectionPosition({ scrollY: 0, focusVideoId: "" }, { isCurrent: () => ownsView(owner) });
    }
    collectionVideoReturnWindow = null;
    collectionVideoEnteredWithinApp = false;
    return true;
  }

  function returnToFeed() {
    changeViewIntent();
    if (collectionPageEnteredWithinApp && window.history.length > 1) {
      window.history.back();
      return;
    }
    state.shortVideo.mode = "feed";
    state.shortVideo.collectionId = "";
    state.shortVideo.current = null;
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    state.shortVideo.prevId = "";
    state.shortVideo.nextId = "";
    state.shortVideo.data = null;
    replaceRoute({ view: "shortVideos", shortVideoId: "", shortVideoMode: "feed", shortVideoCollectionId: "" });
    if (!restoreCollectionFeedWindow(state.shortVideo, collectionFeedReturnWindow, render, null, positionRestoreOptions())) {
      render();
      loadFeed();
    }
    collectionFeedReturnWindow = null;
    collectionPageEnteredWithinApp = false;
  }

  function restoreFeedAfterRoute(route = {}) {
    if (!collectionFeedReturnWindow) return false;
    changeViewIntent();
    const restored = restoreCollectionFeedWindow(state.shortVideo, collectionFeedReturnWindow, render, route, positionRestoreOptions());
    if (!restored) {
      collectionFeedReturnWindow = null;
      collectionPageEnteredWithinApp = false;
      return false;
    }
    collectionFeedReturnWindow = null;
    collectionPageEnteredWithinApp = false;
    setMainHeader("短视频", "抖音点赞本地库");
    return true;
  }

  function syncCollectionSummary(collection) {
    if (!collection?.id) return;
    for (const target of [state.shortVideo, collectionFeedReturnWindow?.state]) {
      if (!target) continue;
      target.collections = Array.isArray(target.collections) ? target.collections : [];
      const index = target.collections.findIndex((item) => item.id === collection.id);
      if (index >= 0) target.collections[index] = { ...target.collections[index], ...collection };
      else target.collections.push(collection);
    }
  }

  function pruneCollectionVideos(collectionId, ids, extra = null) {
    const targets = new Set([extra, state.shortVideo.collectionData, collectionVideoReturnWindow?.data,
      collectionFeedReturnWindow?.state?.collectionData]);
    for (const data of targets) {
      if (!data || String(data.collection?.id || "") !== String(collectionId)) continue;
      const previous = Array.isArray(data.videos) ? data.videos : [];
      data.videos = previous.filter(video => !ids.has(String(video.id)));
      data.total = Math.max(0, Number(data.total ?? previous.length) - (previous.length - data.videos.length));
    }
    if (state.shortVideo.mode === "collection" && state.shortVideo.collectionId === collectionId
      && state.shortVideo.collectionData?.collection?.id === collectionId) {
      const data = state.shortVideo.collectionData;
      state.shortVideo.data = { ...state.shortVideo.data, videos: data.videos, total: data.total };
      const currentId = String(state.shortVideo.current?.id || "");
      const navigation = currentId ? collectionNavigation(currentId) : null;
      if (navigation) {
        Object.assign(state.shortVideo, navigation);
        onNavigationChange?.();
      }
    }
  }

  function forgetVideos(values = []) {
    const ids = new Set([...values].map(value => String(value || "").trim()).filter(Boolean));
    if (!ids.size) return false;
    for (const id of ids) deletedVideos.add(id);
    collectionsRevision += 1;
    const data = [state.shortVideo.collectionData, collectionVideoReturnWindow?.data, collectionFeedReturnWindow?.state?.collectionData];
    const collectionIds = new Set(data.filter(value => value?.videos?.some(video => ids.has(String(video.id))))
      .map(value => value?.collection?.id).filter(Boolean));
    for (const id of collectionIds) {
      invalidateCollection(id);
      pruneCollectionVideos(id, ids);
    }
    const feed = collectionFeedReturnWindow?.state;
    if (Array.isArray(feed?.data?.videos)) feed.data = { ...feed.data, videos: feed.data.videos.filter(video => !ids.has(String(video.id))) };
    for (const target of [state.shortVideo, feed]) {
      if (!target) continue;
      if (ids.has(String(target.prevId || target.prevVideo?.id || ""))) { target.prevId = ""; target.prevVideo = null; }
      if (ids.has(String(target.nextId || target.nextVideo?.id || ""))) { target.nextId = ""; target.nextVideo = null; }
    }
    return true;
  }

  return Object.freeze({
    cancelReads,
    collectionNavigation,
    forgetVideos,
    loadCollection,
    loadCollectionVideoDetail,
    loadCollections,
    openCollection,
    prepareCollectionNavigation,
    renderCollectionPage,
    renderSidebar,
    restoreFeedAfterRoute,
    returnFromCollectionVideo,
    returnToFeed,
    showPicker
  });
}

function mergeUniqueVideos(previous = [], incoming = []) {
  const videos = [];
  const seen = new Set();
  for (const video of [...(previous || []), ...(incoming || [])]) {
    const id = String(video?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    videos.push(video);
  }
  return videos;
}
