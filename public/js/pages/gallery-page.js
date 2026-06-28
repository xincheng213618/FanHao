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

  function enter(options = {}) {
    if (state.gallery.mode === "cache") state.gallery.mode = "photo";
    clearPersonSelection();
    hidePersonProfile();
    setMainHeader("图库", "漫画 / 套图");
    renderGalleryStats();
    renderGalleryView();
    loadImageLibrary();
    syncRouteAfterNavigation(options);
  }

  function applyRouteState(route) {
    state.gallery.mode = route.galleryMode || "photo";
    state.gallery.photoView = route.galleryPhotoView || "albums";
    state.gallery.photoCollection = route.galleryPhotoCollection || null;
    state.gallery.query = route.galleryQuery || "";
    state.gallery.category = route.galleryCategory || "all";
    state.gallery.person = route.galleryPerson || "all";
    state.gallery.subCategory = "all";
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
    if (["western", "movie", "tv"].includes(route.galleryMode) && route.galleryMediaId) {
      await openGalleryMedia(route.galleryMediaId, { skipRoute: true });
    }
  }

  function setStatus(message) {
    state.gallery.status = message || "";
    const node = els.workGrid.querySelector(".gallery-status");
    if (node) node.textContent = state.gallery.status;
  }

  async function loadImageLibrary(options = {}) {
    if (state.gallery.loading) return;
    if (state.gallery.data && !options.refresh) {
      state.gallery.status = state.gallery.data.scannedAt ? `索引 ${formatDateTime(state.gallery.data.scannedAt)}` : state.gallery.status;
      renderGalleryStats();
      renderGalleryView();
      return;
    }
    state.gallery.loading = true;
    setStatus(options.refresh ? "正在刷新图像资料库索引" : "正在读取图像资料库");
    try {
      const data = await api(options.refresh ? "/api/image-library/rescan" : "/api/image-library", {
        method: options.refresh ? "POST" : "GET"
      });
      state.gallery.data = data;
      state.gallery.cache = data.cache || null;
      state.uiConfig = normalizeUiConfig({ ...state.uiConfig, ...(data.config || {}), ...(data.cache ? { imageReaderCacheMaxBytes: data.cache.maxBytes } : {}) });
      state.gallery.status = data.scannedAt ? `索引 ${formatDateTime(data.scannedAt)}` : "";
      state.gallery.loading = false;
      renderGalleryStats();
      renderGalleryView();
    } catch (error) {
      state.gallery.loading = false;
      setStatus(error.message || "图像资料库读取失败");
      renderGalleryView();
    } finally {
      state.gallery.loading = false;
    }
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

  async function openPhotoSet(albumId, options = {}) {
    setStatus("正在读取图包");
    try {
      const data = await api(`/api/photo-sets/${encodeURIComponent(albumId)}`);
      resetReader();
      state.gallery.album = data.album;
      state.gallery.cache = data.cache || state.gallery.cache;
      renderGalleryStats();
      renderGalleryView();
      syncRouteAfterNavigation(options);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setStatus(error.message || "图包读取失败");
    }
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
    loadImageLibrary,
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
