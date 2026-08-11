import {
  appendCollectionCursorBoundary,
  removeCollectionCursorBoundaryVideo
} from "./cursor-boundaries.js?v=20260812-native-cursor-boundary-01";
import { retryShortVideoCollectionRequest } from "./request.js?v=20260812-collection-busy-01";

const COLLECTION_PAGE_LIMIT = 48;

export function createShortVideoCollections(context = {}) {
  const { api, els, getActiveUrl, showView } = context;
  const openNativeShortVideoFeed = (...args) => context.openNativeShortVideoFeed(...args);
  const renderCard = (...args) => context.renderCard(...args);
  const shortVideoToast = (...args) => context.shortVideoToast(...args);
  const state = {
    collections: [],
    loaded: false,
    loading: false,
    active: null
  };
  let collectionRenderId = 0;
  let collectionsRequest = null;
  let collectionPageRequest = null;
  let collectionMutationRevision = 0;
  const pendingCollectionMutations = new Map();
  const collectionApi = (...args) => retryShortVideoCollectionRequest(() => api.fetch(...args));

  async function loadCollections(force = false) {
    if (state.loaded && !force) return state.collections;
    if (collectionsRequest) return collectionsRequest;
    state.loading = true;
    const requestRevision = collectionMutationRevision;
    const request = collectionApi(null, "/api/short-videos/collections").then((data) => {
      state.collections = mergeCollectionRefresh(data?.collections, requestRevision);
      state.loaded = true;
      return state.collections;
    });
    collectionsRequest = request;
    try {
      return await request;
    } finally {
      if (collectionsRequest === request) {
        collectionsRequest = null;
        state.loading = false;
      }
    }
  }

  async function renderCollections(_params = {}, renderGuard = null) {
    configurePage("我的清单");
    const shell = collectionShell("我的清单", "创建清单后，可从任意短视频封面加入。");
    const create = createForm(async (name) => {
      const result = await collectionApi(null, "/api/short-videos/collections", {
        method: "POST",
        body: { name }
      });
      const collection = rememberCollectionMutation(result.collection);
      showView("shortVideoCollection", { collectionId: collection.id }, { push: true });
    });
    const list = document.createElement("div");
    list.className = "short-video-mobile-collections-list";
    shell.append(create.form, create.status, list);
    els.viewContent.append(shell);
    try {
      const collections = await loadCollections(true);
      if (renderGuard && !renderGuard()) return;
      renderCollectionList(list, collections);
    } catch (error) {
      if ((!renderGuard || renderGuard()) && create.status.isConnected) {
        create.status.textContent = error?.message || "清单读取失败";
      }
    }
  }

  async function renderCollection(params = {}, renderGuard = null) {
    const collectionId = String(params.collectionId || "").trim();
    const renderId = ++collectionRenderId;
    collectionPageRequest = null;
    state.active = null;
    configurePage("清单内容");
    const shell = collectionShell("正在读取清单…", "按加入时间排列");
    const list = document.createElement("div");
    list.className = "short-video-mobile-grid short-video-mobile-collection-grid";
    const status = document.createElement("div");
    status.className = "short-video-mobile-collection-status";
    shell.append(status, list);
    els.viewContent.append(shell);
    try {
      const data = await collectionApi(null, `/api/short-videos/collections/${encodeURIComponent(collectionId)}/videos?limit=${COLLECTION_PAGE_LIMIT}`);
      if (renderId !== collectionRenderId || (renderGuard && !renderGuard())) return;
      const videos = mergeUniqueVideos([], data.videos);
      state.active = {
        ...data,
        videos,
        cursorBoundaries: appendCollectionCursorBoundary([], data, videos),
        collectionId,
        renderId,
        renderGuard
      };
      shell.querySelector("h2").textContent = data.collection?.name || "我的清单";
      shell.querySelector("p").textContent = `${Math.max(0, Number(data.total || 0))} 条 · 按加入时间排列`;
      renderCollectionActions(shell, status, state.active);
      renderCollectionVideos(list, status, state.active);
    } catch (error) {
      if (renderId === collectionRenderId && (!renderGuard || renderGuard()) && status.isConnected) {
        status.textContent = error?.message || "清单读取失败";
      }
    }
  }

  async function showCollectionPicker(video) {
    document.querySelector(".short-video-mobile-collection-picker")?.remove();
    const trigger = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "short-video-mobile-collection-picker";
    let closed = false;
    const closePicker = () => {
      if (closed) return;
      closed = true;
      overlay.remove();
      if (trigger?.isConnected && typeof trigger.focus === "function") trigger.focus();
    };
    const sheet = document.createElement("section");
    sheet.className = "short-video-mobile-collection-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "加入清单");
    const header = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = "加入清单";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.addEventListener("click", closePicker);
    header.append(title, close);
    const create = createForm(async (name) => {
      const result = await collectionApi(null, "/api/short-videos/collections", { method: "POST", body: { name } });
      const collection = rememberCollectionMutation(result.collection);
      await addVideo(collection, video);
      closePicker();
    }, "创建并加入");
    const list = document.createElement("div");
    list.className = "short-video-mobile-collection-picker-list";
    sheet.append(header, create.form, create.status, list);
    overlay.append(sheet);
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
      const focusable = [...overlay.querySelectorAll("button:not([disabled]), input:not([disabled])")]
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
    });
    document.body.append(overlay);
    create.input.focus();
    try {
      const collections = await loadCollections(true);
      if (!overlay.isConnected) return;
      for (const collection of collections) {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.collectionId = collection.id;
        const name = document.createElement("span");
        name.textContent = collection.name;
        const count = document.createElement("small");
        count.textContent = `${Math.max(0, Number(collection.itemCount || 0))} 条`;
        button.append(name, count);
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await addVideo(collection, video);
            closePicker();
          } catch (error) {
            if (overlay.isConnected) {
              create.status.textContent = error?.message || "加入清单失败";
              button.disabled = false;
            }
          }
        });
        list.append(button);
      }
    } catch (error) {
      if (overlay.isConnected) create.status.textContent = error?.message || "清单读取失败";
    }
  }
  async function addVideo(collection, video) {
    const result = await collectionApi(null, `/api/short-videos/collections/${encodeURIComponent(collection.id)}/videos/${encodeURIComponent(video.id)}`, {
      method: "PUT"
    });
    if (result.added) {
      collection.itemCount = Math.max(0, Number(collection.itemCount || 0)) + 1;
      rememberCollectionMutation(collection);
    }
    shortVideoToast(result.added ? `已加入“${collection.name}”` : `已经在“${collection.name}”中`);
  }
  function rememberCollectionMutation(collection) {
    const snapshot = { ...collection };
    const collectionId = String(snapshot.id || "").trim();
    collectionMutationRevision += 1;
    pendingCollectionMutations.set(collectionId, {
      collection: snapshot,
      revision: collectionMutationRevision
    });
    const index = state.collections.findIndex((item) => String(item?.id || "").trim() === collectionId);
    if (index >= 0) state.collections[index] = snapshot;
    else state.collections.push(snapshot);
    state.loaded = true;
    return snapshot;
  }
  function rememberCollectionDeletion(collectionId) {
    const id = String(collectionId || "").trim();
    collectionMutationRevision += 1;
    pendingCollectionMutations.set(id, {
      deleted: true,
      revision: collectionMutationRevision
    });
    state.collections = state.collections.filter((collection) => String(collection?.id || "").trim() !== id);
    state.loaded = true;
  }
  function mergeCollectionRefresh(incoming, requestRevision) {
    const collections = Array.isArray(incoming) ? incoming.slice() : [];
    const indexes = new Map(collections.map((collection, index) => [String(collection?.id || "").trim(), index]));
    const deletedIds = new Set();
    for (const [collectionId, mutation] of pendingCollectionMutations) {
      if (mutation.revision <= requestRevision) {
        pendingCollectionMutations.delete(collectionId);
        continue;
      }
      if (mutation.deleted) {
        deletedIds.add(collectionId);
        continue;
      }
      const index = indexes.get(collectionId);
      if (index === undefined) {
        indexes.set(collectionId, collections.length);
        collections.push(mutation.collection);
      } else {
        collections[index] = mutation.collection;
      }
    }
    return deletedIds.size
      ? collections.filter((collection) => !deletedIds.has(String(collection?.id || "").trim()))
      : collections;
  }
  function renderCollectionActions(shell, status, data) {
    const header = shell.querySelector(".short-video-mobile-collection-header");
    const actions = document.createElement("div");
    actions.className = "short-video-mobile-collection-actions";
    const rename = document.createElement("button");
    rename.type = "button";
    rename.textContent = "重命名";
    const removeCollection = document.createElement("button");
    removeCollection.type = "button";
    removeCollection.className = "is-danger";
    removeCollection.textContent = "删除清单";
    actions.append(rename, removeCollection);
    header.append(actions);
    rename.addEventListener("click", () => {
      const existing = header.querySelector(".short-video-mobile-collection-rename input");
      if (existing) {
        existing.focus();
        return;
      }
      const form = document.createElement("form");
      form.className = "short-video-mobile-collection-rename";
      const input = document.createElement("input");
      input.maxLength = 40;
      input.value = String(data.collection?.name || "");
      input.setAttribute("aria-label", "清单名称");
      const save = document.createElement("button");
      save.type = "submit";
      save.textContent = "保存";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "取消";
      const close = () => {
        form.remove();
        if (rename.isConnected) rename.focus();
      };
      cancel.addEventListener("click", close);
      form.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || cancel.disabled) return;
        event.preventDefault();
        close();
      });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const name = input.value.trim();
        status.textContent = "";
        if (!name) {
          status.textContent = "请输入清单名称";
          input.focus();
          return;
        }
        input.disabled = true;
        save.disabled = true;
        cancel.disabled = true;
        rename.disabled = true;
        removeCollection.disabled = true;
        try {
          const result = await collectionApi(null, `/api/short-videos/collections/${encodeURIComponent(data.collection.id)}`, {
            method: "PATCH",
            body: { name }
          });
          const collection = rememberCollectionMutation(result.collection);
          data.collection = collection;
          if (isActiveCollectionRender(data)) shell.querySelector("h2").textContent = collection.name;
          shortVideoToast("清单已重命名");
          rename.disabled = false;
          removeCollection.disabled = false;
          close();
        } catch (error) {
          if (!isActiveCollectionRender(data)) return;
          rename.disabled = false;
          removeCollection.disabled = false;
          if (!form.isConnected) return;
          status.textContent = error?.message || "重命名失败";
          input.disabled = false;
          save.disabled = false;
          cancel.disabled = false;
          input.focus();
        }
      });
      form.append(input, save, cancel);
      header.append(form);
      input.focus();
      input.select();
    });
    removeCollection.addEventListener("click", async () => {
      const collection = data.collection;
      if (!collection?.id || !window.confirm(`删除清单“${collection.name}”？视频文件不会被删除。`)) {
        removeCollection.focus();
        return;
      }
      rename.disabled = true;
      removeCollection.disabled = true;
      status.textContent = "";
      try {
        await collectionApi(null, `/api/short-videos/collections/${encodeURIComponent(collection.id)}`, { method: "DELETE" });
        rememberCollectionDeletion(collection.id);
        if (state.active === data) {
          collectionRenderId += 1;
          collectionPageRequest = null;
          state.active = null;
        }
        shortVideoToast("清单已删除");
        if (!context.discardPushedView?.()) showView("shortVideoCollections", {}, { skipHistory: true, replaceHistory: true });
      } catch (error) {
        if (!isActiveCollectionRender(data)) return;
        status.textContent = error?.message || "删除清单失败";
        rename.disabled = false;
        removeCollection.disabled = false;
        removeCollection.focus();
      }
    });
  }

  function renderCollectionList(target, collections) {
    target.innerHTML = "";
    if (!collections.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-mobile-empty";
      empty.textContent = "还没有清单";
      target.append(empty);
      return;
    }
    for (const collection of collections) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-mobile-collection-row";
      button.dataset.collectionId = collection.id;
      const name = document.createElement("strong");
      name.textContent = collection.name;
      const count = document.createElement("span");
      count.textContent = `${Math.max(0, Number(collection.itemCount || 0))} 条`;
      button.append(name, count);
      button.addEventListener("click", () => showView("shortVideoCollection", { collectionId: collection.id }, { push: true }));
      target.append(button);
    }
  }

  function renderCollectionVideos(target, status, data) {
    target.innerHTML = "";
    status.textContent = "";
    const videos = Array.isArray(data.videos) ? data.videos : [];
    if (!videos.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-mobile-empty";
      empty.textContent = "这个清单还没有视频";
      target.append(empty);
      return;
    }
    const feedPath = `/api/short-videos/collections/${encodeURIComponent(data.collection.id)}/videos`;
    for (const video of videos) {
      const wrap = document.createElement("div");
      wrap.className = "short-video-mobile-collection-card";
      wrap.append(renderCard(video, {
        allowCollections: false,
        onOpen: () => openNativeShortVideoFeed(video, {
          videos,
          hasMore: data.hasMore,
          nextCursor: data.nextCursor,
          cursorBoundaries: data.cursorBoundaries,
          feedUrl: new URL(feedPath, getActiveUrl()).toString()
        })
      }));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "short-video-mobile-collection-remove";
      remove.dataset.videoId = video.id;
      remove.textContent = "移除";
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          await collectionApi(null, `${feedPath}/${encodeURIComponent(video.id)}`, { method: "DELETE" });
          data.videos = data.videos.filter((item) => item.id !== video.id);
          data.cursorBoundaries = removeCollectionCursorBoundaryVideo(data.cursorBoundaries, video.id);
          data.total = Math.max(0, Number(data.total || 0) - 1);
          const summary = state.collections.find((item) => item.id === data.collection.id);
          if (summary) {
            summary.itemCount = data.total;
            rememberCollectionMutation(summary);
          }
          renderCollectionVideos(target, status, data);
          shellMeta(data);
          shortVideoToast("已移出清单");
        } catch (error) {
          status.textContent = error?.message || "移出清单失败";
          remove.disabled = false;
        }
      });
      wrap.append(remove);
      target.append(wrap);
    }
    if (data.hasMore && data.nextCursor) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "short-video-mobile-collection-more";
      more.textContent = collectionPageRequest ? "加载中…" : "加载更多";
      more.disabled = Boolean(collectionPageRequest);
      more.addEventListener("click", () => loadMoreCollectionVideos(target, status).catch((error) => {
        if (isActiveCollectionRender(data, target)) status.textContent = error?.message || "加载更多失败";
      }));
      target.append(more);
    }
  }

  function loadMoreCollectionVideos(target, status) {
    if (collectionPageRequest) return collectionPageRequest.promise;
    const active = state.active;
    const cursor = String(active?.nextCursor || "").trim();
    if (!active?.collectionId || !active.hasMore || !cursor) return Promise.resolve(active);
    const expectedRenderId = active.renderId;
    const params = new URLSearchParams({ limit: String(COLLECTION_PAGE_LIMIT), cursor });
    const request = { promise: null, renderId: expectedRenderId };
    collectionPageRequest = request;
    request.promise = collectionApi(
      null,
      `/api/short-videos/collections/${encodeURIComponent(active.collectionId)}/videos?${params}`
    ).then((page) => {
      if (
        state.active !== active
        || expectedRenderId !== collectionRenderId
        || (active.renderGuard && !active.renderGuard())
      ) return null;
      const previousVideos = active.videos;
      active.videos = mergeUniqueVideos(previousVideos, page.videos);
      active.cursorBoundaries = appendCollectionCursorBoundary(
        active.cursorBoundaries,
        page,
        active.videos,
        previousVideos
      );
      active.total = Number(page.total || active.total || active.videos.length);
      active.hasMore = Boolean(page.hasMore);
      active.nextCursor = page.nextCursor || null;
      active.collection = page.collection || active.collection;
      renderCollectionVideos(target, status, active);
      shellMeta(active);
      return active;
    }).finally(() => {
      if (collectionPageRequest === request) collectionPageRequest = null;
      if (isActiveCollectionRender(active, target) && expectedRenderId === collectionRenderId) {
        renderCollectionVideos(target, status, active);
      }
    });
    renderCollectionVideos(target, status, active);
    return request.promise;
  }

  function shellMeta(data) {
    const shell = els.viewContent.querySelector(".short-video-mobile-collection-page");
    if (shell) shell.querySelector("p").textContent = `${Math.max(0, Number(data.total || 0))} 条 · 按加入时间排列`;
  }

  function isActiveCollectionRender(data, target = null) {
    return Boolean(
      state.active === data
      && data?.renderId === collectionRenderId
      && (!data.renderGuard || data.renderGuard())
      && (!target || target.isConnected)
    );
  }

  function createForm(onCreate, label = "创建") {
    const form = document.createElement("form");
    form.className = "short-video-mobile-collection-create";
    const input = document.createElement("input");
    input.maxLength = 40;
    input.placeholder = "新清单名称";
    input.setAttribute("aria-label", "新清单名称");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = label;
    const status = document.createElement("div");
    status.className = "short-video-mobile-collection-status";
    status.setAttribute("role", "status");
    form.append(input, submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      input.disabled = true;
      submit.disabled = true;
      status.textContent = "";
      try {
        await onCreate(input.value);
      } catch (error) {
        if (!form.isConnected) return;
        status.textContent = error?.message || "清单创建失败";
        input.disabled = false;
        submit.disabled = false;
        input.focus();
      }
    });
    return { form, input, status };
  }

  function collectionShell(titleText, description) {
    els.viewContent.innerHTML = "";
    const shell = document.createElement("section");
    shell.className = "short-video-mobile-list short-video-mobile-collection-page";
    const header = document.createElement("header");
    header.className = "short-video-mobile-collection-header";
    const title = document.createElement("h2");
    title.textContent = titleText;
    const copy = document.createElement("p");
    copy.textContent = description;
    header.append(title, copy);
    shell.append(header);
    return shell;
  }

  function configurePage(title) {
    context.setActiveBottom("shortVideos");
    els.viewKicker.textContent = "短视频";
    els.viewTitle.textContent = title;
    els.viewMeta.textContent = "";
    els.viewContent.className = "content-list short-video-mobile-content";
  }

  function deactivateCollections() {
    collectionRenderId += 1;
    collectionPageRequest = null;
    state.active = null;
  }

  return Object.freeze({
    deactivateCollections,
    renderCollection,
    renderCollections,
    showCollectionPicker
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
