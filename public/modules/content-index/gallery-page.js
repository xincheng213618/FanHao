const DEFAULT_GALLERY_PHOTO_CATEGORY = "all";
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

  function enter(options = {}) {
    if (state.gallery.mode === "cache") state.gallery.mode = "photo";
    clearPersonSelection();
    hidePersonProfile();
    const imageModule = ["photo", "manga"].includes(state.gallery.mode);
    setMainHeader(imageModule ? "图库" : galleryModeLabel(state.gallery.mode), imageModule ? "套图和韩漫" : "本地媒体");
    renderGalleryStats();
    renderGalleryView();
    loadImageLibrary();
    syncRouteAfterNavigation(options);
  }

  function applyRouteState(route) {
    state.gallery.mode = route.galleryMode || "photo";
    state.gallery.photoView = state.gallery.mode === "photo" && route.galleryPhotoView !== "albums" ? "collections" : "albums";
    state.gallery.photoCollection = route.galleryPhotoCollection || null;
    state.gallery.query = route.galleryQuery || "";
    state.gallery.category = route.galleryCategory || (state.gallery.mode === "photo" ? DEFAULT_GALLERY_PHOTO_CATEGORY : "all");
    state.gallery.subCategory = route.gallerySubCategory || "all";
    state.gallery.person = route.galleryPerson || "all";
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

  function refreshGalleryAfterLibraryChange() {
    renderGalleryStats();
    if (!hasUnsubmittedGallerySearchDraft()) {
      renderGalleryView();
    } else {
      setStatus(state.gallery.status);
    }
  }

  async function loadImageLibrary(options = {}) {
    if (state.gallery.loading) return;
    if (state.gallery.data && !options.refresh && !options.reload) {
      state.gallery.status = state.gallery.data.scannedAt ? `索引 ${formatDateTime(state.gallery.data.scannedAt)}` : state.gallery.status;
      refreshGalleryAfterLibraryChange();
      return;
    }
    state.gallery.loading = true;
    setStatus(options.refresh ? "正在刷新图像资料库索引" : "正在读取图像资料库");
    try {
      const imageModule = isImageLibraryMode();
      const endpoint = imageModule ? "/api/image-library/summary" : "/api/image-library";
      const data = await api(options.refresh ? "/api/image-library/rescan" : endpoint, {
        method: options.refresh ? "POST" : "GET"
      });
      state.gallery.data = data;
      state.gallery.cache = data.cache || null;
      state.uiConfig = normalizeUiConfig({ ...state.uiConfig, ...(data.config || {}), ...(data.cache ? { imageReaderCacheMaxBytes: data.cache.maxBytes } : {}) });
      state.gallery.status = data.scannedAt ? `索引 ${formatDateTime(data.scannedAt)}` : "";
      state.gallery.loading = false;
      refreshGalleryAfterLibraryChange();
    } catch (error) {
      state.gallery.loading = false;
      setStatus(error.message || "图像资料库读取失败");
      if (!hasUnsubmittedGallerySearchDraft()) renderGalleryView();
    } finally {
      state.gallery.loading = false;
    }
  }

  function isImageLibraryMode() {
    return ["photo", "manga"].includes(state.gallery.mode);
  }

  function imageLibraryListKey() {
    if (!isImageLibraryMode()) return "";
    return JSON.stringify({
      mode: state.gallery.mode,
      photoView: state.gallery.mode === "photo" ? state.gallery.photoCollection ? "albums" : state.gallery.photoView || "collections" : "",
      collection: state.gallery.mode === "photo" ? state.gallery.photoCollection || "" : "",
      category: state.gallery.mode === "photo" ? state.gallery.category || "all" : "",
      subCategory: state.gallery.mode === "photo" ? state.gallery.subCategory || "all" : "",
      person: state.gallery.mode === "photo" ? state.gallery.person || "all" : "",
      query: state.gallery.query || ""
    });
  }

  function imageLibraryListPath(options = {}) {
    const collectionIndex = state.gallery.mode === "photo" && !state.gallery.photoCollection && state.gallery.photoView === "collections";
    const query = String(state.gallery.query || "").trim();
    const params = new URLSearchParams({
      mode: state.gallery.mode,
      limit: String(Math.max(1, Number(options.limit || state.gallery.visibleLimit || 80))),
      offset: String(Math.max(0, Number(options.offset || 0))),
      sort: query ? "relevance" : collectionIndex ? "count" : state.gallery.sort || "updated"
    });
    if (query) params.set("q", query);
    if (state.gallery.mode === "photo") {
      params.set("photoView", state.gallery.photoCollection ? "albums" : state.gallery.photoView || "collections");
      if (state.gallery.category && state.gallery.category !== "all") params.set("category", state.gallery.category);
      if (state.gallery.subCategory && state.gallery.subCategory !== "all") params.set("subCategory", state.gallery.subCategory);
      if (state.gallery.person && state.gallery.person !== "all") params.set("person", state.gallery.person);
      if (state.gallery.photoCollection) params.set("collection", state.gallery.photoCollection);
    }
    return `/api/image-library/items?${params.toString()}`;
  }

  function imageLibraryListNeedsLoad() {
    const key = imageLibraryListKey();
    if (!key || state.gallery.list?.key !== key) return Boolean(key);
    const loaded = Array.isArray(state.gallery.list.items) ? state.gallery.list.items.length : 0;
    const target = Math.min(Math.max(1, Number(state.gallery.visibleLimit || 80)), Number(state.gallery.list.total || loaded));
    return loaded < target;
  }

  function isImageLibraryListLoading() {
    return Boolean(state.gallery.listLoadingKey && state.gallery.listLoadingKey === imageLibraryListKey());
  }

  async function loadImageLibraryItems(options = {}) {
    if (!isImageLibraryMode()) return null;
    const key = imageLibraryListKey();
    if (!key) return null;
    const currentList = state.gallery.list?.key === key ? state.gallery.list : null;
    const targetCount = Math.max(1, Number(state.gallery.visibleLimit || 80));
    const loadedCount = Array.isArray(currentList?.items) ? currentList.items.length : 0;
    const knownTotal = Number(currentList?.total || 0);
    const hasKnownTotal = currentList && Number.isFinite(Number(currentList.total));
    if (!options.force && currentList && (loadedCount >= targetCount || (hasKnownTotal && loadedCount >= knownTotal))) return currentList;
    if (!options.force && state.gallery.listLoadingKey === key) return null;

    const offset = options.force ? 0 : loadedCount;
    const requestLimit = Math.max(1, targetCount - offset);

    const requestVersion = ++imageListRequestVersion;
    state.gallery.listLoadingKey = key;
    state.gallery.listError = "";
    state.gallery.listErrorKey = "";
    if (options.renderStart !== false && !hasUnsubmittedGallerySearchDraft()) renderGalleryView();

    try {
      const data = await api(imageLibraryListPath({ limit: requestLimit, offset }));
      if (requestVersion !== imageListRequestVersion || key !== imageLibraryListKey()) return null;
      const items = offset > 0 ? mergeImageLibraryListItems(currentList?.items, data.items) : Array.isArray(data.items) ? data.items : [];
      state.gallery.list = {
        ...(currentList || {}),
        ...data,
        items,
        count: items.length,
        limit: items.length,
        offset: 0,
        key
      };
      state.gallery.listLoadingKey = "";
      state.gallery.listError = "";
      state.gallery.listErrorKey = "";
      state.gallery.status = data.scannedAt ? `索引 ${formatDateTime(data.scannedAt)}` : state.gallery.status;
      refreshGalleryAfterLibraryChange();
      return state.gallery.list;
    } catch (error) {
      if (requestVersion !== imageListRequestVersion || key !== imageLibraryListKey()) return null;
      state.gallery.listLoadingKey = "";
      state.gallery.listError = error.message || "图库列表读取失败";
      state.gallery.listErrorKey = key;
      setStatus(state.gallery.listError);
      if (!hasUnsubmittedGallerySearchDraft()) renderGalleryView();
      return null;
    }
  }

  function mergeImageLibraryListItems(existing = [], incoming = []) {
    const merged = new Map();
    for (const item of [...(existing || []), ...(incoming || [])]) {
      const key = `${String(item?.type || "")}:${String(item?.id || item?.collectionId || item?.routePath || "")}`;
      if (key !== ":") merged.set(key, item);
    }
    return [...merged.values()];
  }

  function resetReader() {
    state.gallery.album = null;
    state.gallery.comic = null;
    state.gallery.chapter = null;
    state.gallery.media = null;
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
    setStatus("正在读取套图");
    try {
      const data = await api(photoSetPath(albumId, { imageLimit: photoReaderInitialLimit() }));
      resetReader();
      state.gallery.album = data.album;
      state.gallery.cache = data.cache || state.gallery.cache;
      renderGalleryStats();
      renderGalleryView();
      syncRouteAfterNavigation(options);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setStatus(error.message || "套图读取失败");
    }
  }

  function photoSetPath(albumId, options = {}) {
    const params = new URLSearchParams();
    if (options.imageLimit === "all") {
      params.set("imageLimit", "all");
    } else if (Number.isFinite(Number(options.imageLimit)) && Number(options.imageLimit) > 0) {
      params.set("imageLimit", String(Math.floor(Number(options.imageLimit))));
    }
    const query = params.toString();
    return `/api/photo-sets/${encodeURIComponent(albumId)}${query ? `?${query}` : ""}`;
  }

  function photoReaderInitialLimit() {
    const mode = String(state.accessMode || "").trim();
    if (mode === "local" || mode === "lan") return PHOTO_READER_LIMITS[mode];
    if (mode === "remote") return PHOTO_READER_LIMITS.remote;
    return PHOTO_READER_LIMITS.fallback;
  }

  async function openMangaComic(comicId, options = {}) {
    setStatus("正在读取漫画目录");
    try {
      const data = await api(`/api/manga/${encodeURIComponent(comicId)}`);
      resetReader();
      state.gallery.comic = data.comic;
      state.gallery.cache = data.cache || state.gallery.cache;
      const firstChapter = data.comic?.chapters?.[0]?.index;
      const chapterIndex = options.chapterIndex || firstChapter;
      if (chapterIndex !== undefined && chapterIndex !== null && String(chapterIndex) !== "") {
        await openMangaChapter(chapterIndex, { keepComic: true, skipRoute: options.skipRoute, replaceRoute: options.replaceRoute });
      } else {
        renderGalleryView();
        syncRouteAfterNavigation(options);
      }
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setStatus(error.message || "漫画读取失败");
    }
  }

  async function openMangaChapter(chapterIndex, options = {}) {
    const comic = state.gallery.comic;
    if (!comic) return;
    setStatus("正在读取章节");
    try {
      const data = await api(`/api/manga/${encodeURIComponent(comic.id)}/chapters/${encodeURIComponent(String(chapterIndex))}`);
      if (!options.keepComic) state.gallery.comic = { ...comic, ...(data.comic || {}) };
      state.gallery.chapter = data.chapter;
      state.gallery.cache = data.cache || state.gallery.cache;
      renderGalleryStats();
      renderGalleryView();
      syncRouteAfterNavigation(options);
    } catch (error) {
      setStatus(error.message || "章节读取失败");
    }
  }

  async function openGalleryMedia(mediaId, options = {}) {
    setStatus(`正在读取${galleryModeLabel(state.gallery.mode)}`);
    try {
      const data = await api(`/api/gallery-media/${encodeURIComponent(mediaId)}`);
      if (["movie", "tv"].includes(data.item?.mediaKind)) {
        const params = new URLSearchParams({ mediaId: String(data.item.id || mediaId) });
        params.set("returnTo", galleryListReturnPath());
        window.location.href = `/player.html?${params.toString()}`;
        return;
      }
      resetReader();
      state.gallery.media = data.item;
      renderGalleryView();
      syncRouteAfterNavigation(options);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setStatus(error.message || "媒体读取失败");
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
    openGalleryMedia,
    openMangaChapter,
    openMangaComic,
    openPhotoSet,
    openRouteTarget,
    resetReader,
    setStatus,
    syncRoute
  };
}
