export function createShortVideoListWindow(dependencies) {
  const {
    getState,
    isAuthorDetailPage,
    loadVideos,
    markCacheState,
    markPerformance,
    rememberLoadedCoverId,
    renderVideoCard,
    shortVideoCardCoverUrl,
    shortVideosWithCovers,
    showError,
    wasCoverLoaded
  } = dependencies;

  const FEED_MIN_COLUMN_WIDTH = 320;
  const AUTHOR_MIN_COLUMN_WIDTH = 176;
  const COLUMN_GAP = 10;
  const ROW_GAP = 14;
  const BUFFER_ROWS = 5;
  const INITIAL_BUFFER_ROWS = 2;
  const APPEND_LOOKAHEAD_ROWS = 18;
  const EAGER_COVER_COUNT = 18;
  const COVER_BATCH_SIZE = 2;
  const COVER_BATCH_DELAY = 24;

  let columns = 0;
  let cardWidth = 0;
  let cardHeight = 0;
  let rowHeight = 0;
  let ready = false;
  let start = 0;
  let end = 0;
  let total = 0;
  let gridElement = null;
  let innerElement = null;
  let scrollFrame = 0;
  let appendContinuationFrame = 0;
  let expandIdle = 0;
  let coverObserver = null;
  let coverTimer = 0;
  const coverQueue = [];

  function attach(grid, inner = null) {
    gridElement = grid || null;
    innerElement = inner || null;
    start = 0;
    end = 0;
  }

  function reset() {
    start = 0;
    end = 0;
    total = 0;
    gridElement = null;
    innerElement = null;
    ready = false;
    cardHeight = 0;
    if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    if (appendContinuationFrame) window.cancelAnimationFrame(appendContinuationFrame);
    appendContinuationFrame = 0;
    cancelExpansion();
    coverObserver?.disconnect?.();
    coverObserver = null;
    if (coverTimer) window.clearTimeout(coverTimer);
    coverTimer = 0;
    coverQueue.length = 0;
  }

  function resize() {
    ready = false;
    start = 0;
    end = 0;
    cardHeight = 0;
    if (gridElement) render(true);
  }

  function measureGrid(grid) {
    const gridWidth = grid.clientWidth || grid.getBoundingClientRect().width || 800;
    const authorDetail = isAuthorDetailPage();
    const minCardWidth = authorDetail ? AUTHOR_MIN_COLUMN_WIDTH : FEED_MIN_COLUMN_WIDTH;
    columns = Math.max(1, Math.floor((gridWidth + COLUMN_GAP) / (minCardWidth + COLUMN_GAP)));
    cardWidth = (gridWidth - (columns - 1) * COLUMN_GAP) / columns;
    if (!cardHeight) cardHeight = Math.round(cardWidth * (authorDetail ? 14 / 9 : 9 / 16)) + (authorDetail ? 56 : 62);
    rowHeight = cardHeight + ROW_GAP;
  }

  function computeWindow(grid, itemCount, bufferRows = BUFFER_ROWS) {
    if (!columns || !rowHeight) measureGrid(grid);
    const gridTop = grid.getBoundingClientRect().top + window.scrollY;
    const viewportTop = window.scrollY;
    const viewportBottom = viewportTop + (window.innerHeight || document.documentElement.clientHeight || 800);
    const totalRows = Math.ceil(itemCount / columns) || 1;
    const rawStartRow = Math.max(0, Math.floor((viewportTop - gridTop) / rowHeight));
    const rawEndRow = Math.min(totalRows, Math.ceil((viewportBottom - gridTop) / rowHeight));
    const startRow = Math.max(0, rawStartRow - bufferRows);
    const endRow = Math.min(totalRows, rawEndRow + bufferRows);
    return {
      start: startRow * columns,
      end: Math.min(itemCount, endRow * columns),
      startRow,
      totalRows
    };
  }

  function render(force = false) {
    const renderStartedAt = Date.now();
    const state = getState();
    const grid = gridElement;
    const inner = innerElement;
    const videos = shortVideosWithCovers(state.shortVideo?.data?.videos || []);
    const itemCount = videos.length;
    if (!grid || !itemCount) {
      if (grid) grid.style.height = "";
      total = 0;
      return;
    }
    const previousTotal = total;
    const totalChanged = itemCount !== previousTotal;
    total = itemCount;
    const initialWindow = !ready;
    if (initialWindow) measureGrid(grid);
    const bufferRows = initialWindow ? INITIAL_BUFFER_ROWS : BUFFER_ROWS;
    const nextWindow = computeWindow(grid, itemCount, bufferRows);
    const virtualHeight = Math.max(0, nextWindow.totalRows * rowHeight - ROW_GAP);
    grid.style.height = `${virtualHeight}px`;
    if (!inner) return;
    if (document.documentElement.dataset.shortVideoPerfCapture === "1" && totalChanged) {
      markPerformance("short-video-window-total-changed", {
        previousTotal,
        total: itemCount,
        totalRows: nextWindow.totalRows,
        columns,
        rowHeight,
        virtualHeight,
        start: nextWindow.start,
        end: nextWindow.end
      });
    }
    if (!force && !totalChanged && nextWindow.start === start && nextWindow.end === end && ready) return;
    start = nextWindow.start;
    end = nextWindow.end;
    inner.style.transform = `translate3d(0, ${nextWindow.startRow * rowHeight}px, 0)`;
    inner.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    const existingCards = new Map(
      [...inner.children]
        .filter((card) => card?.dataset?.videoId)
        .map((card) => [String(card.dataset.videoId), card])
    );
    const cards = [];
    let createdCount = 0;
    let reusedCount = 0;
    const capturePerformance = document.documentElement.dataset.shortVideoPerfCapture === "1";
    let cardCreateDurationMs = 0;
    for (let index = start; index < end; index += 1) {
      const video = videos[index];
      if (!video) continue;
      const videoId = String(video.id || "");
      let card = existingCards.get(videoId) || null;
      if (card?.shortVideoCardRecord !== video) card = null;
      if (card) {
        existingCards.delete(videoId);
        reusedCount += 1;
      } else {
        const cardCreateStartedAt = capturePerformance ? globalThis.performance?.now?.() || Date.now() : 0;
        card = renderVideoCard(video, index);
        if (capturePerformance) cardCreateDurationMs += (globalThis.performance?.now?.() || Date.now()) - cardCreateStartedAt;
        createdCount += card ? 1 : 0;
      }
      if (!card) continue;
      const coverUrl = shortVideoCardCoverUrl(video);
      if (coverUrl && wasCoverLoaded(video.id)) {
        rememberLoadedCoverId(video.id);
        const image = card.querySelector("img.short-video-cover-image");
        if (image) {
          image.src = coverUrl;
          image.dataset.loaded = "1";
          image.classList.add("is-loaded");
          delete image.dataset.src;
        }
      }
      cards.push(card);
    }
    const desiredCards = new Set(cards);
    const domPatchStartedAt = capturePerformance ? globalThis.performance?.now?.() || Date.now() : 0;
    let removedCount = 0;
    for (const card of [...inner.children]) {
      if (desiredCards.has(card)) continue;
      card.querySelectorAll?.("img.short-video-cover-image")?.forEach?.((image) => coverObserver?.unobserve?.(image));
      card.remove();
      removedCount += 1;
    }
    cards.forEach((card, index) => {
      const current = inner.children[index] || null;
      if (current !== card) inner.insertBefore(card, current);
    });
    for (let index = coverQueue.length - 1; index >= 0; index -= 1) {
      if (!coverQueue[index]?.isConnected) coverQueue.splice(index, 1);
    }
    const domPatchDurationMs = capturePerformance
      ? (globalThis.performance?.now?.() || Date.now()) - domPatchStartedAt
      : 0;
    const coverActivationStartedAt = capturePerformance ? globalThis.performance?.now?.() || Date.now() : 0;
    activateCoversForNodes(cards);
    const coverActivationDurationMs = capturePerformance
      ? (globalThis.performance?.now?.() || Date.now()) - coverActivationStartedAt
      : 0;
    if (capturePerformance) {
      markPerformance("short-video-window-render", {
        start,
        end,
        created: createdCount,
        reused: reusedCount,
        removed: removedCount,
        initial: initialWindow,
        bufferRows,
        cardCreateDurationMs: Math.round(cardCreateDurationMs * 10) / 10,
        domPatchDurationMs: Math.round(domPatchDurationMs * 10) / 10,
        coverActivationDurationMs: Math.round(coverActivationDurationMs * 10) / 10,
        durationMs: Date.now() - renderStartedAt
      });
      markCacheState();
    }
    if (initialWindow) {
      ready = true;
      scheduleExpansion();
    }
  }

  function updateAndLoadMore() {
    render(false);
    const state = getState();
    const data = state.shortVideo?.data;
    if (data?.hasMore && !state.shortVideo.loading && !state.shortVideo.loadingMore) {
      const itemCount = shortVideosWithCovers(data.videos || []).length;
      if (end >= itemCount - columns * APPEND_LOOKAHEAD_ROWS) {
        loadVideos({ append: true, keepCurrent: true }).catch(showError);
      }
    }
  }

  function cancelExpansion() {
    if (!expandIdle) return;
    if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(expandIdle);
    else window.clearTimeout(expandIdle);
    expandIdle = 0;
  }

  function scheduleExpansion() {
    cancelExpansion();
    const expand = () => {
      expandIdle = 0;
      const state = getState();
      if (state.activeView !== "shortVideos" || state.shortVideo?.current || !gridElement?.isConnected) return;
      render(true);
    };
    if (typeof window.requestIdleCallback === "function") {
      expandIdle = window.requestIdleCallback(expand, { timeout: 180 });
    } else {
      expandIdle = window.setTimeout(expand, 60);
    }
  }

  function isViewportOutsideWindow() {
    if (!gridElement || !columns || !rowHeight || end <= start) return false;
    const gridTop = gridElement.getBoundingClientRect().top + window.scrollY;
    const viewportTop = Math.max(0, window.scrollY - gridTop);
    const viewportBottom = viewportTop + (window.innerHeight || document.documentElement.clientHeight || 800);
    const firstVisibleRow = Math.max(0, Math.floor(viewportTop / rowHeight));
    const lastVisibleRow = Math.max(firstVisibleRow, Math.ceil(viewportBottom / rowHeight));
    const renderedStartRow = Math.floor(start / columns);
    const renderedEndRow = Math.ceil(end / columns);
    return firstVisibleRow < renderedStartRow || lastVisibleRow > renderedEndRow;
  }

  function scheduleUpdate() {
    if (isViewportOutsideWindow()) {
      if (scrollFrame) window.cancelAnimationFrame(scrollFrame);
      scrollFrame = 0;
      updateAndLoadMore();
      return;
    }
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0;
      updateAndLoadMore();
    });
  }

  function scheduleAppendContinuation() {
    if (appendContinuationFrame) window.cancelAnimationFrame(appendContinuationFrame);
    appendContinuationFrame = window.requestAnimationFrame(() => {
      appendContinuationFrame = window.requestAnimationFrame(() => {
        appendContinuationFrame = 0;
        const state = getState();
        if (state.activeView !== "shortVideos" || state.shortVideo?.current || !gridElement?.isConnected) return;
        updateAndLoadMore();
      });
    });
  }

  function activateCovers(root) {
    const images = [...(root?.querySelectorAll?.("img.short-video-cover-image[data-src]") || [])];
    const observer = ensureCoverObserver();
    images.forEach((image, index) => {
      if (index < EAGER_COVER_COUNT || !observer) queueCover(image);
      else observer.observe(image);
    });
  }

  function activateCoversForNodes(nodes) {
    const observer = ensureCoverObserver();
    for (const node of nodes || []) {
      for (const image of node?.querySelectorAll?.("img.short-video-cover-image[data-src]") || []) {
        if (image.loading === "eager" || !observer) queueCover(image);
        else observer.observe(image);
      }
    }
  }

  function ensureCoverObserver() {
    if (!("IntersectionObserver" in window)) return null;
    if (!coverObserver) {
      coverObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.fetchPriority = "high";
          queueCover(entry.target);
        }
      }, { rootMargin: "720px 0px", threshold: 0.01 });
    }
    return coverObserver;
  }

  function queueCover(image) {
    if (!image?.dataset?.src || image.dataset.queued === "1" || image.dataset.loaded === "1") return;
    coverObserver?.unobserve(image);
    image.dataset.queued = "1";
    coverQueue.push(image);
    scheduleCoverDrain();
  }

  function scheduleCoverDrain(delay = 0) {
    if (coverTimer) return;
    coverTimer = window.setTimeout(drainCoverQueue, delay);
  }

  function drainCoverQueue() {
    coverTimer = 0;
    let loaded = 0;
    while (coverQueue.length && loaded < COVER_BATCH_SIZE) {
      const image = coverQueue.shift();
      if (!image?.isConnected || !image.dataset.src || image.dataset.loaded === "1") continue;
      loadCover(image);
      loaded += 1;
    }
    if (coverQueue.length) scheduleCoverDrain(COVER_BATCH_DELAY);
  }

  function loadCover(image) {
    const source = image.dataset.src;
    image.dataset.loaded = "1";
    delete image.dataset.src;
    image.addEventListener("load", () => {
      image.classList.add("is-loaded");
      const videoId = image.dataset.videoId;
      if (videoId) rememberLoadedCoverId(videoId);
    }, { once: true });
    image.addEventListener("error", () => image.classList.add("is-cover-error"), { once: true });
    image.src = source;
  }

  return Object.freeze({
    activateCovers,
    attach,
    render,
    reset,
    resize,
    scheduleAppendContinuation,
    scheduleUpdate
  });
}
