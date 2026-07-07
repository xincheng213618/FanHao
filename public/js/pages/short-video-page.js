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
  let touchStartY = 0;
  let touchDeltaY = 0;
  let pointerStartY = 0;
  let pointerDeltaY = 0;
  let pointerDragging = false;
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
  const SV_MIN_COL = 176;
  const SV_COL_GAP = 10;
  const SV_ROW_GAP = 14;
  const SV_BUFFER_ROWS = 12;
  const SV_APPEND_LOOKAHEAD_ROWS = 18;
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
  const loadedCoverIds = new Set();

  function ensureState() {
    if (!state.shortVideo) state.shortVideo = {};
    state.shortVideo.query = state.shortVideo.query || "";
    state.shortVideo.author = state.shortVideo.author || "all";
    state.shortVideo.source = normalizeShortVideoSource(state.shortVideo.source);
    state.shortVideo.sort = state.shortVideo.sort || "published";
    state.shortVideo.data = state.shortVideo.data || null;
    state.shortVideo.summary = state.shortVideo.summary || null;
    state.shortVideo.authors = Array.isArray(state.shortVideo.authors) ? state.shortVideo.authors : [];
    state.shortVideo.facetsLoaded = Boolean(state.shortVideo.facetsLoaded);
    state.shortVideo.facetsLoading = Boolean(state.shortVideo.facetsLoading);
    state.shortVideo.current = state.shortVideo.current || null;
    state.shortVideo.prevVideo = state.shortVideo.prevVideo || null;
    state.shortVideo.nextVideo = state.shortVideo.nextVideo || null;
    state.shortVideo.dragging = Boolean(state.shortVideo.dragging);
    if (typeof state.shortVideo.muted !== "boolean") {
      state.shortVideo.muted = readMutedPreference();
    }
    if (typeof state.shortVideo.autoNext !== "boolean") {
      state.shortVideo.autoNext = readAutoNextPreference();
    }
    state.shortVideo.prevId = state.shortVideo.prevId || "";
    state.shortVideo.nextId = state.shortVideo.nextId || "";
    state.shortVideo.slideDirection = Number(state.shortVideo.slideDirection || 0);
    state.shortVideo.loading = Boolean(state.shortVideo.loading);
    state.shortVideo.loadingMore = Boolean(state.shortVideo.loadingMore);
    state.shortVideo.status = state.shortVideo.status || "";
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
    }
    loadShortVideoFacets().catch(showError);
    syncRouteAfterNavigation(options);
  }

  function applyRouteState(route = {}) {
    ensureState();
    state.shortVideo.query = route.shortVideoQuery || "";
    state.shortVideo.author = route.shortVideoAuthor || "all";
    state.shortVideo.source = normalizeShortVideoSource(route.shortVideoSource);
    state.shortVideo.sort = route.shortVideoSort || "published";
  }

  async function openRouteTarget(route = {}) {
    ensureState();
    if (route.shortVideoId) {
      await openVideo(route.shortVideoId, { skipRoute: true });
      return;
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
    if (state.shortVideo.author && state.shortVideo.author !== "all") params.set("author", state.shortVideo.author);
    params.set("source", state.shortVideo.source || "liked");
    params.set("sort", state.shortVideo.sort || "published");
    params.set("limit", String(append ? appendVideoLimit : initialVideoLimit));
    params.set("facets", "0");
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
    state.shortVideo.source = normalizeShortVideoSource(data.source || state.shortVideo.source);
    if (Array.isArray(data.authors) && data.authors.length) state.shortVideo.authors = data.authors;
    state.shortVideo.summary = data.summary || state.shortVideo.summary;
    state.shortVideo.loading = false;
    state.shortVideo.loadingMore = false;
    state.shortVideo.status = data.total ? "" : "还没有短视频。";
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
    if (!append) loadShortVideoFacets().catch(showError);
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
    renderView();
    const data = await api(`/api/short-videos/${encodeURIComponent(videoId)}?${shortVideoFeedParams()}`);
    state.shortVideo.current = data.video;
    state.shortVideo.prevId = data.prevId || "";
    state.shortVideo.nextId = data.nextId || "";
    state.shortVideo.slideDirection = Number(options.slideDirection || 0);
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    await loadAdjacentVideos(data.video.id);
    state.shortVideo.loading = false;
    state.shortVideo.status = "";
    renderStats();
    renderView();
    resumeActiveSound();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    if (!options.skipRoute) pushRoute({ view: "shortVideos", shortVideoId: data.video.id });
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
    shell.append(renderHomeToolbar(data));
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
      const empty = document.createElement("div");
      empty.className = "short-video-empty";
      empty.textContent = state.shortVideo.loading
        ? "正在读取短视频"
        : (data.videos || []).length
          ? "封面补齐前暂不显示这些短视频。"
          : state.shortVideo.status || "没有匹配的短视频。";
      grid.append(empty);
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

  function renderHomeToolbar(data = {}) {
    const toolbar = document.createElement("div");
    toolbar.className = "short-video-home-toolbar";
    const tabs = document.createElement("div");
    tabs.className = "short-video-source-tabs";
    tabs.setAttribute("role", "tablist");
    for (const item of [
      ["liked", "我的喜欢"],
      ["posts", "作者作品"],
      ["all", "全部"]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-source-tab";
      const active = (state.shortVideo.source || "liked") === item[0];
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
      button.textContent = item[1];
      button.addEventListener("click", () => {
        if ((state.shortVideo.source || "liked") === item[0]) return;
        state.shortVideo.source = item[0];
        state.shortVideo.current = null;
        state.shortVideo.data = null;
        loadVideos({ replaceRoute: true }).catch(showError);
      });
      tabs.append(button);
    }
    const total = document.createElement("div");
    total.className = "short-video-home-total";
    total.textContent = `${formatNumber(data.total || 0)} 条`;
    toolbar.append(tabs, total);
    return toolbar;
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
    svCols = Math.max(1, Math.floor((gw + SV_COL_GAP) / (SV_MIN_COL + SV_COL_GAP)));
    svCardW = (gw - (svCols - 1) * SV_COL_GAP) / svCols;
    if (!svCardH) svCardH = Math.round(svCardW * 14 / 9) + 24;
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
    const thumb = document.createElement("button");
    thumb.type = "button";
    thumb.className = "short-video-thumb";
    thumb.setAttribute("aria-label", video.title || "打开短视频");
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
    thumb.append(img);
    const like = document.createElement("span");
    like.className = "short-video-like-badge";
    like.append(createIcon("heart"), document.createTextNode(formatCompact(video.stats?.likes || 0)));
    thumb.append(like);
    thumb.addEventListener("click", () => openVideo(video.id).catch(showError));
    const title = document.createElement("div");
    title.className = "short-video-card-title";
    title.textContent = cardTitle(video);
    card.append(thumb, title);
    return card;
  }

  function shortVideoCardCoverUrl(video = {}) {
    return video.coverUrl || "";
  }

  function shortVideosWithCovers(videos = []) {
    return (videos || []).filter((video) => shortVideoCardCoverUrl(video));
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
    setIconButton(back, "close", "关闭");
    back.addEventListener("click", showHome);
    const search = document.createElement("button");
    search.type = "button";
    search.className = "short-video-browser-search";
    search.setAttribute("aria-label", "返回列表搜索短视频");
    search.append(createIcon("search"));
    const searchText = document.createElement("span");
    searchText.className = "short-video-browser-search-text";
    searchText.textContent = state.shortVideo.query || "搜索你感兴趣的内容";
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
    page.append(top, stack, renderBrowserNav(), renderControlBar());
    els.workGrid.append(page);
    syncPlayToggle();
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

    const backdrop = document.createElement("video");
    backdrop.className = "short-video-backdrop-video";
    backdrop.src = video.streamUrl;
    backdrop.muted = true;
    backdrop.playsInline = true;
    backdrop.loop = true;
    backdrop.preload = "auto";
    if (video.coverUrl) backdrop.poster = video.coverUrl;
    if (!ghost) window.requestAnimationFrame(() => backdrop.play().catch(() => {}));

    const stage = document.createElement("div");
    stage.className = "short-video-stage is-video-loading";
    applyVideoOrientation(panel, stage, video.width, video.height);
    if (video.coverUrl) {
      stage.style.setProperty("--short-video-cover", `url(${JSON.stringify(video.coverUrl)})`);
    }
    const player = document.createElement("video");
    player.className = "short-video-player";
    if (ghost) player.classList.add("is-ghost");
    player.src = video.streamUrl;
    if (video.coverUrl) player.poster = video.coverUrl;
    player.controls = false;
    player.autoplay = true;
    player.muted = ghost ? true : Boolean(state.shortVideo.muted);
    player.playsInline = true;
    player.loop = true;
    player.preload = "auto";
    const markVideoReady = () => {
      stage.classList.remove("is-video-loading");
      stage.classList.add("is-video-ready");
      applyVideoOrientation(panel, stage, player.videoWidth, player.videoHeight);
    };
    player.addEventListener("loadedmetadata", markVideoReady, { once: true });
    player.addEventListener("loadeddata", markVideoReady, { once: true });
    player.addEventListener("canplay", markVideoReady, { once: true });
    player.addEventListener("playing", markVideoReady, { once: true });
    window.requestAnimationFrame(() => {
      if (player.readyState >= 2) markVideoReady();
    });

    let syncPlayToggle = () => {};
    if (ghost) {
      stage.append(player);
    } else {
      syncPlayToggle = attachPrimaryPlayerControls(stage, player, () => rail);
    }

    const info = document.createElement("div");
    info.className = "short-video-caption";
    const tools = document.createElement("div");
    tools.className = "short-video-caption-tools";
    const recommend = document.createElement("button");
    recommend.type = "button";
    recommend.className = "short-video-caption-pill";
    recommend.textContent = "点击推荐 ›";
    recommend.addEventListener("click", () => showBrowserToast("已标记为感兴趣"));
    const identify = document.createElement("button");
    identify.type = "button";
    identify.className = "short-video-caption-pill short-video-identify-button";
    identify.textContent = "识别画面";
    identify.addEventListener("click", () => showBrowserToast("识别能力待接入"));
    tools.append(recommend, identify);
    const author = authorCaptionButton(video);
    const title = document.createElement("p");
    appendCaptionText(title, captionTitleWithTags(video));
    const meta = document.createElement("span");
    meta.textContent = [formatDuration(video.durationMs), formatBytes(video.size || 0)].filter(Boolean).join(" · ");
    info.append(tools, author, title, meta);
    panel.append(backdrop, stage, info);

    const rail = document.createElement("aside");
    rail.className = "short-video-rail";
    rail.append(railButton("", createIcon("ai"), "ai", "AI", () => showBrowserToast("AI 能力待接入")));
    rail.append(authorRailButton(video));
    const likeButton = railMetric("heart", video.stats?.likes, "like", "点赞");
    if (!ghost) {
      likeButton.addEventListener("click", (event) => {
        activateLikeButton(likeButton);
        showHeartBurst(stage, event);
      });
    }
    rail.append(likeButton);
    rail.append(railMetric("comment", video.stats?.comments, "comment", "评论", ghost ? null : () => showBrowserToast("评论暂未导入")));
    rail.append(railMetric("star", video.stats?.collects, "collect", "收藏", ghost ? null : toggleRailActive));
    rail.append(railMetric("share", video.stats?.shares, "share", "分享", ghost ? null : () => shareShortVideo(video)));
    rail.append(railButton("听抖音", createIcon("headphones"), "listen", "听抖音", () => openDouyinLink(video)));
    rail.append(railButton("", createIcon("more"), "more", "更多", () => showBrowserToast("更多操作待接入")));
    panel.append(rail);

    return { panel, player, syncPlayToggle };
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

  function attachPrimaryPlayerControls(stage, player, railGetter) {
    const syncPlayToggle = () => {
      stage.classList.toggle("is-paused", player.paused);
    };
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
        playerClickTimer = window.setTimeout(togglePlay, 180);
      });
      stage.addEventListener("dblclick", (event) => {
        window.clearTimeout(playerClickTimer);
        activateLikeButton(railGetter?.());
        showHeartBurst(stage, event);
      });
    }
    stage.append(player);
    syncActivePlaybackMode(player);
    syncPlayToggle();
    return syncPlayToggle;
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
  }

  function restorePlayerSound(player, stage = player?.closest?.(".short-video-stage")) {
    if (!player) return;
    state.shortVideo.muted = false;
    writeMutedPreference(false);
    player.muted = false;
    player.volume = 1;
    stage?.classList.remove("is-sound-blocked");
    player.play?.().catch(() => {
      stage?.classList.add("is-sound-blocked");
      player.muted = true;
      player.play?.().catch(() => {});
    });
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
    const autoNext = document.createElement("button");
    autoNext.type = "button";
    autoNext.className = "short-video-control-auto";
    autoNext.textContent = "连播";
    autoNext.title = "自动播放下一条";
    const original = document.createElement("button");
    original.type = "button";
    original.className = "short-video-control-original";
    original.textContent = "原视频";
    original.title = "打开抖音原视频";
    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "short-video-control-icon";
    setIconButton(mute, "volumeX", "取消静音");
    const full = document.createElement("button");
    full.type = "button";
    full.className = "short-video-control-icon";
    setIconButton(full, "fullscreen", "全屏");
    let scrubbing = false;

    const sync = (force = false) => {
      const player = activePlayer();
      if (!player) return;
      const duration = Number(player.duration || 0);
      const current = Number(player.currentTime || 0);
      setIconButton(play, player.paused ? "play" : "pause", player.paused ? "播放" : "暂停");
      setIconButton(mute, player.muted ? "volumeX" : "volume2", player.muted ? "取消静音" : "静音");
      autoNext.classList.toggle("active", Boolean(state.shortVideo?.autoNext));
      autoNext.setAttribute("aria-pressed", String(Boolean(state.shortVideo?.autoNext)));
      autoNext.setAttribute("aria-label", state.shortVideo?.autoNext ? "关闭连播" : "开启连播");
      const originalUrl = originalDouyinUrl(state.shortVideo?.current);
      original.disabled = !originalUrl;
      original.classList.toggle("is-unavailable", !originalUrl);
      original.setAttribute("aria-label", originalUrl ? "打开抖音原视频" : "当前视频没有原始链接");
      time.textContent = `${formatSeconds(current)} / ${formatSeconds(duration)}`;
      const progressValue = duration ? Math.round((current / duration) * 1000) : 0;
      if (!scrubbing) progress.value = String(progressValue);
      progress.style.setProperty("--short-video-progress", `${Math.max(0, Math.min(100, progressValue / 10))}%`);
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
    autoNext.addEventListener("click", () => {
      state.shortVideo.autoNext = !state.shortVideo.autoNext;
      writeAutoNextPreference(state.shortVideo.autoNext);
      syncActivePlaybackMode();
      showBrowserToast(state.shortVideo.autoNext ? "已开启连播" : "已关闭连播");
      sync(true);
    });
    original.addEventListener("click", () => openDouyinLink(state.shortVideo?.current));
    full.addEventListener("click", () => {
      const player = activePlayer();
      const target = player?.closest(".short-video-stage") || player;
      target?.requestFullscreen?.().catch(() => {});
    });
    progress.addEventListener("pointerdown", () => {
      scrubbing = true;
    });
    progress.addEventListener("pointerup", () => {
      scrubbing = false;
      sync(true);
    });
    progress.addEventListener("input", () => {
      const player = activePlayer();
      if (!player) return;
      const duration = Number(player.duration || 0);
      if (!duration) return;
      player.currentTime = (Number(progress.value || 0) / 1000) * duration;
      sync(true);
    });
    bar.append(play, time, progress, autoNext, original, mute, full);
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
    wheelLocked = true;
    wheelDeltaY = 0;
    wheelLockedDeltaY = 0;
    queuedAdjacentDirection = 0;
    wheelIgnoreUntil = Date.now() + 480;
    window.clearTimeout(wheelResetTimer);
    try {
      primeAdjacentSound(direction);
      if (cachedVideo?.id === id) {
        await waitForVideoFirstFrame(adjacentPlayer(direction), 220);
      }
      await animateActiveStack(direction);
      if (cachedVideo?.id === id) {
        promoteAdjacentPanelDom(direction);
        await promoteAdjacentVideo(cachedVideo, direction);
      } else {
        await openVideo(id);
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

  function primeAdjacentSound(direction) {
    if (state.shortVideo.muted) return;
    const player = adjacentPlayer(direction);
    if (!player) return;
    player.muted = false;
    player.volume = 1;
    player.play?.().catch(() => {});
  }

  function adjacentPlayer(direction) {
    const selector = direction > 0
      ? ".short-video-reel-panel.is-next .short-video-player"
      : ".short-video-reel-panel.is-prev .short-video-player";
    return els.workGrid?.querySelector?.(selector) || null;
  }

  function promoteAdjacentPanelDom(direction) {
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
    outgoing.classList.remove("is-current");
    outgoing.classList.add(direction > 0 ? "is-prev" : "is-next", "is-ghost-panel");
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
      player.volume = 1;
      if (player.dataset.primaryControlsBound !== "1") {
        attachPrimaryPlayerControls(stage, player, () => incoming.querySelector(".short-video-rail"));
      }
      const likeButton = incoming.querySelector(".short-video-rail-button.is-like");
      if (likeButton && !likeButton.dataset.boundPrimaryLike) {
        likeButton.dataset.boundPrimaryLike = "1";
        likeButton.addEventListener("click", (event) => {
          activateLikeButton(likeButton);
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

    const previousPlayer = outgoing.querySelector(".short-video-player");
    if (previousPlayer) {
      previousPlayer.classList.add("is-ghost");
      previousPlayer.muted = true;
      previousPlayer.pause?.();
      try {
        previousPlayer.currentTime = 0;
      } catch {}
    }
  }

  async function promoteAdjacentVideo(video, direction) {
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
      }
      resumeActiveSound();
    } catch (error) {
      console.warn(error);
      if (state.shortVideo.current?.id === video.id) {
        renderStats();
        refreshAdjacentPanelsDom();
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
      player.volume = 1;
      player.play?.().catch(() => {
        player.closest(".short-video-stage")?.classList.add("is-sound-blocked");
        player.muted = true;
        player.play?.().catch(() => {});
      });
    });
  }

  function showHome() {
    state.shortVideo.current = null;
    state.shortVideo.prevVideo = null;
    state.shortVideo.nextVideo = null;
    state.shortVideo.prevId = "";
    state.shortVideo.nextId = "";
    state.shortVideo.slideDirection = 0;
    setBodyClass();
    renderStats();
    renderView();
    pushRoute({ view: "shortVideos", shortVideoId: "" });
  }

  function showHomeAndFocusSearch() {
    showHome();
    window.requestAnimationFrame(() => {
      const input = els.workGrid?.querySelector?.(".short-video-search input");
      input?.focus?.({ preventScroll: true });
      input?.select?.();
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
      touchStartY = event.touches?.[0]?.clientY || 0;
      touchDeltaY = 0;
      state.shortVideo.dragging = true;
      activeReelStack()?.classList.add("is-dragging");
    }, { passive: true });
    window.addEventListener("touchmove", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (isShortVideoOverlayTarget(event.target)) return;
      const y = event.touches?.[0]?.clientY || 0;
      touchDeltaY = y - touchStartY;
      applyDragDelta(touchDeltaY);
      event.preventDefault();
    }, { passive: false });
    window.addEventListener("touchend", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (isShortVideoOverlayTarget(event.target)) return;
      const endY = event.changedTouches?.[0]?.clientY || 0;
      const delta = touchDeltaY || endY - touchStartY;
      finishDrag(delta);
    }, { passive: true });
    window.addEventListener("pointerdown", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (isShortVideoOverlayTarget(event.target)) return;
      if (event.button !== 0 || event.target?.closest?.("button, select, input, textarea, a")) return;
      pointerStartY = event.clientY || 0;
      pointerDeltaY = 0;
      pointerDragging = true;
      state.shortVideo.dragging = true;
      activeReelStack()?.classList.add("is-dragging");
    });
    window.addEventListener("pointermove", (event) => {
      if (!pointerDragging || state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      pointerDeltaY = (event.clientY || 0) - pointerStartY;
      applyDragDelta(pointerDeltaY);
      event.preventDefault();
    }, { passive: false });
    window.addEventListener("pointerup", () => {
      if (!pointerDragging) return;
      pointerDragging = false;
      if (Math.abs(pointerDeltaY) > 8) {
        suppressNextPlayerClick = true;
        window.setTimeout(() => {
          suppressNextPlayerClick = false;
        }, 240);
      }
      finishDrag(pointerDeltaY);
    });
    window.addEventListener("pointercancel", () => {
      if (!pointerDragging) return;
      pointerDragging = false;
      suppressNextPlayerClick = false;
      finishDrag(0);
    });
    window.addEventListener("keydown", (event) => {
      if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
      if (event.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "ArrowDown" || event.key === "PageDown") {
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
  }

  function handleShortVideoVisibilityChange() {
    if (state.activeView !== "shortVideos" || !state.shortVideo?.current) return;
    const players = els.workGrid?.querySelectorAll?.(".short-video-player") || [];
    if (document.hidden) {
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

  function toggleActivePlayer() {
    const player = activePlayer();
    if (!player) return;
    if (player.paused) player.play().catch(() => {});
    else player.pause();
    player.closest(".short-video-stage")?.classList.remove("is-sound-blocked");
  }

  function toggleActiveMute() {
    const player = activePlayer();
    if (!player) return;
    player.muted = !player.muted;
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
    const authorPanel = browser?.querySelector?.(".short-video-author-panel");
    if (authorPanel) {
      authorPanel.remove();
      return;
    }
    if (browser?.classList.contains("is-clear-screen")) {
      browser.classList.remove("is-clear-screen");
      return;
    }
    showHome();
  }

  function isShortVideoOverlayTarget(target) {
    return Boolean(target?.closest?.(".short-video-author-sheet, .short-video-share-panel"));
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
    const params = shortVideoFeedParams();
    const [prevResult, nextResult] = await Promise.allSettled([
      state.shortVideo.prevId ? api(`/api/short-videos/${encodeURIComponent(videoId)}/adjacent?direction=prev&${params}`) : Promise.resolve(null),
      state.shortVideo.nextId ? api(`/api/short-videos/${encodeURIComponent(videoId)}/adjacent?direction=next&${params}`) : Promise.resolve(null)
    ]);
    state.shortVideo.prevVideo = prevResult.status === "fulfilled" ? prevResult.value?.video || null : null;
    state.shortVideo.nextVideo = nextResult.status === "fulfilled" ? nextResult.value?.video || null : null;
  }

  function shortVideoFeedParams() {
    const params = new URLSearchParams();
    if (state.shortVideo.query) params.set("q", state.shortVideo.query);
    if (state.shortVideo.author && state.shortVideo.author !== "all") params.set("author", state.shortVideo.author);
    params.set("source", state.shortVideo.source || "liked");
    params.set("sort", state.shortVideo.sort || "published");
    return params.toString();
  }

  function activeReelStack() {
    return els.workGrid?.querySelector?.(".short-video-reel-stack") || null;
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

  function activateLikeButton(target) {
    const likeButton = target?.matches?.(".short-video-rail-button.is-like")
      ? target
      : target?.querySelector?.(".short-video-rail-button.is-like");
    if (!likeButton) return;
    if (!likeButton.classList.contains("is-liked")) {
      const nextValue = Number(likeButton.dataset.metricValue || 0) + 1;
      likeButton.dataset.metricValue = String(nextValue);
      const valueLabel = likeButton.querySelector("span");
      if (valueLabel) valueLabel.textContent = formatCompact(nextValue);
    }
    likeButton.classList.add("is-liked");
  }

  function toggleRailActive(event) {
    const button = event?.currentTarget;
    if (!button) return;
    const active = button.classList.toggle("is-active");
    button.setAttribute("aria-pressed", String(active));
    if (active) {
      const nextValue = Number(button.dataset.metricValue || 0) + 1;
      button.dataset.metricValue = String(nextValue);
      const valueLabel = button.querySelector("span");
      if (valueLabel) valueLabel.textContent = formatCompact(nextValue);
    }
  }

  function originalDouyinUrl(video) {
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

  async function shareShortVideo(video) {
    const url = originalDouyinUrl(video) || `${window.location.origin}/short-videos/${encodeURIComponent(video?.id || "")}`;
    try {
      if (navigator.clipboard?.writeText) {
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          fallbackCopyText(url);
        }
      } else {
        fallbackCopyText(url);
      }
      showBrowserToast("已复制链接");
    } catch {
      showSharePanel(url);
    }
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
    const browser = els.workGrid?.querySelector?.(".short-video-browser");
    if (!browser) return;
    browser.querySelector(".short-video-toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "short-video-toast";
    toast.textContent = message;
    browser.append(toast);
    window.setTimeout(() => toast.remove(), 1500);
  }

  function showSharePanel(url) {
    const browser = els.workGrid?.querySelector?.(".short-video-browser");
    if (!browser) return;
    browser.querySelector(".short-video-share-panel")?.remove();
    const panel = document.createElement("div");
    panel.className = "short-video-share-panel";
    const label = document.createElement("strong");
    label.textContent = "分享链接";
    const input = document.createElement("input");
    input.value = url;
    input.readOnly = true;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.addEventListener("click", () => panel.remove());
    panel.append(label, input, close);
    browser.append(panel);
    window.requestAnimationFrame(() => {
      input.focus({ preventScroll: true });
      input.select();
    });
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
    button.addEventListener("click", () => showAuthorPanel(video));
    return button;
  }

  function authorAvatar(author = {}, className = "short-video-author-avatar") {
    const avatar = document.createElement("span");
    avatar.className = className;
    if (author?.avatarUrl) {
      const img = document.createElement("img");
      img.src = author.avatarUrl;
      img.alt = author?.name || "作者";
      avatar.append(img);
    } else {
      avatar.textContent = initials(author?.name || "?");
    }
    return avatar;
  }

  async function showAuthorPanel(video) {
    const browser = els.workGrid?.querySelector?.(".short-video-browser");
    if (!browser) return;
    browser.querySelector(".short-video-author-panel")?.remove();
    const author = video.author || {};
    const panel = document.createElement("section");
    panel.className = "short-video-author-panel is-douyin-style";
    panel.addEventListener("click", (event) => {
      if (event.target === panel) panel.remove();
    });

    const sheet = document.createElement("div");
    sheet.className = "short-video-author-sheet";

    const top = document.createElement("div");
    top.className = "short-video-author-top";
    const tabs = document.createElement("div");
    tabs.className = "short-video-author-tabs";
    const tabButtons = new Map();
    for (const item of [
      ["detail", "详情"],
      ["works", "TA的作品"],
      ["comments", "评论"],
      ["ai", "问AI"],
      ["related", "相关推荐"]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item[1];
      button.dataset.tab = item[0];
      button.addEventListener("click", () => renderAuthorTab(item[0]));
      tabButtons.set(item[0], button);
      tabs.append(button);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "short-video-author-close";
    close.append(createIcon("close"));
    close.setAttribute("aria-label", "关闭");
    close.addEventListener("click", () => panel.remove());
    top.append(tabs, close);

    const head = document.createElement("header");
    head.className = "short-video-author-head";
    head.append(authorAvatar(author, "short-video-author-head-avatar"));
    const title = document.createElement("div");
    title.className = "short-video-author-title";
    const name = document.createElement("strong");
    name.textContent = author.name || "未知作者";
    const sub = document.createElement("span");
    sub.textContent = "读取中";
    title.append(name, sub);

    const actions = document.createElement("div");
    actions.className = "short-video-author-actions";
    const douyin = document.createElement("button");
    douyin.type = "button";
    douyin.textContent = "抖音主页";
    douyin.addEventListener("click", () => openAuthorDouyinLink(author));
    const filter = document.createElement("button");
    filter.type = "button";
    filter.textContent = "全部视频";
    filter.addEventListener("click", () => {
      if (!author.secUid) return;
      panel.remove();
      state.shortVideo.author = author.secUid;
      state.shortVideo.source = "all";
      state.shortVideo.query = "";
      state.shortVideo.current = null;
      loadVideos({ replaceRoute: true }).catch(showError);
    });
    actions.append(douyin, filter);
    head.append(title, actions);

    const content = document.createElement("div");
    content.className = "short-video-author-content";
    const status = document.createElement("div");
    status.className = "short-video-author-status";
    status.textContent = "正在读取";
    content.append(status);
    sheet.append(top, head, content);
    panel.append(sheet);
    browser.append(panel);

    let authorVideos = [];
    let authorTotal = 0;
    let activeTab = "works";
    const renderAuthorTab = (tab) => {
      activeTab = tab;
      for (const [key, button] of tabButtons) {
        button.classList.toggle("active", key === tab);
        button.setAttribute("aria-selected", String(key === tab));
      }
      content.innerHTML = "";
      if (tab === "works") {
        content.append(authorWorksView(authorVideos, authorTotal, panel));
        return;
      }
      if (tab === "detail") {
        content.append(authorDetailView(video, author));
        return;
      }
      content.append(authorComingSoonView({
        comments: "评论还没有导入",
        ai: "问 AI 待接入",
        related: "相关推荐待接入"
      }[tab] || "内容待接入"));
    };
    renderAuthorTab(activeTab);

    try {
      const params = new URLSearchParams();
      if (author.secUid) params.set("author", author.secUid);
      params.set("sort", "published");
      params.set("limit", "36");
      params.set("facets", "0");
      const data = author.secUid ? await api(`/api/short-videos?${params}`) : { videos: [video], total: 1 };
      authorVideos = data.videos || [];
      authorTotal = Number(data.total || authorVideos.length || 0);
      sub.textContent = `${formatNumber(authorTotal)} 个本地作品`;
      renderAuthorTab(activeTab);
    } catch (error) {
      status.textContent = "读取失败";
      showError(error);
    }
  }

  function authorWorksView(videos, total, panel) {
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
        const tile = authorVideoTile(item, panel, index);
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
    const title = document.createElement("p");
    appendCaptionText(title, captionTitleWithTags(video));
    const stats = document.createElement("div");
    stats.className = "short-video-author-detail-stats";
    for (const item of [
      ["点赞", formatCompact(video.stats?.likes || 0)],
      ["评论", formatCompact(video.stats?.comments || 0)],
      ["收藏", formatCompact(video.stats?.collects || 0)],
      ["分享", formatCompact(video.stats?.shares || 0)],
      ["时长", formatDuration(video.durationMs) || "-"],
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
    detail.append(authorLine, title, stats, actions);
    return detail;
  }

  function authorComingSoonView(text) {
    const box = document.createElement("div");
    box.className = "short-video-author-status";
    box.textContent = text;
    return box;
  }

  function authorVideoTile(video, panel, index = 0) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-author-tile";
    button.setAttribute("aria-label", video.title || "打开短视频");
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
    media.append(like);
    meta.textContent = cardTitle(video);
    button.append(media, meta);
    button.addEventListener("click", () => {
      panel.remove();
      openVideo(video.id).catch(showError);
    });
    return button;
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
    const avatar = authorAvatar(video.author, "short-video-author-avatar");
    const plus = document.createElement("span");
    plus.className = "short-video-author-plus";
    plus.append(createIcon("plusBadge"));
    avatar.append(plus);
    return railButton("", avatar, "author", video.author?.name ? `作者 ${video.author.name}` : "作者", () => showAuthorPanel(video));
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
      chevronDown: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M7 10l5 5 5-5"/></svg>`,
      chevronUp: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M7 14l5-5 5 5"/></svg>`,
      close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M6 6l12 12M18 6 6 18"/></svg>`,
      comment: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.8571 17.3202C20.8406 15.3333 22 13.2638 22 10.8541C22 5.96406 17.5232 2 12 2C6.47686 2 2 5.96406 2 10.8542C2 16.8002 8 19.2002 11.429 19.2002V20.7211C11.429 22.3041 12.3493 22.1732 13.1196 21.7347C14.586 20.9 17.4106 18.7693 18.8571 17.3202ZM8.57142 11.0778C8.57142 11.8619 7.93154 12.4971 7.1422 12.4971C6.35418 12.4971 5.71427 11.8619 5.71427 11.0778C5.71427 10.2953 6.35418 9.66007 7.1422 9.66007C7.93154 9.66007 8.57142 10.2953 8.57142 11.0778ZM12 12.4971C11.2112 12.4971 10.5715 11.8619 10.5715 11.0778C10.5715 10.2953 11.2111 9.66007 12 9.66007C12.789 9.66007 13.4286 10.2953 13.4286 11.0778C13.4286 11.8619 12.789 12.4971 12 12.4971ZM18.2857 11.0778C18.2857 11.8619 17.6467 12.4971 16.8575 12.4971C16.0683 12.4971 15.4284 11.8619 15.4285 11.0778C15.4285 10.2953 16.0683 9.66007 16.8575 9.66007C17.6467 9.66007 18.2857 10.2953 18.2857 11.0778Z"/></svg>`,
      fullscreen: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5"/></svg>`,
      headphones: `<svg viewBox="0 0 36 36" aria-hidden="true"><path fill="currentColor" fill-opacity=".9" d="M9.68718 12.4801C8.612 14.3927 8.1197 16.7374 8.05821 19.0767C8.23942 18.9661 8.4351 18.8725 8.64383 18.7988L9.16952 18.6132C10.7699 18.0482 12.5315 18.8701 13.1042 20.4491L15.3865 26.7417C15.9591 28.3206 15.126 30.0586 13.5257 30.6236L13 30.8092C11.4155 31.3686 9.85676 30.6485 8.86663 29.2939C8.83318 29.2583 8.80192 29.22 8.7732 29.1788C7.33136 27.1149 6.42117 24.618 6.13186 21.9841C5.75876 18.5873 6.12658 14.6403 7.8929 11.4983C9.70099 8.28189 12.9317 6 17.9885 6C23.0436 6 26.2778 8.27305 28.092 11.4819C29.8643 14.6168 30.2393 18.557 29.8725 21.9536C29.5881 24.5883 28.6825 27.0875 27.2445 29.155C27.2194 29.1911 27.1924 29.2251 27.1636 29.2569C26.1749 30.6354 24.6023 31.3737 23.0035 30.8092L22.4778 30.6236C20.8774 30.0586 20.0443 28.3206 20.617 26.7417L22.8993 20.4491C23.472 18.8701 25.2335 18.0482 26.8339 18.6132L27.3596 18.7988C27.5669 18.8719 27.7613 18.9648 27.9415 19.0744C27.8783 16.7301 27.382 14.3817 26.3001 12.468C24.846 9.89593 22.2949 8.02429 17.9885 8.02428C13.684 8.02428 11.1369 9.90129 9.68718 12.4801Z"/></svg>`,
      heart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M2.00534 9C2.00179 8.91711 2 8.83376 2 8.75C2 5.57436 4.57436 3 7.75 3C9.43372 3 10.9484 3.72368 12 4.87696C13.0516 3.72368 14.5663 3 16.25 3C19.4256 3 22 5.57436 22 8.75C22 8.83376 21.9982 8.91711 21.9947 9H22C22 13.5738 14.6263 19.141 12.5425 20.6229C12.2133 20.8571 11.7867 20.8571 11.4575 20.6229C9.37369 19.141 2 13.5738 2 9H2.00534Z" fill="currentColor"/></svg>`,
      more: `<svg viewBox="0 0 36 36" aria-hidden="true"><path d="M13.556 17.778a1.778 1.778 0 1 1-3.556 0 1.778 1.778 0 0 1 3.556 0zM19.778 17.778a1.778 1.778 0 1 1-3.556 0 1.778 1.778 0 0 1 3.556 0zM24.222 19.556a1.778 1.778 0 1 0 0-3.556 1.778 1.778 0 0 0 0 3.556z" fill="currentColor"/></svg>`,
      pause: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.8" height="14" rx="1.3" fill="currentColor"/><rect x="13.2" y="5" width="3.8" height="14" rx="1.3" fill="currentColor"/></svg>`,
      play: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.7v12.6c0 .9 1 1.4 1.8.9l9.2-6.3c.7-.5.7-1.5 0-2L9.8 4.8C9 4.3 8 4.8 8 5.7z"/></svg>`,
      plusBadge: `<svg viewBox="0 0 32 33" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M16 26.7319C22.6274 26.7319 28 21.3594 28 14.7319C28 8.10452 22.6274 2.73193 16 2.73193C9.37258 2.73193 4 8.10452 4 14.7319C4 21.3594 9.37258 26.7319 16 26.7319Z" fill="#FE2C55"/><path d="M12 15.7319C11.4477 15.7319 11 15.2842 11 14.7319C11 14.1796 11.4477 13.7319 12 13.7319H20C20.5523 13.7319 21 14.1796 21 14.7319C21 15.2842 20.5523 15.7319 20 15.7319H12Z" fill="white"/><path d="M15 10.7319C15 10.1796 15.4477 9.73193 16 9.73193C16.5523 9.73193 17 10.1796 17 10.7319V18.7319C17 19.2842 16.5523 19.7319 16 19.7319C15.4477 19.7319 15 19.2842 15 18.7319V10.7319Z" fill="white"/></svg>`,
      search: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4zM16.1 16.1L21 21"/></svg>`,
      share: `<svg viewBox="0 0 36 36" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M21.8839 9.41656C20.675 8.26037 18.67 9.11717 18.67 10.7899V13.186C18.5357 13.186 18.4029 13.1872 18.2714 13.1895C16.8626 13.1517 12.0185 13.3097 8.61024 16.9648C6.24883 19.4974 5.18753 23.5267 5.25283 25.606C5.19102 27.6796 6.15808 27.4932 6.41822 27.0157C9.39378 21.554 18.67 23.2251 18.67 23.2251V25.4897C18.67 27.1268 20.6019 27.9978 21.8286 26.9138L29.8176 19.855C30.6512 19.1185 30.6767 17.8265 29.8728 17.0576L21.8839 9.41656Z" fill="currentColor"/></svg>`,
      star: `<svg viewBox="0 0 36 36" aria-hidden="true"><path d="M16.5101 7.2579C17.0254 5.84046 18.9746 5.84047 19.4899 7.2579L21.8225 13.6744L28.4762 13.9734C29.946 14.0395 30.5484 15.9463 29.397 16.8884L24.1849 21.153L25.9645 27.7544C26.3577 29.2126 24.7807 30.3911 23.5538 29.5559L18 25.7751L12.4462 29.5559C11.2193 30.3911 9.64234 29.2126 10.0355 27.7544L11.8151 21.153L6.60299 16.8884C5.45162 15.9463 6.05397 14.0395 7.5238 13.9734L14.1775 13.6744L16.5101 7.2579Z" fill="currentColor"/></svg>`,
      volume2: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M4 9v6h4l5 4V5L8 9H4z"/><path ${line} d="M16 8.5a5 5 0 0 1 0 7M19 6a9 9 0 0 1 0 12"/></svg>`,
      volumeX: `<svg viewBox="0 0 24 24" aria-hidden="true"><path ${line} d="M4 9v6h4l5 4V5L8 9H4z"/><path ${line} d="m18 9 4 4M22 9l-4 4"/></svg>`
    };
    return icons[name] || icons.more;
  }

  function appendCaptionText(target, text) {
    const parts = String(text || "").split(/(#[^\s#]+)/g).filter(Boolean);
    for (const part of parts) {
      if (part.startsWith("#")) {
        const tag = document.createElement("span");
        tag.className = "short-video-caption-tag";
        tag.textContent = part;
        target.append(tag);
      } else {
        target.append(document.createTextNode(part));
      }
    }
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
    state.shortVideo.status = error?.message || "短视频读取失败";
    renderView();
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

function selectOption(value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function formatCompact(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "0";
  if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`;
  return String(Math.round(number));
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

function normalizeShortVideoSource(value) {
  const source = String(value || "liked").trim();
  return ["liked", "posts", "all", "local"].includes(source) ? source : "liked";
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

function formatSeconds(value) {
  const total = Math.max(0, Math.floor(Number(value || 0)));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function initials(value) {
  return String(value || "?").trim().slice(0, 2).toUpperCase();
}
