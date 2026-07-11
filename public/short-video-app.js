import { createApiClient } from "./js/api.js?v=20260701-gallery-merge-01";
import { normalizeRoute, routeFromUrl, routeUrl } from "./js/router.js?v=20260712-project-refactor-03";
import { createShortVideoPage } from "./modules/short-videos/short-video-page.js?v=20260712-author-pagination-107";

const formatter = new Intl.NumberFormat("zh-CN");
const initialParams = new URLSearchParams(window.location.search);
const api = createApiClient({ isAndroidClient: initialParams.get("client") === "android" });

const state = {
  activeView: "shortVideos",
  selectedPersonId: null,
  selectedPerson: null,
  works: [],
  personWorksTotal: 0,
  personWorksFacets: null,
  shortVideo: {
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
    shortVideoAuthorPage: state.shortVideo.authorPage || "",
    shortVideoQuery: state.shortVideo.query || "",
    shortVideoTopic: state.shortVideo.topic || "",
    shortVideoSound: state.shortVideo.sound || "",
    shortVideoAuthor: state.shortVideo.author || "all",
    shortVideoMedia: state.shortVideo.media || "all",
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
  const initialRoute = routeFromUrl();
  await applyShortVideoRoute(initialRoute);
  state.routeReady = true;
  replaceRoute();
}

bootShortVideoApp().catch((error) => {
  console.error(error);
  if (els.workGrid) {
    els.workGrid.textContent = error?.message || "短视频页面加载失败";
  }
});
