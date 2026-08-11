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
    render,
    setMainHeader,
    showToast,
    state
  } = dependencies;
  let collectionsRequest = null;
  let collectionRequestId = 0;

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
    const offset = append ? Number(state.shortVideo.collectionData?.videos?.length || 0) : 0;
    const requestId = ++collectionRequestId;
    state.shortVideo.collectionId = id;
    state.shortVideo.collectionLoading = true;
    state.shortVideo.collectionError = "";
    try {
      const data = await api(`/api/short-videos/collections/${encodeURIComponent(id)}/videos?limit=${COLLECTION_PAGE_SIZE}&offset=${offset}`);
      if (requestId !== collectionRequestId || state.shortVideo.collectionId !== id) return null;
      const previous = append && state.shortVideo.collectionData?.collection?.id === id
        ? state.shortVideo.collectionData
        : null;
      const videos = previous
        ? [...(previous.videos || []), ...(data.videos || [])]
        : [...(data.videos || [])];
      state.shortVideo.collectionData = { ...data, videos };
      state.shortVideo.data = {
        videos,
        total: Number(data.total || videos.length),
        hasMore: Boolean(data.hasMore),
        nextOffset: data.nextOffset
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
    document.querySelector(".short-video-collection-picker")?.remove();
    const overlay = document.createElement("div");
    overlay.className = "short-video-collection-picker";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) overlay.remove();
    });
    const dialog = document.createElement("section");
    dialog.className = "short-video-collection-picker-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", video ? "加入清单" : "新建清单");
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = video ? "加入清单" : "我的清单";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "short-video-collection-picker-close";
    close.setAttribute("aria-label", "关闭");
    close.append(createIcon("close"));
    close.addEventListener("click", () => overlay.remove());
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
        overlay.remove();
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
              overlay.remove();
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
    input.focus();
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
        onOpenVideo(video);
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
    render();
    await Promise.all([loadCollections().catch(() => []), loadCollection(id)]);
    if (options.videoId) {
      const video = state.shortVideo.collectionData?.videos?.find((item) => item.id === options.videoId);
      await onOpenVideo(video || { id: options.videoId }, { skipRoute: true });
      return;
    }
    render();
  }

  function returnToFeed() {
    state.shortVideo.mode = "feed";
    state.shortVideo.collectionId = "";
    state.shortVideo.current = null;
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    state.shortVideo.prevId = "";
    state.shortVideo.nextId = "";
    state.shortVideo.data = null;
    pushRoute({ view: "shortVideos", shortVideoId: "", shortVideoMode: "feed", shortVideoCollectionId: "" });
    render();
    loadFeed();
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
    loadCollections,
    openCollection,
    prepareCollectionNavigation,
    renderCollectionPage,
    renderSidebar,
    returnToFeed,
    showPicker
  });
}
