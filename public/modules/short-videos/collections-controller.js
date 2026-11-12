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
    activateCardCovers,
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
    releaseCardCovers,
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
  let dismissPicker = null;
  const collectionApi = (path, options = {}) => options.method && options.method.toUpperCase() !== "GET"
    ? retryShortVideoCollectionRequest(() => api(path, options))
    : runShortVideoRead(signal => retryShortVideoCollectionRequest(() => api(path, { ...options, signal }), { signal }), { signal: options.signal });

  function cancelReads() {
    dismissPicker?.({ restoreFocus: false });
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
    const closePicker = ({ restoreFocus = true } = {}) => {
      if (dismissPicker === closePicker) dismissPicker = null;
      if (!overlay.isConnected) return;
      overlay.remove();
      if (!restoreFocus || !ownsView(owner)) return;
      const fallback = document.querySelector(".short-video-rail-button.is-collection")
        || document.querySelector(".short-video-collection-create");
      (returnFocus?.isConnected ? returnFocus : fallback)?.focus?.({ preventScroll: true });
    };
    overlay._closeCollectionPicker = closePicker;
    dismissPicker = closePicker;
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closePicker();
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229 || composing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closePicker();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll("button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])")]
        .filter((element) => !element.closest("[hidden], [aria-hidden='true']"));
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

    const showChoices = Boolean(video && !options.createOnly);
    const controls = document.createElement("div");
    controls.className = "short-video-collection-picker-tools";
    controls.hidden = true;
    const filter = document.createElement("input");
    filter.type = "search";
    filter.autocomplete = "off";
    filter.maxLength = 40;
    filter.placeholder = "搜索清单名称";
    filter.setAttribute("aria-label", "搜索清单名称");
    const toggleMultiple = document.createElement("button");
    toggleMultiple.type = "button";
    toggleMultiple.textContent = "多选";
    toggleMultiple.setAttribute("aria-pressed", "false");
    const addSelected = document.createElement("button");
    addSelected.type = "button";
    addSelected.className = "short-video-collection-picker-apply";
    addSelected.hidden = true;
    controls.append(filter, toggleMultiple, addSelected);

    const status = document.createElement("div");
    status.className = "short-video-collection-picker-status";
    status.setAttribute("role", "status");
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "short-video-collection-picker-retry";
    retry.textContent = "重试读取清单";
    retry.hidden = true;
    const empty = document.createElement("p");
    empty.className = "short-video-collection-picker-status";
    empty.setAttribute("role", "status");
    empty.hidden = true;
    const list = document.createElement("div");
    list.className = "short-video-collection-picker-list";
    list.setAttribute("aria-label", "清单选项");
    list.hidden = true;
    if (showChoices) dialog.append(header, controls, status, retry, empty, list, form);
    else dialog.append(header, form, status);
    let composing = false;
    let query = "";
    let multiple = false;
    let writing = false;
    let reading = false;
    let createdCollection = null;
    const selected = new Set();
    const completed = new Set();
    const rows = new Map();
    overlay.append(dialog);
    document.body.append(overlay);
    const ownsPicker = () => ownsView(owner) && overlay.isConnected;

    function syncChoices() {
      controls.hidden = rows.size === 0;
      filter.disabled = writing;
      toggleMultiple.disabled = writing || rows.size < 2;
      toggleMultiple.setAttribute("aria-pressed", String(multiple));
      addSelected.hidden = !multiple;
      addSelected.disabled = writing || selected.size === 0;
      addSelected.textContent = selected.size ? `加入 ${selected.size} 个清单` : "加入所选清单";
      let visible = 0;
      for (const [id, row] of rows) {
        row.button.hidden = !row.searchName.includes(query);
        if (!row.button.hidden) visible += 1;
        row.button.disabled = writing || completed.has(id);
        if (multiple) row.button.setAttribute("aria-pressed", String(selected.has(id)));
        else row.button.removeAttribute("aria-pressed");
        row.count.textContent = completed.has(id) ? "已在清单" : `${Math.max(0, Number(row.collection.itemCount || 0))} 条`;
      }
      empty.hidden = Boolean(visible || !rows.size);
      empty.textContent = empty.hidden ? "" : "没有匹配的清单";
      list.hidden = !visible;
    }

    function updateFilter() {
      if (composing || writing || !ownsPicker()) return;
      query = normalizeCollectionPickerName(filter.value);
      syncChoices();
      list.scrollTop = 0;
    }

    async function write(run, failureMessage, failureFocus) {
      if (!ownsPicker() || writing) return;
      writing = true;
      input.disabled = submit.disabled = retry.disabled = true;
      dialog.setAttribute("aria-busy", "true");
      status.textContent = "";
      syncChoices();
      let failed = false;
      try {
        await run();
      } catch (error) {
        if (!ownsPicker()) return;
        failed = true;
        status.textContent = error?.message || failureMessage;
      } finally {
        if (ownsPicker()) {
          writing = false;
          input.disabled = Boolean(createdCollection);
          submit.disabled = retry.disabled = false;
          dialog.removeAttribute("aria-busy");
          syncChoices();
          if (failed) failureFocus().focus({ preventScroll: true });
        }
      }
    }

    async function addToCollection(collection) {
      const result = await collectionApi(`/api/short-videos/collections/${encodeURIComponent(collection.id)}/videos/${encodeURIComponent(video.id)}`, { method: "PUT" });
      invalidateCollection(collection.id);
      const latest = state.shortVideo.collections.find(item => item.id === collection.id) || collection;
      syncCollectionSummary({ ...latest, itemCount: Math.max(0, Number(latest.itemCount || 0)) + Number(Boolean(result.added)) });
      return Boolean(result.added);
    }

    function finishPicker(message) {
      if (!ownsPicker()) return false;
      closePicker();
      render();
      if (message) showToast(message);
      return true;
    }

    function mountChoice(collection) {
      const id = collection?.id;
      if (!id || rows.has(id)) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-collection-picker-item";
      button.dataset.collectionId = id;
      const name = document.createElement("span"), count = document.createElement("small");
      name.textContent = collection.name;
      button.append(name, count);
      rows.set(id, { collection, button, count, searchName: normalizeCollectionPickerName(collection.name) });
      button.addEventListener("click", () => {
        if (!ownsPicker() || writing || button.hidden || button.disabled) return;
        if (multiple) {
          if (selected.has(id)) selected.delete(id);
          else selected.add(id);
          syncChoices();
          return;
        }
        void write(async () => {
          const added = await addToCollection(collection);
          finishPicker(added ? `已加入“${collection.name}”` : `已经在“${collection.name}”中`);
        }, "加入清单失败", () => button);
      });
      list.append(button);
    }

    async function readChoices() {
      if (!ownsPicker() || reading || writing) return;
      reading = true;
      if (document.activeElement === retry) dialog.focus({ preventScroll: true });
      retry.hidden = true;
      status.textContent = "正在读取清单…";
      try {
        const collections = await loadCollections();
        if (!ownsPicker()) return;
        for (const collection of collections) mountChoice(collection);
        syncChoices();
        if (!writing) {
          status.textContent = rows.size ? "" : "先创建一个清单";
          if (document.activeElement === dialog || document.activeElement === document.body) {
            (rows.size ? filter : input).focus({ preventScroll: true });
          }
        }
      } catch (error) {
        if (!ownsPicker()) return;
        if (!writing) status.textContent = error?.message || "清单读取失败";
        retry.hidden = false;
      } finally {
        reading = false;
      }
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void write(async () => {
        if (!createdCollection) {
          const result = await collectionApi("/api/short-videos/collections", { method: "POST", body: { name: input.value } });
          createdCollection = result.collection;
          if (!createdCollection?.id) throw new Error("清单创建失败");
          collectionsRevision += 1;
          syncCollectionSummary(createdCollection);
          state.shortVideo.collectionsLoaded = true;
        }
        if (!ownsPicker()) return;
        if (!video) {
          if (finishPicker()) openCollection(createdCollection.id).catch((error) => showToast(error?.message || "清单读取失败"));
          return;
        }
        mountChoice(createdCollection);
        submit.textContent = "重试加入";
        const added = await addToCollection(createdCollection);
        finishPicker(added ? `已加入“${createdCollection.name}”` : `已经在“${createdCollection.name}”中`);
      }, createdCollection ? "加入清单失败" : "清单创建失败", () => createdCollection ? submit : input);
    });

    filter.addEventListener("compositionstart", () => { composing = true; });
    filter.addEventListener("compositionend", () => { composing = false; updateFilter(); });
    filter.addEventListener("input", (event) => { if (!event.isComposing) updateFilter(); });
    filter.addEventListener("search", updateFilter);
    filter.addEventListener("keydown", (event) => {
      if (composing || event.isComposing || event.keyCode === 229 || (event.key !== "ArrowDown" && event.key !== "Enter")) return;
      event.preventDefault();
      list.querySelector("button:not([hidden]):not([disabled])")?.focus();
    });
    toggleMultiple.addEventListener("click", () => {
      if (!ownsPicker() || writing) return;
      multiple = !multiple;
      if (!multiple) selected.clear();
      status.textContent = "";
      syncChoices();
    });
    addSelected.addEventListener("click", () => {
      if (!multiple || !selected.size) return;
      void write(async () => {
        const destinations = [...rows].filter(([id]) => selected.has(id));
        let failure = null;
        for (const [id, row] of destinations) {
          if (!ownsPicker()) return;
          try {
            await addToCollection(row.collection);
            completed.add(id);
            selected.delete(id);
          } catch (error) {
            failure ||= error;
          }
        }
        if (!ownsPicker()) return;
        if (failure) {
          const reason = failure.message || "可重试所选清单。";
          throw new Error(`已确认 ${completed.size} 个清单，${selected.size} 个未完成。 ${reason}`);
        }
        finishPicker(`已确认在 ${completed.size} 个清单中`);
      }, "加入清单失败", () => addSelected);
    });
    retry.addEventListener("click", () => { void readChoices(); });

    if (showChoices) {
      dialog.focus({ preventScroll: true });
      await readChoices();
    } else {
      input.focus({ preventScroll: true });
    }
  }

  function renderCollectionPage() {
    ensureState();
    const shell = document.createElement("section");
    shell.className = "short-video-home short-video-collection-page";
    const layout = document.createElement("div");
    layout.className = "short-video-home-layout";
    const main = document.createElement("section");
    main.className = "short-video-home-main";
    const sidebar = renderSidebar();
    layout.append(sidebar, main);
    shell.append(layout);

    const data = state.shortVideo.collectionData;
    const mount = { shell, main, owner: captureViewOwner({ video: true }), data, videos: [], cards: new Map(),
      grid: null, more: null, empty: null, loading: false };
    const header = document.createElement("header");
    header.className = "short-video-collection-page-header";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "short-video-collection-back";
    back.textContent = "返回短视频";
    back.addEventListener("click", () => {
      if (shell.isConnected && ownsView(mount.owner)) returnToFeed();
    });
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
    rename.addEventListener("click", () => { if (ownsCollectionMount(mount)) renameActiveCollection(); });
    const removeCollection = document.createElement("button");
    removeCollection.type = "button";
    removeCollection.className = "is-danger";
    removeCollection.textContent = "删除清单";
    removeCollection.disabled = !data?.collection?.id;
    removeCollection.addEventListener("click", () => { if (ownsCollectionMount(mount)) deleteActiveCollection(); });
    actions.append(rename, removeCollection);
    header.append(back, copy, actions);
    main.append(header);
    Object.assign(mount, { title, meta, back });
    const sidebarRow = [...sidebar.querySelectorAll(".short-video-collection-sidebar-item")]
      .find(button => button.dataset.collectionId === data?.collection?.id);
    mount.sidebarName = sidebarRow?.querySelector("span");
    mount.sidebarCount = sidebarRow?.querySelector("small");

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
    mount.grid = grid;
    videos.forEach((video, index) => appendCollectionCard(mount, video, index));
    mount.videos = videos;
    main.append(grid);
    syncCollectionControls(mount);
    return shell;
  }

  function ownsCollectionMount(mount) {
    return Boolean(mount.shell.isConnected && ownsView(mount.owner)
      && state.shortVideo.collectionData?.collection?.id === mount.owner.collectionId);
  }

  function currentCollectionCard(mount, record) {
    if (!ownsCollectionMount(mount) || mount.cards.get(record.id) !== record || record.card.parentElement !== mount.grid) return null;
    // loadCollection replaces the envelope on append. Retained controls read
    // that latest window, while detached/replaced records cannot act on it.
    return state.shortVideo.collectionData.videos?.find(video => String(video.id) === record.id && video === record.video) || null;
  }

  function appendCollectionCard(mount, video, index) {
    const card = getListCards()?.renderVideoCard(video, index);
    if (!card) return;
    const record = { id: String(video.id), video, card };
    mount.cards.set(record.id, record);
    card.dataset.collectionVideoId = video.id;
    card.addEventListener("click", event => {
      if (currentCollectionCard(mount, record)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }, { capture: true });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "short-video-collection-remove";
    remove.dataset.videoId = video.id;
    remove.textContent = "移出清单";
    record.remove = remove;
    remove.addEventListener("click", () => removeVideo(mount, record));
    card.append(remove);
    card.querySelector(".short-video-thumb-open")?.addEventListener("click", event => {
      event.preventDefault(); event.stopImmediatePropagation();
      const current = currentCollectionCard(mount, record), button = event.currentTarget;
      if (!current || button.disabled) return;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      openCollectionVideo(current).catch(error => {
        if (currentCollectionCard(mount, record) && error?.name !== "AbortError") showToast(error?.message || "清单视频读取失败");
      }).finally(() => {
        if (currentCollectionCard(mount, record)) { button.disabled = false; button.removeAttribute("aria-busy"); }
      });
    }, { capture: true });
    mount.grid.append(card);
    activateCardCovers?.([card]);
  }

  function syncCollectionControls(mount) {
    const data = mount.data;
    mount.title.textContent = data?.collection?.name || "我的清单";
    mount.meta.textContent = `${Math.max(0, Number(data?.total || 0))} 条 · 按加入时间排列`;
    const summary = state.shortVideo.collections.find(collection => collection.id === mount.owner.collectionId);
    if (mount.sidebarName) mount.sidebarName.textContent = summary?.name || "";
    if (mount.sidebarCount) mount.sidebarCount.textContent = String(Math.max(0, Number(summary?.itemCount || 0)));
    if (!mount.videos.length && !mount.empty) {
      mount.empty = document.createElement("div");
      mount.empty.className = "short-video-empty";
      mount.empty.textContent = "这个清单还没有视频";
      mount.grid.append(mount.empty);
    } else if (mount.videos.length && mount.empty) {
      mount.empty.remove(); mount.empty = null;
    }
    if (data?.hasMore && !mount.more) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "short-video-collection-load-more";
      more.addEventListener("click", async () => {
        if (!ownsCollectionMount(mount) || mount.more !== more || !more.isConnected || more.disabled || mount.loading) return;
        const focused = document.activeElement === more;
        mount.loading = true;
        syncCollectionControls(mount);
        try {
          const data = await loadCollection(mount.owner.collectionId, { append: true });
          if (data && ownsCollectionMount(mount) && !appendMountedCollectionVideos(mount, data)) render();
        } catch (error) {
          if (!ownsCollectionMount(mount) || !more.isConnected) return;
          showToast(error?.message || "加载更多失败");
        } finally {
          mount.loading = false;
          if (ownsCollectionMount(mount)) {
            syncCollectionControls(mount);
            if (focused && (document.activeElement === more || document.activeElement === document.body)) {
              const target = mount.more || mount.grid.lastElementChild?.querySelector(".short-video-thumb-open") || mount.back;
              target.focus({ preventScroll: true });
            }
          }
        }
      });
      mount.more = more;
      mount.main.append(more);
    }
    if (mount.more && !data?.hasMore) { mount.more.remove(); mount.more = null; }
    if (mount.more) {
      mount.more.disabled = mount.loading;
      mount.more.textContent = mount.loading ? "加载中…" : "加载更多";
      if (mount.loading) mount.more.setAttribute("aria-busy", "true");
      else mount.more.removeAttribute("aria-busy");
    }
  }

  function appendMountedCollectionVideos(mount, data) {
    if (!ownsCollectionMount(mount) || data !== state.shortVideo.collectionData || !Array.isArray(data.videos)
      || mount.videos.length > data.videos.length || mount.videos.some((video, index) => data.videos[index] !== video)) return false;
    for (let index = mount.videos.length; index < data.videos.length; index++) appendCollectionCard(mount, data.videos[index], index);
    mount.data = data;
    mount.videos = data.videos;
    syncCollectionControls(mount);
    return true;
  }

  async function removeVideo(mount, record) {
    const video = currentCollectionCard(mount, record), button = record.remove;
    if (!video || button.disabled) return;
    const collectionId = mount.owner.collectionId, data = state.shortVideo.collectionData;
    const focused = record.card.contains(document.activeElement);
    button.disabled = true;
    try {
      await collectionApi(`/api/short-videos/collections/${encodeURIComponent(collectionId)}/videos/${encodeURIComponent(video.id)}`, {
        method: "DELETE"
      });
      invalidateCollection(collectionId);
      pruneCollectionVideos(collectionId, new Set([String(video.id)]), data);
      const collection = state.shortVideo.collections.find((item) => item.id === collectionId);
      const latest = state.shortVideo.collectionData?.collection?.id === collectionId ? state.shortVideo.collectionData : data;
      if (collection) collection.itemCount = latest.total;
      if (!ownsCollectionMount(mount) || !button.isConnected) return;
      const restoreFocus = record.card.contains(document.activeElement) || (focused && document.activeElement === document.body);
      const neighbor = record.card.nextElementSibling || record.card.previousElementSibling;
      releaseCardCovers?.([record.card]);
      record.card.remove();
      mount.cards.delete(record.id);
      mount.videos = mount.videos.filter(item => String(item.id) !== record.id);
      showToast("已移出清单");
      if (!appendMountedCollectionVideos(mount, latest)) { render(); return; }
      if (restoreFocus) {
        const remove = neighbor?.querySelector(".short-video-collection-remove");
        const target = remove && !remove.disabled ? remove
          : neighbor?.querySelector(".short-video-thumb-open") || (mount.more?.disabled ? null : mount.more) || mount.back;
        target.focus({ preventScroll: true });
      }
    } catch (error) {
      if (!currentCollectionCard(mount, record)) return;
      showToast(error?.message || "移出清单失败");
      button.disabled = false;
      if (focused && document.activeElement === document.body) button.focus({ preventScroll: true });
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

function normalizeCollectionPickerName(value) {
  return String(value || "").normalize("NFKC").trim().toLowerCase();
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
