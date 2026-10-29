import { createApiClient } from "./js/api.js?v=20260812-collection-busy-01";
import { normalizeRoute, routeFromUrl, routeUrl } from "./modules/short-videos/router.js?v=20260715-dedicated-router-01";
import { createShortVideoPage } from "./modules/short-videos/short-video-page.js?v=20260813-delete-client-state-02";
import { allowShortVideoSpeculativePrewarm } from "./modules/short-videos/prewarm-policy.js?v=20261027-prewarm-budget-01";

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

// Media starts only after detail metadata supplies its canonical, versioned
// source. A guessed smooth URL can fetch a second file and even queue a
// transcode that the source-first player will never use.
const shortVideoPlaybackPrimerPromise = initialShortVideoRoute.shortVideoId
  || !allowShortVideoSpeculativePrewarm({ hidden: document.hidden, connection: navigator.connection })
  ? Promise.resolve(false)
  : scheduleShortVideoPlaybackDecoderPrimer();
if (initialShortVideoRoute.shortVideoId) {
  markShortVideoPerformance("playback-decoder-primer-skipped", {
    reason: "direct-video-uses-canonical-stream",
    videoId: initialShortVideoRoute.shortVideoId
  });
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
    let quietTimer = null;
    let idleHandle = null;
    let fallbackRunTimer = null;
    let idleGeneration = 0;
    let lastActivityAt = Date.now();
    const clearIdle = () => {
      idleGeneration += 1;
      if (idleHandle != null && typeof window.cancelIdleCallback === "function") {
        window.cancelIdleCallback(idleHandle);
        idleHandle = null;
      }
      if (fallbackRunTimer != null) {
        window.clearTimeout(fallbackRunTimer);
        fallbackRunTimer = null;
      }
    };
    const removeActivityListeners = () => {
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, noteActivity, true));
      document.removeEventListener("visibilitychange", noteActivity, true);
    };
    const run = () => {
      idleHandle = null;
      fallbackRunTimer = null;
      if (started) return;
      if (document.visibilityState !== "visible") {
        noteActivity();
        return;
      }
      started = true;
      if (quietTimer != null) window.clearTimeout(quietTimer);
      quietTimer = null;
      removeActivityListeners();
      if (!allowShortVideoSpeculativePrewarm({ hidden: document.hidden, connection: navigator.connection })) {
        resolve(false);
        return;
      }
      primeShortVideoPlaybackDecoder().then(resolve, () => resolve(false));
    };
    const queueIdle = () => {
      quietTimer = null;
      const remainingQuietMs = quietMs - (Date.now() - lastActivityAt);
      if (remainingQuietMs > 0) {
        quietTimer = window.setTimeout(queueIdle, remainingQuietMs);
        return;
      }
      markShortVideoPerformance("playback-decoder-primer-quiet-ready", { quietMs });
      const generation = ++idleGeneration;
      const runIfCurrent = () => { if (!started && generation === idleGeneration) run(); };
      if (typeof window.requestIdleCallback === "function") {
        idleHandle = window.requestIdleCallback(runIfCurrent, { timeout: idleTimeoutMs });
      } else {
        fallbackRunTimer = window.setTimeout(runIfCurrent, 240);
      }
    };
    function noteActivity() {
      if (started) return;
      lastActivityAt = Date.now();
      clearIdle();
      if (quietTimer == null) quietTimer = window.setTimeout(queueIdle, quietMs);
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
  syncRouteAfterNavigation
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
