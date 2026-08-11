import { createApiClient } from "./js/api.js?v=20260812-collection-busy-01";
import { normalizeRoute, routeFromUrl, routeUrl } from "./modules/short-videos/router.js?v=20260715-dedicated-router-01";
import { createShortVideoPage } from "./modules/short-videos/short-video-page.js?v=20260812-collection-busy-01";

const formatter = new Intl.NumberFormat("zh-CN");
const initialParams = new URLSearchParams(window.location.search);
if (initialParams.get("perf") === "1") document.documentElement.dataset.shortVideoPerfCapture = "1";
const api = createApiClient({ isAndroidClient: initialParams.get("client") === "android" });
const initialShortVideoRoute = routeFromUrl();

function markShortVideoPerformance(name, details = {}) {
  const now = Date.now();
  const trace = window.__fanhaoShortVideoPerf && typeof window.__fanhaoShortVideoPerf === "object"
    ? window.__fanhaoShortVideoPerf
    : {
        version: 1,
        startedAt: Math.floor(Number(globalThis.performance?.timeOrigin || now)),
        events: []
      };
  const event = {
    name: String(name || "event"),
    at: now,
    elapsedMs: Math.max(0, now - Number(trace.startedAt || now)),
    ...details
  };
  trace.events = Array.isArray(trace.events) ? trace.events : [];
  trace.events.push(event);
  if (trace.events.length > 240) trace.events.splice(0, trace.events.length - 240);
  trace.latest = event;
  window.__fanhaoShortVideoPerf = trace;
  if (document.documentElement.dataset.shortVideoPerfCapture === "1") {
    document.documentElement.dataset.shortVideoPerfTrace = JSON.stringify({
      version: trace.version,
      startedAt: trace.startedAt,
      latest: trace.latest,
      events: trace.events.slice(-120)
    });
  }
  return event;
}

function startShortVideoPerformanceCapture() {
  if (document.documentElement.dataset.shortVideoPerfCapture !== "1") return;
  const moduleUrl = "/modules/short-videos/performance-observers.js?v=20260715-perf-observers-01";
  import(moduleUrl)
    .then((module) => module.startShortVideoPerformanceObservers?.(markShortVideoPerformance))
    .catch((error) => console.warn("短视频性能监控加载失败", error));
}

startShortVideoPerformanceCapture();

markShortVideoPerformance("app-module-start", {
  directVideo: Boolean(initialShortVideoRoute.shortVideoId),
  videoId: initialShortVideoRoute.shortVideoId || ""
});

let directShortVideoPlaybackPrewarm = shouldPrewarmDirectShortVideo(initialShortVideoRoute)
  ? createDirectShortVideoPlaybackPrewarm(initialShortVideoRoute.shortVideoId)
  : null;
const shortVideoPlaybackPrimerPromise = initialShortVideoRoute.shortVideoId
  ? Promise.resolve(false)
  : scheduleShortVideoPlaybackDecoderPrimer();
if (initialShortVideoRoute.shortVideoId) {
  markShortVideoPerformance("playback-decoder-primer-skipped", {
    reason: "direct-video-uses-real-stream",
    videoId: initialShortVideoRoute.shortVideoId
  });
}

function shouldPrewarmDirectShortVideo(route = {}) {
  if (!route.shortVideoId) return false;
  return route.shortVideoMedia === "video" || route.shortVideoQuality !== "all";
}

function createDirectShortVideoPlaybackPrewarm(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return null;
  const streamUrl = `/media/short-video-smooth/${encodeURIComponent(id)}?rendition=2k30-v2-range2`;
  const player = document.createElement("video");
  const startedAt = Date.now();
  const entry = {
    id,
    player,
    streamUrl,
    startedAt,
    taken: false,
    settled: false,
    frameHandle: 0,
    readyTimer: 0,
    cleanupTimer: 0
  };
  player.className = "short-video-prewarm-player short-video-direct-prewarm-player";
  player.dataset.streamUrl = streamUrl;
  player.dataset.videoId = id;
  player.dataset.shortVideoSlot = "direct-prewarm";
  player.src = streamUrl;
  player.preload = "auto";
  player.fetchPriority = "high";
  player.controls = false;
  player.autoplay = false;
  player.loop = false;
  player.muted = true;
  player.volume = 0;
  player.playsInline = true;
  player.tabIndex = -1;
  player.setAttribute("aria-hidden", "true");
  Object.assign(player.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "2px",
    height: "2px",
    opacity: "0.001",
    pointerEvents: "none"
  });
  document.body.append(player);
  markShortVideoPerformance("direct-video-prewarm-start", { videoId: id });

  const removeReadyListeners = () => {
    player.removeEventListener("loadeddata", requestFrame);
    player.removeEventListener("canplay", requestFrame);
    player.removeEventListener("playing", requestFrame);
  };
  const finish = (ready, reason = "ready") => {
    if (entry.settled) return;
    entry.settled = true;
    removeReadyListeners();
    if (entry.frameHandle && player.cancelVideoFrameCallback) {
      player.cancelVideoFrameCallback(entry.frameHandle);
      entry.frameHandle = 0;
    }
    if (entry.readyTimer) {
      window.clearTimeout(entry.readyTimer);
      entry.readyTimer = 0;
    }
    if (ready) {
      player.dataset.shortVideoFrameReady = "1";
      player.dataset.shortVideoFrameReadyAt = String(Date.now());
    }
    if (!entry.taken) player.pause?.();
    markShortVideoPerformance("direct-video-prewarm-finish", {
      videoId: id,
      ready: Boolean(ready),
      reason,
      readyState: Number(player.readyState || 0),
      durationMs: Date.now() - startedAt,
      taken: entry.taken
    });
  };
  function requestFrame() {
    if (entry.settled || player.readyState < 2) return;
    if (player.requestVideoFrameCallback) {
      if (!entry.frameHandle) {
        entry.frameHandle = player.requestVideoFrameCallback(() => finish(true, "painted-frame"));
      }
      return;
    }
    finish(true, "media-ready");
  }
  const cleanup = () => {
    if (entry.taken) return;
    removeReadyListeners();
    player.muted = true;
    player.pause?.();
    player.removeAttribute("src");
    player.load?.();
    player.remove();
    if (directShortVideoPlaybackPrewarm === entry) directShortVideoPlaybackPrewarm = null;
  };
  player.addEventListener("loadeddata", requestFrame);
  player.addEventListener("canplay", requestFrame);
  player.addEventListener("playing", requestFrame);
  player.load?.();
  player.play?.().catch(() => {});
  entry.readyTimer = window.setTimeout(() => finish(player.readyState >= 2, "timeout"), 1800);
  entry.cleanupTimer = window.setTimeout(cleanup, 5200);
  return entry;
}

function takeDirectShortVideoPlaybackPrewarm(video = {}, playbackUrl = "") {
  const entry = directShortVideoPlaybackPrewarm;
  const videoId = String(video?.id || "").trim();
  if (!entry || !videoId || entry.id !== videoId || !entry.player?.isConnected) return null;
  let expectedPath = "";
  let playbackPath = "";
  try {
    expectedPath = new URL(entry.streamUrl, window.location.href).pathname;
    playbackPath = new URL(playbackUrl, window.location.href).pathname;
  } catch {}
  if (!expectedPath || expectedPath !== playbackPath) return null;
  entry.taken = true;
  if (entry.cleanupTimer) {
    window.clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = 0;
  }
  const player = entry.player;
  player.dataset.streamUrl = playbackUrl;
  player.dataset.shortVideoPrewarmed = "1";
  player.removeAttribute("aria-hidden");
  player.removeAttribute("tabindex");
  directShortVideoPlaybackPrewarm = null;
  markShortVideoPerformance("direct-video-prewarm-taken", {
    videoId,
    readyState: Number(player.readyState || 0),
    frameReady: player.dataset.shortVideoFrameReady === "1",
    durationMs: Date.now() - entry.startedAt
  });
  return player;
}

function scheduleShortVideoPlaybackDecoderPrimer() {
  // Every measured 4K source currently reaches the browser through the cached
  // 2K/30 H.264 rendition. Prime that exact decoder configuration after the
  // list has painted instead of warming an HEVC pipeline the player never uses.
  const quietMs = 900;
  const idleTimeoutMs = 2200;
  const activityEvents = ["pointerdown", "wheel", "touchstart", "keydown", "scroll"];
  markShortVideoPerformance("playback-decoder-primer-scheduled", { quietMs });
  return new Promise((resolve) => {
    let started = false;
    let quietTimer = 0;
    let idleHandle = 0;
    let fallbackRunTimer = 0;
    let lastActivityAt = Date.now();
    const clearIdle = () => {
      if (idleHandle && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleHandle);
        idleHandle = 0;
      }
      if (fallbackRunTimer) {
        window.clearTimeout(fallbackRunTimer);
        fallbackRunTimer = 0;
      }
    };
    const removeActivityListeners = () => {
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, noteActivity, true));
      document.removeEventListener("visibilitychange", noteActivity, true);
    };
    const run = () => {
      idleHandle = 0;
      fallbackRunTimer = 0;
      if (started) return;
      if (document.visibilityState !== "visible") {
        noteActivity();
        return;
      }
      started = true;
      if (quietTimer) window.clearTimeout(quietTimer);
      quietTimer = 0;
      removeActivityListeners();
      primeShortVideoPlaybackDecoder().then(resolve, () => resolve(false));
    };
    const queueIdle = () => {
      quietTimer = 0;
      const remainingQuietMs = quietMs - (Date.now() - lastActivityAt);
      if (remainingQuietMs > 0) {
        quietTimer = window.setTimeout(queueIdle, remainingQuietMs);
        return;
      }
      markShortVideoPerformance("playback-decoder-primer-quiet-ready", { quietMs });
      if (typeof window.requestIdleCallback === "function") {
        idleHandle = window.requestIdleCallback(run, { timeout: idleTimeoutMs });
      } else {
        fallbackRunTimer = window.setTimeout(run, 240);
      }
    };
    function noteActivity() {
      if (started) return;
      lastActivityAt = Date.now();
      clearIdle();
      if (!quietTimer) quietTimer = window.setTimeout(queueIdle, quietMs);
    }
    activityEvents.forEach((eventName) => window.addEventListener(eventName, noteActivity, { capture: true, passive: true }));
    document.addEventListener("visibilitychange", noteActivity, { capture: true, passive: true });
    quietTimer = window.setTimeout(queueIdle, quietMs);
  });
}

function primeShortVideoPlaybackDecoder() {
  markShortVideoPerformance("playback-decoder-primer-start", {
    codec: "h264",
    width: 1440,
    height: 2560,
    frameRate: 30
  });
  const player = document.createElement("video");
  player.src = "/assets/short-video-h264-2k-primer.mp4?v=20260715-01";
  player.preload = "auto";
  player.autoplay = false;
  player.controls = false;
  player.loop = false;
  player.muted = true;
  player.playsInline = true;
  player.tabIndex = -1;
  player.setAttribute("aria-hidden", "true");
  Object.assign(player.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: "2px",
    height: "2px",
    opacity: "0.001",
    pointerEvents: "none"
  });
  document.body.append(player);
  return new Promise((resolve) => {
    let settled = false;
    let frameHandle = 0;
    const cleanup = () => {
      player.muted = true;
      player.pause?.();
      player.removeAttribute("src");
      player.load?.();
      player.remove();
    };
    const finish = (ready, reason = "ready") => {
      if (settled) return;
      settled = true;
      player.removeEventListener("loadeddata", requestFrame);
      player.removeEventListener("canplay", requestFrame);
      player.removeEventListener("playing", requestFrame);
      if (frameHandle && player.cancelVideoFrameCallback) player.cancelVideoFrameCallback(frameHandle);
      player.pause?.();
      window.setTimeout(cleanup, ready ? 1200 : 0);
      markShortVideoPerformance("playback-decoder-primer-finish", {
        ready: Boolean(ready),
        reason,
        readyState: Number(player.readyState || 0)
      });
      resolve(Boolean(ready));
    };
    const requestFrame = () => {
      if (settled || player.readyState < 2) return;
      if (player.requestVideoFrameCallback) {
        if (!frameHandle) {
          frameHandle = player.requestVideoFrameCallback(() => finish(true, "painted-frame"));
        }
        return;
      }
      finish(true, "media-ready");
    };
    player.addEventListener("loadeddata", requestFrame);
    player.addEventListener("canplay", requestFrame);
    player.addEventListener("playing", requestFrame);
    player.load?.();
    player.play?.().catch(() => finish(false, "play-rejected"));
    window.setTimeout(() => finish(player.readyState >= 2, "timeout"), 900);
  });
}

const state = {
  activeView: "shortVideos",
  selectedPersonId: null,
  selectedPerson: null,
  works: [],
  personWorksTotal: 0,
  personWorksFacets: null,
  shortVideo: {
    mode: "feed",
    collectionId: "",
    query: "",
    author: "all",
    authorPage: "",
    media: "all",
    source: "liked",
    sort: "published",
    data: null,
    summary: null,
    current: null,
    prevId: "",
    nextId: "",
    loading: false,
    status: ""
  },
  routeReady: false,
  restoringRoute: false
};

const els = {
  currentPath: document.querySelector("#currentPath"),
  currentTitle: document.querySelector("#currentTitle"),
  personProfile: document.querySelector("#personProfile"),
  statsRow: document.querySelector("#statsRow"),
  workGrid: document.querySelector("#workGrid")
};

document.body.classList.add("standalone-module-view", "short-video-view");
document.body.classList.remove("fanhao-view");

for (const selector of ["#adminBackdrop", "#adminModal", "#drawerBackdrop", "#detailDrawer"]) {
  const element = document.querySelector(selector);
  if (!element) continue;
  element.hidden = true;
  element.inert = true;
  element.setAttribute("aria-hidden", "true");
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

function hidePersonProfile() {
  if (!els.personProfile) return;
  els.personProfile.hidden = true;
  els.personProfile.replaceChildren();
}

function setMainHeader(title, pathText) {
  if (els.currentTitle) els.currentTitle.textContent = title;
  if (els.currentPath) els.currentPath.textContent = pathText;
}

function currentRouteSnapshot(overrides = {}) {
  return normalizeRoute({
    view: "shortVideos",
    shortVideoId: state.shortVideo.current?.id || "",
    shortVideoCollectionId: state.shortVideo.collectionId || "",
    shortVideoAuthorPage: state.shortVideo.authorPage || "",
    shortVideoMode: state.shortVideo.mode || "feed",
    shortVideoQuery: state.shortVideo.query || "",
    shortVideoTopic: state.shortVideo.topic || "",
    shortVideoSound: state.shortVideo.sound || "",
    shortVideoAuthor: state.shortVideo.author || "all",
    shortVideoMedia: state.shortVideo.media || "all",
    shortVideoQuality: state.shortVideo.quality || "all",
    shortVideoAuthorAccountStatus: state.shortVideo.authorAccountStatus || "all",
    shortVideoSource: state.shortVideo.source || "liked",
    shortVideoSort: state.shortVideo.sort || "published",
    ...overrides
  });
}

function writeRoute(route, mode = "push") {
  const next = normalizeRoute(route);
  const url = routeUrl(next);
  const historyState = { fanhaoRoute: next };
  if (mode === "replace") window.history.replaceState(historyState, "", url);
  else window.history.pushState(historyState, "", url);
}

function pushRoute(overrides = {}) {
  writeRoute(currentRouteSnapshot(overrides), "push");
}

function replaceRoute(overrides = {}) {
  writeRoute(currentRouteSnapshot(overrides), "replace");
}

function syncRouteAfterNavigation(options = {}) {
  if (options.skipRoute) return;
  if (options.replaceRoute) replaceRoute(options.routeOverrides || {});
  else pushRoute(options.routeOverrides || {});
}

const shortVideoPage = createShortVideoPage({
  api,
  cancelScheduledWorkRendering() {},
  disconnectPeopleIndexAutoload() {},
  els,
  ensureShortVideoViewerStyles: () => window.__fanhaoEnsureShortVideoViewerStyles?.() || Promise.resolve(),
  formatBytes,
  formatNumber,
  hidePersonProfile,
  pushRoute,
  replaceRoute,
  resetProgressiveCoverLoading() {},
  setMainHeader,
  state,
  syncRouteAfterNavigation,
  takeDirectShortVideoPlaybackPrewarm
});

async function applyShortVideoRoute(route) {
  const next = normalizeRoute(route);
  if (next.view !== "shortVideos") {
    window.location.reload();
    return;
  }
  state.restoringRoute = true;
  try {
    shortVideoPage.applyRouteState(next);
    shortVideoPage.enter({
      skipRoute: true,
      deferInitialLoad: true
    });
    await shortVideoPage.openRouteTarget(next);
  } finally {
    state.restoringRoute = false;
  }
}

window.addEventListener("popstate", () => {
  if (!state.routeReady) return;
  applyShortVideoRoute(routeFromUrl()).catch((error) => console.error(error));
});

async function bootShortVideoApp() {
  const initialRoute = initialShortVideoRoute;
  markShortVideoPerformance("initial-route-start", {
    videoId: initialRoute.shortVideoId || ""
  });
  await applyShortVideoRoute(initialRoute);
  state.routeReady = true;
  replaceRoute();
  markShortVideoPerformance("initial-route-ready", {
    videoId: state.shortVideo.current?.id || ""
  });
}

await bootShortVideoApp().catch((error) => {
  console.error(error);
  if (els.workGrid) {
    els.workGrid.textContent = error?.message || "短视频页面加载失败";
  }
});
