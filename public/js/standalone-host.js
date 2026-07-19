import { createApiClient } from "./api.js?v=20260701-gallery-merge-01";
import { installAndroidClientReturn, isLocalHostName, prepareClientShell } from "./client-shell.js?v=20260712-project-refactor-03";
import { normalizeRoute, routeFromUrl, routeUrl } from "./router.js?v=20260717-photo-library-workspace-01";

const MODULE_VIEWS = new Set(["gallery", "novels", "music", "tools"]);
const TXT_TOOL_MAX_FILE_BYTES = 24 * 1024 * 1024;
const formatter = new Intl.NumberFormat("zh-CN");

export async function bootStandaloneApp() {
  const initialParams = new URLSearchParams(window.location.search);
  const initialRoute = normalizeRoute(routeFromUrl());
  if (!MODULE_VIEWS.has(initialRoute.view)) {
    window.location.replace("/fanhao");
    return;
  }

  const isAndroidClient = initialParams.get("client") === "android";
  const api = createApiClient({ isAndroidClient });
  const state = createStandaloneState(initialRoute.view);
  const els = createElementIndex();
  const pages = await loadCurrentModule(initialRoute.view);
  const host = createHost({ api, els, initialParams, pages, state });

  prepareClientShell();
  document.documentElement.classList.toggle("android-client", isAndroidClient);
  document.body.classList.add("standalone-module-view");
  host.syncBodyClasses();
  installAndroidClientReturn({ isAndroidClient, initialParams });
  host.installHistory();
  await host.applyRoute(initialRoute);
  host.initializeHistory();
}

async function loadCurrentModule(view) {
  if (view === "gallery") {
    const [pageModule, rendererModule] = await Promise.all([
      import("../modules/content-index/gallery-page.js?v=20260717-photo-library-workspace-01"),
      import("../modules/content-index/gallery-renderer.js?v=20260718-photo-gesture-parser-03")
    ]);
    return {
      createPage: pageModule.createGalleryPage,
      createRenderer: rendererModule.createGalleryRenderer,
      view
    };
  }
  if (view === "novels") {
    const module = await import("../modules/novels/novel-page.js?v=20260712-project-refactor-03");
    return { createPage: module.createNovelPage, view };
  }
  if (view === "music") {
    const module = await import("../modules/music/music-page.js?v=20260712-project-refactor-03");
    return { createPage: module.createMusicPage, view };
  }
  const module = await import("../modules/tools/tools-page.js?v=20260712-project-refactor-03");
  return { createPage: module.createToolsPage, view };
}

function createHost({ api, els, initialParams, pages, state }) {
  let page = null;
  let galleryRenderer = null;
  let adminModalPromise = null;
  let routeApplication = Promise.resolve();

  const shared = {
    api,
    cancelScheduledWorkRendering: noop,
    disconnectPeopleIndexAutoload: noop,
    els,
    formatBytes,
    formatDateTime,
    formatNumber,
    hidePersonProfile,
    openAdminScript,
    pushRoute,
    replaceRoute,
    resetProgressiveCoverLoading: noop,
    setMainHeader,
    state,
    syncRouteAfterNavigation,
    writeStoredFlag
  };

  if (pages.view === "gallery") {
    galleryRenderer = pages.createRenderer({
      ...shared,
      getGalleryPage: () => page,
      includesText
    });
    page = pages.createPage({
      ...shared,
      clearPersonSelection: () => {
        state.selectedPersonId = null;
        state.selectedPerson = null;
        state.works = [];
        state.personWorksTotal = 0;
        state.personWorksFacets = null;
      },
      galleryModeLabel: galleryRenderer.modeLabel,
      normalizeUiConfig,
      renderGalleryStats: galleryRenderer.renderStats,
      renderGalleryView: galleryRenderer.renderView
    });
  } else if (pages.view === "tools") {
    page = pages.createPage({
      ...shared,
      toastInline,
      txtToolMaxFileBytes: TXT_TOOL_MAX_FILE_BYTES
    });
  } else {
    page = pages.createPage(shared);
  }

  function currentRouteSnapshot(overrides = {}) {
    const route = { view: state.activeView };
    if (state.activeView === "gallery") {
      Object.assign(route, {
        galleryMode: state.gallery.mode || "photo",
        galleryPhotoView: state.gallery.photoView || "collections",
        galleryPhotoCollection: state.gallery.photoCollection || "",
        galleryAlbumId: state.gallery.album?.id || "",
        galleryComicId: state.gallery.comic?.id || "",
        galleryChapterIndex: String(state.gallery.chapter?.index || ""),
        galleryMediaId: state.gallery.media?.id || "",
        galleryQuery: state.gallery.query || "",
        galleryMediaKind: state.gallery.mediaKind || "all",
        galleryCategory: state.gallery.category || "all",
        gallerySubCategory: state.gallery.subCategory || "all",
        galleryPerson: state.gallery.person || "all",
        galleryPhotoDate: state.gallery.photoDate || "all",
        gallerySort: state.gallery.sort || "updated"
      });
    } else if (state.activeView === "novels") {
      Object.assign(route, {
        novelBookId: state.novel.chapter?.bookId || state.novel.book?.id || "",
        novelChapterIndex: String(state.novel.chapter?.index || ""),
        novelQuery: state.novel.query || "",
        novelCategory: state.novel.category || "all",
        novelSort: state.novel.sort || "updated",
        novelMode: state.novel.mode || "books",
        novelAuthor: state.novel.author || "",
        novelPage: Math.max(0, Number(state.novel.page || 0))
      });
    } else if (state.activeView === "music") {
      Object.assign(route, {
        musicTrackId: state.music.trackPageOpen ? state.music.current?.id || "" : "",
        musicArtistId: state.music.artistId !== "all" ? state.music.artistId || "" : "",
        musicAlbumId: state.music.albumId !== "all" ? state.music.albumId || "" : "",
        musicGenre: state.music.genre !== "all" ? state.music.genre || "" : "",
        musicLanguage: state.music.language !== "all" ? state.music.language || "" : "",
        musicMode: state.music.mode || "home",
        musicPlaylistId: state.music.mode === "playlist" ? state.music.activePlaylistId || "" : "",
        musicSmartId: state.music.mode === "smart" ? state.music.activeSmartPlaylistId || "" : "",
        musicQuery: state.music.query || "",
        musicSort: state.music.sort || "album",
        musicArtistSort: state.music.artistSort || "count",
        musicAlbumSort: state.music.albumSort || "updated",
        musicFavorite: Boolean(state.music.favorite)
      });
    }
    return normalizeRoute({ ...route, ...overrides });
  }

  function writeRoute(overrides = {}, mode = "push") {
    if (!state.routeReady || !window.history?.pushState) return;
    if (state.restoringRoute && mode !== "replace") return;
    syncBodyClasses();
    const next = currentRouteSnapshot(overrides);
    const url = routeUrl(next, { initialParams });
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash || ""}`;
    const historyState = { standaloneRoute: true, ...next };
    if (mode === "replace" || url === currentUrl) {
      window.history.replaceState(historyState, "", url);
    } else {
      window.history.pushState(historyState, "", url);
    }
  }

  function pushRoute(overrides = {}) {
    writeRoute(overrides, "push");
  }

  function replaceRoute(overrides = {}) {
    writeRoute(overrides, "replace");
  }

  function syncRouteAfterNavigation(options = {}) {
    syncBodyClasses();
    if (options.skipRoute) return;
    if (options.replaceRoute) replaceRoute(options.routeOverrides || {});
    else pushRoute(options.routeOverrides || {});
  }

  function applyRoute(route) {
    const next = normalizeRoute(route);
    const run = routeApplication.catch(() => {}).then(() => applyRouteNow(next));
    routeApplication = run;
    return run;
  }

  async function applyRouteNow(route) {
    const next = normalizeRoute(route);
    if (next.view !== state.activeView) {
      window.location.assign(routeUrl(next, { initialParams }));
      return;
    }
    state.restoringRoute = true;
    try {
      syncBodyClasses();
      if (state.activeView === "gallery") {
        page.applyRouteState(next);
        syncBodyClasses();
        page.enter({ skipRoute: true });
        await page.openRouteTarget(next);
      } else if (state.activeView === "novels") {
        page.applyRouteState(next);
        page.enter({ skipRoute: true, deferInitialLoad: true });
        await page.openRouteTarget(next);
      } else if (state.activeView === "music") {
        page.applyRouteState(next);
        page.enter({ skipRoute: true, deferInitialLoad: true });
        await page.openRouteTarget(next);
      } else {
        hidePersonProfile();
        setMainHeader("小工具", "离线小游戏 / TXT 文档处理");
        page.renderStats();
        page.renderView();
      }
    } finally {
      state.restoringRoute = false;
      syncBodyClasses();
    }
  }

  function initializeHistory() {
    if (state.routeReady) return;
    state.routeReady = true;
    replaceRoute();
  }

  function installHistory() {
    window.addEventListener("popstate", () => {
      applyRoute(routeFromUrl()).catch(renderFatalError);
    });
  }

  function syncBodyClasses() {
    const view = state.activeView;
    document.body.classList.toggle("gallery-view", view === "gallery");
    document.body.classList.toggle("gallery-photo-view", view === "gallery" && ["photo", "manga"].includes(state.gallery.mode));
    document.body.classList.toggle("gallery-media-view", view === "gallery" && ["media", "movie", "tv"].includes(state.gallery.mode));
    document.body.classList.toggle("novel-view", view === "novels");
    document.body.classList.toggle("novel-reader-active", view === "novels" && Boolean(state.novel?.chapter));
    document.body.classList.toggle("music-view", view === "music");
    document.body.classList.toggle("tools-view", view === "tools");
  }

  function openAdminScript(scriptId = "", options = {}) {
    getStandaloneAdmin().then((admin) => {
      admin.openModal({
        scriptId,
        scriptDefaults: options.defaults || options.scriptDefaults || {}
      });
    }).catch((error) => {
      console.error("[standalone-admin]", error);
      window.location.assign("/admin");
    });
  }

  function getStandaloneAdmin() {
    if (!adminModalPromise) adminModalPromise = createStandaloneAdmin({ api, els, page, state });
    return adminModalPromise;
  }

  return {
    applyRoute,
    initializeHistory,
    installHistory,
    syncBodyClasses
  };
}

async function createStandaloneAdmin({ api, els, page, state }) {
  const { createAdminModal } = await import("../modules/system/admin-modal.js?v=20260712-module-settings-02");
  const admin = createAdminModal({
    api,
    displayPersonName: (person) => person?.actorProfile?.displayName || person?.name || "",
    els,
    formatBytes,
    formatDateTime,
    formatNumber,
    loadFavorites: noopAsync,
    loadHistory: noopAsync,
    loadImageLibrary: (options) => state.activeView === "gallery" ? page.loadImageLibrary(options) : noopAsync(),
    loadLibrary: noopAsync,
    loadMusic: (options) => state.activeView === "music" ? page.loadMusic(options) : noopAsync(),
    loadNovels: (options) => state.activeView === "novels" ? page.loadNovels(options) : noopAsync(),
    loadRankings: noopAsync,
    normalizeUiConfig,
    personWorkPageSize: () => 0,
    renderMeta: noop,
    renderPeopleIndex: noop,
    renderPeopleIndexStats: noop,
    renderPlayer: noop,
    renderWorks: noop,
    resetWorkPaging: noop,
    selectPerson: noopAsync,
    state,
    updateWorkSnapshot: noop
  });

  els.closeAdmin?.addEventListener("click", admin.closeModal);
  els.adminBackdrop?.addEventListener("click", admin.closeModal);
  els.adminRescanPerson?.addEventListener("click", admin.rescanSelectedPerson);
  els.adminRefreshActor?.addEventListener("click", admin.refreshActorMovies);
  els.adminRefreshRankings?.addEventListener("click", admin.refreshRankings);
  els.adminPreviewActorAvatars?.addEventListener("click", admin.previewActorAvatarCandidates);
  els.adminImportActorAvatars?.addEventListener("click", admin.importActorAvatars);
  els.adminGenerateCovers?.addEventListener("click", admin.generateMissingCovers);
  els.adminScriptForm?.addEventListener("submit", admin.runSelectedScript);
  els.adminRefreshScripts?.addEventListener("click", admin.loadScripts);
  els.adminScriptCategory?.addEventListener("change", () => {
    state.adminScriptCategory = els.adminScriptCategory.value || "all";
    admin.renderScripts();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && els.adminModal?.classList.contains("open")) admin.closeModal();
  });
  return admin;
}

function createStandaloneState(view) {
  return {
    activeView: view,
    accessMode: isLocalHostName(window.location.hostname) ? "local" : "lan",
    people: [],
    selectedPersonId: null,
    selectedPerson: null,
    works: [],
    personWorksTotal: 0,
    personWorksFacets: null,
    uiConfig: defaultUiConfig(),
    routeReady: false,
    restoringRoute: false,
    handledAdminTaskIds: new Set(),
    adminTasks: [],
    adminScripts: [],
    adminScriptCategories: [],
    selectedAdminScriptId: "",
    adminScriptCategory: "all",
    rankingLists: [],
    gallery: {
      mode: "photo",
      photoView: "collections",
      photoCollection: null,
      query: "",
      mediaKind: "all",
      category: "all",
      subCategory: "all",
      person: "all",
      photoDate: "all",
      sort: "updated",
      visibleLimit: 80,
      loading: false,
      data: null,
      list: null,
      listLoadingKey: "",
      listError: "",
      listErrorKey: "",
      cache: null,
      comic: null,
      chapter: null,
      album: null,
      media: null,
      fitWidth: readStoredFlag("fanhao.gallery.fitWidth", true),
      status: ""
    },
    novel: {},
    music: {},
    txtTool: {
      fileName: "",
      fileSize: 0,
      fileBase64: "",
      text: "",
      indent: readStoredFlag("fanhao.txtTool.indent", true),
      cleanJunk: readStoredFlag("fanhao.txtTool.cleanJunk", true),
      processing: false,
      result: null,
      status: ""
    }
  };
}

function createElementIndex() {
  const entries = {
    currentPath: document.querySelector("#currentPath"),
    currentTitle: document.querySelector("#currentTitle"),
    personProfile: document.querySelector("#personProfile"),
    statsRow: document.querySelector("#statsRow"),
    workGrid: document.querySelector("#workGrid")
  };
  const adminIds = [
    "adminBackdrop", "adminModal", "closeAdmin", "adminPersonSelect", "adminRescanPerson",
    "adminRefreshActor", "adminRefreshRankings", "adminPreviewActorAvatars",
    "adminImportActorAvatars", "adminActorAvatarCandidates", "adminCoverLimit", "adminGenerateCovers",
    "adminCoverStatus", "adminStatus", "adminTaskList", "adminScriptCount",
    "adminRunningCount", "adminDoneCount", "adminErrorCount", "adminScriptCategory", "adminRefreshScripts",
    "adminScriptList", "adminScriptForm", "adminSelectedScriptCategory", "adminSelectedScriptTitle",
    "adminSelectedScriptRuntime", "adminSelectedScriptDescription", "adminScriptFields", "adminRunScript",
    "adminScriptStatus"
  ];
  for (const id of adminIds) entries[id] = document.querySelector(`#${id}`);
  return entries;
}

function setMainHeader(title, pathText) {
  const currentTitle = document.querySelector("#currentTitle");
  const currentPath = document.querySelector("#currentPath");
  if (currentTitle) currentTitle.textContent = title;
  if (currentPath) currentPath.textContent = pathText;
}

function hidePersonProfile() {
  const profile = document.querySelector("#personProfile");
  if (profile) {
    profile.hidden = true;
    profile.innerHTML = "";
  }
}

function formatNumber(value) {
  return formatter.format(value || 0);
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes) || 0;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function includesText(value, query) {
  return String(value || "").toLowerCase().includes(String(query || "").trim().toLowerCase());
}

function toastInline(button, message, restoreText = "") {
  if (!button) return;
  const original = restoreText || button.textContent;
  button.textContent = message;
  window.setTimeout(() => {
    if (button.isConnected) button.textContent = original;
  }, 1500);
}

function readStoredFlag(key, fallback = false) {
  try {
    const value = window.localStorage?.getItem(key);
    if (value === "1") return true;
    if (value === "0") return false;
  } catch {}
  return fallback;
}

function writeStoredFlag(key, value) {
  try {
    window.localStorage?.setItem(key, value ? "1" : "0");
  } catch {}
}

function defaultUiConfig() {
  return {
    compilationPrefixes: ["OFJE", "THN", "THU"],
    compilationKeywords: ["合集", "総集編", "総集", "コンプリート", "全タイトル", "ベスト盤"],
    actorAvatarDataPath: "",
    imageReaderCacheMaxBytes: 2 * 1024 * 1024 * 1024
  };
}

function normalizeUiConfig(config = {}) {
  const fallback = defaultUiConfig();
  const input = config && typeof config === "object" ? config : {};
  return {
    compilationPrefixes: uniqueLines(input.compilationPrefixes, fallback.compilationPrefixes),
    compilationKeywords: uniqueLines(input.compilationKeywords, fallback.compilationKeywords),
    actorAvatarDataPath: String(input.actorAvatarDataPath || "").trim(),
    imageReaderCacheMaxBytes: normalizeCacheBytes(input.imageReaderCacheMaxBytes, fallback.imageReaderCacheMaxBytes)
  };
}

function uniqueLines(values, fallback) {
  const result = [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))];
  return result.length ? result : fallback;
}

function normalizeCacheBytes(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed <= 0) return 0;
  return Math.max(128 * 1024 * 1024, Math.min(200 * 1024 * 1024 * 1024, Math.floor(parsed)));
}

function renderFatalError(error) {
  console.error(error);
  const grid = document.querySelector("#workGrid");
  if (!grid) return;
  grid.innerHTML = "";
  const message = document.createElement("div");
  message.className = "empty-state";
  message.textContent = error?.message || "模块加载失败";
  grid.append(message);
}

function noop() {}
async function noopAsync() {}
