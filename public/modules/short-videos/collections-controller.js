import {
  captureCollectionFeedWindow,
  captureCollectionWindow,
  restoreCollectionFeedWindow,
  restoreCollectionPosition,
  restoreCollectionWindow
} from "./collection-navigation.js?v=20260812-collection-review-02";

const COLLECTION_PAGE_SIZE = 48;

export function createShortVideoCollectionsController(dependencies) {
  const {
    api,
    createIcon,
    ensureListCards,
    getListCards,
    onNavigationChange,
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
  let collectionVideoEnteredWithinApp = false;
  let collectionVideoReturnWindow = null;
  let collectionPageEnteredWithinApp = false;
  let collectionFeedReturnWindow = null;

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
    if (state.shortVideo.collectionsLoaded && !options.force) return state.shortVideo.collections;
    if (collectionsRequest && !options.force) return collectionsRequest;
    state.shortVideo.collectionsLoading = true;
    collectionsRequest = api("/api/short-videos/collections")
      .then((data) => {
        state.shortVideo.collections = Array.isArray(data?.collections) ? data.collections : [];
        state.shortVideo.collectionsLoaded = true;
        return state.shortVideo.collections;
      })
      .finally(() => {
        state.shortVideo.collectionsLoading = false;
        collectionsRequest = null;
      });
    return collectionsRequest;
  }

  async function loadCollection(collectionId, options = {}) {
    ensureState();
    const id = String(collectionId || "").trim();
    if (!id) throw new Error("缺少清单 ID");
    const append = Boolean(options.append);
    const cursor = append ? String(state.shortVideo.collectionData?.nextCursor || "") : "";
    const requestId = ++collectionRequestId;
    state.shortVideo.collectionId = id;
    state.shortVideo.collectionLoading = true;
    state.shortVideo.collectionError = "";
    try {
      const params = new URLSearchParams({ limit: String(COLLECTION_PAGE_SIZE) });
      if (cursor) params.set("cursor", cursor);
      const data = await api(`/api/short-videos/collections/${encodeURIComponent(id)}/videos?${params}`);
      if (requestId !== collectionRequestId || state.shortVideo.collectionId !== id) return null;
      const previous = append && state.shortVideo.collectionData?.collection?.id === id
        ? state.shortVideo.collectionData
        : null;
      const videos = mergeUniqueVideos(previous?.videos, data.videos);
      state.shortVideo.collectionData = { ...data, videos };
      state.shortVideo.data = {
        videos,
        total: Number(data.total || videos.length),
        hasMore: Boolean(data.hasMore),
        nextCursor: data.nextCursor || null
      };
      syncCollectionSummary(data.collection);
      return state.shortVideo.collectionData;
    } catch (error) {
      if (requestId === collectionRequestId) state.shortVideo.collectionError = error?.message || "清单读取失败";
      throw error;
    } finally {
      if (requestId === collectionRequestId) state.shortVideo.collectionLoading = false;
    }
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
        loadCollections().then(render).catch((error) => {
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

    const busy = (enabled) => {
      input.disabled = enabled;
      submit.disabled = enabled;
      dialog.setAttribute("aria-busy", String(enabled));
    };
    const addToCollection = async (collection) => {
      if (!video?.id) return;
      const result = await api(`/api/short-videos/collections/${encodeURIComponent(collection.id)}/videos/${encodeURIComponent(video.id)}`, {
        method: "PUT"
      });
      if (result.added) collection.itemCount = Math.max(0, Number(collection.itemCount || 0)) + 1;
      showToast(result.added ? `已加入“${collection.name}”` : `已经在“${collection.name}”中`);
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      busy(true);
      status.textContent = "";
      try {
        const result = await api("/api/short-videos/collections", {
          method: "POST",
          body: { name: input.value }
        });
        const collection = result.collection;
        state.shortVideo.collections.push(collection);
        state.shortVideo.collectionsLoaded = true;
        if (video) await addToCollection(collection);
        closePicker();
        render();
        if (!video) openCollection(collection.id).catch((error) => showToast(error?.message || "清单读取失败"));
      } catch (error) {
        status.textContent = error?.message || "清单创建失败";
        busy(false);
        input.focus();
      }
    });

    if (video && !options.createOnly) {
      status.textContent = "正在读取清单…";
      try {
        const collections = await loadCollections();
        if (!overlay.isConnected) return;
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
            button.disabled = true;
            try {
              await addToCollection(collection);
              closePicker();
              render();
            } catch (error) {
              status.textContent = error?.message || "加入清单失败";
              button.disabled = false;
            }
          });
          list.append(button);
        }
      } catch (error) {
        status.textContent = error?.message || "清单读取失败";
      }
    }
    input.focus({ preventScroll: true });
  }

  function renderCollectionPage() {
    ensureState();
    const shell = document.createElement("section");
    shell.className = "short-video-home short-video-collection-page";
    const layout = document.createElement("div");
    layout.className = "short-video-home-layout";
    const main = document.createElement("main");
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
      return shell;
    }

    if (!getListCards() && (data?.videos || []).length) {
      const status = document.createElement("div");
      status.className = "short-video-status";
      status.textContent = "正在准备清单内容…";
      main.append(status);
      ensureListCards().then(render).catch((error) => showToast(error?.message || "短视频列表模块加载失败"));
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
        openCollectionVideo(video).catch((error) => showToast(error?.message || "清单视频读取失败"));
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
        more.disabled = true;
        try {
          await loadCollection(state.shortVideo.collectionId, { append: true });
          render();
        } catch (error) {
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
    button.disabled = true;
    try {
      await api(`/api/short-videos/collections/${encodeURIComponent(collectionId)}/videos/${encodeURIComponent(video.id)}`, {
        method: "DELETE"
      });
      const data = state.shortVideo.collectionData;
      data.videos = (data.videos || []).filter((item) => item.id !== video.id);
      data.total = Math.max(0, Number(data.total || 0) - 1);
      state.shortVideo.data = { ...state.shortVideo.data, videos: data.videos, total: data.total };
      const collection = state.shortVideo.collections.find((item) => item.id === collectionId);
      if (collection) collection.itemCount = data.total;
      showToast("已移出清单");
      render();
    } catch (error) {
      showToast(error?.message || "移出清单失败");
      button.disabled = false;
    }
  }

  async function renameActiveCollection() {
    const data = state.shortVideo.collectionData;
    if (!data?.collection?.id) return;
    const name = window.prompt("清单名称", data.collection.name);
    if (name == null) return;
    try {
      const result = await api(`/api/short-videos/collections/${encodeURIComponent(data.collection.id)}`, {
        method: "PATCH",
        body: { name }
      });
      data.collection = result.collection;
      syncCollectionSummary(result.collection);
      showToast("清单已重命名");
      render();
    } catch (error) {
      showToast(error?.message || "重命名失败");
    }
  }

  async function deleteActiveCollection() {
    const collection = state.shortVideo.collectionData?.collection;
    if (!collection?.id || !window.confirm(`删除清单“${collection.name}”？视频文件不会被删除。`)) return;
    try {
      await api(`/api/short-videos/collections/${encodeURIComponent(collection.id)}`, { method: "DELETE" });
      state.shortVideo.collections = state.shortVideo.collections.filter((item) => item.id !== collection.id);
      state.shortVideo.collectionData = null;
      state.shortVideo.collectionId = "";
      showToast("清单已删除");
      returnToFeed();
    } catch (error) {
      showToast(error?.message || "删除清单失败");
    }
  }

  function loadCollectionVideoDetail(videoId) {
    const collectionId = String(state.shortVideo.collectionId || "").trim();
    const id = String(videoId || "").trim();
    if (!collectionId || !id) return Promise.reject(new Error("缺少清单视频 ID"));
    return api(`/api/short-videos/collections/${encodeURIComponent(collectionId)}/videos/${encodeURIComponent(id)}`);
  }

  async function openCollectionVideo(video, options = {}) {
    const videoId = String(video?.id || video || "").trim();
    if (!videoId) return false;
    if (!options.deepLink) {
      collectionVideoEnteredWithinApp = true;
      collectionVideoReturnWindow = captureCollectionWindow(
        state.shortVideo,
        window.scrollY,
        videoId,
        document.activeElement
      );
    }
    const detail = options.detail || await loadCollectionVideoDetail(videoId);
    return onOpenVideo(detail.video, { ...options, detailData: detail, deepLink: undefined });
  }

  function collectionNavigation(videoId) {
    if (state.shortVideo.mode !== "collection") return null;
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

  async function prepareCollectionNavigation(videoId) {
    let navigation = collectionNavigation(videoId);
    if (!navigation || navigation.nextId || !state.shortVideo.collectionData?.hasMore) return navigation;
    await loadCollection(state.shortVideo.collectionId, { append: true });
    navigation = collectionNavigation(videoId);
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
      render
    )) {
      collectionVideoReturnWindow = null;
      collectionVideoEnteredWithinApp = false;
      loadCollections().catch(() => []);
      return;
    }
    render();
    await Promise.all([loadCollections().catch(() => []), loadCollection(id)]);
    if (options.videoId) {
      collectionVideoEnteredWithinApp = false;
      collectionVideoReturnWindow = captureCollectionWindow(state.shortVideo, 0, options.videoId);
      await openCollectionVideo(options.videoId, { deepLink: true, skipRoute: true });
      return;
    }
    render();
  }

  function returnFromCollectionVideo() {
    if (state.shortVideo.mode !== "collection" || !state.shortVideo.collectionId) return false;
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
    const restored = restoreCollectionWindow(state.shortVideo, collectionVideoReturnWindow, render);
    if (!restored) {
      render();
      restoreCollectionPosition({ scrollY: 0, focusVideoId: "" });
    }
    collectionVideoReturnWindow = null;
    collectionVideoEnteredWithinApp = false;
    return true;
  }

  function returnToFeed() {
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
    if (!restoreCollectionFeedWindow(state.shortVideo, collectionFeedReturnWindow, render)) {
      render();
      loadFeed();
    }
    collectionFeedReturnWindow = null;
    collectionPageEnteredWithinApp = false;
  }

  function restoreFeedAfterRoute(route = {}) {
    if (!collectionFeedReturnWindow) return false;
    const restored = restoreCollectionFeedWindow(state.shortVideo, collectionFeedReturnWindow, render, route);
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
    const index = state.shortVideo.collections.findIndex((item) => item.id === collection.id);
    if (index >= 0) state.shortVideo.collections[index] = { ...state.shortVideo.collections[index], ...collection };
    else state.shortVideo.collections.push(collection);
  }

  return Object.freeze({
    collectionNavigation,
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
