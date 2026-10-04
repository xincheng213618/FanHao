const DEFAULT_GALLERY_PHOTO_CATEGORY = "all";
const IMAGE_LIBRARY_PAGE_LIMIT = 5000;
const IMAGE_LIBRARY_REBASE_ATTEMPTS = 3;
const PHOTO_READER_LIMITS = {
  local: 160,
  lan: 160,
  remote: 24,
  fallback: 48
};

export function createGalleryPage(deps) {
  const {
    api,
    clearPersonSelection,
    els,
    formatDateTime,
    galleryModeLabel,
    hidePersonProfile,
    normalizeUiConfig,
    pushRoute,
    renderGalleryStats,
    renderGalleryView,
    replaceRoute,
    setMainHeader,
    state,
    syncRouteAfterNavigation
  } = deps;

  let imageListRequestVersion = 0;
  let imageListRequest = null;
  let listRefreshHandler = null;
  let librarySummaryTimer = 0;
  let readerGeneration = 0;
  let readerOwner = null;
  let readerStatusRequest = null;
  let photoPageRequest = null;
  let photoFullRequest = null;

  function enter(options = {}) {
    if (state.gallery.mode === "cache") state.gallery.mode = "photo";
    clearPersonSelection();
    hidePersonProfile();
    const imageModule = ["photo", "manga"].includes(state.gallery.mode);
    setMainHeader(imageModule ? "图库" : galleryModeLabel(state.gallery.mode), imageModule ? "套图和韩漫" : "本地媒体");
    renderGalleryStats();
    renderGalleryView();
    window.clearTimeout(librarySummaryTimer);
    if (imageModule) {
      void loadImageLibrary();
    } else {
      librarySummaryTimer = window.setTimeout(() => {
        librarySummaryTimer = 0;
        void loadImageLibrary();
      }, 1000);
    }
    syncRouteAfterNavigation(options);
  }

  function applyRouteState(route) {
    cancelImageLibraryListRequest();
    state.gallery.mode = route.galleryMode || "photo";
    state.gallery.photoView = state.gallery.mode === "photo" && route.galleryPhotoView !== "albums" ? "collections" : "albums";
    state.gallery.photoCollection = route.galleryPhotoCollection || null;
    state.gallery.query = route.galleryQuery || "";
    state.gallery.mediaKind = state.gallery.mode === "media" ? route.galleryMediaKind || "all" : "all";
    state.gallery.category = route.galleryCategory || (state.gallery.mode === "photo" ? DEFAULT_GALLERY_PHOTO_CATEGORY : "all");
    state.gallery.subCategory = route.gallerySubCategory || "all";
    state.gallery.person = route.galleryPerson || "all";
    state.gallery.seriesKey = ["media", "tv"].includes(state.gallery.mode) ? route.gallerySeriesKey || "" : "";
    state.gallery.photoDate = route.galleryPhotoDate || "all";
    state.gallery.sort = route.gallerySort || "updated";
    state.gallery.visibleLimit = 80;
    resetReader();
  }

  async function openRouteTarget(route) {
    if (route.galleryMode === "photo" && route.galleryAlbumId) {
      await openPhotoSet(route.galleryAlbumId, { skipRoute: true });
      return;
    }
    if (route.galleryMode === "manga" && route.galleryComicId) {
      await openMangaComic(route.galleryComicId, {
        chapterIndex: route.galleryChapterIndex,
        skipRoute: true
      });
      return;
    }
    if (["western", "media", "movie", "tv"].includes(route.galleryMode) && route.galleryMediaId) {
      await openGalleryMedia(route.galleryMediaId, { skipRoute: true });
    }
  }

  function setStatus(message) {
    state.gallery.status = message || "";
    const node = els.workGrid.querySelector(".gallery-status");
    if (node) node.textContent = state.gallery.status;
  }

  function hasUnsubmittedGallerySearchDraft() {
    const active = document.activeElement;
    if (!active?.classList?.contains("gallery-search")) return false;
    return String(active.value || "").trim() !== String(state.gallery.query || "").trim();
  }

  function refreshGalleryAfterLibraryChange(options = {}) {
    if (state.activeView !== "gallery") return;
    renderGalleryStats();
    if (hasReaderIntent()) {
      listRefreshHandler?.({ loading: false });
      setStatus(state.gallery.status);
      return;
    }
    if (listRefreshHandler?.(options)) {
      setStatus(state.gallery.status);
      return;
    }
    if (!hasUnsubmittedGallerySearchDraft()) {
      renderGalleryView(options);
    } else {
      setStatus(state.gallery.status);
    }
  }

  function hasReaderIntent() {
    return Boolean(state.gallery.album || state.gallery.comic || state.gallery.media
      || readerStatusRequest && readerRequestCurrent(readerOwner));
  }

  function setListRefreshHandler(handler) {
    listRefreshHandler = typeof handler === "function" ? handler : null;
  }

  function cancelImageLibraryListRequest() {
    imageListRequest?.controller.abort();
    imageListRequest = null;
    imageListRequestVersion += 1;
    state.gallery.listLoadingKey = "";
  }

  async function loadImageLibrary(options = {}) {
    if (state.gallery.loading) return;
    if (state.gallery.data && !options.refresh && !options.reload) {
      state.gallery.status = state.gallery.data.scannedAt ? `索引 ${formatDateTime(state.gallery.data.scannedAt)}` : state.gallery.status;
      refreshGalleryAfterLibraryChange({ preserveScroll: true });
      return;
    }
    state.gallery.loading = true;
    setStatus(options.refresh ? "正在刷新图像资料库索引" : "正在读取图像资料库");
    try {
      const summaryEndpoint = isImageLibraryMode() ? "/api/image-library/summary" : "/api/image-library/summary?cache=0";
      const data = await api(options.refresh ? "/api/image-library/rescan" : summaryEndpoint, {
        method: options.refresh ? "POST" : "GET"
      });
      state.gallery.data = data;
      state.gallery.cache = data.cache || null;
      state.uiConfig = normalizeUiConfig({ ...state.uiConfig, ...(data.config || {}), ...(data.cache ? { imageReaderCacheMaxBytes: data.cache.maxBytes } : {}) });
      state.gallery.status = data.scannedAt ? `索引 ${formatDateTime(data.scannedAt)}` : "";
      state.gallery.loading = false;
      refreshGalleryAfterLibraryChange({ preserveScroll: true });
    } catch (error) {
      state.gallery.loading = false;
      setStatus(error.message || "图像资料库读取失败");
      refreshGalleryAfterLibraryChange({ preserveScroll: true });
    } finally {
      state.gallery.loading = false;
    }
  }

  function isImageLibraryMode() {
    return ["photo", "manga"].includes(state.gallery.mode);
  }

  function imageLibraryListKey() {
    if (!["photo", "manga", "western", "media", "movie", "tv"].includes(state.gallery.mode)) return "";
    return JSON.stringify({
      mode: state.gallery.mode,
      mediaKind: state.gallery.mode === "media" ? state.gallery.mediaKind || "all" : "",
      photoView: state.gallery.mode === "photo" ? state.gallery.photoCollection ? "albums" : state.gallery.photoView || "collections" : "",
      collection: state.gallery.mode === "photo" ? state.gallery.photoCollection || "" : "",
      category: state.gallery.mode === "manga" ? "" : state.gallery.category || "all",
      subCategory: state.gallery.mode === "photo" ? state.gallery.subCategory || "all" : "",
      person: ["photo", "western", "media", "tv"].includes(state.gallery.mode) ? state.gallery.person || "all" : "",
      seriesKey: ["media", "tv"].includes(state.gallery.mode) ? state.gallery.seriesKey || "" : "",
      date: state.gallery.mode === "photo" ? state.gallery.photoDate || "all" : "",
      query: state.gallery.query || "",
      sort: ["photo", "media", "movie"].includes(state.gallery.mode) ? state.gallery.sort || "updated" : ""
    });
  }

  function imageLibraryListPath(options = {}) {
    const collectionIndex = state.gallery.mode === "photo" && !state.gallery.photoCollection && state.gallery.photoView === "collections";
    const selectedSeries = ["media", "tv"].includes(state.gallery.mode) && (state.gallery.seriesKey || state.gallery.person && state.gallery.person !== "all");
    const query = String(state.gallery.query || "").trim();
    const params = new URLSearchParams({
      mode: state.gallery.mode,
      limit: String(Math.max(1, Number(options.limit || state.gallery.visibleLimit || 80))),
      offset: String(Math.max(0, Number(options.offset || 0))),
      sort: query ? "relevance" : selectedSeries ? "title" : state.gallery.sort || "updated"
    });
    if (query) params.set("q", query);
    if (state.gallery.mode === "photo") {
      params.set("photoView", state.gallery.photoCollection ? "albums" : state.gallery.photoView || "collections");
      if (state.gallery.category && state.gallery.category !== "all") params.set("category", state.gallery.category);
      if (state.gallery.subCategory && state.gallery.subCategory !== "all") params.set("subCategory", state.gallery.subCategory);
      if (state.gallery.person && state.gallery.person !== "all") params.set("person", state.gallery.person);
      if (state.gallery.photoDate && state.gallery.photoDate !== "all") params.set("date", state.gallery.photoDate);
      if (state.gallery.photoCollection) params.set("collection", state.gallery.photoCollection);
    } else if (["western", "media", "movie", "tv"].includes(state.gallery.mode)) {
      if (state.gallery.mode === "media" && state.gallery.mediaKind && state.gallery.mediaKind !== "all") params.set("kind", state.gallery.mediaKind);
      if (state.gallery.category && state.gallery.category !== "all") params.set("category", state.gallery.category);
      if (["media", "tv"].includes(state.gallery.mode) && state.gallery.seriesKey) {
        params.set("seriesKey", state.gallery.seriesKey);
      } else if (["western", "media", "tv"].includes(state.gallery.mode) && state.gallery.person && state.gallery.person !== "all") {
        params.set("person", state.gallery.person);
      }
    }
    return `/api/image-library/items?${params.toString()}`;
  }

  function imageLibraryListNeedsLoad() {
    const key = imageLibraryListKey();
    if (!key || state.gallery.list?.key !== key) return Boolean(key);
    const loaded = Array.isArray(state.gallery.list.items) ? state.gallery.list.items.length : 0;
    if (state.gallery.list.hasMore === false || Number(state.gallery.list.rawLoaded ?? loaded) >= Number(state.gallery.list.total ?? Infinity)) return false;
    const target = Math.min(Math.max(1, Number(state.gallery.visibleLimit || 80)), Number(state.gallery.list.total || loaded));
    return loaded < target;
  }

  function isImageLibraryListLoading() {
    return Boolean(state.gallery.listLoadingKey && state.gallery.listLoadingKey === imageLibraryListKey());
  }

  function sameImageLibraryRevision(left, right) {
    const leftRevision = String(left?.listRevision || "");
    const rightRevision = String(right?.listRevision || "");
    if (leftRevision || rightRevision) return Boolean(leftRevision && leftRevision === rightRevision);
    return String(left?.scannedAt || "") === String(right?.scannedAt || "");
  }

  function imageLibraryNextOffset(data, offset) {
    const fallback = offset + (Array.isArray(data.items) ? data.items.length : 0);
    return Number.isSafeInteger(data.nextOffset) && data.nextOffset >= fallback ? data.nextOffset : fallback;
  }

  async function reloadImageLibraryPrefix(path, target, request, isCurrent, firstPage = null) {
    const [endpoint, query] = path.split("?");
    for (let attempt = 0; attempt < IMAGE_LIBRARY_REBASE_ATTEMPTS; attempt += 1) {
      let prefix = null;
      let offset = 0;
      let items = [];
      let hasMore = true;
      if (attempt === 0 && firstPage) {
        items = mergeImageLibraryListItems([], Array.isArray(firstPage.items) ? firstPage.items : []);
        offset = imageLibraryNextOffset(firstPage, 0);
        const total = Number(firstPage.total ?? offset);
        hasMore = firstPage.items?.length > 0 && offset < total;
        prefix = { ...firstPage, items, rawLoaded: offset, total, hasMore };
        if (offset >= target || !hasMore) return prefix;
      }
      while (offset < target && hasMore) {
        if (!isCurrent()) return null;
        const params = new URLSearchParams(query);
        params.set("offset", String(offset));
        params.set("limit", String(Math.min(IMAGE_LIBRARY_PAGE_LIMIT, target - offset)));
        const data = await api(`${endpoint}?${params}`, { signal: request.controller.signal });
        if (!isCurrent()) return null;
        if (prefix && !sameImageLibraryRevision(prefix, data)) break;
        const incoming = Array.isArray(data.items) ? data.items : [];
        items = mergeImageLibraryListItems(items, incoming);
        offset = imageLibraryNextOffset(data, offset);
        const total = Number(data.total ?? offset);
        hasMore = incoming.length > 0 && offset < total;
        prefix = { ...data, items, rawLoaded: offset, total, hasMore };
        if (offset >= target || !hasMore) return prefix;
      }
    }
    throw new Error("图库列表持续变化，请稍后重试");
  }

  async function loadImageLibraryItems(options = {}) {
    const key = imageLibraryListKey();
    if (!key) return null;
    const currentList = state.gallery.list?.key === key ? state.gallery.list : null;
    const targetCount = Math.max(1, Number(state.gallery.visibleLimit || 80));
    const loadedCount = Array.isArray(currentList?.items) ? currentList.items.length : 0;
    const rawLoaded = Math.max(loadedCount, Number(currentList?.rawLoaded || 0));
    const knownTotal = Number(currentList?.total || 0);
    const hasKnownTotal = currentList && Number.isFinite(Number(currentList.total));
    if (!options.force && currentList && (loadedCount >= targetCount || currentList.hasMore === false || (hasKnownTotal && rawLoaded >= knownTotal))) return currentList;
    if (!options.force && state.gallery.listLoadingKey === key) return null;

    const offset = options.force ? 0 : rawLoaded;
    const requestLimit = Math.min(IMAGE_LIBRARY_PAGE_LIMIT, Math.max(1, targetCount - (options.force ? 0 : loadedCount)));
    const requestPath = imageLibraryListPath({ limit: requestLimit, offset });

    imageListRequest?.controller.abort();
    const requestVersion = ++imageListRequestVersion;
    const request = { controller: new AbortController(), key, version: requestVersion };
    imageListRequest = request;
    const isCurrent = () => imageListRequest === request && requestVersion === imageListRequestVersion
      && !request.controller.signal.aborted && key === imageLibraryListKey() && state.activeView === "gallery";
    state.gallery.listLoadingKey = key;
    state.gallery.listError = "";
    state.gallery.listErrorKey = "";
    if (!listRefreshHandler?.({ loading: true }) && options.renderStart !== false && !hasUnsubmittedGallerySearchDraft()) renderGalleryView({ preserveScroll: true });

    try {
      let data = await api(requestPath, { signal: request.controller.signal });
      if (!isCurrent()) return null;
      const prefixTarget = Math.max(targetCount, rawLoaded);
      const reloadingPrefix = offset === 0 && imageLibraryNextOffset(data, 0) < prefixTarget
        && Array.isArray(data.items) && data.items.length > 0 && imageLibraryNextOffset(data, 0) < Number(data.total ?? Infinity);
      const rebased = reloadingPrefix || offset > 0 && !sameImageLibraryRevision(currentList, data);
      if (rebased) {
        data = await reloadImageLibraryPrefix(requestPath, reloadingPrefix ? prefixTarget : offset + requestLimit, request, isCurrent, reloadingPrefix ? data : null);
        if (!data || !isCurrent()) return null;
      }
      const incoming = Array.isArray(data.items) ? data.items : [];
      const items = mergeImageLibraryListItems(offset > 0 && !rebased ? currentList?.items : [], incoming);
      const nextRawLoaded = rebased ? data.rawLoaded : imageLibraryNextOffset(data, offset);
      const nextTotal = Number(data.total ?? currentList?.total ?? nextRawLoaded);
      state.gallery.list = {
        ...(currentList || {}),
        ...data,
        items,
        count: items.length,
        limit: items.length,
        offset: 0,
        rawLoaded: nextRawLoaded,
        total: nextTotal,
        hasMore: (rebased ? data.hasMore : incoming.length > 0) && nextRawLoaded < nextTotal,
        key
      };
      state.gallery.listLoadingKey = "";
      state.gallery.listError = "";
      state.gallery.listErrorKey = "";
      if (!hasReaderIntent()) state.gallery.status = data.scannedAt ? `索引 ${formatDateTime(data.scannedAt)}` : state.gallery.status;
      refreshGalleryAfterLibraryChange({ preserveScroll: true, listChanged: true, previousList: currentList });
      return state.gallery.list;
    } catch (error) {
      if (!isCurrent()) return null;
      state.gallery.listLoadingKey = "";
      state.gallery.listError = error.message || "图库列表读取失败";
      state.gallery.listErrorKey = key;
      if (hasReaderIntent()) {
        listRefreshHandler?.({ loading: false });
        return null;
      }
      setStatus(state.gallery.listError);
      if (!listRefreshHandler?.({ loading: false }) && !hasUnsubmittedGallerySearchDraft()) renderGalleryView({ preserveScroll: true });
      return null;
    } finally {
      if (imageListRequest === request) imageListRequest = null;
    }
  }

  function mergeImageLibraryListItems(existing = [], incoming = []) {
    const merged = new Map();
    for (const item of [...(existing || []), ...(incoming || [])]) {
      const id = String(item?.id || item?.collectionId || item?.routePath || "");
      const key = `${String(item?.type || "")}:${id}`;
      // Missing identity retains the response and uses the renderer's full fallback.
      if (id) merged.set(key, item);
      else merged.set(item, item);
    }
    return [...merged.values()];
  }

  function clearReaderState() {
    state.gallery.album = null;
    state.gallery.comic = null;
    state.gallery.chapter = null;
    state.gallery.media = null;
  }

  function beginReaderRequest(type, id) {
    readerOwner?.controller.abort();
    const owner = { generation: ++readerGeneration, mode: state.gallery.mode, type, id, controller: new AbortController() };
    readerOwner = owner;
    photoPageRequest = null;
    photoFullRequest = null;
    readerStatusRequest = null;
    return owner;
  }

  function readerRequestCurrent(owner, albumId = "") {
    return Boolean(owner && owner === readerOwner && owner.generation === readerGeneration && !owner.controller.signal.aborted
      && state.activeView === "gallery" && state.gallery.mode === owner.mode
      && (!albumId || owner.type === "photo" && owner.id === albumId && state.gallery.album?.id === albumId));
  }

  function setReaderRequestStatus(owner, request, message) {
    if (!readerRequestCurrent(owner)) return;
    readerStatusRequest = request;
    setStatus(message);
  }

  function clearReaderRequestStatus(owner, request) {
    if (!readerRequestCurrent(owner) || readerStatusRequest !== request) return;
    readerStatusRequest = null;
    setStatus("");
  }

  function resetReader() {
    readerOwner?.controller.abort();
    readerGeneration += 1;
    readerOwner = null;
    photoPageRequest = null;
    photoFullRequest = null;
    if (readerStatusRequest) setStatus("");
    readerStatusRequest = null;
    clearReaderState();
  }

  function syncRoute(mode = "push") {
    if (state.activeView !== "gallery") return;
    if (mode === "replace") replaceRoute();
    else pushRoute();
  }

  function galleryListReturnPath() {
    if (state.gallery.mode === "movie") return "/movies";
    if (state.gallery.mode === "tv") return "/tv";
    if (state.gallery.mode === "media") return "/media";
    return "/media";
  }

  async function openPhotoSet(albumId, options = {}) {
    const owner = beginReaderRequest("photo", albumId);
    setReaderRequestStatus(owner, owner, "正在读取套图");
    try {
      const data = await api(photoSetPath(albumId, { imageLimit: photoReaderInitialLimit() }), { signal: owner.controller.signal });
      if (!readerRequestCurrent(owner)) return null;
      clearReaderState();
      state.gallery.album = data.album;
      state.gallery.cache = data.cache || state.gallery.cache;
      clearReaderRequestStatus(owner, owner);
      renderGalleryStats();
      renderGalleryView();
      syncRouteAfterNavigation(options);
      window.scrollTo({ top: 0, behavior: "smooth" });
      return state.gallery.album;
    } catch (error) {
      if (readerRequestCurrent(owner)) setReaderRequestStatus(owner, owner, error.message || "套图读取失败");
      return null;
    }
  }

  function photoSetPath(albumId, options = {}) {
    const params = new URLSearchParams();
    if (options.imageLimit === "all") {
      params.set("imageLimit", "all");
    } else if (Number.isFinite(Number(options.imageLimit)) && Number(options.imageLimit) > 0) {
      params.set("imageLimit", String(Math.floor(Number(options.imageLimit))));
    }
    if (Number(options.imageOffset) > 0) params.set("imageOffset", String(Math.floor(Number(options.imageOffset))));
    const query = params.toString();
    return `/api/photo-sets/${encodeURIComponent(albumId)}${query ? `?${query}` : ""}`;
  }

  function photoReaderInitialLimit() {
    const mode = String(state.accessMode || "").trim();
    if (mode === "local" || mode === "lan") return PHOTO_READER_LIMITS[mode];
    if (mode === "remote") return PHOTO_READER_LIMITS.remote;
    return PHOTO_READER_LIMITS.fallback;
  }

  function mergePhotoReaderImages(existing = [], incoming = []) {
    const merged = new Map();
    for (const image of [...existing, ...incoming]) {
      const key = Number(image?.index || 0) > 0 ? `index:${Number(image.index)}` : `url:${String(image?.url || image?.name || "")}`;
      if (key !== "url:") merged.set(key, image);
    }
    return [...merged.values()].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  }

  function loadPhotoReaderImages(limit) {
    const owner = readerOwner;
    const album = state.gallery.album;
    if (!album?.id || !readerRequestCurrent(owner, album.id)) return Promise.resolve(null);
    if (photoPageRequest?.owner === owner) return photoPageRequest.promise;
    const currentImages = Array.isArray(album.images) ? album.images : [];
    const totalCount = Math.max(Number(album.imageCount || 0), currentImages.length);
    if (currentImages.length >= totalCount) return Promise.resolve(album);
    const batchSize = photoReaderInitialLimit();
    const requestedTotal = Math.max(currentImages.length + batchSize, Math.floor(Number(limit || 0)) || 0);
    const nextLimit = Math.min(totalCount - currentImages.length, requestedTotal - currentImages.length);
    const request = { owner, albumId: album.id, promise: null };
    photoPageRequest = request;
    setReaderRequestStatus(owner, request, "正在继续读取图片");
    request.promise = (async () => {
      try {
        const data = await api(photoSetPath(album.id, { imageLimit: nextLimit, imageOffset: currentImages.length }), { signal: owner.controller.signal });
        if (!readerRequestCurrent(owner, album.id)) return null;
        const nextAlbum = data.album || {};
        const images = mergePhotoReaderImages(currentImages, nextAlbum.images || []);
        state.gallery.album = { ...state.gallery.album, ...nextAlbum, images, imageOffset: 0, imageLimit: images.length,
          imagesTruncated: images.length < Math.max(Number(nextAlbum.imageCount || 0), totalCount) };
        state.gallery.cache = data.cache || state.gallery.cache;
        return state.gallery.album;
      } catch (error) {
        if (!readerRequestCurrent(owner, album.id)) return null;
        throw error;
      } finally {
        if (photoPageRequest === request) photoPageRequest = null;
        clearReaderRequestStatus(owner, request);
      }
    })();
    return request.promise;
  }

  function fullPhotoReaderImages(album = state.gallery.album) {
    const owner = readerOwner;
    if (!album?.id || !readerRequestCurrent(owner, album.id)) return Promise.resolve([]);
    const currentAlbum = state.gallery.album;
    const images = Array.isArray(currentAlbum.images) ? currentAlbum.images : [];
    const total = Number(currentAlbum.imageCount || images.length || 0);
    if (images.length >= total) return Promise.resolve(images);
    if (Array.isArray(currentAlbum.fullImages) && currentAlbum.fullImages.length >= total) return Promise.resolve(currentAlbum.fullImages);
    if (photoFullRequest?.owner === owner) return photoFullRequest.promise;
    const request = { owner, promise: null };
    photoFullRequest = request;
    request.promise = (async () => {
      try {
        const data = await api(photoSetPath(album.id, { imageLimit: "all" }), { signal: owner.controller.signal });
        if (!readerRequestCurrent(owner, album.id)) return [];
        const fullImages = Array.isArray(data.album?.images) ? data.album.images : images;
        state.gallery.album.fullImages = fullImages;
        return fullImages;
      } catch (error) {
        if (!readerRequestCurrent(owner, album.id)) return [];
        throw error;
      } finally {
        if (photoFullRequest === request) photoFullRequest = null;
      }
    })();
    return request.promise;
  }

  async function openMangaComic(comicId, options = {}) {
    const owner = beginReaderRequest("manga", comicId);
    setReaderRequestStatus(owner, owner, "正在读取漫画目录");
    try {
      const data = await api(`/api/manga/${encodeURIComponent(comicId)}`, { signal: owner.controller.signal });
      if (!readerRequestCurrent(owner)) return;
      clearReaderState();
      state.gallery.comic = data.comic;
      state.gallery.cache = data.cache || state.gallery.cache;
      const firstChapter = data.comic?.chapters?.[0]?.index;
      const chapterIndex = options.chapterIndex || firstChapter;
      if (chapterIndex !== undefined && chapterIndex !== null && String(chapterIndex) !== "") {
        await openMangaChapter(chapterIndex, { keepComic: true, skipRoute: options.skipRoute, replaceRoute: options.replaceRoute, readerOwner: owner });
      } else {
        clearReaderRequestStatus(owner, owner);
        renderGalleryView();
        syncRouteAfterNavigation(options);
      }
      if (readerRequestCurrent(owner)) window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      if (readerRequestCurrent(owner)) setReaderRequestStatus(owner, owner, error.message || "漫画读取失败");
    }
  }

  async function openMangaChapter(chapterIndex, options = {}) {
    const comic = state.gallery.comic;
    if (!comic) return;
    const owner = options.readerOwner || beginReaderRequest("manga", comic.id);
    if (!readerRequestCurrent(owner)) return;
    const request = {};
    setReaderRequestStatus(owner, request, "正在读取章节");
    try {
      const data = await api(`/api/manga/${encodeURIComponent(comic.id)}/chapters/${encodeURIComponent(String(chapterIndex))}`, { signal: owner.controller.signal });
      if (!readerRequestCurrent(owner) || state.gallery.comic?.id !== comic.id) return;
      if (!options.keepComic) state.gallery.comic = { ...comic, ...(data.comic || {}) };
      state.gallery.chapter = data.chapter;
      state.gallery.cache = data.cache || state.gallery.cache;
      clearReaderRequestStatus(owner, request);
      renderGalleryStats();
      renderGalleryView();
      syncRouteAfterNavigation(options);
    } catch (error) {
      if (readerRequestCurrent(owner) && state.gallery.comic?.id === comic.id) setReaderRequestStatus(owner, request, error.message || "章节读取失败");
    }
  }

  async function openGalleryMedia(mediaId, options = {}) {
    const owner = beginReaderRequest("media", mediaId);
    setReaderRequestStatus(owner, owner, `正在读取${galleryModeLabel(state.gallery.mode)}`);
    try {
      const data = await api(`/api/gallery-media/${encodeURIComponent(mediaId)}`, { signal: owner.controller.signal });
      if (!readerRequestCurrent(owner)) return;
      if (["movie", "tv", "anime"].includes(data.item?.mediaKind)) {
        const params = new URLSearchParams({ mediaId: String(data.item.id || mediaId) });
        params.set("returnTo", galleryListReturnPath());
        window.location.href = `/player.html?${params.toString()}`;
        return;
      }
      clearReaderState();
      state.gallery.media = data.item;
      clearReaderRequestStatus(owner, owner);
      renderGalleryView();
      syncRouteAfterNavigation(options);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      if (readerRequestCurrent(owner)) setReaderRequestStatus(owner, owner, error.message || "媒体读取失败");
    }
  }

  return {
    applyRouteState,
    enter,
    imageLibraryListKey,
    imageLibraryListNeedsLoad,
    isImageLibraryListLoading,
    loadImageLibrary,
    loadImageLibraryItems,
    loadPhotoReaderImages,
    fullPhotoReaderImages,
    openGalleryMedia,
    openMangaChapter,
    openMangaComic,
    openPhotoSet,
    openRouteTarget,
    resetReader,
    setStatus,
    setListRefreshHandler,
    syncRoute
  };
}
