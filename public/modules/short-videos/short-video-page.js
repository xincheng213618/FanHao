import { createShortVideoSearchModule } from "./search/index.js?v=20260710-short-video-search-01";

export function createShortVideoPage(deps) {
  const {
    api,
    cancelScheduledWorkRendering,
    disconnectPeopleIndexAutoload,
    els,
    formatBytes,
    formatNumber,
    hidePersonProfile,
    pushRoute,
    replaceRoute,
    resetProgressiveCoverLoading,
    setMainHeader,
    state,
    syncRouteAfterNavigation
  } = deps;

  let wheelLocked = false;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchDeltaX = 0;
  let touchDeltaY = 0;
  let touchHorizontalDragging = false;
  let touchLastX = 0;
  let touchLastY = 0;
  let touchLastAt = 0;
  let touchVelocityX = 0;
  let touchVelocityY = 0;
  let touchControlInteraction = false;
  let pointerStartX = 0;
  let pointerStartY = 0;
  let pointerDeltaX = 0;
  let pointerDeltaY = 0;
  let pointerHorizontalDragging = false;
  let pointerDragging = false;
  let pointerLastX = 0;
  let pointerLastY = 0;
  let pointerLastAt = 0;
  let pointerVelocityX = 0;
  let pointerVelocityY = 0;
  let suppressNextPlayerClick = false;
  let holdSpeedGestureConsumed = false;
  let holdSpeedGestureBlockUntil = 0;
  let wheelDeltaY = 0;
  let wheelLastAt = 0;
  let wheelResetTimer = 0;
  let reelDragRaf = 0;
  let reelDragDeltaY = 0;
  let reelBoundaryPulseRaf = 0;
  let reelBoundaryPulseTimer = 0;
  let reelBoundaryResetTimer = 0;
  let wheelIgnoreUntil = 0;
  let wheelGestureConsumed = false;
  let wheelGestureStartedAt = 0;
  let queuedAdjacentDirection = 0;
  let eventsInstalled = false;
  let playerClickTimer = 0;
  let pendingPlayerTap = null;
  let loadMoreObserver = null;
  let coverLoadObserver = null;
  let coverLoadTimer = null;
  const coverLoadQueue = [];
  const initialVideoLimit = 48;
  const appendVideoLimit = 72;
  const coverEagerCount = 18;
  const coverLoadBatchSize = 10;
  const coverLoadBatchDelay = 70;
  const SV_FEED_MIN_COL = 320;
  const SV_AUTHOR_MIN_COL = 176;
  const SV_COL_GAP = 10;
  const SV_ROW_GAP = 14;
  const SV_BUFFER_ROWS = 12;
  const SV_APPEND_LOOKAHEAD_ROWS = 18;
  const AUTHOR_INITIAL_COUNT = 240;
  const AUTHOR_APPEND_COUNT = 240;
  const AUTHOR_APPEND_LOOKAHEAD = 900;
  const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  let svCols = 0;
  let svCardW = 0;
  let svCardH = 0;
  let svRowH = 0;
  let svReady = false;
  let svStart = 0;
  let svEnd = 0;
  let svGridEl = null;
  let svInnerEl = null;
  let svScrollRaf = 0;
  let authorPanelReturnFeed = null;
  let authorPanelVideoRequestId = 0;
  let authorPanelVideoCache = null;
  let authorPanelTileMap = null;
  let shortVideoAdjacentRequestId = 0;
  let shortVideoOpenRequestId = 0;
  let shortVideoOpeningId = "";
  let shortVideoOpenError = "";
  let shortVideoNavigationPrefetchTimer = 0;
  let shortVideoVisibilitySnapshot = null;
  const loadedCoverIds = new Set();
  const shortVideoWatchWrites = new Map();
  const shortVideoDetailCache = new Map();
  const shortVideoResolvedDetailCache = new Map();
  const shortVideoNavigationCache = new Map();
  const shortVideoVideoCache = new Map();
  const shortVideoVideoPrefetches = new Map();
  const shortVideoMediaPrefetches = new Map();
  const SHORT_VIDEO_WATCH_SAVE_INTERVAL = 4000;
  const SHORT_VIDEO_GALLERY_ADVANCE_MS = 3000;
  const SHORT_VIDEO_GALLERY_GESTURE_HINT_MS = 3200;
  const SHORT_VIDEO_GALLERY_GESTURE_HINT_KEY = "fanhao.shortVideo.galleryGestureHintSeen";
  const SHORT_VIDEO_NAV_CACHE_LIMIT = 32;
  const SHORT_VIDEO_NEIGHBOR_CACHE_LIMIT = 96;
  const SHORT_VIDEO_DETAIL_NEIGHBOR_LIMIT = 2;
  const SHORT_VIDEO_SWIPE_DISTANCE = 44;
  const SHORT_VIDEO_WHEEL_DISTANCE = 82;
  const SHORT_VIDEO_SWITCH_ANIMATION_MS = 220;
  const SHORT_VIDEO_SWITCH_MIN_ANIMATION_MS = 112;
  const SHORT_VIDEO_SWITCH_MAX_ANIMATION_MS = 232;
  const SHORT_VIDEO_SWITCH_PRIME_TIMEOUT_MS = 200;
  const SHORT_VIDEO_BOUNDARY_RESISTANCE = 0.3;
  const SHORT_VIDEO_BOUNDARY_RANGE = 180;
  const SHORT_VIDEO_HOLD_ARM_MOVE_TOLERANCE = 12;
  const SHORT_VIDEO_HOLD_ACTIVE_MOVE_TOLERANCE = 26;
  const SHORT_VIDEO_DOUBLE_TAP_WINDOW_MS = 520;
  const WHEEL_GESTURE_IDLE_MS = 220;
  const WHEEL_NEW_GESTURE_GAP_MS = 160;
  const shortVideoSearch = createShortVideoSearchModule({
    api,
    createIcon,
    getState: () => state.shortVideo,
    onSearch: commitShortVideoSearch
  });

  function ensureState() {
    if (!state.shortVideo) state.shortVideo = {};
    state.shortVideo.query = state.shortVideo.query || "";
    state.shortVideo.topic = normalizeShortVideoTopic(state.shortVideo.topic);
    state.shortVideo.sound = normalizeShortVideoSound(state.shortVideo.sound);
    state.shortVideo.soundInfo = state.shortVideo.soundInfo && typeof state.shortVideo.soundInfo === "object" ? state.shortVideo.soundInfo : null;
    state.shortVideo.author = state.shortVideo.author || "all";
    state.shortVideo.authorPage = state.shortVideo.authorPage || "";
    state.shortVideo.media = normalizeShortVideoMedia(state.shortVideo.media);
    state.shortVideo.source = normalizeShortVideoSource(state.shortVideo.source);
    state.shortVideo.sort = normalizeShortVideoSortValue(state.shortVideo.sort);
    state.shortVideo.data = state.shortVideo.data || null;
    state.shortVideo.summary = state.shortVideo.summary || null;
    state.shortVideo.authors = Array.isArray(state.shortVideo.authors) ? state.shortVideo.authors : [];
    state.shortVideo.authorDetail = state.shortVideo.authorDetail && typeof state.shortVideo.authorDetail === "object"
      ? state.shortVideo.authorDetail
      : null;
    state.shortVideo.authorVideo = state.shortVideo.authorVideo && typeof state.shortVideo.authorVideo === "object"
      ? state.shortVideo.authorVideo
      : null;
    state.shortVideo.facetsLoaded = Boolean(state.shortVideo.facetsLoaded);
    state.shortVideo.facetsLoading = Boolean(state.shortVideo.facetsLoading);
    state.shortVideo.summaryLoading = Boolean(state.shortVideo.summaryLoading);
    state.shortVideo.current = state.shortVideo.current || null;
    state.shortVideo.prevVideo = state.shortVideo.prevVideo || null;
    state.shortVideo.nextVideo = state.shortVideo.nextVideo || null;
    state.shortVideo.dragging = Boolean(state.shortVideo.dragging);
    if (typeof state.shortVideo.muted !== "boolean") {
      state.shortVideo.muted = readMutedPreference();
    }
    state.shortVideo.volume = normalizeShortVideoVolume(
      state.shortVideo.volume ?? readVolumePreference()
    );
    if (typeof state.shortVideo.autoNext !== "boolean") {
      state.shortVideo.autoNext = readAutoNextPreference();
    }
    state.shortVideo.playbackRate = normalizePlaybackRate(
      state.shortVideo.playbackRate ?? readPlaybackRatePreference()
    );
    state.shortVideo.prevId = state.shortVideo.prevId || "";
    state.shortVideo.nextId = state.shortVideo.nextId || "";
    state.shortVideo.slideDirection = Number(state.shortVideo.slideDirection || 0);
    state.shortVideo.loading = Boolean(state.shortVideo.loading);
    state.shortVideo.loadingMore = Boolean(state.shortVideo.loadingMore);
    state.shortVideo.status = state.shortVideo.status || "";
    state.shortVideo.authorVisibleCount = clampNumber(state.shortVideo.authorVisibleCount, AUTHOR_INITIAL_COUNT, AUTHOR_INITIAL_COUNT, 100000);
    state.shortVideo.deleteMode = Boolean(state.shortVideo.deleteMode);
    if (!(state.shortVideo.deleteSelection instanceof Set)) {
      state.shortVideo.deleteSelection = new Set(Array.isArray(state.shortVideo.deleteSelection) ? state.shortVideo.deleteSelection : []);
    }
    installBrowseEvents();
  }

  function enter(options = {}) {
    ensureState();
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.works = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    hidePersonProfile();
    disconnectPeopleIndexAutoload();
    cancelScheduledWorkRendering();
    resetProgressiveCoverLoading();
    setMainHeader("短视频", "抖音点赞本地库");
    setBodyClass();
    renderStats();
    if (options.deferInitialLoad) {
      renderView();
      return;
    }
    if (!state.shortVideo.data || options.reload) {
      loadVideos({ skipRoute: true }).catch(showError);
    } else {
      renderView();
      loadShortVideoSummary().catch(handleSummaryLoadError);
    }
    syncRouteAfterNavigation(options);
  }

  function applyRouteState(route = {}) {
    ensureState();
    const nextAuthorPage = route.shortVideoAuthorPage || "";
    if (state.shortVideo.authorPage && state.shortVideo.authorPage !== nextAuthorPage) {
      state.shortVideo.authorDetail = null;
      state.shortVideo.authorVideo = null;
    }
    state.shortVideo.query = route.shortVideoQuery || "";
    state.shortVideo.topic = normalizeShortVideoTopic(route.shortVideoTopic);
    state.shortVideo.sound = normalizeShortVideoSound(route.shortVideoSound);
    if (!state.shortVideo.sound) state.shortVideo.soundInfo = null;
    state.shortVideo.authorPage = nextAuthorPage;
    state.shortVideo.author = state.shortVideo.authorPage || route.shortVideoAuthor || "all";
    state.shortVideo.media = normalizeShortVideoMedia(route.shortVideoMedia);
    state.shortVideo.source = normalizeShortVideoSource(route.shortVideoSource);
    state.shortVideo.sort = normalizeShortVideoSortValue(route.shortVideoSort);
    if (state.shortVideo.source === "recommended" && state.shortVideo.sort === "published") {
      state.shortVideo.sort = "recommended";
    } else if (state.shortVideo.source === "history" && state.shortVideo.sort === "published") {
      state.shortVideo.sort = "watched";
    }
  }

  async function openRouteTarget(route = {}) {
    ensureState();
    if (route.shortVideoId) {
      await openVideo(route.shortVideoId, { skipRoute: true });
      return;
    }
    shortVideoOpenRequestId += 1;
    shortVideoOpeningId = "";
    shortVideoOpenError = "";
    if (route.shortVideoAuthorPage) {
      state.shortVideo.authorPage = route.shortVideoAuthorPage;
      state.shortVideo.author = route.shortVideoAuthorPage;
    }
    state.shortVideo.current = null;
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    state.shortVideo.prevId = "";
    state.shortVideo.nextId = "";
    await loadVideos({ skipRoute: true });
  }

  async function loadVideos(options = {}) {
    ensureState();
    const append = Boolean(options.append);
    if (isShortVideoAuthorIndexPage()) {
      if (append) return;
      state.shortVideo.current = null;
      state.shortVideo.prevVideo = null;
      state.shortVideo.nextVideo = null;
      state.shortVideo.prevId = "";
      state.shortVideo.nextId = "";
      state.shortVideo.data = null;
      state.shortVideo.loading = !state.shortVideo.facetsLoaded;
      state.shortVideo.status = state.shortVideo.loading ? "正在读取作者" : "";
      renderView();
      await loadShortVideoFacets();
      state.shortVideo.loading = false;
      state.shortVideo.status = "";
      renderStats();
      renderView();
      if (!options.skipRoute) {
        const writer = options.replaceRoute ? replaceRoute : pushRoute;
        writer({ view: "shortVideos", shortVideoId: "" });
      }
      return;
    }
    if (append && (state.shortVideo.loading || state.shortVideo.loadingMore || !state.shortVideo.data?.hasMore)) return;
    if (append) {
      state.shortVideo.loadingMore = true;
    } else {
      state.shortVideo.loading = true;
      state.shortVideo.status = "正在读取短视频";
    }
    if (!options.keepCurrent) {
      state.shortVideo.current = null;
      state.shortVideo.prevVideo = null;
      state.shortVideo.nextVideo = null;
      state.shortVideo.prevId = "";
      state.shortVideo.nextId = "";
    }
    if (!append) renderView();
    const params = new URLSearchParams();
    if (state.shortVideo.query) params.set("q", state.shortVideo.query);
    if (state.shortVideo.topic) params.set("topic", state.shortVideo.topic);
    if (state.shortVideo.sound) params.set("sound", state.shortVideo.sound);
    if (state.shortVideo.author && state.shortVideo.author !== "all") params.set("author", state.shortVideo.author);
    if (state.shortVideo.media && state.shortVideo.media !== "all") params.set("media", state.shortVideo.media);
    params.set("source", shortVideoApiSource());
    params.set("sort", state.shortVideo.sort || "published");
    params.set("limit", String(append ? appendVideoLimit : initialVideoLimit));
    params.set("facets", "0");
    params.set("stats", "0");
    if (append) params.set("offset", String(state.shortVideo.data?.videos?.length || 0));
    const data = await api(`/api/short-videos?${params}`);
    if (append && state.shortVideo.data) {
      const seen = new Set((state.shortVideo.data.videos || []).map((video) => video.id));
      const merged = [...(state.shortVideo.data.videos || [])];
      for (const video of data.videos || []) {
        if (seen.has(video.id)) continue;
        seen.add(video.id);
        merged.push(video);
      }
      state.shortVideo.data = { ...data, videos: merged, offset: 0, limit: merged.length };
    } else {
      state.shortVideo.data = data;
    }
    if (!isShortVideoAuthorDetailPage()) {
      state.shortVideo.source = normalizeShortVideoSource(data.source || state.shortVideo.source);
    }
    state.shortVideo.topic = normalizeShortVideoTopic(data.topic || state.shortVideo.topic);
    state.shortVideo.sound = normalizeShortVideoSound(data.sound || state.shortVideo.sound);
    if (state.shortVideo.sound) {
      state.shortVideo.soundInfo = (data.videos || []).find((video) => video?.sound?.key === state.shortVideo.sound)?.sound || state.shortVideo.soundInfo;
    }
    state.shortVideo.media = normalizeShortVideoMedia(data.media || state.shortVideo.media);
    if (Array.isArray(data.authors) && data.authors.length) state.shortVideo.authors = data.authors;
    state.shortVideo.summary = data.summary || state.shortVideo.summary;
    state.shortVideo.loading = false;
    state.shortVideo.loadingMore = false;
    state.shortVideo.status = data.total
      ? ""
      : (state.shortVideo.source === "following"
        ? "还没有关注的作者。打开任一作品，点击头像下方的加号即可关注。"
        : state.shortVideo.source === "history"
          ? "还没有观看记录。打开视频或图文后会自动出现在这里。"
          : state.shortVideo.source === "recommended"
            ? "暂时没有推荐内容。可以在全部作品中撤销“不感兴趣”。"
        : "还没有短视频。");
    renderStats();
    if (append) {
      renderShortVideoWindow(false);
      scheduleShortVideoWindowUpdate();
    } else {
      renderView();
    }
    if (!options.skipRoute) {
      const writer = options.replaceRoute ? replaceRoute : pushRoute;
      writer({ view: "shortVideos", shortVideoId: "" });
    }
    if (!append) loadShortVideoSummary().catch(handleSummaryLoadError);
  }

  async function loadShortVideoSummary() {
    ensureState();
    if (state.shortVideo.summary || state.shortVideo.summaryLoading) return;
    state.shortVideo.summaryLoading = true;
    try {
      const data = await api("/api/short-videos/summary");
      state.shortVideo.summary = data || state.shortVideo.summary;
      if (state.shortVideo.data) {
        state.shortVideo.data = { ...state.shortVideo.data, summary: state.shortVideo.summary };
      }
      renderStats();
    } finally {
      state.shortVideo.summaryLoading = false;
    }
  }

  async function loadShortVideoFacets(options = {}) {
    ensureState();
    if (state.shortVideo.facetsLoading) return;
    if (state.shortVideo.facetsLoaded && !options.force) return;
    state.shortVideo.facetsLoading = true;
    try {
      const data = await api("/api/short-videos/facets");
      state.shortVideo.summary = data.summary || state.shortVideo.summary;
      state.shortVideo.authors = Array.isArray(data.authors) ? data.authors : state.shortVideo.authors;
      if (state.shortVideo.data) {
        state.shortVideo.data = {
          ...state.shortVideo.data,
          summary: state.shortVideo.summary,
          authors: state.shortVideo.authors
        };
      }
      state.shortVideo.facetsLoaded = true;
      renderStats();
    } finally {
      state.shortVideo.facetsLoading = false;
    }
  }

  async function openVideo(videoId, options = {}) {
    ensureState();
    if (!videoId) return;
    const requestId = ++shortVideoOpenRequestId;
    shortVideoOpeningId = String(videoId);
    shortVideoOpenError = "";
    state.shortVideo.loading = true;
    state.shortVideo.status = "正在打开视频";
    if (options.renderLoading !== false) renderView();
    try {
      const data = await fetchShortVideoDetail(videoId);
      if (requestId !== shortVideoOpenRequestId) return false;
      state.shortVideo.current = data.video;
      if (state.shortVideo.sound && data.video?.sound?.key === state.shortVideo.sound) state.shortVideo.soundInfo = data.video.sound;
      state.shortVideo.prevId = data.prevId || "";
      state.shortVideo.nextId = data.nextId || "";
      state.shortVideo.slideDirection = Number(options.slideDirection || 0);
      state.shortVideo.prevVideo = null;
      state.shortVideo.nextVideo = null;
      state.shortVideo.loading = false;
      state.shortVideo.status = "";
      shortVideoOpeningId = "";
      shortVideoOpenError = "";
      renderStats();
      renderView();
      resumeActiveSound();
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      if (!options.skipRoute) pushRoute({ view: "shortVideos", shortVideoId: data.video.id });
      loadShortVideoSummary().catch(handleSummaryLoadError);
      loadAdjacentVideos(data.video.id).then((loaded) => {
        if (!loaded) return;
        refreshAdjacentPanelsDom();
        syncCurrentNavigationDom();
      }).catch((error) => console.warn(error));
      return true;
    } catch (error) {
      if (requestId !== shortVideoOpenRequestId) return false;
      state.shortVideo.loading = false;
      state.shortVideo.status = "";
      if (state.shortVideo.current) {
        shortVideoOpeningId = "";
        shortVideoOpenError = "";
        renderView();
        throw error;
      }
      shortVideoOpenError = shortVideoFriendlyError(error, "本地视频暂时无法打开");
      renderView();
      console.warn(error);
      return false;
    }
  }

  function renderStats() {
    ensureState();
    if (!els.statsRow) return;
    els.statsRow.innerHTML = "";
    const totals = state.shortVideo.summary?.totals || state.shortVideo.data?.summary?.totals || {};
    for (const [label, value] of [
      ["视频", formatNumber(totals.videos || 0)],
      ["作者", formatNumber(totals.authors || 0)],
      ["容量", formatBytes(totals.bytes || 0)],
      ["时长", formatDuration(totals.durationMs || 0)]
    ]) {
      const stat = document.createElement("div");
      stat.className = "stat short-video-stat";
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      const span = document.createElement("span");
      span.textContent = label;
      stat.append(strong, span);
      els.statsRow.append(stat);
    }
  }

  function disposeShortVideoMedia(root, options = {}) {
    const release = options.release !== false;
    root?.querySelectorAll?.("video, audio")?.forEach?.((player) => {
      try {
        player.muted = true;
        player.onended = null;
        player.pause?.();
        if (release) {
          player.removeAttribute?.("src");
          player.load?.();
        }
      } catch {}
    });
  }

  function renderView() {
    ensureState();
    if (!els.workGrid) return;
    resetShortVideoWindow();
    resetLoadMoreObserver();
    resetCoverLoadObserver();
    clearPendingPlayerClick();
    els.workGrid.querySelector?.(".short-video-browser")?.shortVideoControlsDispose?.();
    els.workGrid.querySelector?.(".short-video-control-bar")?.shortVideoDispose?.();
    disposeShortVideoMedia(els.workGrid);
    els.workGrid.innerHTML = "";
    setBodyClass();
    if (state.shortVideo.current) {
      renderBrowser();
      return;
    }
    if (shortVideoOpeningId) {
      renderBrowserLoading();
      return;
    }
    renderHome();
  }

  function renderHome() {
    const data = state.shortVideo.data || {};
    const shell = document.createElement("section");
    shell.className = "short-video-home";
    shell.classList.toggle("is-author-page", isShortVideoAuthorDetailPage());
    if (!isShortVideoAuthorDetailPage() && !isShortVideoAuthorIndexPage()) {
      shell.append(renderShortVideoDiscovery());
    }
    shell.append(renderHomeToolbar(data));
    if (isShortVideoAuthorIndexPage()) {
      shell.append(renderAuthorIndex());
      els.workGrid.append(shell);
      return;
    }
    if (isShortVideoAuthorDetailPage()) {
      shell.append(renderAuthorDetailHome(data), renderAuthorWorkspaceToolbar(data));
    }
    if (state.shortVideo.status && !(data.videos || []).length) {
      const status = document.createElement("div");
      status.className = "short-video-status";
      status.textContent = state.shortVideo.status;
      shell.append(status);
    }
    const grid = document.createElement("div");
    const displayVideos = shortVideosWithCovers(data.videos || []);
    if (!displayVideos.length) {
      grid.className = "short-video-grid";
      grid.append(renderShortVideoEmpty(data));
    } else {
      grid.className = "short-video-grid short-video-virtual-grid";
      const inner = document.createElement("div");
      inner.className = "short-video-window";
      grid.append(inner);
      svInnerEl = inner;
    }
    shell.append(grid);
    els.workGrid.append(shell);
    svGridEl = grid;
    svStart = 0;
    svEnd = 0;
    renderShortVideoWindow(true);
  }

  function renderShortVideoDiscovery() {
    const section = document.createElement("section");
    section.className = "short-video-discovery";
    const form = shortVideoSearch.renderForm();

    const media = document.createElement("div");
    media.className = "short-video-media-filter";
    media.setAttribute("role", "group");
    media.setAttribute("aria-label", "筛选作品类型");
    for (const [value, label] of [["all", "全部"], ["video", "视频"], ["gallery", "图文"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-media-filter-button";
      const active = normalizeShortVideoMedia(state.shortVideo.media) === value;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      button.textContent = label;
      button.addEventListener("click", () => commitShortVideoMedia(value));
      media.append(button);
    }
    section.append(form, media);
    if (state.shortVideo.topic) {
      const topic = document.createElement("div");
      topic.className = "short-video-active-topic";
      const label = document.createElement("span");
      label.append(createIcon("link"), document.createTextNode(`#${state.shortVideo.topic}`));
      const clearTopic = document.createElement("button");
      clearTopic.type = "button";
      clearTopic.setAttribute("aria-label", `退出话题 ${state.shortVideo.topic}`);
      clearTopic.append(createIcon("close"));
      clearTopic.addEventListener("click", () => commitShortVideoTopic(""));
      topic.append(label, clearTopic);
      section.append(topic);
    }
    if (state.shortVideo.sound) {
      const soundInfo = state.shortVideo.soundInfo || {};
      const sound = document.createElement("div");
      sound.className = "short-video-active-sound";
      const label = document.createElement("span");
      label.append(createIcon("headphones"), document.createTextNode(soundInfo.title || "原声流"));
      const clearSound = document.createElement("button");
      clearSound.type = "button";
      clearSound.setAttribute("aria-label", `退出原声 ${soundInfo.title || "原声流"}`);
      clearSound.append(createIcon("close"));
      clearSound.addEventListener("click", () => commitShortVideoSound(""));
      sound.append(label, clearSound);
      section.append(sound);
    }
    return section;
  }

  function commitShortVideoSearch(value) {
    const query = String(value || "").trim().slice(0, 120);
    shortVideoSearch.remember(query);
    if (query === (state.shortVideo.query || "") && !state.shortVideo.topic && !state.shortVideo.sound && state.shortVideo.data) return;
    state.shortVideo.query = query;
    state.shortVideo.topic = "";
    state.shortVideo.sound = "";
    state.shortVideo.soundInfo = null;
    state.shortVideo.current = null;
    state.shortVideo.data = null;
    clearShortVideoDeleteSelection();
    loadVideos({ replaceRoute: true }).catch(showError);
  }

  function commitShortVideoTopic(value) {
    const topic = normalizeShortVideoTopic(value);
    if (topic === normalizeShortVideoTopic(state.shortVideo.topic) && state.shortVideo.data) return;
    state.shortVideo.topic = topic;
    state.shortVideo.query = "";
    state.shortVideo.sound = "";
    state.shortVideo.soundInfo = null;
    state.shortVideo.author = "all";
    if (topic) {
      state.shortVideo.source = "all";
      state.shortVideo.sort = "likes";
    }
    state.shortVideo.current = null;
    state.shortVideo.data = null;
    clearShortVideoDeleteSelection();
    loadVideos({ replaceRoute: true }).catch(showError);
  }

  function commitShortVideoSound(value, info = null) {
    const sound = normalizeShortVideoSound(value);
    if (sound === normalizeShortVideoSound(state.shortVideo.sound) && state.shortVideo.data) return;
    state.shortVideo.sound = sound;
    state.shortVideo.soundInfo = sound && info ? info : null;
    state.shortVideo.query = "";
    state.shortVideo.topic = "";
    state.shortVideo.author = "all";
    if (sound) {
      state.shortVideo.source = "all";
      state.shortVideo.sort = "likes";
    }
    state.shortVideo.current = null;
    state.shortVideo.data = null;
    clearShortVideoDeleteSelection();
    loadVideos({ replaceRoute: true }).catch(showError);
  }

  function commitShortVideoMedia(value) {
    const media = normalizeShortVideoMedia(value);
    if (media === normalizeShortVideoMedia(state.shortVideo.media)) return;
    state.shortVideo.media = media;
    state.shortVideo.current = null;
    state.shortVideo.data = null;
    clearShortVideoDeleteSelection();
    loadVideos({ replaceRoute: true }).catch(showError);
  }

  function renderShortVideoEmpty(data = {}) {
    const empty = document.createElement("div");
    empty.className = "short-video-empty";
    if (state.shortVideo.loading) {
      empty.classList.add("is-loading");
      empty.textContent = "正在读取短视频";
      return empty;
    }
    if ((data.videos || []).length) {
      empty.textContent = "封面补齐前暂不显示这些短视频。";
      return empty;
    }
    const query = String(state.shortVideo.query || "").trim();
    const topic = normalizeShortVideoTopic(state.shortVideo.topic);
    const sound = normalizeShortVideoSound(state.shortVideo.sound);
    const media = normalizeShortVideoMedia(state.shortVideo.media);
    const title = document.createElement("h2");
    title.textContent = query
      ? `没有找到“${query}”`
      : topic
        ? `没有找到 #${topic} 的本地作品`
      : sound
        ? `没有找到“${state.shortVideo.soundInfo?.title || "当前原声"}”的本地作品`
      : media === "gallery"
        ? "没有找到图文作品"
        : media === "video"
          ? "没有找到视频作品"
          : state.shortVideo.status || "没有匹配的短视频";
    const hint = document.createElement("p");
    hint.textContent = query || topic || sound || media !== "all"
      ? "试试更短的关键词，或者调整作品类型。"
      : "本地库暂时没有可展示的内容。";
    const actions = document.createElement("div");
    actions.className = "short-video-empty-actions";
    if (query) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "清除搜索";
      clear.addEventListener("click", () => commitShortVideoSearch(""));
      actions.append(clear);
    }
    if (media !== "all") {
      const all = document.createElement("button");
      all.type = "button";
      all.textContent = "查看全部类型";
      all.addEventListener("click", () => commitShortVideoMedia("all"));
      actions.append(all);
    }
    if (topic) {
      const exitTopic = document.createElement("button");
      exitTopic.type = "button";
      exitTopic.textContent = "退出话题";
      exitTopic.addEventListener("click", () => commitShortVideoTopic(""));
      actions.append(exitTopic);
    }
    if (sound) {
      const exitSound = document.createElement("button");
      exitSound.type = "button";
      exitSound.textContent = "退出原声流";
      exitSound.addEventListener("click", () => commitShortVideoSound(""));
      actions.append(exitSound);
    }
    empty.append(title, hint);
    if (actions.childElementCount) empty.append(actions);
    return empty;
  }

  function renderHomeToolbar(data = {}) {
    const toolbar = document.createElement("div");
    toolbar.className = "short-video-home-toolbar";
    const tabs = document.createElement("div");
    tabs.className = "short-video-source-tabs";
    tabs.setAttribute("role", "tablist");
    const activeSource = isShortVideoAuthorDetailPage() ? "authors" : (state.shortVideo.source || "liked");
    for (const item of [
      ["recommended", "推荐"],
      ["liked", "我的喜欢"],
      ["following", "关注"],
      ["history", "历史"],
      ["authors", "作者"],
      ["all", "全部"]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-source-tab";
      const active = activeSource === item[0];
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      button.textContent = item[1];
      button.addEventListener("click", () => {
        if (activeSource === item[0] && !isShortVideoAuthorDetailPage()) return;
        state.shortVideo.authorPage = "";
        state.shortVideo.source = item[0];
        state.shortVideo.topic = "";
        state.shortVideo.sound = "";
        state.shortVideo.soundInfo = null;
        if (item[0] === "recommended") {
          state.shortVideo.sort = "recommended";
        } else if (item[0] === "history") {
          state.shortVideo.sort = "watched";
        } else if (["recommended", "watched"].includes(state.shortVideo.sort)) {
          state.shortVideo.sort = "published";
        }
        if (item[0] === "authors") {
          state.shortVideo.author = "all";
          state.shortVideo.query = "";
          state.shortVideo.media = "all";
          state.shortVideo.authorVisibleCount = AUTHOR_INITIAL_COUNT;
        } else {
          state.shortVideo.author = "all";
        }
        state.shortVideo.current = null;
        state.shortVideo.data = null;
        clearShortVideoDeleteSelection();
        pushRoute({
          view: "shortVideos",
          shortVideoId: "",
          shortVideoAuthorPage: "",
          shortVideoAuthor: state.shortVideo.author,
          shortVideoQuery: state.shortVideo.query,
          shortVideoSource: state.shortVideo.source
        });
        loadVideos({ skipRoute: true }).catch(showError);
      });
      tabs.append(button);
    }
    const actions = isShortVideoAuthorDetailPage() ? document.createElement("div") : renderDeleteSelectionActions(data);
    const total = document.createElement("div");
    total.className = "short-video-home-total";
    if (isShortVideoAuthorIndexPage()) {
      const authors = sortedShortVideoAuthors();
      const visibleCount = Math.min(state.shortVideo.authorVisibleCount || AUTHOR_INITIAL_COUNT, authors.length);
      total.textContent = state.shortVideo.loading
        ? "正在读取作者"
        : visibleCount < authors.length
          ? `已显示 ${formatNumber(visibleCount)} / ${formatNumber(authors.length)} 位作者`
          : `${formatNumber(authors.length || 0)} 位作者`;
    } else if (isShortVideoAuthorDetailPage()) {
      total.textContent = `${formatNumber(data.total || 0)} 条作品`;
    } else if (
      state.shortVideo.source === "liked"
      && Number(data.relationshipTotal || 0) > Number(data.total || 0)
    ) {
      total.textContent = `喜欢关系 ${formatNumber(data.relationshipTotal)} · 本地可看 ${formatNumber(data.total || 0)}`;
    } else {
      total.textContent = `${formatNumber(data.total || 0)} 条`;
    }
    toolbar.append(tabs, actions, total);
    return toolbar;
  }

  function renderDeleteSelectionActions(data = {}) {
    const wrap = document.createElement("div");
    wrap.className = "short-video-delete-actions";
    if (isShortVideoAuthorIndexPage()) return wrap;
    wrap.append(renderShortVideoSortControl());
    const selection = shortVideoDeleteSelection();
    if (!state.shortVideo.deleteMode) {
      const start = document.createElement("button");
      start.type = "button";
      start.className = "short-video-delete-tool";
      start.append(createIcon("trash"), document.createTextNode("选择删除"));
      start.addEventListener("click", () => {
        state.shortVideo.deleteMode = true;
        renderView();
      });
      wrap.append(start);
      return wrap;
    }
    const loadedIds = shortVideosWithCovers(data.videos || []).map((video) => String(video.id || "")).filter(Boolean);
    const allLoadedSelected = loadedIds.length > 0 && loadedIds.every((id) => selection.has(id));
    const selectLoaded = document.createElement("button");
    selectLoaded.type = "button";
    selectLoaded.className = "short-video-delete-tool";
    selectLoaded.textContent = allLoadedSelected ? "取消全选" : "全选已加载";
    selectLoaded.disabled = !loadedIds.length;
    selectLoaded.addEventListener("click", () => {
      toggleLoadedShortVideoSelection(loadedIds, allLoadedSelected);
    });
    const commit = document.createElement("button");
    commit.type = "button";
    commit.className = "short-video-delete-tool is-danger";
    commit.textContent = selection.size ? `删除选中 ${selection.size}` : "删除选中";
    commit.disabled = !selection.size;
    commit.addEventListener("click", () => deleteSelectedShortVideos().catch(showError));
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "short-video-delete-tool";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => {
      clearShortVideoDeleteSelection();
      renderView();
    });
    wrap.append(selectLoaded, commit, cancel);
    return wrap;
  }

  function renderShortVideoSortControl() {
    const label = document.createElement("label");
    label.className = "short-video-sort-control";
    const text = document.createElement("span");
    text.textContent = isShortVideoAuthorDetailPage() ? "日期" : "排序";
    const select = document.createElement("select");
    select.className = "short-video-sort-select";
    for (const item of [
      ["recommended", "推荐排序"],
      ["watched", "最近观看"],
      ["published", "时间倒序"],
      ["publishedAsc", "时间正序"],
      ["likes", "点赞最多"],
      ["likesAsc", "点赞最少"],
      ["comments", "评论最多"],
      ["duration", "时长最长"]
    ]) {
      const option = document.createElement("option");
      option.value = item[0];
      option.textContent = item[1];
      select.append(option);
    }
    select.value = normalizeShortVideoSortValue(state.shortVideo.sort);
    select.addEventListener("change", () => {
      const nextSort = normalizeShortVideoSortValue(select.value);
      if ((state.shortVideo.sort || "published") === nextSort) return;
      state.shortVideo.sort = nextSort;
      state.shortVideo.current = null;
      state.shortVideo.data = null;
      clearShortVideoDeleteSelection();
      loadVideos({ replaceRoute: true }).catch(showError);
    });
    label.append(text, select);
    return label;
  }

  function shortVideoDeleteSelection() {
    ensureState();
    return state.shortVideo.deleteSelection;
  }

  function clearShortVideoDeleteSelection(options = {}) {
    const selection = shortVideoDeleteSelection();
    selection.clear();
    if (!options.keepMode) state.shortVideo.deleteMode = false;
  }

  function toggleShortVideoSelected(id) {
    const videoId = String(id || "").trim();
    if (!videoId) return;
    const selection = shortVideoDeleteSelection();
    if (selection.has(videoId)) selection.delete(videoId);
    else selection.add(videoId);
    renderView();
  }

  function toggleLoadedShortVideoSelection(loadedIds, clear) {
    const selection = shortVideoDeleteSelection();
    for (const id of loadedIds || []) {
      const videoId = String(id || "").trim();
      if (!videoId) continue;
      if (clear) selection.delete(videoId);
      else selection.add(videoId);
    }
    renderView();
  }

  function renderAuthorDetailHome(data = {}) {
    const author = currentShortVideoAuthorDetail(data);
    const visibleAuthorVideo = (data.videos || []).find((video) => video?.ownerUserId || video?.author?.id) || null;
    if (visibleAuthorVideo) state.shortVideo.authorVideo = visibleAuthorVideo;
    const authorVideo = visibleAuthorVideo || state.shortVideo.authorVideo || null;
    const head = document.createElement("section");
    head.className = "short-video-author-page-head";
    const heroCoverUrl = shortVideoCardCoverUrl(authorVideo || {});
    if (heroCoverUrl) {
      const hero = document.createElement("div");
      hero.className = "short-video-author-page-hero";
      hero.setAttribute("aria-hidden", "true");
      const heroImage = document.createElement("img");
      heroImage.src = heroCoverUrl;
      heroImage.alt = "";
      heroImage.loading = "eager";
      heroImage.decoding = "async";
      hero.append(heroImage);
      head.append(hero);
    }
    const back = document.createElement("button");
    back.type = "button";
    back.className = "short-video-author-page-back";
    back.append(createIcon("chevronLeft"), document.createTextNode("返回"));
    back.addEventListener("click", () => returnToShortVideoAuthorIndex());
    const avatar = authorAvatar(author, "short-video-author-page-avatar");
    const copy = document.createElement("div");
    copy.className = "short-video-author-page-copy";
    const eyebrow = document.createElement("span");
    eyebrow.className = "short-video-author-page-eyebrow";
    eyebrow.textContent = "抖音作者";
    const nameRow = document.createElement("div");
    nameRow.className = "short-video-author-page-name-row";
    const name = document.createElement("strong");
    name.textContent = author.name || authorNameFromFilter(state.shortVideo.author) || "未知作者";
    nameRow.append(name);
    const verification = String(author.verification || "").trim();
    if (verification) {
      const badge = document.createElement("span");
      badge.className = "short-video-author-page-verified";
      badge.textContent = verification;
      nameRow.append(badge);
    }
    const identity = document.createElement("div");
    identity.className = "short-video-author-page-identity";
    const identityText = authorProfileLineText({ ...author, verification: "" });
    identity.textContent = identityText || "本地作者资料";
    const signature = document.createElement("p");
    signature.className = "short-video-author-page-signature";
    signature.textContent = String(author.signature || "暂无作者简介").trim();
    const stats = document.createElement("div");
    stats.className = "short-video-author-page-stats";
    for (const [label, value] of [
      ["关注", profileNumber(author.followingCount)],
      ["粉丝", profileNumber(author.followerCount)],
      ["获赞", profileNumber(author.totalFavorited)],
      ["作品", profileNumber(author.awemeCount)],
      ["喜欢", profileNumber(author.favoritingCount)]
    ]) {
      if (value === null) continue;
      const cell = document.createElement("span");
      const strong = document.createElement("b");
      strong.textContent = formatCompact(value);
      const small = document.createElement("small");
      small.textContent = label;
      cell.append(strong, small);
      stats.append(cell);
    }
    const libraryMeta = document.createElement("div");
    libraryMeta.className = "short-video-author-page-library-meta";
    const localCount = document.createElement("b");
    localCount.textContent = `${formatNumber(author.count || data.total || 0)} 个本地作品`;
    libraryMeta.append(localCount);
    const homeCount = profileNumber(author.awemeCount);
    if (homeCount !== null) {
      const comparison = document.createElement("span");
      comparison.textContent = `主页 ${formatNumber(homeCount)}`;
      libraryMeta.append(comparison);
    }
    const collectedAt = formatDate(author.profileCollectedAt);
    if (collectedAt) {
      const collected = document.createElement("span");
      collected.textContent = `资料更新 ${collectedAt}`;
      libraryMeta.append(collected);
    }
    copy.append(eyebrow, nameRow, stats, identity, signature, libraryMeta);
    const actions = document.createElement("div");
    actions.className = "short-video-author-page-actions";
    const follow = createAuthorFollowButton(authorVideo, author, "page");
    const douyin = document.createElement("button");
    douyin.type = "button";
    douyin.className = "short-video-author-page-secondary";
    douyin.textContent = "抖音主页";
    douyin.addEventListener("click", () => openAuthorDouyinLink(author));
    actions.append(follow, douyin);
    head.append(back, avatar, copy, actions);
    return head;
  }

  function renderAuthorWorkspaceToolbar(data = {}) {
    const section = document.createElement("section");
    section.className = "short-video-author-workspace";
    const heading = document.createElement("div");
    heading.className = "short-video-author-workspace-heading";
    heading.setAttribute("role", "tablist");
    heading.setAttribute("aria-label", "作者作品来源");
    const author = currentShortVideoAuthorDetail(data);
    const authorTotal = author.count || data.total || 0;
    const activeSource = ["all", "posts", "liked", "local"].includes(state.shortVideo.source)
      ? state.shortVideo.source
      : "all";
    for (const [value, label] of [
      ["all", "作品"],
      ["posts", "发布"],
      ["liked", "喜欢"],
      ["local", "本地"]
    ]) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "short-video-author-workspace-tab";
      tab.classList.toggle("active", activeSource === value);
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(activeSource === value));
      tab.append(document.createTextNode(label));
      if (value === "all") {
        const count = document.createElement("small");
        count.textContent = state.shortVideo.loading ? "…" : formatNumber(authorTotal);
        tab.append(count);
      } else if (value === "liked") {
        tab.append(createIcon("eyeOff"));
      }
      tab.addEventListener("click", () => {
        if (value === state.shortVideo.source) return;
        state.shortVideo.source = value;
        state.shortVideo.data = null;
        clearShortVideoDeleteSelection();
        loadVideos({ replaceRoute: true }).catch(showError);
      });
      heading.append(tab);
    }

    const filters = document.createElement("div");
    filters.className = "short-video-author-filters";
    const search = shortVideoSearch.renderForm({
      compact: true,
      placeholder: "搜索 TA 的作品",
      ariaLabel: "搜索作者作品",
      params: () => ({ author: state.shortVideo.authorPage || state.shortVideo.author })
    });
    filters.append(search, renderDeleteSelectionActions(data));
    section.append(heading, filters);
    return section;
  }

  function returnToShortVideoAuthorIndex() {
    state.shortVideo.authorPage = "";
    state.shortVideo.authorDetail = null;
    state.shortVideo.authorVideo = null;
    state.shortVideo.source = "authors";
    state.shortVideo.author = "all";
    state.shortVideo.query = "";
    state.shortVideo.topic = "";
    state.shortVideo.sound = "";
    state.shortVideo.soundInfo = null;
    state.shortVideo.media = "all";
    state.shortVideo.current = null;
    state.shortVideo.data = null;
    clearShortVideoDeleteSelection();
    replaceRoute({
      view: "shortVideos",
      shortVideoId: "",
      shortVideoAuthorPage: "",
      shortVideoAuthor: "all",
      shortVideoQuery: "",
      shortVideoSource: "authors"
    });
    loadVideos({ skipRoute: true }).catch(showError);
  }

  function openShortVideoAuthorPage(author = {}, video = {}) {
    const authorId = authorScopeId(video, author);
    if (!authorId) {
      showBrowserToast("没有作者资料");
      return;
    }
    authorPanelReturnFeed = null;
    state.shortVideo.authorPage = authorId;
    state.shortVideo.author = authorId;
    state.shortVideo.authorDetail = { ...(video?.author || {}), ...author, secUid: authorId };
    state.shortVideo.authorVideo = video?.id ? video : null;
    state.shortVideo.source = "all";
    state.shortVideo.query = "";
    state.shortVideo.topic = "";
    state.shortVideo.sound = "";
    state.shortVideo.soundInfo = null;
    state.shortVideo.media = "all";
    state.shortVideo.current = null;
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    state.shortVideo.prevId = "";
    state.shortVideo.nextId = "";
    state.shortVideo.data = null;
    clearShortVideoDeleteSelection();
    pushRoute({
      view: "shortVideos",
      shortVideoId: "",
      shortVideoAuthorPage: authorId,
      shortVideoAuthor: authorId,
      shortVideoQuery: "",
      shortVideoSource: "all"
    });
    loadVideos({ skipRoute: true }).catch(showError);
  }

  function renderAuthorIndex() {
    const authors = sortedShortVideoAuthors();
    const visibleCount = Math.min(state.shortVideo.authorVisibleCount || AUTHOR_INITIAL_COUNT, authors.length);
    const visibleAuthors = authors.slice(0, visibleCount);
    const wrap = document.createElement("div");
    wrap.className = "short-video-author-index";
    if (state.shortVideo.loading && !authors.length) {
      const status = document.createElement("div");
      status.className = "short-video-author-index-status";
      status.textContent = "正在读取作者";
      wrap.append(status);
      return wrap;
    }
    if (!authors.length) {
      const status = document.createElement("div");
      status.className = "short-video-author-index-status";
      status.textContent = "还没有作者数据";
      wrap.append(status);
      return wrap;
    }
    for (const author of visibleAuthors) {
      wrap.append(renderAuthorIndexCard(author));
    }
    if (visibleCount < authors.length) {
      const status = document.createElement("div");
      status.className = "short-video-author-index-status short-video-author-index-more";
      status.textContent = "继续下滑加载更多作者";
      wrap.append(status);
    }
    return wrap;
  }

  function sortedShortVideoAuthors() {
    return [...(state.shortVideo.authors || [])]
      .filter((author) => author && (author.secUid || author.name))
      .sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));
  }

  function appendVisibleAuthorsIfNeeded(force = false) {
    if (state.activeView !== "shortVideos" || state.shortVideo?.current || !isShortVideoAuthorIndexPage()) return;
    const total = sortedShortVideoAuthors().length;
    const current = state.shortVideo.authorVisibleCount || AUTHOR_INITIAL_COUNT;
    if (!total || current >= total) return;
    if (!force) {
      const doc = document.documentElement;
      const bottomDistance = Math.max(0, (doc.scrollHeight || 0) - ((window.scrollY || 0) + (window.innerHeight || 0)));
      if (bottomDistance > AUTHOR_APPEND_LOOKAHEAD) return;
    }
    state.shortVideo.authorVisibleCount = Math.min(total, current + AUTHOR_APPEND_COUNT);
    renderView();
  }

  function isShortVideoAuthorIndexPage() {
    return !state.shortVideo?.authorPage && state.shortVideo?.source === "authors";
  }

  function isShortVideoAuthorDetailPage() {
    return Boolean(state.shortVideo?.authorPage);
  }

  function shortVideoApiSource() {
    if (isShortVideoAuthorDetailPage()) {
      return ["liked", "posts", "all", "local"].includes(state.shortVideo.source) ? state.shortVideo.source : "all";
    }
    return state.shortVideo.source || "liked";
  }

  function currentShortVideoAuthorDetail(data = {}) {
    const filter = String(state.shortVideo.author || "").trim();
    const fromVideo = (data.videos || []).find((video) => video?.author)?.author || {};
    const fromFacet = (state.shortVideo.authors || []).find((author) => shortVideoAuthorFilterValue(author) === filter) || {};
    const cached = state.shortVideo.authorDetail || {};
    const fromCache = shortVideoAuthorFilterValue(cached) === filter ? cached : {};
    const fresh = { ...fromVideo, ...fromFacet };
    const preserveCachedProfile = Boolean(fromCache.secUid || fromCache.name) && state.shortVideo.source !== "all";
    const detail = preserveCachedProfile
      ? { ...fresh, ...fromCache }
      : { ...fromCache, ...fresh };
    detail.name = preserveCachedProfile
      ? (fromCache.name || fromFacet.name || fromVideo.name || authorNameFromFilter(filter))
      : (fromFacet.name || fromVideo.name || fromCache.name || authorNameFromFilter(filter));
    if (state.shortVideo.source === "all" && Number.isFinite(Number(data.total))) {
      detail.count = Math.max(0, Number(data.total));
    }
    if (detail.secUid || detail.name) {
      state.shortVideo.authorDetail = { ...detail };
    }
    return detail;
  }

  function shortVideoAuthorFilterValue(author = {}) {
    const secUid = String(author.secUid || "").trim();
    if (secUid) return secUid;
    const name = String(author.name || "").trim();
    return name ? `name:${name}` : "all";
  }

  function authorNameFromFilter(value) {
    const text = String(value || "").trim();
    return text.startsWith("name:") ? text.slice(5) : "";
  }

  function shortVideoAuthorDisplayName(value, fallback = "未知作者") {
    const name = String(value || "").trim().replace(/^(?:@\s*)+/u, "").trim();
    return name || fallback;
  }

  function shortVideoAuthorHandle(value, fallback = "未知作者") {
    return `@${shortVideoAuthorDisplayName(value, fallback)}`;
  }

  function renderAuthorIndexCard(author = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-author-index-card";
    button.setAttribute("aria-label", `查看 ${author.name || "未知作者"} 的短视频`);
    const media = document.createElement("span");
    media.className = "short-video-author-index-media";
    const imageUrl = author.avatarUrl || author.fallbackCoverUrl || "";
    if (imageUrl) {
      const img = document.createElement("img");
      img.src = imageUrl;
      img.alt = author.name || "作者头像";
      img.loading = "lazy";
      img.decoding = "async";
      media.append(img);
    } else {
      media.classList.add("is-fallback");
      media.textContent = initials(author.name || "?");
    }
    const name = document.createElement("strong");
    name.textContent = author.name || "未知作者";
    const meta = document.createElement("span");
    meta.className = "short-video-author-index-meta";
    meta.textContent = `${formatNumber(author.count || 0)} 条视频`;
    button.append(media, name, meta);
    if (author.following) {
      const following = document.createElement("span");
      following.className = "short-video-author-index-following";
      following.textContent = "已关注";
      button.append(following);
    }
    button.addEventListener("click", () => {
      openShortVideoAuthorPage(author);
    });
    return button;
  }

  function resetShortVideoWindow() {
    svStart = 0;
    svEnd = 0;
    svGridEl = null;
    svInnerEl = null;
    svReady = false;
    svCardH = 0;
    if (svScrollRaf) window.cancelAnimationFrame(svScrollRaf);
    svScrollRaf = 0;
    coverLoadObserver?.disconnect?.();
    coverLoadObserver = null;
    if (coverLoadTimer) window.clearTimeout(coverLoadTimer);
    coverLoadTimer = null;
    coverLoadQueue.length = 0;
  }

  function measureShortVideoGrid(grid) {
    const gw = grid.clientWidth || grid.getBoundingClientRect().width || 800;
    const authorDetail = isShortVideoAuthorDetailPage();
    const minCardWidth = authorDetail ? SV_AUTHOR_MIN_COL : SV_FEED_MIN_COL;
    svCols = Math.max(1, Math.floor((gw + SV_COL_GAP) / (minCardWidth + SV_COL_GAP)));
    svCardW = (gw - (svCols - 1) * SV_COL_GAP) / svCols;
    if (!svCardH) svCardH = Math.round(svCardW * (authorDetail ? 14 / 9 : 9 / 16)) + (authorDetail ? 56 : 62);
    svRowH = svCardH + SV_ROW_GAP;
  }

  function computeShortVideoWindow(grid, total) {
    if (!svCols || !svRowH) measureShortVideoGrid(grid);
    const gridTop = grid.getBoundingClientRect().top + window.scrollY;
    const viewportTop = window.scrollY;
    const viewportBottom = viewportTop + (window.innerHeight || document.documentElement.clientHeight || 800);
    const totalRows = Math.ceil(total / svCols) || 1;
    const rawStartRow = Math.max(0, Math.floor((viewportTop - gridTop) / svRowH));
    const rawEndRow = Math.min(totalRows, Math.ceil((viewportBottom - gridTop) / svRowH));
    const startRow = Math.max(0, rawStartRow - SV_BUFFER_ROWS);
    const endRow = Math.min(totalRows, rawEndRow + SV_BUFFER_ROWS);
    return {
      start: startRow * svCols,
      end: Math.min(total, endRow * svCols),
      startRow,
      totalRows
    };
  }

  function renderShortVideoWindow(force) {
    const grid = svGridEl;
    const inner = svInnerEl;
    const videos = shortVideosWithCovers(state.shortVideo?.data?.videos || []);
    const total = videos.length;
    if (!grid || !total) {
      if (grid) grid.style.height = "";
      return;
    }
    if (!svReady) measureShortVideoGrid(grid);
    const { start, end, startRow, totalRows } = computeShortVideoWindow(grid, total);
    grid.style.height = `${Math.max(0, totalRows * svRowH - SV_ROW_GAP)}px`;
    if (!inner) return;
    if (!force && start === svStart && end === svEnd && svReady) return;
    svStart = start;
    svEnd = end;
    inner.style.transform = `translate3d(0, ${startRow * svRowH}px, 0)`;
    inner.style.gridTemplateColumns = `repeat(${svCols}, minmax(0, 1fr))`;
    inner.innerHTML = "";
    coverLoadObserver?.disconnect?.();
    coverLoadObserver = null;
    coverLoadQueue.length = 0;
    const cards = [];
    for (let i = start; i < end; i++) {
      const video = videos[i];
      if (!video) continue;
      const card = renderVideoCard(video, i);
      if (!card) continue;
      const coverUrl = shortVideoCardCoverUrl(video);
      if (coverUrl && loadedCoverIds.has(video.id)) {
        const img = card.querySelector("img.short-video-cover-image");
        if (img) {
          img.src = coverUrl;
          img.dataset.loaded = "1";
          img.classList.add("is-loaded");
          delete img.dataset.src;
        }
      }
      inner.append(card);
      cards.push(card);
    }
    activateShortVideoCoversForNodes(cards);
    if (!svReady) {
      const first = cards[0];
      if (first) {
        const h = first.getBoundingClientRect().height;
        const w = first.getBoundingClientRect().width;
        if (h > 0) {
          svCardH = h;
          svRowH = h + SV_ROW_GAP;
          if (w) svCardW = w;
          svReady = true;
          renderShortVideoWindow(true);
          return;
        }
      }
      svReady = true;
    }
  }

  function updateShortVideoWindowAndLoadMore() {
    renderShortVideoWindow(false);
    const data = state.shortVideo?.data;
    if (data?.hasMore && !state.shortVideo.loading && !state.shortVideo.loadingMore) {
      const total = shortVideosWithCovers(data.videos || []).length;
      if (svEnd >= total - svCols * SV_APPEND_LOOKAHEAD_ROWS) {
        loadVideos({ append: true, keepCurrent: true }).catch(showError);
      }
    }
  }

  function scheduleShortVideoWindowUpdate() {
    if (svScrollRaf) return;
    svScrollRaf = window.requestAnimationFrame(() => {
      svScrollRaf = 0;
      updateShortVideoWindowAndLoadMore();
    });
  }

  function renderVideoCard(video, index = 0) {
    const card = document.createElement("article");
    card.className = "short-video-card";
    const authorWork = isShortVideoAuthorDetailPage();
    card.classList.toggle("is-author-work", authorWork);
    const selection = shortVideoDeleteSelection();
    const selected = selection.has(String(video.id || ""));
    const selecting = Boolean(state.shortVideo.deleteMode);
    card.classList.toggle("is-selecting", selecting);
    card.classList.toggle("is-selected", selected);
    const thumb = document.createElement("div");
    thumb.className = "short-video-thumb";
    const coverUrl = shortVideoCardCoverUrl(video);
    if (!coverUrl) return null;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "short-video-thumb-open";
    open.setAttribute("aria-label", selecting ? `选择 ${video.title || "短视频"}` : video.title || "打开短视频");
    if (selecting) open.setAttribute("aria-pressed", String(selected));
    const img = document.createElement("img");
    img.className = "short-video-cover-image";
    img.dataset.src = coverUrl;
    img.dataset.videoId = video.id;
    img.alt = video.title || "短视频封面";
    img.loading = index < coverEagerCount ? "eager" : "lazy";
    img.decoding = "async";
    img.fetchPriority = index < 8 ? "high" : "low";
    open.append(img);
    const like = document.createElement("span");
    like.className = "short-video-like-badge";
    like.append(createIcon("heart"), document.createTextNode(formatShortVideoMetric(video, "likes")));
    applyShortVideoStatsBadgeState(like, video);
    open.append(like);
    if (isGalleryPost(video)) {
      open.append(galleryBadge(video));
    } else if (!authorWork) {
      const durationText = formatDuration(video.durationMs);
      if (durationText) {
        const duration = document.createElement("span");
        duration.className = "short-video-duration-badge";
        duration.textContent = durationText;
        open.append(duration);
      }
    }
    appendShortVideoWatchBadge(open, video);
    const selectionBadge = document.createElement("span");
    selectionBadge.className = "short-video-selection-badge";
    selectionBadge.append(createIcon("check"));
    open.append(selectionBadge);
    open.addEventListener("click", () => {
      if (state.shortVideo.deleteMode) {
        toggleShortVideoSelected(video.id);
        return;
      }
      openVideo(video.id).catch(showError);
    });
    thumb.append(open);
    const title = document.createElement("div");
    title.className = "short-video-card-title";
    title.textContent = cardTitle(video);
    card.append(thumb, title);
    if (authorWork) {
      const meta = document.createElement("div");
      meta.className = "short-video-card-meta";
      const date = document.createElement("span");
      date.textContent = formatDate(video.publishedAt) || "日期未知";
      const duration = document.createElement("span");
      duration.textContent = isGalleryPost(video) ? galleryLabel(video) : (formatDuration(video.durationMs) || "-");
      const comments = document.createElement("span");
      comments.append(createIcon("comment"), document.createTextNode(formatShortVideoMetric(video, "comments")));
      meta.append(date, duration, comments);
      card.append(meta);
    } else {
      const subline = document.createElement("div");
      subline.className = "short-video-card-subline";
      const authorName = String(video.author?.name || "未知作者").trim() || "未知作者";
      if (authorScopeId(video, video.author)) {
        const author = document.createElement("button");
        author.type = "button";
        author.className = "short-video-card-author";
        author.textContent = shortVideoAuthorHandle(authorName);
        author.title = `查看 ${authorName}`;
        author.disabled = selecting;
        author.addEventListener("click", () => openShortVideoAuthorPage(video.author, video));
        subline.append(author);
      } else {
        const author = document.createElement("span");
        author.className = "short-video-card-author is-static";
        author.textContent = shortVideoAuthorHandle(authorName);
        subline.append(author);
      }
      if (state.shortVideo.source === "recommended" && video.recommendation?.reason) {
        const reason = document.createElement("span");
        reason.className = "short-video-recommend-reason";
        reason.textContent = video.recommendation.reason;
        subline.append(reason);
      }
      const date = document.createElement("span");
      date.className = "short-video-card-date";
      date.textContent = formatDate(video.publishedAt) || "日期未知";
      subline.append(date);
      card.append(subline);
    }
    return card;
  }

  function appendShortVideoWatchBadge(target, video = {}) {
    const watchedAt = String(video?.watch?.lastWatchedAt || "").trim();
    if (!watchedAt) return;
    const completed = Boolean(video?.watch?.completed);
    const progressMs = Math.max(0, Number(video?.watch?.progressMs || 0));
    const durationMs = Math.max(0, Number(video?.durationMs || 0));
    const ratio = completed
      ? 1
      : (durationMs > 0 ? Math.max(0, Math.min(1, progressMs / durationMs)) : 0);
    const badge = document.createElement("span");
    badge.className = "short-video-watch-badge";
    badge.textContent = completed
      ? "已看完"
      : (progressMs >= 1000 ? `续播 ${formatSeconds(progressMs / 1000)}` : "看过");
    const track = document.createElement("span");
    track.className = "short-video-watch-progress";
    const fill = document.createElement("span");
    fill.style.width = `${Math.max(3, Math.round(ratio * 100))}%`;
    track.append(fill);
    target.append(badge, track);
  }

  function shortVideoCardCoverUrl(video = {}) {
    return video.coverUrl || "";
  }

  function shortVideosWithCovers(videos = []) {
    return (videos || []).filter((video) => shortVideoCardCoverUrl(video));
  }

  function isGalleryPost(video = {}) {
    return String(video.mediaType || "").toLowerCase() === "gallery" && galleryImageEntries(video).length > 0;
  }

  function galleryImageEntries(video = {}) {
    if (Array.isArray(video.galleryItems) && video.galleryItems.length) {
      return video.galleryItems
        .filter((item) => item && item.url)
        .map((item) => ({ ...item, type: item.type === "video" ? "video" : "image" }));
    }
    return Array.isArray(video.galleryImages)
      ? video.galleryImages.filter((item) => item && item.url).map((item) => ({ ...item, type: "image" }))
      : [];
  }

  function galleryLabel(video = {}) {
    const count = Number(video.galleryCount || galleryImageEntries(video).length || 0);
    const hasVideo = galleryImageEntries(video).some((item) => item.type === "video");
    return `${Math.max(1, count)} ${hasVideo ? "项" : "张"}`;
  }

  function galleryBadge(video = {}) {
    const badge = document.createElement("span");
    badge.className = "short-video-gallery-badge";
    badge.append(createIcon("images"), document.createTextNode(galleryLabel(video)));
    return badge;
  }

  function cardTitle(video = {}) {
    return String(video.title || video.description || video.fileName || "无标题").replace(/\s+/g, " ").trim() || "无标题";
  }

  function resetLoadMoreObserver() {
    loadMoreObserver?.disconnect?.();
    loadMoreObserver = null;
  }

  function resetCoverLoadObserver() {
    coverLoadObserver?.disconnect?.();
    coverLoadObserver = null;
    if (coverLoadTimer) window.clearTimeout(coverLoadTimer);
    coverLoadTimer = null;
    coverLoadQueue.length = 0;
  }

  function activateShortVideoCovers(root) {
    const images = [...(root?.querySelectorAll?.("img.short-video-cover-image[data-src]") || [])];
    const observer = ensureShortVideoCoverObserver();
    images.forEach((img, index) => {
      if (index < coverEagerCount || !observer) {
        queueShortVideoCover(img);
      } else {
        observer.observe(img);
      }
    });
  }

  function activateShortVideoCoversForNodes(nodes) {
    const observer = ensureShortVideoCoverObserver();
    const viewportCenter = (window.innerHeight || document.documentElement.clientHeight || 800) / 2;
    const images = [];
    for (const node of nodes || []) {
      for (const img of node?.querySelectorAll?.("img.short-video-cover-image[data-src]") || []) {
        const rect = img.getBoundingClientRect();
        images.push({ img, distance: Math.abs((rect.top + rect.bottom) / 2 - viewportCenter) });
      }
    }
    images.sort((a, b) => a.distance - b.distance);
    for (const { img, distance } of images) {
      if (!observer || distance < viewportCenter * 1.35) {
        img.fetchPriority = "high";
        queueShortVideoCover(img);
      } else {
        observer.observe(img);
      }
    }
  }

  function ensureShortVideoCoverObserver() {
    if (!("IntersectionObserver" in window)) return null;
    if (!coverLoadObserver) {
      coverLoadObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) queueShortVideoCover(entry.target);
        }
      }, { rootMargin: "720px 0px", threshold: 0.01 });
    }
    return coverLoadObserver;
  }

  function queueShortVideoCover(img) {
    if (!img?.dataset?.src || img.dataset.queued === "1" || img.dataset.loaded === "1") return;
    coverLoadObserver?.unobserve(img);
    img.dataset.queued = "1";
    coverLoadQueue.push(img);
    scheduleShortVideoCoverDrain();
  }

  function scheduleShortVideoCoverDrain(delay = 0) {
    if (coverLoadTimer) return;
    coverLoadTimer = window.setTimeout(drainShortVideoCoverQueue, delay);
  }

  function drainShortVideoCoverQueue() {
    coverLoadTimer = null;
    let loaded = 0;
    while (coverLoadQueue.length && loaded < coverLoadBatchSize) {
      const img = coverLoadQueue.shift();
      if (!img?.isConnected || !img.dataset.src || img.dataset.loaded === "1") continue;
      loadShortVideoCover(img);
      loaded += 1;
    }
    if (coverLoadQueue.length) scheduleShortVideoCoverDrain(coverLoadBatchDelay);
  }

  function loadShortVideoCover(img) {
    const src = img.dataset.src;
    img.dataset.loaded = "1";
    delete img.dataset.src;
    img.addEventListener("load", () => {
      img.classList.add("is-loaded");
      const vid = img.dataset.videoId;
      if (vid) loadedCoverIds.add(vid);
    }, { once: true });
    img.addEventListener("error", () => {
      img.classList.add("is-cover-error");
    }, { once: true });
    img.src = src;
  }

  function observeLoadMoreSentinel(sentinel) {
    if (!sentinel || !("IntersectionObserver" in window)) {
      if (state.shortVideo.data?.hasMore) loadVideos({ append: true, keepCurrent: true }).catch(showError);
      return;
    }
    loadMoreObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (!state.shortVideo.data?.hasMore || state.shortVideo.loadingMore || state.shortVideo.loading) return;
      loadVideos({ append: true, keepCurrent: true }).catch(showError);
    }, { root: null, rootMargin: "900px 0px", threshold: 0.01 });
    loadMoreObserver.observe(sentinel);
  }

  function renderBrowserTop() {
    const top = document.createElement("div");
    top.className = "short-video-browser-top";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "short-video-close";
    back.setAttribute("aria-label", "返回短视频列表");
    back.append(createIcon("chevronLeft"));
    back.addEventListener("click", showHome);
    const search = document.createElement("button");
    search.type = "button";
    search.className = "short-video-browser-search";
    search.setAttribute("aria-label", "返回列表搜索短视频");
    search.append(createIcon("search"));
    const searchText = document.createElement("span");
    searchText.className = "short-video-browser-search-text";
    searchText.textContent = shortVideoSearch.label();
    const searchAction = document.createElement("span");
    searchAction.className = "short-video-browser-search-action";
    searchAction.textContent = "搜索";
    search.append(searchText, searchAction);
    search.addEventListener("click", showHomeAndFocusSearch);
    top.append(back, search);
    return top;
  }

  function renderBrowserLoading() {
    const page = document.createElement("section");
    page.className = `short-video-browser is-loading-shell${shortVideoOpenError ? " is-load-error" : ""}`;
    const stage = document.createElement("div");
    stage.className = "short-video-loading-stage";
    const shimmer = document.createElement("span");
    shimmer.className = "short-video-loading-shimmer";
    shimmer.setAttribute("aria-hidden", "true");
    const status = document.createElement("div");
    status.className = "short-video-opening-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const icon = createIcon("repeat");
    icon.classList.add("short-video-opening-icon");
    const title = document.createElement("strong");
    title.textContent = shortVideoOpenError ? "作品暂时打不开" : "正在准备作品";
    const detail = document.createElement("span");
    detail.className = "short-video-opening-detail";
    detail.textContent = shortVideoOpenError || "正在读取本地媒体";
    status.append(icon, title, detail);
    if (shortVideoOpenError) {
      const actions = document.createElement("div");
      actions.className = "short-video-opening-actions";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新加载";
      retry.addEventListener("click", () => openVideo(shortVideoOpeningId).catch(showError));
      const back = document.createElement("button");
      back.type = "button";
      back.textContent = "返回列表";
      back.addEventListener("click", showHome);
      actions.append(retry, back);
      status.append(actions);
    }
    stage.append(shimmer, status);
    const controls = document.createElement("div");
    controls.className = "short-video-loading-controls";
    controls.setAttribute("aria-hidden", "true");
    controls.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
    page.append(renderBrowserTop(), stage, controls);
    els.workGrid.append(page);
  }

  function renderBrowser() {
    const video = state.shortVideo.current;
    const page = document.createElement("section");
    page.className = "short-video-browser";
    const slideDirection = Number(state.shortVideo.slideDirection || 0);
    if (slideDirection > 0) page.classList.add("is-slide-next");
    else if (slideDirection < 0) page.classList.add("is-slide-prev");
    if (slideDirection) {
      page.addEventListener("animationend", () => {
        if (state.shortVideo) state.shortVideo.slideDirection = 0;
      }, { once: true });
    }
    const top = renderBrowserTop();

    const stack = document.createElement("div");
    stack.className = "short-video-reel-stack";
    if (state.shortVideo.dragging) stack.classList.add("is-dragging");
    if (state.shortVideo.prevVideo) {
      stack.append(renderReelPanel(state.shortVideo.prevVideo, { ghost: true, slot: "prev" }).panel);
    }
    const current = renderReelPanel(video, { slot: "current" });
    const { player, syncPlayToggle } = current;
    stack.append(current.panel);
    if (state.shortVideo.nextVideo) {
      stack.append(renderReelPanel(state.shortVideo.nextVideo, { ghost: true, slot: "next" }).panel);
    }
    page.append(top, stack, renderBrowserNav(), isGalleryPost(video) ? renderGalleryControlBar(video) : renderControlBar());
    els.workGrid.append(page);
    syncPlayToggle();
    bindBrowserControlVisibility(page, player);
    if (!player) return;
    window.requestAnimationFrame(() => {
      player.play().then(syncPlayToggle).catch(() => {
        if (state.shortVideo.muted) {
          player.muted = true;
          player.play().then(syncPlayToggle).catch(syncPlayToggle);
          return;
        }
        markPlayerSoundBlocked(player.closest(".short-video-stage"));
        player.muted = true;
        player.play().then(syncPlayToggle).catch(syncPlayToggle);
        syncPlayToggle();
      });
    });
  }

  function renderReelPanel(video, options = {}) {
    const ghost = Boolean(options.ghost);
    const slot = options.slot || "current";
    const panel = document.createElement("div");
    panel.className = `short-video-reel-panel is-${slot}${ghost ? " is-ghost-panel" : ""}`;
    panel.dataset.videoId = String(video?.id || "");
    if (ghost) {
      panel.setAttribute("aria-hidden", "true");
      // 相邻作品只用于画面预热和切换动画，不能进入当前作品的键盘顺序。
      panel.inert = true;
    }

    const gallery = isGalleryPost(video);
    panel.classList.toggle("is-gallery-post", gallery);
    const staticBackdropUrl = video.coverUrl || (gallery
      ? galleryImageEntries(video).find((item) => item.type !== "video")?.url || ""
      : "");
    const useStaticBackdrop = gallery || Boolean(staticBackdropUrl);
    const backdrop = document.createElement(useStaticBackdrop ? "img" : "video");
    backdrop.className = "short-video-backdrop-video";
    if (useStaticBackdrop) {
      backdrop.classList.add("short-video-backdrop-image");
      backdrop.src = staticBackdropUrl;
      backdrop.alt = "";
      backdrop.setAttribute("aria-hidden", "true");
    } else {
      backdrop.src = video.streamUrl;
      backdrop.muted = true;
      backdrop.playsInline = true;
      backdrop.loop = true;
      backdrop.preload = ghost ? "metadata" : "auto";
      if (video.coverUrl) backdrop.poster = video.coverUrl;
      if (!ghost) window.requestAnimationFrame(() => backdrop.play().catch(() => {}));
    }

    const stage = document.createElement("div");
    stage.className = gallery ? "short-video-stage is-gallery-stage is-video-ready" : "short-video-stage is-video-loading";
    stage.setAttribute("aria-busy", String(!gallery));
    stage.tabIndex = -1;
    stage.addEventListener("pointerdown", (event) => {
      if (isShortVideoKeyboardControl(event.target)) return;
      stage.focus({ preventScroll: true });
    });
    applyVideoOrientation(panel, stage, video.width, video.height);
    if (video.coverUrl) {
      stage.style.setProperty("--short-video-cover", `url(${JSON.stringify(video.coverUrl)})`);
    }
    let player = null;
    let syncPlayToggle = () => {};
    if (gallery) {
      stage.append(renderGalleryPlayer(video, { ghost, stage, railGetter: () => rail }));
    } else {
      player = document.createElement("video");
      player.className = "short-video-player";
      if (ghost) player.classList.add("is-ghost");
      player.src = video.streamUrl;
      player.dataset.streamUrl = video.streamUrl;
      if (video.coverUrl) player.poster = video.coverUrl;
      player.controls = false;
      player.autoplay = !ghost;
      player.muted = ghost ? true : Boolean(state.shortVideo.muted);
      player.volume = currentShortVideoVolume();
      player.playbackRate = normalizePlaybackRate(state.shortVideo.playbackRate);
      player.playsInline = true;
      player.loop = true;
      player.preload = ghost ? "none" : "auto";
      let firstFramePromise = null;
      const revealVideoFrame = () => {
        stage.classList.remove("is-video-loading", "is-video-buffering", "is-video-error");
        stage.classList.add("is-video-ready");
        stage.setAttribute("aria-busy", "false");
        if (!player.dataset.shortVideoMediaReadyAt) player.dataset.shortVideoMediaReadyAt = String(Date.now());
        applyVideoOrientation(panel, stage, player.videoWidth, player.videoHeight);
      };
      const markVideoReady = () => {
        if (stage.classList.contains("is-video-ready") || firstFramePromise) return;
        firstFramePromise = waitForVideoFirstFrame(player, 420).then((ready) => {
          firstFramePromise = null;
          if (!player.isConnected || stage.classList.contains("is-video-ready")) return;
          if (!ready && player.readyState < 2) return;
          revealVideoFrame();
        });
      };
      player.addEventListener("loadedmetadata", () => {
        applyVideoOrientation(panel, stage, player.videoWidth, player.videoHeight);
      });
      player.addEventListener("loadeddata", markVideoReady);
      player.addEventListener("canplay", markVideoReady);
      player.addEventListener("playing", markVideoReady);
      window.requestAnimationFrame(() => {
        if (player.readyState >= 2) markVideoReady();
      });
      if (ghost) {
        stage.append(player);
        scheduleAdjacentVideoWarmup(player, video, slot);
      } else {
        syncPlayToggle = attachPrimaryPlayerControls(stage, player, () => rail, video);
      }
    }

    const info = document.createElement("div");
    info.className = "short-video-caption";
    const tools = document.createElement("div");
    tools.className = "short-video-caption-context";
    const recommend = document.createElement("button");
    recommend.type = "button";
    recommend.className = "short-video-caption-context-button";
    recommend.append(createIcon("repeat"), document.createTextNode("相关推荐"));
    recommend.addEventListener("click", () => showAuthorPanel(video, {
      initialTab: "related",
      switchAuthorFeed: false
    }));
    const identify = document.createElement("button");
    identify.type = "button";
    identify.className = "short-video-caption-context-button short-video-identify-button";
    identify.append(createIcon("ai"), document.createTextNode("识别内容"));
    identify.addEventListener("click", () => showAuthorPanel(video, {
      initialTab: "ai",
      switchAuthorFeed: false
    }).catch(showError));
    tools.append(recommend, identify);
    const author = authorCaptionButton(video);
    const captionCopy = document.createElement("div");
    captionCopy.className = "short-video-caption-copy";
    const title = document.createElement("p");
    title.id = `short-video-caption-${String(video.id || "current").replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    appendCaptionText(title, captionTitleWithTags(video), video);
    const captionToggle = document.createElement("button");
    captionToggle.type = "button";
    captionToggle.className = "short-video-caption-expand";
    captionToggle.textContent = "… 展开";
    captionToggle.hidden = true;
    captionToggle.setAttribute("aria-expanded", "false");
    captionToggle.setAttribute("aria-label", "展开完整标题");
    captionToggle.setAttribute("aria-controls", title.id);
    const setCaptionExpanded = (expanded) => {
      captionCopy.classList.toggle("is-expanded", expanded);
      captionToggle.textContent = expanded ? "收起" : "… 展开";
      captionToggle.setAttribute("aria-expanded", String(expanded));
      captionToggle.setAttribute("aria-label", expanded ? "收起完整标题" : "展开完整标题");
      if (!expanded) title.scrollTop = 0;
    };
    title.addEventListener("click", (event) => {
      if (!captionCopy.classList.contains("can-expand") || event.target.closest?.("button")) return;
      setCaptionExpanded(!captionCopy.classList.contains("is-expanded"));
    });
    captionToggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setCaptionExpanded(!captionCopy.classList.contains("is-expanded"));
    });
    captionCopy.append(title, captionToggle);
    let soundButton = null;
    if (video.sound) {
      soundButton = document.createElement("button");
      soundButton.type = "button";
      soundButton.className = "short-video-caption-sound";
      soundButton.setAttribute("aria-label", `查看原声：${video.sound.title || "作品原声"}`);
      const soundCover = document.createElement("span");
      soundCover.className = "short-video-caption-sound-cover";
      if (video.sound.coverUrl) {
        const soundImage = document.createElement("img");
        soundImage.src = video.sound.coverUrl;
        soundImage.alt = "";
        soundImage.decoding = "async";
        soundCover.append(soundImage);
      } else {
        soundCover.append(createIcon("headphones"));
      }
      const soundCopy = document.createElement("span");
      const soundTitle = document.createElement("strong");
      soundTitle.textContent = video.sound.title || "作品原声";
      const soundAuthor = document.createElement("small");
      soundAuthor.textContent = [video.sound.author || video.author?.name || "", video.sound.localAvailable ? "本地原声" : "原声"].filter(Boolean).join(" · ");
      soundCopy.append(soundTitle, soundAuthor);
      soundButton.append(soundCover, soundCopy);
      soundButton.addEventListener("click", () => showAuthorPanel(video, {
        initialTab: "sound",
        switchAuthorFeed: false
      }).catch(showError));
    }
    const meta = document.createElement("span");
    meta.className = "short-video-caption-meta";
    meta.textContent = [gallery ? `图集 · ${galleryLabel(video)}` : formatDuration(video.durationMs), formatBytes(video.size || 0)].filter(Boolean).join(" · ");
    info.append(author, captionCopy);
    if (soundButton) info.append(soundButton);
    info.append(meta, tools);
    panel.append(backdrop, stage, info);
    const syncCaptionOverflow = () => {
      if (!title.isConnected) return;
      const wasExpanded = captionCopy.classList.contains("is-expanded");
      if (wasExpanded) captionCopy.classList.remove("is-expanded");
      const canExpand = title.scrollHeight > title.clientHeight + 1;
      if (wasExpanded && canExpand) captionCopy.classList.add("is-expanded");
      captionCopy.classList.toggle("can-expand", canExpand);
      captionToggle.hidden = !canExpand;
      if (!canExpand) setCaptionExpanded(false);
    };
    panel.shortVideoSyncCaptionOverflow = syncCaptionOverflow;
    if (!ghost) {
      window.requestAnimationFrame(() => {
        syncCaptionOverflow();
        window.requestAnimationFrame(syncCaptionOverflow);
      });
      document.fonts?.ready.then(syncCaptionOverflow).catch(() => {});
    }

    const rail = document.createElement("aside");
    rail.className = "short-video-rail";
    const aiButton = railButton("识别", createIcon("ai"), "ai", "识别当前内容", () => showAuthorPanel(video, {
      initialTab: "ai",
      switchAuthorFeed: false
    }).catch(showError));
    rail.append(authorRailButton(video));
    const likeButton = railMetric("heart", video.stats?.likes, "like", "点赞");
    likeButton.dataset.videoId = String(video.id || "");
    likeButton.dataset.actionType = "like";
    likeButton.dataset.boundPrimaryLike = "1";
    likeButton.addEventListener("click", (event) => {
      toggleShortVideoAction(video, "like", likeButton);
      showHeartBurst(stage, event);
    });
    applyRailActionButtonState(likeButton, "like", Boolean(video.actions?.liked), video.stats?.likes);
    rail.append(likeButton);
    rail.append(railMetric("comment", video.stats?.comments, "comment", "评论", () => showAuthorPanel(video, {
      initialTab: "comments",
      switchAuthorFeed: false
    })));
    const collectButton = railMetric("star", video.stats?.collects, "collect", "收藏");
    collectButton.dataset.videoId = String(video.id || "");
    collectButton.dataset.actionType = "collect";
    collectButton.addEventListener("click", () => toggleShortVideoAction(video, "collect", collectButton));
    applyRailActionButtonState(collectButton, "collect", Boolean(video.actions?.collected), video.stats?.collects);
    rail.append(collectButton);
    rail.append(railMetric("share", video.stats?.shares, "share", "分享", (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      shareShortVideo(video, { trigger: event?.currentTarget || null });
    }));
    const soundVisual = video.sound?.coverUrl
      ? Object.assign(document.createElement("img"), {
        className: "short-video-sound-rail-cover",
        src: video.sound.coverUrl,
        alt: ""
      })
      : createIcon("headphones");
    const listenButton = railButton(video.sound ? "原声" : "听抖音", soundVisual, "listen", video.sound ? `原声：${video.sound.title}` : "听抖音", () => {
      if (!video.sound) {
        openDouyinLink(video);
        return;
      }
      showAuthorPanel(video, { initialTab: "sound", switchAuthorFeed: false }).catch(showError);
    });
    rail.append(listenButton);
    rail.append(aiButton);
    rail.append(railButton("", createIcon("more"), "more", "更多", (event) => {
      event.preventDefault();
      event.stopPropagation();
      showPlaybackSettings(video, { trigger: event.currentTarget });
    }));
    panel.append(rail);

    return { panel, player, syncPlayToggle };
  }

  function renderGalleryPlayer(video, options = {}) {
    const images = galleryImageEntries(video);
    const ghost = Boolean(options.ghost);
    const stage = options.stage;
    const wrap = document.createElement("div");
    wrap.className = `short-video-gallery-player${ghost ? " is-ghost" : ""}`;
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "图文播放器");
    if (images.length > 1) wrap.setAttribute("aria-description", "左右滑动翻图，上下滑动切换作品");
    wrap.dataset.galleryIndex = "0";
    wrap.dataset.galleryRequestedIndex = "0";
    wrap.dataset.galleryCount = String(images.length);
    wrap.style.setProperty("--short-video-gallery-advance-duration", `${SHORT_VIDEO_GALLERY_ADVANCE_MS}ms`);

    const track = document.createElement("div");
    track.className = "short-video-gallery-track";

    const counter = document.createElement("span");
    counter.className = "short-video-gallery-counter";
    counter.setAttribute("role", "status");
    counter.setAttribute("aria-live", "polite");
    counter.setAttribute("aria-atomic", "true");

    const pager = document.createElement("div");
    pager.className = "short-video-gallery-pager";
    pager.setAttribute("role", "group");
    pager.setAttribute("aria-label", "图集翻页");

    const loadStatus = document.createElement("div");
    loadStatus.className = "short-video-gallery-load-status";
    loadStatus.setAttribute("aria-hidden", "true");
    const loadStatusCopy = document.createElement("span");
    loadStatusCopy.className = "short-video-gallery-load-copy";
    loadStatusCopy.setAttribute("role", "status");
    loadStatusCopy.setAttribute("aria-live", "polite");
    loadStatusCopy.setAttribute("aria-atomic", "true");
    const loadRetry = document.createElement("button");
    loadRetry.type = "button";
    loadRetry.className = "short-video-gallery-load-retry";
    loadRetry.textContent = "重试";
    loadRetry.hidden = true;
    loadStatus.append(loadStatusCopy, loadRetry);

    const gestureHint = document.createElement("div");
    gestureHint.className = "short-video-gallery-gesture-hint";
    gestureHint.setAttribute("aria-hidden", "true");
    gestureHint.textContent = "左右滑动翻图 · 上下滑动切作品";

    const progress = document.createElement("div");
    progress.className = "short-video-gallery-progress";
    progress.setAttribute("role", "tablist");
    progress.setAttribute("aria-label", "图集内容进度");
    const progressButtons = images.map((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.galleryMediaType = item?.type === "video" ? "video" : "image";
      button.setAttribute("role", "tab");
      const mediaLabel = item?.type === "video" ? "视频" : "图片";
      button.setAttribute("aria-label", `查看第 ${index + 1} 项，共 ${images.length} 项，${mediaLabel}`);
      progress.append(button);
      return button;
    });

    const centerPlay = document.createElement("button");
    centerPlay.type = "button";
    centerPlay.className = "short-video-center-play is-gallery-center-play";
    centerPlay.tabIndex = -1;
    centerPlay.setAttribute("aria-hidden", "true");
    setIconButton(centerPlay, "play", "继续播放图集");

    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "short-video-gallery-nav is-previous";
    previous.append(createIcon("chevronLeft"));
    previous.setAttribute("aria-label", "上一项内容");

    const next = document.createElement("button");
    next.type = "button";
    next.className = "short-video-gallery-nav is-next";
    next.append(createIcon("chevronLeft"));
    next.setAttribute("aria-label", "下一项内容");

    const edgePrevious = document.createElement("button");
    edgePrevious.type = "button";
    edgePrevious.className = "short-video-gallery-edge-nav is-previous";
    edgePrevious.append(createIcon("chevronLeft"));
    edgePrevious.setAttribute("aria-label", "上一项图集内容");
    edgePrevious.title = "上一张（←）";

    const edgeNext = document.createElement("button");
    edgeNext.type = "button";
    edgeNext.className = "short-video-gallery-edge-nav is-next";
    edgeNext.append(createIcon("chevronLeft"));
    edgeNext.setAttribute("aria-label", "下一项图集内容");
    edgeNext.title = "下一张（→）";

    let currentIndex = 0;
    let requestedIndex = 0;
    let currentReady = false;
    let image = null;
    let requestToken = 0;
    let cacheClock = 0;
    let animationTimer = 0;
    let boundaryTimer = 0;
    let loadStatusTimer = 0;
    let loadStatusHideTimer = 0;
    let failedLoadIndex = -1;
    let failedLoadDirection = 0;
    let dragActive = false;
    let dragDirection = 0;
    let dragVisualX = 0;
    let dragPreviewEntry = null;
    let dragPreviewToken = 0;
    let dragSettleTimer = 0;
    let advanceTimer = 0;
    let advanceStartedAt = 0;
    let advanceRemainingMs = SHORT_VIDEO_GALLERY_ADVANCE_MS;
    let advanceEntry = null;
    let videoProgressRaf = 0;
    let galleryVisibilityPaused = false;
    let galleryUserPaused = false;
    let backgroundAudio = null;
    let syncGallerySoundState = () => {};
    let galleryClickTimer = 0;
    let captionMetaTimer = 0;
    let counterMotionTimer = 0;
    let localSoundPollTimer = 0;
    let localSoundPollAttempts = 0;
    let gestureHintTimer = 0;
    let gestureHintShown = false;
    const imageCache = new Map();

    const dismissGalleryGestureHint = () => {
      window.clearTimeout(gestureHintTimer);
      gestureHintTimer = 0;
      gestureHint.classList.remove("is-visible");
    };
    const maybeShowGalleryGestureHint = () => {
      if (ghost || gestureHintShown || images.length <= 1 || !window.matchMedia?.("(max-width: 680px)")?.matches) return;
      let alreadySeen = false;
      try {
        alreadySeen = window.sessionStorage?.getItem(SHORT_VIDEO_GALLERY_GESTURE_HINT_KEY) === "1";
      } catch {}
      if (alreadySeen) return;
      gestureHintShown = true;
      try {
        window.sessionStorage?.setItem(SHORT_VIDEO_GALLERY_GESTURE_HINT_KEY, "1");
      } catch {}
      window.requestAnimationFrame(() => gestureHint.classList.add("is-visible"));
      gestureHintTimer = window.setTimeout(dismissGalleryGestureHint, SHORT_VIDEO_GALLERY_GESTURE_HINT_MS);
    };

    const createGalleryImage = (index) => {
      const mediaType = images[index]?.type === "video" ? "video" : "image";
      const element = document.createElement(mediaType === "video" ? "video" : "img");
      element.className = "short-video-gallery-image";
      if (mediaType === "video") {
        element.muted = true;
        element.playsInline = true;
        element.preload = ghost ? "metadata" : "auto";
        element.setAttribute("aria-label", `${video.title || "图文作品"}，第 ${index + 1} 项视频，共 ${images.length} 项`);
      } else {
        element.alt = `${video.title || "图文作品"}，第 ${index + 1} 张，共 ${images.length} 张`;
        element.decoding = "async";
      }
      element.draggable = false;
      element.dataset.galleryImageIndex = String(index);
      element.dataset.galleryMediaType = mediaType;
      return element;
    };
    const loadImage = (index) => {
      const cached = imageCache.get(index);
      if (cached) {
        cached.lastUsed = ++cacheClock;
        return cached;
      }
      const element = createGalleryImage(index);
      const entry = {
        index,
        mediaType: images[index]?.type === "video" ? "video" : "image",
        image: element,
        status: "loading",
        cancelled: false,
        lastUsed: ++cacheClock,
        promise: null,
        cancel: () => {}
      };
      entry.promise = new Promise((resolve) => {
        let settled = false;
        const finish = async (ready) => {
          if (settled) return;
          settled = true;
          element.removeEventListener(entry.mediaType === "video" ? "canplay" : "load", handleLoad);
          element.removeEventListener("error", handleError);
          if (ready && entry.mediaType === "image" && !entry.cancelled && typeof element.decode === "function") {
            try {
              await element.decode();
            } catch {
              // The load event still proves the image can be displayed.
            }
          }
          if (entry.cancelled) {
            resolve(null);
            return;
          }
          entry.status = ready ? "ready" : "error";
          if (!ready && imageCache.get(index) === entry) imageCache.delete(index);
          resolve(ready ? entry : null);
        };
        const handleLoad = () => finish(true);
        const handleError = () => finish(false);
        entry.cancel = () => {
          if (settled) return;
          entry.cancelled = true;
          element.removeEventListener(entry.mediaType === "video" ? "canplay" : "load", handleLoad);
          element.removeEventListener("error", handleError);
          element.pause?.();
          element.removeAttribute("src");
          settled = true;
          resolve(null);
        };
        element.addEventListener(entry.mediaType === "video" ? "canplay" : "load", handleLoad, { once: true });
        element.addEventListener("error", handleError, { once: true });
        element.src = images[index].url;
        if (entry.mediaType === "video") {
          element.load?.();
          if (element.readyState >= 3) Promise.resolve().then(handleLoad);
        } else if (element.complete && element.naturalWidth) {
          Promise.resolve().then(handleLoad);
        }
      });
      imageCache.set(index, entry);
      return entry;
    };
    const releaseEntry = (entry) => {
      if (!entry || entry.image === image) return false;
      entry.cancelled = true;
      entry.cancel?.();
      entry.image.pause?.();
      entry.image.removeAttribute("src");
      if (imageCache.get(entry.index) === entry) imageCache.delete(entry.index);
      return true;
    };
    const trimImageCache = (keepIndexes = new Set()) => {
      const protectedIndexes = new Set([currentIndex, requestedIndex, ...keepIndexes]);
      const candidates = [...imageCache.values()]
        .filter((entry) => !protectedIndexes.has(entry.index) && entry.image !== image)
        .sort((a, b) => a.lastUsed - b.lastUsed);
      while (imageCache.size > 7 && candidates.length) releaseEntry(candidates.shift());
    };
    const resolveGalleryIndex = (index) => {
      if (!images.length) return 0;
      return ((Number(index) % images.length) + images.length) % images.length;
    };
    const preloadAround = (index, direction = 0) => {
      const offsets = direction > 0 ? [1, 2, -1] : (direction < 0 ? [-1, -2, 1] : [-1, 1, -2, 2]);
      const preloadIndexes = [...new Set(offsets
        .map((offset) => resolveGalleryIndex(index + offset))
        .filter((item) => item !== index))];
      preloadIndexes.forEach((item) => loadImage(item));
      trimImageCache(new Set([index, ...preloadIndexes]));
    };
    const hideLoadStatus = () => {
      window.clearTimeout(loadStatusTimer);
      window.clearTimeout(loadStatusHideTimer);
      wrap.classList.remove("is-image-loading");
      wrap.setAttribute("aria-busy", "false");
      loadStatus.classList.remove("is-visible", "is-error");
      loadStatus.setAttribute("aria-hidden", "true");
      loadStatusCopy.textContent = "";
      loadRetry.hidden = true;
      failedLoadIndex = -1;
      failedLoadDirection = 0;
    };
    const showLoadStatus = (index) => {
      window.clearTimeout(loadStatusTimer);
      window.clearTimeout(loadStatusHideTimer);
      wrap.classList.add("is-image-loading");
      wrap.setAttribute("aria-busy", "true");
      loadStatus.classList.remove("is-visible", "is-error");
      loadStatus.setAttribute("aria-hidden", "true");
      loadRetry.hidden = true;
      loadStatusCopy.textContent = currentReady && currentIndex !== index
        ? `正在载入 ${index + 1}/${images.length}，当前仍显示 ${currentIndex + 1}/${images.length}`
        : `正在载入 ${index + 1}/${images.length}`;
      loadStatusTimer = window.setTimeout(() => {
        if (requestedIndex === index && (!currentReady || currentIndex !== index)) {
          loadStatus.setAttribute("aria-hidden", "false");
          loadStatus.classList.add("is-visible");
        }
      }, 120);
    };
    const showLoadError = (index, direction = 0) => {
      window.clearTimeout(loadStatusTimer);
      window.clearTimeout(loadStatusHideTimer);
      wrap.classList.remove("is-image-loading");
      wrap.setAttribute("aria-busy", "false");
      failedLoadIndex = index;
      failedLoadDirection = direction || Math.sign(index - currentIndex);
      requestedIndex = currentIndex;
      syncRequestedUi();
      loadStatusCopy.textContent = currentReady
        ? `第 ${index + 1} 项暂时无法载入，仍显示 ${currentIndex + 1}/${images.length}`
        : `第 ${index + 1} 项暂时无法载入`;
      loadRetry.hidden = false;
      loadRetry.setAttribute("aria-label", `重试载入第 ${index + 1} 项`);
      loadStatus.setAttribute("aria-hidden", "false");
      loadStatus.classList.add("is-visible", "is-error");
    };
    const animateImage = (direction) => {
      window.clearTimeout(animationTimer);
      if (!image) return;
      image.classList.remove("is-entering-next", "is-entering-previous");
      if (!direction || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
      image.getBoundingClientRect();
      image.classList.add(direction > 0 ? "is-entering-next" : "is-entering-previous");
      animationTimer = window.setTimeout(() => {
        image.classList.remove("is-entering-next", "is-entering-previous");
      }, 260);
    };
    const showBoundary = (direction) => {
      window.clearTimeout(boundaryTimer);
      wrap.classList.remove("is-boundary-start", "is-boundary-end");
      wrap.classList.add(direction < 0 ? "is-boundary-start" : "is-boundary-end");
      boundaryTimer = window.setTimeout(() => {
        wrap.classList.remove("is-boundary-start", "is-boundary-end");
      }, 280);
    };
    const syncGalleryCaptionState = (direction = 0) => {
      const caption = stage?.closest?.(".short-video-reel-panel")?.querySelector?.(".short-video-caption");
      const captionMeta = caption?.querySelector?.(".short-video-caption-meta");
      if (!caption || !captionMeta) return;
      caption.dataset.galleryIndex = String(currentIndex);
      captionMeta.textContent = [
        `图集 · ${currentIndex + 1}/${images.length}`,
        formatBytes(video.size || 0)
      ].filter(Boolean).join(" · ");
      captionMeta.classList.remove("is-page-next", "is-page-previous");
      window.clearTimeout(captionMetaTimer);
      if (!direction || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
      captionMeta.getBoundingClientRect();
      captionMeta.classList.add(direction > 0 ? "is-page-next" : "is-page-previous");
      captionMetaTimer = window.setTimeout(() => {
        captionMeta.classList.remove("is-page-next", "is-page-previous");
      }, 220);
    };
    const syncCommittedUi = (direction = 0) => {
      const current = images[currentIndex];
      counter.textContent = `${currentIndex + 1}/${images.length}`;
      counter.setAttribute("aria-label", `第 ${currentIndex + 1} 项，共 ${images.length} 项`);
      counter.classList.remove("is-page-next", "is-page-previous");
      window.clearTimeout(counterMotionTimer);
      if (direction && !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
        counter.getBoundingClientRect();
        counter.classList.add(direction > 0 ? "is-page-next" : "is-page-previous");
        counterMotionTimer = window.setTimeout(() => {
          counter.classList.remove("is-page-next", "is-page-previous");
        }, 220);
      }
      wrap.dataset.galleryIndex = String(currentIndex);
      wrap.classList.toggle("is-gallery-video-item", current?.type === "video");
      progressButtons.forEach((button, itemIndex) => {
        const active = itemIndex === currentIndex;
        button.classList.toggle("active", active);
        button.classList.toggle("is-past", itemIndex < currentIndex);
        button.setAttribute("aria-selected", String(active));
        if (active) button.setAttribute("aria-current", "true");
        else button.removeAttribute("aria-current");
      });
      if (current) stage?.style.setProperty("--short-video-cover", `url(${JSON.stringify(current.url)})`);
      syncGalleryCaptionState(direction);
    };
    const restartProgressTiming = () => {
      const activeButton = progressButtons[currentIndex];
      if (!activeButton) return;
      activeButton.style.setProperty("--short-video-gallery-media-progress", "0");
      activeButton.classList.remove("active");
      activeButton.getBoundingClientRect();
      activeButton.classList.add("active");
    };
    const syncRequestedUi = () => {
      wrap.dataset.galleryRequestedIndex = String(requestedIndex);
      previous.disabled = images.length <= 1;
      next.disabled = images.length <= 1;
      edgePrevious.disabled = images.length <= 1;
      edgeNext.disabled = images.length <= 1;
    };
    const stopVideoProgress = () => {
      if (videoProgressRaf) window.cancelAnimationFrame(videoProgressRaf);
      videoProgressRaf = 0;
    };
    const updateVideoProgress = (entry) => {
      if (!entry || entry.mediaType !== "video") return 0;
      const clip = entry.image;
      const duration = Math.max(0, Number(clip.duration || 0));
      const currentTime = Math.max(0, Number(clip.currentTime || 0));
      const ratio = duration > 0 ? Math.max(0, Math.min(1, currentTime / duration)) : 0;
      progressButtons[entry.index]?.style.setProperty("--short-video-gallery-media-progress", String(ratio));
      wrap.dataset.galleryVideoProgress = ratio.toFixed(4);
      return ratio;
    };
    const startVideoProgress = (entry) => {
      stopVideoProgress();
      if (!entry || entry.mediaType !== "video") {
        delete wrap.dataset.galleryVideoProgress;
        return;
      }
      const tick = () => {
        videoProgressRaf = 0;
        updateVideoProgress(entry);
        if (!wrap.isConnected
          || currentIndex !== entry.index
          || entry.image.paused
          || entry.image.ended
          || galleryTimingPaused()) return;
        videoProgressRaf = window.requestAnimationFrame(tick);
      };
      tick();
    };
    const clearAdvance = (options = {}) => {
      window.clearTimeout(advanceTimer);
      advanceTimer = 0;
      advanceStartedAt = 0;
      stopVideoProgress();
      if (options.detachVideo !== false && image?.tagName === "VIDEO") {
        image.onended = null;
        delete wrap.dataset.galleryVideoProgress;
      }
      if (options.reset !== false) {
        advanceRemainingMs = SHORT_VIDEO_GALLERY_ADVANCE_MS;
        advanceEntry = null;
      }
    };
    const galleryTimingPaused = () => galleryVisibilityPaused || galleryUserPaused;
    const syncGalleryPlaybackState = () => {
      const paused = galleryTimingPaused();
      wrap.classList.toggle("is-gallery-timing-paused", paused);
      wrap.dataset.galleryPlaybackPaused = galleryUserPaused ? "1" : "0";
      stage?.classList.toggle("is-paused", galleryUserPaused);
      const centerVisible = Boolean(galleryUserPaused && currentReady && !ghost);
      centerPlay.classList.toggle("is-visible", centerVisible);
      centerPlay.tabIndex = centerVisible ? 0 : -1;
      centerPlay.setAttribute("aria-hidden", String(!centerVisible));
      els.workGrid?.querySelector?.(".short-video-control-bar.is-gallery")?.shortVideoSync?.();
    };
    const startAdvance = (entry, options = {}) => {
      if (!entry || ghost || !wrap.isConnected || galleryTimingPaused() || document.hidden) return;
      if (entry.mediaType === "video") {
        const clip = entry.image;
        if (options.restartVideo !== false) clip.currentTime = 0;
        clip.muted = true;
        clip.onended = () => {
          updateVideoProgress(entry);
          if (images.length > 1 && wrap.isConnected && currentIndex === entry.index) move(1);
        };
        clip.play?.().catch(() => {}).finally(() => startVideoProgress(entry));
        return;
      }
      advanceStartedAt = Date.now();
      advanceTimer = window.setTimeout(() => {
        advanceTimer = 0;
        advanceStartedAt = 0;
        if (wrap.isConnected && currentIndex === entry.index) move(1);
      }, Math.max(0, advanceRemainingMs));
    };
    const scheduleAdvance = (entry) => {
      clearAdvance();
      if (!entry) return;
      advanceEntry = entry;
      galleryVisibilityPaused = document.hidden;
      syncGalleryPlaybackState();
      restartProgressTiming();
      startAdvance(entry);
    };
    const pauseAutoAdvance = (reason = "visibility") => {
      const wasPaused = galleryTimingPaused();
      if (reason === "user") galleryUserPaused = true;
      else galleryVisibilityPaused = true;
      if (!wasPaused && advanceTimer && advanceStartedAt) {
        advanceRemainingMs = Math.max(0, advanceRemainingMs - (Date.now() - advanceStartedAt));
      }
      if (!wasPaused) {
        clearAdvance({ reset: false, detachVideo: false });
        if (advanceEntry?.mediaType === "video") advanceEntry.image.pause?.();
      }
      if (reason === "user") backgroundAudio?.pause?.();
      syncGalleryPlaybackState();
      if (reason === "user") stage?.closest?.(".short-video-browser")?.shortVideoRevealControls?.(1900);
    };
    const resumeAutoAdvance = (reason = "visibility") => {
      if (reason === "user") galleryUserPaused = false;
      else galleryVisibilityPaused = false;
      syncGalleryPlaybackState();
      if (galleryTimingPaused()) return;
      const entry = advanceEntry;
      if (!entry || entry.index !== currentIndex || !currentReady) return;
      startAdvance(entry, { restartVideo: false });
      if (reason === "user" && backgroundAudio) playGallerySound();
      if (reason === "user") stage?.closest?.(".short-video-browser")?.shortVideoRevealControls?.(1900);
    };
    const playGallerySound = async () => {
      if (!backgroundAudio || galleryTimingPaused()) return false;
      try {
        await backgroundAudio.play?.();
        syncGallerySoundState();
        return !backgroundAudio.paused;
      } catch {
        if (!state.shortVideo.muted) markPlayerSoundBlocked(stage);
        backgroundAudio.muted = true;
        syncGallerySoundState();
        try {
          await backgroundAudio.play?.();
        } catch {
          // The environment may block audio playback entirely; keep the blocked state visible.
        }
        syncGallerySoundState();
        return false;
      }
    };
    const restoreGallerySound = async () => {
      if (!backgroundAudio) return "missing";
      state.shortVideo.muted = false;
      writeMutedPreference(false);
      backgroundAudio.muted = false;
      backgroundAudio.volume = currentShortVideoVolume();
      clearPlayerSoundBlocked(stage);
      syncGallerySoundState();
      if (galleryTimingPaused()) return "paused";
      return await playGallerySound() ? "playing" : "blocked";
    };
    const toggleGalleryPlayback = () => {
      if (galleryUserPaused) resumeAutoAdvance("user");
      else pauseAutoAdvance("user");
      return galleryUserPaused;
    };
    centerPlay.addEventListener("pointerdown", (event) => event.stopPropagation());
    centerPlay.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!galleryUserPaused) return;
      resumeAutoAdvance("user");
      stage?.focus?.({ preventScroll: true });
    });
    centerPlay.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    const commitImage = (entry, direction = 0, commitOptions = {}) => {
      const nextImage = entry.image;
      clearAdvance();
      if (image && image !== nextImage) {
        image.onended = null;
        image.pause?.();
      }
      nextImage.className = "short-video-gallery-image";
      if (entry.mediaType === "image") {
        nextImage.alt = `${video.title || "图文作品"}，第 ${entry.index + 1} 张，共 ${images.length} 张`;
      }
      track.replaceChildren(nextImage);
      image = nextImage;
      dragActive = false;
      dragDirection = 0;
      dragVisualX = 0;
      dragPreviewEntry = null;
      dragPreviewToken += 1;
      wrap.classList.remove("is-gallery-dragging", "is-gallery-settling");
      track.style.setProperty("--short-video-gallery-drag-x", "0px");
      wrap.dataset.galleryDragX = "0";
      delete wrap.dataset.galleryDragTarget;
      currentIndex = entry.index;
      requestedIndex = entry.index;
      currentReady = true;
      syncCommittedUi(direction);
      syncRequestedUi();
      hideLoadStatus();
      if (commitOptions.animate !== false) animateImage(direction);
      applyVideoOrientation(
        stage?.closest?.(".short-video-reel-panel"),
        stage,
        image.videoWidth || image.naturalWidth,
        image.videoHeight || image.naturalHeight
      );
      if (ghost) trimImageCache(new Set([currentIndex]));
      else preloadAround(currentIndex, direction);
      scheduleAdvance(entry);
      if (!direction) maybeShowGalleryGestureHint();
    };
    const show = (index, direction = 0) => {
      if (!images.length) return;
      if (dragActive || wrap.classList.contains("is-gallery-settling")) return false;
      const nextIndex = Math.max(0, Math.min(images.length - 1, Number(index) || 0));
      const resolvedDirection = direction || Math.sign(nextIndex - requestedIndex) || Math.sign(nextIndex - currentIndex);
      requestedIndex = nextIndex;
      syncRequestedUi();
      const token = ++requestToken;
      if (nextIndex === currentIndex && currentReady) {
        hideLoadStatus();
        preloadAround(currentIndex, resolvedDirection);
        return true;
      }
      showLoadStatus(nextIndex);
      const entry = loadImage(nextIndex);
      if (ghost) trimImageCache(new Set([nextIndex]));
      else preloadAround(nextIndex, resolvedDirection);
      entry.promise.then((readyEntry) => {
        if (token !== requestToken || requestedIndex !== nextIndex || !wrap.isConnected) return;
        if (!readyEntry) {
          showLoadError(nextIndex, resolvedDirection);
          return;
        }
        commitImage(readyEntry, resolvedDirection);
      });
      return true;
    };
    loadRetry.addEventListener("pointerdown", (event) => event.stopPropagation());
    loadRetry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (failedLoadIndex < 0) return;
      show(failedLoadIndex, failedLoadDirection);
    });
    loadRetry.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    const clearDragPreview = () => {
      const previewImage = dragPreviewEntry?.image;
      if (previewImage && previewImage !== image) {
        previewImage.classList.remove("is-drag-preview", "is-next", "is-previous");
        previewImage.remove();
      }
      dragPreviewEntry = null;
    };
    const prepareDragPreview = (direction) => {
      const token = ++dragPreviewToken;
      clearDragPreview();
      dragDirection = direction;
      const targetIndex = resolveGalleryIndex(currentIndex + direction);
      wrap.dataset.galleryDragTarget = String(targetIndex);
      const entry = loadImage(targetIndex);
      trimImageCache(new Set([currentIndex, targetIndex]));
      const attach = (readyEntry) => {
        if (!readyEntry || !dragActive || token !== dragPreviewToken || dragDirection !== direction) return;
        if (readyEntry.index !== resolveGalleryIndex(currentIndex + direction)) return;
        const previewImage = readyEntry.image;
        previewImage.className = `short-video-gallery-image is-drag-preview ${direction > 0 ? "is-next" : "is-previous"}`;
        dragPreviewEntry = readyEntry;
        track.append(previewImage);
      };
      if (entry.status === "ready") attach(entry);
      else entry.promise.then(attach);
    };
    const startDrag = () => {
      if (ghost || images.length <= 1 || !currentReady || dragActive || wrap.classList.contains("is-gallery-settling")) return false;
      window.clearTimeout(dragSettleTimer);
      clearAdvance();
      wrap.classList.add("is-gallery-timing-paused");
      requestToken += 1;
      requestedIndex = currentIndex;
      syncRequestedUi();
      hideLoadStatus();
      clearDragPreview();
      dragActive = true;
      dragDirection = 0;
      dragVisualX = 0;
      image?.classList.remove("is-entering-next", "is-entering-previous");
      wrap.classList.add("is-gallery-dragging");
      wrap.dataset.galleryDragX = "0";
      track.style.setProperty("--short-video-gallery-drag-x", "0px");
      return true;
    };
    const updateDrag = (deltaX) => {
      if (!dragActive) return false;
      const rawDelta = Number(deltaX || 0);
      const direction = rawDelta < 0 ? 1 : (rawDelta > 0 ? -1 : 0);
      if (direction && direction !== dragDirection) prepareDragPreview(direction);
      const targetIndex = resolveGalleryIndex(currentIndex + direction);
      const canMove = Boolean(direction && images.length > 1);
      const width = Math.max(1, wrap.clientWidth || stage?.clientWidth || 1);
      const bounded = Math.sign(rawDelta) * Math.min(Math.abs(rawDelta), width * 1.06);
      dragVisualX = canMove ? bounded : rawDelta * .22;
      track.style.setProperty("--short-video-gallery-drag-x", `${dragVisualX}px`);
      wrap.dataset.galleryDragX = String(Math.round(dragVisualX));
      return true;
    };
    const settleDrag = (targetX, callback, durationMs = 230) => {
      dragActive = false;
      wrap.classList.remove("is-gallery-dragging");
      wrap.classList.add("is-gallery-settling");
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      const settleDuration = reducedMotion ? 20 : Math.max(120, Math.min(280, Math.round(Number(durationMs) || 230)));
      wrap.style.setProperty("--short-video-gallery-settle-duration", `${settleDuration}ms`);
      wrap.dataset.gallerySettleDuration = String(settleDuration);
      dragVisualX = Number(targetX || 0);
      track.style.setProperty("--short-video-gallery-drag-x", `${dragVisualX}px`);
      wrap.dataset.galleryDragX = String(Math.round(dragVisualX));
      window.clearTimeout(dragSettleTimer);
      dragSettleTimer = window.setTimeout(() => {
        wrap.classList.remove("is-gallery-settling");
        callback?.();
        dragVisualX = 0;
        track.style.setProperty("--short-video-gallery-drag-x", "0px");
        wrap.dataset.galleryDragX = "0";
        delete wrap.dataset.galleryDragTarget;
      }, settleDuration + 10);
    };
    const endDrag = (deltaX, velocityX = 0) => {
      if (!dragActive) return false;
      const rawDelta = Number(deltaX || dragVisualX || 0);
      const velocity = Math.max(-2.4, Math.min(2.4, Number(velocityX || 0)));
      const projectedDelta = rawDelta + velocity * 180;
      const direction = rawDelta < 0 ? 1 : (rawDelta > 0 ? -1 : (velocity < 0 ? 1 : (velocity > 0 ? -1 : dragDirection)));
      const targetIndex = resolveGalleryIndex(currentIndex + direction);
      const canMove = Boolean(direction && images.length > 1);
      const width = Math.max(1, wrap.clientWidth || stage?.clientWidth || 1);
      const distanceReady = Math.abs(rawDelta) >= Math.min(120, width * .22);
      const projectedReady = Math.abs(projectedDelta) >= Math.min(96, width * .18)
        && Math.sign(projectedDelta) === Math.sign(rawDelta || projectedDelta);
      const velocityReady = Math.abs(velocity) >= .45
        && Math.sign(velocity) === Math.sign(rawDelta)
        && Math.abs(rawDelta) >= 18;
      const shouldCommit = Boolean(canMove && (distanceReady || projectedReady || velocityReady));
      const readyEntry = dragPreviewEntry?.index === targetIndex && dragPreviewEntry.status === "ready"
        ? dragPreviewEntry
        : null;
      if (shouldCommit && readyEntry) {
        const settleX = direction > 0 ? -width : width;
        const remainingRatio = Math.min(1, Math.abs(settleX - rawDelta) / width);
        const settleDuration = 220 + remainingRatio * 42 - Math.min(92, Math.abs(velocity) * 58);
        settleDrag(settleX, () => commitImage(readyEntry, direction, { animate: false }), settleDuration);
        return true;
      }
      const reboundDuration = 148 + Math.min(72, Math.abs(rawDelta) / width * 90) - Math.min(28, Math.abs(velocity) * 18);
      settleDrag(0, () => {
        clearDragPreview();
        dragDirection = 0;
        if (shouldCommit) show(targetIndex, direction);
        else scheduleAdvance(imageCache.get(currentIndex));
      }, reboundDuration);
      return true;
    };
    const cancelDrag = () => {
      if (!dragActive) return false;
      settleDrag(0, () => {
        clearDragPreview();
        dragDirection = 0;
        scheduleAdvance(imageCache.get(currentIndex));
      });
      return true;
    };
    const move = (delta) => {
      const direction = Math.sign(Number(delta) || 0);
      if (!direction) return false;
      const nextIndex = resolveGalleryIndex(requestedIndex + direction);
      return Boolean(show(nextIndex, direction));
    };
    wrap.shortVideoGalleryMove = move;
    wrap.shortVideoGalleryDragStart = startDrag;
    wrap.shortVideoGalleryDragMove = updateDrag;
    wrap.shortVideoGalleryDragEnd = endDrag;
    wrap.shortVideoGalleryDragCancel = cancelDrag;
    wrap.shortVideoGalleryPause = pauseAutoAdvance;
    wrap.shortVideoGalleryResume = resumeAutoAdvance;
    wrap.shortVideoGalleryTogglePlayback = toggleGalleryPlayback;
    wrap.shortVideoGalleryIsPaused = () => galleryUserPaused;
    wrap.shortVideoGalleryPlaySound = playGallerySound;
    progressButtons.forEach((button, index) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        show(index, Math.sign(index - requestedIndex));
      });
      button.addEventListener("pointerdown", (event) => event.stopPropagation());
    });
    const stopAndMove = (delta) => (event) => {
      event.preventDefault();
      event.stopPropagation();
      move(delta);
    };
    previous.addEventListener("click", stopAndMove(-1));
    next.addEventListener("click", stopAndMove(1));
    edgePrevious.addEventListener("click", stopAndMove(-1));
    edgeNext.addEventListener("click", stopAndMove(1));
    previous.addEventListener("pointerdown", (event) => event.stopPropagation());
    next.addEventListener("pointerdown", (event) => event.stopPropagation());
    edgePrevious.addEventListener("pointerdown", (event) => event.stopPropagation());
    edgeNext.addEventListener("pointerdown", (event) => event.stopPropagation());
    if (!ghost) {
      wrap.addEventListener("pointerdown", dismissGalleryGestureHint, { passive: true });
      window.requestAnimationFrame(() => {
        persistShortVideoWatch(video, null, { force: true, completed: true });
      });
      stage?.addEventListener("dblclick", (event) => {
        window.clearTimeout(galleryClickTimer);
        galleryClickTimer = 0;
        if (wasClearScreenJustRevealed(stage) || isShortVideoGestureClickBlocked(stage)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        toggleShortVideoAction(state.shortVideo?.current, "like", options.railGetter?.(), { forceActive: true, silent: true });
        showHeartBurst(stage, event);
      });
      wrap.addEventListener("click", (event) => {
        if (isShortVideoKeyboardControl(event.target)) return;
        if (revealShortVideoClearScreen(wrap) || wasClearScreenJustRevealed(wrap)) return;
        if (isShortVideoGestureClickBlocked(wrap)) return;
        if (stage?.classList.contains("is-sound-blocked") && backgroundAudio) {
          window.clearTimeout(galleryClickTimer);
          galleryClickTimer = 0;
          restoreGallerySound().then((result) => {
            if (result === "playing") showBrowserToast("图集音乐已开启");
            else if (result === "paused") showBrowserToast("图集音乐已开启，继续播放图集后生效");
            else showBrowserToast("浏览器仍在阻止音乐播放，请再次点击声音按钮");
          });
          return;
        }
        const browser = wrap.closest(".short-video-browser");
        if (browser?.dataset?.shortVideoTapReveal === "1") {
          delete browser.dataset.shortVideoTapReveal;
          return;
        }
        window.clearTimeout(galleryClickTimer);
        galleryClickTimer = window.setTimeout(() => {
          galleryClickTimer = 0;
          toggleGalleryPlayback();
        }, SHORT_VIDEO_DOUBLE_TAP_WINDOW_MS);
      });
    }
    const initialEntry = loadImage(0);
    image = initialEntry.image;
    track.append(image);
    if (images.length > 1) pager.append(previous, counter, next);
    else pager.append(counter);
    wrap.append(track, progress, pager);
    if (images.length > 1) wrap.append(edgePrevious, edgeNext);
    wrap.append(centerPlay, loadStatus, gestureHint);
    const attachLocalBackgroundSound = (sound = video.sound) => {
      const localSoundUrl = !ghost && sound?.localAvailable ? String(sound.previewUrl || "").trim() : "";
      if (!localSoundUrl || backgroundAudio) return false;
      const audio = document.createElement("audio");
      audio.className = "short-video-player short-video-gallery-audio";
      audio.src = localSoundUrl;
      audio.dataset.streamUrl = localSoundUrl;
      audio.loop = true;
      audio.autoplay = true;
      audio.preload = "auto";
      audio.muted = Boolean(state.shortVideo.muted);
      audio.volume = currentShortVideoVolume();
      backgroundAudio = audio;
      video.sound = sound;
      if (state.shortVideo?.current?.id === video.id) state.shortVideo.current.sound = sound;
      wrap.append(audio);
      syncGallerySoundState = () => {
        const playing = !audio.paused && !audio.ended;
        const muted = Boolean(audio.muted || audio.volume <= 0);
        const blocked = Boolean(stage?.classList.contains("is-sound-blocked"));
        const soundState = blocked ? "blocked" : (playing ? "playing" : "paused");
        const audible = Boolean(playing && !muted && !blocked);
        wrap.dataset.gallerySoundState = soundState;
        wrap.dataset.gallerySoundMuted = muted ? "1" : "0";
        const railSound = options.railGetter?.()?.querySelector?.(".short-video-rail-button.is-listen");
        railSound?.classList.toggle("is-playing", audible);
        railSound?.classList.toggle("is-muted", muted);
        railSound?.classList.toggle("is-blocked", blocked);
        const captionSound = stage?.closest?.(".short-video-reel-panel")?.querySelector?.(".short-video-caption-sound-cover");
        captionSound?.classList.toggle("is-playing", audible);
        captionSound?.classList.toggle("is-muted", muted);
        captionSound?.classList.toggle("is-blocked", blocked);
        els.workGrid?.querySelector?.(".short-video-control-bar.is-gallery")?.shortVideoSync?.();
      };
      audio.addEventListener("play", syncGallerySoundState);
      audio.addEventListener("pause", syncGallerySoundState);
      audio.addEventListener("ended", syncGallerySoundState);
      audio.addEventListener("volumechange", syncGallerySoundState);
      audio.addEventListener("error", syncGallerySoundState);
      els.workGrid?.querySelector?.(".short-video-control-bar.is-gallery")?.shortVideoEnableGallerySound?.(sound);
      window.requestAnimationFrame(() => {
        if (galleryUserPaused) {
          syncGallerySoundState();
          return;
        }
        playGallerySound();
        syncGallerySoundState();
      });
      return true;
    };
    const scheduleLocalSoundPoll = () => {
      window.clearTimeout(localSoundPollTimer);
      if (ghost || backgroundAudio || !video.sound?.previewUrl || localSoundPollAttempts >= 48) return;
      localSoundPollTimer = window.setTimeout(async () => {
        localSoundPollTimer = 0;
        if (!wrap.isConnected || backgroundAudio) return;
        localSoundPollAttempts += 1;
        try {
          const params = new URLSearchParams({
            source: "all",
            neighbors: "1",
            metadata: "0",
            refresh: String(Date.now())
          });
          const data = await api(`/api/short-videos/${encodeURIComponent(video.id)}?${params}`);
          const sound = data?.video?.sound;
          if (sound?.localAvailable && sound.previewUrl && attachLocalBackgroundSound(sound)) return;
        } catch {
          // The downloader or local sync may still be replacing its database row.
        }
        scheduleLocalSoundPoll();
      }, 15000);
    };
    if (!attachLocalBackgroundSound(video.sound)) scheduleLocalSoundPoll();
    syncCommittedUi();
    syncRequestedUi();
    show(0);
    window.requestAnimationFrame(() => syncGalleryCaptionState(0));
    return wrap;
  }

  function applyVideoOrientation(panel, stage, width, height) {
    const w = Number(width || 0);
    const h = Number(height || 0);
    if (!panel || !stage || !w || !h) return;
    const landscape = w / h >= 1.08;
    panel.classList.toggle("is-landscape-video", landscape);
    panel.classList.toggle("is-portrait-video", !landscape);
    stage.classList.toggle("is-landscape-video", landscape);
    stage.classList.toggle("is-portrait-video", !landscape);
  }

  function renderBrowserNav() {
    const nav = document.createElement("div");
    nav.className = "short-video-nav-pair";
    const prev = railNav("↑", () => openAdjacent(-1), !state.shortVideo.prevId);
    const next = railNav("↓", () => openAdjacent(1), !state.shortVideo.nextId);
    nav.append(prev, next);
    return nav;
  }

  function bindShortVideoPlaybackStatus(stage, player, video, syncPlayToggle = () => {}) {
    if (!stage || !player || player.dataset.playbackStatusBound === "1") return;
    player.dataset.playbackStatusBound = "1";

    const status = document.createElement("div");
    status.className = "short-video-playback-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-hidden", "true");
    const statusIcon = createIcon("repeat");
    statusIcon.classList.add("short-video-playback-status-icon");
    const copy = document.createElement("span");
    copy.className = "short-video-playback-status-copy";
    const title = document.createElement("strong");
    const detail = document.createElement("small");
    copy.append(title, detail);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "short-video-playback-retry";
    retry.append(createIcon("repeat"), document.createTextNode("重新加载"));
    status.append(statusIcon, copy, retry);
    stage.append(status);

    let feedbackTimer = 0;
    let stuckTimer = 0;
    let retrying = false;
    let wantsToPlay = Boolean(player.autoplay);
    let lastGoodTime = Math.max(0, Number(player.currentTime || 0));

    const clearTimers = () => {
      window.clearTimeout(feedbackTimer);
      window.clearTimeout(stuckTimer);
      feedbackTimer = 0;
      stuckTimer = 0;
    };
    const syncStageState = (kind) => {
      stage.classList.toggle("is-video-loading", kind === "loading" || kind === "retrying");
      stage.classList.toggle("is-video-buffering", kind === "buffering");
      stage.classList.toggle("is-video-error", kind === "error");
      if (kind === "loading" || kind === "retrying") stage.classList.remove("is-video-ready");
      stage.setAttribute("aria-busy", String(kind === "loading" || kind === "buffering" || kind === "retrying"));
      syncPlayToggle();
    };
    const showStatus = (kind, heading, message) => {
      clearTimers();
      status.dataset.state = kind;
      title.textContent = heading;
      detail.textContent = message;
      status.classList.add("is-visible");
      status.setAttribute("aria-hidden", "false");
      syncStageState(kind);
      if (kind === "loading" || kind === "buffering" || kind === "retrying") {
        stuckTimer = window.setTimeout(() => {
          if (player.readyState >= 2 && !stage.classList.contains("is-video-buffering")) return;
          retrying = false;
          showStatus("error", "视频加载失败", "保留当前进度后重试");
        }, 8000);
      }
    };
    const hideStatus = () => {
      clearTimers();
      retrying = false;
      status.classList.remove("is-visible");
      status.removeAttribute("data-state");
      status.setAttribute("aria-hidden", "true");
      stage.classList.remove("is-video-buffering", "is-video-error");
      if (player.readyState >= 2 && player.dataset.shortVideoFrameReady === "1") {
        stage.classList.remove("is-video-loading");
        stage.classList.add("is-video-ready");
        stage.setAttribute("aria-busy", "false");
      }
      syncPlayToggle();
    };
    const showDelayed = (kind) => {
      window.clearTimeout(feedbackTimer);
      feedbackTimer = window.setTimeout(() => {
        if (kind === "loading" && player.readyState >= 2) return;
        if (kind === "buffering" && (!wantsToPlay || player.readyState >= 3)) return;
        if (kind === "loading") showStatus("loading", "正在加载视频", "即将开始播放");
        else showStatus("buffering", "正在缓冲", "网络恢复后会自动继续");
      }, 420);
    };
    const handleLoadStart = () => {
      stage.classList.add("is-video-loading");
      stage.classList.remove("is-video-ready", "is-video-error");
      showDelayed("loading");
      syncPlayToggle();
    };
    const handleWaiting = () => {
      if (!wantsToPlay && player.currentTime > 0) return;
      showDelayed(player.readyState >= 2 ? "buffering" : "loading");
    };
    const handleReady = () => {
      if (player.readyState < 2) return;
      const recoveredFromRetry = retrying;
      hideStatus();
      if (recoveredFromRetry) warmVisibleAdjacentVideoPlayers();
    };
    const handleError = () => {
      retrying = false;
      showStatus("error", "视频加载失败", "保留当前进度后重试");
    };
    const rememberProgress = () => {
      // A failed source reset emits timeupdate with currentTime = 0 and
      // readyState = HAVE_NOTHING. Do not let that erase the last playable
      // position that the retry flow promises to restore.
      if (player.error || player.readyState < 2) return;
      const current = Math.max(0, Number(player.currentTime || 0));
      if (!Number.isFinite(current)) return;
      const madeForwardProgress = current > lastGoodTime + 0.04;
      lastGoodTime = current;
      // Some media stacks resume advancing without another canplay/playing
      // event. Progress itself is the strongest recovery signal.
      if (madeForwardProgress && wantsToPlay && status.dataset.state === "buffering") hideStatus();
    };

    player.addEventListener("loadstart", handleLoadStart);
    player.addEventListener("waiting", handleWaiting);
    player.addEventListener("stalled", handleWaiting);
    player.addEventListener("error", handleError);
    player.addEventListener("loadeddata", handleReady);
    player.addEventListener("canplay", handleReady);
    player.addEventListener("playing", () => {
      wantsToPlay = true;
      handleReady();
    });
    player.addEventListener("play", () => {
      wantsToPlay = true;
    });
    player.addEventListener("pause", () => {
      if (!retrying && !player.error && !stage.classList.contains("is-video-error")) wantsToPlay = false;
    });
    player.addEventListener("timeupdate", rememberProgress);
    player.addEventListener("seeked", rememberProgress);

    retry.addEventListener("pointerdown", (event) => event.stopPropagation());
    retry.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const source = String(video?.streamUrl || player.currentSrc || player.src || "").trim();
      if (!source) {
        showStatus("error", "视频加载失败", "暂时找不到可播放的视频地址");
        return;
      }
      const preservedTime = Math.max(lastGoodTime, Math.max(0, Number(player.currentTime || 0)));
      const preservedMuted = Boolean(player.muted);
      const preservedVolume = Math.max(0, Math.min(1, Number(player.volume || 0)));
      const preservedRate = normalizePlaybackRate(player.playbackRate);
      const shouldPlay = wantsToPlay || (!player.paused && !player.ended);
      retrying = true;
      wantsToPlay = shouldPlay;
      showStatus("retrying", "正在重新加载", "恢复播放状态中");

      const restorePlaybackState = () => {
        player.muted = preservedMuted;
        player.volume = preservedVolume;
        player.playbackRate = preservedRate;
        const duration = Math.max(0, Number(player.duration || 0));
        if (duration > 0 && preservedTime > 0) {
          try {
            player.currentTime = Math.min(preservedTime, Math.max(0, duration - 0.2));
          } catch {}
        }
        if (!shouldPlay) return;
        const resume = () => {
          player.play().catch(() => {
            if (!player.error) {
              wantsToPlay = false;
              handleReady();
            }
          });
        };
        if (player.readyState >= 2) resume();
        else player.addEventListener("canplay", resume, { once: true });
      };
      player.addEventListener("loadedmetadata", restorePlaybackState, { once: true });
      delete player.dataset.shortVideoFrameReady;
      delete player.dataset.shortVideoFrameReadyAt;
      player.src = source;
      player.load();
    });

    if (player.error) handleError();
    else if (player.readyState >= 2) hideStatus();
    else showDelayed("loading");
  }

  function attachPrimaryPlayerControls(stage, player, railGetter, video = state.shortVideo?.current, options = {}) {
    const centerPlay = document.createElement("button");
    centerPlay.type = "button";
    centerPlay.className = "short-video-center-play";
    centerPlay.tabIndex = -1;
    centerPlay.setAttribute("aria-hidden", "true");
    setIconButton(centerPlay, "play", "继续播放当前视频");
    const syncPlayToggle = () => {
      const paused = Boolean(player.paused);
      const centerVisible = paused
        && player.readyState >= 2
        && !stage.classList.contains("is-video-loading")
        && !stage.classList.contains("is-video-buffering")
        && !stage.classList.contains("is-video-error");
      stage.classList.toggle("is-paused", paused);
      centerPlay.classList.toggle("is-visible", centerVisible);
      centerPlay.tabIndex = centerVisible ? 0 : -1;
      centerPlay.setAttribute("aria-hidden", String(!centerVisible));
    };
    centerPlay.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!player.paused) return;
      player.play().then(() => {
        syncPlayToggle();
        stage.focus({ preventScroll: true });
      }).catch(syncPlayToggle);
    });
    centerPlay.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearPendingPlayerClick();
      toggleShortVideoAction(state.shortVideo?.current, "like", railGetter?.(), { forceActive: true, silent: true });
      showHeartBurst(stage, event);
    });
    if (player.dataset.primaryControlsBound !== "1") {
      const togglePlay = () => {
        if (player.paused) {
          player.play().then(syncPlayToggle).catch(syncPlayToggle);
        } else {
          player.pause();
          syncPlayToggle();
        }
      };
      player.dataset.primaryControlsBound = "1";
      const syncGlobalControlBar = () => {
        if (player === activePlayer()) syncActiveControlBar();
      };
      player.addEventListener("play", syncPlayToggle);
      player.addEventListener("play", syncGlobalControlBar);
      player.addEventListener("play", () => {
        if (!player.muted) clearPlayerSoundBlocked(stage);
      });
      player.addEventListener("pause", syncPlayToggle);
      player.addEventListener("pause", syncGlobalControlBar);
      player.addEventListener("loadedmetadata", syncPlayToggle);
      player.addEventListener("loadedmetadata", syncGlobalControlBar);
      player.addEventListener("ratechange", syncGlobalControlBar);
      player.addEventListener("volumechange", syncGlobalControlBar);
      player.addEventListener("ended", () => handleAutoNextEnded(player));
      bindHoldToSpeed(stage, player);
      player.addEventListener("click", (event) => {
        if (suppressNextPlayerClick) {
          clearPendingPlayerClick();
          suppressNextPlayerClick = false;
          return;
        }
        if (revealShortVideoClearScreen(stage) || wasClearScreenJustRevealed(stage)) {
          clearPendingPlayerClick();
          return;
        }
        if (isShortVideoGestureClickBlocked(stage)) {
          clearPendingPlayerClick();
          return;
        }
        if (stage.classList.contains("is-sound-blocked")) {
          event.preventDefault();
          clearPendingPlayerClick();
          restorePlayerSound(player, stage);
          return;
        }
        if (pendingPlayerTap?.player === player) {
          window.clearTimeout(playerClickTimer);
          playerClickTimer = 0;
          return;
        }
        clearPendingPlayerClick();
        const tapToken = String(Date.now());
        pendingPlayerTap = {
          player,
          wasPlaying: Boolean(!player.paused && !player.ended),
          token: tapToken
        };
        player.dataset.shortVideoTapToken = tapToken;
        player.dataset.shortVideoTapWasPlaying = pendingPlayerTap.wasPlaying ? "1" : "0";
        togglePlay();
        playerClickTimer = window.setTimeout(() => {
          if (pendingPlayerTap?.player === player && pendingPlayerTap.token === tapToken) {
            clearPendingPlayerClick();
          }
        }, SHORT_VIDEO_DOUBLE_TAP_WINDOW_MS);
      });
      stage.addEventListener("dblclick", (event) => {
        if (wasClearScreenJustRevealed(stage) || isShortVideoGestureClickBlocked(stage)) {
          clearPendingPlayerClick();
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const tapWasPlaying = player.dataset.shortVideoTapWasPlaying;
        clearPendingPlayerClick();
        if (tapWasPlaying === "1" && player.paused) {
          player.play().then(syncPlayToggle).catch(syncPlayToggle);
        } else if (tapWasPlaying === "0") {
          const pauseGuard = String(Date.now());
          player.dataset.shortVideoTapPauseGuard = pauseGuard;
          const enforcePausedTapState = () => {
            if (player.dataset.shortVideoTapPauseGuard !== pauseGuard) return;
            player.pause();
            syncPlayToggle();
          };
          player.addEventListener("play", enforcePausedTapState);
          enforcePausedTapState();
          window.setTimeout(() => {
            player.removeEventListener("play", enforcePausedTapState);
            if (player.dataset.shortVideoTapPauseGuard === pauseGuard) {
              delete player.dataset.shortVideoTapPauseGuard;
            }
          }, 240);
        }
        toggleShortVideoAction(state.shortVideo?.current, "like", railGetter?.(), { forceActive: true, silent: true });
        showHeartBurst(stage, event);
      });
    }
    bindShortVideoWatchTracking(stage, player, video, { resume: options.resume !== false });
    stage.append(player, centerPlay);
    bindShortVideoPlaybackStatus(stage, player, video, syncPlayToggle);
    syncActivePlaybackMode(player);
    syncPlayToggle();
    return syncPlayToggle;
  }

  function clearPendingPlayerClick() {
    const tap = pendingPlayerTap;
    window.clearTimeout(playerClickTimer);
    playerClickTimer = 0;
    pendingPlayerTap = null;
    if (tap && tap.player?.dataset?.shortVideoTapToken === tap.token) {
      delete tap.player.dataset.shortVideoTapToken;
      delete tap.player.dataset.shortVideoTapWasPlaying;
    }
  }

  function bindShortVideoWatchTracking(stage, player, video, options = {}) {
    const videoId = String(video?.id || "").trim();
    if (!videoId || player.dataset.watchTrackingVideoId === videoId) return;
    player.dataset.watchTrackingVideoId = videoId;
    const resumeProgressMs = Math.max(0, Number(video?.watch?.progressMs || 0));
    const resumeCompleted = Boolean(video?.watch?.completed);
    const restore = () => {
      if (player.dataset.watchRestored === "1") return;
      player.dataset.watchRestored = "1";
      player.dataset.watchRestoredAt = String(Date.now());
      const durationMs = Math.max(0, Number(player.duration || 0) * 1000);
      const canResume = options.resume !== false
        && !resumeCompleted
        && resumeProgressMs >= 1500
        && durationMs > 0
        && durationMs - resumeProgressMs >= 1500;
      if (canResume) {
        try {
          player.currentTime = resumeProgressMs / 1000;
          window.requestAnimationFrame(() => {
            if (stage.isConnected && player === activePlayer()) {
              showBrowserToast(`已续播至 ${formatSeconds(resumeProgressMs / 1000)}`);
            }
          });
        } catch {}
      }
      persistShortVideoWatch(video, player, { force: true });
    };
    const scheduleRestore = () => {
      if (player.dataset.watchRestored === "1" || player.dataset.watchRestoreScheduled === "1") return;
      const durationMs = Math.max(0, Number(player.duration || 0) * 1000);
      const canResume = options.resume !== false
        && !resumeCompleted
        && resumeProgressMs >= 1500
        && durationMs > 0
        && durationMs - resumeProgressMs >= 1500;
      if (!canResume) {
        restore();
        return;
      }
      player.dataset.watchRestoreScheduled = "1";
      waitForVideoFirstFrame(player, 1800).finally(() => {
        window.requestAnimationFrame(() => {
          if (player.isConnected) restore();
        });
      });
    };
    player.addEventListener("loadedmetadata", scheduleRestore, { once: true });
    player.addEventListener("playing", () => {
      if (player.dataset.watchRestored === "1") persistShortVideoWatch(video, player);
    });
    player.addEventListener("pause", () => {
      if (player.dataset.watchRestored === "1") persistShortVideoWatch(video, player, { force: true });
    });
    player.addEventListener("timeupdate", () => {
      if (player.dataset.watchRestored !== "1") return;
      const duration = Math.max(0, Number(player.duration || 0));
      const current = Math.max(0, Number(player.currentTime || 0));
      if (duration > 0 && duration - current <= 0.8) {
        if (player.dataset.watchCompleted !== "1") {
          player.dataset.watchCompleted = "1";
          persistShortVideoWatch(video, player, { force: true, completed: true });
        }
        return;
      }
      if (duration > 0 && current < duration * 0.5) player.dataset.watchCompleted = "";
      persistShortVideoWatch(video, player);
    });
    player.addEventListener("ended", () => persistShortVideoWatch(video, player, { force: true, completed: true }));
    if (player.readyState >= 1) window.requestAnimationFrame(scheduleRestore);
  }

  function persistShortVideoWatch(video, player, options = {}) {
    const videoId = String(video?.id || "").trim();
    if (!videoId) return;
    const now = Date.now();
    let write = shortVideoWatchWrites.get(videoId);
    if (!write) {
      write = { inFlight: false, lastSavedAt: 0, lastPayload: null, pending: null };
      shortVideoWatchWrites.set(videoId, write);
    }
    if (!options.force && now - write.lastSavedAt < SHORT_VIDEO_WATCH_SAVE_INTERVAL) return;
    const progressMs = Math.max(0, Math.round(Number(player?.currentTime || 0) * 1000));
    const payload = { progressMs, completed: Boolean(options.completed) };
    if (
      options.force
      && now - write.lastSavedAt < 600
      && write.lastPayload?.completed === payload.completed
      && Math.abs(Number(write.lastPayload?.progressMs || 0) - progressMs) < 1000
    ) {
      return;
    }
    write.lastSavedAt = now;
    write.lastPayload = payload;
    if (write.inFlight) {
      write.pending = payload;
      return;
    }
    dispatchShortVideoWatchWrite(video, write, payload);
  }

  function dispatchShortVideoWatchWrite(video, write, payload) {
    const videoId = String(video?.id || "").trim();
    if (!videoId) return;
    write.inFlight = true;
    api(`/api/short-videos/${encodeURIComponent(videoId)}/watch`, {
      method: "PUT",
      keepalive: true,
      body: payload
    }).then((data) => {
      if (data?.video) syncShortVideoWatchVideo(data.video);
      else if (data?.videoId && data?.watch) {
        syncShortVideoWatchVideo({ id: data.videoId, watch: data.watch });
      }
    }).catch((error) => {
      console.warn("观看进度保存失败", error);
    }).finally(() => {
      write.inFlight = false;
      const pending = write.pending;
      write.pending = null;
      if (pending) dispatchShortVideoWatchWrite(video, write, pending);
    });
  }

  function bindBrowserControlVisibility(browser, player) {
    if (!browser || browser.dataset.controlsVisibilityBound === "1") return;
    browser.dataset.controlsVisibilityBound = "1";
    const finePointer = window.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches !== false;
    let idleTimer = 0;
    let readinessTimer = 0;
    let lastPointerX = -1;
    let lastPointerY = -1;

    const clearIdleTimer = () => {
      window.clearTimeout(idleTimer);
      idleTimer = 0;
    };
    const clearReadinessTimer = () => {
      window.clearTimeout(readinessTimer);
      readinessTimer = 0;
    };
    const controlsPinned = () => {
      const currentPanel = browser.querySelector(".short-video-reel-panel.is-current");
      const currentPlayer = currentPanel?.querySelector(".short-video-gallery-audio, .short-video-player:not(.is-ghost)");
      const gallery = currentPanel?.querySelector(".short-video-gallery-player");
      const mediaNotReady = currentPlayer
        ? currentPlayer.readyState < 2
        : !gallery || gallery.classList.contains("is-image-loading");
      const playbackPaused = currentPlayer
        ? currentPlayer.paused
        : gallery?.dataset?.galleryPlaybackPaused === "1";
      const focused = document.activeElement;
      const hasInteractiveFocus = focused && browser.contains(focused) && isShortVideoKeyboardControl(focused);
      return mediaNotReady
        || playbackPaused
        || hasInteractiveFocus
        || browser.classList.contains("is-author-panel-open")
        || Boolean(browser.querySelector(".short-video-more-overlay, .short-video-share-panel"));
    };
    const hideControls = () => {
      idleTimer = 0;
      if (controlsPinned() || !browser.isConnected) return;
      browser.classList.add("is-controls-idle");
    };
    const revealControls = (delay = 1500) => {
      clearIdleTimer();
      browser.classList.remove("is-controls-idle");
      if (controlsPinned()) return;
      idleTimer = window.setTimeout(hideControls, Math.max(300, Number(delay || 0)));
    };
    const pinControls = () => {
      clearIdleTimer();
      browser.classList.remove("is-controls-idle");
    };
    const handlePointerMove = (event) => {
      const x = Number(event.clientX || 0);
      const y = Number(event.clientY || 0);
      if (lastPointerX >= 0 && Math.hypot(x - lastPointerX, y - lastPointerY) < 3) return;
      lastPointerX = x;
      lastPointerY = y;
      const nearControls = y >= Math.max(0, window.innerHeight - 88);
      revealControls(nearControls ? 2400 : 1500);
    };
    const handlePointerLeave = () => {
      if (finePointer) revealControls(520);
    };
    const handlePointerDown = (event) => {
      if (!finePointer
        && browser.classList.contains("is-controls-idle")
        && !isShortVideoKeyboardControl(event.target)) {
        browser.dataset.shortVideoTapReveal = "1";
        suppressNextPlayerClick = true;
        window.setTimeout(() => {
          if (browser.dataset.shortVideoTapReveal === "1") delete browser.dataset.shortVideoTapReveal;
          suppressNextPlayerClick = false;
        }, 520);
      }
      revealControls(finePointer ? 1900 : 2400);
    };
    const handleFocusIn = () => pinControls();
    const handleFocusOut = () => window.setTimeout(() => revealControls(1500));
    const isActiveMediaEvent = (event) => event.target === browser.querySelector(
      ".short-video-reel-panel.is-current .short-video-gallery-audio, .short-video-reel-panel.is-current .short-video-player:not(.is-ghost)"
    );
    const handlePlay = (event) => {
      if (isActiveMediaEvent(event)) revealControls(1700);
    };
    const handlePause = (event) => {
      if (isActiveMediaEvent(event)) pinControls();
    };
    const handleWaiting = (event) => {
      if (isActiveMediaEvent(event)) pinControls();
    };
    const handlePlaying = (event) => {
      if (isActiveMediaEvent(event)) revealControls(1500);
    };
    const revealWhenReady = (attempt = 0) => {
      clearReadinessTimer();
      if (!browser.isConnected) return;
      if (controlsPinned()) {
        if (attempt < 28) readinessTimer = window.setTimeout(() => revealWhenReady(attempt + 1), 220);
        return;
      }
      revealControls(finePointer ? 1500 : 2400);
    };

    browser.addEventListener("pointermove", handlePointerMove, { passive: true });
    browser.addEventListener("pointerleave", handlePointerLeave, { passive: true });
    browser.addEventListener("pointerdown", handlePointerDown, { passive: true });
    browser.addEventListener("focusin", handleFocusIn);
    browser.addEventListener("focusout", handleFocusOut);
    browser.addEventListener("play", handlePlay, true);
    browser.addEventListener("pause", handlePause, true);
    browser.addEventListener("waiting", handleWaiting, true);
    browser.addEventListener("playing", handlePlaying, true);

    browser.shortVideoRevealControls = revealControls;
    browser.shortVideoControlsDispose = () => {
      clearIdleTimer();
      clearReadinessTimer();
      browser.removeEventListener("pointermove", handlePointerMove);
      browser.removeEventListener("pointerleave", handlePointerLeave);
      browser.removeEventListener("pointerdown", handlePointerDown);
      browser.removeEventListener("focusin", handleFocusIn);
      browser.removeEventListener("focusout", handleFocusOut);
      browser.removeEventListener("play", handlePlay, true);
      browser.removeEventListener("pause", handlePause, true);
      browser.removeEventListener("waiting", handleWaiting, true);
      browser.removeEventListener("playing", handlePlaying, true);
    };
    revealControls(finePointer ? 1800 : 2600);
    readinessTimer = window.setTimeout(() => revealWhenReady(0), 220);
  }

  function syncShortVideoWatchVideo(updated) {
    if (!updated?.id) return;
    const candidates = [
      state.shortVideo?.current,
      state.shortVideo?.prevVideo,
      state.shortVideo?.nextVideo,
      ...(state.shortVideo?.data?.videos || [])
    ];
    for (const item of candidates) {
      if (!item || !isCurrentShortVideo(updated, item)) continue;
      item.watch = { ...(item.watch || {}), ...(updated.watch || {}) };
    }
  }

  function flushActiveShortVideoWatch() {
    const video = state.shortVideo?.current;
    if (!video?.id) return;
    if (isGalleryPost(video)) {
      persistShortVideoWatch(video, null, { force: true, completed: true });
      return;
    }
    persistShortVideoWatch(video, activePlayer(), { force: true });
  }

  function handleAutoNextEnded(player) {
    if (!state.shortVideo?.autoNext) return;
    if (player !== activePlayer()) return;
    if (!state.shortVideo.nextId) {
      player.loop = true;
      player.currentTime = 0;
      player.play?.().catch(() => {});
      showBrowserToast("已经是最后一条");
      return;
    }
    openAdjacent(1).catch(showError);
  }

  function syncActivePlaybackMode(player = activePlayer()) {
    if (!player || player.classList.contains("is-ghost")) return;
    player.loop = !(state.shortVideo?.autoNext && state.shortVideo?.nextId);
    if (player.dataset.holdSpeedActive !== "1") {
      player.playbackRate = normalizePlaybackRate(state.shortVideo?.playbackRate);
    }
  }

  function bindHoldToSpeed(stage, player) {
    if (!stage || !player || player.dataset.holdSpeedBound === "1") return;
    player.dataset.holdSpeedBound = "1";
    let holdTimer = 0;
    let holdPointerId = null;
    let holdStartX = 0;
    let holdStartY = 0;
    let holdActive = false;
    let holdBaseRate = normalizePlaybackRate(state.shortVideo?.playbackRate);

    const clearHoldTimer = () => {
      window.clearTimeout(holdTimer);
      holdTimer = 0;
    };
    const setClickSuppression = () => {
      suppressNextPlayerClick = true;
      window.setTimeout(() => {
        suppressNextPlayerClick = false;
      }, 280);
    };
    const stopHold = (options = {}) => {
      clearHoldTimer();
      if (holdActive) {
        holdActive = false;
        delete player.dataset.holdSpeedActive;
        player.playbackRate = normalizePlaybackRate(state.shortVideo?.playbackRate);
        clearHoldSpeedFeedback(stage);
        if (options.suppressClick) setClickSuppression();
      }
      holdPointerId = null;
    };
    const startHold = () => {
      holdTimer = 0;
      if (holdPointerId == null || !player.isConnected || player.paused) return;
      holdActive = true;
      holdSpeedGestureConsumed = true;
      state.shortVideo.dragging = false;
      snapStackBack();
      holdBaseRate = normalizePlaybackRate(state.shortVideo?.playbackRate);
      player.dataset.holdSpeedActive = "1";
      player.playbackRate = 2;
      showHoldSpeedFeedback(stage, holdBaseRate);
    };
    const finishPointer = (event, options = {}) => {
      if (holdPointerId == null || (event?.pointerId != null && event.pointerId !== holdPointerId)) return;
      const wasActive = holdActive;
      stopHold({ suppressClick: wasActive && options.suppressClick !== false });
    };

    player.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.isPrimary === false || player.paused) return;
      if (pendingPlayerTap?.player !== player) clearPendingPlayerClick();
      stopHold();
      holdPointerId = event.pointerId;
      holdStartX = Number(event.clientX || 0);
      holdStartY = Number(event.clientY || 0);
      holdTimer = window.setTimeout(startHold, 360);
    });
    player.addEventListener("pointermove", (event) => {
      if (holdPointerId == null || event.pointerId !== holdPointerId) return;
      const deltaX = Number(event.clientX || 0) - holdStartX;
      const deltaY = Number(event.clientY || 0) - holdStartY;
      const moveTolerance = holdActive ? SHORT_VIDEO_HOLD_ACTIVE_MOVE_TOLERANCE : SHORT_VIDEO_HOLD_ARM_MOVE_TOLERANCE;
      if (Math.hypot(deltaX, deltaY) <= moveTolerance) return;
      finishPointer(event, { suppressClick: holdActive });
    });
    player.addEventListener("pointerup", (event) => finishPointer(event));
    player.addEventListener("pointercancel", (event) => finishPointer(event, { suppressClick: false }));
    player.addEventListener("pointerleave", (event) => finishPointer(event));
    player.addEventListener("pause", () => stopHold());
    player.addEventListener("emptied", () => stopHold());
    player.addEventListener("contextmenu", (event) => {
      if (!holdTimer && !holdActive) return;
      event.preventDefault();
    });
  }

  function showHoldSpeedFeedback(stage, baseRate) {
    if (!stage) return;
    clearHoldSpeedFeedback(stage);
    stage.classList.add("is-hold-speed");
    const feedback = document.createElement("div");
    feedback.className = "short-video-hold-speed-feedback";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    const badge = document.createElement("span");
    badge.textContent = "2×";
    badge.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = "倍速播放中";
    const hint = document.createElement("small");
    hint.textContent = `松开恢复 ${formatPlaybackRate(baseRate)}`;
    copy.append(label, hint);
    feedback.append(badge, copy);
    stage.append(feedback);
  }

  function clearHoldSpeedFeedback(stage) {
    stage?.classList?.remove("is-hold-speed");
    stage?.querySelector?.(".short-video-hold-speed-feedback")?.remove();
  }

  function markPlayerSoundBlocked(stage) {
    if (!stage) return;
    if (stage.shortVideoSoundHintTimer) window.clearTimeout(stage.shortVideoSoundHintTimer);
    stage.classList.add("is-sound-blocked", "is-sound-hint-visible");
    stage.shortVideoSoundHintTimer = window.setTimeout(() => {
      stage.shortVideoSoundHintTimer = 0;
      stage.classList.remove("is-sound-hint-visible");
    }, 2400);
  }

  function clearPlayerSoundBlocked(stage) {
    if (!stage) return;
    if (stage.shortVideoSoundHintTimer) window.clearTimeout(stage.shortVideoSoundHintTimer);
    stage.shortVideoSoundHintTimer = 0;
    stage.classList.remove("is-sound-blocked", "is-sound-hint-visible");
  }

  function restorePlayerSound(player, stage = player?.closest?.(".short-video-stage")) {
    if (!player) return;
    state.shortVideo.muted = false;
    writeMutedPreference(false);
    player.muted = false;
    player.volume = currentShortVideoVolume();
    clearPlayerSoundBlocked(stage);
    player.play?.().catch(() => {
      if (!player.paused) {
        clearPlayerSoundBlocked(stage);
        return;
      }
      markPlayerSoundBlocked(stage);
      player.muted = true;
      player.play?.().catch(() => {});
    });
  }

  function activeShortVideoStage() {
    return els.workGrid?.querySelector?.(".short-video-reel-panel.is-current .short-video-stage") || null;
  }

  function shortVideoFullscreenActive() {
    const fullscreenElement = document.fullscreenElement;
    return Boolean(fullscreenElement && fullscreenElement.classList?.contains?.("short-video-stage"));
  }

  function syncShortVideoFullscreenControl(control) {
    if (!control) return;
    const active = shortVideoFullscreenActive();
    control.classList.toggle("active", active);
    control.setAttribute("aria-pressed", String(active));
    if (control.dataset.shortVideoFullscreenControl === "settings") {
      const title = control.querySelector("b");
      const detail = control.querySelector("small");
      if (title) title.textContent = active ? "退出全屏" : "全屏播放";
      if (detail) detail.textContent = active ? "返回普通播放页面" : "沉浸观看当前作品";
      return;
    }
    setIconButton(control, "fullscreen", active ? "退出全屏" : (control.dataset.shortVideoFullscreenLabel || "全屏"));
  }

  function syncShortVideoFullscreenControls() {
    els.workGrid?.querySelectorAll?.("[data-short-video-fullscreen-control]")?.forEach(syncShortVideoFullscreenControl);
  }

  async function toggleShortVideoFullscreen() {
    const target = activeShortVideoStage();
    if (!target) return false;
    const exiting = Boolean(document.fullscreenElement);
    if (exiting && typeof document.exitFullscreen !== "function") {
      showBrowserToast("当前浏览器无法退出网页全屏");
      return false;
    }
    if (!exiting && typeof target.requestFullscreen !== "function") {
      showBrowserToast("当前浏览器不支持网页全屏");
      return false;
    }
    try {
      if (exiting) await document.exitFullscreen();
      else await target.requestFullscreen();
      syncShortVideoFullscreenControls();
      return true;
    } catch {
      showBrowserToast(exiting ? "退出全屏失败" : "全屏启动失败");
      return false;
    }
  }

  function renderGalleryControlBar(video) {
    const bar = document.createElement("div");
    bar.className = "short-video-control-bar is-gallery";
    const hasKnownSound = Boolean(video.sound?.previewUrl);
    bar.classList.toggle("has-sound-control", hasKnownSound);
    const play = document.createElement("button");
    play.type = "button";
    play.className = "short-video-control-icon short-video-gallery-play-toggle";
    const label = document.createElement("span");
    label.className = "short-video-gallery-control-label";
    label.append(createIcon("images"), document.createTextNode(`图集 · ${galleryLabel(video)}`));
    const spacer = document.createElement("span");
    spacer.className = "short-video-gallery-control-spacer";
    const original = document.createElement("button");
    original.type = "button";
    original.className = "short-video-control-original";
    original.textContent = "原作品";
    original.addEventListener("click", () => openDouyinLink(video));
    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "short-video-control-icon short-video-gallery-sound-toggle";
    const syncSound = () => {
      const gallery = activeGalleryPlayer();
      const paused = Boolean(gallery?.shortVideoGalleryIsPaused?.());
      setIconButton(play, paused ? "play" : "pause", paused ? "继续播放图集" : "暂停图集");
      const localReady = Boolean(video.sound?.localAvailable && video.sound?.previewUrl);
      mute.disabled = !localReady;
      if (!localReady) {
        setIconButton(mute, "volumeX", "背景音乐下载中");
        return;
      }
      const player = activePlayer();
      const muted = player ? player.muted : Boolean(state.shortVideo.muted);
      const blocked = Boolean(gallery?.closest?.(".short-video-stage")?.classList.contains("is-sound-blocked"));
      const soundState = String(gallery?.dataset?.gallerySoundState || "");
      const soundLabel = blocked
        ? "开启图集音乐（浏览器已阻止自动播放）"
        : (muted
          ? "开启图集音乐"
          : (paused ? "关闭图集音乐（图集已暂停）" : (soundState === "paused" ? "播放图集音乐" : "关闭图集音乐")));
      mute.classList.toggle("is-muted", muted);
      mute.classList.toggle("is-blocked", blocked);
      mute.setAttribute("aria-pressed", String(muted));
      setIconButton(mute, muted ? "volumeX" : "volume2", soundLabel);
    };
    mute.addEventListener("click", () => {
      const gallery = activeGalleryPlayer();
      const player = activePlayer();
      if (player && player.paused && !player.muted && !gallery?.shortVideoGalleryIsPaused?.()) {
        gallery?.shortVideoGalleryPlaySound?.();
        syncSound();
        return;
      }
      toggleActiveMute();
      const nextPlayer = activePlayer();
      if (nextPlayer && !nextPlayer.muted && !gallery?.shortVideoGalleryIsPaused?.()) {
        gallery?.shortVideoGalleryPlaySound?.();
      }
      syncSound();
    });
    play.addEventListener("click", () => {
      activeGalleryPlayer()?.shortVideoGalleryTogglePlayback?.();
      syncSound();
    });
    bar.shortVideoSync = syncSound;
    bar.shortVideoEnableGallerySound = (sound) => {
      video.sound = sound;
      mute.hidden = false;
      bar.classList.add("has-sound-control");
      syncSound();
    };
    mute.hidden = !hasKnownSound;
    syncSound();
    const full = document.createElement("button");
    full.type = "button";
    full.className = "short-video-control-icon";
    full.dataset.shortVideoFullscreenControl = "icon";
    full.dataset.shortVideoFullscreenLabel = "全屏查看图文";
    syncShortVideoFullscreenControl(full);
    full.addEventListener("click", () => toggleShortVideoFullscreen());
    bar.append(play, label, spacer);
    bar.append(mute);
    bar.append(original, full);
    return bar;
  }

  function renderControlBar() {
    const bar = document.createElement("div");
    bar.className = "short-video-control-bar";
    const play = document.createElement("button");
    play.type = "button";
    play.className = "short-video-control-play";
    setIconButton(play, "play", "播放");
    const time = document.createElement("span");
    time.className = "short-video-control-time";
    time.textContent = "0:00 / 0:00";
    const progress = document.createElement("input");
    progress.type = "range";
    progress.className = "short-video-control-progress";
    progress.min = "0";
    progress.max = "1000";
    progress.value = "0";
    progress.setAttribute("aria-label", "播放进度");
    const progressWrap = document.createElement("div");
    progressWrap.className = "short-video-control-progress-wrap";
    const controlSpacer = document.createElement("span");
    controlSpacer.className = "short-video-control-spacer";
    controlSpacer.setAttribute("aria-hidden", "true");
    const seekPreview = document.createElement("output");
    seekPreview.className = "short-video-seek-preview";
    seekPreview.textContent = "0:00";
    seekPreview.setAttribute("aria-hidden", "true");
    progressWrap.append(progress, seekPreview);
    const autoNext = document.createElement("button");
    autoNext.type = "button";
    autoNext.className = "short-video-control-auto";
    autoNext.textContent = "连播";
    autoNext.title = "自动播放下一条";
    const rate = document.createElement("button");
    rate.type = "button";
    rate.className = "short-video-control-rate";
    rate.textContent = formatPlaybackRate(state.shortVideo.playbackRate);
    rate.title = "播放速度";
    const original = document.createElement("button");
    original.type = "button";
    original.className = "short-video-control-original";
    original.textContent = "原视频";
    original.title = "打开抖音原视频";
    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "short-video-control-icon";
    setIconButton(mute, "volumeX", "取消静音");
    const volumeControl = document.createElement("div");
    volumeControl.className = "short-video-control-volume";
    const volumePopover = document.createElement("div");
    volumePopover.className = "short-video-volume-popover";
    volumePopover.id = "short-video-volume-popover";
    volumePopover.setAttribute("role", "group");
    volumePopover.setAttribute("aria-label", "音量调整");
    const volume = document.createElement("input");
    volume.type = "range";
    volume.className = "short-video-volume-range";
    volume.min = "0";
    volume.max = "100";
    volume.step = "1";
    volume.value = state.shortVideo.muted ? "0" : String(Math.round(currentShortVideoVolume() * 100));
    const volumeReadout = document.createElement("span");
    volumeReadout.className = "short-video-volume-readout";
    volumePopover.append(volume, volumeReadout);
    volumeControl.append(mute, volumePopover);
    mute.setAttribute("aria-controls", volumePopover.id);
    mute.setAttribute("aria-expanded", "false");
    const full = document.createElement("button");
    full.type = "button";
    full.className = "short-video-control-icon";
    full.dataset.shortVideoFullscreenControl = "icon";
    full.dataset.shortVideoFullscreenLabel = "全屏";
    syncShortVideoFullscreenControl(full);
    let scrubbing = false;
    let progressFrameHandle = 0;
    let progressRaf = 0;
    let progressPlayer = null;
    let lastProgressFrameAt = 0;
    let volumeScrubbing = false;
    let scrubPlayer = null;
    let scrubWasPlaying = false;
    let scrubTargetTime = 0;
    let scrubSeekRaf = 0;

    const setVolumePopoverOpen = (open) => {
      const expanded = Boolean(open);
      volumeControl.classList.toggle("is-open", expanded);
      mute.setAttribute("aria-expanded", String(expanded));
      volumePopover.setAttribute("aria-hidden", String(!expanded));
      volumePopover.inert = !expanded;
      bar.closest(".short-video-browser")?.classList.toggle("is-volume-open", expanded);
    };
    volumeControl.shortVideoSetOpen = setVolumePopoverOpen;
    setVolumePopoverOpen(false);

    const updateSeekPreview = (ratio, duration) => {
      const safeRatio = Math.max(0, Math.min(1, Number(ratio || 0)));
      const width = Math.max(0, progress.getBoundingClientRect().width || progressWrap.clientWidth || 0);
      const bubbleHalfWidth = 30;
      const left = width
        ? Math.max(bubbleHalfWidth, Math.min(width - bubbleHalfWidth, safeRatio * width))
        : 0;
      seekPreview.textContent = formatSeconds(Math.max(0, duration) * safeRatio);
      seekPreview.style.left = width ? `${left}px` : `${safeRatio * 100}%`;
    };

    const updateSeekPreviewFromPointer = (event) => {
      const player = activePlayer();
      if (!player) return;
      const duration = Number(player.duration || 0);
      const rect = progress.getBoundingClientRect();
      if (!duration || !rect.width) return;
      const ratio = (Number(event.clientX || rect.left) - rect.left) / rect.width;
      updateSeekPreview(ratio, duration);
    };

    const applyScrubTarget = (exact = false) => {
      if (scrubSeekRaf) {
        window.cancelAnimationFrame(scrubSeekRaf);
        scrubSeekRaf = 0;
      }
      const player = scrubPlayer;
      if (!player || player !== activePlayer() || !Number.isFinite(scrubTargetTime)) return;
      try {
        if (!exact && typeof player.fastSeek === "function") player.fastSeek(scrubTargetTime);
        else player.currentTime = scrubTargetTime;
      } catch {
        try {
          player.currentTime = scrubTargetTime;
        } catch {}
      }
    };

    const scheduleScrubTarget = (player, target, duration) => {
      scrubPlayer = player;
      scrubTargetTime = Math.max(0, Math.min(duration, Number(target || 0)));
      const ratio = duration ? scrubTargetTime / duration : 0;
      const timeText = `${formatSeconds(scrubTargetTime)} / ${formatSeconds(duration)}`;
      progress.value = String(Math.round(ratio * 1000));
      progress.style.setProperty("--short-video-progress", `${ratio * 100}%`);
      time.textContent = timeText;
      progress.setAttribute("aria-valuetext", timeText);
      updateSeekPreview(ratio, duration);
      if (scrubSeekRaf) return;
      scrubSeekRaf = window.requestAnimationFrame(() => {
        scrubSeekRaf = 0;
        applyScrubTarget(false);
      });
    };

    const seekFromProgressPointer = (event) => {
      const player = activePlayer();
      if (!player) return;
      const duration = Number(player.duration || 0);
      const rect = progress.getBoundingClientRect();
      if (!duration || !rect.width) return;
      const ratio = Math.max(0, Math.min(1, (Number(event.clientX || rect.left) - rect.left) / rect.width));
      scheduleScrubTarget(player, ratio * duration, duration);
    };

    const finishProgressScrub = (event, usePointer = false) => {
      if (!scrubbing) return;
      if (usePointer) seekFromProgressPointer(event);
      const player = scrubPlayer;
      const shouldResume = scrubWasPlaying && player === activePlayer();
      applyScrubTarget(true);
      scrubbing = false;
      progressWrap.classList.remove("is-scrubbing");
      if (progress.hasPointerCapture?.(event?.pointerId)) progress.releasePointerCapture?.(event.pointerId);
      scrubPlayer = null;
      scrubWasPlaying = false;
      if (shouldResume) player.play?.().catch(() => {});
      sync(true);
      scheduleProgressLoop();
    };

    const syncProgress = (player = activePlayer()) => {
      if (!player) return;
      const duration = Number(player.duration || 0);
      const current = Number(player.currentTime || 0);
      const timeText = `${formatSeconds(current)} / ${formatSeconds(duration)}`;
      if (time.textContent !== timeText) time.textContent = timeText;
      const progressValue = duration ? Math.round((current / duration) * 1000) : 0;
      const progressText = String(progressValue);
      if (!scrubbing && progress.value !== progressText) progress.value = progressText;
      progress.style.setProperty("--short-video-progress", `${Math.max(0, Math.min(100, progressValue / 10))}%`);
      if (progress.getAttribute("aria-valuetext") !== timeText) progress.setAttribute("aria-valuetext", timeText);
    };

    const sync = (force = false) => {
      const player = activePlayer();
      if (!player) return;
      setIconButton(play, player.paused ? "play" : "pause", player.paused ? "播放" : "暂停");
      const volumePercent = player.muted ? 0 : Math.round(currentShortVideoVolume() * 100);
      setIconButton(mute, player.muted ? "volumeX" : "volume2", player.muted ? "取消静音" : "静音");
      volume.value = String(volumePercent);
      volume.style.setProperty("--short-video-volume", `${volumePercent}%`);
      volume.setAttribute("aria-label", `音量 ${volumePercent}%`);
      volumeReadout.textContent = `${volumePercent}%`;
      autoNext.classList.toggle("active", Boolean(state.shortVideo?.autoNext));
      autoNext.setAttribute("aria-pressed", String(Boolean(state.shortVideo?.autoNext)));
      autoNext.setAttribute("aria-label", state.shortVideo?.autoNext ? "关闭连播" : "开启连播");
      rate.textContent = formatPlaybackRate(state.shortVideo?.playbackRate);
      rate.setAttribute("aria-label", `播放速度 ${formatPlaybackRate(state.shortVideo?.playbackRate)}`);
      const originalUrl = originalDouyinUrl(state.shortVideo?.current);
      original.disabled = !originalUrl;
      original.classList.toggle("is-unavailable", !originalUrl);
      original.setAttribute("aria-label", originalUrl ? "打开抖音原视频" : "当前视频没有原始链接");
      syncProgress(player);
      player.closest(".short-video-stage")?.classList.toggle("is-paused", player.paused);
      syncActivePlaybackMode(player);
    };

    const stopProgressLoop = () => {
      if (progressFrameHandle && progressPlayer?.cancelVideoFrameCallback) {
        progressPlayer.cancelVideoFrameCallback(progressFrameHandle);
      }
      if (progressRaf) window.cancelAnimationFrame(progressRaf);
      progressFrameHandle = 0;
      progressRaf = 0;
      progressPlayer = null;
      lastProgressFrameAt = 0;
    };

    const scheduleProgressLoop = () => {
      if (!bar.isConnected) {
        stopProgressLoop();
        return;
      }
      const player = activePlayer();
      if (!player) {
        stopProgressLoop();
        return;
      }
      if (progressPlayer !== player) {
        stopProgressLoop();
        progressPlayer = player;
      }
      if (player.paused || player.ended) {
        stopProgressLoop();
        syncProgress(player);
        return;
      }
      if (progressFrameHandle || progressRaf) return;
      const paintProgress = (now) => {
        progressFrameHandle = 0;
        progressRaf = 0;
        if (!bar.isConnected || player !== activePlayer()) {
          scheduleProgressLoop();
          return;
        }
        if (!lastProgressFrameAt || now - lastProgressFrameAt >= 30) {
          lastProgressFrameAt = now;
          syncProgress(player);
        }
        scheduleProgressLoop();
      };
      if (player.requestVideoFrameCallback) {
        progressFrameHandle = player.requestVideoFrameCallback(paintProgress);
      } else {
        progressRaf = window.requestAnimationFrame(paintProgress);
      }
    };
    play.addEventListener("click", () => {
      toggleActivePlayer();
      window.requestAnimationFrame(() => sync(true));
    });
    mute.addEventListener("click", () => {
      toggleActiveMute();
      setVolumePopoverOpen(true);
      sync(true);
    });
    volume.addEventListener("input", () => {
      setActiveShortVideoVolume(Number(volume.value || 0));
      sync(true);
    });
    volume.addEventListener("keydown", (event) => {
      const current = Math.max(0, Math.min(100, Number(volume.value || 0)));
      const next = {
        ArrowUp: current + 1,
        ArrowRight: current + 1,
        ArrowDown: current - 1,
        ArrowLeft: current - 1,
        PageUp: current + 10,
        PageDown: current - 10,
        Home: 0,
        End: 100
      }[event.key];
      if (!Number.isFinite(next)) return;
      event.preventDefault();
      volume.value = String(Math.max(0, Math.min(100, next)));
      setActiveShortVideoVolume(Number(volume.value));
      sync(true);
    });
    const setVolumeFromPointer = (event) => {
      const rect = volume.getBoundingClientRect();
      if (!rect.height) return;
      const clientY = Number(event.clientY);
      const ratio = Math.max(0, Math.min(1, (rect.bottom - (Number.isFinite(clientY) ? clientY : rect.bottom)) / rect.height));
      volume.value = String(Math.round(ratio * 100));
      setActiveShortVideoVolume(Number(volume.value || 0));
      sync(true);
    };
    volume.addEventListener("pointerdown", (event) => {
      volumeScrubbing = true;
      setVolumePopoverOpen(true);
      volume.setPointerCapture?.(event.pointerId);
      volume.focus?.({ preventScroll: true });
      setVolumeFromPointer(event);
      event.preventDefault();
    });
    volume.addEventListener("pointermove", (event) => {
      if (!volumeScrubbing) return;
      setVolumeFromPointer(event);
      event.preventDefault();
    });
    const finishVolumeScrub = (event) => {
      if (!volumeScrubbing) return;
      setVolumeFromPointer(event);
      volumeScrubbing = false;
      if (volume.hasPointerCapture?.(event.pointerId)) volume.releasePointerCapture?.(event.pointerId);
    };
    volume.addEventListener("pointerup", finishVolumeScrub);
    volume.addEventListener("pointercancel", () => {
      volumeScrubbing = false;
      sync(true);
    });
    volumeControl.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setVolumePopoverOpen(false);
      activePlayer()?.closest?.(".short-video-stage")?.focus?.({ preventScroll: true });
    });
    volumeControl.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") setVolumePopoverOpen(true);
    });
    volumeControl.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "touch") return;
      if (!volumeScrubbing && !volumeControl.contains(document.activeElement)) setVolumePopoverOpen(false);
    });
    volumeControl.addEventListener("focusin", () => setVolumePopoverOpen(true));
    volumeControl.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!volumeScrubbing && !volumeControl.contains(document.activeElement)) setVolumePopoverOpen(false);
      });
    });
    const closeVolumeFromOutside = (event) => {
      if (!volumeControl.contains(event.target)) setVolumePopoverOpen(false);
    };
    window.addEventListener("pointerdown", closeVolumeFromOutside, true);
    autoNext.addEventListener("click", () => {
      state.shortVideo.autoNext = !state.shortVideo.autoNext;
      writeAutoNextPreference(state.shortVideo.autoNext);
      syncActivePlaybackMode();
      showBrowserToast(state.shortVideo.autoNext ? "已开启连播" : "已关闭连播");
      sync(true);
    });
    rate.addEventListener("click", (event) => {
      showPlaybackSettings(state.shortVideo?.current, { trigger: event.currentTarget, focusSpeed: true });
    });
    original.addEventListener("click", () => openDouyinLink(state.shortVideo?.current));
    full.addEventListener("click", () => toggleShortVideoFullscreen());
    progress.addEventListener("pointerenter", (event) => {
      progressWrap.classList.add("is-hovering");
      updateSeekPreviewFromPointer(event);
    });
    progress.addEventListener("pointermove", (event) => {
      progressWrap.classList.add("is-hovering");
      if (scrubbing) seekFromProgressPointer(event);
      else updateSeekPreviewFromPointer(event);
    });
    progress.addEventListener("pointerleave", () => {
      progressWrap.classList.remove("is-hovering");
      if (!scrubbing) sync(true);
    });
    progress.addEventListener("pointerdown", (event) => {
      scrubbing = true;
      scrubPlayer = activePlayer();
      scrubWasPlaying = Boolean(scrubPlayer && !scrubPlayer.paused && !scrubPlayer.ended);
      scrubTargetTime = Math.max(0, Number(scrubPlayer?.currentTime || 0));
      scrubPlayer?.pause?.();
      progress.setPointerCapture?.(event.pointerId);
      progressWrap.classList.add("is-scrubbing");
      seekFromProgressPointer(event);
    });
    progress.addEventListener("pointerup", (event) => finishProgressScrub(event, true));
    progress.addEventListener("pointercancel", (event) => finishProgressScrub(event));
    progress.addEventListener("focus", () => {
      const player = activePlayer();
      const duration = Number(player?.duration || 0);
      updateSeekPreview(Number(progress.value || 0) / 1000, duration);
    });
    progress.addEventListener("input", () => {
      const player = activePlayer();
      if (!player) return;
      const duration = Number(player.duration || 0);
      if (!duration) return;
      const ratio = Number(progress.value || 0) / 1000;
      if (scrubbing) {
        scheduleScrubTarget(player, ratio * duration, duration);
      } else {
        player.currentTime = ratio * duration;
        updateSeekPreview(ratio, duration);
        sync(true);
      }
    });
    bar.append(play, time, progressWrap, controlSpacer, autoNext, rate, original, volumeControl, full);
    bar.shortVideoSync = () => {
      sync();
      scheduleProgressLoop();
    };
    bar.shortVideoDispose = () => {
      setVolumePopoverOpen(false);
      stopProgressLoop();
      if (scrubSeekRaf) window.cancelAnimationFrame(scrubSeekRaf);
      scrubSeekRaf = 0;
      scrubPlayer = null;
      window.removeEventListener("pointerdown", closeVolumeFromOutside, true);
    };
    window.requestAnimationFrame(() => bar.shortVideoSync?.());
    return bar;
  }

  async function openAdjacent(direction, options = {}) {
    const id = direction < 0 ? state.shortVideo.prevId : state.shortVideo.nextId;
    if (!id) {
      if (queuedAdjacentDirection === direction) queuedAdjacentDirection = 0;
      pulseBoundaryStack(direction);
      return;
    }
    clearPendingPlayerClick();
    closeTransientPlayerControls();
    if (wheelLocked) {
      queuedAdjacentDirection = direction;
      return;
    }
    const cachedVideo = (direction < 0 ? state.shortVideo.prevVideo : state.shortVideo.nextVideo)
      || cachedShortVideo(id);
    const hasCachedAdjacent = cachedVideo?.id === id;
    const canPromoteVideoPanel = hasCachedAdjacent
      && !isGalleryPost(state.shortVideo.current)
      && !isGalleryPost(cachedVideo);
    if (!canPromoteVideoPanel) flushActiveShortVideoWatch();
    wheelLocked = true;
    wheelDeltaY = 0;
    queuedAdjacentDirection = 0;
    wheelIgnoreUntil = Date.now() + 180;
    window.clearTimeout(wheelResetTimer);
    try {
      const animationPromise = animateActiveStack(direction, options.motion);
      const primePromise = primeAdjacentSound(direction, cachedVideo).catch(() => false);
      await Promise.all([
        animationPromise,
        primePromise
      ]);
      if (canPromoteVideoPanel) {
        promoteAdjacentPanelDom(direction, cachedVideo);
        await promoteAdjacentMedia(cachedVideo, direction);
      } else if (hasCachedAdjacent) {
        await promoteAdjacentMedia(cachedVideo, direction, { renderCurrent: true });
      } else {
        await openVideo(id, { renderLoading: false });
      }
    } finally {
      wheelIgnoreUntil = Date.now();
      wheelLocked = false;
      scheduleWheelGestureRelease();
      flushQueuedAdjacent();
    }
  }

  function flushQueuedAdjacent() {
    const direction = queuedAdjacentDirection;
    queuedAdjacentDirection = 0;
    if (!direction || state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
    const id = direction < 0 ? state.shortVideo.prevId : state.shortVideo.nextId;
    if (!id) return;
    openAdjacent(direction).catch(showError);
  }

  async function primeAdjacentSound(direction, video) {
    const player = adjacentPlayer(direction);
    if (!player) return false;
    const ready = await warmAdjacentVideoPlayer(player, video, {
      forceReload: Boolean(player.error),
      pauseAfter: false,
      timeout: SHORT_VIDEO_SWITCH_PRIME_TIMEOUT_MS
    });
    if (player.currentTime > 0.12) {
      try {
        player.currentTime = 0;
      } catch {}
    }
    // Keep the incoming reel silent until the visual handoff finishes. The
    // promoted player restores the user's sound preference in one step.
    player.muted = true;
    player.volume = currentShortVideoVolume();
    player.playbackRate = normalizePlaybackRate(state.shortVideo.playbackRate);
    player.play?.().catch(() => {});
    return ready || player.readyState >= 2;
  }

  function adjacentPlayer(direction) {
    const selector = direction > 0
      ? ".short-video-reel-panel.is-next .short-video-player"
      : ".short-video-reel-panel.is-prev .short-video-player";
    return els.workGrid?.querySelector?.(selector) || null;
  }

  async function warmAdjacentVideoPlayer(player, video, options = {}) {
    if (!player) return false;
    const source = String(video?.streamUrl || player.dataset.streamUrl || player.currentSrc || player.src || "").trim();
    if (!source) return false;
    const pauseAfter = options.pauseAfter !== false;
    const settleGhost = () => {
      if (!pauseAfter || !player.classList.contains("is-ghost")) return;
      player.pause?.();
      player.muted = true;
      player.preload = "metadata";
    };
    const shouldReload = Boolean(options.forceReload || player.error || !player.currentSrc);
    if (shouldReload) {
      delete player.dataset.shortVideoFrameReady;
      delete player.dataset.shortVideoFrameReadyAt;
      player.src = source;
      player.dataset.streamUrl = source;
      player.load?.();
    }
    player.preload = "auto";
    player.muted = true;
    if (player.readyState >= 1 && player.currentTime > 0.12) {
      delete player.dataset.shortVideoFrameReady;
      delete player.dataset.shortVideoFrameReadyAt;
      try {
        player.currentTime = 0;
      } catch {}
    }
    const readyPromise = waitForVideoFirstFrame(player, Math.max(200, Number(options.timeout || 1000)));
    player.play?.().catch(() => {});
    const ready = await readyPromise;
    settleGhost();
    return ready || player.readyState >= 2;
  }

  function scheduleAdjacentVideoWarmup(player, video, slot = "next") {
    const startedAt = Date.now();
    const warm = () => {
      if (!player?.isConnected || !player.classList.contains("is-ghost")) return;
      const current = activePlayer();
      if (current && current !== player && current.readyState < 2 && Date.now() - startedAt < 2600) {
        window.setTimeout(warm, 180);
        return;
      }
      if (slot === "prev" && Date.now() - startedAt < 2600) {
        const nextPlayer = player.closest(".short-video-reel-stack")?.querySelector(".short-video-reel-panel.is-next .short-video-player");
        if (nextPlayer && nextPlayer !== player && !nextPlayer.error && nextPlayer.dataset.shortVideoFrameReady !== "1") {
          window.setTimeout(warm, 160);
          return;
        }
        const nextReadyAt = Number(nextPlayer?.dataset?.shortVideoFrameReadyAt || 0);
        const nextCooldown = 600 - (Date.now() - nextReadyAt);
        if (nextReadyAt && nextCooldown > 0) {
          window.setTimeout(warm, nextCooldown);
          return;
        }
      }
      warmAdjacentVideoPlayer(player, video, { pauseAfter: true, timeout: 1200 }).catch(() => {});
    };
    window.setTimeout(warm, slot === "next" ? 40 : 220);
  }

  function warmVisibleAdjacentVideoPlayers() {
    const stack = activeReelStack();
    const players = [
      stack?.querySelector?.(".short-video-reel-panel.is-next .short-video-player"),
      stack?.querySelector?.(".short-video-reel-panel.is-prev .short-video-player")
    ].filter(Boolean);
    players.forEach((player, index) => {
      window.setTimeout(() => {
        warmAdjacentVideoPlayer(player, null, {
          forceReload: Boolean(player.error),
          pauseAfter: true,
          timeout: 1200
        }).catch(() => {});
      }, index * 360);
    });
  }

  function promoteAdjacentPanelDom(direction, video) {
    const stack = activeReelStack();
    if (!stack) return;
    const incoming = stack.querySelector(direction > 0 ? ".short-video-reel-panel.is-next" : ".short-video-reel-panel.is-prev");
    const outgoing = stack.querySelector(".short-video-reel-panel.is-current");
    if (!incoming || !outgoing) return;

    stack.classList.add("is-rebasing");
    stack.style.transition = "none";
    stack.classList.remove("is-snap-next", "is-snap-prev", "is-dragging");
    stack.style.setProperty("--short-video-drag-y", "0px");
    incoming.classList.remove("is-next", "is-prev", "is-ghost-panel");
    incoming.classList.add("is-current");
    incoming.removeAttribute("aria-hidden");
    outgoing.classList.remove("is-current");
    outgoing.classList.add(direction > 0 ? "is-prev" : "is-next", "is-ghost-panel");
    outgoing.setAttribute("aria-hidden", "true");
    stack.querySelectorAll(".short-video-reel-panel.is-ghost-panel").forEach((panel) => {
      if (panel !== outgoing) disposeReelPanel(panel);
    });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        stack.classList.remove("is-rebasing");
        stack.style.removeProperty("transition");
        incoming.shortVideoSyncCaptionOverflow?.();
      });
    });

    // Silence the outgoing reel before restoring sound on the incoming one.
    // The adjacent player may already be running muted for first-frame warmup,
    // so unmuting it first would briefly leave two audible players alive.
    const previousPlayer = outgoing.querySelector(".short-video-player");
    if (previousPlayer) {
      previousPlayer.classList.add("is-ghost");
      previousPlayer.muted = true;
      previousPlayer.pause?.();
      delete previousPlayer.dataset.shortVideoFrameReady;
      delete previousPlayer.dataset.shortVideoFrameReadyAt;
      try {
        previousPlayer.currentTime = 0;
      } catch {}
    }
    const previousBackdrop = outgoing.querySelector("video.short-video-backdrop-video");
    if (previousBackdrop) {
      previousBackdrop.muted = true;
      previousBackdrop.pause?.();
      try {
        previousBackdrop.currentTime = 0;
      } catch {}
    }

    const player = incoming.querySelector(".short-video-player");
    const stage = incoming.querySelector(".short-video-stage");
    if (player && stage) {
      player.classList.remove("is-ghost");
      player.muted = Boolean(state.shortVideo.muted);
      player.volume = currentShortVideoVolume();
      if (player.dataset.primaryControlsBound !== "1") {
        attachPrimaryPlayerControls(stage, player, () => incoming.querySelector(".short-video-rail"), video, { resume: false });
      }
      const likeButton = incoming.querySelector(".short-video-rail-button.is-like");
      if (likeButton && !likeButton.dataset.boundPrimaryLike) {
        likeButton.dataset.boundPrimaryLike = "1";
        likeButton.addEventListener("click", (event) => {
          toggleShortVideoAction(state.shortVideo?.current, "like", likeButton);
          showHeartBurst(stage, event);
        });
      }
      player.play?.().catch(() => {
        if (!state.shortVideo.muted) {
          markPlayerSoundBlocked(stage);
          player.muted = true;
          player.play?.().catch(() => {});
        }
      });
    }

    const incomingBackdrop = incoming.querySelector("video.short-video-backdrop-video");
    if (incomingBackdrop) {
      incomingBackdrop.preload = "auto";
      incomingBackdrop.muted = true;
      incomingBackdrop.play?.().catch(() => {});
    }

  }

  function promoteAdjacentMedia(video, direction, options = {}) {
    const previousCurrent = state.shortVideo.current;
    const navigation = cachedShortVideoNavigation(video.id);
    const fallbackPrevId = direction > 0 ? previousCurrent?.id || "" : "";
    const fallbackNextId = direction < 0 ? previousCurrent?.id || "" : "";
    state.shortVideo.current = video;
    state.shortVideo.slideDirection = 0;
    state.shortVideo.loading = false;
    state.shortVideo.status = "";
    state.shortVideo.prevId = navigation?.prevId || fallbackPrevId;
    state.shortVideo.nextId = navigation?.nextId || fallbackNextId;
    state.shortVideo.prevVideo = cachedShortVideo(state.shortVideo.prevId)
      || (previousCurrent?.id === state.shortVideo.prevId ? previousCurrent : null);
    state.shortVideo.nextVideo = cachedShortVideo(state.shortVideo.nextId)
      || (previousCurrent?.id === state.shortVideo.nextId ? previousCurrent : null);
    replaceRoute({ view: "shortVideos", shortVideoId: video.id });
    syncActiveControlBar();
    if (options.renderCurrent) {
      renderStats();
      renderView();
      resumeActiveSound();
    } else {
      refreshAdjacentPanelsDom();
    }
    scheduleAdjacentNavigationPrefetch();
    hydratePromotedShortVideo(video).catch((error) => console.warn(error));
  }

  async function hydratePromotedShortVideo(video) {
    try {
      const data = await fetchShortVideoDetail(video.id);
      if (state.shortVideo.current?.id !== video.id) return;
      state.shortVideo.current = data.video || video;
      cacheAuthorPanelVideo(state.shortVideo.current);
      state.shortVideo.prevId = data.prevId || "";
      state.shortVideo.nextId = data.nextId || "";
      state.shortVideo.prevVideo = cachedShortVideo(state.shortVideo.prevId);
      state.shortVideo.nextVideo = cachedShortVideo(state.shortVideo.nextId);
      await loadAdjacentVideos(video.id);
      if (state.shortVideo.current?.id === video.id) {
        refreshAdjacentPanelsDom();
        syncAuthorPanelCurrentTile();
      }
      resumeActiveSound();
    } catch (error) {
      if (state.shortVideo.current?.id === video.id) {
        refreshAdjacentPanelsDom();
        syncAuthorPanelCurrentTile();
        resumeActiveSound();
      }
      throw error;
    }
  }

  function refreshAdjacentPanelsDom() {
    const stack = activeReelStack();
    if (!stack || !state.shortVideo?.current) {
      renderView();
      return;
    }
    const currentPanel = stack.querySelector(".short-video-reel-panel.is-current");
    if (!currentPanel) {
      renderView();
      return;
    }
    const existingGhosts = [...stack.querySelectorAll(".short-video-reel-panel.is-ghost-panel")];
    const reusedGhosts = new Set();
    const placeGhost = (video, slot) => {
      if (!video?.id) return;
      const videoId = String(video.id);
      let panel = existingGhosts.find((candidate) => !reusedGhosts.has(candidate) && candidate.dataset.videoId === videoId);
      if (panel) {
        reusedGhosts.add(panel);
        panel.classList.remove("is-current", "is-prev", "is-next");
        panel.classList.add(`is-${slot}`, "is-ghost-panel");
        panel.setAttribute("aria-hidden", "true");
        const player = panel.querySelector(".short-video-player");
        if (player) {
          player.classList.add("is-ghost");
          player.muted = true;
          player.pause?.();
        }
      } else {
        panel = renderReelPanel(video, { ghost: true, slot }).panel;
      }
      if (slot === "prev") stack.insertBefore(panel, currentPanel);
      else stack.append(panel);
    };
    placeGhost(state.shortVideo.prevVideo, "prev");
    placeGhost(state.shortVideo.nextVideo, "next");
    existingGhosts.forEach((panel) => {
      if (!reusedGhosts.has(panel)) disposeReelPanel(panel);
    });
    syncCurrentNavigationDom();
  }

  function disposeReelPanel(panel) {
    if (!panel) return;
    panel.querySelectorAll?.("video")?.forEach?.((player) => {
      player.muted = true;
      player.pause?.();
    });
    panel.remove();
  }

  function syncCurrentNavigationDom() {
    const buttons = els.workGrid?.querySelectorAll?.(".short-video-browser > .short-video-nav-pair .short-video-rail-button.is-nav");
    if (!buttons?.length) return;
    if (buttons[0]) buttons[0].disabled = !state.shortVideo.prevId;
    if (buttons[1]) buttons[1].disabled = !state.shortVideo.nextId;
  }

  function syncShortVideoBrowserSearchDom() {
    shortVideoSearch.syncTrigger(els.workGrid);
  }

  function shortVideoFeedSnapshot() {
    return {
      author: state.shortVideo?.author || "all",
      source: state.shortVideo?.source || "liked",
      query: state.shortVideo?.query || "",
      topic: state.shortVideo?.topic || "",
      sound: state.shortVideo?.sound || "",
      soundInfo: state.shortVideo?.soundInfo || null,
      media: state.shortVideo?.media || "all",
      sort: state.shortVideo?.sort || "published"
    };
  }

  function applyShortVideoFeedSnapshot(feed = {}) {
    state.shortVideo.author = feed.author || "all";
    state.shortVideo.source = normalizeShortVideoSource(feed.source || "liked");
    state.shortVideo.query = feed.query || "";
    state.shortVideo.topic = normalizeShortVideoTopic(feed.topic);
    state.shortVideo.sound = normalizeShortVideoSound(feed.sound);
    state.shortVideo.soundInfo = feed.soundInfo || null;
    state.shortVideo.media = normalizeShortVideoMedia(feed.media);
    state.shortVideo.sort = feed.sort || "published";
    state.shortVideo.data = null;
  }

  function clearAuthorPanelCaches() {
    authorPanelVideoCache = null;
    authorPanelTileMap = null;
  }

  function cacheAuthorPanelVideos(videos = []) {
    const cache = new Map();
    for (const video of videos) {
      const id = String(video?.id || "").trim();
      if (id) {
        cache.set(id, video);
        rememberShortVideo(video);
      }
    }
    authorPanelVideoCache = cache.size ? cache : null;
  }

  function cacheAuthorPanelVideo(video) {
    const id = String(video?.id || "").trim();
    if (!id || !authorPanelVideoCache) return;
    rememberShortVideo(video);
    authorPanelVideoCache.set(id, video);
  }

  function cachedAuthorPanelVideo(id) {
    const key = String(id || "").trim();
    return key ? authorPanelVideoCache?.get(key) || null : null;
  }

  function closeAuthorPanel(panel, options = {}) {
    if (!panel || panel.dataset.closing === "1") return;
    const browser = panel.closest?.(".short-video-browser");
    const returnFocus = panel._shortVideoReturnFocus;
    panel._shortVideoDragAbort?.abort?.();
    panel._shortVideoDragAbort = null;
    browser?.classList.remove("is-author-panel-open");
    panel?.querySelectorAll?.(".short-video-sound-audio")?.forEach?.((audio) => {
      try {
        audio.pause?.();
        audio.removeAttribute?.("src");
        audio.load?.();
      } catch {}
    });
    authorPanelVideoRequestId += 1;
    clearAuthorPanelCaches();
    if (options.restoreFeed === false) authorPanelReturnFeed = null;
    let finished = false;
    let handleTransitionEnd = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (panel._shortVideoCloseTimer) window.clearTimeout(panel._shortVideoCloseTimer);
      panel._shortVideoCloseTimer = 0;
      if (handleTransitionEnd) panel.removeEventListener("transitionend", handleTransitionEnd);
      restoreAuthorPanelModalIsolation(panel);
      panel.remove();
      if (options.restoreFocus !== false && returnFocus?.isConnected) {
        returnFocus.focus?.({ preventScroll: true });
      }
      if (options.restoreFeed !== false) restoreAuthorPanelFeed().catch(showError);
    };
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (options.animate === false || reduceMotion || !panel.isConnected) {
      finish();
      return;
    }
    panel.dataset.closing = "1";
    panel.classList.add("is-closing");
    panel.classList.remove("is-open");
    handleTransitionEnd = (event) => {
      if (event.propertyName === "transform") finish();
    };
    panel.addEventListener("transitionend", handleTransitionEnd);
    panel._shortVideoCloseTimer = window.setTimeout(finish, 1000);
  }

  function isolateAuthorPanelAsMobileModal(panel, sheet, browser, initialFocus) {
    if (!panel || !sheet || !browser || !window.matchMedia?.("(max-width: 680px)")?.matches) return;
    panel.setAttribute("aria-modal", "true");
    panel._shortVideoModalSiblings = [...browser.children]
      .filter((element) => element !== panel)
      .map((element) => ({ element, wasInert: element.hasAttribute("inert") }));
    for (const item of panel._shortVideoModalSiblings) item.element.setAttribute("inert", "");
    bindShortVideoModalFocusLoop(panel, sheet, () => closeAuthorPanel(panel));
    window.requestAnimationFrame(() => initialFocus?.focus?.({ preventScroll: true }));
  }

  function restoreAuthorPanelModalIsolation(panel) {
    for (const item of panel?._shortVideoModalSiblings || []) {
      if (!item.wasInert && item.element?.isConnected) item.element.removeAttribute("inert");
    }
    panel._shortVideoModalSiblings = null;
  }

  function bindAuthorPanelDragToClose(panel, sheet, handle) {
    if (!panel || !sheet || !handle) return;
    panel._shortVideoDragAbort?.abort?.();
    const dragAbort = new AbortController();
    panel._shortVideoDragAbort = dragAbort;
    let pointerId = -1;
    let startY = 0;
    let lastY = 0;
    let lastAt = 0;
    let velocityY = 0;
    let dragY = 0;
    let moved = false;
    let mouseFallbackActive = false;
    let suppressClickUntil = 0;
    const mobileSheet = () => window.matchMedia?.("(max-width: 680px)")?.matches;
    const clearDrag = () => {
      pointerId = -1;
      mouseFallbackActive = false;
      sheet.classList.remove("is-dragging");
      handle.removeAttribute("aria-pressed");
    };
    const beginDrag = (clientY, nextPointerId, eventTime) => {
      pointerId = nextPointerId;
      startY = clientY;
      lastY = clientY;
      lastAt = eventTime || Date.now();
      velocityY = 0;
      dragY = 0;
      moved = false;
      sheet.classList.add("is-dragging");
      sheet.style.setProperty("--short-video-author-sheet-drag-y", "0px");
      handle.setAttribute("aria-pressed", "true");
    };
    const moveDrag = (clientY, eventTime) => {
      const nextY = Math.max(0, clientY - startY);
      const now = eventTime || Date.now();
      const elapsed = Math.max(1, now - lastAt);
      velocityY = Math.max(0, (clientY - lastY) / elapsed);
      lastY = clientY;
      lastAt = now;
      dragY = Math.min(nextY, Math.max(180, sheet.clientHeight * .82));
      moved = moved || dragY > 4;
      sheet.style.setProperty("--short-video-author-sheet-drag-y", `${dragY}px`);
    };
    const settle = (event, cancelled = false) => {
      if (pointerId < 0 || (event?.pointerId != null && event.pointerId !== pointerId)) return;
      try {
        handle.releasePointerCapture?.(pointerId);
      } catch {}
      const closeDistance = Math.min(160, Math.max(96, sheet.clientHeight * .2));
      const shouldClose = !cancelled && (dragY >= closeDistance || (dragY >= 28 && velocityY >= .62));
      if (moved) suppressClickUntil = Date.now() + 280;
      clearDrag();
      if (shouldClose) {
        sheet.style.setProperty("--short-video-author-sheet-drag-y", `${Math.max(dragY, 120)}px`);
        closeAuthorPanel(panel);
        return;
      }
      sheet.style.setProperty("--short-video-author-sheet-drag-y", "0px");
    };
    handle.addEventListener("pointerdown", (event) => {
      if (!mobileSheet() || panel.dataset.closing === "1") return;
      beginDrag(event.clientY, event.pointerId, event.timeStamp);
      try {
        handle.setPointerCapture?.(pointerId);
      } catch {}
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId) return;
      moveDrag(event.clientY, event.timeStamp);
      event.preventDefault();
    });
    handle.addEventListener("pointerup", (event) => settle(event));
    handle.addEventListener("pointercancel", (event) => settle(event, true));
    handle.addEventListener("mousedown", (event) => {
      if (!mobileSheet() || panel.dataset.closing === "1" || pointerId >= 0) return;
      mouseFallbackActive = true;
      beginDrag(event.clientY, -2, event.timeStamp);
      event.preventDefault();
    });
    window.addEventListener("mousemove", (event) => {
      if (!mouseFallbackActive || pointerId !== -2) return;
      moveDrag(event.clientY, event.timeStamp);
      event.preventDefault();
    }, { signal: dragAbort.signal });
    window.addEventListener("mouseup", (event) => {
      if (!mouseFallbackActive || pointerId !== -2) return;
      settle({ pointerId: -2 });
      event.preventDefault();
    }, { signal: dragAbort.signal });
    handle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < suppressClickUntil) return;
      closeAuthorPanel(panel);
    });
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      closeAuthorPanel(panel);
    });
  }

  async function restoreAuthorPanelFeed() {
    const returnFeed = authorPanelReturnFeed;
    authorPanelReturnFeed = null;
    if (!returnFeed) return;
    applyShortVideoFeedSnapshot(returnFeed);
    const currentId = state.shortVideo?.current?.id || "";
    if (!currentId) {
      replaceRoute({ view: "shortVideos", shortVideoId: "" });
      return;
    }
    const data = await fetchShortVideoDetail(currentId);
    if (state.shortVideo?.current?.id !== currentId) return;
    state.shortVideo.current = data.video || state.shortVideo.current;
    state.shortVideo.prevId = data.prevId || "";
    state.shortVideo.nextId = data.nextId || "";
    await loadAdjacentVideos(currentId);
    if (state.shortVideo?.current?.id !== currentId) return;
    renderStats();
    refreshAdjacentPanelsDom();
    syncShortVideoBrowserSearchDom();
    replaceRoute({ view: "shortVideos", shortVideoId: currentId });
  }

  function syncAuthorPanelCurrentTile() {
    const panel = els.workGrid?.querySelector?.(".short-video-author-panel");
    const grid = panel?.querySelector?.(".short-video-author-grid");
    const current = state.shortVideo?.current;
    if (!panel || !grid || !current?.id) return;
    const previousTile = grid.querySelector(".short-video-author-tile.is-current");
    const currentId = String(current.id || "").trim();
    const currentAwemeId = String(current.awemeId || "").trim();
    const nextTile = authorPanelTileMap?.get(`id:${currentId}`)
      || (currentAwemeId ? authorPanelTileMap?.get(`aweme:${currentAwemeId}`) : null)
      || null;
    if (previousTile && previousTile !== nextTile) {
      previousTile.classList.remove("is-current");
      previousTile.removeAttribute("aria-current");
      previousTile.querySelector(".short-video-author-current-badge")?.remove();
    }
    if (nextTile?.isConnected) {
      nextTile.classList.add("is-current");
      nextTile.setAttribute("aria-current", "true");
      ensureAuthorCurrentBadge(nextTile);
    }
  }

  function syncRelatedPanelCurrentItem(panel = null) {
    const root = panel?.isConnected ? panel : els.workGrid?.querySelector?.(".short-video-author-panel");
    if (!root) return;
    const current = state.shortVideo?.current;
    for (const item of root.querySelectorAll(".short-video-related-item")) {
      const selected = isCurrentShortVideo({
        id: item.dataset.videoId || "",
        awemeId: item.dataset.awemeId || ""
      }, current);
      item.classList.toggle("is-current", selected);
      if (selected) item.setAttribute("aria-current", "true");
      else item.removeAttribute("aria-current");
      const existing = item.querySelector(".short-video-related-current");
      if (selected && !existing) {
        const badge = document.createElement("span");
        badge.className = "short-video-related-current";
        badge.textContent = "播放中";
        item.querySelector(".short-video-related-media")?.append(badge);
      } else if (!selected) {
        existing?.remove();
      }
    }
  }

  function ensureAuthorCurrentBadge(tile) {
    const media = tile?.querySelector?.(".short-video-author-tile-media");
    if (!media || media.querySelector(".short-video-author-current-badge")) return;
    const currentBadge = document.createElement("span");
    currentBadge.className = "short-video-author-current-badge";
    currentBadge.textContent = "当前观看";
    media.append(currentBadge);
  }

  function waitForVideoFirstFrame(player, timeout = 260) {
    if (!player) return Promise.resolve(false);
    if (player.readyState >= 2 && player.dataset.shortVideoFrameReady === "1") return Promise.resolve(true);
    if (player.readyState >= 2 && !player.requestVideoFrameCallback) return Promise.resolve(true);
    return new Promise((resolve) => {
      let finished = false;
      let frameHandle = null;
      const done = (ready) => {
        if (finished) return;
        finished = true;
        player.removeEventListener("loadeddata", onReady);
        player.removeEventListener("canplay", onReady);
        player.removeEventListener("playing", onReady);
        if (frameHandle && player.cancelVideoFrameCallback) {
          player.cancelVideoFrameCallback(frameHandle);
        }
        if (ready) {
          player.dataset.shortVideoFrameReady = "1";
          player.dataset.shortVideoFrameReadyAt = String(Date.now());
        }
        resolve(ready);
      };
      const requestPaintedFrame = () => {
        if (finished || frameHandle || player.readyState < 2 || !player.requestVideoFrameCallback) return false;
        frameHandle = player.requestVideoFrameCallback(() => done(true));
        return true;
      };
      const onReady = () => {
        if (!requestPaintedFrame()) done(true);
      };
      player.addEventListener("loadeddata", onReady, { once: true });
      player.addEventListener("canplay", onReady, { once: true });
      player.addEventListener("playing", onReady, { once: true });
      requestPaintedFrame();
      window.setTimeout(() => done(player.readyState >= 2), timeout);
    });
  }

  function resumeActiveSound() {
    if (state.shortVideo.muted) return;
    window.requestAnimationFrame(() => {
      const player = activePlayer();
      if (!player) return;
      player.muted = false;
      player.volume = currentShortVideoVolume();
      player.play?.().catch(() => {
        markPlayerSoundBlocked(player.closest(".short-video-stage"));
        player.muted = true;
        player.play?.().catch(() => {});
      });
    });
  }

  function showHome() {
    shortVideoVisibilitySnapshot = null;
    shortVideoOpenRequestId += 1;
    shortVideoOpeningId = "";
    shortVideoOpenError = "";
    flushActiveShortVideoWatch();
    if (authorPanelReturnFeed) {
      applyShortVideoFeedSnapshot(authorPanelReturnFeed);
      authorPanelReturnFeed = null;
    }
    state.shortVideo.current = null;
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    state.shortVideo.prevId = "";
    state.shortVideo.nextId = "";
    state.shortVideo.slideDirection = 0;
    state.shortVideo.loading = false;
    state.shortVideo.status = "";
    setBodyClass();
    renderStats();
    renderView();
    if (!state.shortVideo.data && !state.shortVideo.loading) {
      loadVideos({ replaceRoute: true }).catch(showError);
      return;
    }
    pushRoute({ view: "shortVideos", shortVideoId: "" });
  }

  function showHomeAndFocusSearch() {
    showHome();
    window.requestAnimationFrame(() => {
      shortVideoSearch.focus(els.workGrid);
    });
  }

  function installBrowseEvents() {
    if (eventsInstalled) return;
    eventsInstalled = true;
    window.addEventListener("wheel", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (isShortVideoOverlayTarget(event.target)) return;
      event.preventDefault();
      handleWheelSwipe(event.deltaY);
    }, { passive: false });
    window.addEventListener("scroll", () => {
      if (state.activeView !== "shortVideos" || state.shortVideo?.current) return;
      if (state.shortVideo?.source === "authors") {
        appendVisibleAuthorsIfNeeded();
        return;
      }
      if (!state.shortVideo?.data) return;
      scheduleShortVideoWindowUpdate();
    }, { passive: true });
    let resizeRaf = 0;
    window.addEventListener("resize", () => {
      if (state.activeView !== "shortVideos" || state.shortVideo?.current) return;
      if (resizeRaf) return;
      resizeRaf = window.requestAnimationFrame(() => {
        resizeRaf = 0;
        svReady = false;
        svStart = 0;
        svEnd = 0;
        svCardH = 0;
        if (svGridEl) renderShortVideoWindow(true);
      });
    });
    window.addEventListener("touchstart", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      touchControlInteraction = isShortVideoOverlayTarget(event.target) || isShortVideoKeyboardControl(event.target);
      if (touchControlInteraction) return;
      holdSpeedGestureConsumed = false;
      holdSpeedGestureBlockUntil = 0;
      const touch = event.touches?.[0];
      touchStartX = touch?.clientX || 0;
      touchStartY = touch?.clientY || 0;
      touchLastX = touchStartX;
      touchLastY = touchStartY;
      touchLastAt = Date.now();
      touchVelocityX = 0;
      touchVelocityY = 0;
      touchDeltaX = 0;
      touchDeltaY = 0;
      touchHorizontalDragging = false;
      state.shortVideo.dragging = true;
      activeReelStack()?.classList.add("is-dragging");
    }, { passive: true });
    window.addEventListener("touchmove", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (touchControlInteraction) return;
      if (isShortVideoOverlayTarget(event.target)) return;
      const touch = event.touches?.[0];
      const x = touch?.clientX || 0;
      const y = touch?.clientY || 0;
      const now = Date.now();
      const elapsed = Math.max(1, now - touchLastAt);
      const instantVelocityX = (x - touchLastX) / elapsed;
      const instantVelocityY = (y - touchLastY) / elapsed;
      touchVelocityX = touchVelocityX * .35 + instantVelocityX * .65;
      touchVelocityY = touchVelocityY * .35 + instantVelocityY * .65;
      touchLastX = x;
      touchLastY = y;
      touchLastAt = now;
      touchDeltaX = x - touchStartX;
      touchDeltaY = y - touchStartY;
      if (holdSpeedGestureConsumed) {
        touchDeltaX = 0;
        touchDeltaY = 0;
        touchVelocityX = 0;
        touchVelocityY = 0;
        event.preventDefault();
        return;
      }
      if (!touchHorizontalDragging && isHorizontalSwipe(touchDeltaX, touchDeltaY, 28)) {
        touchHorizontalDragging = true;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        startActiveGalleryDrag();
      }
      if (touchHorizontalDragging) updateActiveGalleryDrag(touchDeltaX);
      else scheduleReelDragDelta(touchDeltaY);
      event.preventDefault();
    }, { passive: false });
    window.addEventListener("touchend", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (touchControlInteraction) {
        touchControlInteraction = false;
        return;
      }
      if (holdSpeedGestureConsumed || Date.now() < holdSpeedGestureBlockUntil) {
        holdSpeedGestureConsumed = false;
        holdSpeedGestureBlockUntil = Date.now() + 120;
        state.shortVideo.dragging = false;
        touchHorizontalDragging = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        return;
      }
      if (isShortVideoOverlayTarget(event.target)) return;
      const touch = event.changedTouches?.[0];
      const endX = touch?.clientX || 0;
      const endY = touch?.clientY || 0;
      const deltaX = touchDeltaX || endX - touchStartX;
      const deltaY = touchDeltaY || endY - touchStartY;
      if (Math.hypot(deltaX, deltaY) > 8) {
        markShortVideoGestureClickBlocked(event.target);
      }
      if (Date.now() - touchLastAt > 80) {
        const velocityDecay = Math.max(0, 1 - (Date.now() - touchLastAt - 80) / 180);
        touchVelocityX *= velocityDecay;
        touchVelocityY *= velocityDecay;
      }
      if (touchHorizontalDragging) {
        state.shortVideo.dragging = false;
        touchHorizontalDragging = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        const handled = finishActiveGalleryDrag(deltaX, touchVelocityX);
        if (!handled && isHorizontalSwipe(deltaX, deltaY, 72)) handleHorizontalSwipe(deltaX);
        else if (!handled) finishDrag(0, 0);
        return;
      }
      finishDrag(deltaY, touchVelocityY);
    }, { passive: true });
    window.addEventListener("touchcancel", () => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (touchControlInteraction) {
        touchControlInteraction = false;
        return;
      }
      if (holdSpeedGestureConsumed || Date.now() < holdSpeedGestureBlockUntil) {
        holdSpeedGestureConsumed = false;
        holdSpeedGestureBlockUntil = Date.now() + 120;
        touchHorizontalDragging = false;
        state.shortVideo.dragging = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        return;
      }
      const wasHorizontal = touchHorizontalDragging;
      touchHorizontalDragging = false;
      state.shortVideo.dragging = false;
      activeReelStack()?.classList.remove("is-dragging");
      if (wasHorizontal) cancelActiveGalleryDrag();
      finishDrag(0, 0);
    }, { passive: true });
    window.addEventListener("pointerdown", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (event.pointerType === "touch") return;
      if (isShortVideoOverlayTarget(event.target)) return;
      if (event.button !== 0 || event.target?.closest?.("button, select, input, textarea, a")) return;
      holdSpeedGestureConsumed = false;
      holdSpeedGestureBlockUntil = 0;
      pointerStartX = event.clientX || 0;
      pointerStartY = event.clientY || 0;
      pointerLastX = pointerStartX;
      pointerLastY = pointerStartY;
      pointerLastAt = Date.now();
      pointerVelocityX = 0;
      pointerVelocityY = 0;
      pointerDeltaX = 0;
      pointerDeltaY = 0;
      pointerHorizontalDragging = false;
      pointerDragging = true;
      state.shortVideo.dragging = true;
      activeReelStack()?.classList.add("is-dragging");
    });
    window.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return;
      if (!pointerDragging || state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      const x = event.clientX || 0;
      const y = event.clientY || 0;
      const now = Date.now();
      const elapsed = Math.max(1, now - pointerLastAt);
      const instantVelocityX = (x - pointerLastX) / elapsed;
      const instantVelocityY = (y - pointerLastY) / elapsed;
      pointerVelocityX = pointerVelocityX * .35 + instantVelocityX * .65;
      pointerVelocityY = pointerVelocityY * .35 + instantVelocityY * .65;
      pointerLastX = x;
      pointerLastY = y;
      pointerLastAt = now;
      pointerDeltaX = x - pointerStartX;
      pointerDeltaY = y - pointerStartY;
      if (holdSpeedGestureConsumed) {
        pointerDeltaX = 0;
        pointerDeltaY = 0;
        pointerVelocityX = 0;
        pointerVelocityY = 0;
        event.preventDefault();
        return;
      }
      if (!pointerHorizontalDragging && isHorizontalSwipe(pointerDeltaX, pointerDeltaY, 28)) {
        pointerHorizontalDragging = true;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        startActiveGalleryDrag();
      }
      if (pointerHorizontalDragging) updateActiveGalleryDrag(pointerDeltaX);
      else scheduleReelDragDelta(pointerDeltaY);
      event.preventDefault();
    }, { passive: false });
    window.addEventListener("pointerup", (event) => {
      if (event.pointerType === "touch") return;
      if (!pointerDragging) return;
      pointerDragging = false;
      if (holdSpeedGestureConsumed || Date.now() < holdSpeedGestureBlockUntil) {
        holdSpeedGestureConsumed = false;
        holdSpeedGestureBlockUntil = Date.now() + 120;
        pointerHorizontalDragging = false;
        state.shortVideo.dragging = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        return;
      }
      if (Math.hypot(pointerDeltaX, pointerDeltaY) > 8) {
        markShortVideoGestureClickBlocked(event.target);
        suppressNextPlayerClick = true;
        window.setTimeout(() => {
          suppressNextPlayerClick = false;
        }, 240);
      }
      if (Date.now() - pointerLastAt > 80) {
        const velocityDecay = Math.max(0, 1 - (Date.now() - pointerLastAt - 80) / 180);
        pointerVelocityX *= velocityDecay;
        pointerVelocityY *= velocityDecay;
      }
      if (pointerHorizontalDragging) {
        state.shortVideo.dragging = false;
        pointerHorizontalDragging = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        const handled = finishActiveGalleryDrag(pointerDeltaX, pointerVelocityX);
        if (!handled && isHorizontalSwipe(pointerDeltaX, pointerDeltaY, 72)) handleHorizontalSwipe(pointerDeltaX);
        else if (!handled) finishDrag(0, 0);
        return;
      }
      finishDrag(pointerDeltaY, pointerVelocityY);
    });
    window.addEventListener("pointercancel", (event) => {
      if (event.pointerType === "touch") return;
      if (!pointerDragging) return;
      pointerDragging = false;
      if (holdSpeedGestureConsumed || Date.now() < holdSpeedGestureBlockUntil) {
        holdSpeedGestureConsumed = false;
        holdSpeedGestureBlockUntil = Date.now() + 120;
        pointerHorizontalDragging = false;
        state.shortVideo.dragging = false;
        suppressNextPlayerClick = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        return;
      }
      const wasHorizontal = pointerHorizontalDragging;
      pointerHorizontalDragging = false;
      suppressNextPlayerClick = false;
      if (wasHorizontal) cancelActiveGalleryDrag();
      finishDrag(0, 0);
    });
    window.addEventListener("keydown", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      const playbackSettings = event.target?.closest?.(".short-video-more-overlay")
        || els.workGrid?.querySelector?.(".short-video-more-overlay");
      if (playbackSettings) {
        if (event.key === "Escape") {
          event.preventDefault();
          closePlaybackSettings(playbackSettings);
        }
        return;
      }
      if (isShortVideoKeyboardControl(event.target)) return;
      if (["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "PageDown", "PageUp", " ", "m", "M", "j", "J", "f", "F", "Escape"].includes(event.key)) {
        els.workGrid?.querySelector?.(".short-video-browser")?.shortVideoRevealControls?.(1900);
      }
      if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && isGalleryPost(state.shortVideo.current)) {
        event.preventDefault();
        stepActiveGallery(event.key === "ArrowLeft" ? -1 : 1);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        seekActiveVideo(event.key === "ArrowLeft" ? -5 : 5);
      } else if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        openAdjacent(1).catch(showError);
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        openAdjacent(-1).catch(showError);
      } else if (event.key === " ") {
        event.preventDefault();
        toggleActivePlayer();
      } else if (event.key?.toLowerCase?.() === "m") {
        event.preventDefault();
        toggleActiveMute();
      } else if (event.key?.toLowerCase?.() === "j") {
        event.preventDefault();
        toggleClearScreen();
      } else if (event.key?.toLowerCase?.() === "f") {
        event.preventDefault();
        toggleShortVideoFullscreen();
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (document.fullscreenElement) toggleShortVideoFullscreen();
        else closeOrRevealBrowser();
      }
    });
    document.addEventListener("visibilitychange", handleShortVideoVisibilityChange);
    document.addEventListener("fullscreenchange", syncShortVideoFullscreenControls);
    window.addEventListener("pagehide", flushActiveShortVideoWatch);
  }

  function handleShortVideoVisibilityChange() {
    if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
    const gallery = activeGalleryPlayer();
    const players = els.workGrid?.querySelectorAll?.(
      ".short-video-player, .short-video-gallery-image[data-gallery-media-type='video']"
    ) || [];
    if (document.hidden) {
      gallery?.shortVideoGalleryPause?.();
      const current = activePlayer();
      shortVideoVisibilitySnapshot = {
        videoId: current?.closest?.(".short-video-reel-panel")?.dataset?.videoId || "",
        wasPlaying: Boolean(current && !current.paused && !current.ended)
      };
      flushActiveShortVideoWatch();
      players.forEach((player) => {
        player.muted = true;
        player.pause?.();
      });
      return;
    }
    gallery?.shortVideoGalleryResume?.();
    const resume = shortVideoVisibilitySnapshot;
    shortVideoVisibilitySnapshot = null;
    const current = activePlayer();
    if (!current) return;
    const currentVideoId = current.closest?.(".short-video-reel-panel")?.dataset?.videoId || "";
    if (!resume?.wasPlaying || resume.videoId !== currentVideoId) {
      current.muted = Boolean(state.shortVideo.muted);
      current.volume = currentShortVideoVolume();
      syncActiveControlBar();
      return;
    }
    if (state.shortVideo.muted) {
      current.muted = true;
      current.play?.().catch(() => {});
      return;
    }
    resumeActiveSound();
  }

  function activePlayer() {
    const panel = els.workGrid?.querySelector?.(".short-video-reel-panel.is-current");
    return panel?.querySelector?.(".short-video-gallery-audio")
      || panel?.querySelector?.(".short-video-player:not(.is-ghost)")
      || null;
  }

  function closeTransientPlayerControls() {
    const volumeControl = els.workGrid?.querySelector?.(".short-video-control-volume");
    const hadVolumeFocus = Boolean(volumeControl?.contains?.(document.activeElement));
    if (typeof volumeControl?.shortVideoSetOpen === "function") volumeControl.shortVideoSetOpen(false);
    else {
      volumeControl?.classList.remove("is-open");
      volumeControl?.querySelector?.("button")?.setAttribute?.("aria-expanded", "false");
      const popover = volumeControl?.querySelector?.(".short-video-volume-popover");
      popover?.setAttribute?.("aria-hidden", "true");
      if (popover) popover.inert = true;
    }
    els.workGrid?.querySelector?.(".short-video-control-progress-wrap")?.classList.remove("is-hovering", "is-scrubbing");
    if (hadVolumeFocus) {
      activePlayer()?.closest?.(".short-video-stage")?.focus?.({ preventScroll: true });
    }
  }

  function syncActiveControlBar() {
    const bar = els.workGrid?.querySelector?.(".short-video-control-bar");
    bar?.shortVideoSync?.();
  }

  function activeGalleryPlayer() {
    return els.workGrid?.querySelector?.(".short-video-reel-panel.is-current .short-video-gallery-player") || null;
  }

  function stepActiveGallery(direction) {
    const gallery = activeGalleryPlayer();
    const count = Math.max(0, Number(gallery?.dataset?.galleryCount || 0));
    if (!gallery || count <= 1) return false;
    gallery.shortVideoGalleryMove?.(direction);
    return true;
  }

  function startActiveGalleryDrag() {
    return Boolean(activeGalleryPlayer()?.shortVideoGalleryDragStart?.());
  }

  function updateActiveGalleryDrag(deltaX) {
    return Boolean(activeGalleryPlayer()?.shortVideoGalleryDragMove?.(deltaX));
  }

  function finishActiveGalleryDrag(deltaX, velocityX = 0) {
    return Boolean(activeGalleryPlayer()?.shortVideoGalleryDragEnd?.(deltaX, velocityX));
  }

  function cancelActiveGalleryDrag() {
    return Boolean(activeGalleryPlayer()?.shortVideoGalleryDragCancel?.());
  }

  function isShortVideoKeyboardControl(target) {
    return Boolean(target?.closest?.("input, textarea, select, button, a, [contenteditable='true'], [role='button'], [role='tab'], [role='slider']"));
  }

  function markShortVideoGestureClickBlocked(target, durationMs = 420) {
    const browser = target?.closest?.(".short-video-browser")
      || els.workGrid?.querySelector?.(".short-video-browser");
    if (!browser) return;
    browser.dataset.shortVideoGestureBlockUntil = String(Date.now() + Math.max(120, Number(durationMs) || 420));
  }

  function isShortVideoGestureClickBlocked(target) {
    const browser = target?.closest?.(".short-video-browser")
      || els.workGrid?.querySelector?.(".short-video-browser");
    const blockedUntil = Number(browser?.dataset?.shortVideoGestureBlockUntil || 0);
    if (!blockedUntil) return false;
    if (Date.now() < blockedUntil) return true;
    delete browser.dataset.shortVideoGestureBlockUntil;
    return false;
  }

  function seekActiveVideo(deltaSeconds) {
    const player = activePlayer();
    if (!player) return false;
    const duration = Number(player.duration || 0);
    const current = Number(player.currentTime || 0);
    if (!duration || !Number.isFinite(current)) return false;
    const requestedDelta = Number(deltaSeconds || 0);
    const target = Math.max(0, Math.min(duration, current + requestedDelta));
    const actualDelta = target - current;
    player.currentTime = target;
    syncActiveControlBar();
    showKeyboardSeekFeedback(player.closest(".short-video-stage"), requestedDelta, actualDelta, target, duration);
    return true;
  }

  function showKeyboardSeekFeedback(stage, requestedDelta, actualDelta, target, duration) {
    if (!stage) return;
    stage.querySelector(".short-video-keyboard-seek-feedback")?.remove();
    const feedback = document.createElement("div");
    feedback.className = `short-video-keyboard-seek-feedback${requestedDelta > 0 ? " is-forward" : " is-backward"}`;
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    const icon = createIcon("chevronLeft");
    const copy = document.createElement("span");
    const label = document.createElement("strong");
    if (Math.abs(actualDelta) < .1) label.textContent = requestedDelta > 0 ? "已到结尾" : "已到开头";
    else label.textContent = requestedDelta > 0 ? "快进 5 秒" : "快退 5 秒";
    const position = document.createElement("small");
    position.textContent = `${formatSeconds(target)} / ${formatSeconds(duration)}`;
    copy.append(label, position);
    feedback.append(icon, copy);
    stage.append(feedback);
    window.setTimeout(() => feedback.remove(), 820);
  }

  function toggleActivePlayer() {
    const gallery = activeGalleryPlayer();
    if (gallery && isGalleryPost(state.shortVideo?.current)) {
      gallery.shortVideoGalleryTogglePlayback?.();
      syncActiveControlBar();
      return;
    }
    const player = activePlayer();
    if (!player) return;
    if (player.paused) player.play().catch(() => {}).finally(syncActiveControlBar);
    else {
      player.pause();
      syncActiveControlBar();
    }
    clearPlayerSoundBlocked(player.closest(".short-video-stage"));
  }

  function currentShortVideoVolume() {
    return normalizeShortVideoVolume(state.shortVideo?.volume ?? readVolumePreference());
  }

  function setActiveShortVideoVolume(percent) {
    const player = activePlayer();
    if (!player) return;
    const wasPlaying = !player.paused && !player.ended;
    const rawPercent = Math.max(0, Math.min(100, Number(percent || 0)));
    if (rawPercent <= 0) {
      player.muted = true;
      state.shortVideo.muted = true;
      writeMutedPreference(true);
    } else {
      const volume = normalizeShortVideoVolume(rawPercent / 100);
      state.shortVideo.volume = volume;
      state.shortVideo.muted = false;
      writeVolumePreference(volume);
      writeMutedPreference(false);
      player.volume = volume;
      player.muted = false;
      if (wasPlaying) player.play?.().catch(() => {});
    }
    clearPlayerSoundBlocked(player.closest(".short-video-stage"));
  }

  function toggleActiveMute() {
    const player = activePlayer();
    if (!player) return;
    const wasPlaying = !player.paused && !player.ended;
    player.muted = !player.muted;
    if (!player.muted) player.volume = currentShortVideoVolume();
    state.shortVideo.muted = player.muted;
    writeMutedPreference(player.muted);
    clearPlayerSoundBlocked(player.closest(".short-video-stage"));
    if (wasPlaying && !player.muted) {
      player.play?.().catch(() => {
        player.muted = true;
        state.shortVideo.muted = true;
        writeMutedPreference(true);
        player.play?.().catch(() => {});
      });
    }
    syncActiveControlBar();
  }

  function toggleClearScreen() {
    const browser = els.workGrid?.querySelector?.(".short-video-browser");
    if (!browser) return;
    closeTransientPlayerControls();
    const cleared = browser.classList.toggle("is-clear-screen");
    delete browser.dataset.shortVideoClearScreenRevealAt;
    if (cleared) {
      const touchPrimary = window.matchMedia?.("(pointer: coarse)")?.matches;
      showBrowserToast(touchPrimary ? "轻触画面恢复操作界面" : "按 J 或 Esc 恢复操作界面");
      return;
    }
    browser.shortVideoRevealControls?.(1900);
    showBrowserToast("已恢复操作界面");
  }

  function revealShortVideoClearScreen(target) {
    const browser = target?.closest?.(".short-video-browser");
    if (!browser?.classList.contains("is-clear-screen")) return false;
    browser.classList.remove("is-clear-screen");
    browser.dataset.shortVideoClearScreenRevealAt = String(Date.now());
    browser.shortVideoRevealControls?.(1900);
    showBrowserToast("已恢复操作界面");
    return true;
  }

  function wasClearScreenJustRevealed(target) {
    const browser = target?.closest?.(".short-video-browser");
    const revealedAt = Number(browser?.dataset?.shortVideoClearScreenRevealAt || 0);
    if (!revealedAt) return false;
    if (Date.now() - revealedAt <= SHORT_VIDEO_DOUBLE_TAP_WINDOW_MS + 120) return true;
    delete browser.dataset.shortVideoClearScreenRevealAt;
    return false;
  }

  function closeOrRevealBrowser() {
    const browser = els.workGrid?.querySelector?.(".short-video-browser");
    const playbackSettings = browser?.querySelector?.(".short-video-more-overlay");
    if (playbackSettings) {
      closePlaybackSettings(playbackSettings);
      return;
    }
    const authorPanel = browser?.querySelector?.(".short-video-author-panel");
    if (authorPanel) {
      closeAuthorPanel(authorPanel);
      return;
    }
    if (browser?.classList.contains("is-clear-screen")) {
      browser.classList.remove("is-clear-screen");
      browser.shortVideoRevealControls?.(1900);
      showBrowserToast("已恢复操作界面");
      return;
    }
    showHome();
  }

  function isShortVideoOverlayTarget(target) {
    return Boolean(target?.closest?.(".short-video-author-sheet, .short-video-share-panel, .short-video-more-overlay"));
  }

  function showHeartBurst(stage, event) {
    const heart = document.createElement("span");
    heart.className = "short-video-heart-burst";
    heart.append(createIcon("heart"));
    const rect = stage.getBoundingClientRect();
    heart.style.left = `${Math.max(28, Math.min(rect.width - 28, (event.clientX || rect.left + rect.width / 2) - rect.left))}px`;
    heart.style.top = `${Math.max(28, Math.min(rect.height - 28, (event.clientY || rect.top + rect.height / 2) - rect.top))}px`;
    stage.append(heart);
    heart.addEventListener("animationend", () => heart.remove(), { once: true });
  }

  function rememberShortVideo(video) {
    const id = String(video?.id || "").trim();
    if (!id) return null;
    shortVideoVideoCache.delete(id);
    shortVideoVideoCache.set(id, video);
    while (shortVideoVideoCache.size > SHORT_VIDEO_NAV_CACHE_LIMIT) {
      shortVideoVideoCache.delete(shortVideoVideoCache.keys().next().value);
    }
    return video;
  }

  function cachedShortVideo(id) {
    const key = String(id || "").trim();
    if (!key) return null;
    return cachedAuthorPanelVideo(key) || shortVideoVideoCache.get(key) || null;
  }

  function shortVideoNavigationKey(id, params = shortVideoFeedParams()) {
    const videoId = String(id || "").trim();
    return videoId ? `${params}::${videoId}` : "";
  }

  function cachedShortVideoNavigation(id, params = shortVideoFeedParams()) {
    const key = shortVideoNavigationKey(id, params);
    return key ? shortVideoNavigationCache.get(key) || null : null;
  }

  function rememberShortVideoNavigation(data, params = shortVideoFeedParams()) {
    const current = data?.video;
    const currentId = String(current?.id || "").trim();
    if (!currentId) return;
    const previous = Array.isArray(data?.neighbors?.previous) ? data.neighbors.previous.filter((video) => video?.id) : [];
    const next = Array.isArray(data?.neighbors?.next) ? data.neighbors.next.filter((video) => video?.id) : [];
    previous.forEach(rememberShortVideo);
    rememberShortVideo(current);
    next.forEach(rememberShortVideo);
    const chain = [...previous].reverse().concat(current, next);
    chain.forEach((video, index) => {
      const id = String(video?.id || "").trim();
      const key = shortVideoNavigationKey(id, params);
      if (!key) return;
      const navigation = { ...(shortVideoNavigationCache.get(key) || {}) };
      if (index > 0) navigation.prevId = String(chain[index - 1]?.id || "");
      if (index < chain.length - 1) navigation.nextId = String(chain[index + 1]?.id || "");
      if (id === currentId) {
        navigation.prevId = String(data.prevId || "");
        navigation.nextId = String(data.nextId || "");
      }
      shortVideoNavigationCache.delete(key);
      shortVideoNavigationCache.set(key, navigation);
    });
    while (shortVideoNavigationCache.size > SHORT_VIDEO_NEIGHBOR_CACHE_LIMIT) {
      shortVideoNavigationCache.delete(shortVideoNavigationCache.keys().next().value);
    }
  }

  function fetchShortVideoDetail(videoId, params = shortVideoFeedParams()) {
    const id = String(videoId || "").trim();
    if (!id) return Promise.resolve(null);
    const cacheKey = `${params}::${id}`;
    const cached = shortVideoDetailCache.get(cacheKey);
    if (cached) return cached;
    const detailParams = new URLSearchParams(params);
    detailParams.set("neighbors", String(SHORT_VIDEO_DETAIL_NEIGHBOR_LIMIT));
    detailParams.set("metadata", "0");
    const request = api(`/api/short-videos/${encodeURIComponent(id)}?${detailParams}`).then((data) => {
      rememberShortVideoNavigation(data, params);
      shortVideoResolvedDetailCache.delete(cacheKey);
      shortVideoResolvedDetailCache.set(cacheKey, data);
      while (shortVideoResolvedDetailCache.size > SHORT_VIDEO_NAV_CACHE_LIMIT) {
        shortVideoResolvedDetailCache.delete(shortVideoResolvedDetailCache.keys().next().value);
      }
      return data;
    }).catch((error) => {
      shortVideoDetailCache.delete(cacheKey);
      shortVideoResolvedDetailCache.delete(cacheKey);
      throw error;
    });
    shortVideoDetailCache.set(cacheKey, request);
    while (shortVideoDetailCache.size > SHORT_VIDEO_NAV_CACHE_LIMIT) {
      shortVideoDetailCache.delete(shortVideoDetailCache.keys().next().value);
    }
    return request;
  }

  function resolvedShortVideoDetail(videoId, params = shortVideoFeedParams()) {
    const id = String(videoId || "").trim();
    if (!id) return null;
    return shortVideoResolvedDetailCache.get(`${params}::${id}`) || null;
  }

  function prefetchShortVideoFirstMedia(video = {}) {
    const galleryEntry = isGalleryPost(video) ? galleryImageEntries(video)[0] : null;
    const url = String(galleryEntry?.url || shortVideoCardCoverUrl(video) || "").trim();
    if (!url || shortVideoMediaPrefetches.has(url)) return shortVideoMediaPrefetches.get(url)?.promise || Promise.resolve(false);
    const image = new Image();
    image.decoding = "async";
    image.fetchPriority = "low";
    const promise = new Promise((resolve) => {
      const finish = (ready) => resolve(Boolean(ready));
      image.addEventListener("load", () => finish(true), { once: true });
      image.addEventListener("error", () => finish(false), { once: true });
      image.src = url;
      if (image.complete && image.naturalWidth) Promise.resolve().then(() => finish(true));
    });
    shortVideoMediaPrefetches.set(url, { image, promise });
    while (shortVideoMediaPrefetches.size > 18) {
      shortVideoMediaPrefetches.delete(shortVideoMediaPrefetches.keys().next().value);
    }
    return promise;
  }

  async function prefetchRelatedVideo(video = {}) {
    const videoId = String(video?.id || "").trim();
    if (!videoId) return null;
    const params = shortVideoFeedParams();
    const cached = resolvedShortVideoDetail(videoId, params);
    if (cached?.video) {
      prefetchShortVideoFirstMedia(cached.video).catch(() => {});
      return cached;
    }
    const detail = await fetchShortVideoDetail(videoId, params);
    if (detail?.video) {
      cacheAuthorPanelVideo(detail.video);
      await prefetchShortVideoFirstMedia(detail.video).catch(() => false);
    }
    return detail;
  }

  function scheduleAdjacentNavigationPrefetch() {
    window.clearTimeout(shortVideoNavigationPrefetchTimer);
    const params = shortVideoFeedParams();
    const candidates = [
      { direction: 1, video: state.shortVideo?.nextVideo },
      { direction: -1, video: state.shortVideo?.prevVideo }
    ].filter((item) => item.video?.id);
    if (!candidates.length) return;
    shortVideoNavigationPrefetchTimer = window.setTimeout(() => {
      candidates.forEach((item, index) => {
        window.setTimeout(() => {
          prefetchAdjacentNavigation(item.video, item.direction, params).catch(() => {});
        }, index * 120);
      });
    }, 60);
  }

  async function prefetchAdjacentNavigation(video, direction, params) {
    const videoId = String(video?.id || "").trim();
    if (!videoId) return;
    rememberShortVideo(video);
    const detail = await fetchShortVideoDetail(videoId, params);
    const farId = String(direction > 0 ? detail?.nextId || "" : detail?.prevId || "").trim();
    if (!farId || cachedShortVideo(farId) || shortVideoVideoPrefetches.has(farId)) return;
    const request = api(`/api/short-videos/${encodeURIComponent(videoId)}/adjacent?direction=${direction > 0 ? "next" : "prev"}&${params}`)
      .then((data) => rememberShortVideo(data?.video))
      .finally(() => shortVideoVideoPrefetches.delete(farId));
    shortVideoVideoPrefetches.set(farId, request);
    await request;
  }

  async function loadAdjacentVideos(videoId) {
    const requestId = ++shortVideoAdjacentRequestId;
    const prevId = state.shortVideo.prevId;
    const nextId = state.shortVideo.nextId;
    const params = shortVideoFeedParams();
    const knownPrev = String(state.shortVideo.prevVideo?.id || "") === String(prevId || "")
      ? state.shortVideo.prevVideo
      : cachedShortVideo(prevId);
    const knownNext = String(state.shortVideo.nextVideo?.id || "") === String(nextId || "")
      ? state.shortVideo.nextVideo
      : cachedShortVideo(nextId);
    const loadAdjacent = (id, known, direction) => {
      if (!id) return Promise.resolve(null);
      if (known) return Promise.resolve({ video: known });
      const prefetched = shortVideoVideoPrefetches.get(String(id));
      if (prefetched) {
        return prefetched
          .then((video) => video ? { video } : null)
          .catch(() => api(`/api/short-videos/${encodeURIComponent(videoId)}/adjacent?direction=${direction}&${params}`));
      }
      return api(`/api/short-videos/${encodeURIComponent(videoId)}/adjacent?direction=${direction}&${params}`);
    };
    const [prevResult, nextResult] = await Promise.allSettled([
      loadAdjacent(prevId, knownPrev, "prev"),
      loadAdjacent(nextId, knownNext, "next")
    ]);
    if (requestId !== shortVideoAdjacentRequestId || state.shortVideo.current?.id !== videoId) return false;
    state.shortVideo.prevVideo = prevResult.status === "fulfilled" ? prevResult.value?.video || null : null;
    state.shortVideo.nextVideo = nextResult.status === "fulfilled" ? nextResult.value?.video || null : null;
    rememberShortVideo(state.shortVideo.prevVideo);
    rememberShortVideo(state.shortVideo.nextVideo);
    cacheAuthorPanelVideo(state.shortVideo.prevVideo);
    cacheAuthorPanelVideo(state.shortVideo.nextVideo);
    scheduleAdjacentNavigationPrefetch();
    return true;
  }

  function shortVideoFeedParams() {
    const params = new URLSearchParams();
    if (state.shortVideo.query) params.set("q", state.shortVideo.query);
    if (state.shortVideo.topic) params.set("topic", state.shortVideo.topic);
    if (state.shortVideo.sound) params.set("sound", state.shortVideo.sound);
    if (state.shortVideo.author && state.shortVideo.author !== "all") params.set("author", state.shortVideo.author);
    if (state.shortVideo.media && state.shortVideo.media !== "all") params.set("media", state.shortVideo.media);
    params.set("source", shortVideoApiSource());
    params.set("sort", state.shortVideo.sort || "published");
    return params.toString();
  }

  function activeReelStack() {
    return els.workGrid?.querySelector?.(".short-video-reel-stack") || null;
  }

  function isHorizontalSwipe(deltaX, deltaY, threshold) {
    return Math.abs(deltaX) >= threshold && Math.abs(deltaX) > Math.abs(deltaY) * 1.25;
  }

  function handleHorizontalSwipe(deltaX) {
    if (isGalleryPost(state.shortVideo?.current) && stepActiveGallery(deltaX < 0 ? 1 : -1)) return;
    if (deltaX < 0) {
      closeOrRevealBrowser();
      return;
    }
    if (isViewingAuthorFeed()) return;
    openShortVideoAuthorPage(state.shortVideo?.current?.author, state.shortVideo?.current);
  }

  function isViewingAuthorFeed() {
    return Boolean(state.shortVideo?.author && state.shortVideo.author !== "all");
  }

  function applyDragDelta(deltaY) {
    const hasTarget = deltaY < 0 ? Boolean(state.shortVideo.nextId) : Boolean(state.shortVideo.prevId);
    const stack = activeReelStack();
    if (!stack) return;
    clearBoundaryPulse(stack);
    window.clearTimeout(reelBoundaryResetTimer);
    reelBoundaryResetTimer = 0;
    stack.classList.remove("is-boundary-rebounding");
    stack.classList.toggle("is-boundary-start", !hasTarget && deltaY > 0);
    stack.classList.toggle("is-boundary-end", !hasTarget && deltaY < 0);
    const distance = Math.abs(deltaY);
    const resistedDistance = distance * SHORT_VIDEO_BOUNDARY_RESISTANCE / (1 + distance / SHORT_VIDEO_BOUNDARY_RANGE);
    const damped = hasTarget ? deltaY : Math.sign(deltaY) * resistedDistance;
    stack.style.setProperty("--short-video-drag-y", `${damped}px`);
  }

  function scheduleReelDragDelta(deltaY) {
    reelDragDeltaY = deltaY;
    if (reelDragRaf) return;
    reelDragRaf = window.requestAnimationFrame(() => {
      reelDragRaf = 0;
      applyDragDelta(reelDragDeltaY);
    });
  }

  function flushReelDragDelta() {
    if (reelDragRaf) window.cancelAnimationFrame(reelDragRaf);
    reelDragRaf = 0;
    applyDragDelta(reelDragDeltaY);
  }

  function cancelReelDragDelta() {
    if (reelDragRaf) window.cancelAnimationFrame(reelDragRaf);
    reelDragRaf = 0;
    reelDragDeltaY = 0;
  }

  function handleWheelSwipe(deltaY) {
    const now = Date.now();
    if (Math.abs(deltaY) < 2) return;
    const previousWheelAt = wheelLastAt;
    wheelLastAt = now;
    const gestureAge = wheelGestureStartedAt ? now - wheelGestureStartedAt : 0;
    const isExplicitNewGesture = Math.abs(deltaY) >= 70
      && (now - previousWheelAt >= WHEEL_NEW_GESTURE_GAP_MS || gestureAge >= 400);
    if (wheelLocked && now >= wheelIgnoreUntil && isExplicitNewGesture) {
      queuedAdjacentDirection = deltaY > 0 ? 1 : -1;
      wheelGestureConsumed = true;
      wheelGestureStartedAt = now;
      scheduleWheelGestureRelease();
      return;
    }
    const startsExplicitNewGesture = wheelGestureConsumed
      && !wheelLocked
      && now >= wheelIgnoreUntil
      && isExplicitNewGesture;
    if (startsExplicitNewGesture) {
      wheelGestureConsumed = false;
      wheelDeltaY = 0;
    }
    if (wheelLocked || wheelGestureConsumed || now < wheelIgnoreUntil) {
      wheelGestureConsumed = true;
      wheelDeltaY = 0;
      cancelReelDragDelta();
      scheduleWheelGestureRelease();
      return;
    }
    if (now - previousWheelAt > 260 || Math.sign(wheelDeltaY) !== Math.sign(deltaY)) {
      wheelDeltaY = 0;
    }
    wheelDeltaY = Math.max(-180, Math.min(180, wheelDeltaY + deltaY));
    const visualDelta = wheelDeltaY * -0.55;
    activeReelStack()?.classList.add("is-dragging");
    scheduleReelDragDelta(visualDelta);
    window.clearTimeout(wheelResetTimer);
    wheelResetTimer = window.setTimeout(() => {
      wheelDeltaY = 0;
      snapStackBack();
    }, 160);
    if (Math.abs(wheelDeltaY) < SHORT_VIDEO_WHEEL_DISTANCE) return;
    const direction = wheelDeltaY > 0 ? 1 : -1;
    const wheelMotion = {
      dragDistance: Math.abs(visualDelta),
      velocity: Math.min(1.4, Math.abs(deltaY) / 80)
    };
    wheelDeltaY = 0;
    wheelGestureConsumed = true;
    wheelGestureStartedAt = now;
    flushReelDragDelta();
    scheduleWheelGestureRelease();
    activeReelStack()?.classList.remove("is-dragging");
    openAdjacent(direction, { motion: wheelMotion }).catch(showError);
  }

  function scheduleWheelGestureRelease() {
    window.clearTimeout(wheelResetTimer);
    if (!wheelGestureConsumed) return;
    const idleFor = Date.now() - wheelLastAt;
    if (!wheelLocked && idleFor >= WHEEL_GESTURE_IDLE_MS) {
      wheelGestureConsumed = false;
      wheelGestureStartedAt = 0;
      wheelDeltaY = 0;
      snapStackBack();
      return;
    }
    const delay = Math.max(16, WHEEL_GESTURE_IDLE_MS - idleFor);
    wheelResetTimer = window.setTimeout(() => {
      if (wheelLocked) return;
      const remaining = WHEEL_GESTURE_IDLE_MS - (Date.now() - wheelLastAt);
      if (remaining > 0) {
        scheduleWheelGestureRelease();
        return;
      }
      wheelGestureConsumed = false;
      wheelGestureStartedAt = 0;
      wheelDeltaY = 0;
      snapStackBack();
    }, delay);
  }

  function finishDrag(deltaY, velocityY = 0) {
    flushReelDragDelta();
    const fastFlick = Math.abs(deltaY) >= 18 && Math.abs(velocityY) >= .32;
    const directionSignal = Math.abs(deltaY) >= 18 ? deltaY : velocityY * 80;
    const direction = directionSignal < 0 ? 1 : -1;
    state.shortVideo.dragging = false;
    activeReelStack()?.classList.remove("is-dragging");
    if ((!fastFlick && Math.abs(deltaY) < SHORT_VIDEO_SWIPE_DISTANCE) || (direction > 0 && !state.shortVideo.nextId) || (direction < 0 && !state.shortVideo.prevId)) {
      snapStackBack();
      return;
    }
    openAdjacent(direction, {
      motion: {
        dragDistance: Math.abs(deltaY),
        velocity: Math.abs(velocityY)
      }
    }).catch(showError);
  }

  function snapStackBack() {
    cancelReelDragDelta();
    const stack = activeReelStack();
    if (!stack) return;
    clearBoundaryPulse(stack);
    window.clearTimeout(reelBoundaryResetTimer);
    reelBoundaryResetTimer = 0;
    const boundaryRebound = stack.classList.contains("is-boundary-start") || stack.classList.contains("is-boundary-end");
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev", "is-rebasing", "is-boundary-start", "is-boundary-end");
    stack.classList.toggle("is-boundary-rebounding", boundaryRebound);
    stack.style.setProperty("--short-video-drag-y", "0px");
    if (boundaryRebound) {
      reelBoundaryResetTimer = window.setTimeout(() => {
        reelBoundaryResetTimer = 0;
        stack.classList.remove("is-boundary-rebounding");
      }, 360);
    }
  }

  function clearBoundaryPulse(stack = activeReelStack()) {
    if (reelBoundaryPulseRaf) window.cancelAnimationFrame(reelBoundaryPulseRaf);
    if (reelBoundaryPulseTimer) window.clearTimeout(reelBoundaryPulseTimer);
    reelBoundaryPulseRaf = 0;
    reelBoundaryPulseTimer = 0;
    stack?.classList.remove("is-boundary-pulse-start", "is-boundary-pulse-end");
  }

  function pulseBoundaryStack(direction) {
    cancelReelDragDelta();
    const stack = activeReelStack();
    if (!stack) return;
    clearBoundaryPulse(stack);
    window.clearTimeout(reelBoundaryResetTimer);
    reelBoundaryResetTimer = 0;
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev", "is-rebasing", "is-boundary-start", "is-boundary-end", "is-boundary-rebounding");
    stack.style.setProperty("--short-video-drag-y", "0px");
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    reelBoundaryPulseRaf = window.requestAnimationFrame(() => {
      reelBoundaryPulseRaf = 0;
      const className = direction < 0 ? "is-boundary-pulse-start" : "is-boundary-pulse-end";
      stack.classList.add(className);
      reelBoundaryPulseTimer = window.setTimeout(() => {
        reelBoundaryPulseTimer = 0;
        stack.classList.remove(className);
      }, 340);
    });
  }

  function resolveSwitchAnimationDuration(motion = {}) {
    const dragDistance = Math.max(0, Number(motion?.dragDistance || 0));
    const velocity = Math.max(0, Number(motion?.velocity || 0));
    if (!dragDistance && !velocity) return SHORT_VIDEO_SWITCH_ANIMATION_MS;
    const viewportHeight = Math.max(1, Number(window.innerHeight || 720));
    const remainingRatio = 1 - Math.min(1, dragDistance / viewportHeight);
    const velocityRatio = Math.min(1, velocity / 1.4);
    const duration = SHORT_VIDEO_SWITCH_MIN_ANIMATION_MS
      + remainingRatio * (SHORT_VIDEO_SWITCH_ANIMATION_MS - SHORT_VIDEO_SWITCH_MIN_ANIMATION_MS)
      - velocityRatio * 28;
    return Math.round(Math.max(
      SHORT_VIDEO_SWITCH_MIN_ANIMATION_MS,
      Math.min(SHORT_VIDEO_SWITCH_MAX_ANIMATION_MS, duration)
    ));
  }

  function animateActiveStack(direction, motion = {}) {
    const stack = activeReelStack();
    if (!stack) return Promise.resolve();
    const duration = resolveSwitchAnimationDuration(motion);
    clearBoundaryPulse(stack);
    window.clearTimeout(reelBoundaryResetTimer);
    reelBoundaryResetTimer = 0;
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev", "is-boundary-start", "is-boundary-end", "is-boundary-rebounding");
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      stack.classList.add(direction > 0 ? "is-snap-next" : "is-snap-prev");
      stack.style.setProperty("--short-video-drag-y", "0px");
      return Promise.resolve();
    }
    stack.style.setProperty("--short-video-switch-duration", `${duration}ms`);
    return new Promise((resolve) => {
      let done = false;
      let animationFrame = 0;
      let timeoutHandle = 0;
      const finish = () => {
        if (done) return;
        done = true;
        if (animationFrame) window.cancelAnimationFrame(animationFrame);
        if (timeoutHandle) window.clearTimeout(timeoutHandle);
        stack.removeEventListener("transitionend", handleTransitionEnd);
        stack.style.removeProperty("--short-video-switch-duration");
        resolve();
      };
      const handleTransitionEnd = (event) => {
        if (event.propertyName !== "transform") return;
        finish();
      };
      stack.addEventListener("transitionend", handleTransitionEnd);
      timeoutHandle = window.setTimeout(finish, duration + 70);
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        if (done) return;
        stack.classList.add(direction > 0 ? "is-snap-next" : "is-snap-prev");
        stack.style.setProperty("--short-video-drag-y", "0px");
      });
    });
  }

  function railMetric(icon, value, kind = "", label = "", action = null) {
    const metric = Math.max(0, Number(value || 0));
    const metricLabel = formatCompact(metric);
    const button = railButton(metricLabel, createIcon(icon), kind, label ? `${label}，${metricLabel}` : metricLabel, action);
    button.dataset.actionLabel = label;
    button.dataset.metricValue = String(metric);
    if (label) button.title = label;
    return button;
  }

  function resolveRailActionButton(target, actionType) {
    const selector = `.short-video-rail-button.is-${actionType === "like" ? "like" : "collect"}`;
    return target?.matches?.(selector) ? target : target?.querySelector?.(selector) || null;
  }

  function applyRailActionButtonState(button, actionType, active, metricValue) {
    if (!button) return;
    const enabled = Boolean(active);
    const metric = Math.max(0, Number(metricValue || 0));
    const previousMetric = Number(button.dataset.metricValue);
    button.classList.toggle(actionType === "like" ? "is-liked" : "is-active", enabled);
    button.dataset.metricValue = String(metric);
    button.setAttribute("aria-pressed", String(enabled));
    const label = actionType === "like"
      ? (enabled ? "取消点赞" : "点赞")
      : (enabled ? "取消收藏" : "收藏");
    button.dataset.actionLabel = label;
    button.setAttribute("aria-label", `${label}，${formatCompact(metric)}`);
    button.title = label;
    const valueLabel = button.querySelector(":scope > span");
    if (valueLabel) {
      valueLabel.textContent = formatCompact(metric);
      if (Number.isFinite(previousMetric) && previousMetric !== metric) {
        valueLabel.classList.remove("is-metric-up", "is-metric-down");
        valueLabel.getBoundingClientRect();
        valueLabel.classList.add(metric > previousMetric ? "is-metric-up" : "is-metric-down");
        window.clearTimeout(button._railMetricTimer);
        button._railMetricTimer = window.setTimeout(() => {
          valueLabel.classList.remove("is-metric-up", "is-metric-down");
          button._railMetricTimer = 0;
        }, 380);
      }
    }
  }

  function animateRailActionButton(button, active) {
    if (!button || window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return;
    button.classList.remove("is-action-pulse", "is-action-release");
    button.getBoundingClientRect();
    const className = active ? "is-action-pulse" : "is-action-release";
    button.classList.add(className);
    window.setTimeout(() => button.classList.remove(className), 460);
  }

  async function toggleShortVideoAction(video, actionType, target, options = {}) {
    const type = actionType === "collect" ? "collect" : "like";
    const button = resolveRailActionButton(target, type);
    const videoId = String(video?.id || button?.dataset?.videoId || "").trim();
    if (!button || !videoId || button.getAttribute("aria-busy") === "true") return;
    const activeClass = type === "like" ? "is-liked" : "is-active";
    const wasActive = button.classList.contains(activeClass);
    const nextActive = typeof options.forceActive === "boolean" ? options.forceActive : !wasActive;
    if (nextActive === wasActive) return;
    const previousMetric = Math.max(0, Number(button.dataset.metricValue || 0));
    const optimisticMetric = Math.max(0, previousMetric + (nextActive ? 1 : -1));
    applyRailActionButtonState(button, type, nextActive, optimisticMetric);
    animateRailActionButton(button, nextActive);
    button.setAttribute("aria-busy", "true");
    try {
      const data = await api(`/api/short-videos/${encodeURIComponent(videoId)}/actions/${type}`, {
        method: "PUT",
        body: { active: nextActive }
      });
      const updated = data.video || null;
      if (updated) {
        syncShortVideoActionVideo(updated);
        syncShortVideoActionButtons(updated, type);
      } else {
        applyRailActionButtonState(button, type, Boolean(data.active), optimisticMetric);
      }
      if (!options.silent) {
        showBrowserToast(type === "like"
          ? (nextActive ? "已点赞" : "已取消点赞")
          : (nextActive ? "已收藏" : "已取消收藏"));
      }
    } catch (error) {
      console.warn(error);
      applyRailActionButtonState(button, type, wasActive, previousMetric);
      showBrowserToast(type === "like" ? "点赞状态保存失败" : "收藏状态保存失败");
    } finally {
      button.removeAttribute("aria-busy");
    }
  }

  function syncShortVideoActionVideo(updated) {
    if (!updated?.id) return;
    const candidates = [
      state.shortVideo?.current,
      state.shortVideo?.prevVideo,
      state.shortVideo?.nextVideo,
      ...(state.shortVideo?.data?.videos || [])
    ];
    for (const item of candidates) {
      if (!item || !isCurrentShortVideo(updated, item)) continue;
      item.stats = { ...(item.stats || {}), ...(updated.stats || {}) };
      item.actions = { ...(item.actions || {}), ...(updated.actions || {}) };
    }
  }

  function syncShortVideoActionButtons(video, actionType) {
    const type = actionType === "collect" ? "collect" : "like";
    const active = type === "like" ? Boolean(video.actions?.liked) : Boolean(video.actions?.collected);
    const metric = type === "like" ? video.stats?.likes : video.stats?.collects;
    const buttons = els.workGrid?.querySelectorAll?.(`.short-video-rail-button.is-${type === "like" ? "like" : "collect"}`) || [];
    for (const button of buttons) {
      if (String(button.dataset.videoId || "") !== String(video.id || "")) continue;
      applyRailActionButtonState(button, type, active, metric);
    }
  }

  async function toggleShortVideoDislike(video, active = !Boolean(video?.actions?.disliked)) {
    const videoId = String(video?.id || "").trim();
    if (!videoId) return false;
    try {
      const data = await api(`/api/short-videos/${encodeURIComponent(videoId)}/actions/dislike`, {
        method: "PUT",
        body: { active: Boolean(active) }
      });
      const updated = data.video || null;
      if (updated) syncShortVideoActionVideo(updated);
      const disliked = updated ? Boolean(updated.actions?.disliked) : Boolean(data.active);
      showBrowserToast(disliked ? "已减少此类推荐" : "已撤销不感兴趣");
      return disliked;
    } catch (error) {
      console.warn(error);
      showBrowserToast("推荐反馈保存失败");
      return false;
    }
  }

  function authorFollowTargetId(video = {}, author = video?.author || {}) {
    return String(author?.id || video?.ownerUserId || "").trim();
  }

  function authorFollowKey(video = {}, author = video?.author || {}) {
    return authorFollowTargetId(video, author) || String(author?.secUid || "").trim();
  }

  function sameShortVideoAuthor(leftVideo = {}, rightVideo = {}) {
    const leftTarget = authorFollowTargetId(leftVideo, leftVideo?.author);
    const rightTarget = authorFollowTargetId(rightVideo, rightVideo?.author);
    if (leftTarget && rightTarget) return leftTarget === rightTarget;
    const leftSecUid = String(leftVideo?.author?.secUid || "").trim();
    const rightSecUid = String(rightVideo?.author?.secUid || "").trim();
    return Boolean(leftSecUid && rightSecUid && leftSecUid === rightSecUid);
  }

  function createAuthorFollowButton(video, author = video?.author || {}, variant = "panel") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `short-video-follow-button is-${variant}`;
    button.dataset.authorFollowVariant = variant;
    button.dataset.authorFollowKey = authorFollowKey(video, author);
    applyAuthorFollowButtonState(button, Boolean(author?.following), author?.name || "作者");
    if (!video?.id || !authorFollowTargetId(video, author)) {
      button.disabled = true;
      button.setAttribute("aria-label", "当前作者无法关注");
      return button;
    }
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleAuthorFollow(video, author, button).catch(() => {});
    });
    return button;
  }

  function applyAuthorFollowButtonState(button, following, authorName = "作者") {
    if (!button) return;
    const active = Boolean(following);
    const variant = button.dataset.authorFollowVariant || "panel";
    button.classList.toggle("is-following", active);
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-label", `${active ? "取消关注" : "关注"} ${authorName}`);
    button.title = active ? `取消关注 ${authorName}` : `关注 ${authorName}`;
    if (variant === "rail") {
      button.replaceChildren(createIcon(active ? "check" : "plusBadge"));
      return;
    }
    button.textContent = active ? "已关注" : "+ 关注";
  }

  async function toggleAuthorFollow(video, author = video?.author || {}, button) {
    const videoId = String(video?.id || "").trim();
    if (!videoId || !button || button.getAttribute("aria-busy") === "true") return;
    const wasFollowing = button.classList.contains("is-following");
    const nextFollowing = !wasFollowing;
    applyAuthorFollowButtonState(button, nextFollowing, author?.name || "作者");
    button.setAttribute("aria-busy", "true");
    try {
      const data = await api(`/api/short-videos/${encodeURIComponent(videoId)}/author-follow`, {
        method: "PUT",
        body: { active: nextFollowing }
      });
      const updated = data.video || null;
      const following = updated ? Boolean(updated.author?.following) : Boolean(data.active);
      syncShortVideoAuthorFollow(updated || video, following);
      showBrowserToast(following ? `已关注 ${author?.name || "作者"}` : "已取消关注");
    } catch (error) {
      console.warn(error);
      applyAuthorFollowButtonState(button, wasFollowing, author?.name || "作者");
      showBrowserToast("关注状态保存失败");
    } finally {
      button.removeAttribute("aria-busy");
    }
  }

  function syncShortVideoAuthorFollow(updatedVideo, following) {
    if (!updatedVideo) return;
    const candidates = [
      state.shortVideo?.current,
      state.shortVideo?.prevVideo,
      state.shortVideo?.nextVideo,
      ...(state.shortVideo?.data?.videos || [])
    ];
    for (const item of candidates) {
      if (!item || !sameShortVideoAuthor(updatedVideo, item)) continue;
      item.author = { ...(item.author || {}), following: Boolean(following) };
    }
    const authorKey = authorFollowKey(updatedVideo, updatedVideo.author);
    for (const item of state.shortVideo?.authors || []) {
      if (authorFollowKey({}, item) !== authorKey) continue;
      item.following = Boolean(following);
    }
    if (state.shortVideo?.authorDetail && authorFollowKey({}, state.shortVideo.authorDetail) === authorKey) {
      state.shortVideo.authorDetail.following = Boolean(following);
    }
    const buttons = els.workGrid?.querySelectorAll?.("[data-author-follow-key]") || [];
    for (const followButton of buttons) {
      if (String(followButton.dataset.authorFollowKey || "") !== authorKey) continue;
      applyAuthorFollowButtonState(followButton, following, updatedVideo.author?.name || "作者");
    }
  }

  function originalDouyinUrl(video) {
    if (isGalleryPost(video)) {
      const galleryUrl = String(video?.originalUrl || video?.shareUrl || "").trim();
      if (galleryUrl) return galleryUrl;
      const galleryId = String(video?.awemeId || video?.id || "").trim();
      return /^\d{8,}$/.test(galleryId) ? `https://www.douyin.com/note/${galleryId}` : "";
    }
    const awemeId = String(video?.awemeId || video?.id || "").trim();
    if (/^\d{8,}$/.test(awemeId)) return `https://www.douyin.com/video/${awemeId}`;
    const url = String(video?.originalUrl || video?.shareUrl || "").trim();
    if (url) return url;
    return "";
  }

  function openDouyinLink(video) {
    const url = originalDouyinUrl(video);
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    showBrowserToast("当前是本地视频");
  }

  function shareShortVideo(video, options = {}) {
    showSharePanel(video, options);
  }

  async function copyShortVideoValue(value, message = "已复制链接") {
    const text = String(value || "").trim();
    if (!text) throw new Error("没有可复制的内容");
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await Promise.race([
            navigator.clipboard.writeText(text),
            new Promise((_, reject) => window.setTimeout(() => reject(new Error("clipboard timeout")), 800))
          ]);
        } catch {
          fallbackCopyText(text);
        }
      } else {
        fallbackCopyText(text);
      }
      showBrowserToast(message);
      return true;
    } catch (error) {
      showBrowserToast("复制失败，请手动选择链接");
      throw error;
    }
  }

  function localShortVideoUrl(video) {
    const id = String(video?.id || "").trim();
    const url = new URL(window.location.href);
    url.pathname = `/short-videos/${encodeURIComponent(id)}`;
    url.hash = "";
    return url.href;
  }

  function shortVideoShareText(video, url = localShortVideoUrl(video)) {
    const title = cardTitle(video) || "分享一个本地作品";
    const author = String(video?.author?.name || "").trim();
    return [title, author ? shortVideoAuthorHandle(author) : "", url].filter(Boolean).join("\n");
  }

  function bindShortVideoModalFocusLoop(overlay, sheet, closeModal) {
    if (!overlay || !sheet) return;
    const focusableSelector = [
      "button:not([disabled])",
      "a[href]",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "summary",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");
    const focusableItems = () => [...sheet.querySelectorAll(focusableSelector)].filter((element) => (
      !element.hidden
      && element.getAttribute("aria-hidden") !== "true"
      && element.getClientRects().length > 0
    ));
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeModal?.();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableItems();
      if (!items.length) {
        event.preventDefault();
        sheet.focus?.({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !sheet.contains(active))) {
        event.preventDefault();
        last.focus?.({ preventScroll: true });
      } else if (!event.shiftKey && (active === last || !sheet.contains(active))) {
        event.preventDefault();
        first.focus?.({ preventScroll: true });
      }
    });
  }

  function showPlaybackSettings(video = state.shortVideo?.current, options = {}) {
    const browser = els.workGrid?.querySelector?.(".short-video-browser");
    if (!browser) return;
    browser.querySelector(".short-video-more-overlay")?.remove();

    const overlay = document.createElement("div");
    overlay.className = "short-video-more-overlay";
    overlay._shortVideoReturnFocus = options.trigger || null;
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closePlaybackSettings(overlay);
    });

    const sheet = document.createElement("section");
    sheet.className = "short-video-more-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "short-video-playback-settings-title");
    sheet.tabIndex = -1;

    const header = document.createElement("header");
    header.className = "short-video-more-head";
    const headingWrap = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.textContent = "本地播放器";
    const heading = document.createElement("h2");
    heading.id = "short-video-playback-settings-title";
    heading.textContent = "更多功能";
    headingWrap.append(eyebrow, heading);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "short-video-more-close";
    close.append(createIcon("close"));
    close.setAttribute("aria-label", "关闭更多功能");
    close.addEventListener("click", () => closePlaybackSettings(overlay));
    header.append(headingWrap, close);

    const speedSection = document.createElement("section");
    speedSection.className = "short-video-speed-section";
    const speedHead = document.createElement("div");
    const speedTitle = document.createElement("strong");
    speedTitle.textContent = "播放速度";
    const speedCurrent = document.createElement("span");
    speedHead.append(speedTitle, speedCurrent);
    const speedGrid = document.createElement("div");
    speedGrid.className = "short-video-speed-grid";
    const speedButtons = new Map();
    const syncSpeedButtons = () => {
      const currentRate = normalizePlaybackRate(state.shortVideo?.playbackRate);
      speedCurrent.textContent = `当前 ${formatPlaybackRate(currentRate)}`;
      for (const [value, button] of speedButtons) {
        const active = value === currentRate;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      }
    };
    for (const value of PLAYBACK_RATES) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = formatPlaybackRate(value);
      button.addEventListener("click", () => {
        setPlaybackRate(value);
        syncSpeedButtons();
      });
      speedButtons.set(value, button);
      speedGrid.append(button);
    }
    speedSection.append(speedHead, speedGrid);

    const actions = document.createElement("div");
    actions.className = "short-video-more-actions is-primary-actions";
    const player = activePlayer();
    const pictureInPictureAvailable = Boolean(player?.requestPictureInPicture && document.pictureInPictureEnabled);
    const pictureInPictureActive = Boolean(player && document.pictureInPictureElement === player);
    const pip = playbackSettingsAction(
      pictureInPictureActive ? "退出画中画" : "画中画",
      pictureInPictureAvailable ? "悬浮在其他窗口上方" : "当前作品不支持",
      "pictureInPicture",
      async () => {
        if (!pictureInPictureAvailable) return;
        closePlaybackSettings(overlay, { restoreFocus: false });
        try {
          if (pictureInPictureActive) await document.exitPictureInPicture();
          else await player.requestPictureInPicture();
        } catch {
          showBrowserToast("画中画启动失败");
        }
      }
    );
    pip.disabled = !pictureInPictureAvailable;

    const fullscreen = playbackSettingsAction("全屏播放", "沉浸观看当前作品", "fullscreen", () => {
      closePlaybackSettings(overlay, { restoreFocus: false });
      toggleShortVideoFullscreen();
    });
    fullscreen.dataset.shortVideoFullscreenControl = "settings";
    syncShortVideoFullscreenControl(fullscreen);

    const autoNext = playbackSettingsAction("连播", "播完自动切换下一条", "repeat", () => {
      state.shortVideo.autoNext = !state.shortVideo.autoNext;
      writeAutoNextPreference(state.shortVideo.autoNext);
      syncActivePlaybackMode();
      autoNext.classList.toggle("active", state.shortVideo.autoNext);
      autoNext.setAttribute("aria-pressed", String(state.shortVideo.autoNext));
      autoNext.querySelector("small").textContent = state.shortVideo.autoNext ? "已开启，播完切换下一条" : "播完自动切换下一条";
      els.workGrid?.querySelector?.(".short-video-control-auto")?.classList.toggle("active", state.shortVideo.autoNext);
    });
    autoNext.classList.toggle("active", Boolean(state.shortVideo.autoNext));
    autoNext.setAttribute("aria-pressed", String(Boolean(state.shortVideo.autoNext)));
    if (state.shortVideo.autoNext) autoNext.querySelector("small").textContent = "已开启，播完切换下一条";

    const clearScreen = playbackSettingsAction("清屏播放", "快捷键 J，再按恢复", "clearScreen", () => {
      closePlaybackSettings(overlay, { restoreFocus: false });
      toggleClearScreen();
    });
    const copyLink = playbackSettingsAction("分享作品", "复制链接或打开系统分享", "link", () => {
      const returnFocus = overlay._shortVideoReturnFocus;
      closePlaybackSettings(overlay, { restoreFocus: false });
      shareShortVideo(video, { trigger: returnFocus });
    });
    const originalUrl = originalDouyinUrl(video);
    const original = playbackSettingsAction("抖音原视频", originalUrl ? "在新窗口打开" : "当前作品没有原始链接", "external", () => {
      closePlaybackSettings(overlay, { restoreFocus: false });
      openDouyinLink(video);
    });
    original.disabled = !originalUrl;
    const dislike = playbackSettingsAction(
      video?.actions?.disliked ? "撤销不感兴趣" : "不感兴趣",
      video?.actions?.disliked ? "重新允许出现在推荐中" : "减少此类内容推荐",
      "eyeOff",
      async () => {
        closePlaybackSettings(overlay, { restoreFocus: false });
        const disliked = await toggleShortVideoDislike(video);
        if (!disliked || state.shortVideo?.source !== "recommended" || !isCurrentShortVideo(video)) return;
        if (state.shortVideo.nextId) {
          openAdjacent(1).catch(showError);
          return;
        }
        state.shortVideo.current = null;
        state.shortVideo.data = null;
        loadVideos({ replaceRoute: true }).catch(showError);
      }
    );
    const deleteCurrent = playbackSettingsAction("删除作品", "删除本地记录与文件", "trash", () => {
      closePlaybackSettings(overlay, { restoreFocus: false });
      deleteShortVideo(video, { fromBrowser: true }).catch(showError);
    });
    deleteCurrent.classList.add("is-danger");
    const deleteGroup = playbackSettingsAction("删除同组", "清理同一文件夹作品", "folderTrash", () => {
      closePlaybackSettings(overlay, { restoreFocus: false });
      deleteShortVideo(video, { fromBrowser: true, scope: "group" }).catch(showError);
    });
    deleteGroup.classList.add("is-danger");
    const primarySection = document.createElement("section");
    primarySection.className = "short-video-more-section";
    const primaryTitle = document.createElement("strong");
    primaryTitle.textContent = "播放与分享";
    actions.append(pip, fullscreen, autoNext, clearScreen, copyLink, original);
    primarySection.append(primaryTitle, actions);

    const manageSection = document.createElement("section");
    manageSection.className = "short-video-more-section";
    const manageTitle = document.createElement("strong");
    manageTitle.textContent = "内容管理";
    const manageActions = document.createElement("div");
    manageActions.className = "short-video-more-actions is-manage-actions";
    manageActions.append(dislike, deleteCurrent, deleteGroup);
    manageSection.append(manageTitle, manageActions);

    const shortcuts = document.createElement("details");
    shortcuts.className = "short-video-shortcuts";
    const shortcutsSummary = document.createElement("summary");
    const shortcutsTitle = document.createElement("strong");
    shortcutsTitle.textContent = "快捷操作";
    const shortcutsHint = document.createElement("span");
    shortcutsHint.textContent = "键盘与手势";
    shortcutsSummary.append(shortcutsTitle, shortcutsHint);
    const shortcutGrid = document.createElement("div");
    for (const [key, label] of [
      ["Space", "播放 / 暂停"],
      ["M", "静音"],
      ["J", "清屏"],
      ["按住画面", "临时 2×，松开恢复"],
      ["←  →", "视频快退 / 快进 5 秒"],
      ["↑  ↓", "切换作品"],
      ["Esc", "关闭 / 返回"]
    ]) {
      const item = document.createElement("span");
      const keyboard = document.createElement("kbd");
      keyboard.textContent = key;
      item.append(keyboard, document.createTextNode(label));
      shortcutGrid.append(item);
    }
    shortcuts.append(shortcutsSummary, shortcutGrid);

    sheet.append(header, speedSection, primarySection, manageSection, shortcuts);
    overlay.append(sheet);
    browser.append(overlay);
    bindShortVideoModalFocusLoop(overlay, sheet, () => closePlaybackSettings(overlay));
    syncSpeedButtons();
    window.requestAnimationFrame(() => {
      const target = options.focusSpeed
        ? speedButtons.get(normalizePlaybackRate(state.shortVideo?.playbackRate))
        : close;
      target?.focus?.({ preventScroll: true });
    });
  }

  function playbackSettingsAction(label, description, icon, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-more-action";
    const visual = document.createElement("span");
    visual.append(createIcon(icon));
    const copy = document.createElement("span");
    const title = document.createElement("b");
    title.textContent = label;
    const detail = document.createElement("small");
    detail.textContent = description;
    copy.append(title, detail);
    button.append(visual, copy);
    button.addEventListener("click", action);
    return button;
  }

  function closePlaybackSettings(overlay, options = {}) {
    if (!overlay) return;
    const returnFocus = overlay._shortVideoReturnFocus;
    overlay.remove();
    if (options.restoreFocus === false) return;
    if (returnFocus?.isConnected) {
      returnFocus.focus?.({ preventScroll: true });
      window.requestAnimationFrame(() => {
        if (document.activeElement !== returnFocus && returnFocus.isConnected) {
          returnFocus.focus?.({ preventScroll: true });
        }
      });
    }
  }

  function setPlaybackRate(value) {
    const rate = normalizePlaybackRate(value);
    state.shortVideo.playbackRate = rate;
    writePlaybackRatePreference(rate);
    const players = els.workGrid?.querySelectorAll?.(
      ".short-video-player, .short-video-gallery-image[data-gallery-media-type='video']"
    ) || [];
    players.forEach((player) => {
      player.playbackRate = rate;
    });
    const controlRate = els.workGrid?.querySelector?.(".short-video-control-rate");
    if (controlRate) controlRate.textContent = formatPlaybackRate(rate);
    showBrowserToast(`已切换到 ${formatPlaybackRate(rate)}`);
  }

  async function deleteShortVideo(video, options = {}) {
    if (!video?.id) return;
    const title = cardTitle(video);
    const scope = options.scope === "group" ? "group" : "single";
    const prompt = scope === "group"
      ? `确定删除同组短视频吗？\n\n${title}\n\n会删除同一个本地文件夹下的短视频记录，以及这些记录引用且未被组外引用的本地文件。`
      : `确定删除这条短视频吗？\n\n${title}\n\n会删除资料库记录以及这条记录引用的本地视频文件。`;
    const ok = window.confirm(prompt);
    if (!ok) return;
    const deletingCurrent = state.shortVideo?.current?.id === video.id;
    const nextId = deletingCurrent ? state.shortVideo.nextId || "" : "";
    const prevId = deletingCurrent ? state.shortVideo.prevId || "" : "";
    const endpoint = `/api/short-videos/${encodeURIComponent(video.id)}${scope === "group" ? "?scope=group" : ""}`;
    const data = await api(endpoint, { method: "DELETE" });
    const deletedIds = new Set((Array.isArray(data.ids) && data.ids.length ? data.ids : [video.id]).map(String));
    for (const id of deletedIds) loadedCoverIds.delete(id);
    if (state.shortVideo.data?.videos) {
      state.shortVideo.data.videos = state.shortVideo.data.videos.filter((item) => !deletedIds.has(String(item.id || "")));
      state.shortVideo.data.total = Math.max(0, Number(state.shortVideo.data.total || 0) - deletedIds.size);
    }
    decrementCurrentAuthorCount(deletedIds.size);
    const message = scope === "group"
      ? `已删除 ${data.count || deletedIds.size} 条${data.deletedFiles?.length ? `，${data.deletedFiles.length} 个文件` : ""}`
      : `已删除${data.deletedFiles?.length ? ` ${data.deletedFiles.length} 个文件` : ""}`;
    if (deletingCurrent) {
      showBrowserToast(message);
      const fallbackId = [nextId, prevId].find((id) => id && !deletedIds.has(String(id)));
      if (fallbackId) {
        await openVideo(fallbackId);
      } else {
        state.shortVideo.data = null;
        showHome();
      }
      return;
    }
    state.shortVideo.data = null;
    await loadVideos({ replaceRoute: true });
    if (options.fromBrowser || scope === "group") showBrowserToast(message);
  }

  async function deleteSelectedShortVideos() {
    const selection = shortVideoDeleteSelection();
    const ids = [...selection].filter(Boolean);
    if (!ids.length) return;
    const ok = window.confirm(`确定删除选中的 ${ids.length} 条短视频吗？\n\n会删除资料库记录以及这些记录引用且未被其他记录引用的本地文件。`);
    if (!ok) return;
    const data = await api("/api/short-videos", {
      method: "DELETE",
      body: { ids }
    });
    const deletedIds = new Set((Array.isArray(data.ids) && data.ids.length ? data.ids : ids).map(String));
    for (const id of deletedIds) loadedCoverIds.delete(id);
    if (state.shortVideo.data?.videos) {
      state.shortVideo.data.videos = state.shortVideo.data.videos.filter((item) => !deletedIds.has(String(item.id || "")));
      state.shortVideo.data.total = Math.max(0, Number(state.shortVideo.data.total || 0) - deletedIds.size);
    }
    decrementCurrentAuthorCount(deletedIds.size);
    clearShortVideoDeleteSelection();
    state.shortVideo.data = null;
    await loadVideos({ replaceRoute: true });
    showBrowserToast(`已删除 ${data.count || deletedIds.size} 条${data.deletedFiles?.length ? `，${data.deletedFiles.length} 个文件` : ""}`);
  }

  function decrementCurrentAuthorCount(value) {
    if (!isShortVideoAuthorDetailPage()) return;
    const amount = Math.max(0, Number(value) || 0);
    if (!amount) return;
    const filter = String(state.shortVideo.author || "").trim();
    const facet = (state.shortVideo.authors || []).find((author) => shortVideoAuthorFilterValue(author) === filter);
    if (facet) facet.count = Math.max(0, Number(facet.count || 0) - amount);
  }

  function fallbackCopyText(value) {
    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.left = "-9999px";
    document.body.append(input);
    input.select();
    const copied = document.execCommand?.("copy");
    input.remove();
    if (!copied) throw new Error("copy failed");
  }

  function showBrowserToast(message) {
    const browser = els.workGrid?.querySelector?.(".short-video-browser, .short-video-home");
    if (!browser) return;
    browser.querySelector(".short-video-toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "short-video-toast";
    toast.textContent = message;
    browser.append(toast);
    window.setTimeout(() => toast.remove(), 1500);
  }

  function showSharePanel(video = state.shortVideo?.current, options = {}) {
    const browser = els.workGrid?.querySelector?.(".short-video-browser");
    if (!browser || !video?.id) return;
    browser.querySelector(".short-video-more-overlay")?.remove();
    browser.querySelector(".short-video-share-panel")?.remove();

    const localUrl = localShortVideoUrl(video);
    const originalUrl = originalDouyinUrl(video);
    const title = cardTitle(video) || "本地短视频";
    const authorName = String(video?.author?.name || "").trim();
    const shareText = shortVideoShareText(video, localUrl);

    const overlay = document.createElement("div");
    overlay.className = "short-video-more-overlay short-video-share-overlay";
    overlay._shortVideoReturnFocus = options.trigger || null;
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closePlaybackSettings(overlay);
    });

    const sheet = document.createElement("section");
    sheet.className = "short-video-more-sheet short-video-share-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "short-video-share-title");
    sheet.tabIndex = -1;

    const header = document.createElement("header");
    header.className = "short-video-more-head";
    const headingWrap = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.textContent = "分享作品";
    const heading = document.createElement("h2");
    heading.id = "short-video-share-title";
    heading.textContent = "发送给朋友";
    headingWrap.append(eyebrow, heading);
    const input = document.createElement("input");
    input.value = localUrl;
    input.readOnly = true;
    input.setAttribute("aria-label", "本地作品链接");
    input.addEventListener("focus", () => input.select());
    input.addEventListener("click", () => input.select());
    const close = document.createElement("button");
    close.type = "button";
    close.className = "short-video-more-close";
    close.append(createIcon("close"));
    close.setAttribute("aria-label", "关闭分享面板");
    close.addEventListener("click", () => closePlaybackSettings(overlay));
    header.append(headingWrap, close);

    const preview = document.createElement("section");
    preview.className = "short-video-share-preview";
    const media = document.createElement("span");
    media.className = "short-video-share-preview-media";
    if (video.coverUrl) {
      const image = document.createElement("img");
      image.src = video.coverUrl;
      image.alt = title;
      image.decoding = "async";
      media.append(image);
    } else {
      media.append(createIcon(isGalleryPost(video) ? "images" : "play"));
    }
    const mediaType = document.createElement("small");
    mediaType.textContent = isGalleryPost(video) ? `图集 · ${galleryLabel(video)}` : (formatDuration(video.durationMs) || "视频");
    media.append(mediaType);
    const previewCopy = document.createElement("div");
    const previewTitle = document.createElement("strong");
    previewTitle.textContent = title;
    const previewAuthor = document.createElement("span");
    previewAuthor.textContent = authorName ? shortVideoAuthorHandle(authorName) : "本地作品";
    const previewMeta = document.createElement("small");
    previewMeta.textContent = `${formatShortVideoMetric(video, "likes", "待补")} 赞 · ${formatShortVideoMetric(video, "comments", "待补")} 评论`;
    previewCopy.append(previewTitle, previewAuthor, previewMeta);
    preview.append(media, previewCopy);

    const actionSection = document.createElement("section");
    actionSection.className = "short-video-share-section";
    const actionTitle = document.createElement("strong");
    actionTitle.textContent = "分享方式";
    const actions = document.createElement("div");
    actions.className = "short-video-share-actions";

    const copyLocal = sharePanelAction("复制本地链接", "在这台设备或局域网打开", "link", async (button) => {
      await copyShortVideoValue(localUrl, "已复制本地链接");
      syncShareActionDone(button, "已复制");
    });
    copyLocal.classList.add("is-primary");
    const copyOriginal = sharePanelAction("复制抖音链接", originalUrl ? "打开原作品" : "当前作品没有原链接", "external", async (button) => {
      await copyShortVideoValue(originalUrl, "已复制抖音原链接");
      syncShareActionDone(button, "已复制");
    });
    copyOriginal.disabled = !originalUrl;
    const copyText = sharePanelAction("复制分享文案", "标题、作者和观看地址", "comment", async (button) => {
      await copyShortVideoValue(shareText, "已复制分享文案");
      syncShareActionDone(button, "已复制文案");
    });
    const systemShareAvailable = typeof navigator.share === "function";
    const systemShare = sharePanelAction("系统分享", systemShareAvailable ? "发送到其他应用" : "当前浏览器不支持", "share", async (button) => {
      if (!systemShareAvailable) return;
      try {
        await navigator.share({
          title,
          text: [title, authorName ? shortVideoAuthorHandle(authorName) : ""].filter(Boolean).join("\n"),
          url: localUrl
        });
        syncShareActionDone(button, "已打开分享");
      } catch (error) {
        if (error?.name !== "AbortError") showBrowserToast("系统分享启动失败");
      }
    });
    systemShare.disabled = !systemShareAvailable;
    actions.append(copyLocal, copyOriginal, copyText, systemShare);
    actionSection.append(actionTitle, actions);

    const linkSection = document.createElement("details");
    linkSection.className = "short-video-share-link";
    const linkSummary = document.createElement("summary");
    const linkLabel = document.createElement("strong");
    linkLabel.textContent = "查看本地地址";
    const linkHint = document.createElement("span");
    const localOnly = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
    linkHint.textContent = localOnly ? "仅这台设备可用" : "同一局域网可打开";
    linkSummary.append(linkLabel, linkHint);
    const linkField = document.createElement("div");
    const linkButton = document.createElement("button");
    linkButton.type = "button";
    linkButton.textContent = "复制";
    linkButton.addEventListener("click", () => {
      copyShortVideoValue(localUrl, "已复制本地链接").then(() => {
        linkButton.textContent = "已复制";
        window.setTimeout(() => {
          if (linkButton.isConnected) linkButton.textContent = "复制";
        }, 1800);
      }).catch(() => {
        input.focus({ preventScroll: true });
        input.select();
      });
    });
    linkField.append(input, linkButton);
    linkSection.append(linkSummary, linkField);

    const note = document.createElement("p");
    note.className = "short-video-share-note";
    note.append(createIcon("check"), document.createTextNode("分享只复制地址或调用系统面板，不会自动发布内容"));

    sheet.append(header, preview, actionSection, linkSection, note);
    overlay.append(sheet);
    browser.append(overlay);
    bindShortVideoModalFocusLoop(overlay, sheet, () => closePlaybackSettings(overlay));
    window.requestAnimationFrame(() => {
      copyLocal.focus({ preventScroll: true });
    });
  }

  function sharePanelAction(label, description, icon, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-share-action";
    const visual = document.createElement("span");
    visual.append(createIcon(icon));
    const copy = document.createElement("span");
    const title = document.createElement("b");
    title.textContent = label;
    const detail = document.createElement("small");
    detail.textContent = description;
    copy.append(title, detail);
    button.append(visual, copy);
    button.addEventListener("click", async () => {
      if (button.disabled || button.getAttribute("aria-busy") === "true") return;
      button.setAttribute("aria-busy", "true");
      try {
        await action?.(button);
      } catch (error) {
        console.warn(error);
      } finally {
        button.removeAttribute("aria-busy");
      }
    });
    return button;
  }

  function syncShareActionDone(button, detail) {
    if (!button) return;
    button.classList.add("is-done");
    const description = button.querySelector("small");
    const previous = description?.textContent || "";
    if (description) description.textContent = detail;
    window.setTimeout(() => {
      if (!button.isConnected) return;
      button.classList.remove("is-done");
      if (description) description.textContent = previous;
    }, 1800);
  }

  function railNav(icon, action, disabled) {
    const button = railButton("", createIcon(icon === "↑" ? "chevronUp" : "chevronDown"), "nav", icon === "↑" ? "上一个" : "下一个");
    button.disabled = disabled;
    button.addEventListener("click", action);
    return button;
  }

  function authorCaptionButton(video) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-caption-author";
    button.title = video.author?.name ? `查看 ${video.author.name}` : "查看作者";
    button.append(authorAvatar(video.author, "short-video-caption-author-avatar"));
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = shortVideoAuthorHandle(video.author?.name);
    const meta = document.createElement("em");
    meta.textContent = [formatDate(video.publishedAt), video.author?.secUid ? "作者主页" : ""].filter(Boolean).join(" · ");
    copy.append(name, meta);
    button.append(copy);
    button.addEventListener("click", () => openShortVideoAuthorPage(video.author, video));
    return button;
  }

  function authorAvatar(author = {}, className = "short-video-author-avatar") {
    const avatar = document.createElement("span");
    avatar.className = className;
    if (author?.avatarUrl) {
      const img = document.createElement("img");
      img.src = author.avatarUrl;
      img.alt = author?.name || "作者";
      img.decoding = "async";
      img.addEventListener("error", () => {
        img.remove();
        avatar.classList.add("is-fallback");
        avatar.textContent = initials(author?.name || "?");
      }, { once: true });
      avatar.append(img);
    } else {
      avatar.classList.add("is-fallback");
      avatar.textContent = initials(author?.name || "?");
    }
    return avatar;
  }

  async function showAuthorPanel(video, options = {}) {
    const browser = els.workGrid?.querySelector?.(".short-video-browser");
    if (!browser) return;
    const existingPanel = browser.querySelector(".short-video-author-panel");
    if (existingPanel) closeAuthorPanel(existingPanel, { restoreFeed: false, restoreFocus: false, animate: false });
    closeTransientPlayerControls();
    authorPanelReturnFeed = shortVideoFeedSnapshot();
    const author = video.author || {};
    const selectedTopic = normalizeShortVideoTopic(options.topic || video.tags?.[0]);
    const selectedSound = options.sound || video.sound || null;
    const panel = document.createElement("section");
    panel.className = "short-video-author-panel is-douyin-style";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "false");
    panel._shortVideoReturnFocus = document.activeElement;
    panel.setAttribute("aria-label", options.initialTab === "sound" && selectedSound
      ? `原声 ${selectedSound.title || "作品原声"}`
      : options.initialTab === "topic" && selectedTopic
      ? `话题 ${selectedTopic}`
      : options.initialTab === "comments"
      ? "评论与视频详情"
      : options.initialTab === "ai"
      ? "本地内容识别"
      : (options.initialTab === "related" ? "相关推荐" : "作者作品"));
    panel.addEventListener("click", (event) => {
      if (event.target === panel) closeAuthorPanel(panel);
    });

    const sheet = document.createElement("div");
    sheet.className = "short-video-author-sheet";
    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "short-video-author-drag-handle";
    dragHandle.setAttribute("aria-label", "向下拖动关闭面板");
    dragHandle.title = "下滑关闭";

    const top = document.createElement("div");
    top.className = "short-video-author-top";
    const tabNav = document.createElement("div");
    tabNav.className = "short-video-author-tab-nav";
    const tabs = document.createElement("div");
    tabs.className = "short-video-author-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "视频信息视图");
    const contextTabs = document.createElement("div");
    contextTabs.className = "short-video-author-context-tabs";
    contextTabs.setAttribute("role", "toolbar");
    contextTabs.setAttribute("aria-label", "扩展信息");
    const tabButtons = new Map();
    const primaryTabItems = [
      ["related", "相关推荐"],
      ["comments", `评论 ${formatShortVideoMetric(video, "comments")}`]
    ];
    const contextTabItems = [
      ["works", "作品"],
      ["detail", "详情"],
      ["ai", "识别"]
    ];
    if (selectedTopic) contextTabItems.push(["topic", `#${selectedTopic}`]);
    if (selectedSound) contextTabItems.push(["sound", "原声"]);
    const appendTabButton = (item, container, role = "tab") => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item[1];
      button.dataset.tab = item[0];
      button.setAttribute("role", role);
      button.addEventListener("click", () => renderAuthorTab(item[0], { userInitiated: true }));
      tabButtons.set(item[0], button);
      container.append(button);
    };
    primaryTabItems.forEach((item) => appendTabButton(item, tabs));
    contextTabItems.forEach((item) => appendTabButton(item, contextTabs, "button"));
    tabNav.append(tabs, contextTabs);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "short-video-author-close";
    close.append(createIcon("close"));
    close.setAttribute("aria-label", "关闭");
    close.addEventListener("click", () => closeAuthorPanel(panel));
    top.append(tabNav, close);

    const head = document.createElement("header");
    head.className = "short-video-author-head";
    head.append(authorAvatar(author, "short-video-author-head-avatar"));
    const title = document.createElement("div");
    title.className = "short-video-author-title";
    const name = document.createElement("strong");
    name.textContent = author.name || "未知作者";
    const profileLine = document.createElement("div");
    profileLine.className = "short-video-author-profile-line";
    const signature = document.createElement("div");
    signature.className = "short-video-author-profile-signature";
    const profileStats = document.createElement("div");
    profileStats.className = "short-video-author-profile-stats";
    const sub = document.createElement("span");
    sub.textContent = "读取中";
    title.append(name, profileLine, signature, profileStats, sub);
    const refreshAuthorHeader = () => {
      const lineText = authorProfileLineText(author);
      profileLine.textContent = lineText;
      profileLine.hidden = !lineText;
      const signatureText = String(author.signature || "").trim();
      signature.textContent = signatureText;
      signature.hidden = !signatureText;
      renderAuthorProfileStats(profileStats, author);
    };
    refreshAuthorHeader();

    const actions = document.createElement("div");
    actions.className = "short-video-author-actions";
    const follow = createAuthorFollowButton(video, author, "panel");
    const douyin = document.createElement("button");
    douyin.type = "button";
    douyin.textContent = "抖音主页";
    douyin.addEventListener("click", () => openAuthorDouyinLink(author));
    const authorPage = document.createElement("button");
    authorPage.type = "button";
    authorPage.textContent = "作者主页";
    authorPage.addEventListener("click", () => {
      closeAuthorPanel(panel, { restoreFeed: false });
      openShortVideoAuthorPage(author, video);
    });
    actions.append(follow, douyin, authorPage);
    head.append(title, actions);

    const content = document.createElement("div");
    content.className = "short-video-author-content";
    const status = document.createElement("div");
    status.className = "short-video-author-status";
    status.textContent = "正在读取";
    content.append(status);
    sheet.append(dragHandle, head, top, content);
    panel.append(sheet);
    browser.append(panel);
    bindAuthorPanelDragToClose(panel, sheet, dragHandle);
    isolateAuthorPanelAsMobileModal(panel, sheet, browser, close);

    let authorVideos = [];
    let authorTotal = 0;
    let authorVideosLoaded = false;
    let authorFeedSwitchRequested = false;
    let activeTab = ["detail", "works", "comments", "ai", "sound", "topic", "related"].includes(options.initialTab)
      && (options.initialTab !== "topic" || selectedTopic)
      && (options.initialTab !== "sound" || selectedSound)
      ? options.initialTab
      : "works";
    const autoSwitchAuthorFeed = options.switchAuthorFeed !== false;
    let authorFeedSwitchStarted = false;
    let relatedItems = [];
    let relatedBasis = null;
    let relatedLoading = false;
    let relatedLoaded = false;
    let relatedError = "";
    let topicItems = [];
    let topicTotal = 0;
    let topicLoading = false;
    let topicLoaded = false;
    let topicError = "";
    let soundItems = [];
    let soundTotal = 0;
    let soundLoading = false;
    let soundLoaded = false;
    let soundError = "";
    const startAuthorFeedSwitch = () => {
      if (!panel.isConnected || authorFeedSwitchStarted || !authorScopeId(video, author)) return;
      if (!authorVideosLoaded) {
        authorFeedSwitchRequested = true;
        return;
      }
      authorFeedSwitchStarted = true;
      authorFeedSwitchRequested = false;
      switchToAuthorWorksFeed(video, author, panel).catch(showError);
    };
    const loadRelatedRecommendations = async (force = false) => {
      if (relatedLoading || (relatedLoaded && !force)) return;
      relatedLoading = true;
      relatedError = "";
      try {
        const data = await api(`/api/short-videos/${encodeURIComponent(video.id)}/related?limit=36`);
        if (!panel.isConnected) return;
        relatedItems = Array.isArray(data.videos) ? data.videos : [];
        for (const item of relatedItems) cacheAuthorPanelVideo(item);
        relatedBasis = data.basis || null;
        relatedLoaded = true;
      } catch (error) {
        if (!panel.isConnected) return;
        relatedError = shortVideoFriendlyError(error, "相关推荐读取失败");
      } finally {
        relatedLoading = false;
        if (panel.isConnected && ["related", "ai"].includes(activeTab)) renderAuthorTab(activeTab);
      }
    };
    const loadTopicWorks = async (force = false) => {
      if (!selectedTopic || topicLoading || (topicLoaded && !force)) return;
      topicLoading = true;
      topicError = "";
      try {
        const params = new URLSearchParams({
          topic: selectedTopic,
          source: "all",
          sort: "likes",
          limit: "36",
          facets: "0"
        });
        const data = await api(`/api/short-videos?${params}`);
        if (!panel.isConnected) return;
        topicItems = Array.isArray(data.videos) ? data.videos : [];
        topicTotal = Number(data.total || topicItems.length || 0);
        topicLoaded = true;
      } catch (error) {
        if (!panel.isConnected) return;
        topicError = shortVideoFriendlyError(error, "话题作品读取失败");
      } finally {
        topicLoading = false;
        if (panel.isConnected && activeTab === "topic") renderAuthorTab("topic");
      }
    };
    const loadSoundWorks = async (force = false) => {
      if (!selectedSound?.key || soundLoading || (soundLoaded && !force)) return;
      soundLoading = true;
      soundError = "";
      try {
        const params = new URLSearchParams({
          sound: selectedSound.key,
          source: "all",
          sort: "likes",
          limit: "36",
          facets: "0"
        });
        const data = await api(`/api/short-videos?${params}`);
        if (!panel.isConnected) return;
        soundItems = Array.isArray(data.videos) ? data.videos : [];
        soundTotal = Number(data.total || soundItems.length || 0);
        soundLoaded = true;
      } catch (error) {
        if (!panel.isConnected) return;
        soundError = shortVideoFriendlyError(error, "原声作品读取失败");
      } finally {
        soundLoading = false;
        if (panel.isConnected && activeTab === "sound") renderAuthorTab("sound");
      }
    };
    const renderAuthorTab = (tab, renderOptions = {}) => {
      activeTab = tab;
      panel.dataset.activeTab = tab;
      for (const [key, button] of tabButtons) {
        const selected = key === tab;
        button.classList.toggle("active", selected);
        if (button.getAttribute("role") === "tab") button.setAttribute("aria-selected", String(selected));
        else button.setAttribute("aria-pressed", String(selected));
      }
      authorPanelTileMap = null;
      content.replaceChildren();
      if (tab === "works") {
        if (autoSwitchAuthorFeed || renderOptions.userInitiated) startAuthorFeedSwitch();
        content.append(authorWorksView(authorVideos, authorTotal, panel, state.shortVideo?.current || video));
        return;
      }
      if (tab === "detail") {
        content.append(authorDetailView(video, author));
        return;
      }
      if (tab === "comments") {
        content.append(shortVideoCommentsView(video));
        return;
      }
      if (tab === "ai") {
        content.append(shortVideoInsightView({
          videos: relatedItems,
          basis: relatedBasis,
          loading: relatedLoading,
          loaded: relatedLoaded,
          error: relatedError,
          onRetry: () => loadRelatedRecommendations(true),
          onShowRelated: () => renderAuthorTab("related", { userInitiated: true })
        }, panel, state.shortVideo?.current || video));
        if (!relatedLoaded && !relatedLoading) loadRelatedRecommendations().catch(() => {});
        return;
      }
      if (tab === "related") {
        content.append(shortVideoRelatedView({
          videos: relatedItems,
          basis: relatedBasis,
          loading: relatedLoading,
          loaded: relatedLoaded,
          error: relatedError,
          onRetry: () => loadRelatedRecommendations(true)
        }, panel, state.shortVideo?.current || video));
        if (!relatedLoaded && !relatedLoading) loadRelatedRecommendations().catch(() => {});
        return;
      }
      if (tab === "topic") {
        content.append(shortVideoTopicView({
          topic: selectedTopic,
          videos: topicItems,
          total: topicTotal,
          loading: topicLoading,
          loaded: topicLoaded,
          error: topicError,
          onRetry: () => loadTopicWorks(true)
        }, panel, state.shortVideo?.current || video));
        if (!topicLoaded && !topicLoading) loadTopicWorks().catch(() => {});
        return;
      }
      if (tab === "sound") {
        content.append(shortVideoSoundView({
          sound: selectedSound,
          videos: soundItems,
          total: soundTotal,
          loading: soundLoading,
          loaded: soundLoaded,
          error: soundError,
          onRetry: () => loadSoundWorks(true)
        }, panel, state.shortVideo?.current || video));
        if (!soundLoaded && !soundLoading) loadSoundWorks().catch(() => {});
        return;
      }
      content.append(authorComingSoonView("内容待接入"));
    };
    renderAuthorTab(activeTab);
    const commitPanelOpen = () => {
      if (!panel.isConnected || panel.dataset.openCommitted === "1") return;
      panel.dataset.openCommitted = "1";
      browser.classList.add("is-author-panel-open");
      panel.classList.add("is-open");
      const focusActiveTab = () => {
        if (!panel.isConnected) return;
        tabButtons.get(activeTab)?.focus?.({ preventScroll: true });
      };
      window.requestAnimationFrame(focusActiveTab);
      window.setTimeout(focusActiveTab, 100);
    };
    window.requestAnimationFrame(commitPanelOpen);
    window.setTimeout(commitPanelOpen, 80);

    try {
      const params = new URLSearchParams();
      if (author.secUid) params.set("author", author.secUid);
      params.set("source", "all");
      params.set("sort", state.shortVideo.sort || "published");
      params.set("limit", "36");
      params.set("facets", "0");
      const data = author.secUid ? await api(`/api/short-videos?${params}`) : { videos: [video], total: 1 };
      if (!panel.isConnected) return;
      authorVideos = data.videos || [];
      authorTotal = Number(data.total || authorVideos.length || 0);
      authorVideosLoaded = true;
      cacheAuthorPanelVideos([video, ...authorVideos]);
      const richerAuthor = authorVideos.find((item) => authorHasProfileMeta(item.author))?.author || authorVideos[0]?.author;
      if (richerAuthor) Object.assign(author, richerAuthor);
      refreshAuthorHeader();
      const homeCount = profileNumber(author.awemeCount);
      sub.textContent = homeCount !== null
        ? `${formatNumber(authorTotal)} 个本地作品 / 主页 ${formatNumber(homeCount)}`
        : `${formatNumber(authorTotal)} 个本地作品`;
      if (activeTab === "works" || activeTab === "detail") renderAuthorTab(activeTab);
    } catch (error) {
      if (!panel.isConnected) return;
      authorVideosLoaded = true;
      if (authorFeedSwitchRequested && activeTab === "works") startAuthorFeedSwitch();
      status.textContent = "读取失败";
      showError(error);
    }
  }

  async function switchToAuthorWorksFeed(video, author = {}, panel = null) {
    const authorId = authorScopeId(video, author);
    if (!authorId || !panel?.isConnected || !isCurrentShortVideo(video)) return;
    state.shortVideo.author = authorId;
    if (!isShortVideoAuthorDetailPage()) state.shortVideo.source = "all";
    state.shortVideo.query = "";
    state.shortVideo.topic = "";
    state.shortVideo.sound = "";
    state.shortVideo.soundInfo = null;
    if (!isShortVideoAuthorDetailPage()) state.shortVideo.sort = "published";
    state.shortVideo.data = null;
    const data = await fetchShortVideoDetail(video.id);
    if (!panel.isConnected || !isCurrentShortVideo(video)) return;
    state.shortVideo.current = data.video || state.shortVideo.current;
    cacheAuthorPanelVideo(state.shortVideo.current);
    state.shortVideo.prevId = data.prevId || "";
    state.shortVideo.nextId = data.nextId || "";
    await loadAdjacentVideos(state.shortVideo.current.id);
    if (!panel.isConnected || !isCurrentShortVideo(video)) return;
    refreshAdjacentPanelsDom();
    syncShortVideoBrowserSearchDom();
    syncAuthorPanelCurrentTile();
    replaceRoute({ view: "shortVideos", shortVideoId: state.shortVideo.current.id });
  }

  function authorScopeId(video = {}, author = {}) {
    return String(author?.secUid || video?.author?.secUid || "").trim();
  }

  function isCurrentShortVideo(video = {}, currentVideo = state.shortVideo?.current) {
    const id = String(video?.id || "").trim();
    const currentId = String(currentVideo?.id || "").trim();
    if (id && currentId && id === currentId) return true;
    const awemeId = String(video?.awemeId || "").trim();
    const currentAwemeId = String(currentVideo?.awemeId || "").trim();
    return Boolean(awemeId && currentAwemeId && awemeId === currentAwemeId);
  }

  function authorWorksView(videos, total, panel, currentVideo = null) {
    const wrap = document.createElement("div");
    wrap.className = "short-video-author-works";
    const label = document.createElement("div");
    label.className = "short-video-author-section-title";
    label.textContent = `${formatNumber(total || videos.length || 0)} 个作品`;
    const grid = document.createElement("div");
    grid.className = "short-video-author-grid";
    const tileMap = new Map();
    const displayVideos = shortVideosWithCovers(videos);
    if (!displayVideos.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-author-status";
      empty.textContent = videos.length ? "封面补齐前暂不显示这些短视频。" : "没有视频";
      grid.append(empty);
    } else {
      for (const [index, item] of displayVideos.entries()) {
        const tile = authorVideoTile(item, panel, index, {
          current: isCurrentShortVideo(item, currentVideo),
          previous: displayVideos[index - 1] || null,
          next: displayVideos[index + 1] || null
        });
        if (tile) {
          const id = String(item.id || "").trim();
          const awemeId = String(item.awemeId || "").trim();
          if (id) tileMap.set(`id:${id}`, tile);
          if (awemeId) tileMap.set(`aweme:${awemeId}`, tile);
          grid.append(tile);
        }
      }
    }
    authorPanelTileMap = tileMap;
    activateShortVideoCovers(grid);
    wrap.append(label, grid);
    return wrap;
  }

  function authorDetailView(video, author) {
    const detail = document.createElement("div");
    detail.className = "short-video-author-detail";
    const authorLine = document.createElement("button");
    authorLine.type = "button";
    authorLine.className = "short-video-author-detail-owner";
    authorLine.textContent = `${shortVideoAuthorHandle(author.name)} ›`;
    authorLine.addEventListener("click", () => openAuthorDouyinLink(author));
    const profile = authorProfileBlock(author);
    const title = document.createElement("p");
    appendCaptionText(title, captionTitleWithTags(video), video);
    const stats = document.createElement("div");
    stats.className = "short-video-author-detail-stats";
    for (const item of [
      ["点赞", formatShortVideoMetric(video, "likes", "待补")],
      ["评论", formatShortVideoMetric(video, "comments", "待补")],
      ["收藏", formatShortVideoMetric(video, "collects", "待补")],
      ["分享", formatShortVideoMetric(video, "shares", "待补")],
      [isGalleryPost(video) ? "图片" : "时长", isGalleryPost(video) ? galleryLabel(video) : (formatDuration(video.durationMs) || "-")],
      ["大小", formatBytes(video.size || 0) || "-"]
    ]) {
      const cell = document.createElement("span");
      const value = document.createElement("b");
      value.textContent = item[1];
      const label = document.createElement("small");
      label.textContent = item[0];
      cell.append(value, label);
      stats.append(cell);
    }
    const actions = document.createElement("div");
    actions.className = "short-video-author-detail-actions";
    const original = document.createElement("button");
    original.type = "button";
    original.textContent = "打开原视频";
    original.addEventListener("click", () => openDouyinLink(video));
    const home = document.createElement("button");
    home.type = "button";
    home.textContent = "打开抖音主页";
    home.addEventListener("click", () => openAuthorDouyinLink(author));
    actions.append(original, home);
    detail.append(authorLine);
    if (profile) detail.append(profile);
    detail.append(title, stats, actions);
    return detail;
  }

  function authorProfileLineText(author) {
    const parts = [];
    const douyinId = String(author?.shortId || author?.uniqueId || "").trim();
    if (douyinId) parts.push(`抖音号 ${douyinId}`);
    const ipLocation = String(author?.ipLocation || "").trim().replace(/^IP属地[:：]?\s*/u, "");
    if (ipLocation) parts.push(`IP ${ipLocation}`);
    const age = profileNumber(author?.age);
    if (age) parts.push(`${age}岁`);
    const verification = String(author?.verification || "").trim();
    if (verification) parts.push(verification);
    return parts.join(" · ");
  }

  function authorHasProfileMeta(author) {
    return Boolean(authorProfileLineText(author) || String(author?.signature || "").trim() || profileStatItems(author).length);
  }

  function profileNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
  }

  function profileStatItems(author) {
    return [
      ["关注", profileNumber(author?.followingCount)],
      ["粉丝", profileNumber(author?.followerCount)],
      ["获赞", profileNumber(author?.totalFavorited)],
      ["作品", profileNumber(author?.awemeCount)]
    ].filter((item) => item[1] !== null);
  }

  function renderAuthorProfileStats(target, author) {
    target.textContent = "";
    const items = profileStatItems(author);
    target.hidden = !items.length;
    for (const [label, value] of items) {
      const cell = document.createElement("span");
      cell.dataset.profileStat = label;
      const strong = document.createElement("b");
      strong.textContent = formatCompact(value);
      const small = document.createElement("small");
      small.textContent = label;
      cell.append(strong, small);
      target.append(cell);
    }
  }

  function authorProfileBlock(author) {
    if (!authorHasProfileMeta(author)) return null;
    const block = document.createElement("div");
    block.className = "short-video-author-profile-block";
    const lineText = authorProfileLineText(author);
    if (lineText) {
      const line = document.createElement("div");
      line.className = "short-video-author-profile-line";
      line.textContent = lineText;
      block.append(line);
    }
    const signature = String(author?.signature || "").trim();
    if (signature) {
      const bio = document.createElement("div");
      bio.className = "short-video-author-profile-signature";
      bio.textContent = signature;
      block.append(bio);
    }
    const stats = document.createElement("div");
    stats.className = "short-video-author-profile-stats";
    renderAuthorProfileStats(stats, author);
    if (!stats.hidden) block.append(stats);
    return block;
  }

  function shortVideoCommentsView(video) {
    const commentCount = Math.max(0, Number(video?.stats?.comments || 0));
    const originalUrl = originalDouyinUrl(video);
    const videoId = String(video?.id || "").trim();
    const commentsEndpoint = `/api/short-videos/${encodeURIComponent(videoId)}/comments`;
    const wrap = document.createElement("div");
    wrap.className = "short-video-comments";

    const heading = document.createElement("div");
    heading.className = "short-video-comments-heading";
    const title = document.createElement("strong");
    title.textContent = `${formatCompact(commentCount)} 条评论`;
    const source = document.createElement("span");
    source.textContent = "原视频统计";
    heading.append(title, source);

    const scroll = document.createElement("div");
    scroll.className = "short-video-comments-scroll";

    const localSection = document.createElement("section");
    localSection.className = "short-video-local-comments";
    const localHeading = document.createElement("div");
    localHeading.className = "short-video-local-comments-heading";
    const localTitle = document.createElement("strong");
    localTitle.textContent = "我的本地评论";
    const localCount = document.createElement("span");
    localCount.textContent = "读取中";
    localHeading.append(localTitle, localCount);
    const localList = document.createElement("div");
    localList.className = "short-video-local-comment-list";
    localSection.append(localHeading, localList);

    const remote = document.createElement("section");
    remote.className = "short-video-comments-remote";
    const remoteIcon = document.createElement("span");
    remoteIcon.className = "short-video-comments-remote-icon";
    remoteIcon.append(createIcon("comment"));
    const remoteCopy = document.createElement("div");
    const remoteTitle = document.createElement("strong");
    remoteTitle.textContent = commentCount
      ? `${formatCompact(commentCount)} 条抖音评论未同步`
      : "原视频暂无评论正文";
    const remoteMessage = document.createElement("p");
    remoteMessage.textContent = commentCount
      ? "这里只显示保存在本机的评论；原评论请前往抖音查看。"
      : "当前资料库没有保存原视频评论正文。";
    remoteCopy.append(remoteTitle, remoteMessage);

    const actions = document.createElement("div");
    actions.className = "short-video-comments-remote-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "is-primary";
    open.textContent = "查看原评论";
    open.disabled = !originalUrl;
    open.title = originalUrl ? "打开抖音原视频" : "当前作品没有原始链接";
    open.addEventListener("click", () => openDouyinLink(video));
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "复制链接";
    copy.addEventListener("click", () => {
      const value = originalUrl || localShortVideoUrl(video);
      copyShortVideoValue(value, originalUrl ? "已复制抖音原链接" : "已复制本地链接").catch(() => {});
    });
    actions.append(open, copy);
    remote.append(remoteIcon, remoteCopy, actions);

    const note = document.createElement("div");
    note.className = "short-video-comments-note";
    note.append(createIcon("check"), document.createTextNode("“我的本地评论”只保存在这台设备，不会发布到抖音"));

    scroll.append(remote, localSection, note);

    const composer = document.createElement("form");
    composer.className = "short-video-comment-composer";
    const composerAvatar = document.createElement("span");
    composerAvatar.className = "short-video-comment-composer-avatar";
    composerAvatar.textContent = "我";
    const composerField = document.createElement("div");
    composerField.className = "short-video-comment-composer-field";
    const textarea = document.createElement("textarea");
    textarea.rows = 1;
    textarea.maxLength = 500;
    textarea.placeholder = "说点什么，只保存在本机…";
    textarea.setAttribute("aria-label", "输入本地评论");
    const composerFooter = document.createElement("div");
    composerFooter.className = "short-video-comment-composer-footer";
    const composerHint = document.createElement("span");
    composerHint.textContent = "Enter 发送 · Shift+Enter 换行";
    const composerActions = document.createElement("span");
    const characterCount = document.createElement("small");
    characterCount.textContent = "0/500";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "发送";
    submit.disabled = true;
    composerActions.append(characterCount, submit);
    composerFooter.append(composerHint, composerActions);
    composerField.append(textarea, composerFooter);
    composer.append(composerAvatar, composerField);

    let comments = [];
    let loading = true;
    let loadError = "";

    const renderLocalComments = () => {
      localList.innerHTML = "";
      localCount.textContent = loading ? "读取中" : `${comments.length} 条`;
      if (loading) {
        const status = document.createElement("div");
        status.className = "short-video-local-comments-status is-loading";
        status.textContent = "正在读取本地评论";
        localList.append(status);
        return;
      }
      if (loadError) {
        const status = document.createElement("div");
        status.className = "short-video-local-comments-status is-error";
        const message = document.createElement("span");
        message.textContent = loadError;
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "重试";
        retry.addEventListener("click", () => loadLocalComments());
        status.append(message, retry);
        localList.append(status);
        return;
      }
      if (!comments.length) {
        const empty = document.createElement("div");
        empty.className = "short-video-local-comments-status";
        empty.textContent = "还没有本地评论，写下第一条只给自己看的评论。";
        localList.append(empty);
        return;
      }
      for (const comment of comments) localList.append(renderLocalComment(comment));
    };

    const renderLocalComment = (comment = {}) => {
      const item = document.createElement("article");
      item.className = "short-video-local-comment";
      item.dataset.commentId = comment.id || "";
      const avatar = document.createElement("span");
      avatar.className = "short-video-local-comment-avatar";
      avatar.textContent = "我";
      const body = document.createElement("div");
      body.className = "short-video-local-comment-body";
      const meta = document.createElement("div");
      meta.className = "short-video-local-comment-meta";
      const name = document.createElement("strong");
      name.textContent = "我";
      const badge = document.createElement("span");
      badge.textContent = "本地";
      const time = document.createElement("time");
      time.dateTime = comment.createdAt || "";
      time.textContent = formatLocalCommentDate(comment.createdAt);
      meta.append(name, badge, time);
      const content = document.createElement("p");
      content.textContent = comment.body || "";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "short-video-local-comment-delete";
      remove.textContent = "删除";
      remove.setAttribute("aria-label", "删除本地评论");
      let confirmTimer = 0;
      remove.addEventListener("click", async () => {
        if (remove.dataset.confirm !== "1") {
          remove.dataset.confirm = "1";
          remove.textContent = "确认删除";
          window.clearTimeout(confirmTimer);
          confirmTimer = window.setTimeout(() => {
            remove.dataset.confirm = "0";
            remove.textContent = "删除";
          }, 10000);
          return;
        }
        window.clearTimeout(confirmTimer);
        remove.disabled = true;
        remove.setAttribute("aria-busy", "true");
        try {
          const data = await api(`${commentsEndpoint}/${encodeURIComponent(comment.id || "")}`, { method: "DELETE" });
          comments = Array.isArray(data.comments) ? data.comments : comments.filter((itemComment) => itemComment.id !== comment.id);
          renderLocalComments();
          showBrowserToast("已删除本地评论");
        } catch (error) {
          remove.disabled = false;
          remove.removeAttribute("aria-busy");
          remove.dataset.confirm = "0";
          remove.textContent = "删除";
          showBrowserToast(error.message || "本地评论删除失败");
        }
      });
      body.append(meta, content, remove);
      item.append(avatar, body);
      return item;
    };

    const loadLocalComments = async () => {
      loading = true;
      loadError = "";
      renderLocalComments();
      try {
        const data = await api(commentsEndpoint);
        comments = Array.isArray(data.comments) ? data.comments : [];
      } catch (error) {
        loadError = error.message || "本地评论读取失败";
      } finally {
        loading = false;
        renderLocalComments();
      }
    };

    const syncComposer = () => {
      const value = textarea.value || "";
      const length = Array.from(value).length;
      characterCount.textContent = `${length}/500`;
      submit.disabled = !value.trim() || submit.getAttribute("aria-busy") === "true";
      composerField.classList.toggle("is-dirty", Boolean(value));
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(104, Math.max(28, textarea.scrollHeight || 28))}px`;
    };
    textarea.addEventListener("input", syncComposer);
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (!submit.disabled) composer.requestSubmit();
    });
    composer.addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = textarea.value.trim();
      if (!body || submit.getAttribute("aria-busy") === "true") return;
      submit.setAttribute("aria-busy", "true");
      submit.disabled = true;
      submit.textContent = "发送中";
      try {
        const data = await api(commentsEndpoint, { method: "POST", body: { body } });
        comments = Array.isArray(data.comments) ? data.comments : [data.comment, ...comments].filter(Boolean);
        textarea.value = "";
        renderLocalComments();
        scroll.scrollTop = 0;
        showBrowserToast("本地评论已保存");
      } catch (error) {
        showBrowserToast(error.message || "本地评论保存失败");
      } finally {
        submit.removeAttribute("aria-busy");
        submit.textContent = "发送";
        syncComposer();
        textarea.focus();
      }
    });

    wrap.append(heading, scroll, composer);
    renderLocalComments();
    loadLocalComments();
    return wrap;
  }

  function shortVideoSoundView(data = {}, panel, currentVideo) {
    const sound = data.sound || currentVideo?.sound || {};
    const wrap = document.createElement("div");
    wrap.className = "short-video-sound";
    const heading = document.createElement("div");
    heading.className = "short-video-sound-heading";
    const cover = document.createElement("span");
    cover.className = "short-video-sound-cover";
    if (sound.coverUrl) {
      const image = document.createElement("img");
      image.src = sound.coverUrl;
      image.alt = `${sound.title || "原声"}封面`;
      image.decoding = "async";
      cover.append(image);
    } else {
      cover.append(createIcon("headphones"));
    }
    const copy = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.textContent = sound.localAvailable ? "本地原声" : "作品原声";
    const title = document.createElement("strong");
    title.textContent = sound.title || "作品原声";
    const author = document.createElement("small");
    author.textContent = [sound.author ? `音乐人 ${sound.author}` : "", data.loaded ? `${formatNumber(data.total || 0)} 个作品` : "正在统计"].filter(Boolean).join(" · ");
    copy.append(eyebrow, title, author);
    const actions = document.createElement("div");
    actions.className = "short-video-sound-actions";
    let audio = null;
    let preview = null;
    if (sound.previewUrl) {
      audio = document.createElement("audio");
      audio.className = "short-video-sound-audio";
      audio.src = sound.previewUrl;
      audio.preload = "metadata";
      preview = document.createElement("button");
      preview.type = "button";
      preview.textContent = sound.localAvailable ? "播放本地原声" : "试听原声";
      const syncPreview = () => {
        const playing = !audio.paused && !audio.ended;
        preview.textContent = playing ? "暂停原声" : (sound.localAvailable ? "播放本地原声" : "试听原声");
        cover.classList.toggle("is-playing", playing);
      };
      audio.addEventListener("play", syncPreview);
      audio.addEventListener("pause", syncPreview);
      audio.addEventListener("ended", syncPreview);
      audio.addEventListener("error", () => {
        preview.disabled = true;
        preview.textContent = "原声暂不可播放";
        cover.classList.remove("is-playing");
      });
      preview.addEventListener("click", async () => {
        if (audio.paused) {
          activePlayer()?.pause?.();
          try {
            await audio.play();
          } catch (error) {
            showBrowserToast(error?.name === "NotAllowedError"
              ? "浏览器拦截了播放，请再次点击试听"
              : "原声暂时无法播放");
          }
        } else {
          audio.pause();
        }
        syncPreview();
      });
      actions.append(preview, audio);
    }
    const enter = document.createElement("button");
    enter.type = "button";
    enter.className = "is-primary";
    enter.textContent = "进入原声流";
    enter.disabled = !sound.key || data.loading;
    enter.addEventListener("click", () => enterShortVideoSoundFeed(sound, currentVideo, panel).catch(showError));
    actions.append(enter);
    heading.append(cover, copy, actions);
    wrap.append(heading);

    if (data.error) {
      const error = document.createElement("div");
      error.className = "short-video-related-status is-error";
      const message = document.createElement("span");
      message.textContent = data.error;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新加载";
      retry.addEventListener("click", () => data.onRetry?.());
      error.append(message, retry);
      wrap.append(error);
      return wrap;
    }
    if (data.loading || !data.loaded) {
      const loading = document.createElement("div");
      loading.className = "short-video-related-status is-loading";
      loading.append(createIcon("repeat"), document.createTextNode("正在读取同原声作品"));
      wrap.append(loading);
      return wrap;
    }
    const videos = shortVideosWithCovers(Array.isArray(data.videos) ? data.videos : []);
    if (!videos.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-related-status";
      empty.textContent = "本地库暂时没有同原声作品";
      wrap.append(empty);
      return wrap;
    }
    const grid = document.createElement("div");
    grid.className = "short-video-author-grid short-video-sound-grid";
    for (const [index, video] of videos.entries()) {
      const tile = authorVideoTile(video, panel, index, {
        current: isCurrentShortVideo(video, currentVideo),
        previous: videos[index - 1] || null,
        next: videos[index + 1] || null,
        onOpen: (item, sourcePanel) => enterShortVideoSoundFeed(sound, item, sourcePanel)
      });
      if (tile) grid.append(tile);
    }
    activateShortVideoCovers(grid);
    wrap.append(grid);
    return wrap;
  }

  async function enterShortVideoSoundFeed(sound, targetVideo, panel) {
    const key = normalizeShortVideoSound(sound?.key);
    const video = targetVideo || state.shortVideo?.current;
    if (!key || !video?.id) return;
    authorPanelReturnFeed = null;
    state.shortVideo.authorPage = "";
    state.shortVideo.author = "all";
    state.shortVideo.source = "all";
    state.shortVideo.sort = "likes";
    state.shortVideo.query = "";
    state.shortVideo.topic = "";
    state.shortVideo.sound = key;
    state.shortVideo.soundInfo = sound;
    state.shortVideo.media = "all";
    state.shortVideo.data = null;
    clearShortVideoDeleteSelection();

    if (isCurrentShortVideo(video)) {
      const data = await fetchShortVideoDetail(video.id);
      if (!isCurrentShortVideo(video)) return;
      state.shortVideo.current = data.video || video;
      state.shortVideo.prevId = data.prevId || "";
      state.shortVideo.nextId = data.nextId || "";
      await loadAdjacentVideos(video.id);
      if (!isCurrentShortVideo(video)) return;
      renderStats();
      refreshAdjacentPanelsDom();
      syncCurrentNavigationDom();
    } else {
      await replaceVideoFromAuthorPanel(video, panel);
    }
    syncShortVideoBrowserSearchDom();
    if (panel?.isConnected) closeAuthorPanel(panel, { restoreFeed: false });
    replaceRoute({ view: "shortVideos", shortVideoId: state.shortVideo.current?.id || video.id });
    showBrowserToast(`已进入原声：${sound.title || "作品原声"}`);
  }

  function shortVideoTopicView(data = {}, panel, currentVideo) {
    const topic = normalizeShortVideoTopic(data.topic);
    const wrap = document.createElement("div");
    wrap.className = "short-video-topic";
    const heading = document.createElement("div");
    heading.className = "short-video-topic-heading";
    const copy = document.createElement("div");
    const eyebrow = document.createElement("span");
    eyebrow.textContent = "本地话题";
    const title = document.createElement("strong");
    title.textContent = `#${topic}`;
    const count = document.createElement("small");
    count.textContent = data.loaded ? `${formatNumber(data.total || 0)} 个作品` : "正在统计";
    copy.append(eyebrow, title, count);
    const enter = document.createElement("button");
    enter.type = "button";
    enter.textContent = "进入话题流";
    enter.disabled = !topic || data.loading;
    enter.addEventListener("click", () => enterShortVideoTopicFeed(topic, currentVideo, panel).catch(showError));
    heading.append(copy, enter);
    wrap.append(heading);

    if (data.error) {
      const error = document.createElement("div");
      error.className = "short-video-related-status is-error";
      const message = document.createElement("span");
      message.textContent = data.error;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新加载";
      retry.addEventListener("click", () => data.onRetry?.());
      error.append(message, retry);
      wrap.append(error);
      return wrap;
    }
    if (data.loading || !data.loaded) {
      const loading = document.createElement("div");
      loading.className = "short-video-related-status is-loading";
      loading.append(createIcon("repeat"), document.createTextNode("正在读取同话题作品"));
      wrap.append(loading);
      return wrap;
    }
    const videos = shortVideosWithCovers(Array.isArray(data.videos) ? data.videos : []);
    if (!videos.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-related-status";
      empty.textContent = "本地库暂时没有同话题作品";
      wrap.append(empty);
      return wrap;
    }
    const grid = document.createElement("div");
    grid.className = "short-video-author-grid short-video-topic-grid";
    for (const [index, video] of videos.entries()) {
      const tile = authorVideoTile(video, panel, index, {
        current: isCurrentShortVideo(video, currentVideo),
        previous: videos[index - 1] || null,
        next: videos[index + 1] || null,
        onOpen: (item, sourcePanel) => enterShortVideoTopicFeed(topic, item, sourcePanel)
      });
      if (tile) grid.append(tile);
    }
    activateShortVideoCovers(grid);
    wrap.append(grid);
    return wrap;
  }

  async function enterShortVideoTopicFeed(value, targetVideo, panel) {
    const topic = normalizeShortVideoTopic(value);
    const video = targetVideo || state.shortVideo?.current;
    if (!topic || !video?.id) return;
    authorPanelReturnFeed = null;
    state.shortVideo.authorPage = "";
    state.shortVideo.author = "all";
    state.shortVideo.source = "all";
    state.shortVideo.sort = "likes";
    state.shortVideo.query = "";
    state.shortVideo.topic = topic;
    state.shortVideo.sound = "";
    state.shortVideo.soundInfo = null;
    state.shortVideo.media = "all";
    state.shortVideo.data = null;
    clearShortVideoDeleteSelection();

    if (isCurrentShortVideo(video)) {
      const data = await fetchShortVideoDetail(video.id);
      if (!isCurrentShortVideo(video)) return;
      state.shortVideo.current = data.video || video;
      state.shortVideo.prevId = data.prevId || "";
      state.shortVideo.nextId = data.nextId || "";
      await loadAdjacentVideos(video.id);
      if (!isCurrentShortVideo(video)) return;
      renderStats();
      refreshAdjacentPanelsDom();
      syncCurrentNavigationDom();
    } else {
      await replaceVideoFromAuthorPanel(video, panel);
    }
    syncShortVideoBrowserSearchDom();
    if (panel?.isConnected) closeAuthorPanel(panel, { restoreFeed: false });
    replaceRoute({ view: "shortVideos", shortVideoId: state.shortVideo.current?.id || video.id });
    showBrowserToast(`已进入 #${topic}`);
  }

  function shortVideoInsightQuery(video = {}) {
    const cleanTitle = String(video.title || video.description || "")
      .replace(/#[^\s#@]+/gu, " ")
      .replace(/@[^\s#@]+/gu, " ")
      .replace(/[|｜]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (cleanTitle) return cleanTitle.slice(0, 32);
    const firstTag = normalizeShortVideoTopic(video.tags?.[0]);
    return firstTag || String(video.author?.name || "").trim().slice(0, 32);
  }

  function shortVideoFrameLabel(video = {}) {
    const width = Math.max(0, Number(video.width || 0));
    const height = Math.max(0, Number(video.height || 0));
    if (!width || !height) return "规格未知";
    const orientation = Math.abs(width - height) < Math.max(width, height) * 0.04
      ? "方形"
      : (width > height ? "横屏" : "竖屏");
    return `${orientation} · ${width}×${height}`;
  }

  function shortVideoInsightView(data = {}, panel, currentVideo = {}) {
    const video = currentVideo || {};
    const gallery = isGalleryPost(video);
    const query = shortVideoInsightQuery(video);
    const tags = [...new Set((Array.isArray(video.tags) ? video.tags : [])
      .map(normalizeShortVideoTopic)
      .filter(Boolean))].slice(0, 8);
    const wrap = document.createElement("div");
    wrap.className = "short-video-insight";

    const hero = document.createElement("section");
    hero.className = "short-video-insight-hero";
    const media = document.createElement("div");
    media.className = "short-video-insight-media";
    const coverUrl = shortVideoCardCoverUrl(video);
    if (coverUrl) {
      const cover = document.createElement("img");
      cover.className = "short-video-cover-image";
      cover.dataset.src = coverUrl;
      cover.dataset.videoId = String(video.id || "");
      cover.alt = gallery ? "当前图文封面" : "当前视频封面";
      cover.loading = "eager";
      cover.decoding = "async";
      media.append(cover);
    }
    const mediaBadge = document.createElement("span");
    mediaBadge.textContent = gallery ? `图集 · ${galleryLabel(video)}` : "短视频";
    media.append(mediaBadge);

    const heroCopy = document.createElement("div");
    heroCopy.className = "short-video-insight-hero-copy";
    const eyebrow = document.createElement("span");
    eyebrow.className = "short-video-insight-eyebrow";
    eyebrow.append(createIcon("ai"), document.createTextNode("本地内容识别"));
    const privacy = document.createElement("em");
    privacy.textContent = "未上传云端";
    eyebrow.append(privacy);
    const title = document.createElement("strong");
    title.textContent = cardTitle(video);
    const note = document.createElement("p");
    note.textContent = "根据本地标题、标签、作者与媒体信息整理，不虚构画面结论。";
    heroCopy.append(eyebrow, title, note);
    hero.append(media, heroCopy);

    const facts = document.createElement("div");
    facts.className = "short-video-insight-facts";
    const factItems = [
      ["内容类型", gallery ? "图文作品" : "视频作品"],
      ["画面规格", shortVideoFrameLabel(video)],
      [gallery ? "图片数量" : "视频时长", gallery ? galleryLabel(video) : (formatDuration(video.durationMs) || "未知")],
      ["发布时间", formatDate(video.publishedAt) || "日期未知"]
    ];
    for (const [labelText, valueText] of factItems) {
      const fact = document.createElement("span");
      const value = document.createElement("b");
      value.textContent = valueText;
      const label = document.createElement("small");
      label.textContent = labelText;
      fact.append(value, label);
      facts.append(fact);
    }

    const clues = document.createElement("section");
    clues.className = "short-video-insight-section";
    const cluesHeading = document.createElement("div");
    cluesHeading.className = "short-video-insight-section-heading";
    const cluesTitle = document.createElement("strong");
    cluesTitle.textContent = "内容线索";
    const cluesHint = document.createElement("span");
    cluesHint.textContent = "点击线索继续探索";
    cluesHeading.append(cluesTitle, cluesHint);
    const chips = document.createElement("div");
    chips.className = "short-video-insight-chips";
    for (const topic of tags) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.textContent = `#${topic}`;
      chip.addEventListener("click", () => showAuthorPanel(video, {
        initialTab: "topic",
        topic,
        switchAuthorFeed: false
      }).catch(showError));
      chips.append(chip);
    }
    if (video.author?.name) {
      const author = document.createElement("button");
      author.type = "button";
      author.textContent = shortVideoAuthorHandle(video.author.name);
      author.addEventListener("click", () => {
        closeAuthorPanel(panel, { restoreFeed: false });
        openShortVideoAuthorPage(video.author, video);
      });
      chips.append(author);
    }
    if (!chips.childElementCount) {
      const empty = document.createElement("span");
      empty.className = "short-video-insight-empty-clue";
      empty.textContent = "这条作品没有记录可用的话题或作者线索。";
      chips.append(empty);
    }
    clues.append(cluesHeading, chips);

    const actions = document.createElement("div");
    actions.className = "short-video-insight-actions";
    const search = document.createElement("button");
    search.type = "button";
    search.className = "is-primary";
    search.textContent = query ? `搜索“${query}”` : "搜索相关内容";
    search.disabled = !query;
    search.addEventListener("click", () => {
      closeAuthorPanel(panel, { restoreFeed: false });
      commitShortVideoSearch(query);
    });
    const related = document.createElement("button");
    related.type = "button";
    related.textContent = data.loading ? "正在匹配相似作品" : "查看全部相关推荐";
    related.addEventListener("click", () => data.onShowRelated?.());
    actions.append(search, related);

    const recommendation = document.createElement("section");
    recommendation.className = "short-video-insight-section short-video-insight-recommendations";
    const recommendationHeading = document.createElement("div");
    recommendationHeading.className = "short-video-insight-section-heading";
    const recommendationTitle = document.createElement("strong");
    recommendationTitle.textContent = "相似作品";
    const recommendationBasis = document.createElement("span");
    const basisTags = Array.isArray(data.basis?.tags) ? data.basis.tags.filter(Boolean).slice(0, 2) : [];
    recommendationBasis.textContent = basisTags.length
      ? `基于 ${basisTags.map((tag) => `#${tag}`).join(" · ")}`
      : `基于 ${data.basis?.author || video.author?.name || "当前作品"}`;
    recommendationHeading.append(recommendationTitle, recommendationBasis);
    recommendation.append(recommendationHeading);

    if (data.error) {
      const error = document.createElement("div");
      error.className = "short-video-insight-recommendation-status";
      const message = document.createElement("span");
      message.textContent = data.error;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新匹配";
      retry.addEventListener("click", () => data.onRetry?.());
      error.append(message, retry);
      recommendation.append(error);
    } else if (data.loading || !data.loaded) {
      const loading = document.createElement("div");
      loading.className = "short-video-insight-recommendation-status is-loading";
      loading.append(createIcon("repeat"), document.createTextNode("正在匹配本地作品"));
      recommendation.append(loading);
    } else {
      const videos = shortVideosWithCovers(Array.isArray(data.videos) ? data.videos : []).slice(0, 3);
      if (!videos.length) {
        const empty = document.createElement("div");
        empty.className = "short-video-insight-recommendation-status";
        empty.textContent = "本地库暂时没有相似作品";
        recommendation.append(empty);
      } else {
        const list = document.createElement("div");
        list.className = "short-video-insight-recommendation-list";
        for (const [index, item] of videos.entries()) {
          const button = document.createElement("button");
          button.type = "button";
          button.setAttribute("aria-label", `播放相似作品：${cardTitle(item)}`);
          const itemMedia = document.createElement("span");
          const image = document.createElement("img");
          image.className = "short-video-cover-image";
          image.dataset.src = shortVideoCardCoverUrl(item);
          image.dataset.videoId = String(item.id || "");
          image.alt = item.title || "相似作品封面";
          image.loading = index === 0 ? "eager" : "lazy";
          image.decoding = "async";
          itemMedia.append(image);
          const copy = document.createElement("span");
          const itemTitle = document.createElement("strong");
          itemTitle.textContent = cardTitle(item);
          const reason = document.createElement("small");
          reason.textContent = item.recommendation?.reason || shortVideoAuthorHandle(item.author?.name);
          copy.append(itemTitle, reason);
          button.append(itemMedia, copy);
          button.addEventListener("click", () => openRelatedVideo(item, panel));
          list.append(button);
        }
        recommendation.append(list);
      }
    }

    wrap.append(hero, facts, clues, actions, recommendation);
    activateShortVideoCovers(wrap);
    return wrap;
  }

  function shortVideoRelatedView(data = {}, panel, currentVideo) {
    const wrap = document.createElement("div");
    wrap.className = "short-video-related";
    const summary = document.createElement("div");
    summary.className = "short-video-related-summary";
    const basis = document.createElement("span");
    const basisTags = Array.isArray(data.basis?.tags) ? data.basis.tags.filter(Boolean).slice(0, 2) : [];
    basis.textContent = basisTags.length
      ? `基于 ${basisTags.map((tag) => `#${tag}`).join(" · ")}`
      : `基于 ${data.basis?.author || currentVideo?.author?.name || "当前作品"}`;
    summary.append(basis);
    wrap.append(summary);

    if (data.error) {
      const error = document.createElement("div");
      error.className = "short-video-related-status is-error";
      const message = document.createElement("span");
      message.textContent = data.error;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重新加载";
      retry.addEventListener("click", () => data.onRetry?.());
      error.append(message, retry);
      wrap.append(error);
      return wrap;
    }
    if (data.loading || !data.loaded) {
      const loading = document.createElement("div");
      loading.className = "short-video-related-status is-loading";
      loading.append(createIcon("repeat"), document.createTextNode("正在匹配本地作品"));
      wrap.append(loading);
      return wrap;
    }

    const candidates = shortVideosWithCovers([
      currentVideo,
      ...(Array.isArray(data.videos) ? data.videos : [])
    ].filter(Boolean));
    const seen = new Set();
    const videos = candidates.filter((item) => {
      const key = String(item?.id || item?.awemeId || "").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const recommendations = videos.filter((item) => !isCurrentShortVideo(item, currentVideo));
    if (!recommendations.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-related-status";
      empty.textContent = "暂时没有可展示的本地相关推荐";
      wrap.append(empty);
      return wrap;
    }

    const count = document.createElement("strong");
    count.textContent = `${formatNumber(recommendations.length)} 条本地推荐`;
    summary.append(count);
    const list = document.createElement("div");
    list.className = "short-video-related-list";
    for (const [index, video] of videos.entries()) {
      const isCurrent = isCurrentShortVideo(video, currentVideo);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-related-item";
      button.classList.toggle("is-current", isCurrent);
      button.dataset.videoId = String(video.id || "");
      button.dataset.awemeId = String(video.awemeId || "");
      if (isCurrent) button.setAttribute("aria-current", "true");
      button.setAttribute("aria-label", `播放推荐：${cardTitle(video)}`);
      const media = document.createElement("span");
      media.className = "short-video-related-media";
      const img = document.createElement("img");
      img.className = "short-video-cover-image";
      img.dataset.src = shortVideoCardCoverUrl(video);
      img.dataset.videoId = video.id;
      img.alt = video.title || "推荐作品封面";
      img.loading = index < 5 ? "eager" : "lazy";
      img.decoding = "async";
      img.fetchPriority = index < 3 ? "high" : "low";
      const type = document.createElement("em");
      type.textContent = isGalleryPost(video) ? galleryLabel(video) : (formatDuration(video.durationMs) || "视频");
      media.append(img, type);
      if (isCurrent) {
        const current = document.createElement("span");
        current.className = "short-video-related-current";
        current.textContent = "播放中";
        media.append(current);
      }

      const copy = document.createElement("span");
      copy.className = "short-video-related-copy";
      const itemTitle = document.createElement("strong");
      itemTitle.textContent = cardTitle(video);
      const metrics = document.createElement("small");
      metrics.className = "short-video-related-meta";
      const likes = document.createElement("span");
      likes.append(createIcon("heart"), document.createTextNode(formatShortVideoMetric(video, "likes")));
      applyShortVideoStatsBadgeState(likes, video);
      const author = document.createElement("span");
      author.className = "short-video-related-author";
      author.textContent = video.author?.name || "未知作者";
      metrics.append(likes, author);
      copy.append(itemTitle, metrics);
      button.append(media, copy);
      const warmRelatedItem = () => {
        if (isCurrent || button.dataset.prefetchStarted === "1" || !button.isConnected) return;
        button.dataset.prefetchStarted = "1";
        button.classList.add("is-prefetching");
        prefetchRelatedVideo(video).then((detail) => {
          if (!button.isConnected || !detail?.video) return;
          button.dataset.detailReady = "1";
          button.classList.add("is-prefetched");
        }).catch(() => {}).finally(() => {
          button.classList.remove("is-prefetching");
        });
      };
      button.addEventListener("pointerenter", warmRelatedItem, { once: true });
      button.addEventListener("focus", warmRelatedItem, { once: true });
      if (!isCurrent && index <= 4) {
        if (typeof window.requestIdleCallback === "function") {
          window.requestIdleCallback(warmRelatedItem, { timeout: 900 });
        } else {
          window.setTimeout(warmRelatedItem, 80 + index * 55);
        }
      }
      button.addEventListener("click", async () => {
        button.classList.add("is-opening");
        panel?.classList.add("is-switching-video");
        try {
          await openRelatedVideo(video, panel, {
            previous: videos[index - 1] || null,
            next: videos[index + 1] || null
          });
        } finally {
          button.classList.remove("is-opening");
          panel?.classList.remove("is-switching-video");
        }
      });
      list.append(button);
    }
    activateShortVideoCovers(list);
    wrap.append(list);
    return wrap;
  }

  async function openRelatedVideo(video, panel, neighbors = {}) {
    if (!video?.id) return;
    if (isCurrentShortVideo(video)) {
      showBrowserToast("正在观看这条");
      return;
    }
    const resolved = resolvedShortVideoDetail(video.id);
    await replaceVideoFromAuthorPanel(resolved?.video || video, panel, neighbors);
  }

  function authorComingSoonView(text) {
    const box = document.createElement("div");
    box.className = "short-video-author-status";
    box.textContent = text;
    return box;
  }

  function authorVideoTile(video, panel, index = 0, options = {}) {
    const isCurrent = Boolean(options.current);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-author-tile";
    button.classList.toggle("is-current", isCurrent);
    button.dataset.videoId = String(video.id || "");
    button.dataset.awemeId = String(video.awemeId || "");
    button.setAttribute("aria-label", video.title || "打开短视频");
    if (isCurrent) button.setAttribute("aria-current", "true");
    const media = document.createElement("span");
    media.className = "short-video-author-tile-media";
    const coverUrl = shortVideoCardCoverUrl(video);
    if (!coverUrl) return null;
    const img = document.createElement("img");
    img.className = "short-video-cover-image";
    img.dataset.src = coverUrl;
    img.dataset.videoId = video.id;
    img.alt = video.title || "短视频封面";
    img.loading = index < coverEagerCount ? "eager" : "lazy";
    img.decoding = "async";
    img.fetchPriority = index < 8 ? "high" : "low";
    media.append(img);
    const meta = document.createElement("span");
    meta.className = "short-video-author-tile-meta";
    const like = document.createElement("span");
    like.className = "short-video-like-badge";
    like.append(createIcon("heart"), document.createTextNode(formatShortVideoMetric(video, "likes")));
    applyShortVideoStatsBadgeState(like, video);
    if (isCurrent) {
      const currentBadge = document.createElement("span");
      currentBadge.className = "short-video-author-current-badge";
      currentBadge.textContent = "当前观看";
      media.append(currentBadge);
    }
    media.append(like);
    if (isGalleryPost(video)) media.append(galleryBadge(video));
    meta.textContent = cardTitle(video);
    button.append(media, meta);
    button.addEventListener("click", () => {
      if (isCurrentShortVideo(video)) {
        showBrowserToast("正在观看这条");
        return;
      }
      if (typeof options.onOpen === "function") {
        Promise.resolve(options.onOpen(video, panel, {
          previous: options.previous || null,
          next: options.next || null
        })).catch(showError);
        return;
      }
      replaceVideoFromAuthorPanel(video, panel, {
        previous: options.previous || null,
        next: options.next || null
      }).catch(showError);
    });
    return button;
  }

  async function replaceVideoFromAuthorPanel(video, panel, neighbors = {}) {
    const videoId = String(video?.id || "").trim();
    if (!videoId || !panel?.isConnected) return;

    const requestId = ++authorPanelVideoRequestId;
    panel.setAttribute("aria-busy", "true");
    state.shortVideo.current = video;
    state.shortVideo.loading = false;
    state.shortVideo.status = "";
    state.shortVideo.slideDirection = 0;
    state.shortVideo.prevVideo = neighbors.previous || null;
    state.shortVideo.nextVideo = neighbors.next || null;
    state.shortVideo.prevId = neighbors.previous?.id || "";
    state.shortVideo.nextId = neighbors.next?.id || "";

    replaceCurrentReelDom(video, { transition: true });
    syncAuthorPanelCurrentTile();
    syncRelatedPanelCurrentItem(panel);
    syncCurrentNavigationDom();
    replaceRoute({ view: "shortVideos", shortVideoId: videoId });
    resumeActiveSound();

    try {
      const data = await fetchShortVideoDetail(videoId);
      if (requestId !== authorPanelVideoRequestId || state.shortVideo.current?.id !== videoId || !panel.isConnected) return;
      state.shortVideo.current = data.video || video;
      cacheAuthorPanelVideo(state.shortVideo.current);
      const currentPanel = els.workGrid?.querySelector?.(".short-video-reel-panel.is-current");
      const needsGallerySoundRefresh = isGalleryPost(state.shortVideo.current)
        && state.shortVideo.current?.sound?.localAvailable
        && state.shortVideo.current?.sound?.previewUrl
        && !currentPanel?.querySelector?.(".short-video-gallery-audio");
      if (needsGallerySoundRefresh) replaceCurrentReelDom(state.shortVideo.current);
      state.shortVideo.prevId = data.prevId || "";
      state.shortVideo.nextId = data.nextId || "";
      await loadAdjacentVideos(videoId);
      if (requestId !== authorPanelVideoRequestId || state.shortVideo.current?.id !== videoId || !panel.isConnected) return;
      refreshAdjacentPanelsDom();
      syncAuthorPanelCurrentTile();
      syncRelatedPanelCurrentItem(panel);
      syncCurrentNavigationDom();
      resumeActiveSound();
    } catch (error) {
      console.warn(error);
      if (requestId === authorPanelVideoRequestId && panel.isConnected) {
        showBrowserToast("已切换视频，详情仍在后台读取");
      }
    } finally {
      if (requestId === authorPanelVideoRequestId && panel.isConnected) {
        panel.removeAttribute("aria-busy");
      }
    }
  }

  function replaceCurrentReelDom(video, options = {}) {
    const stack = activeReelStack();
    if (!stack) return;
    const oldCurrent = stack.querySelector(".short-video-reel-panel.is-current");
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const animateTransition = Boolean(options.transition && oldCurrent && !reducedMotion);
    let outgoing = null;
    if (animateTransition && oldCurrent.classList.contains("is-gallery-post")) {
      outgoing = oldCurrent.cloneNode(true);
      outgoing.classList.remove("is-current", "is-prev", "is-next", "is-ghost-panel");
      outgoing.classList.add("is-transition-outgoing");
      outgoing.setAttribute("aria-hidden", "true");
      outgoing.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
      outgoing.querySelectorAll("audio, video").forEach((element) => element.remove());
      outgoing.querySelectorAll("button, input, a").forEach((element) => {
        element.setAttribute("tabindex", "-1");
        element.setAttribute("aria-hidden", "true");
      });
    }
    disposeShortVideoMedia(stack);
    stack.querySelectorAll(".short-video-reel-panel.is-transition-outgoing").forEach((panel) => panel.remove());
    if (stack._shortVideoDirectTransitionTimer) window.clearTimeout(stack._shortVideoDirectTransitionTimer);
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev", "is-rebasing");
    stack.style.setProperty("--short-video-drag-y", "0px");

    const panels = [];
    if (state.shortVideo.prevVideo) {
      panels.push(renderReelPanel(state.shortVideo.prevVideo, { ghost: true, slot: "prev" }).panel);
    }
    const current = renderReelPanel(video, { slot: "current" });
    if (animateTransition) current.panel.classList.add("is-transition-incoming");
    panels.push(current.panel);
    if (state.shortVideo.nextVideo) {
      panels.push(renderReelPanel(state.shortVideo.nextVideo, { ghost: true, slot: "next" }).panel);
    }
    stack.replaceChildren(...panels);
    if (outgoing) stack.append(outgoing);
    if (animateTransition) {
      let transitionFinished = false;
      const finishTransition = () => {
        if (transitionFinished) return;
        transitionFinished = true;
        window.clearTimeout(stack._shortVideoDirectTransitionTimer);
        stack._shortVideoDirectTransitionTimer = 0;
        current.panel.removeEventListener("animationend", handleTransitionEnd);
        current.panel.classList.remove("is-transition-incoming");
        outgoing?.remove();
        stack.classList.remove("is-direct-switching");
      };
      const handleTransitionEnd = (event) => {
        if (event.target === current.panel) finishTransition();
      };
      stack.classList.add("is-direct-switching");
      current.panel.addEventListener("animationend", handleTransitionEnd);
      stack._shortVideoDirectTransitionTimer = window.setTimeout(finishTransition, 420);
    }
    current.syncPlayToggle();
    if (current.player) {
      window.requestAnimationFrame(() => {
        current.player?.play?.().then(current.syncPlayToggle).catch(current.syncPlayToggle);
      });
    }
  }

  function authorDouyinUrl(author) {
    const url = String(author?.profileUrl || "").trim();
    if (url) return url;
    const secUid = String(author?.secUid || "").trim();
    return secUid ? `https://www.douyin.com/user/${encodeURIComponent(secUid)}` : "";
  }

  function openAuthorDouyinLink(author) {
    const url = authorDouyinUrl(author);
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    showBrowserToast("没有作者主页");
  }

  function authorRailButton(video) {
    const wrap = document.createElement("div");
    wrap.className = "short-video-author-rail";
    const avatar = authorAvatar(video.author, "short-video-author-avatar");
    const profile = railButton("", avatar, "author", video.author?.name ? `作者 ${video.author.name}` : "作者", () => showAuthorPanel(video));
    const follow = createAuthorFollowButton(video, video.author, "rail");
    wrap.append(profile, follow);
    return wrap;
  }

  function railButton(label, icon, kind = "", ariaLabel = "", action = null) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `short-video-rail-button${kind ? ` is-${kind}` : ""}`;
    if (!label) button.classList.add("is-icon-only");
    button.setAttribute("aria-label", ariaLabel || label || kind || "操作");
    if (ariaLabel) button.title = ariaLabel;
    const strong = document.createElement("strong");
    if (icon instanceof Node) strong.append(icon);
    else strong.textContent = icon;
    button.append(strong);
    if (label) {
      const span = document.createElement("span");
      span.textContent = label;
      button.append(span);
    }
    if (action) button.addEventListener("click", action);
    return button;
  }

  function setIconButton(button, iconName, label) {
    if (!button || button.dataset.iconName === iconName) {
      if (button && label) {
        button.setAttribute("aria-label", label);
        button.title = label;
      }
      return;
    }
    button.dataset.iconName = iconName;
    button.textContent = "";
    button.append(createIcon(iconName));
    if (label) {
      button.setAttribute("aria-label", label);
      button.title = label;
    }
  }

  function createIcon(name) {
    const wrap = document.createElement("span");
    wrap.className = `short-video-icon short-video-icon-${name}`;
    wrap.innerHTML = iconMarkup(name);
    return wrap;
  }

  function iconMarkup(name) {
    const line = "fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"";
    const icons = {
      ai: `<svg viewBox="0 0 34 34" aria-hidden="true"><path d="M22.94 21.309l.58 1.364a45.819 45.819 0 0 0 2.125 4.34l.528.947-.108.056-1.077.543-.102.052-.054-.102-.576-1.087a44.077 44.077 0 0 1-.22-.423 7.704 7.704 0 0 0-3.902.001c-.087.169-.154.3-.219.422l-.576 1.087-.054.102-.102-.052-1.077-.543-.108-.056.059-.106.468-.841a45.902 45.902 0 0 0 2.125-4.34l.58-1.364.038-.086.091.017c.482.086.97.086 1.451 0l.093-.017.037.086zm6.011-.019a3.731 3.731 0 0 0-.173.9c-.022.342-.034.69-.034 1.035v3.067c0 .345.012.694.034 1.035l.022.227c.029.226.08.452.151.673l.05.153h-1.92l.049-.153c.095-.295.153-.597.173-.9.022-.345.033-.694.033-1.035v-3.067c0-.34-.01-.689-.033-1.034a3.753 3.753 0 0 0-.173-.9l-.05-.154h1.921l-.05.153zM17.161 5.395l.123.008a4.527 4.527 0 0 1 3.14 1.602 4.367 4.367 0 0 1 1.033 2.978l-.005.109c-.015.284-.063.56-.13.828l-.117.447 1.964-.504.113-.027c2.38-.549 4.824.818 5.465 3.136l.05.184a4.368 4.368 0 0 1-.534 3.265l-.06.097a4.495 4.495 0 0 1-1.965 1.674c-3.71 1.444-5.893-1.51-6.663-3.187l.134-.034 2.236-.575c.033.329.136.661.333.984a2.5 2.5 0 0 0 2.51 1.157l.113-.021a2.456 2.456 0 0 0 1.384-.825l.297-.448a2.37 2.37 0 0 0 .209-1.637l-.018-.075c-.334-1.268-1.63-2.035-2.914-1.753h-.01l-7.51 1.916h-.022a.056.056 0 0 1-.02-.01.048.048 0 0 1-.017-.037l.014-.205.136-2.238c.327.071.682.079 1.054-.008.973-.227 1.74-1.006 1.894-1.992a2.371 2.371 0 0 0-.303-1.578l-.055-.09a2.46 2.46 0 0 0-1.855-1.118l-.076-.006c-1.323-.076-2.469.897-2.596 2.188v.009l-.47 7.62a.047.047 0 0 1-.053.04l-.013-.002-.166-.065-2.15-.83c.169-.284.285-.612.316-.987l.007-.092a2.443 2.443 0 0 0-1.263-2.256l-.084-.043-.105-.048a2.482 2.482 0 0 0-1.508-.155l-.104.024a2.443 2.443 0 0 0-1.683 1.46c-.487 1.219.104 2.59 1.31 3.109l.008.003 7.22 2.797c.03.012.036.048.02.068l-.114.136-1.467 1.759a2.335 2.335 0 0 0-.79-.573l-.068-.03-.086-.034c-.873-.321-1.878-.147-2.566.484l-.069.065a2.407 2.407 0 0 0 .188 3.584 2.49 2.49 0 0 0 3.404-.268l.006-.006 3.485-4.165v3.166l-.5.607v-.004l-1.29 1.543c-1.559 1.868-4.346 2.229-6.28.782l-.092-.07a4.41 4.41 0 0 1-1.668-3.076l-.009-.113a4.384 4.384 0 0 1 1.619-3.688l.357-.297-1.892-.729c-2.323-.895-3.535-3.457-2.656-5.739a4.475 4.475 0 0 1 2.565-2.555 4.577 4.577 0 0 1 4.068.373l.393.244.12-1.995h-.001c.146-2.447 2.248-4.375 4.728-4.258zm4.679 17.909a45.987 45.987 0 0 1-.964 2.191 9.16 9.16 0 0 1 2.417 0 45.878 45.878 0 0 1-.963-2.191l-.245-.6-.245.6z" fill="#fff"/></svg>`,
      check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M20 6 9 17l-5-5"/></svg>`,
      chevronLeft: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M15 18l-6-6 6-6"/></svg>`,
      chevronDown: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M7 10l5 5 5-5"/></svg>`,
      chevronUp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M7 14l5-5 5 5"/></svg>`,
      clearScreen: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M8 4H4v4M16 4h4v4M8 20H4v-4M20 16v4h-4"/><path ${line} d="M9 9h6v6H9z"/></svg>`,
      close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M6 6l12 12M18 6 6 18"/></svg>`,
      comment: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.8571 17.3202C20.8406 15.3333 22 13.2638 22 10.8541C22 5.96406 17.5232 2 12 2C6.47686 2 2 5.96406 2 10.8542C2 16.8002 8 19.2002 11.429 19.2002V20.7211C11.429 22.3041 12.3493 22.1732 13.1196 21.7347C14.586 20.9 17.4106 18.7693 18.8571 17.3202ZM8.57142 11.0778C8.57142 11.8619 7.93154 12.4971 7.1422 12.4971C6.35418 12.4971 5.71427 11.8619 5.71427 11.0778C5.71427 10.2953 6.35418 9.66007 7.1422 9.66007C7.93154 9.66007 8.57142 10.2953 8.57142 11.0778ZM12 12.4971C11.2112 12.4971 10.5715 11.8619 10.5715 11.0778C10.5715 10.2953 11.2111 9.66007 12 9.66007C12.789 9.66007 13.4286 10.2953 13.4286 11.0778C13.4286 11.8619 12.789 12.4971 12 12.4971ZM18.2857 11.0778C18.2857 11.8619 17.6467 12.4971 16.8575 12.4971C16.0683 12.4971 15.4284 11.8619 15.4285 11.0778C15.4285 10.2953 16.0683 9.66007 16.8575 9.66007C17.6467 9.66007 18.2857 10.2953 18.2857 11.0778Z"/></svg>`,
      folderTrash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M3 7.5V6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2.5M4 10h16M9 13h8M10 13l.6 7h2.8l.6-7M11 13v-2h2v2"/></svg>`,
      fullscreen: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5"/></svg>`,
      headphones: `<svg viewBox="0 0 36 36" aria-hidden="true"><path fill="currentColor" fill-opacity=".9" d="M9.68718 12.4801C8.612 14.3927 8.1197 16.7374 8.05821 19.0767C8.23942 18.9661 8.4351 18.8725 8.64383 18.7988L9.16952 18.6132C10.7699 18.0482 12.5315 18.8701 13.1042 20.4491L15.3865 26.7417C15.9591 28.3206 15.126 30.0586 13.5257 30.6236L13 30.8092C11.4155 31.3686 9.85676 30.6485 8.86663 29.2939C8.83318 29.2583 8.80192 29.22 8.7732 29.1788C7.33136 27.1149 6.42117 24.618 6.13186 21.9841C5.75876 18.5873 6.12658 14.6403 7.8929 11.4983C9.70099 8.28189 12.9317 6 17.9885 6C23.0436 6 26.2778 8.27305 28.092 11.4819C29.8643 14.6168 30.2393 18.557 29.8725 21.9536C29.5881 24.5883 28.6825 27.0875 27.2445 29.155C27.2194 29.1911 27.1924 29.2251 27.1636 29.2569C26.1749 30.6354 24.6023 31.3737 23.0035 30.8092L22.4778 30.6236C20.8774 30.0586 20.0443 28.3206 20.617 26.7417L22.8993 20.4491C23.472 18.8701 25.2335 18.0482 26.8339 18.6132L27.3596 18.7988C27.5669 18.8719 27.7613 18.9648 27.9415 19.0744C27.8783 16.7301 27.382 14.3817 26.3001 12.468C24.846 9.89593 22.2949 8.02429 17.9885 8.02428C13.684 8.02428 11.1369 9.90129 9.68718 12.4801Z"/></svg>`,
      images: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect ${line} x="5" y="5" width="15" height="15" rx="2"/><path ${line} d="M5 16l4-4 3 3 2-2 6 6M8.5 9h.01"/><path ${line} d="M3 17V5a2 2 0 0 1 2-2h12"/></svg>`,
      external: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M14 4h6v6M20 4l-9 9"/><path ${line} d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/></svg>`,
      eyeOff: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A10.7 10.7 0 0 1 12 4c5.5 0 9 6 9 6a15.7 15.7 0 0 1-2.1 2.9M6.6 6.6C4.2 8.2 3 10 3 10s3.5 6 9 6c1 0 1.9-.2 2.7-.5"/></svg>`,
      heart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M2.00534 9C2.00179 8.91711 2 8.83376 2 8.75C2 5.57436 4.57436 3 7.75 3C9.43372 3 10.9484 3.72368 12 4.87696C13.0516 3.72368 14.5663 3 16.25 3C19.4256 3 22 5.57436 22 8.75C22 8.83376 21.9982 8.91711 21.9947 9H22C22 13.5738 14.6263 19.141 12.5425 20.6229C12.2133 20.8571 11.7867 20.8571 11.4575 20.6229C9.37369 19.141 2 13.5738 2 9H2.00534Z" fill="currentColor"/></svg>`,
      link: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/></svg>`,
      more: `<svg viewBox="0 0 36 36" aria-hidden="true"><path d="M13.556 17.778a1.778 1.778 0 1 1-3.556 0 1.778 1.778 0 0 1 3.556 0zM19.778 17.778a1.778 1.778 0 1 1-3.556 0 1.778 1.778 0 0 1 3.556 0zM24.222 19.556a1.778 1.778 0 1 0 0-3.556 1.778 1.778 0 0 0 0 3.556z" fill="currentColor"/></svg>`,
      pause: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.8" height="14" rx="1.3" fill="currentColor"/><rect x="13.2" y="5" width="3.8" height="14" rx="1.3" fill="currentColor"/></svg>`,
      play: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.7v12.6c0 .9 1 1.4 1.8.9l9.2-6.3c.7-.5.7-1.5 0-2L9.8 4.8C9 4.3 8 4.8 8 5.7z"/></svg>`,
      pictureInPicture: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect ${line} x="3" y="5" width="18" height="14" rx="2"/><rect x="12" y="11" width="7" height="5" rx="1" fill="currentColor"/></svg>`,
      plusBadge: `<svg viewBox="0 0 32 33" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M16 26.7319C22.6274 26.7319 28 21.3594 28 14.7319C28 8.10452 22.6274 2.73193 16 2.73193C9.37258 2.73193 4 8.10452 4 14.7319C4 21.3594 9.37258 26.7319 16 26.7319Z" fill="#FE2C55"/><path d="M12 15.7319C11.4477 15.7319 11 15.2842 11 14.7319C11 14.1796 11.4477 13.7319 12 13.7319H20C20.5523 13.7319 21 14.1796 21 14.7319C21 15.2842 20.5523 15.7319 20 15.7319H12Z" fill="white"/><path d="M15 10.7319C15 10.1796 15.4477 9.73193 16 9.73193C16.5523 9.73193 17 10.1796 17 10.7319V18.7319C17 19.2842 16.5523 19.7319 16 19.7319C15.4477 19.7319 15 19.2842 15 18.7319V10.7319Z" fill="white"/></svg>`,
      repeat: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M17 2l4 4-4 4"/><path ${line} d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path ${line} d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>`,
      search: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4zM16.1 16.1L21 21"/></svg>`,
      share: `<svg viewBox="0 0 36 36" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M21.8839 9.41656C20.675 8.26037 18.67 9.11717 18.67 10.7899V13.186C18.5357 13.186 18.4029 13.1872 18.2714 13.1895C16.8626 13.1517 12.0185 13.3097 8.61024 16.9648C6.24883 19.4974 5.18753 23.5267 5.25283 25.606C5.19102 27.6796 6.15808 27.4932 6.41822 27.0157C9.39378 21.554 18.67 23.2251 18.67 23.2251V25.4897C18.67 27.1268 20.6019 27.9978 21.8286 26.9138L29.8176 19.855C30.6512 19.1185 30.6767 17.8265 29.8728 17.0576L21.8839 9.41656Z" fill="currentColor"/></svg>`,
      star: `<svg viewBox="0 0 36 36" aria-hidden="true"><path d="M16.5101 7.2579C17.0254 5.84046 18.9746 5.84047 19.4899 7.2579L21.8225 13.6744L28.4762 13.9734C29.946 14.0395 30.5484 15.9463 29.397 16.8884L24.1849 21.153L25.9645 27.7544C26.3577 29.2126 24.7807 30.3911 23.5538 29.5559L18 25.7751L12.4462 29.5559C11.2193 30.3911 9.64234 29.2126 10.0355 27.7544L11.8151 21.153L6.60299 16.8884C5.45162 15.9463 6.05397 14.0395 7.5238 13.9734L14.1775 13.6744L16.5101 7.2579Z" fill="currentColor"/></svg>`,
      trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M3 6h18M8 6V4h8v2M7 6l1 15h8l1-15M10 10v7M14 10v7"/></svg>`,
      volume2: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M4 9v6h4l5 4V5L8 9H4z"/><path ${line} d="M16 8.5a5 5 0 0 1 0 7M19 6a9 9 0 0 1 0 12"/></svg>`,
      volumeX: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M4 9v6h4l5 4V5L8 9H4z"/><path ${line} d="m18 9 4 4M22 9l-4 4"/></svg>`
    };
    return icons[name] || icons.more;
  }

  function appendCaptionText(target, text, video = null) {
    const value = String(text || "");
    const knownTags = (Array.isArray(video?.tags) ? video.tags : [])
      .map((tag) => normalizeShortVideoTopic(tag))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const pattern = /#([^\s#]+)/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(value))) {
      if (match.index > cursor) target.append(document.createTextNode(value.slice(cursor, match.index)));
      const token = String(match[1] || "");
      const recognized = knownTags.find((tag) => token === tag || token.startsWith(tag));
      const topic = normalizeShortVideoTopic(recognized || token.split(/[@＠,，。.!！?？:：;；、()（）\[\]【】{}]/)[0]);
      if (topic) {
        const tag = document.createElement("button");
        tag.type = "button";
        tag.className = "short-video-caption-tag";
        tag.textContent = `#${topic}`;
        tag.title = `查看话题 ${topic}`;
        tag.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!video) return;
          showAuthorPanel(video, { initialTab: "topic", topic, switchAuthorFeed: false }).catch(showError);
        });
        target.append(tag);
        const remainder = token.slice(topic.length);
        if (remainder) target.append(document.createTextNode(remainder));
      } else {
        target.append(document.createTextNode(match[0]));
      }
      cursor = pattern.lastIndex;
    }
    if (cursor < value.length) target.append(document.createTextNode(value.slice(cursor)));
  }

  function captionTitleWithTags(video) {
    const text = String(video?.title || "").trim();
    if (text.includes("#")) return text;
    const tags = Array.isArray(video?.tags) ? video.tags.filter(Boolean).slice(0, 4) : [];
    if (!tags.length) return text;
    return [text, tags.map((tag) => `#${String(tag).replace(/^#/, "")}`).join(" ")].filter(Boolean).join(" ");
  }

  function setBodyClass() {
    document.body.classList.toggle("short-video-view", state.activeView === "shortVideos");
    document.body.classList.toggle("short-video-browser-active", state.activeView === "shortVideos" && Boolean(state.shortVideo?.current || shortVideoOpeningId));
    document.body.classList.toggle(
      "short-video-author-page-active",
      state.activeView === "shortVideos" && isShortVideoAuthorDetailPage() && !state.shortVideo?.current
    );
  }

  function showError(error) {
    state.shortVideo.loading = false;
    state.shortVideo.loadingMore = false;
    state.shortVideo.status = shortVideoFriendlyError(error, "短视频读取失败");
    renderView();
  }

  function handleFacetLoadError(error) {
    state.shortVideo.facetsLoaded = false;
    state.shortVideo.facetsLoading = false;
    const hasVisibleContent = Boolean(state.shortVideo.current || state.shortVideo.data?.videos?.length);
    if (!hasVisibleContent) {
      state.shortVideo.status = shortVideoFriendlyError(error, "短视频筛选暂时不可用");
      renderView();
      return;
    }
    renderStats();
  }

  function handleSummaryLoadError(error) {
    state.shortVideo.summaryLoading = false;
    console.warn(error);
  }

  function shortVideoFriendlyError(error, fallback) {
    const message = String(error?.message || "").trim();
    if (!message) return fallback;
    if (/database disk image|malformed|sqlite/i.test(message)) return "短视频数据正在恢复，请稍后重试";
    if (/failed to fetch|network|timeout/i.test(message)) return fallback;
    return message;
  }

  return {
    applyRouteState,
    enter,
    loadVideos,
    openRouteTarget,
    openVideo,
    renderStats,
    renderView
  };
}

function formatShortVideoMetric(video, key, unknownLabel = "—") {
  if (video?.stats?.known === false) return unknownLabel;
  return formatCompact(video?.stats?.[key] || 0);
}

function applyShortVideoStatsBadgeState(element, video) {
  const unknown = video?.stats?.known === false;
  element?.classList?.toggle("is-unknown", unknown);
  if (unknown) {
    element.setAttribute("aria-label", "点赞统计待补");
    element.title = "统计待补";
  }
}

function formatCompact(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0";
  if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`;
  return String(Math.round(number));
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function readMutedPreference() {
  try {
    return window.localStorage.getItem("fanhao.shortVideo.muted") === "1";
  } catch {
    return false;
  }
}

function writeMutedPreference(muted) {
  try {
    window.localStorage.setItem("fanhao.shortVideo.muted", muted ? "1" : "0");
  } catch {}
}

function readVolumePreference() {
  try {
    return normalizeShortVideoVolume(window.localStorage.getItem("fanhao.shortVideo.volume"));
  } catch {
    return 1;
  }
}

function writeVolumePreference(value) {
  try {
    window.localStorage.setItem("fanhao.shortVideo.volume", String(normalizeShortVideoVolume(value)));
  } catch {}
}

function normalizeShortVideoVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1;
  return Math.max(.01, Math.min(1, Math.round(number * 100) / 100));
}

function readAutoNextPreference() {
  try {
    return window.localStorage.getItem("fanhao.shortVideo.autoNext") === "1";
  } catch {
    return false;
  }
}

function writeAutoNextPreference(enabled) {
  try {
    window.localStorage.setItem("fanhao.shortVideo.autoNext", enabled ? "1" : "0");
  } catch {}
}

function readPlaybackRatePreference() {
  try {
    return normalizePlaybackRate(window.localStorage.getItem("fanhao.shortVideo.playbackRate"));
  } catch {
    return 1;
  }
}

function writePlaybackRatePreference(value) {
  try {
    window.localStorage.setItem("fanhao.shortVideo.playbackRate", String(normalizePlaybackRate(value)));
  } catch {}
}

function normalizePlaybackRate(value) {
  const number = Number(value);
  const allowed = [0.5, 0.75, 1, 1.25, 1.5, 2];
  return allowed.includes(number) ? number : 1;
}

function formatPlaybackRate(value) {
  const rate = normalizePlaybackRate(value);
  return `${Number.isInteger(rate) ? rate : String(rate).replace(/0+$/, "")}x`;
}

function normalizeShortVideoSource(value) {
  const source = String(value || "liked").trim().toLowerCase();
  return ["recommended", "liked", "following", "history", "posts", "authors", "all", "local"].includes(source) ? source : "liked";
}

function normalizeShortVideoSortValue(value) {
  const sort = String(value || "published").trim();
  return ["recommended", "watched", "published", "publishedAsc", "likes", "likesAsc", "comments", "duration"].includes(sort) ? sort : "published";
}

function normalizeShortVideoMedia(value) {
  const media = String(value || "all").trim().toLowerCase();
  return ["video", "gallery"].includes(media) ? media : "all";
}

function normalizeShortVideoTopic(value) {
  return String(value || "").trim().replace(/^#+/, "").slice(0, 48);
}

function normalizeShortVideoSound(value) {
  const sound = String(value || "").trim();
  return /^[A-Za-z0-9_-]{1,1000}$/.test(sound) ? sound : "";
}

function formatDuration(ms) {
  const seconds = Math.round(Number(ms || 0) / 1000);
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  const remain = seconds % 60;
  return minutes ? `${minutes}:${String(remain).padStart(2, "0")}` : `0:${String(remain).padStart(2, "0")}`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatLocalCommentDate(value) {
  if (!value) return "刚刚";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  const now = new Date();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${time}`;
  const day = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return date.getFullYear() === now.getFullYear() ? `${day} ${time}` : `${date.getFullYear()}-${day} ${time}`;
}

function formatSeconds(value) {
  const total = Math.max(0, Math.floor(Number(value || 0)));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function initials(value) {
  return String(value || "?").trim().slice(0, 2).toUpperCase();
}
