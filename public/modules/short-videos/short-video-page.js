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
  let touchLastAt = 0;
  let touchVelocityX = 0;
  let pointerStartX = 0;
  let pointerStartY = 0;
  let pointerDeltaX = 0;
  let pointerDeltaY = 0;
  let pointerHorizontalDragging = false;
  let pointerDragging = false;
  let pointerLastX = 0;
  let pointerLastAt = 0;
  let pointerVelocityX = 0;
  let suppressNextPlayerClick = false;
  let wheelDeltaY = 0;
  let wheelLastAt = 0;
  let wheelResetTimer = 0;
  let wheelIgnoreUntil = 0;
  let wheelLockedDeltaY = 0;
  let queuedAdjacentDirection = 0;
  let eventsInstalled = false;
  let playerClickTimer = 0;
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
  let shortVideoAdjacentRequestId = 0;
  const loadedCoverIds = new Set();
  const shortVideoWatchWrites = new Map();
  const SHORT_VIDEO_WATCH_SAVE_INTERVAL = 4000;
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
    state.shortVideo.query = route.shortVideoQuery || "";
    state.shortVideo.topic = normalizeShortVideoTopic(route.shortVideoTopic);
    state.shortVideo.sound = normalizeShortVideoSound(route.shortVideoSound);
    if (!state.shortVideo.sound) state.shortVideo.soundInfo = null;
    state.shortVideo.authorPage = route.shortVideoAuthorPage || "";
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
    state.shortVideo.loading = true;
    state.shortVideo.status = "正在打开视频";
    if (options.renderLoading !== false) renderView();
    const data = await api(`/api/short-videos/${encodeURIComponent(videoId)}?${shortVideoFeedParams()}`);
    state.shortVideo.current = data.video;
    if (state.shortVideo.sound && data.video?.sound?.key === state.shortVideo.sound) state.shortVideo.soundInfo = data.video.sound;
    state.shortVideo.prevId = data.prevId || "";
    state.shortVideo.nextId = data.nextId || "";
    state.shortVideo.slideDirection = Number(options.slideDirection || 0);
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    state.shortVideo.loading = false;
    state.shortVideo.status = "";
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

  function renderView() {
    ensureState();
    if (!els.workGrid) return;
    resetShortVideoWindow();
    resetLoadMoreObserver();
    resetCoverLoadObserver();
    els.workGrid.innerHTML = "";
    setBodyClass();
    if (state.shortVideo.current) {
      renderBrowser();
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
    text.textContent = "排序";
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
    const authorVideo = (data.videos || []).find((video) => video?.ownerUserId || video?.author?.id) || null;
    const head = document.createElement("section");
    head.className = "short-video-author-page-head";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "short-video-author-page-back";
    back.append(createIcon("chevronLeft"), document.createTextNode("返回作者"));
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
    copy.append(eyebrow, nameRow, identity, signature, stats, libraryMeta);
    const actions = document.createElement("div");
    actions.className = "short-video-author-page-actions";
    const follow = createAuthorFollowButton(authorVideo, author, "page");
    const douyin = document.createElement("button");
    douyin.type = "button";
    douyin.className = "short-video-author-page-secondary";
    douyin.textContent = "打开抖音主页";
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
    const title = document.createElement("h2");
    title.textContent = "作品";
    const summary = document.createElement("span");
    summary.textContent = state.shortVideo.loading
      ? "正在读取"
      : `共 ${formatNumber(data.total || 0)} 条`;
    heading.append(title, summary);

    const filters = document.createElement("div");
    filters.className = "short-video-author-filters";
    const search = shortVideoSearch.renderForm({
      compact: true,
      placeholder: "搜索 TA 的作品",
      ariaLabel: "搜索作者作品",
      params: () => ({ author: state.shortVideo.authorPage || state.shortVideo.author })
    });

    const sourceLabel = document.createElement("label");
    sourceLabel.className = "short-video-author-source-filter";
    const sourceText = document.createElement("span");
    sourceText.textContent = "来源";
    const sourceSelect = document.createElement("select");
    sourceSelect.setAttribute("aria-label", "筛选作者作品来源");
    for (const [value, label] of [
      ["all", "全部本地"],
      ["liked", "我的喜欢"],
      ["posts", "作者发布"],
      ["local", "其他本地"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      sourceSelect.append(option);
    }
    sourceSelect.value = ["all", "liked", "posts", "local"].includes(state.shortVideo.source) ? state.shortVideo.source : "all";
    sourceSelect.addEventListener("change", () => {
      const source = ["all", "liked", "posts", "local"].includes(sourceSelect.value) ? sourceSelect.value : "all";
      if (source === state.shortVideo.source) return;
      state.shortVideo.source = source;
      state.shortVideo.data = null;
      clearShortVideoDeleteSelection();
      loadVideos({ replaceRoute: true }).catch(showError);
    });
    sourceLabel.append(sourceText, sourceSelect);
    filters.append(search, sourceLabel, renderDeleteSelectionActions(data));
    section.append(heading, filters);
    return section;
  }

  function returnToShortVideoAuthorIndex() {
    state.shortVideo.authorPage = "";
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
    return { ...fromFacet, ...fromVideo, name: fromVideo.name || fromFacet.name || authorNameFromFilter(filter) };
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
    like.append(createIcon("heart"), document.createTextNode(formatCompact(video.stats?.likes || 0)));
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
      comments.append(createIcon("comment"), document.createTextNode(formatCompact(video.stats?.comments || 0)));
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
        author.textContent = `@${authorName}`;
        author.title = `查看 ${authorName}`;
        author.disabled = selecting;
        author.addEventListener("click", () => openShortVideoAuthorPage(video.author, video));
        subline.append(author);
      } else {
        const author = document.createElement("span");
        author.className = "short-video-card-author is-static";
        author.textContent = `@${authorName}`;
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
    return Array.isArray(video.galleryImages)
      ? video.galleryImages.filter((item) => item && item.url)
      : [];
  }

  function galleryLabel(video = {}) {
    const count = Number(video.galleryCount || galleryImageEntries(video).length || 0);
    return `${Math.max(1, count)} 张`;
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
    if (!player) return;
    window.requestAnimationFrame(() => {
      player.play().then(syncPlayToggle).catch(() => {
        if (state.shortVideo.muted) {
          player.muted = true;
          player.play().then(syncPlayToggle).catch(syncPlayToggle);
          return;
        }
        player.closest(".short-video-stage")?.classList.add("is-sound-blocked");
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
    if (ghost) panel.setAttribute("aria-hidden", "true");

    const gallery = isGalleryPost(video);
    panel.classList.toggle("is-gallery-post", gallery);
    const backdrop = document.createElement(gallery ? "img" : "video");
    backdrop.className = "short-video-backdrop-video";
    if (gallery) {
      backdrop.classList.add("short-video-backdrop-image");
      backdrop.src = video.coverUrl || galleryImageEntries(video)[0]?.url || "";
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
      player.autoplay = true;
      player.muted = ghost ? true : Boolean(state.shortVideo.muted);
      player.volume = currentShortVideoVolume();
      player.playbackRate = normalizePlaybackRate(state.shortVideo.playbackRate);
      player.playsInline = true;
      player.loop = true;
      player.preload = ghost ? "metadata" : "auto";
      const markVideoReady = () => {
        stage.classList.remove("is-video-loading", "is-video-buffering", "is-video-error");
        stage.classList.add("is-video-ready");
        applyVideoOrientation(panel, stage, player.videoWidth, player.videoHeight);
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
        scheduleAdjacentVideoWarmup(player, video);
      } else {
        syncPlayToggle = attachPrimaryPlayerControls(stage, player, () => rail, video);
      }
    }

    const info = document.createElement("div");
    info.className = "short-video-caption";
    const tools = document.createElement("div");
    tools.className = "short-video-caption-tools";
    const recommend = document.createElement("button");
    recommend.type = "button";
    recommend.className = "short-video-caption-pill";
    recommend.textContent = "相关推荐 ›";
    recommend.addEventListener("click", () => showAuthorPanel(video, {
      initialTab: "related",
      switchAuthorFeed: false
    }));
    const identify = document.createElement("button");
    identify.type = "button";
    identify.className = "short-video-caption-pill short-video-identify-button";
    identify.textContent = "识别内容";
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
    captionToggle.textContent = "展开";
    captionToggle.hidden = true;
    captionToggle.setAttribute("aria-expanded", "false");
    captionToggle.setAttribute("aria-controls", title.id);
    const setCaptionExpanded = (expanded) => {
      captionCopy.classList.toggle("is-expanded", expanded);
      captionToggle.textContent = expanded ? "收起" : "展开";
      captionToggle.setAttribute("aria-expanded", String(expanded));
      if (!expanded) title.scrollTop = 0;
    };
    captionToggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setCaptionExpanded(!captionCopy.classList.contains("is-expanded"));
    });
    captionCopy.append(title, captionToggle);
    const meta = document.createElement("span");
    meta.textContent = [gallery ? `图文 · ${galleryLabel(video)}` : formatDuration(video.durationMs), formatBytes(video.size || 0)].filter(Boolean).join(" · ");
    info.append(tools, author, captionCopy, meta);
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
    window.requestAnimationFrame(() => {
      syncCaptionOverflow();
      window.requestAnimationFrame(syncCaptionOverflow);
    });
    document.fonts?.ready.then(syncCaptionOverflow).catch(() => {});

    const rail = document.createElement("aside");
    rail.className = "short-video-rail";
    rail.append(railButton("识别", createIcon("ai"), "ai", "识别当前内容", () => showAuthorPanel(video, {
      initialTab: "ai",
      switchAuthorFeed: false
    }).catch(showError)));
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
    rail.append(railButton("", createIcon("trash"), "delete", "删除", () => deleteShortVideo(video, { fromBrowser: true })));
    rail.append(railButton("", createIcon("folderTrash"), "delete-group", "删同组", () => deleteShortVideo(video, { fromBrowser: true, scope: "group" })));
    rail.append(railButton(video.sound ? "原声" : "听抖音", createIcon("headphones"), "listen", video.sound ? `原声：${video.sound.title}` : "听抖音", () => {
      if (!video.sound) {
        openDouyinLink(video);
        return;
      }
      showAuthorPanel(video, { initialTab: "sound", switchAuthorFeed: false }).catch(showError);
    }));
    rail.append(railButton("", createIcon("more"), "more", "更多播放设置", (event) => {
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
    wrap.dataset.galleryIndex = "0";
    wrap.dataset.galleryRequestedIndex = "0";
    wrap.dataset.galleryCount = String(images.length);

    const track = document.createElement("div");
    track.className = "short-video-gallery-track";

    const counter = document.createElement("span");
    counter.className = "short-video-gallery-counter";
    counter.setAttribute("aria-live", "polite");

    const loadStatus = document.createElement("span");
    loadStatus.className = "short-video-gallery-load-status";
    loadStatus.setAttribute("role", "status");
    loadStatus.setAttribute("aria-live", "polite");
    loadStatus.setAttribute("aria-hidden", "true");

    const progress = document.createElement("div");
    progress.className = "short-video-gallery-progress";
    progress.setAttribute("role", "tablist");
    progress.setAttribute("aria-label", "图文图片进度");
    const progressButtons = images.map((_, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-label", `查看第 ${index + 1} 张图片`);
      progress.append(button);
      return button;
    });

    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "short-video-gallery-nav is-previous";
    previous.append(createIcon("chevronLeft"));
    previous.setAttribute("aria-label", "上一张图片");

    const next = document.createElement("button");
    next.type = "button";
    next.className = "short-video-gallery-nav is-next";
    next.append(createIcon("chevronLeft"));
    next.setAttribute("aria-label", "下一张图片");

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
    let dragActive = false;
    let dragDirection = 0;
    let dragVisualX = 0;
    let dragPreviewEntry = null;
    let dragPreviewToken = 0;
    let dragSettleTimer = 0;
    const imageCache = new Map();

    const createGalleryImage = (index) => {
      const element = document.createElement("img");
      element.className = "short-video-gallery-image";
      element.alt = `${video.title || "图文作品"}，第 ${index + 1} 张，共 ${images.length} 张`;
      element.draggable = false;
      element.decoding = "async";
      element.dataset.galleryImageIndex = String(index);
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
          element.removeEventListener("load", handleLoad);
          element.removeEventListener("error", handleError);
          if (ready && !entry.cancelled && typeof element.decode === "function") {
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
          element.removeEventListener("load", handleLoad);
          element.removeEventListener("error", handleError);
          element.removeAttribute("src");
          settled = true;
          resolve(null);
        };
        element.addEventListener("load", handleLoad, { once: true });
        element.addEventListener("error", handleError, { once: true });
        element.src = images[index].url;
        if (element.complete && element.naturalWidth) Promise.resolve().then(handleLoad);
      });
      imageCache.set(index, entry);
      return entry;
    };
    const releaseEntry = (entry) => {
      if (!entry || entry.image === image) return false;
      entry.cancelled = true;
      entry.cancel?.();
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
    const preloadAround = (index, direction = 0) => {
      const offsets = direction > 0 ? [1, 2, -1] : (direction < 0 ? [-1, -2, 1] : [-1, 1, -2, 2]);
      const preloadIndexes = offsets
        .map((offset) => index + offset)
        .filter((item) => item >= 0 && item < images.length);
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
      loadStatus.textContent = "";
    };
    const showLoadStatus = (index) => {
      window.clearTimeout(loadStatusTimer);
      window.clearTimeout(loadStatusHideTimer);
      wrap.classList.add("is-image-loading");
      wrap.setAttribute("aria-busy", "true");
      loadStatus.classList.remove("is-visible", "is-error");
      loadStatus.setAttribute("aria-hidden", "true");
      loadStatus.textContent = `正在载入 ${index + 1} / ${images.length}`;
      loadStatusTimer = window.setTimeout(() => {
        if (requestedIndex === index && (!currentReady || currentIndex !== index)) {
          loadStatus.setAttribute("aria-hidden", "false");
          loadStatus.classList.add("is-visible");
        }
      }, 120);
    };
    const showLoadError = (index) => {
      window.clearTimeout(loadStatusTimer);
      window.clearTimeout(loadStatusHideTimer);
      wrap.classList.remove("is-image-loading");
      wrap.setAttribute("aria-busy", "false");
      loadStatus.textContent = `第 ${index + 1} 张暂时无法载入`;
      loadStatus.setAttribute("aria-hidden", "false");
      loadStatus.classList.add("is-visible", "is-error");
      loadStatusHideTimer = window.setTimeout(() => {
        if (requestedIndex === index) {
          loadStatus.classList.remove("is-visible", "is-error");
          loadStatus.setAttribute("aria-hidden", "true");
          loadStatus.textContent = "";
        }
      }, 2200);
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
    const syncCommittedUi = () => {
      const current = images[currentIndex];
      counter.textContent = `${currentIndex + 1} / ${images.length}`;
      wrap.dataset.galleryIndex = String(currentIndex);
      progressButtons.forEach((button, itemIndex) => {
        const active = itemIndex === currentIndex;
        button.classList.toggle("active", active);
        button.classList.toggle("is-past", itemIndex < currentIndex);
        button.setAttribute("aria-selected", String(active));
        if (active) button.setAttribute("aria-current", "true");
        else button.removeAttribute("aria-current");
      });
      if (current) stage?.style.setProperty("--short-video-cover", `url(${JSON.stringify(current.url)})`);
    };
    const syncRequestedUi = () => {
      wrap.dataset.galleryRequestedIndex = String(requestedIndex);
      previous.disabled = requestedIndex <= 0;
      next.disabled = requestedIndex >= images.length - 1;
    };
    const commitImage = (entry, direction = 0, commitOptions = {}) => {
      const nextImage = entry.image;
      nextImage.className = "short-video-gallery-image";
      nextImage.alt = `${video.title || "图文作品"}，第 ${entry.index + 1} 张，共 ${images.length} 张`;
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
      syncCommittedUi();
      syncRequestedUi();
      hideLoadStatus();
      if (commitOptions.animate !== false) animateImage(direction);
      applyVideoOrientation(stage?.closest?.(".short-video-reel-panel"), stage, image.naturalWidth, image.naturalHeight);
      if (ghost) trimImageCache(new Set([currentIndex]));
      else preloadAround(currentIndex, direction);
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
          showLoadError(nextIndex);
          return;
        }
        commitImage(readyEntry, resolvedDirection);
      });
      return true;
    };
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
      const targetIndex = currentIndex + direction;
      if (targetIndex < 0 || targetIndex >= images.length) {
        delete wrap.dataset.galleryDragTarget;
        return;
      }
      wrap.dataset.galleryDragTarget = String(targetIndex);
      const entry = loadImage(targetIndex);
      trimImageCache(new Set([currentIndex, targetIndex]));
      const attach = (readyEntry) => {
        if (!readyEntry || !dragActive || token !== dragPreviewToken || dragDirection !== direction) return;
        if (readyEntry.index !== currentIndex + direction) return;
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
      const targetIndex = currentIndex + direction;
      const canMove = direction && targetIndex >= 0 && targetIndex < images.length;
      const width = Math.max(1, wrap.clientWidth || stage?.clientWidth || 1);
      const bounded = Math.sign(rawDelta) * Math.min(Math.abs(rawDelta), width * 1.06);
      dragVisualX = canMove ? bounded : rawDelta * .22;
      track.style.setProperty("--short-video-gallery-drag-x", `${dragVisualX}px`);
      wrap.dataset.galleryDragX = String(Math.round(dragVisualX));
      return true;
    };
    const settleDrag = (targetX, callback) => {
      dragActive = false;
      wrap.classList.remove("is-gallery-dragging");
      wrap.classList.add("is-gallery-settling");
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
      }, window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? 20 : 230);
    };
    const endDrag = (deltaX, velocityX = 0) => {
      if (!dragActive) return false;
      const rawDelta = Number(deltaX || dragVisualX || 0);
      const direction = rawDelta < 0 ? 1 : (rawDelta > 0 ? -1 : dragDirection);
      const targetIndex = currentIndex + direction;
      const canMove = direction && targetIndex >= 0 && targetIndex < images.length;
      const width = Math.max(1, wrap.clientWidth || stage?.clientWidth || 1);
      const distanceReady = Math.abs(rawDelta) >= Math.min(116, width * .24);
      const velocityReady = Math.abs(Number(velocityX || 0)) >= .5
        && Math.sign(velocityX) === Math.sign(rawDelta)
        && Math.abs(rawDelta) >= 24;
      const shouldCommit = Boolean(canMove && (distanceReady || velocityReady));
      const readyEntry = dragPreviewEntry?.index === targetIndex && dragPreviewEntry.status === "ready"
        ? dragPreviewEntry
        : null;
      const preserveBoundaryNavigation = !canMove && Math.abs(rawDelta) >= 72;
      if (shouldCommit && readyEntry) {
        const settleX = direction > 0 ? -width : width;
        settleDrag(settleX, () => commitImage(readyEntry, direction, { animate: false }));
        return true;
      }
      settleDrag(0, () => {
        clearDragPreview();
        dragDirection = 0;
        if (shouldCommit) show(targetIndex, direction);
      });
      return !preserveBoundaryNavigation;
    };
    const cancelDrag = () => {
      if (!dragActive) return false;
      settleDrag(0, () => {
        clearDragPreview();
        dragDirection = 0;
      });
      return true;
    };
    const move = (delta) => {
      const direction = Math.sign(Number(delta) || 0);
      if (!direction) return false;
      const nextIndex = requestedIndex + direction;
      if (nextIndex < 0 || nextIndex >= images.length) {
        showBoundary(direction);
        return false;
      }
      return Boolean(show(nextIndex, direction));
    };
    wrap.shortVideoGalleryMove = move;
    wrap.shortVideoGalleryDragStart = startDrag;
    wrap.shortVideoGalleryDragMove = updateDrag;
    wrap.shortVideoGalleryDragEnd = endDrag;
    wrap.shortVideoGalleryDragCancel = cancelDrag;
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
    previous.addEventListener("pointerdown", (event) => event.stopPropagation());
    next.addEventListener("pointerdown", (event) => event.stopPropagation());
    if (!ghost) {
      window.requestAnimationFrame(() => {
        persistShortVideoWatch(video, null, { force: true, completed: true });
      });
      stage?.addEventListener("dblclick", (event) => {
        toggleShortVideoAction(state.shortVideo?.current, "like", options.railGetter?.(), { forceActive: true, silent: true });
        showHeartBurst(stage, event);
      });
    }
    const initialEntry = loadImage(0);
    image = initialEntry.image;
    track.append(image);
    wrap.append(track, progress, counter, loadStatus);
    if (images.length > 1) wrap.append(previous, next);
    syncCommittedUi();
    syncRequestedUi();
    show(0);
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
      if (player.readyState >= 2) {
        stage.classList.remove("is-video-loading");
        stage.classList.add("is-video-ready");
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
      const current = Math.max(0, Number(player.currentTime || 0));
      if (Number.isFinite(current)) lastGoodTime = current;
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
      player.addEventListener("play", syncPlayToggle);
      player.addEventListener("play", () => {
        if (!player.muted) stage.classList.remove("is-sound-blocked");
      });
      player.addEventListener("pause", syncPlayToggle);
      player.addEventListener("loadedmetadata", syncPlayToggle);
      player.addEventListener("ended", () => handleAutoNextEnded(player));
      bindHoldToSpeed(stage, player);
      player.addEventListener("click", () => {
        window.clearTimeout(playerClickTimer);
        if (suppressNextPlayerClick) {
          suppressNextPlayerClick = false;
          return;
        }
        if (stage.classList.contains("is-sound-blocked")) {
          restorePlayerSound(player, stage);
          return;
        }
        playerClickTimer = window.setTimeout(togglePlay, 260);
      });
      stage.addEventListener("dblclick", (event) => {
        window.clearTimeout(playerClickTimer);
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

  function bindShortVideoWatchTracking(stage, player, video, options = {}) {
    const videoId = String(video?.id || "").trim();
    if (!videoId || player.dataset.watchTrackingVideoId === videoId) return;
    player.dataset.watchTrackingVideoId = videoId;
    const resumeProgressMs = Math.max(0, Number(video?.watch?.progressMs || 0));
    const resumeCompleted = Boolean(video?.watch?.completed);
    const restore = () => {
      if (player.dataset.watchRestored === "1") return;
      player.dataset.watchRestored = "1";
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
    player.addEventListener("loadedmetadata", restore, { once: true });
    player.addEventListener("playing", () => persistShortVideoWatch(video, player));
    player.addEventListener("pause", () => {
      if (player.dataset.watchRestored === "1") persistShortVideoWatch(video, player, { force: true });
    });
    player.addEventListener("timeupdate", () => {
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
    if (player.readyState >= 1) window.requestAnimationFrame(restore);
  }

  function persistShortVideoWatch(video, player, options = {}) {
    const videoId = String(video?.id || "").trim();
    if (!videoId) return;
    const now = Date.now();
    let write = shortVideoWatchWrites.get(videoId);
    if (!write) {
      write = { inFlight: false, lastSavedAt: 0, pending: null };
      shortVideoWatchWrites.set(videoId, write);
    }
    if (!options.force && now - write.lastSavedAt < SHORT_VIDEO_WATCH_SAVE_INTERVAL) return;
    const progressMs = Math.max(0, Math.round(Number(player?.currentTime || 0) * 1000));
    const payload = { progressMs, completed: Boolean(options.completed) };
    write.lastSavedAt = now;
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
      body: payload
    }).then((data) => {
      if (data?.video) syncShortVideoWatchVideo(data.video);
    }).catch((error) => {
      console.warn("观看进度保存失败", error);
    }).finally(() => {
      write.inFlight = false;
      const pending = write.pending;
      write.pending = null;
      if (pending) dispatchShortVideoWatchWrite(video, write, pending);
    });
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
      if (Math.hypot(deltaX, deltaY) <= 12) return;
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

  function restorePlayerSound(player, stage = player?.closest?.(".short-video-stage")) {
    if (!player) return;
    state.shortVideo.muted = false;
    writeMutedPreference(false);
    player.muted = false;
    player.volume = currentShortVideoVolume();
    stage?.classList.remove("is-sound-blocked");
    player.play?.().catch(() => {
      stage?.classList.add("is-sound-blocked");
      player.muted = true;
      player.play?.().catch(() => {});
    });
  }

  function renderGalleryControlBar(video) {
    const bar = document.createElement("div");
    bar.className = "short-video-control-bar is-gallery";
    const label = document.createElement("span");
    label.className = "short-video-gallery-control-label";
    label.append(createIcon("images"), document.createTextNode(`图文 · ${galleryLabel(video)}`));
    const spacer = document.createElement("span");
    spacer.className = "short-video-gallery-control-spacer";
    const original = document.createElement("button");
    original.type = "button";
    original.className = "short-video-control-original";
    original.textContent = "原图文";
    original.addEventListener("click", () => openDouyinLink(video));
    const full = document.createElement("button");
    full.type = "button";
    full.className = "short-video-control-icon";
    setIconButton(full, "fullscreen", "全屏查看图文");
    full.addEventListener("click", () => {
      els.workGrid?.querySelector?.(".short-video-reel-panel.is-current .short-video-stage")?.requestFullscreen?.().catch(() => {});
    });
    bar.append(label, spacer, original, full);
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
    const full = document.createElement("button");
    full.type = "button";
    full.className = "short-video-control-icon";
    setIconButton(full, "fullscreen", "全屏");
    let scrubbing = false;
    let progressHovering = false;

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

    const sync = (force = false) => {
      const player = activePlayer();
      if (!player) return;
      const duration = Number(player.duration || 0);
      const current = Number(player.currentTime || 0);
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
      time.textContent = `${formatSeconds(current)} / ${formatSeconds(duration)}`;
      const progressValue = duration ? Math.round((current / duration) * 1000) : 0;
      if (!scrubbing) progress.value = String(progressValue);
      progress.style.setProperty("--short-video-progress", `${Math.max(0, Math.min(100, progressValue / 10))}%`);
      progress.setAttribute("aria-valuetext", `${formatSeconds(current)} / ${formatSeconds(duration)}`);
      if (!scrubbing && !progressHovering) updateSeekPreview(progressValue / 1000, duration);
      player.closest(".short-video-stage")?.classList.toggle("is-paused", player.paused);
      syncActivePlaybackMode(player);
    };
    play.addEventListener("click", () => {
      toggleActivePlayer();
      window.requestAnimationFrame(() => sync(true));
    });
    mute.addEventListener("click", () => {
      toggleActiveMute();
      sync(true);
    });
    volume.addEventListener("input", () => {
      setActiveShortVideoVolume(Number(volume.value || 0));
      sync(true);
    });
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
    full.addEventListener("click", () => {
      const player = activePlayer();
      const target = player?.closest(".short-video-stage") || player;
      target?.requestFullscreen?.().catch(() => {});
    });
    progress.addEventListener("pointerenter", (event) => {
      progressHovering = true;
      updateSeekPreviewFromPointer(event);
    });
    progress.addEventListener("pointermove", (event) => {
      progressHovering = true;
      updateSeekPreviewFromPointer(event);
    });
    progress.addEventListener("pointerleave", () => {
      progressHovering = false;
      if (!scrubbing) sync(true);
    });
    progress.addEventListener("pointerdown", (event) => {
      scrubbing = true;
      progressWrap.classList.add("is-scrubbing");
      updateSeekPreviewFromPointer(event);
    });
    progress.addEventListener("pointerup", () => {
      scrubbing = false;
      progressWrap.classList.remove("is-scrubbing");
      sync(true);
    });
    progress.addEventListener("pointercancel", () => {
      scrubbing = false;
      progressWrap.classList.remove("is-scrubbing");
      sync(true);
    });
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
      player.currentTime = ratio * duration;
      updateSeekPreview(ratio, duration);
      sync(true);
    });
    bar.append(play, time, progressWrap, autoNext, rate, original, volumeControl, full);
    bar.shortVideoSync = () => sync(true);
    const tick = () => {
      if (!bar.isConnected) return;
      sync();
      window.setTimeout(tick, 500);
    };
    sync(true);
    window.setTimeout(tick, 500);
    return bar;
  }

  async function openAdjacent(direction) {
    const id = direction < 0 ? state.shortVideo.prevId : state.shortVideo.nextId;
    if (!id) {
      if (queuedAdjacentDirection === direction) queuedAdjacentDirection = 0;
      return;
    }
    if (wheelLocked) {
      queuedAdjacentDirection = direction;
      return;
    }
    const cachedVideo = direction < 0 ? state.shortVideo.prevVideo : state.shortVideo.nextVideo;
    const hasCachedAdjacent = cachedVideo?.id === id;
    const canPromoteVideoPanel = hasCachedAdjacent
      && !isGalleryPost(state.shortVideo.current)
      && !isGalleryPost(cachedVideo);
    flushActiveShortVideoWatch();
    wheelLocked = true;
    wheelDeltaY = 0;
    wheelLockedDeltaY = 0;
    queuedAdjacentDirection = 0;
    wheelIgnoreUntil = Date.now() + 480;
    window.clearTimeout(wheelResetTimer);
    try {
      const adjacentReady = await primeAdjacentSound(direction, cachedVideo);
      if (hasCachedAdjacent && !isGalleryPost(cachedVideo) && !adjacentReady) {
        await waitForVideoFirstFrame(adjacentPlayer(direction), 220);
      }
      await animateActiveStack(direction);
      if (canPromoteVideoPanel) {
        promoteAdjacentPanelDom(direction, cachedVideo);
        await promoteAdjacentMedia(cachedVideo, direction);
      } else if (hasCachedAdjacent) {
        await promoteAdjacentMedia(cachedVideo, direction, { renderCurrent: true });
      } else {
        await openVideo(id, { renderLoading: false });
      }
    } finally {
      wheelIgnoreUntil = Date.now() + 180;
      window.setTimeout(() => {
        wheelLocked = false;
        flushQueuedAdjacent();
      }, 120);
    }
  }

  function flushQueuedAdjacent() {
    const direction = queuedAdjacentDirection;
    queuedAdjacentDirection = 0;
    wheelLockedDeltaY = 0;
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
      timeout: 800
    });
    try {
      player.currentTime = 0;
    } catch {}
    player.muted = Boolean(state.shortVideo.muted);
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
      if (player.readyState >= 1) {
        try {
          player.currentTime = 0;
        } catch {}
      }
    };
    const shouldReload = Boolean(options.forceReload || player.error || !player.currentSrc);
    if (shouldReload) {
      player.src = source;
      player.dataset.streamUrl = source;
      player.load?.();
    }
    player.preload = "auto";
    player.muted = true;
    if (player.readyState >= 2) {
      settleGhost();
      return true;
    }
    const readyPromise = waitForVideoFirstFrame(player, Math.max(200, Number(options.timeout || 1000)));
    player.play?.().catch(() => {});
    const ready = await readyPromise;
    settleGhost();
    return ready || player.readyState >= 2;
  }

  function scheduleAdjacentVideoWarmup(player, video) {
    const startedAt = Date.now();
    const warm = () => {
      if (!player?.isConnected || !player.classList.contains("is-ghost")) return;
      const current = activePlayer();
      if (current && current !== player && current.readyState < 2 && Date.now() - startedAt < 2600) {
        window.setTimeout(warm, 180);
        return;
      }
      warmAdjacentVideoPlayer(player, video, { pauseAfter: true, timeout: 1200 }).catch(() => {});
    };
    window.setTimeout(warm, 160);
  }

  function warmVisibleAdjacentVideoPlayers() {
    const players = els.workGrid?.querySelectorAll?.(".short-video-reel-panel.is-ghost-panel .short-video-player") || [];
    players.forEach((player) => {
      warmAdjacentVideoPlayer(player, null, {
        forceReload: Boolean(player.error),
        pauseAfter: true,
        timeout: 1200
      }).catch(() => {});
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
    stack.getBoundingClientRect();
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        stack.classList.remove("is-rebasing");
        stack.style.removeProperty("transition");
      });
    });

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
          stage.classList.add("is-sound-blocked");
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

    const previousPlayer = outgoing.querySelector(".short-video-player");
    if (previousPlayer) {
      previousPlayer.classList.add("is-ghost");
      previousPlayer.muted = true;
      previousPlayer.pause?.();
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
  }

  async function promoteAdjacentMedia(video, direction, options = {}) {
    const previousCurrent = state.shortVideo.current;
    state.shortVideo.current = video;
    state.shortVideo.slideDirection = 0;
    state.shortVideo.loading = false;
    state.shortVideo.status = "";
    state.shortVideo.prevId = direction > 0 ? previousCurrent?.id || "" : "";
    state.shortVideo.nextId = direction < 0 ? previousCurrent?.id || "" : "";
    state.shortVideo.prevVideo = direction > 0 ? previousCurrent : null;
    state.shortVideo.nextVideo = direction < 0 ? previousCurrent : null;
    replaceRoute({ view: "shortVideos", shortVideoId: video.id });
    syncActiveControlBar();
    if (options.renderCurrent) {
      renderStats();
      renderView();
      resumeActiveSound();
    }

    try {
      const detailPromise = api(`/api/short-videos/${encodeURIComponent(video.id)}?${shortVideoFeedParams()}`);
      const data = await detailPromise;
      if (state.shortVideo.current?.id !== video.id) return;
      state.shortVideo.current = data.video || video;
      state.shortVideo.prevId = data.prevId || "";
      state.shortVideo.nextId = data.nextId || "";
      await loadAdjacentVideos(video.id);
      await wait(80);
      if (state.shortVideo.current?.id === video.id) {
        renderStats();
        refreshAdjacentPanelsDom();
        syncAuthorPanelCurrentTile();
      }
      resumeActiveSound();
    } catch (error) {
      console.warn(error);
      if (state.shortVideo.current?.id === video.id) {
        renderStats();
        refreshAdjacentPanelsDom();
        syncAuthorPanelCurrentTile();
        resumeActiveSound();
      }
    }
  }

  function refreshAdjacentPanelsDom() {
    const stack = activeReelStack();
    if (!stack || !state.shortVideo?.current) {
      renderView();
      return;
    }
    stack.querySelectorAll(".short-video-reel-panel.is-prev, .short-video-reel-panel.is-next").forEach((panel) => panel.remove());
    const currentPanel = stack.querySelector(".short-video-reel-panel.is-current");
    if (!currentPanel) {
      renderView();
      return;
    }
    if (state.shortVideo.prevVideo) {
      stack.insertBefore(renderReelPanel(state.shortVideo.prevVideo, { ghost: true, slot: "prev" }).panel, currentPanel);
    }
    if (state.shortVideo.nextVideo) {
      stack.append(renderReelPanel(state.shortVideo.nextVideo, { ghost: true, slot: "next" }).panel);
    }
    syncCurrentNavigationDom();
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

  function closeAuthorPanel(panel, options = {}) {
    panel?.closest?.(".short-video-browser")?.classList.remove("is-author-panel-open");
    panel?.querySelectorAll?.(".short-video-sound-audio")?.forEach?.((audio) => {
      try {
        audio.pause?.();
        audio.removeAttribute?.("src");
        audio.load?.();
      } catch {}
    });
    authorPanelVideoRequestId += 1;
    panel?.remove();
    if (options.restoreFeed === false) {
      authorPanelReturnFeed = null;
      return;
    }
    restoreAuthorPanelFeed().catch(showError);
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
    const data = await api(`/api/short-videos/${encodeURIComponent(currentId)}?${shortVideoFeedParams()}`);
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
    const tiles = [...grid.querySelectorAll(".short-video-author-tile")];
    for (const tile of tiles) {
      const matchesCurrent = tileMatchesVideo(tile, current);
      tile.classList.toggle("is-current", matchesCurrent);
      if (matchesCurrent) {
        tile.setAttribute("aria-current", "true");
        ensureAuthorCurrentBadge(tile);
      } else {
        tile.removeAttribute("aria-current");
        tile.querySelector(".short-video-author-current-badge")?.remove();
      }
    }
  }

  function tileMatchesVideo(tile, video = {}) {
    if (!tile || !video) return false;
    const id = String(video.id || "").trim();
    if (id && tile.dataset.videoId === id) return true;
    const awemeId = String(video.awemeId || "").trim();
    return Boolean(awemeId && tile.dataset.awemeId === awemeId);
  }

  function ensureAuthorCurrentBadge(tile) {
    const media = tile?.querySelector?.(".short-video-author-tile-media");
    if (!media || media.querySelector(".short-video-author-current-badge")) return;
    const currentBadge = document.createElement("span");
    currentBadge.className = "short-video-author-current-badge";
    currentBadge.textContent = "当前观看";
    media.append(currentBadge);
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function waitForVideoFirstFrame(player, timeout = 260) {
    if (!player || player.readyState >= 2) return Promise.resolve(true);
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
        resolve(ready);
      };
      const onReady = () => done(true);
      player.addEventListener("loadeddata", onReady, { once: true });
      player.addEventListener("canplay", onReady, { once: true });
      player.addEventListener("playing", onReady, { once: true });
      if (player.requestVideoFrameCallback) {
        frameHandle = player.requestVideoFrameCallback(() => done(true));
      }
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
        player.closest(".short-video-stage")?.classList.add("is-sound-blocked");
        player.muted = true;
        player.play?.().catch(() => {});
      });
    });
  }

  function showHome() {
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
      if (isShortVideoOverlayTarget(event.target)) return;
      const touch = event.touches?.[0];
      touchStartX = touch?.clientX || 0;
      touchStartY = touch?.clientY || 0;
      touchLastX = touchStartX;
      touchLastAt = Date.now();
      touchVelocityX = 0;
      touchDeltaX = 0;
      touchDeltaY = 0;
      touchHorizontalDragging = false;
      state.shortVideo.dragging = true;
      activeReelStack()?.classList.add("is-dragging");
    }, { passive: true });
    window.addEventListener("touchmove", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (isShortVideoOverlayTarget(event.target)) return;
      const touch = event.touches?.[0];
      const x = touch?.clientX || 0;
      const y = touch?.clientY || 0;
      const now = Date.now();
      const elapsed = Math.max(1, now - touchLastAt);
      const instantVelocityX = (x - touchLastX) / elapsed;
      touchVelocityX = touchVelocityX * .35 + instantVelocityX * .65;
      touchLastX = x;
      touchLastAt = now;
      touchDeltaX = x - touchStartX;
      touchDeltaY = y - touchStartY;
      if (!touchHorizontalDragging && isHorizontalSwipe(touchDeltaX, touchDeltaY, 28)) {
        touchHorizontalDragging = true;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        startActiveGalleryDrag();
      }
      if (touchHorizontalDragging) updateActiveGalleryDrag(touchDeltaX);
      else applyDragDelta(touchDeltaY);
      event.preventDefault();
    }, { passive: false });
    window.addEventListener("touchend", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (isShortVideoOverlayTarget(event.target)) return;
      const touch = event.changedTouches?.[0];
      const endX = touch?.clientX || 0;
      const endY = touch?.clientY || 0;
      const deltaX = touchDeltaX || endX - touchStartX;
      const deltaY = touchDeltaY || endY - touchStartY;
      if (Date.now() - touchLastAt > 80) touchVelocityX *= Math.max(0, 1 - (Date.now() - touchLastAt - 80) / 180);
      if (touchHorizontalDragging) {
        state.shortVideo.dragging = false;
        touchHorizontalDragging = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        const handled = finishActiveGalleryDrag(deltaX, touchVelocityX);
        if (!handled && isHorizontalSwipe(deltaX, deltaY, 72)) handleHorizontalSwipe(deltaX);
        else if (!handled) finishDrag(0);
        return;
      }
      finishDrag(deltaY);
    }, { passive: true });
    window.addEventListener("touchcancel", () => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      const wasHorizontal = touchHorizontalDragging;
      touchHorizontalDragging = false;
      state.shortVideo.dragging = false;
      activeReelStack()?.classList.remove("is-dragging");
      if (wasHorizontal) cancelActiveGalleryDrag();
      finishDrag(0);
    }, { passive: true });
    window.addEventListener("pointerdown", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (isShortVideoOverlayTarget(event.target)) return;
      if (event.button !== 0 || event.target?.closest?.("button, select, input, textarea, a")) return;
      pointerStartX = event.clientX || 0;
      pointerStartY = event.clientY || 0;
      pointerLastX = pointerStartX;
      pointerLastAt = Date.now();
      pointerVelocityX = 0;
      pointerDeltaX = 0;
      pointerDeltaY = 0;
      pointerHorizontalDragging = false;
      pointerDragging = true;
      state.shortVideo.dragging = true;
      activeReelStack()?.classList.add("is-dragging");
    });
    window.addEventListener("pointermove", (event) => {
      if (!pointerDragging || state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      const x = event.clientX || 0;
      const now = Date.now();
      const elapsed = Math.max(1, now - pointerLastAt);
      const instantVelocityX = (x - pointerLastX) / elapsed;
      pointerVelocityX = pointerVelocityX * .35 + instantVelocityX * .65;
      pointerLastX = x;
      pointerLastAt = now;
      pointerDeltaX = x - pointerStartX;
      pointerDeltaY = (event.clientY || 0) - pointerStartY;
      if (!pointerHorizontalDragging && isHorizontalSwipe(pointerDeltaX, pointerDeltaY, 28)) {
        pointerHorizontalDragging = true;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        startActiveGalleryDrag();
      }
      if (pointerHorizontalDragging) updateActiveGalleryDrag(pointerDeltaX);
      else applyDragDelta(pointerDeltaY);
      event.preventDefault();
    }, { passive: false });
    window.addEventListener("pointerup", () => {
      if (!pointerDragging) return;
      pointerDragging = false;
      if (Math.hypot(pointerDeltaX, pointerDeltaY) > 8) {
        suppressNextPlayerClick = true;
        window.setTimeout(() => {
          suppressNextPlayerClick = false;
        }, 240);
      }
      if (Date.now() - pointerLastAt > 80) pointerVelocityX *= Math.max(0, 1 - (Date.now() - pointerLastAt - 80) / 180);
      if (pointerHorizontalDragging) {
        state.shortVideo.dragging = false;
        pointerHorizontalDragging = false;
        activeReelStack()?.classList.remove("is-dragging");
        snapStackBack();
        const handled = finishActiveGalleryDrag(pointerDeltaX, pointerVelocityX);
        if (!handled && isHorizontalSwipe(pointerDeltaX, pointerDeltaY, 72)) handleHorizontalSwipe(pointerDeltaX);
        else if (!handled) finishDrag(0);
        return;
      }
      finishDrag(pointerDeltaY);
    });
    window.addEventListener("pointercancel", () => {
      if (!pointerDragging) return;
      pointerDragging = false;
      const wasHorizontal = pointerHorizontalDragging;
      pointerHorizontalDragging = false;
      suppressNextPlayerClick = false;
      if (wasHorizontal) cancelActiveGalleryDrag();
      finishDrag(0);
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
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeOrRevealBrowser();
      }
    });
    document.addEventListener("visibilitychange", handleShortVideoVisibilityChange);
    window.addEventListener("pagehide", flushActiveShortVideoWatch);
  }

  function handleShortVideoVisibilityChange() {
    if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
    const players = els.workGrid?.querySelectorAll?.(".short-video-player") || [];
    if (document.hidden) {
      flushActiveShortVideoWatch();
      players.forEach((player) => {
        player.muted = true;
        player.pause?.();
      });
      return;
    }
    const current = activePlayer();
    if (!current) return;
    if (state.shortVideo.muted) {
      current.muted = true;
      current.play?.().catch(() => {});
      return;
    }
    resumeActiveSound();
  }

  function activePlayer() {
    return els.workGrid?.querySelector?.(".short-video-player:not(.is-ghost)") || null;
  }

  function syncActiveControlBar() {
    const bar = els.workGrid?.querySelector?.(".short-video-control-bar:not(.is-gallery)");
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
    const player = activePlayer();
    if (!player) return;
    if (player.paused) player.play().catch(() => {});
    else player.pause();
    player.closest(".short-video-stage")?.classList.remove("is-sound-blocked");
  }

  function currentShortVideoVolume() {
    return normalizeShortVideoVolume(state.shortVideo?.volume ?? readVolumePreference());
  }

  function setActiveShortVideoVolume(percent) {
    const player = activePlayer();
    if (!player) return;
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
    }
    player.closest(".short-video-stage")?.classList.remove("is-sound-blocked");
  }

  function toggleActiveMute() {
    const player = activePlayer();
    if (!player) return;
    player.muted = !player.muted;
    if (!player.muted) player.volume = currentShortVideoVolume();
    state.shortVideo.muted = player.muted;
    writeMutedPreference(player.muted);
    player.closest(".short-video-stage")?.classList.remove("is-sound-blocked");
  }

  function toggleClearScreen() {
    const browser = els.workGrid?.querySelector?.(".short-video-browser");
    browser?.classList.toggle("is-clear-screen");
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

  async function loadAdjacentVideos(videoId) {
    const requestId = ++shortVideoAdjacentRequestId;
    const prevId = state.shortVideo.prevId;
    const nextId = state.shortVideo.nextId;
    const params = shortVideoFeedParams();
    const [prevResult, nextResult] = await Promise.allSettled([
      prevId ? api(`/api/short-videos/${encodeURIComponent(videoId)}/adjacent?direction=prev&${params}`) : Promise.resolve(null),
      nextId ? api(`/api/short-videos/${encodeURIComponent(videoId)}/adjacent?direction=next&${params}`) : Promise.resolve(null)
    ]);
    if (requestId !== shortVideoAdjacentRequestId || state.shortVideo.current?.id !== videoId) return false;
    state.shortVideo.prevVideo = prevResult.status === "fulfilled" ? prevResult.value?.video || null : null;
    state.shortVideo.nextVideo = nextResult.status === "fulfilled" ? nextResult.value?.video || null : null;
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
    const damped = hasTarget ? deltaY : deltaY * 0.22;
    const stack = activeReelStack();
    if (stack) stack.style.setProperty("--short-video-drag-y", `${damped}px`);
  }

  function handleWheelSwipe(deltaY) {
    const now = Date.now();
    if (wheelLocked || now < wheelIgnoreUntil || Math.abs(deltaY) < 2) {
      if ((wheelLocked || now < wheelIgnoreUntil) && Math.abs(deltaY) >= 2) {
        wheelLockedDeltaY = Math.max(-180, Math.min(180, wheelLockedDeltaY + deltaY));
        if (Math.abs(wheelLockedDeltaY) >= 85) {
          queuedAdjacentDirection = wheelLockedDeltaY > 0 ? 1 : -1;
          wheelLockedDeltaY = 0;
        }
      }
      if (wheelLocked || now < wheelIgnoreUntil) {
        wheelDeltaY = 0;
        window.clearTimeout(wheelResetTimer);
      }
      return;
    }
    if (now - wheelLastAt > 260 || Math.sign(wheelDeltaY) !== Math.sign(deltaY)) {
      wheelDeltaY = 0;
    }
    wheelLastAt = now;
    wheelDeltaY = Math.max(-180, Math.min(180, wheelDeltaY + deltaY));
    const visualDelta = wheelDeltaY * -0.55;
    activeReelStack()?.classList.add("is-dragging");
    applyDragDelta(visualDelta);
    window.clearTimeout(wheelResetTimer);
    wheelResetTimer = window.setTimeout(() => {
      wheelDeltaY = 0;
      snapStackBack();
    }, 160);
    if (Math.abs(wheelDeltaY) < 95) return;
    const direction = wheelDeltaY > 0 ? 1 : -1;
    wheelDeltaY = 0;
    activeReelStack()?.classList.remove("is-dragging");
    openAdjacent(direction).catch(showError);
  }

  function finishDrag(deltaY) {
    const direction = deltaY < 0 ? 1 : -1;
    state.shortVideo.dragging = false;
    activeReelStack()?.classList.remove("is-dragging");
    if (Math.abs(deltaY) < 78 || (direction > 0 && !state.shortVideo.nextId) || (direction < 0 && !state.shortVideo.prevId)) {
      snapStackBack();
      return;
    }
    openAdjacent(direction).catch(showError);
  }

  function snapStackBack() {
    const stack = activeReelStack();
    if (!stack) return;
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev", "is-rebasing");
    stack.style.setProperty("--short-video-drag-y", "0px");
  }

  function animateActiveStack(direction) {
    const stack = activeReelStack();
    if (!stack) return Promise.resolve();
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev");
    stack.style.setProperty("--short-video-drag-y", "0px");
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
      stack.classList.add(direction > 0 ? "is-snap-next" : "is-snap-prev");
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      stack.addEventListener("transitionend", finish, { once: true });
      window.setTimeout(finish, 380);
      window.requestAnimationFrame(() => {
        stack.classList.add(direction > 0 ? "is-snap-next" : "is-snap-prev");
      });
    });
  }

  function railMetric(icon, value, kind = "", label = "", action = null) {
    const button = railButton(formatCompact(value || 0), createIcon(icon), kind, label, action);
    button.dataset.metricValue = String(Number(value || 0));
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
    button.classList.toggle(actionType === "like" ? "is-liked" : "is-active", enabled);
    button.dataset.metricValue = String(metric);
    button.setAttribute("aria-pressed", String(enabled));
    const label = actionType === "like"
      ? (enabled ? "取消点赞" : "点赞")
      : (enabled ? "取消收藏" : "收藏");
    button.setAttribute("aria-label", label);
    button.title = label;
    const valueLabel = button.querySelector(":scope > span");
    if (valueLabel) valueLabel.textContent = formatCompact(metric);
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
    return [title, author ? `@${author}` : "", url].filter(Boolean).join("\n");
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
    heading.textContent = "播放设置";
    headingWrap.append(eyebrow, heading);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "short-video-more-close";
    close.append(createIcon("close"));
    close.setAttribute("aria-label", "关闭播放设置");
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
    actions.className = "short-video-more-actions";
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
      const target = activePlayer()?.closest?.(".short-video-stage")
        || els.workGrid?.querySelector?.(".short-video-reel-panel.is-current .short-video-stage");
      closePlaybackSettings(overlay, { restoreFocus: false });
      target?.requestFullscreen?.().catch(() => showBrowserToast("全屏启动失败"));
    });

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
    actions.append(pip, fullscreen, autoNext, clearScreen, copyLink, original, dislike, deleteCurrent, deleteGroup);

    const shortcuts = document.createElement("section");
    shortcuts.className = "short-video-shortcuts";
    const shortcutsTitle = document.createElement("strong");
    shortcutsTitle.textContent = "快捷操作";
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
    shortcuts.append(shortcutsTitle, shortcutGrid);

    sheet.append(header, speedSection, actions, shortcuts);
    overlay.append(sheet);
    browser.append(overlay);
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
    const players = els.workGrid?.querySelectorAll?.(".short-video-player") || [];
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
    mediaType.textContent = isGalleryPost(video) ? `图文 · ${galleryLabel(video)}` : (formatDuration(video.durationMs) || "视频");
    media.append(mediaType);
    const previewCopy = document.createElement("div");
    const previewTitle = document.createElement("strong");
    previewTitle.textContent = title;
    const previewAuthor = document.createElement("span");
    previewAuthor.textContent = authorName ? `@${authorName}` : "本地作品";
    const previewMeta = document.createElement("small");
    previewMeta.textContent = `${formatCompact(video?.stats?.likes || 0)} 赞 · ${formatCompact(video?.stats?.comments || 0)} 评论`;
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
          text: [title, authorName ? `@${authorName}` : ""].filter(Boolean).join("\n"),
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

    const linkSection = document.createElement("section");
    linkSection.className = "short-video-share-link";
    const linkCopy = document.createElement("div");
    const linkLabel = document.createElement("strong");
    linkLabel.textContent = "本地观看地址";
    const linkHint = document.createElement("span");
    const localOnly = ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
    linkHint.textContent = localOnly ? "当前地址仅这台设备可用" : "同一局域网可直接打开";
    linkCopy.append(linkLabel, linkHint);
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
    linkSection.append(linkCopy, linkField);

    const note = document.createElement("p");
    note.className = "short-video-share-note";
    note.append(createIcon("check"), document.createTextNode("分享只复制地址或调用系统面板，不会自动发布内容"));

    sheet.append(header, preview, actionSection, linkSection, note);
    overlay.append(sheet);
    browser.append(overlay);
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
    name.textContent = `@${video.author?.name || "未知作者"}`;
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
    if (existingPanel) closeAuthorPanel(existingPanel, { restoreFeed: false });
    authorPanelReturnFeed = shortVideoFeedSnapshot();
    const author = video.author || {};
    const selectedTopic = normalizeShortVideoTopic(options.topic || video.tags?.[0]);
    const selectedSound = options.sound || video.sound || null;
    const panel = document.createElement("section");
    panel.className = "short-video-author-panel is-douyin-style";
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

    const top = document.createElement("div");
    top.className = "short-video-author-top";
    const tabs = document.createElement("div");
    tabs.className = "short-video-author-tabs";
    const tabButtons = new Map();
    const tabItems = [
      ["detail", "详情"],
      ["works", "TA的作品"],
      ["comments", "评论"],
      ["ai", "识别"],
      ["related", "相关推荐"]
    ];
    if (selectedSound) tabItems.splice(4, 0, ["sound", "原声"]);
    if (selectedTopic) tabItems.splice(4, 0, ["topic", "话题"]);
    for (const item of tabItems) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item[1];
      button.dataset.tab = item[0];
      button.addEventListener("click", () => renderAuthorTab(item[0], { userInitiated: true }));
      tabButtons.set(item[0], button);
      tabs.append(button);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "short-video-author-close";
    close.append(createIcon("close"));
    close.setAttribute("aria-label", "关闭");
    close.addEventListener("click", () => closeAuthorPanel(panel));
    top.append(tabs, close);

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
    sheet.append(top, head, content);
    panel.append(sheet);
    browser.classList.add("is-author-panel-open");
    browser.append(panel);

    let authorVideos = [];
    let authorTotal = 0;
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
      if (authorFeedSwitchStarted || !authorScopeId(video, author)) return;
      authorFeedSwitchStarted = true;
      switchToAuthorWorksFeed(video, author).catch(showError);
    };
    const loadRelatedRecommendations = async (force = false) => {
      if (relatedLoading || (relatedLoaded && !force)) return;
      relatedLoading = true;
      relatedError = "";
      try {
        const data = await api(`/api/short-videos/${encodeURIComponent(video.id)}/related?limit=36`);
        if (!panel.isConnected) return;
        relatedItems = Array.isArray(data.videos) ? data.videos : [];
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
      for (const [key, button] of tabButtons) {
        button.classList.toggle("active", key === tab);
        button.setAttribute("aria-selected", String(key === tab));
      }
      content.innerHTML = "";
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
        }, panel, video));
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

    try {
      const params = new URLSearchParams();
      if (author.secUid) params.set("author", author.secUid);
      params.set("source", "all");
      params.set("sort", state.shortVideo.sort || "published");
      params.set("limit", "36");
      params.set("facets", "0");
      const data = author.secUid ? await api(`/api/short-videos?${params}`) : { videos: [video], total: 1 };
      authorVideos = data.videos || [];
      authorTotal = Number(data.total || authorVideos.length || 0);
      const richerAuthor = authorVideos.find((item) => authorHasProfileMeta(item.author))?.author || authorVideos[0]?.author;
      if (richerAuthor) Object.assign(author, richerAuthor);
      refreshAuthorHeader();
      const homeCount = profileNumber(author.awemeCount);
      sub.textContent = homeCount !== null
        ? `${formatNumber(authorTotal)} 个本地作品 / 主页 ${formatNumber(homeCount)}`
        : `${formatNumber(authorTotal)} 个本地作品`;
      renderAuthorTab(activeTab);
    } catch (error) {
      status.textContent = "读取失败";
      showError(error);
    }
  }

  async function switchToAuthorWorksFeed(video, author = {}) {
    const authorId = authorScopeId(video, author);
    if (!authorId || !isCurrentShortVideo(video)) return;
    state.shortVideo.author = authorId;
    if (!isShortVideoAuthorDetailPage()) state.shortVideo.source = "all";
    state.shortVideo.query = "";
    state.shortVideo.topic = "";
    state.shortVideo.sound = "";
    state.shortVideo.soundInfo = null;
    if (!isShortVideoAuthorDetailPage()) state.shortVideo.sort = "published";
    state.shortVideo.data = null;
    const data = await api(`/api/short-videos/${encodeURIComponent(video.id)}?${shortVideoFeedParams()}`);
    if (!isCurrentShortVideo(video)) return;
    state.shortVideo.current = data.video || state.shortVideo.current;
    state.shortVideo.prevId = data.prevId || "";
    state.shortVideo.nextId = data.nextId || "";
    await loadAdjacentVideos(state.shortVideo.current.id);
    if (!isCurrentShortVideo(video)) return;
    renderStats();
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
        if (tile) grid.append(tile);
      }
    }
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
    authorLine.textContent = `@${author.name || "未知作者"} ›`;
    authorLine.addEventListener("click", () => openAuthorDouyinLink(author));
    const profile = authorProfileBlock(author);
    const title = document.createElement("p");
    appendCaptionText(title, captionTitleWithTags(video), video);
    const stats = document.createElement("div");
    stats.className = "short-video-author-detail-stats";
    for (const item of [
      ["点赞", formatCompact(video.stats?.likes || 0)],
      ["评论", formatCompact(video.stats?.comments || 0)],
      ["收藏", formatCompact(video.stats?.collects || 0)],
      ["分享", formatCompact(video.stats?.shares || 0)],
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
    remoteTitle.textContent = commentCount ? "抖音评论正文未同步" : "原视频暂无评论正文";
    const remoteMessage = document.createElement("p");
    remoteMessage.textContent = commentCount
      ? `保留了 ${formatCompact(commentCount)} 条评论统计；不会显示或伪造未下载的评论。`
      : "当前资料库没有保存原视频评论正文。";
    remoteCopy.append(remoteTitle, remoteMessage);
    remote.append(remoteIcon, remoteCopy);

    const metric = document.createElement("div");
    metric.className = "short-video-comments-metric";
    const metricValue = document.createElement("strong");
    metricValue.textContent = formatCompact(commentCount);
    const metricLabel = document.createElement("span");
    metricLabel.textContent = "抖音评论数";
    metric.append(metricValue, metricLabel);

    const actions = document.createElement("div");
    actions.className = "short-video-comments-actions";
    const open = document.createElement("button");
    open.type = "button";
    open.className = "is-primary";
    open.textContent = "去抖音看评论";
    open.disabled = !originalUrl;
    open.title = originalUrl ? "打开抖音原视频" : "当前作品没有原始链接";
    open.addEventListener("click", () => openDouyinLink(video));
    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = originalUrl ? "复制原视频链接" : "复制本地链接";
    copy.addEventListener("click", () => {
      const value = originalUrl || localShortVideoUrl(video);
      copyShortVideoValue(value, originalUrl ? "已复制抖音原链接" : "已复制本地链接").catch(() => {});
    });
    actions.append(open, copy);

    const note = document.createElement("div");
    note.className = "short-video-comments-note";
    note.append(createIcon("check"), document.createTextNode("“我的本地评论”只保存在这台设备，不会发布到抖音"));

    scroll.append(localSection, remote, metric, actions, note);

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
    textarea.placeholder = "留下只保存在本机的评论…";
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
      const data = await api(`/api/short-videos/${encodeURIComponent(video.id)}?${shortVideoFeedParams()}`);
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
      const data = await api(`/api/short-videos/${encodeURIComponent(video.id)}?${shortVideoFeedParams()}`);
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
    mediaBadge.textContent = gallery ? `图文 · ${galleryLabel(video)}` : "短视频";
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
      author.textContent = `@${video.author.name}`;
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
          reason.textContent = item.recommendation?.reason || `@${item.author?.name || "未知作者"}`;
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
    const heading = document.createElement("div");
    heading.className = "short-video-related-heading";
    const title = document.createElement("strong");
    title.textContent = "相关推荐";
    const basis = document.createElement("span");
    const basisTags = Array.isArray(data.basis?.tags) ? data.basis.tags.filter(Boolean).slice(0, 2) : [];
    basis.textContent = basisTags.length
      ? `基于 ${basisTags.map((tag) => `#${tag}`).join(" · ")}`
      : `基于 ${data.basis?.author || currentVideo?.author?.name || "当前作品"}`;
    heading.append(title, basis);
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
      loading.append(createIcon("repeat"), document.createTextNode("正在匹配本地作品"));
      wrap.append(loading);
      return wrap;
    }

    const videos = shortVideosWithCovers(Array.isArray(data.videos) ? data.videos : []);
    if (!videos.length) {
      const empty = document.createElement("div");
      empty.className = "short-video-related-status";
      empty.textContent = "暂时没有可展示的本地相关推荐";
      wrap.append(empty);
      return wrap;
    }

    const count = document.createElement("div");
    count.className = "short-video-related-count";
    count.textContent = `${formatNumber(videos.length)} 条本地推荐`;
    const list = document.createElement("div");
    list.className = "short-video-related-list";
    for (const [index, video] of videos.entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-related-item";
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

      const copy = document.createElement("span");
      copy.className = "short-video-related-copy";
      const itemTitle = document.createElement("strong");
      itemTitle.textContent = cardTitle(video);
      const author = document.createElement("span");
      author.textContent = `@${video.author?.name || "未知作者"}`;
      const reason = document.createElement("span");
      reason.className = "short-video-related-reason";
      reason.textContent = video.recommendation?.reason || "本地推荐";
      const metrics = document.createElement("small");
      const likes = document.createElement("span");
      likes.append(createIcon("heart"), document.createTextNode(formatCompact(video.stats?.likes || 0)));
      const comments = document.createElement("span");
      comments.append(createIcon("comment"), document.createTextNode(formatCompact(video.stats?.comments || 0)));
      metrics.append(likes, comments);
      copy.append(itemTitle, author, reason, metrics);
      button.append(media, copy, createIcon("chevronLeft"));
      button.addEventListener("click", () => openRelatedVideo(video, panel));
      list.append(button);
    }
    activateShortVideoCovers(list);
    wrap.append(count, list);
    return wrap;
  }

  function openRelatedVideo(video, panel) {
    if (!video?.id) return;
    if (isCurrentShortVideo(video)) {
      showBrowserToast("正在观看这条");
      return;
    }
    if (authorPanelReturnFeed) applyShortVideoFeedSnapshot(authorPanelReturnFeed);
    closeAuthorPanel(panel, { restoreFeed: false });
    openVideo(video.id).catch(showError);
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
    like.append(createIcon("heart"), document.createTextNode(formatCompact(video.stats?.likes || 0)));
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

    replaceCurrentReelDom(video);
    syncAuthorPanelCurrentTile();
    syncCurrentNavigationDom();
    replaceRoute({ view: "shortVideos", shortVideoId: videoId });
    resumeActiveSound();

    try {
      const data = await api(`/api/short-videos/${encodeURIComponent(videoId)}?${shortVideoFeedParams()}`);
      if (requestId !== authorPanelVideoRequestId || state.shortVideo.current?.id !== videoId || !panel.isConnected) return;
      state.shortVideo.current = data.video || video;
      state.shortVideo.prevId = data.prevId || "";
      state.shortVideo.nextId = data.nextId || "";
      await loadAdjacentVideos(videoId);
      if (requestId !== authorPanelVideoRequestId || state.shortVideo.current?.id !== videoId || !panel.isConnected) return;
      renderStats();
      refreshAdjacentPanelsDom();
      syncAuthorPanelCurrentTile();
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

  function replaceCurrentReelDom(video) {
    const stack = activeReelStack();
    if (!stack) return;
    stack.querySelectorAll("video").forEach((player) => {
      player.muted = true;
      player.pause?.();
    });
    stack.classList.remove("is-dragging", "is-snap-next", "is-snap-prev", "is-rebasing");
    stack.style.setProperty("--short-video-drag-y", "0px");

    const panels = [];
    if (state.shortVideo.prevVideo) {
      panels.push(renderReelPanel(state.shortVideo.prevVideo, { ghost: true, slot: "prev" }).panel);
    }
    const current = renderReelPanel(video, { slot: "current" });
    panels.push(current.panel);
    if (state.shortVideo.nextVideo) {
      panels.push(renderReelPanel(state.shortVideo.nextVideo, { ghost: true, slot: "next" }).panel);
    }
    stack.replaceChildren(...panels);
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
    document.body.classList.toggle("short-video-browser-active", state.activeView === "shortVideos" && Boolean(state.shortVideo?.current));
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
