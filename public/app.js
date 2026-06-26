const state = {
  library: null,
  people: [],
  selectedPersonId: null,
  selectedPerson: null,
  works: [],
  activeView: "people",
  peopleIndexScrollTop: 0,
  personQuery: "",
  workQuery: "",
  sortMode: "title",
  filterMode: "all",
  showMissingLocalWorks: readStoredFlag("fanhao.showMissingLocalWorks", true),
  showCompilationWorks: readStoredFlag("fanhao.showCompilationWorks", false),
  uiConfig: defaultUiConfig(),
  currentWork: null,
  currentVideo: null,
  currentPlayInfo: null,
  currentStreamOffset: 0,
  progressTimer: null,
  timelineTimer: null,
  timelineAbortController: null,
  lastProgressReport: 0,
  searchReturnView: "people",
  searchTimer: null,
  searchSeq: 0,
  searchPeople: [],
  searchQuery: "",
  searchFacets: null,
  accessMode: "local",
  accessHints: {},
  workPageSize: 1000,
  workVisibleLimit: 1000,
  searchTotal: 0,
  searchLoadingMore: false,
  rankingLists: [],
  selectedRankingKey: "y2025",
  rankingTotal: 0,
  rankingMissingTotal: 0,
  rankingLocalTotal: 0,
  rankingUpdatedAt: "",
  rankingPageUrl: "",
  favoriteFolders: [],
  selectedFavoriteFolderId: "all",
  selectedHistoryRange: "30",
  personWorksTotal: 0,
  personWorksFacets: null,
  personWorksLoadingMore: false,
  personPageSize: 120,
  personVisibleLimit: 120,
  personSearchTimer: null,
  openWorkSeq: 0,
  infoRenderTimer: null,
  lastFocusedElement: null,
  adminPollTimer: null,
  handledAdminTaskIds: new Set(),
  routeReady: false,
  restoringRoute: false
};

const els = {
  librarySummary: document.querySelector("#librarySummary"),
  rescanButton: document.querySelector("#rescanButton"),
  adminButton: document.querySelector("#adminButton"),
  personSearch: document.querySelector("#personSearch"),
  personList: document.querySelector("#personList"),
  viewTabs: [...document.querySelectorAll(".view-tab")],
  workSearch: document.querySelector("#workSearch"),
  sortSelect: document.querySelector("#sortSelect"),
  filterSelect: document.querySelector("#filterSelect"),
  missingLocalToggle: document.querySelector("#missingLocalToggle"),
  collectionToggle: document.querySelector("#collectionToggle"),
  compilationConfigButton: document.querySelector("#compilationConfigButton"),
  personProfile: document.querySelector("#personProfile"),
  currentPath: document.querySelector("#currentPath"),
  currentTitle: document.querySelector("#currentTitle"),
  backToPeopleIndex: document.querySelector("#backToPeopleIndex"),
  statsRow: document.querySelector("#statsRow"),
  workGrid: document.querySelector("#workGrid"),
  drawerBackdrop: document.querySelector("#drawerBackdrop"),
  detailDrawer: document.querySelector("#detailDrawer"),
  closeDrawer: document.querySelector("#closeDrawer"),
  drawerPath: document.querySelector("#drawerPath"),
  drawerTitle: document.querySelector("#drawerTitle"),
  playerArea: document.querySelector("#playerArea"),
  drawerSide: document.querySelector(".drawer-side"),
  metaArea: document.querySelector("#metaArea"),
  infoArea: document.querySelector("#infoArea"),
  placeholderTemplate: document.querySelector("#placeholderTemplate"),
  adminBackdrop: document.querySelector("#adminBackdrop"),
  adminModal: document.querySelector("#adminModal"),
  closeAdmin: document.querySelector("#closeAdmin"),
  adminPersonSelect: document.querySelector("#adminPersonSelect"),
  adminRescanPerson: document.querySelector("#adminRescanPerson"),
  adminRefreshActor: document.querySelector("#adminRefreshActor"),
  adminRefreshRankings: document.querySelector("#adminRefreshRankings"),
  adminActorAvatarDataPath: document.querySelector("#adminActorAvatarDataPath"),
  adminPreviewActorAvatars: document.querySelector("#adminPreviewActorAvatars"),
  adminImportActorAvatars: document.querySelector("#adminImportActorAvatars"),
  adminActorAvatarCandidates: document.querySelector("#adminActorAvatarCandidates"),
  adminCoverLimit: document.querySelector("#adminCoverLimit"),
  adminGenerateCovers: document.querySelector("#adminGenerateCovers"),
  adminCoverStatus: document.querySelector("#adminCoverStatus"),
  adminCompilationPrefixes: document.querySelector("#adminCompilationPrefixes"),
  adminCompilationKeywords: document.querySelector("#adminCompilationKeywords"),
  adminSaveCompilationConfig: document.querySelector("#adminSaveCompilationConfig"),
  adminCompilationSection: document.querySelector("#adminCompilationSection"),
  adminConfigStatus: document.querySelector("#adminConfigStatus"),
  adminStatus: document.querySelector("#adminStatus"),
  adminTaskList: document.querySelector("#adminTaskList")
};

const formatter = new Intl.NumberFormat("zh-CN");
let peopleIndexLoadObserver = null;
const initialParams = new URLSearchParams(window.location.search);
const isAndroidClient = initialParams.get("client") === "android";
const URL_VIEW_NAMES = new Set(["people", "favorites", "history", "rankings"]);
const HISTORY_RANGE_OPTIONS = [
  { value: "30", label: "30 天" },
  { value: "7", label: "7 天" },
  { value: "all", label: "全部" }
];
document.documentElement.classList.toggle("android-client", isAndroidClient);

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
    actorAvatarDataPath: ""
  };
}

function normalizeCompilationPrefix(value) {
  return String(value || "")
    .trim()
    .replace(/[-_\s]+$/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function uniqueConfigLines(values, options = {}) {
  const seen = new Set();
  const result = [];
  const transform = options.transform || ((value) => String(value || "").trim());
  for (const value of Array.isArray(values) ? values : []) {
    const item = transform(value);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result.slice(0, options.maxItems || 100);
}

function normalizeUiConfig(config = {}) {
  const fallback = defaultUiConfig();
  const input = config && typeof config === "object" ? config : {};
  const prefixes = uniqueConfigLines(input.compilationPrefixes, {
    maxItems: 80,
    transform: normalizeCompilationPrefix
  });
  const keywords = uniqueConfigLines(input.compilationKeywords, { maxItems: 120 });
  return {
    compilationPrefixes: prefixes.length ? prefixes : fallback.compilationPrefixes,
    compilationKeywords: keywords.length ? keywords : fallback.compilationKeywords,
    actorAvatarDataPath: String(input.actorAvatarDataPath || "").trim()
  };
}

function linesFromTextarea(value) {
  return String(value || "")
    .split(/\r?\n|[,，、;]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function currentPageScrollTop() {
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

function restorePageScrollTop(top) {
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: Math.max(0, Number(top) || 0), left: 0, behavior: "auto" });
  });
}

function routeFromUrl(url = window.location.href) {
  const parsed = new URL(url, window.location.href);
  const params = parsed.searchParams;
  const query = params.get("q") || params.get("search") || "";
  const rawView = params.get("view");
  return {
    view: query ? "search" : URL_VIEW_NAMES.has(rawView) ? rawView : "people",
    personId: params.get("personId") || params.get("person") || "",
    q: query,
    workId: params.get("workId") || params.get("work") || "",
    videoId: params.get("videoId") || params.get("video") || ""
  };
}

function currentRouteSnapshot(overrides = {}) {
  const drawerOpen = els.detailDrawer?.classList.contains("open");
  const route = {
    view: state.activeView || "people",
    personId: state.activeView === "people" ? state.selectedPersonId || "" : "",
    q: state.activeView === "search" ? state.searchQuery || state.workQuery || "" : "",
    workId: drawerOpen ? state.currentWork?.id || "" : "",
    videoId: drawerOpen ? state.currentVideo?.id || "" : ""
  };
  return normalizeRoute({ ...route, ...overrides });
}

function normalizeRoute(route = {}) {
  const view = route.q ? "search" : URL_VIEW_NAMES.has(route.view) ? route.view : "people";
  return {
    view,
    personId: view === "people" ? route.personId || "" : "",
    q: view === "search" ? String(route.q || "").trim() : "",
    workId: route.workId || "",
    videoId: route.videoId || ""
  };
}

function routeUrl(route) {
  const next = normalizeRoute(route);
  const params = new URLSearchParams();
  for (const key of ["client", "returnTo"]) {
    const value = initialParams.get(key);
    if (value) params.set(key, value);
  }
  if (next.view && next.view !== "people" && next.view !== "search") params.set("view", next.view);
  if (next.personId) params.set("personId", next.personId);
  if (next.q) params.set("q", next.q);
  if (next.workId) params.set("workId", next.workId);
  if (next.videoId) params.set("videoId", next.videoId);

  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash || ""}`;
}

function writeRoute(route, mode = "push") {
  if (!state.routeReady || state.restoringRoute || !window.history?.pushState) return;
  const next = normalizeRoute(route);
  const url = routeUrl(next);
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash || ""}`;
  const historyState = { fanhaoRoute: true, ...next };
  if (mode === "replace" || url === currentUrl) {
    window.history.replaceState(historyState, "", url);
    return;
  }
  window.history.pushState(historyState, "", url);
}

function pushRoute(overrides = {}) {
  writeRoute(currentRouteSnapshot(overrides), "push");
}

function replaceRoute(overrides = {}) {
  writeRoute(currentRouteSnapshot(overrides), "replace");
}

function syncRouteAfterNavigation(options = {}) {
  if (options.skipRoute) return;
  const overrides = options.routeOverrides || {};
  if (options.replaceRoute) {
    replaceRoute(overrides);
  } else {
    pushRoute(overrides);
  }
}

function initializeRouteHistory() {
  if (state.routeReady) return;
  state.routeReady = true;
  replaceRoute();
}

async function applyRoute(route) {
  const next = normalizeRoute(route);
  state.restoringRoute = true;
  try {
    if (!next.workId && els.detailDrawer.classList.contains("open")) {
      closeDrawer({ skipRoute: true });
    }

    if (next.view === "search") {
      state.workQuery = next.q;
      els.workSearch.value = next.q;
      await loadSearchResults(next.q, { skipRoute: true });
    } else if (next.view === "people") {
      clearWorkSearch();
      if (next.personId && state.people.some((person) => person.id === next.personId)) {
        await selectPerson(next.personId, { resetFilter: false, captureIndexScroll: false, skipRoute: true });
      } else {
        showPeopleIndex({ restoreScroll: true, skipRoute: true });
      }
    } else {
      clearWorkSearch();
      setActiveView(next.view, { skipRoute: true });
    }

    if (next.workId) {
      await openWork(next.workId, next.videoId || null, { skipRoute: true });
    }
  } finally {
    state.restoringRoute = false;
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

function installAndroidClientReturn() {
  if (!isAndroidClient) return;
  if (document.querySelector(".android-client-return")) return;

  const returnTo = safeAndroidReturnUrl(initialParams.get("returnTo"));
  const button = document.createElement("button");
  button.type = "button";
  button.className = "android-client-return";
  button.textContent = "‹ 返回客户端";
  button.setAttribute("aria-label", "返回客户端首页");

  let returning = false;
  const returnToClient = () => {
    if (returning) return;
    returning = true;
    button.textContent = "正在返回";

    if (returnTo) {
      fallbackReturnToClient(returnTo);
      return;
    }

    if (window.history.length > 1) {
      const currentUrl = window.location.href;
      window.history.back();
      window.setTimeout(() => {
        if (window.location.href === currentUrl && !document.hidden) {
          fallbackReturnToClient(returnTo);
        }
      }, 700);
      return;
    }

    fallbackReturnToClient(returnTo);
  };

  button.addEventListener("click", returnToClient);
  button.addEventListener(
    "touchend",
    (event) => {
      event.preventDefault();
      returnToClient();
    },
    { passive: false }
  );
  document.body.append(button);
}

function fallbackReturnToClient(returnTo) {
  const target = returnTo || "capacitor://localhost/";
  try {
    window.location.replace(target);
  } catch {
    window.location.href = target;
  }
}

function safeAndroidReturnUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol === "capacitor:") return url.toString();
    const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if ((url.protocol === "http:" || url.protocol === "https:") && localHosts.has(url.hostname)) {
      return url.toString();
    }
  } catch {
    return "";
  }
  return "";
}

function formatNumber(value) {
  return formatter.format(value || 0);
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unitIndex]}`;
}

function formatTime(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function includesText(value, query) {
  return String(value || "").toLowerCase().includes(query.trim().toLowerCase());
}

function displayPersonName(person) {
  return person?.actorProfile?.displayName || person?.name || "";
}

function personSearchText(person) {
  return [
    person?.name,
    person?.actorProfile?.displayName,
    person?.actorProfile?.personName,
    ...(person?.actorProfile?.aliases || [])
  ].filter(Boolean).join("\n");
}

function workPersonDisplayName(work) {
  return work?.personDisplayName || work?.personName || "";
}

function workPersonSearchText(work) {
  return [
    work?.personName,
    work?.personDisplayName,
    ...(work?.personAliases || [])
  ].filter(Boolean).join("\n");
}

function workInfoSearchText(work) {
  const info = work?.infoSummary || {};
  return [
    info.code,
    info.title,
    info.director,
    info.maker,
    info.label,
    info.series,
    ...(info.actors || []),
    ...(info.tags || [])
  ].filter(Boolean).join("\n");
}

function coverUrl(coverId) {
  return coverId ? `/media/image/${encodeURIComponent(coverId)}` : "";
}

function workCoverUrl(work) {
  return coverUrl(work.coverId) || work.cachedCover?.coverUrl || work.remoteCoverUrl || "";
}

function formatLibraryPath(value) {
  if (!value) return "";
  const normalized = String(value).replaceAll("/", "\\");
  return /^[A-Za-z]:\\?/.test(normalized) ? normalized : `G:\\${normalized}`;
}

function formatLibraryPaths(values) {
  const paths = (values || []).filter(Boolean).map(formatLibraryPath);
  return paths.length ? paths.join(" · ") : "G:\\ / F:\\ / O:\\ / V:\\";
}

function uniqueSourcePaths(person) {
  const seen = new Set();
  return [...(person.sourcePaths || []), person.relativePath]
    .filter(Boolean)
    .filter((sourcePath) => {
      const key = normalizeSourcePath(sourcePath);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => sourcePriority(a) - sourcePriority(b));
}

function sourceButtonLabel(sourcePath) {
  const normalized = normalizeSourcePath(sourcePath);
  if (normalized === "v:/[a]" || normalized.startsWith("v:/[a]/")) return "打开 VR · V:[A]";
  if (normalized === "v:/[a1]" || normalized.startsWith("v:/[a1]/")) return "打开 VR · V:[A1]";
  if (normalized === "v:/av" || normalized.startsWith("v:/av/")) return "打开 VR · V:AV";
  if (normalized.startsWith("v:/")) return "打开 VR";
  if (normalized === "o:/[珍藏]" || normalized.startsWith("o:/[珍藏]/")) return "打开珍藏 · O:";
  if (normalized === "o:/[珍藏1]" || normalized.startsWith("o:/[珍藏1]/")) return "打开珍藏1 · O:";
  if (normalized.startsWith("g:/")) return "打开普通 · G:";
  if (normalized.startsWith("f:/")) return "打开普通 · F:";
  if (normalized.startsWith("o:/")) return "打开普通 · O:";
  return "打开文件夹";
}

async function api(path, options = {}) {
  const init = { ...options };
  if (init.body && typeof init.body !== "string") {
    init.body = JSON.stringify(init.body);
    init.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
  }

  const response = await fetch(path, init);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `请求失败：${response.status}`);
  }
  return payload;
}

function addQueryParam(url, key, value) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
}

async function loadLibrary() {
  els.librarySummary.textContent = "正在读取索引";
  const data = await api("/api/library");
  state.library = data;
  state.accessMode = data.access?.mode || "local";
  state.accessHints = data.access?.hints || {};
  state.uiConfig = normalizeUiConfig(data.uiConfig || state.uiConfig);
  if (els.adminButton) els.adminButton.hidden = state.accessMode !== "local";
  if (els.missingLocalToggle) els.missingLocalToggle.checked = state.showMissingLocalWorks;
  if (els.collectionToggle) els.collectionToggle.checked = state.showCompilationWorks;
  state.workPageSize = Number(state.accessHints.workPageSize) || (state.accessMode === "lan" ? 60 : 1000);
  state.personPageSize = state.accessMode === "lan" ? 80 : 96;
  resetWorkPaging();
  state.people = sortPeopleForList(data.people || []);
  resetPersonPaging();

  if (state.selectedPersonId && !state.people.some((person) => person.id === state.selectedPersonId)) {
    state.selectedPersonId = null;
  }

  renderSummary();
  setActiveView(state.activeView || "people");
}

function normalizeSourcePath(value) {
  return String(value || "").replaceAll("\\", "/").toLowerCase();
}

function sourcePriority(value) {
  const sourcePath = normalizeSourcePath(value);
  if (sourcePath.startsWith("g:/")) return 0;
  if (sourcePath.startsWith("f:/")) return 1;
  if (sourcePath === "o:/[珍藏]" || sourcePath.startsWith("o:/[珍藏]/")) return 2;
  if (sourcePath === "o:/[珍藏1]" || sourcePath.startsWith("o:/[珍藏1]/")) return 3;
  if (sourcePath.startsWith("o:/")) return 4;
  if (sourcePath === "v:/[a]" || sourcePath.startsWith("v:/[a]/")) return 5;
  if (sourcePath === "v:/[a1]" || sourcePath.startsWith("v:/[a1]/")) return 6;
  if (sourcePath === "v:/av" || sourcePath.startsWith("v:/av/")) return 7;
  if (sourcePath.startsWith("v:/")) return 8;
  return 9;
}

function personSourcePriority(person) {
  const paths = [...(person.sourcePaths || []), person.relativePath].filter(Boolean);
  if (!paths.length) return 9;
  return Math.min(...paths.map(sourcePriority));
}

function sortPeopleForList(people) {
  return [...people].sort((a, b) => {
    const priority = personSourcePriority(a) - personSourcePriority(b);
    if (priority) return priority;
    return displayPersonName(a).localeCompare(displayPersonName(b), undefined, { numeric: true, sensitivity: "base" });
  });
}

function renderSummary() {
  const totals = state.library?.totals || {};
  const rootCount = state.library?.availableRoots?.length || 0;
  const favoriteCount = state.library?.user?.favoriteCount || 0;
  const mode = state.accessMode === "lan" ? "局域网" : "本机";
  els.librarySummary.textContent = `${mode} · ${formatNumber(rootCount)} 盘 · ${formatNumber(totals.people)} 人 · ${formatNumber(totals.videos)} 视频 · ${formatNumber(favoriteCount)} 收藏`;
}

function openAdminModal(options = {}) {
  if (state.accessMode !== "local") return;
  populateAdminPeople();
  populateAdminConfig();
  els.adminStatus.textContent = "";
  if (els.adminConfigStatus) els.adminConfigStatus.textContent = "";
  els.adminBackdrop.hidden = false;
  els.adminModal.classList.add("open");
  els.adminModal.setAttribute("aria-hidden", "false");
  startAdminPolling();
  refreshCoverCacheStatus();
  window.setTimeout(() => {
    if (options.section === "compilation") {
      els.adminCompilationSection?.scrollIntoView({ block: "start" });
      els.adminCompilationPrefixes?.focus();
      return;
    }
    els.adminPersonSelect?.focus();
  }, 0);
}

function closeAdminModal() {
  els.adminModal.classList.remove("open");
  els.adminModal.setAttribute("aria-hidden", "true");
  els.adminBackdrop.hidden = true;
  stopAdminPolling();
}

function populateAdminPeople() {
  if (!els.adminPersonSelect) return;
  const selected = state.selectedPersonId || els.adminPersonSelect.value;
  els.adminPersonSelect.innerHTML = "";
  for (const person of state.people) {
    const option = document.createElement("option");
    option.value = person.id;
    option.textContent = `${displayPersonName(person)} · ${formatNumber(person.workCount)} 部`;
    els.adminPersonSelect.append(option);
  }
  if (selected && state.people.some((person) => person.id === selected)) {
    els.adminPersonSelect.value = selected;
  }
}

function adminPersonId() {
  return els.adminPersonSelect?.value || state.selectedPersonId || "";
}

function populateAdminConfig() {
  const config = normalizeUiConfig(state.uiConfig);
  if (els.adminActorAvatarDataPath) {
    els.adminActorAvatarDataPath.value = config.actorAvatarDataPath || "";
  }
  if (els.adminCompilationPrefixes) {
    els.adminCompilationPrefixes.value = config.compilationPrefixes.join("\n");
  }
  if (els.adminCompilationKeywords) {
    els.adminCompilationKeywords.value = config.compilationKeywords.join("\n");
  }
}

function setAdminBusy(button, busy, text = "处理中") {
  if (!button) return "";
  const original = button.dataset.originalText || button.textContent;
  button.dataset.originalText = original;
  button.disabled = busy;
  button.textContent = busy ? text : original;
  return original;
}

async function adminRescanSelectedPerson() {
  const personId = adminPersonId();
  if (!personId) return;
  setAdminBusy(els.adminRescanPerson, true, "扫描中");
  els.adminStatus.textContent = "正在重新扫描这个人物的本地文件";
  try {
    await api(`/api/admin/rescan-person?limit=${personWorkPageSize()}&sort=${encodeURIComponent(state.sortMode || "title")}`, {
      method: "POST",
      body: { personId }
    });
    await loadLibrary();
    els.adminStatus.textContent = "本地检测已刷新";
    if (state.selectedPersonId === personId) {
      await selectPerson(personId, { resetFilter: false });
    }
    populateAdminPeople();
  } catch (error) {
    els.adminStatus.textContent = error.message || "刷新失败";
  } finally {
    setAdminBusy(els.adminRescanPerson, false);
  }
}

async function adminRefreshActorMovies() {
  const personId = adminPersonId();
  if (!personId) return;
  setAdminBusy(els.adminRefreshActor, true, "启动中");
  els.adminStatus.textContent = "正在启动缺失检测任务";
  try {
    const data = await api("/api/admin/refresh-actor-movies", {
      method: "POST",
      body: { personId, sleep: 2 }
    });
    els.adminStatus.textContent = `已启动：${data.task?.label || "任务"}`;
    await refreshAdminTasks();
    startAdminPolling();
  } catch (error) {
    els.adminStatus.textContent = error.message || "启动失败";
  } finally {
    setAdminBusy(els.adminRefreshActor, false);
  }
}

async function adminRefreshRankings() {
  setAdminBusy(els.adminRefreshRankings, true, "启动中");
  els.adminStatus.textContent = "正在启动排行榜缓存任务";
  try {
    const data = await api("/api/admin/refresh-rankings", {
      method: "POST",
      body: { key: state.selectedRankingKey || "y2025", sleep: 2 }
    });
    els.adminStatus.textContent = `已启动：${data.task?.label || "任务"}`;
    await refreshAdminTasks();
    startAdminPolling();
  } catch (error) {
    els.adminStatus.textContent = error.message || "启动失败";
  } finally {
    setAdminBusy(els.adminRefreshRankings, false);
  }
}

async function adminSaveCompilationConfig() {
  const config = normalizeUiConfig({
    ...state.uiConfig,
    compilationPrefixes: linesFromTextarea(els.adminCompilationPrefixes?.value),
    compilationKeywords: linesFromTextarea(els.adminCompilationKeywords?.value)
  });
  setAdminBusy(els.adminSaveCompilationConfig, true, "保存中");
  if (els.adminConfigStatus) els.adminConfigStatus.textContent = "";
  try {
    await saveCompilationConfig(config);
    populateAdminConfig();
    if (els.adminConfigStatus) els.adminConfigStatus.textContent = "已保存";
  } catch (error) {
    if (els.adminConfigStatus) els.adminConfigStatus.textContent = error.message || "保存失败";
  } finally {
    setAdminBusy(els.adminSaveCompilationConfig, false);
  }
}

async function adminImportActorAvatars() {
  const rootPath = String(els.adminActorAvatarDataPath?.value || "").trim();
  setAdminBusy(els.adminImportActorAvatars, true, "扫描中");
  els.adminStatus.textContent = "正在扫描本地演员头像";
  try {
    const data = await api("/api/admin/import-actor-avatars", {
      method: "POST",
      body: { rootPath, replace: false }
    });
    state.uiConfig = normalizeUiConfig(data.config);
    populateAdminConfig();
    await loadLibrary();
    const summary = data.summary || {};
    const imported = formatNumber(summary.imported || 0);
    const matched = formatNumber(summary.matched || 0);
    const skipped = formatNumber(summary.skippedExisting || 0);
    els.adminStatus.textContent = `头像扫描完成：导入 ${imported}，匹配 ${matched}，已有头像跳过 ${skipped}`;
  } catch (error) {
    els.adminStatus.textContent = error.message || "扫描演员头像失败";
  } finally {
    setAdminBusy(els.adminImportActorAvatars, false);
  }
}

async function adminPreviewActorAvatarCandidates() {
  const rootPath = String(els.adminActorAvatarDataPath?.value || "").trim();
  setAdminBusy(els.adminPreviewActorAvatars, true, "读取中");
  els.adminStatus.textContent = "正在读取头像候选";
  if (els.adminActorAvatarCandidates) els.adminActorAvatarCandidates.innerHTML = "";
  try {
    const data = await api("/api/admin/actor-avatar-candidates", {
      method: "POST",
      body: { rootPath, limit: 40 }
    });
    state.uiConfig = normalizeUiConfig(data.config);
    populateAdminConfig();
    renderActorAvatarCandidates(data.summary || {});
  } catch (error) {
    els.adminStatus.textContent = error.message || "读取头像候选失败";
  } finally {
    setAdminBusy(els.adminPreviewActorAvatars, false);
  }
}

function renderActorAvatarCandidates(summary = {}) {
  if (!els.adminActorAvatarCandidates) return;
  els.adminActorAvatarCandidates.innerHTML = "";
  const people = summary.people || [];
  const matched = formatNumber(summary.matched || 0);
  const matchedPeople = formatNumber(summary.matchedPeople || 0);
  const returnedPeople = formatNumber(summary.returnedPeople || people.length);
  els.adminStatus.textContent = `头像候选：匹配 ${matched} 个文件，涉及 ${matchedPeople} 人，显示 ${returnedPeople} 人`;

  const note = document.createElement("p");
  note.className = "admin-avatar-note";
  note.textContent = `可用 ${formatNumber(summary.usable || 0)}，未匹配 ${formatNumber(summary.skippedUnmatched || 0)}，重名跳过 ${formatNumber(summary.skippedAmbiguous || 0)}`;
  els.adminActorAvatarCandidates.append(note);

  if (!people.length) {
    const empty = document.createElement("div");
    empty.className = "admin-avatar-empty";
    empty.textContent = "没有可选择的头像候选。";
    els.adminActorAvatarCandidates.append(empty);
    return;
  }

  for (const person of people) {
    const card = document.createElement("article");
    card.className = "admin-avatar-person";
    const header = document.createElement("div");
    header.className = "admin-avatar-person-header";
    const name = document.createElement("strong");
    name.textContent = person.displayName || person.personName || person.personId;
    const meta = document.createElement("span");
    meta.textContent = `${formatNumber((person.candidates || []).length)} 个候选${person.hasAvatar ? " · 已有头像" : ""}`;
    header.append(name, meta);
    card.append(header);

    for (const candidate of (person.candidates || []).slice(0, 4)) {
      card.append(createActorAvatarCandidateRow(person, candidate));
    }

    if ((person.candidates || []).length > 4) {
      const more = document.createElement("div");
      more.className = "admin-avatar-more";
      more.textContent = `还有 ${formatNumber(person.candidates.length - 4)} 个候选未显示`;
      card.append(more);
    }
    els.adminActorAvatarCandidates.append(card);
  }
}

function createActorAvatarCandidateRow(person, candidate) {
  const row = document.createElement("div");
  row.className = "admin-avatar-candidate";
  const text = document.createElement("div");
  text.className = "admin-avatar-candidate-text";
  const pathLine = document.createElement("span");
  pathLine.textContent = candidate.relPath || "";
  pathLine.title = candidate.relPath || "";
  const metaLine = document.createElement("small");
  metaLine.textContent = `${candidate.actorName || "未命名"} · ${formatBytes(candidate.size || 0)}`;
  text.append(pathLine, metaLine);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "folder-button compact";
  button.textContent = "设为头像";
  button.addEventListener("click", () => applyActorAvatarCandidate(person.personId, candidate.relPath, button));
  row.append(text, button);
  return row;
}

async function applyActorAvatarCandidate(personId, relPath, button) {
  const rootPath = String(els.adminActorAvatarDataPath?.value || "").trim();
  setAdminBusy(button, true, "写入中");
  try {
    const data = await api("/api/admin/apply-actor-avatar-candidate", {
      method: "POST",
      body: { rootPath, personId, relPath }
    });
    state.uiConfig = normalizeUiConfig(data.config);
    populateAdminConfig();
    await loadLibrary();
    els.adminStatus.textContent = `已设置头像：${data.person?.actorProfile?.displayName || data.person?.name || personId}`;
    await adminPreviewActorAvatarCandidates();
  } catch (error) {
    els.adminStatus.textContent = error.message || "设置头像失败";
  } finally {
    setAdminBusy(button, false);
  }
}

async function refreshCoverCacheStatus() {
  if (!els.adminCoverStatus || els.adminModal.getAttribute("aria-hidden") === "true") return;
  els.adminCoverStatus.textContent = "正在统计缺封面";
  try {
    const data = await api("/api/admin/cover-cache-status?limit=0");
    const candidates = Number(data.candidates || 0);
    const ready = Number(data.ready || 0);
    const missingVideo = Number(data.missingVideo || 0);
    if (!candidates) {
      els.adminCoverStatus.textContent = "当前没有需要补齐的封面";
      return;
    }
    els.adminCoverStatus.textContent = `缺封面候选 ${formatNumber(candidates)}，可生成 ${formatNumber(ready)}，视频不可读 ${formatNumber(missingVideo)}`;
  } catch (error) {
    els.adminCoverStatus.textContent = error.message || "封面状态读取失败";
  }
}

async function adminGenerateMissingCovers() {
  const limit = Math.max(1, Math.min(200, Number(els.adminCoverLimit?.value || 20) || 20));
  if (els.adminCoverLimit) els.adminCoverLimit.value = String(limit);
  setAdminBusy(els.adminGenerateCovers, true, "启动中");
  els.adminStatus.textContent = "正在启动缺封面补齐任务";
  try {
    const data = await api("/api/admin/generate-missing-covers", {
      method: "POST",
      body: { limit }
    });
    els.adminStatus.textContent = `已启动：${data.task?.label || "任务"}`;
    if (els.adminCoverStatus) els.adminCoverStatus.textContent = "任务运行中，完成后刷新封面统计";
    await refreshAdminTasks();
    startAdminPolling();
  } catch (error) {
    els.adminStatus.textContent = error.message || "启动失败";
  } finally {
    setAdminBusy(els.adminGenerateCovers, false);
  }
}

async function saveCompilationConfig(config) {
  const data = await api("/api/admin/config", {
    method: "PUT",
    body: { config: normalizeUiConfig(config) }
  });
  state.uiConfig = normalizeUiConfig(data.config);
  resetWorkPaging();
  if (state.activeView === "people" && !state.selectedPersonId) {
    renderPeopleIndexStats();
    renderPeopleIndex();
  } else {
    renderWorks();
  }
  return state.uiConfig;
}

function openCompilationConfig() {
  openAdminModal({ section: "compilation" });
}

function startAdminPolling() {
  stopAdminPolling();
  refreshAdminTasks();
  state.adminPollTimer = window.setInterval(refreshAdminTasks, 2500);
}

function stopAdminPolling() {
  if (state.adminPollTimer) {
    window.clearInterval(state.adminPollTimer);
    state.adminPollTimer = null;
  }
}

async function refreshAdminTasks() {
  if (!els.adminTaskList || els.adminModal.getAttribute("aria-hidden") === "true") return;
  try {
    const data = await api("/api/admin/tasks");
    const tasks = data.tasks || [];
    renderAdminTasks(tasks);
    await handleCompletedAdminTasks(tasks);
  } catch (error) {
    els.adminTaskList.innerHTML = `<div class="admin-empty">${error.message || "任务读取失败"}</div>`;
  }
}

async function handleCompletedAdminTasks(tasks) {
  for (const task of tasks) {
    if (task.status === "running" || state.handledAdminTaskIds.has(task.id)) continue;
    state.handledAdminTaskIds.add(task.id);
    if (task.status === "done" && task.type === "rankings") {
      state.rankingLists = [];
      if (state.activeView === "rankings") await loadRankings();
      els.adminStatus.textContent = "排行榜缓存已刷新";
      continue;
    }
    if (task.status === "done" && task.type === "covers") {
      await refreshCurrentWorkViewAfterAdminTask();
      await refreshCoverCacheStatus();
      els.adminStatus.textContent = "缺封面补齐任务已完成";
      continue;
    }
    if (task.status === "done" && task.personId && task.personId === state.selectedPersonId) {
      await selectPerson(task.personId, { resetFilter: false });
      els.adminStatus.textContent = "缺失检测已完成，当前人物已刷新";
    }
  }
}

async function refreshCurrentWorkViewAfterAdminTask() {
  if (state.currentWork?.id) {
    try {
      const data = await api(`/api/works/${encodeURIComponent(state.currentWork.id)}`);
      state.currentWork = data.work || state.currentWork;
      updateWorkSnapshot(state.currentWork);
      renderPlayer(state.currentWork, state.currentVideo?.id);
      renderMeta(state.currentWork);
    } catch {}
  }
  if (state.selectedPersonId && state.activeView === "people") {
    await selectPerson(state.selectedPersonId, { resetFilter: false });
    return;
  }
  if (state.activeView === "favorites") {
    await loadFavorites();
    return;
  }
  if (state.activeView === "history") {
    await loadHistory();
    return;
  }
  renderWorks();
}

function renderAdminTasks(tasks) {
  els.adminTaskList.innerHTML = "";
  if (!tasks.length) {
    els.adminTaskList.innerHTML = `<div class="admin-empty">暂无任务</div>`;
    return;
  }

  for (const task of tasks) {
    const item = document.createElement("article");
    item.className = `admin-task ${task.status}`;
    const title = document.createElement("div");
    title.className = "admin-task-title";
    const targetName = task.personName || (task.type === "rankings" ? "全局" : "未指定人物");
    title.textContent = `${task.label} · ${targetName} · ${task.status}`;

    const log = document.createElement("pre");
    log.textContent = (task.logs || []).slice(-18).join("\n");
    item.append(title, log);
    els.adminTaskList.append(item);
  }
}

function setActiveView(view, options = {}) {
  view = URL_VIEW_NAMES.has(view) ? view : "people";
  state.activeView = view;
  if (view !== "rankings" && state.sortMode === "ranking") {
    state.sortMode = "title";
    els.sortSelect.value = "title";
  }
  if (view !== "search") {
    state.searchPeople = [];
    state.searchQuery = "";
    state.searchFacets = null;
    state.searchTotal = 0;
  }
  els.viewTabs.forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderPeople();

  if (view === "favorites") {
    loadFavorites();
    syncRouteAfterNavigation(options);
    return;
  }

  if (view === "history") {
    loadHistory();
    syncRouteAfterNavigation(options);
    return;
  }

  if (view === "rankings") {
    clearWorkFilter();
    state.sortMode = "ranking";
    els.sortSelect.value = "ranking";
    loadRankings();
    syncRouteAfterNavigation(options);
    return;
  }

  showPeopleIndex({ skipRoute: true });
  syncRouteAfterNavigation(options);
}

function filteredPeople() {
  return state.people.filter((person) => includesText(personSearchText(person), state.personQuery));
}

function renderPeople() {
  const filtered = filteredPeople();
  els.personList.innerHTML = "";

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "没有匹配的人物";
    els.personList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const person of filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `person-button${person.id === state.selectedPersonId && state.activeView === "people" ? " active" : ""}`;
    button.addEventListener("click", () => {
      clearWorkSearch();
      state.activeView = "people";
      selectPerson(person.id);
    });

    const name = document.createElement("span");
    name.className = "person-name";
    name.textContent = displayPersonName(person);

    const count = document.createElement("span");
    count.className = "person-count";
    count.textContent =
      person.sourceCount > 1 ? `${formatNumber(person.workCount)} 部 · ${person.sourceCount} 处` : `${formatNumber(person.workCount)} 部`;

    button.append(name, count);
    fragment.append(button);
  }
  els.personList.append(fragment);
}

function showPeopleIndex(options = {}) {
  state.activeView = "people";
  state.selectedPersonId = null;
  state.selectedPerson = null;
  state.searchPeople = [];
  state.works = [];
  state.personWorksTotal = 0;
  state.personWorksFacets = null;
  renderPeople();
  els.viewTabs.forEach((button) => {
    const active = button.dataset.view === "people";
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  hidePersonProfile();
  setMainHeader("人物索引", "按人物浏览全部资料库");
  renderPeopleIndexStats();
  renderPeopleIndex();
  if (options.restoreScroll !== false) {
    restorePageScrollTop(state.peopleIndexScrollTop);
  }
  syncRouteAfterNavigation({
    ...options,
    routeOverrides: { view: "people", personId: "", q: "", workId: "", videoId: "" }
  });
}

function renderPeopleIndexStats() {
  const people = filteredPeople();
  const stats = [
    ["人物", people.length],
    ["有头像", people.filter((person) => actorAvatarUrl(person)).length],
    ["作品", people.reduce((sum, person) => sum + (person.workCount || 0), 0)],
    ["多来源", people.filter((person) => (person.sourceCount || 0) > 1).length]
  ];

  els.statsRow.innerHTML = "";
  for (const [label, value] of stats) {
    const stat = document.createElement("div");
    stat.className = "stat";
    stat.innerHTML = `<strong>${formatNumber(value)}</strong><span>${label}</span>`;
    els.statsRow.append(stat);
  }
}

function renderPeopleIndex() {
  disconnectPeopleIndexAutoload();
  const people = filteredPeople();
  els.workGrid.innerHTML = "";

  if (!people.length) {
    appendEmpty("没有匹配的人物。");
    return;
  }

  const fragment = document.createDocumentFragment();
  const visible = people.slice(0, state.personVisibleLimit);
  for (const person of visible) {
    fragment.append(createPersonIndexCard(person));
  }
  els.workGrid.append(fragment);

  if (visible.length < people.length) {
    appendPeopleIndexLoadMore(visible.length, people.length);
  }
}

function disconnectPeopleIndexAutoload() {
  if (!peopleIndexLoadObserver) return;
  peopleIndexLoadObserver.disconnect();
  peopleIndexLoadObserver = null;
}

function loadMorePeopleIndex() {
  if (state.activeView !== "people" || state.selectedPersonId) return;
  const people = filteredPeople();
  if (state.personVisibleLimit >= people.length) return;
  state.personVisibleLimit = Math.min(people.length, state.personVisibleLimit + state.personPageSize);
  renderPeopleIndex();
}

function observePeopleIndexLoadMore(target) {
  if (!("IntersectionObserver" in window)) return;
  peopleIndexLoadObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      window.setTimeout(loadMorePeopleIndex, 80);
    },
    { root: null, rootMargin: "720px 0px", threshold: 0 }
  );
  peopleIndexLoadObserver.observe(target);
}

function appendPeopleIndexLoadMore(visibleCount, totalCount) {
  const wrap = document.createElement("div");
  wrap.className = "load-more-row";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-button";
  button.textContent = `显示更多人物 ${formatNumber(visibleCount)} / ${formatNumber(totalCount)}`;
  button.addEventListener("click", loadMorePeopleIndex);

  wrap.append(button);
  els.workGrid.append(wrap);
  observePeopleIndexLoadMore(wrap);
}

function actorAvatarUrl(person) {
  return person?.actorProfile?.avatarUrl || coverUrl(person?.coverId);
}

function createPersonIndexCard(person) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "person-index-card";
  card.addEventListener("click", () => {
    clearWorkSearch();
    selectPerson(person.id);
  });

  const avatar = document.createElement("div");
  avatar.className = "person-index-avatar";
  const avatarUrl = actorAvatarUrl(person);
  if (avatarUrl) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.src = avatarUrl;
    img.addEventListener("error", () => {
      img.remove();
      avatar.classList.add("empty");
      avatar.textContent = person.name.slice(0, 2);
    });
    avatar.append(img);
  } else {
    avatar.classList.add("empty");
    avatar.textContent = person.name.slice(0, 2);
  }

  const body = document.createElement("div");
  body.className = "person-index-body";

  const name = document.createElement("div");
  name.className = "person-index-name";
  name.textContent = person.actorProfile?.displayName || person.name;

  const sub = document.createElement("div");
  sub.className = "person-index-sub";
  const aliases = person.actorProfile?.aliases || [];
  sub.textContent = aliases.length ? aliases.slice(0, 3).join("、") : formatLibraryPaths(person.sourcePaths || [person.relativePath]);

  const metrics = document.createElement("div");
  metrics.className = "person-index-metrics";
  metrics.append(createInfoChip(`${formatNumber(person.workCount)} 部`, "code"));
  metrics.append(createInfoChip(`${formatNumber(person.videoCount)} 视频`));

  body.append(name, sub, metrics);
  card.append(avatar, body);
  return card;
}

async function selectPerson(personId, options = {}) {
  disconnectPeopleIndexAutoload();
  if (state.activeView === "people" && !state.selectedPersonId && options.captureIndexScroll !== false) {
    state.peopleIndexScrollTop = currentPageScrollTop();
  }
  state.selectedPersonId = personId;
  state.activeView = "people";
  state.searchPeople = [];
  if (options.resetFilter !== false) {
    clearWorkFilter();
  }
  els.viewTabs.forEach((button) => {
    const active = button.dataset.view === "people";
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  renderPeople();
  els.workGrid.innerHTML = `<div class="empty-state">正在加载作品</div>`;

  const data = await fetchPersonWorksPage(personId, 0);
  state.selectedPerson = data.person;
  state.works = data.works || [];
  state.personWorksTotal = data.total || state.works.length;
  state.personWorksFacets = data.facets || null;
  resetWorkPaging();
  setMainHeader(state.selectedPerson.name, formatLibraryPaths(state.selectedPerson.sourcePaths || [state.selectedPerson.relativePath]));
  renderPersonProfile(state.selectedPerson);
  renderPersonWorkStats();
  renderWorks();
  syncRouteAfterNavigation({
    ...options,
    routeOverrides: { view: "people", personId, q: "", workId: "", videoId: "" }
  });
}

function personWorkPageSize() {
  return Math.max(80, Number(state.workPageSize || 160));
}

async function fetchPersonWorksPage(personId, offset = 0) {
  const params = new URLSearchParams({
    limit: String(personWorkPageSize()),
    offset: String(offset || 0),
    sort: state.sortMode || "updated",
    filter: state.filterMode || "all"
  });
  return api(`/api/people/${encodeURIComponent(personId)}?${params}`);
}

async function goToPerson(personId) {
  if (!personId) return;
  if (els.detailDrawer.classList.contains("open")) {
    closeDrawer();
  }
  clearWorkSearch();
  await selectPerson(personId);
}

async function loadFavorites() {
  els.workGrid.innerHTML = `<div class="empty-state">正在加载收藏</div>`;
  const params = new URLSearchParams();
  if (state.selectedFavoriteFolderId && state.selectedFavoriteFolderId !== "all") {
    params.set("folder", state.selectedFavoriteFolderId);
  }
  const query = params.toString();
  const data = await api(`/api/favorites${query ? `?${query}` : ""}`);
  state.selectedPerson = null;
  state.searchPeople = [];
  state.personWorksTotal = 0;
  state.personWorksFacets = null;
  hidePersonProfile();
  state.works = data.works || [];
  state.favoriteFolders = data.folders || [];
  state.selectedFavoriteFolderId = data.selectedFolderId || state.selectedFavoriteFolderId || "all";
  resetWorkPaging();
  const folder = favoriteFolderById(state.selectedFavoriteFolderId);
  setMainHeader("收藏", folder ? `${folder.name} · ${formatNumber(folder.count || 0)} 部` : "已收藏的作品");
  renderStatsForWorks(state.works);
  renderFavoriteFolderControls();
  renderWorks("还没有收藏。");
}

function favoriteFolderById(folderId) {
  return (state.favoriteFolders || []).find((folder) => folder.id === folderId) || null;
}

function favoriteFolderTotal() {
  return (state.favoriteFolders || []).reduce((sum, folder) => sum + Number(folder.count || 0), 0);
}

function renderFavoriteFolderControls() {
  if (state.activeView !== "favorites") return;
  const folders = state.favoriteFolders || [];
  const wrap = document.createElement("div");
  wrap.className = "stat-quick-filters favorite-folder-controls";

  const group = document.createElement("div");
  group.className = "stat-filter-group";
  const heading = document.createElement("span");
  heading.className = "stat-filter-label";
  heading.textContent = "收藏夹";
  group.append(heading);

  const allButton = createFavoriteFolderFilterButton("all", "全部", favoriteFolderTotal());
  group.append(allButton);
  for (const folder of folders) {
    group.append(createFavoriteFolderFilterButton(folder.id, folder.name, folder.count || 0));
  }

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "stat-filter-chip";
  addButton.textContent = "新建";
  addButton.addEventListener("click", createFavoriteFolder);

  wrap.append(group, addButton);
  els.statsRow.append(wrap);
}

function createFavoriteFolderFilterButton(folderId, name, count) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `stat-filter-chip${state.selectedFavoriteFolderId === folderId ? " active" : ""}`;
  button.textContent = `${name} ${formatNumber(count || 0)}`;
  button.addEventListener("click", () => {
    if (state.selectedFavoriteFolderId === folderId) return;
    state.selectedFavoriteFolderId = folderId;
    loadFavorites();
  });
  return button;
}

async function createFavoriteFolder() {
  const name = window.prompt("新收藏夹名称");
  if (!name || !name.trim()) return;
  try {
    const data = await api("/api/favorite-folders", { method: "POST", body: { name } });
    state.favoriteFolders = data.folders || state.favoriteFolders;
    await loadFavorites();
  } catch (error) {
    alert(error.message);
  }
}

async function loadHistory() {
  els.workGrid.innerHTML = `<div class="empty-state">正在加载观看记录</div>`;
  const data = await api(historyPath());
  state.selectedPerson = null;
  state.searchPeople = [];
  state.personWorksTotal = 0;
  state.personWorksFacets = null;
  hidePersonProfile();
  state.works = data.works || [];
  resetWorkPaging();
  const rangeLabel = historyRangeLabel(state.selectedHistoryRange);
  const total = data.total ?? data.count ?? state.works.length;
  setMainHeader("继续观看", state.selectedHistoryRange === "all" ? "全部有播放进度的作品" : `${rangeLabel}有播放进度的作品 · ${formatNumber(total)} 部`);
  renderStatsForWorks(state.works);
  renderHistoryRangeControls(data);
  renderWorks("暂无观看记录。");
}

function historyPath() {
  const params = new URLSearchParams();
  if (state.selectedHistoryRange && state.selectedHistoryRange !== "all") {
    params.set("days", state.selectedHistoryRange);
  }
  const query = params.toString();
  return `/api/history${query ? `?${query}` : ""}`;
}

function historyRangeLabel(value) {
  return HISTORY_RANGE_OPTIONS.find((item) => item.value === value)?.label || "30 天";
}

function renderHistoryRangeControls(data = {}) {
  if (state.activeView !== "history") return;
  const wrap = document.createElement("div");
  wrap.className = "stat-quick-filters history-range-controls";

  const group = document.createElement("div");
  group.className = "stat-filter-group";
  const heading = document.createElement("span");
  heading.className = "stat-filter-label";
  heading.textContent = "最近观看";
  group.append(heading);

  for (const option of HISTORY_RANGE_OPTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `stat-filter-chip${state.selectedHistoryRange === option.value ? " active" : ""}`;
    button.textContent = option.value === state.selectedHistoryRange ? `${option.label} ${formatNumber(data.total ?? state.works.length)}` : option.label;
    button.addEventListener("click", () => {
      if (state.selectedHistoryRange === option.value) return;
      state.selectedHistoryRange = option.value;
      loadHistory();
    });
    group.append(button);
  }

  wrap.append(group);
  els.statsRow.append(wrap);
}

async function loadRankings() {
  els.workGrid.innerHTML = `<div class="empty-state">正在加载排行榜</div>`;
  state.selectedPersonId = null;
  state.selectedPerson = null;
  state.searchPeople = [];
  state.personWorksTotal = 0;
  state.personWorksFacets = null;
  setMainHeader("排行榜", "JavDB TOP250 缓存");

  try {
    const summary = await api("/api/rankings");
    state.rankingLists = summary.lists || [];
    if (state.rankingLists.length && !state.rankingLists.some((item) => item.key === state.selectedRankingKey)) {
      state.selectedRankingKey = state.rankingLists.find((item) => item.key === "y2025")?.key || state.rankingLists[0].key || "";
    }
    await loadRankingWorks();
  } catch (error) {
    hidePersonProfile();
    renderEmpty(error.message || "排行榜读取失败");
  }
}

async function loadRankingWorks() {
  const key = state.selectedRankingKey || "";
  const params = new URLSearchParams({
    key,
    limit: "1000"
  });
  const data = await api(`/api/rankings/top?${params}`);
  state.works = data.works || [];
  state.rankingTotal = data.rankingTotal || data.total || state.works.length;
  state.rankingMissingTotal = data.missingTotal || 0;
  state.rankingLocalTotal = data.localTotal || 0;
  state.rankingUpdatedAt = data.updatedAt || "";
  state.rankingPageUrl = data.pageUrl || "";
  resetWorkPaging();
  renderRankingPanel(data);
  renderRankingStats(data);
  renderWorks(state.rankingLists.length ? "这个榜单没有匹配项目。" : "还没有缓存排行榜。");
}

function renderRankingPanel(data = {}) {
  if (!els.personProfile) return;
  els.personProfile.hidden = false;
  els.personProfile.classList.add("ranking-profile-panel");
  els.personProfile.innerHTML = "";

  const header = document.createElement("div");
  header.className = "ranking-panel-header";
  const title = document.createElement("h3");
  title.textContent = data.label || "TOP250";
  const meta = document.createElement("div");
  meta.className = "ranking-panel-meta";
  meta.textContent = data.updatedAt ? `更新 ${formatDate(data.updatedAt) || data.updatedAt}` : "未缓存";
  header.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "ranking-panel-actions";
  if (state.rankingPageUrl) {
    const link = document.createElement("a");
    link.href = state.rankingPageUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.className = "folder-button";
    link.textContent = "打开 JavDB";
    actions.append(link);
  }
  if (state.accessMode === "local") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "folder-button";
    button.textContent = "刷新缓存";
    button.addEventListener("click", adminRefreshRankings);
    actions.append(button);
  }
  header.append(actions);

  const list = document.createElement("div");
  list.className = "ranking-chip-list";
  if (!state.rankingLists.length) {
    const empty = document.createElement("div");
    empty.className = "ranking-empty-note";
    empty.textContent = "后台刷新后会出现在这里";
    list.append(empty);
  } else {
    for (const item of state.rankingLists) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `ranking-chip${item.key === state.selectedRankingKey ? " active" : ""}`;
      button.textContent = `${item.label} · 缺 ${formatNumber(item.missingTotal)}`;
      button.addEventListener("click", async () => {
        state.selectedRankingKey = item.key || "";
        await loadRankingWorks();
      });
      list.append(button);
    }
  }

  els.personProfile.append(header, list);
}

function renderRankingStats(data = {}) {
  const stats = [
    ["榜单", data.rankingTotal || state.rankingTotal || 0],
    ["本地已有", data.localTotal || state.rankingLocalTotal || 0],
    ["未下载", data.missingTotal || state.rankingMissingTotal || 0],
    ["当前显示", visibleWorks().length]
  ];

  els.statsRow.innerHTML = "";
  for (const [label, value] of stats) {
    const stat = document.createElement("div");
    stat.className = "stat";
    stat.innerHTML = `<strong>${formatNumber(value)}</strong><span>${label}</span>`;
    els.statsRow.append(stat);
  }
}

function setMainHeader(title, pathText) {
  els.currentTitle.textContent = title;
  els.currentPath.textContent = pathText;
  updateBackToPeopleIndexButton();
}

function updateBackToPeopleIndexButton() {
  if (!els.backToPeopleIndex) return;
  els.backToPeopleIndex.hidden = !(state.activeView === "people" && state.selectedPersonId);
}

function returnToPeopleIndex() {
  clearWorkSearch();
  showPeopleIndex({ restoreScroll: true });
}

function hidePersonProfile() {
  if (!els.personProfile) return;
  els.personProfile.hidden = true;
  els.personProfile.classList.remove("ranking-profile-panel");
  els.personProfile.innerHTML = "";
}

function renderPersonProfile(person) {
  if (!els.personProfile || !person) return;

  const profile = person.actorProfile || null;
  const avatarUrl = profile?.avatarUrl || coverUrl(person.coverId);
  const displayName = profile?.displayName || person.name;
  const aliases = profile?.aliases || [];

  els.personProfile.hidden = false;
  els.personProfile.classList.remove("ranking-profile-panel");
  els.personProfile.innerHTML = "";

  const avatar = document.createElement("div");
  avatar.className = "person-avatar";
  if (avatarUrl) {
    const img = document.createElement("img");
    img.alt = "";
    img.src = avatarUrl;
    img.addEventListener("error", () => {
      img.remove();
      avatar.textContent = person.name.slice(0, 2);
      avatar.classList.add("empty");
    });
    avatar.append(img);
  } else {
    avatar.classList.add("empty");
    avatar.textContent = person.name.slice(0, 2);
  }

  const copy = document.createElement("div");
  copy.className = "person-profile-copy";

  const nameRow = document.createElement("div");
  nameRow.className = "person-profile-name-row";

  const title = document.createElement("h3");
  title.textContent = displayName;
  nameRow.append(title);

  if (profile?.javdbUrl) {
    const link = document.createElement("a");
    link.className = "person-profile-link";
    link.href = profile.javdbUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.title = "打开外部资料页";
    link.textContent = "资料页";
    nameRow.append(link);
  }

  if (state.accessMode === "local") {
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "person-profile-link";
    editButton.textContent = profile?.javdbUrl ? "编辑映射" : "配置资料页";
    nameRow.append(editButton);
  }

  const sub = document.createElement("div");
  sub.className = "person-profile-sub";
  sub.textContent = aliases.length ? aliases.join("、") : formatLibraryPaths(person.sourcePaths || [person.relativePath]);

  const metrics = document.createElement("div");
  metrics.className = "person-profile-metrics";
  const hasActorCache = (person.actorMovieCount ?? profile?.movieCount ?? 0) > 0 || Boolean(profile?.javdbUrl);
  metrics.append(createProfileMetric("作品", person.workCount), createProfileMetric("视频", person.videoCount));
  if (hasActorCache) {
    metrics.append(
      createProfileMetric("JavDB", person.actorMovieCount ?? profile?.movieCount ?? 0),
      createProfileMetric("未下载", person.missingLocalWorkCount ?? 0)
    );
  } else {
    metrics.append(createProfileMetric("可播", person.playableCount));
  }

  copy.append(nameRow, sub, metrics);
  const editor = state.accessMode === "local" ? createActorProfileEditor(person, profile) : null;
  const actions = createPersonProfileActions(person);
  if (editor) {
    copy.append(editor);
    const editButton = nameRow.querySelector("button.person-profile-link");
    editButton?.addEventListener("click", () => {
      editor.hidden = !editor.hidden;
      if (!editor.hidden) editor.querySelector("input")?.focus();
    });
  }
  if (actions) copy.append(actions);
  els.personProfile.append(avatar, copy);
}

function createActorProfileEditor(person, profile) {
  const form = document.createElement("form");
  form.className = "actor-config-form";
  form.hidden = Boolean(profile?.javdbUrl);

  const urlLabel = document.createElement("label");
  urlLabel.className = "actor-config-field wide";
  const urlText = document.createElement("span");
  urlText.textContent = "JavDB actor 页";
  const urlInput = document.createElement("input");
  urlInput.type = "url";
  urlInput.placeholder = "https://javdb.com/actors/BzpA";
  urlInput.value = profile?.javdbUrl || "";
  urlInput.required = true;
  urlLabel.append(urlText, urlInput);

  const nameLabel = document.createElement("label");
  nameLabel.className = "actor-config-field";
  const nameText = document.createElement("span");
  nameText.textContent = "显示名";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = profile?.displayName || person.name;
  nameLabel.append(nameText, nameInput);

  const aliasesLabel = document.createElement("label");
  aliasesLabel.className = "actor-config-field wide";
  const aliasesText = document.createElement("span");
  aliasesText.textContent = "别名 / 曾用名";
  const aliasesInput = document.createElement("textarea");
  aliasesInput.rows = 3;
  aliasesInput.spellcheck = false;
  aliasesInput.placeholder = "一行一个，也可用逗号、顿号分隔";
  aliasesInput.value = (profile?.aliases || []).join("\n");
  aliasesLabel.append(aliasesText, aliasesInput);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "folder-button";
  submit.textContent = "保存映射";

  const status = document.createElement("span");
  status.className = "actor-config-status";

  form.append(urlLabel, nameLabel, aliasesLabel, submit, status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveActorProfileMapping(person, {
      javdbUrl: urlInput.value,
      displayName: nameInput.value,
      aliases: linesFromTextarea(aliasesInput.value),
      button: submit,
      status
    });
  });
  return form;
}

async function saveActorProfileMapping(person, options) {
  const originalText = options.button.textContent;
  options.button.disabled = true;
  options.button.textContent = "保存中";
  options.status.textContent = "";

  try {
    const data = await api(`/api/actor-profiles/${encodeURIComponent(person.id)}`, {
      method: "PUT",
      body: {
        javdbUrl: options.javdbUrl,
        displayName: options.displayName || person.name,
        aliases: options.aliases || [],
        source: "manual",
        status: "ok"
      }
    });
    updatePersonActorProfile(person.id, data.profile);
    options.status.textContent = "已保存";
    await selectPerson(person.id, { resetFilter: false });
  } catch (error) {
    options.status.textContent = error.message || "保存失败";
  } finally {
    options.button.disabled = false;
    options.button.textContent = originalText;
  }
}

function updatePersonActorProfile(personId, profile) {
  state.people = state.people.map((person) => (person.id === personId ? { ...person, actorProfile: profile } : person));
  if (state.selectedPerson?.id === personId) {
    state.selectedPerson = { ...state.selectedPerson, actorProfile: profile, actorMovieCount: 0, missingLocalWorkCount: 0 };
  }
  renderPeople();
}

function createPersonProfileActions(person) {
  if (state.accessMode !== "local") return null;
  const paths = uniqueSourcePaths(person);
  if (!paths.length) return null;

  const actions = document.createElement("div");
  actions.className = "person-profile-actions";

  for (const sourcePath of paths) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "folder-button";
    button.textContent = sourceButtonLabel(sourcePath);
    button.title = formatLibraryPath(sourcePath);
    button.addEventListener("click", () => openLocalFolder(sourcePath, button));
    actions.append(button);
  }

  return actions;
}

async function openLocalFolder(sourcePath, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "打开中";

  try {
    await api("/api/open-folder", { method: "POST", body: { sourcePath } });
    button.textContent = "已打开";
    window.setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
    }, 1200);
  } catch (error) {
    button.textContent = "打开失败";
    button.title = error.message || "打开失败";
    window.setTimeout(() => {
      button.textContent = originalText;
      button.disabled = false;
      button.title = formatLibraryPath(sourcePath);
    }, 2000);
  }
}

function createProfileMetric(label, value) {
  const item = document.createElement("span");
  item.innerHTML = `<strong></strong><small></small>`;
  item.querySelector("strong").textContent = formatNumber(value);
  item.querySelector("small").textContent = label;
  return item;
}

function createStatCard(label, value) {
  const stat = document.createElement("div");
  stat.className = "stat";
  const number = document.createElement("strong");
  number.textContent = formatNumber(value);
  const caption = document.createElement("span");
  caption.textContent = label;
  stat.append(number, caption);
  return stat;
}

function renderStatsForWorks(works, person = null) {
  const hasActorCache = person
    ? (person.actorMovieCount ?? person.actorProfile?.movieCount ?? 0) > 0 || Boolean(person.actorProfile?.javdbUrl)
    : false;
  const stats = person
    ? hasActorCache
      ? [
          ["本地作品", person.workCount],
          ["视频", person.videoCount],
          ["JavDB作品", person.actorMovieCount ?? person.actorProfile?.movieCount ?? 0],
          ["未下载", person.missingLocalWorkCount ?? works.filter((work) => work.missingLocal).length]
        ]
      : [
          ["作品", person.workCount],
          ["视频", person.videoCount],
          ["可网页播放", person.playableCount],
          ["资料", person.infoCount]
        ]
    : [
        ["作品", works.length],
        ["视频", works.reduce((sum, work) => sum + work.videoCount, 0)],
        ["可网页播放", works.reduce((sum, work) => sum + work.playableCount, 0)],
        ["有进度", works.filter((work) => work.progress).length]
      ];

  els.statsRow.innerHTML = "";
  for (const [label, value] of stats) {
    els.statsRow.append(createStatCard(label, value));
  }
  appendMetadataQuickFilters(works);
}

function renderSearchStats() {
  const facets = state.searchFacets || {};
  const stats = [
    ["搜索命中", facets.all ?? state.searchTotal],
    [searchFilterLabel(), state.searchTotal],
    ["已显示", searchVisibleCount()],
    ["本地", facets.localOnly ?? state.works.filter((work) => !work.missingLocal).length],
    ["未下载", facets.missingLocal ?? state.works.filter((work) => work.missingLocal).length]
  ];

  els.statsRow.innerHTML = "";
  for (const [label, value] of stats) {
    els.statsRow.append(createStatCard(label, value));
  }
  appendMetadataQuickFilters(state.works);
}

function searchFilterLabel() {
  const option = els.filterSelect?.selectedOptions?.[0];
  if (!option || state.filterMode === "all") return "当前筛选";
  return `${option.textContent || "当前"}结果`;
}

function searchVisibleCount() {
  return Math.min(visibleWorks().length, state.workVisibleLimit);
}

function renderPersonWorkStats() {
  const person = state.selectedPerson;
  if (!person) {
    renderStatsForWorks(state.works);
    return;
  }

  const facets = state.personWorksFacets || {};
  const stats = [
    ["人物作品", facets.all ?? person.workCount ?? state.personWorksTotal],
    [searchFilterLabel(), state.personWorksTotal || state.works.length],
    ["已显示", searchVisibleCount()],
    ["本地", facets.localOnly ?? state.works.filter((work) => !work.missingLocal).length],
    ["未下载", facets.missingLocal ?? person.missingLocalWorkCount ?? state.works.filter((work) => work.missingLocal).length],
    ["有评分", facets.rated ?? state.works.filter((work) => numericRating(work.infoSummary?.rating) !== null).length]
  ];

  els.statsRow.innerHTML = "";
  for (const [label, value] of stats) {
    els.statsRow.append(createStatCard(label, value));
  }
  appendMetadataQuickFilters(state.works);
}

function appendMetadataQuickFilters(works) {
  const groups = [
    ["类别", topInfoValues(works, (info) => info.tags, 8)],
    ["片商", topInfoValues(works, (info) => [info.maker, info.label], 6)],
    ["系列", topInfoValues(works, (info) => info.series, 4)]
  ].filter(([, items]) => items.length);

  if (!groups.length) return;

  const wrap = document.createElement("div");
  wrap.className = "stat-quick-filters";

  for (const [label, items] of groups) {
    const group = document.createElement("div");
    group.className = "stat-filter-group";
    const heading = document.createElement("span");
    heading.className = "stat-filter-label";
    heading.textContent = label;
    group.append(heading);

    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "stat-filter-chip";
      button.textContent = `${item.value} ${formatNumber(item.count)}`;
      button.title = `${label}: ${item.value}`;
      button.addEventListener("click", () => applyWorkSearch(item.value));
      group.append(button);
    }

    wrap.append(group);
  }

  els.statsRow.append(wrap);
}

function topInfoValues(works, selectValues, limit) {
  const counts = new Map();
  for (const work of works || []) {
    const info = work?.infoSummary || {};
    const rawValues = selectValues(info);
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    const seenForWork = new Set();
    for (const value of values.flat()) {
      const clean = String(value || "").trim();
      if (!clean || clean.length > 32 || seenForWork.has(clean)) continue;
      seenForWork.add(clean);
      counts.set(clean, (counts.get(clean) || 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .filter((item) => item.count > 1)
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: "base" }))
    .slice(0, limit);
}

function visibleWorks() {
  const query = state.activeView === "search" ? "" : state.workQuery.trim().toLowerCase();
  let works = state.works.filter((work) => {
    if (!query) return true;
    return (
      includesText(work.title, query) ||
      includesText(workInfoSearchText(work), query) ||
      includesText(work.directoryName, query) ||
      includesText(work.relativePath, query) ||
      includesText(workPersonSearchText(work), query)
    );
  });

  if (!state.showCompilationWorks) {
    works = works.filter((work) => !isCompilationWork(work));
  }

  if (!state.showMissingLocalWorks && state.filterMode !== "missingLocal") {
    works = works.filter((work) => !work.missingLocal);
  }

  works = works.filter((work) => {
    if (state.filterMode === "playable") return work.playableCount > 0;
    if (state.filterMode === "favorite") return work.favorite;
    if (state.filterMode === "progress") return Boolean(work.progress);
    if (state.filterMode === "info") return work.infoCount > 0;
    if (state.filterMode === "localOnly") return !work.missingLocal;
    if (state.filterMode === "rated") return numericRating(work.infoSummary?.rating) !== null;
    if (state.filterMode === "highRating") {
      const rating = numericRating(work.infoSummary?.rating);
      return rating !== null && rating >= 4;
    }
    if (state.filterMode === "vr") return isVrWork(work);
    if (state.filterMode === "missingLocal") return Boolean(work.missingLocal);
    if (state.filterMode === "missingCover") return !workCoverUrl(work);
    return true;
  });

  works.sort((a, b) => {
    if (state.sortMode === "ranking") return compareWorkRanking(a, b) || compareWorkTitle(a, b);
    if (state.sortMode === "releaseDesc") return compareWorkReleaseDate(a, b, "desc") || compareWorkTitle(a, b);
    if (state.sortMode === "releaseAsc") return compareWorkReleaseDate(a, b, "asc") || compareWorkTitle(a, b);
    if (state.sortMode === "updated") return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""));
    if (state.sortMode === "ratingDesc") return compareWorkRating(a, b, "desc") || compareWorkTitle(a, b);
    if (state.sortMode === "ratingAsc") return compareWorkRating(a, b, "asc") || compareWorkTitle(a, b);
    if (state.sortMode === "progress") return String(b.progress?.updatedAt || "").localeCompare(String(a.progress?.updatedAt || ""));
    if (state.sortMode === "sizeDesc") return compareWorkSize(a, b) || compareWorkTitle(a, b);
    if (state.sortMode === "durationDesc") return compareWorkDuration(a, b) || compareWorkTitle(a, b);
    if (state.sortMode === "videos") return b.videoCount - a.videoCount || a.title.localeCompare(b.title, undefined, { numeric: true });
    return compareWorkTitle(a, b);
  });

  return works;
}

function compareWorkRanking(a, b) {
  const aRank = Number(a.ranking?.rankNo || 0);
  const bRank = Number(b.ranking?.rankNo || 0);
  const aHas = Number.isFinite(aRank) && aRank > 0;
  const bHas = Number.isFinite(bRank) && bRank > 0;
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aHas && aRank !== bRank) return aRank - bRank;
  return 0;
}

function compareWorkRating(a, b, direction = "desc") {
  const aRating = numericRating(a.infoSummary?.rating);
  const bRating = numericRating(b.infoSummary?.rating);
  const aHas = aRating !== null;
  const bHas = bRating !== null;
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (!aHas && !bHas) return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""));
  if (aRating !== bRating) return direction === "asc" ? aRating - bRating : bRating - aRating;

  const aCount = Number(a.infoSummary?.ratingCount || 0);
  const bCount = Number(b.infoSummary?.ratingCount || 0);
  if (aCount !== bCount) return bCount - aCount;
  return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""));
}

function compareWorkReleaseDate(a, b, direction = "desc") {
  const aDate = workReleaseDate(a);
  const bDate = workReleaseDate(b);
  const aHas = Boolean(aDate);
  const bHas = Boolean(bDate);
  if (aHas !== bHas) return aHas ? -1 : 1;
  if (aDate !== bDate) return direction === "asc" ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate);
  return String(b.modifiedAt || "").localeCompare(String(a.modifiedAt || ""));
}

function compareWorkSize(a, b) {
  return Number(b.videoSize || 0) - Number(a.videoSize || 0);
}

function compareWorkDuration(a, b) {
  return Number(b.infoSummary?.durationMinutes || 0) - Number(a.infoSummary?.durationMinutes || 0);
}

function workReleaseDate(work) {
  return String(work.infoSummary?.releaseDate || "").trim();
}

function isCompilationWork(work) {
  if (!work?.missingLocal) return false;

  const config = normalizeUiConfig(state.uiConfig);
  const code = String(work.infoSummary?.code || extractWorkCode(work) || "").trim();
  const codePrefix = code.match(/^([A-Z0-9]+)[-_\s]?\d+/i)?.[1]?.toUpperCase() || "";
  if (codePrefix && config.compilationPrefixes.includes(codePrefix)) return true;

  const text = `${work.title || ""} ${work.directoryName || ""} ${work.infoSummary?.title || ""}`;
  const upperText = text.toUpperCase();
  if (config.compilationPrefixes.some((prefix) => new RegExp(`(^|[^A-Z0-9])${escapeRegExp(prefix)}[-_\\s]?\\d+`, "i").test(text))) {
    return true;
  }
  return config.compilationKeywords.some((keyword) => upperText.includes(String(keyword).toUpperCase()));
}

function numericRating(value) {
  if (value === null || value === undefined || value === "") return null;
  const rating = Number(value);
  return Number.isFinite(rating) ? rating : null;
}

function compareWorkTitle(a, b) {
  return String(a.title || a.directoryName || "").localeCompare(String(b.title || b.directoryName || ""), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function resetWorkPaging() {
  state.workVisibleLimit = state.workPageSize;
}

function resetPersonPaging() {
  state.personVisibleLimit = state.personPageSize;
}

function clearWorkSearch() {
  state.workQuery = "";
  els.workSearch.value = "";
}

function applyWorkSearch(query) {
  const value = String(query || "").trim();
  state.workQuery = value;
  els.workSearch.value = value;
  window.clearTimeout(state.searchTimer);
  resetWorkPaging();
  return loadSearchResults(value);
}

function clearWorkFilter() {
  state.filterMode = "all";
  els.filterSelect.value = "all";
}

async function loadSearchResults(query, options = {}) {
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) {
    state.searchPeople = [];
    state.searchQuery = "";
    state.searchFacets = null;
    state.searchTotal = 0;
    if (state.activeView === "search") {
      setActiveView(state.searchReturnView || "people", {
        ...options,
        replaceRoute: Object.prototype.hasOwnProperty.call(options, "replaceRoute") ? options.replaceRoute : true
      });
    } else {
      renderWorks();
    }
    return;
  }

  const enteringSearch = state.activeView !== "search";
  if (state.activeView !== "search") {
    state.searchReturnView = state.activeView || "people";
    if (state.filterMode !== "all") {
      state.filterMode = "all";
      els.filterSelect.value = "all";
    }
    if (state.sortMode === "ranking") {
      state.sortMode = "title";
      els.sortSelect.value = "title";
    }
  }

  state.activeView = "search";
  els.viewTabs.forEach((button) => {
    button.classList.remove("active");
    button.setAttribute("aria-pressed", "false");
  });
  renderPeople();
  hidePersonProfile();
  setMainHeader(`搜索：${normalizedQuery}`, "全库 · 番号 / 标题 / 文件名 / 人物 / 类别 / 片商");
  els.statsRow.innerHTML = "";
  els.workGrid.innerHTML = `<div class="empty-state">正在全库搜索</div>`;
  state.searchQuery = normalizedQuery;
  state.searchTotal = 0;
  state.searchFacets = null;
  state.searchLoadingMore = false;

  const seq = ++state.searchSeq;
  try {
    const data = await fetchSearchPage(normalizedQuery, 0);
    if (seq !== state.searchSeq) return;
    state.selectedPerson = null;
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    state.searchPeople = data.people || [];
    state.works = data.works || [];
    state.searchTotal = data.total || state.works.length;
    state.searchFacets = data.facets || null;
    resetWorkPaging();
    renderSearchStats();
    renderWorks(`没有搜到「${normalizedQuery}」。`);
    syncRouteAfterNavigation({
      ...options,
      replaceRoute: Object.prototype.hasOwnProperty.call(options, "replaceRoute") ? options.replaceRoute : !enteringSearch,
      routeOverrides: { view: "search", personId: "", q: normalizedQuery, workId: "", videoId: "" }
    });
  } catch (error) {
    if (seq !== state.searchSeq) return;
    renderEmpty(error.message);
  }
}

function searchPageSize() {
  return state.accessMode === "lan" ? 80 : 1000;
}

async function fetchSearchPage(query, offset) {
  const params = new URLSearchParams({
    q: query,
    limit: String(searchPageSize()),
    offset: String(offset || 0),
    sort: state.sortMode || "updated",
    filter: state.filterMode || "all"
  });
  return api(`/api/search?${params}`);
}

async function loadMoreSearchResults(button) {
  if (state.searchLoadingMore || state.activeView !== "search" || !state.searchQuery) return;
  state.searchLoadingMore = true;
  const originalText = button?.textContent || "";
  let restoreInFinally = true;
  if (button) {
    button.disabled = true;
    button.textContent = "正在加载";
  }

  try {
    const data = await fetchSearchPage(state.searchQuery, state.works.length);
    const seen = new Set(state.works.map((work) => work.id));
    const nextWorks = (data.works || []).filter((work) => !seen.has(work.id));
    state.works.push(...nextWorks);
    state.searchTotal = data.total || state.searchTotal || state.works.length;
    state.searchFacets = data.facets || state.searchFacets || null;
    if (!state.searchPeople.length) state.searchPeople = data.people || [];
    state.workVisibleLimit += state.workPageSize;
    renderSearchStats();
    renderWorks(`没有搜到「${state.searchQuery}」。`);
  } catch (error) {
    toastInline(button, error.message || "加载失败", originalText);
    restoreInFinally = false;
  } finally {
    state.searchLoadingMore = false;
    if (button && button.isConnected) button.disabled = false;
    if (restoreInFinally && button && button.isConnected) {
      button.disabled = false;
      button.textContent = originalText || button.textContent;
    }
  }
}

async function loadMorePersonWorks(button) {
  if (state.personWorksLoadingMore || state.activeView !== "people" || !state.selectedPersonId) return;
  if (state.works.length >= state.personWorksTotal) return;

  state.personWorksLoadingMore = true;
  const originalText = button?.textContent || "";
  let restoreInFinally = true;
  if (button) {
    button.disabled = true;
    button.textContent = "正在加载";
  }

  try {
    const personId = state.selectedPersonId;
    const data = await fetchPersonWorksPage(personId, state.works.length);
    if (state.selectedPersonId !== personId) return;
    const seen = new Set(state.works.map((work) => work.id));
    const nextWorks = (data.works || []).filter((work) => !seen.has(work.id));
    state.works.push(...nextWorks);
    state.selectedPerson = data.person || state.selectedPerson;
    state.personWorksTotal = data.total || state.personWorksTotal || state.works.length;
    state.personWorksFacets = data.facets || state.personWorksFacets || null;
    renderPersonProfile(state.selectedPerson);
    renderPersonWorkStats();
    renderWorks();
  } catch (error) {
    toastInline(button, error.message || "加载失败", originalText);
    restoreInFinally = false;
  } finally {
    state.personWorksLoadingMore = false;
    if (button && button.isConnected) button.disabled = false;
    if (restoreInFinally && button && button.isConnected) {
      button.disabled = false;
      button.textContent = originalText || button.textContent;
    }
  }
}

function toastInline(button, message, restoreText) {
  if (!button) {
    alert(message);
    return;
  }
  button.textContent = message;
  window.setTimeout(() => {
    if (button.isConnected) button.textContent = restoreText;
  }, 1800);
}

function renderWorks(emptyMessage = "没有匹配的作品。") {
  disconnectPeopleIndexAutoload();
  const works = visibleWorks();
  els.workGrid.innerHTML = "";
  renderSearchPeoplePanel();

  const hasSearchServerMore = state.activeView === "search" && state.works.length < state.searchTotal;
  const hasPersonServerMore = state.activeView === "people" && state.selectedPersonId && state.works.length < state.personWorksTotal;
  const hasServerMore = hasSearchServerMore || hasPersonServerMore;
  if (!works.length && !hasServerMore) {
    appendEmpty(emptyMessage);
    return;
  }

  const visible = works.slice(0, state.workVisibleLimit);
  const fragment = document.createDocumentFragment();
  visible.forEach((work, index) => {
    fragment.append(createWorkCard(work, index));
  });
  els.workGrid.append(fragment);

  if (visible.length < works.length || hasServerMore) {
    appendLoadMore(visible.length, works.length, { hasSearchServerMore, hasPersonServerMore });
  }
}

function appendLoadMore(visibleCount, totalCount, options = {}) {
  const hasSearchServerMore = Boolean(options.hasSearchServerMore);
  const hasPersonServerMore = Boolean(options.hasPersonServerMore);
  const wrap = document.createElement("div");
  wrap.className = "load-more-row";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-button";
  const loadedCount =
    state.activeView === "search"
      ? Math.max(state.works.length, visibleCount)
      : hasPersonServerMore
        ? Math.max(state.works.length, visibleCount)
        : visibleCount;
  const targetCount =
    state.activeView === "search"
      ? Math.max(state.searchTotal, totalCount)
      : hasPersonServerMore
        ? Math.max(state.personWorksTotal, totalCount)
        : totalCount;
  if (visibleCount < totalCount) {
    button.textContent =
      state.activeView === "search"
        ? `显示更多 ${formatNumber(visibleCount)} / ${formatNumber(loadedCount)} · 总 ${formatNumber(targetCount)}`
        : `显示更多 ${formatNumber(visibleCount)} / ${formatNumber(targetCount)}`;
  } else {
    button.textContent = `继续加载 ${formatNumber(loadedCount)} / ${formatNumber(targetCount)}`;
  }
  button.addEventListener("click", () => {
    if (visibleCount < totalCount) {
      state.workVisibleLimit += state.workPageSize;
      renderWorks();
      return;
    }
    if (hasSearchServerMore) {
      loadMoreSearchResults(button);
    } else if (hasPersonServerMore) {
      loadMorePersonWorks(button);
    }
  });

  wrap.append(button);
  els.workGrid.append(wrap);
}

function renderEmpty(message) {
  els.workGrid.innerHTML = "";
  appendEmpty(message);
}

function appendEmpty(message) {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  els.workGrid.append(empty);
}

function renderSearchPeoplePanel() {
  if (state.activeView !== "search" || !state.searchPeople.length) return;

  const panel = document.createElement("div");
  panel.className = "search-people-panel";

  const label = document.createElement("div");
  label.className = "search-people-title";
  label.textContent = "人物命中";
  panel.append(label);

  const list = document.createElement("div");
  list.className = "search-people-list";

  for (const person of state.searchPeople) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-person-chip";
    button.textContent = `${displayPersonName(person)} · ${formatNumber(person.workCount)} 部`;
    button.addEventListener("click", () => {
      goToPerson(person.id);
    });
    list.append(button);
  }

  panel.append(list);
  els.workGrid.append(panel);
}

function createWorkCard(work, index = 0) {
  const card = document.createElement("article");
  card.className = `work-card${work.missingLocal ? " missing-local" : ""}`;
  card.dataset.workId = work.id;

  const cover = document.createElement("button");
  cover.type = "button";
  cover.className = "cover-wrap work-card-main";
  cover.setAttribute("aria-label", work.missingLocal ? `打开 JavDB：${work.title}` : `打开作品：${work.title}`);
  cover.addEventListener("click", () => openWorkCard(work));

  const resolvedCoverUrl = workCoverUrl(work);
  if (resolvedCoverUrl) {
    const img = document.createElement("img");
    img.loading = index < 12 ? "eager" : "lazy";
    img.decoding = "async";
    img.fetchPriority = index < 8 ? "high" : "auto";
    img.alt = "";
    img.src = resolvedCoverUrl;
    img.addEventListener("error", () => {
      img.replaceWith(els.placeholderTemplate.content.cloneNode(true));
    });
    cover.append(img);
  } else {
    cover.append(els.placeholderTemplate.content.cloneNode(true));
  }

  const favorite = document.createElement("button");
  favorite.type = "button";
  favorite.className = `favorite-button${work.favorite ? " active" : ""}`;
  favorite.title = work.favorite ? "取消收藏" : "收藏";
  favorite.setAttribute("aria-label", work.favorite ? "取消收藏" : "收藏");
  favorite.textContent = "★";
  favorite.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFavorite(work.id);
  });

  if (work.progress?.percent) {
    const track = document.createElement("div");
    track.className = "progress-track";
    track.innerHTML = `<div class="progress-fill" style="width:${Math.min(100, Math.max(0, work.progress.percent)).toFixed(1)}%"></div>`;
    cover.append(track);
  }

  const body = document.createElement("div");
  body.className = "work-body";
  body.addEventListener("click", () => openWorkCard(work));

  const title = document.createElement("div");
  title.className = "work-title";
  title.textContent = work.title;

  const facts = document.createElement("div");
  facts.className = "work-card-facts";
  const rating = createRatingLine(work);
  const updated = document.createElement("div");
  updated.className = "work-updated";
  updated.textContent = formatDate(work.infoSummary?.releaseDate || work.modifiedAt) || (work.missingLocal ? "未下载" : "日期未知");
  facts.append(rating, updated);

  const flags = document.createElement("div");
  flags.className = "work-card-flags";
  if (work.ranking?.rankNo) flags.append(createInfoChip(`TOP ${formatNumber(work.ranking.rankNo)}`, "rank"));
  if (work.missingLocal) flags.append(createInfoChip("未下载", "missing"));
  if (work.infoCount > 0) flags.append(createInfoChip(`${formatNumber(work.infoCount)} 资料`));
  if (work.progress?.percent) flags.append(createInfoChip(`看到 ${Math.floor(work.progress.percent)}%`, "progress"));
  if (work.missingLocal && state.accessMode === "local") {
    const compilationButton = document.createElement("button");
    compilationButton.type = "button";
    compilationButton.className = "inline-rule-button";
    compilationButton.textContent = "标为合集";
    compilationButton.addEventListener("click", (event) => {
      event.stopPropagation();
      markWorkAsCompilation(work, compilationButton);
    });
    flags.append(compilationButton);
  }
  if (state.activeView === "favorites" && work.favorite) {
    flags.append(createFavoriteFolderSelect(work));
  }

  body.append(title, facts);
  if (flags.childElementCount) body.append(flags);
  if (work.missingLocal) {
    card.append(cover, body);
  } else {
    card.append(cover, favorite, body);
  }
  return card;
}

function createFavoriteFolderSelect(work) {
  const select = document.createElement("select");
  select.className = "favorite-folder-select";
  select.title = "移动到收藏夹";
  select.setAttribute("aria-label", "移动到收藏夹");
  for (const folder of state.favoriteFolders || []) {
    const option = document.createElement("option");
    option.value = folder.id;
    option.textContent = folder.name;
    select.append(option);
  }
  select.value = work.favoriteFolderId || "default";
  select.addEventListener("click", (event) => event.stopPropagation());
  select.addEventListener("change", (event) => {
    event.stopPropagation();
    moveFavoriteToFolder(work, select.value, select);
  });
  return select;
}

function openWorkCard(work) {
  if (work.missingLocal) {
    if (work.javdbUrl) {
      window.open(work.javdbUrl, "_blank", "noreferrer");
    }
    return;
  }
  openWork(work.id);
}

function workCodePrefix(work) {
  const code = String(work.infoSummary?.code || extractWorkCode(work) || "").trim();
  return normalizeCompilationPrefix(code.match(/^([A-Z0-9]+)[-_\s]?\d+/i)?.[1] || "");
}

async function markWorkAsCompilation(work, button) {
  const prefix = workCodePrefix(work);
  if (!prefix) {
    toastInline(button, "没识别到前缀", button.textContent);
    return;
  }

  const config = normalizeUiConfig(state.uiConfig);
  if (config.compilationPrefixes.includes(prefix)) {
    renderWorks();
    return;
  }

  const original = button.textContent;
  button.disabled = true;
  button.textContent = "保存中";
  try {
    await saveCompilationConfig({
      ...config,
      compilationPrefixes: [...config.compilationPrefixes, prefix]
    });
    if (els.adminConfigStatus) els.adminConfigStatus.textContent = `已添加 ${prefix}`;
  } catch (error) {
    toastInline(button, error.message || "保存失败", original);
  } finally {
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = original;
    }
  }
}

function createRatingLine(work) {
  const row = document.createElement("div");
  row.className = "work-rating-line";

  const rating = numericRating(work.infoSummary?.rating);
  const ratingForStars = rating === null ? 0 : rating > 5 ? rating / 2 : rating;
  const percent = Math.max(0, Math.min(100, (ratingForStars / 5) * 100));

  const stars = document.createElement("span");
  stars.className = "rating-stars";
  stars.setAttribute("aria-hidden", "true");
  stars.innerHTML = `<span class="rating-stars-empty">★★★★★</span><span class="rating-stars-fill" style="width:${percent.toFixed(1)}%">★★★★★</span>`;

  const text = document.createElement("span");
  text.className = "rating-text";
  const count = Number(work.infoSummary?.ratingCount || 0);
  if (rating !== null) {
    const ratingText = Number.isInteger(rating) ? rating.toFixed(1) : String(rating);
    text.textContent = count ? `${ratingText}分, 由${formatNumber(count)}人评价` : `${ratingText}分`;
    row.setAttribute("aria-label", text.textContent);
  } else {
    text.textContent = "暂无评分";
    row.classList.add("empty");
  }

  row.append(stars, text);
  return row;
}

function formatDate(value) {
  if (!value) return "";
  const match = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(String(value));
  if (!match) return "";
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function extractWorkCode(work) {
  const text = `${work.directoryName || ""} ${work.title || ""}`;
  const match = text.match(/(?:\[[^\]]+\][._\s-]*)?([a-z]{2,10})[-_\s]?(\d{2,6})/i);
  if (!match) return "";
  return `${match[1].toUpperCase()}-${match[2]}`;
}

function workSourceLabel(work) {
  const sourcePath = normalizeSourcePath(work.relativePath);
  if (sourcePath === "v:/[a]" || sourcePath.startsWith("v:/[a]/")) return { label: "VR · V:[A]", vr: true };
  if (sourcePath === "v:/[a1]" || sourcePath.startsWith("v:/[a1]/")) return { label: "VR · V:[A1]", vr: true };
  if (sourcePath === "v:/av" || sourcePath.startsWith("v:/av/")) return { label: "VR · V:AV", vr: true };
  if (sourcePath === "o:/[珍藏]" || sourcePath.startsWith("o:/[珍藏]/")) return { label: "O:珍藏", vr: false };
  if (sourcePath === "o:/[珍藏1]" || sourcePath.startsWith("o:/[珍藏1]/")) return { label: "O:珍藏1", vr: false };
  if (sourcePath.startsWith("g:/")) return { label: "G:", vr: false };
  if (sourcePath.startsWith("f:/")) return { label: "F:", vr: false };
  if (sourcePath.startsWith("o:/")) return { label: "O:", vr: false };
  return { label: "", vr: false };
}

function isVrWork(work) {
  if (workSourceLabel(work).vr) return true;
  const text = [work?.title, work?.directoryName, work?.relativePath]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return text.includes("[vr]") || /\bvr\b/.test(text);
}

function createInfoChip(text, variant = "") {
  const chip = document.createElement("span");
  chip.className = `info-chip${variant ? ` ${variant}` : ""}`;
  chip.textContent = text;
  return chip;
}

function createMetaPart(text) {
  const span = document.createElement("span");
  span.className = "meta-part";
  span.textContent = text;
  return span;
}

function createPersonLink(name, personId) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "meta-person-link";
  button.textContent = name;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    goToPerson(personId);
  });
  return button;
}

function createBadge(text, variant = "") {
  const badge = document.createElement("span");
  badge.className = `badge${variant ? ` ${variant}` : ""}`;
  badge.textContent = text;
  return badge;
}

async function openWork(workId, videoId = null, options = {}) {
  const cachedWork = state.works.find((work) => work.id === workId);
  if (cachedWork?.missingLocal) {
    openWorkCard(cachedWork);
    return;
  }

  const seq = ++state.openWorkSeq;
  reportCurrentProgress();
  stopProgressReporting();
  stopTimelineSync();
  stopPendingInfoRender();
  state.currentWork = null;
  state.currentVideo = null;
  state.currentPlayInfo = null;
  state.currentStreamOffset = 0;

  openDrawerFrame("正在加载作品", "");
  resetDrawerSideScroll();
  els.playerArea.innerHTML = `<div class="unsupported">正在读取作品</div>`;
  els.metaArea.innerHTML = "";
  els.infoArea.innerHTML = "";

  try {
    const data = await api(`/api/works/${encodeURIComponent(workId)}`);
    if (seq !== state.openWorkSeq || !els.detailDrawer.classList.contains("open")) return;

    const work = data.work;
    state.currentWork = work;
    els.drawerTitle.textContent = work.title;
    els.drawerPath.textContent = formatLibraryPath(work.relativePath);
    renderPlayer(work, videoId);
    renderMeta(work);
    scheduleInfoRender(work);
    resetDrawerSideScroll();
    syncRouteAfterNavigation({
      ...options,
      routeOverrides: { workId: work.id, videoId: videoId || state.currentVideo?.id || "" }
    });
  } catch (error) {
    if (seq !== state.openWorkSeq) return;
    els.drawerTitle.textContent = "打开失败";
    els.drawerPath.textContent = "";
    els.playerArea.innerHTML = "";
    const notice = document.createElement("div");
    notice.className = "unsupported";
    notice.textContent = error.message;
    els.playerArea.append(notice);
  }
}

function resetDrawerSideScroll() {
  if (!els.drawerSide) return;
  els.drawerSide.scrollTop = 0;
}

function openDrawerFrame(title, pathText) {
  if (!els.detailDrawer.classList.contains("open")) {
    state.lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  els.drawerTitle.textContent = title;
  els.drawerPath.textContent = pathText;
  els.drawerBackdrop.hidden = false;
  els.detailDrawer.classList.add("open");
  els.detailDrawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  window.setTimeout(() => {
    if (els.detailDrawer.classList.contains("open")) {
      els.closeDrawer.focus({ preventScroll: true });
    }
  }, 0);
}

function scheduleInfoRender(work) {
  stopPendingInfoRender();
  els.infoArea.innerHTML = `<div class="unsupported inline-info-loading">正在准备资料</div>`;

  const render = () => {
    state.infoRenderTimer = null;
    if (state.currentWork?.id !== work.id || !els.detailDrawer.classList.contains("open")) return;
    renderInfo(work);
  };

  if ("requestIdleCallback" in window) {
    state.infoRenderTimer = window.requestIdleCallback(render, { timeout: 700 });
  } else {
    state.infoRenderTimer = window.setTimeout(render, 120);
  }
}

function stopPendingInfoRender() {
  if (!state.infoRenderTimer) return;
  window.cancelIdleCallback?.(state.infoRenderTimer);
  window.clearTimeout(state.infoRenderTimer);
  state.infoRenderTimer = null;
}

function closeDrawer(options = {}) {
  state.openWorkSeq += 1;
  reportCurrentProgress();
  stopProgressReporting();
  stopTimelineSync();
  stopPendingInfoRender();
  els.detailDrawer.classList.remove("open");
  els.detailDrawer.setAttribute("aria-hidden", "true");
  els.drawerBackdrop.hidden = true;
  document.body.style.overflow = "";
  els.playerArea.innerHTML = "";
  state.currentWork = null;
  state.currentVideo = null;
  state.currentPlayInfo = null;
  state.currentStreamOffset = 0;

  const restoreTarget = state.lastFocusedElement;
  state.lastFocusedElement = null;
  if (restoreTarget?.isConnected) {
    window.setTimeout(() => restoreTarget.focus({ preventScroll: true }), 0);
  }
  syncRouteAfterNavigation({
    ...options,
    replaceRoute: options.replaceRoute !== false,
    routeOverrides: { workId: "", videoId: "" }
  });
}

function drawerFocusableElements() {
  return [
    ...els.detailDrawer.querySelectorAll(
      'a[href], button, input, select, textarea, video[controls], [tabindex]:not([tabindex="-1"])'
    )
  ].filter((element) => !element.disabled && element.getAttribute("aria-hidden") !== "true");
}

function trapDrawerFocus(event) {
  const focusable = drawerFocusableElements();
  if (!focusable.length) {
    event.preventDefault();
    els.detailDrawer.focus({ preventScroll: true });
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus({ preventScroll: true });
    return;
  }

  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus({ preventScroll: true });
  }
}

function createPlayerActions(work) {
  const actions = document.createElement("div");
  actions.className = "player-actions";

  const favoriteButton = document.createElement("button");
  favoriteButton.type = "button";
  favoriteButton.className = `text-button${work.favorite ? " active" : ""}`;
  favoriteButton.textContent = work.favorite ? "★ 已收藏" : "☆ 收藏";
  favoriteButton.setAttribute("aria-label", work.favorite ? "取消收藏" : "收藏");
  favoriteButton.addEventListener("click", () => toggleFavorite(work.id));
  actions.append(favoriteButton);

  if (!workCoverUrl(work) && work.canGenerateCover) {
    const coverButton = document.createElement("button");
    coverButton.type = "button";
    coverButton.className = "text-button";
    coverButton.textContent = "生成封面";
    coverButton.setAttribute("aria-label", "生成封面");
    coverButton.addEventListener("click", () => generateWorkCover(work.id, coverButton));
    actions.append(coverButton);
  }

  return actions;
}

async function renderPlayer(work, requestedVideoId = null, startAt = null, autoplay = false) {
  stopProgressReporting();
  stopTimelineSync();
  els.playerArea.innerHTML = "";

  els.playerArea.append(createPlayerActions(work));

  const streamableVideos = work.videos.filter(canTryWebPlay);
  if (!streamableVideos.length) {
    const unsupported = document.createElement("div");
    unsupported.className = "unsupported";
    unsupported.innerHTML = "<strong>这个作品的文件格式暂不支持网页播放。</strong><span>可以用本地播放器打开原文件。</span>";
    els.playerArea.append(unsupported);
    return;
  }

  const progressVideoId = work.progress?.videoId;
  const selected =
    streamableVideos.find((video) => video.id === requestedVideoId) ||
    streamableVideos.find((video) => video.id === progressVideoId) ||
    streamableVideos.find((video) => video.playable) ||
    streamableVideos[0];
  state.currentVideo = selected;
  state.currentPlayInfo = null;
  state.currentStreamOffset = 0;

  const loading = document.createElement("div");
  loading.className = "unsupported";
  loading.textContent = "正在探测播放方式";
  els.playerArea.append(loading);

  let playInfo;
  try {
    playInfo = await api(`/api/playinfo/${encodeURIComponent(selected.id)}`);
  } catch (error) {
    loading.textContent = error.message;
    return;
  }

  if (state.currentVideo?.id !== selected.id || state.currentWork?.id !== work.id) return;

  state.currentPlayInfo = playInfo;
  loading.remove();

  const video = document.createElement("video");
  video.className = "video-player";
  const isSegmentedStream = playInfo.mode !== "direct";
  video.controls = !isSegmentedStream;
  video.preload = state.accessHints.videoPreload || "metadata";

  const savedProgress = selected.progress || (work.progress?.videoId === selected.id ? work.progress : null);
  const requestedStart = Number(startAt);
  const resumePosition = Number.isFinite(requestedStart) ? requestedStart : savedProgress?.position > 5 ? savedProgress.position : 0;
  let streamUrl = playInfo.streamUrl;
  if (isSegmentedStream && resumePosition > 0) {
    state.currentStreamOffset = resumePosition;
    streamUrl = addQueryParam(streamUrl, "t", Math.floor(resumePosition));
  }
  video.src = streamUrl;

  if (!isSegmentedStream && resumePosition > 5) {
    video.addEventListener(
      "loadedmetadata",
      () => {
        if (resumePosition < video.duration - 8) {
          video.currentTime = resumePosition;
        }
      },
      { once: true }
    );
  }

  if (autoplay) {
    video.addEventListener("canplay", () => video.play().catch(() => {}), { once: true });
  }

  video.addEventListener("pause", reportCurrentProgress);
  video.addEventListener("ended", reportCurrentProgress);
  els.playerArea.append(video);
  if (isSegmentedStream) {
    els.playerArea.append(createTranscodeControls(video, playInfo, work, selected.id));
  }
  startProgressReporting();
}

function currentPlaybackPosition(video = activeVideoElement()) {
  const offset = Number(state.currentStreamOffset || 0);
  const current = Number(video?.currentTime || 0);
  return Math.max(0, offset + current);
}

function timelineDuration(video = activeVideoElement()) {
  const candidates = [
    state.currentPlayInfo?.duration,
    state.currentVideo?.progress?.duration,
    state.currentWork?.progress?.duration
  ];
  for (const value of candidates) {
    const duration = Number(value);
    if (Number.isFinite(duration) && duration > 0) return duration;
  }

  const elementDuration = Number(video?.duration || 0);
  return Number.isFinite(elementDuration) && elementDuration > 0 ? elementDuration + state.currentStreamOffset : 0;
}

function createTranscodeControls(video, playInfo, work, videoId) {
  const controls = document.createElement("div");
  controls.className = "transcode-controls";
  const abortController = new AbortController();
  state.timelineAbortController = abortController;
  const listenerOptions = { signal: abortController.signal };

  const playButton = document.createElement("button");
  playButton.type = "button";
  playButton.className = "transcode-button";

  const timeLabel = document.createElement("span");
  timeLabel.className = "transcode-time";

  const seek = document.createElement("input");
  seek.className = "transcode-seek";
  seek.type = "range";
  seek.min = "0";
  seek.step = "1";
  seek.setAttribute("aria-label", "播放进度");

  const modeLabel = document.createElement("span");
  modeLabel.className = "transcode-mode";
  const codecText = [playInfo.videoCodec, playInfo.audioCodec].filter(Boolean).join(" / ");
  modeLabel.textContent = `${playInfo.label}${codecText ? ` · ${codecText}` : ""}`;

  const muteButton = document.createElement("button");
  muteButton.type = "button";
  muteButton.className = "transcode-button";

  const fullButton = document.createElement("button");
  fullButton.type = "button";
  fullButton.className = "transcode-button";
  fullButton.textContent = "全屏";
  fullButton.setAttribute("aria-label", "进入全屏");

  let seeking = false;

  const update = (previewValue = null) => {
    const duration = timelineDuration(video);
    const current = previewValue ?? currentPlaybackPosition(video);
    playButton.textContent = video.paused ? "播放" : "暂停";
    playButton.setAttribute("aria-label", video.paused ? "播放" : "暂停");
    muteButton.textContent = video.muted ? "开声" : "静音";
    muteButton.setAttribute("aria-label", video.muted ? "打开声音" : "静音");
    timeLabel.textContent = duration > 0 ? `${formatTime(current)} / ${formatTime(duration)}` : formatTime(current);

    if (duration > 0) {
      seek.disabled = false;
      seek.max = String(Math.floor(duration));
      if (!seeking) seek.value = String(Math.min(Math.floor(current), Math.floor(duration)));
    } else {
      seek.disabled = true;
      seek.max = "1";
      seek.value = "0";
    }
  };

  playButton.addEventListener("click", () => {
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
    update();
  }, listenerOptions);

  video.addEventListener("click", () => {
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
    update();
  }, listenerOptions);

  seek.addEventListener("input", () => {
    seeking = true;
    update(Number(seek.value || 0));
  }, listenerOptions);

  seek.addEventListener("change", () => {
    const nextPosition = Number(seek.value || 0);
    const shouldKeepPlaying = !video.paused;
    seeking = false;
    reportCurrentProgress({ force: true });
    renderPlayer(work, videoId, nextPosition, shouldKeepPlaying);
  }, listenerOptions);

  seek.addEventListener("pointerup", () => {
    seeking = false;
  }, listenerOptions);

  muteButton.addEventListener("click", () => {
    video.muted = !video.muted;
    update();
  }, listenerOptions);

  fullButton.addEventListener("click", () => {
    const target = els.playerArea;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      target.requestFullscreen?.();
    }
  }, listenerOptions);

  video.addEventListener("timeupdate", () => update(), listenerOptions);
  video.addEventListener("play", () => update(), listenerOptions);
  video.addEventListener("pause", () => update(), listenerOptions);
  video.addEventListener("loadedmetadata", () => update(), listenerOptions);
  document.addEventListener("fullscreenchange", () => {
    fullButton.textContent = document.fullscreenElement ? "退出" : "全屏";
    fullButton.setAttribute("aria-label", document.fullscreenElement ? "退出全屏" : "进入全屏");
  }, listenerOptions);

  state.timelineTimer = window.setInterval(() => update(), 500);
  update();

  controls.append(playButton, timeLabel, seek, modeLabel, muteButton, fullButton);
  return controls;
}

function canTryWebPlay(video) {
  return video.playable || [".mkv", ".wmv", ".avi", ".flv", ".ts"].includes(video.ext);
}

function renderMeta(work) {
  els.metaArea.innerHTML = "";

  if (work.personId && (work.personName || work.personDisplayName)) {
    const personJump = document.createElement("div");
    personJump.className = "person-jump";

    const text = document.createElement("div");
    text.innerHTML = `<span>人物</span><strong></strong>`;
    text.querySelector("strong").textContent = workPersonDisplayName(work);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = "查看人物";
    button.addEventListener("click", () => {
      goToPerson(work.personId);
    });

    personJump.append(text, button);
    els.metaArea.append(personJump);
  }

  const heading = document.createElement("h4");
  heading.className = "section-title";
  heading.textContent = "视频文件";

  const list = document.createElement("div");
  list.className = "file-list video-picker";

  for (const video of work.videos) {
    const item = document.createElement("div");
    item.className = `file-item${state.currentVideo?.id === video.id ? " active" : ""}`;

    const main = document.createElement("div");
    main.innerHTML = `<div class="file-name"></div><div class="file-sub"></div>`;
    main.querySelector(".file-name").textContent = video.name;
    const progress = video.progress ? ` · 看到 ${Math.floor(video.progress.percent)}%` : "";
    main.querySelector(".file-sub").textContent = `${formatLibraryPath(video.relativePath)} · ${formatBytes(video.size)}${progress}`;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = video.playable ? "播放" : canTryWebPlay(video) ? "智能播放" : "暂不支持";
    button.disabled = !canTryWebPlay(video);
    if (canTryWebPlay(video)) {
      button.addEventListener("click", () => {
        reportCurrentProgress();
        renderPlayer(work, video.id);
        renderMeta(work);
      });
    }

    item.append(main, button);
    list.append(item);
  }

  els.metaArea.append(heading, list);
}

function renderInfo(work) {
  els.infoArea.innerHTML = "";
  const preview = createPreviewMediaSection(work);
  if (preview) els.infoArea.append(preview);

  if (hasStructuredInfo(work.infoMetadata)) {
    const heading = document.createElement("h4");
    heading.className = "section-title";
    heading.textContent = "作品资料";
    els.infoArea.append(heading);

    const wrapper = document.createElement("div");
    wrapper.className = "info-block inline-info-block";
    els.infoArea.append(wrapper);
    renderStructuredInfo(wrapper, work.infoMetadata);
    return;
  }

  if (!work.infos.length) {
    const empty = document.createElement("div");
    empty.className = "unsupported";
    empty.textContent = "这个作品没有资料。";
    els.infoArea.append(empty);
    return;
  }

  const heading = document.createElement("h4");
  heading.className = "section-title";
  heading.textContent = "作品资料";
  els.infoArea.append(heading);

  const wrapper = document.createElement("div");
  wrapper.className = "info-block inline-info-block";
  els.infoArea.append(wrapper);
  loadInlineInfoContent(wrapper, primaryInfoFile(work).id);
}

function createPreviewMediaSection(work) {
  const info = work.infoMetadata || work.infoSummary || {};
  const images = uniquePreviewImageUrls([...(info.previewImages || []), ...localPreviewImageUrls(work)]).slice(0, 12);
  const videoUrl = cleanRemoteUrl(info.previewVideoUrl);
  if (!images.length && !videoUrl) return null;

  const section = document.createElement("section");
  section.className = "preview-media-section";

  const heading = document.createElement("h4");
  heading.className = "section-title";
  heading.textContent = "预览媒体";
  section.append(heading);

  if (images.length) {
    const grid = document.createElement("div");
    grid.className = "preview-media-grid";
    for (const imageUrl of images) {
      const link = document.createElement("a");
      link.className = "preview-media-thumb";
      link.href = imageUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      const img = document.createElement("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      img.src = imageUrl;
      link.append(img);
      grid.append(link);
    }
    section.append(grid);
  }

  if (videoUrl) {
    const actions = document.createElement("div");
    actions.className = "preview-media-actions";
    const link = document.createElement("a");
    link.className = "text-button preview-media-link";
    link.href = videoUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "打开预览视频";
    actions.append(link);
    section.append(actions);
  }

  return section;
}

function localPreviewImageUrls(work) {
  return [...(work.images || [])]
    .filter((image) => image?.id && image.id !== work.coverId)
    .sort(comparePreviewImageFiles)
    .map((image) => `/media/image/${encodeURIComponent(image.id)}`);
}

function comparePreviewImageFiles(a, b) {
  return previewImageRank(a) - previewImageRank(b) || String(a.relativePath || a.name || "").localeCompare(String(b.relativePath || b.name || ""));
}

function previewImageRank(image) {
  const text = `${image?.relativePath || ""} ${image?.name || ""}`.toLowerCase();
  if (/(?:extra[-_ ]?fanart|sample|screenshot|preview|fanart)/.test(text)) return 0;
  if (/(?:poster|cover|folder|front|thumb|thumbnail)/.test(text)) return 2;
  return 1;
}

function cleanRemoteUrl(value) {
  const text = String(value || "").trim();
  if (!/^https?:\/\//i.test(text)) return "";
  return text;
}

function cleanPreviewImageUrl(value) {
  const text = String(value || "").trim();
  if (/^https?:\/\//i.test(text) || /^\/media\/image\//i.test(text)) return text;
  return "";
}

function uniquePreviewImageUrls(values) {
  const seen = new Set();
  const urls = [];
  for (const value of Array.isArray(values) ? values : []) {
    const url = cleanPreviewImageUrl(value);
    const key = url.toLowerCase();
    if (!url || seen.has(key)) continue;
    seen.add(key);
    urls.push(url);
  }
  return urls;
}

function primaryInfoFile(work) {
  const infos = work.infos || [];
  return infos.find((info) => /^info\.(txt|json|nfo)$/i.test(info.name || "")) || infos[0];
}

async function loadInlineInfoContent(wrapper, infoId) {
  wrapper.innerHTML = `<div class="unsupported inline-info-loading">正在读取资料</div>`;
  try {
    const data = await api(`/api/info/${encodeURIComponent(infoId)}`);
    if (data.displayable === false) {
      const notice = document.createElement("div");
      notice.className = "unsupported";
      notice.textContent = "这个作品没有可显示的作品资料。";
      wrapper.replaceChildren(notice);
      return;
    }

    if (hasStructuredInfo(data.metadata)) {
      renderStructuredInfo(wrapper, data.metadata);
      return;
    }

    const pre = document.createElement("pre");
    pre.className = "info-content inline-info-content";
    pre.textContent = data.content || "这个作品没有可显示内容。";
    wrapper.replaceChildren(pre);
  } catch (error) {
    const notice = document.createElement("div");
    notice.className = "unsupported info-error";
    notice.textContent = error.message;
    wrapper.replaceChildren(notice);
  }
}

function hasStructuredInfo(metadata) {
  return Boolean(metadata && ((metadata.fields || []).length || metadata.rawText));
}

function renderStructuredInfo(mount, metadata) {
  mount.innerHTML = "";
  const panel = document.createElement("div");
  panel.className = "structured-info-panel";

  const fields = metadata.fields || [];
  if (fields.length) {
    const grid = document.createElement("dl");
    grid.className = "structured-info-grid";
    for (const field of fields) {
      const label = document.createElement("dt");
      label.textContent = field.label;
      const value = document.createElement("dd");
      value.textContent = field.value;
      grid.append(label, value);
    }
    panel.append(grid);
  } else {
    const pre = document.createElement("pre");
    pre.className = "info-content inline-info-content";
    pre.textContent = metadata.rawText || "这个作品没有可显示内容。";
    panel.append(pre);
  }

  if (metadata.rawTextTruncated) {
    const note = document.createElement("div");
    note.className = "info-preview-note";
    note.textContent = "资料较长，已显示主要字段。";
    panel.append(note);
  }

  mount.append(panel);
}

async function loadInfoContent(wrapper, infoId, button) {
  const existing = wrapper.querySelector(".info-content");
  if (existing) return;

  button.textContent = "读取中";
  try {
    const data = await api(`/api/info/${encodeURIComponent(infoId)}`);
    const pre = document.createElement("pre");
    pre.className = "info-content";
    pre.textContent = data.content || "";
    wrapper.append(pre);
    button.textContent = "收起";
  } catch (error) {
    button.textContent = "展开";
    const notice = document.createElement("div");
    notice.className = "unsupported info-error";
    notice.textContent = error.message;
    wrapper.append(notice);
  }
}

function toggleInfoContent(wrapper, infoId, button) {
  const existing = wrapper.querySelector(".info-content, .info-error");
  if (existing) {
    existing.remove();
    button.textContent = "展开";
    return;
  }

  loadInfoContent(wrapper, infoId, button);
}

async function generateWorkCover(workId, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "生成中";
  try {
    const data = await api(`/api/works/${encodeURIComponent(workId)}/cover/generate`, { method: "POST" });
    if (data.work) {
      updateWorkSnapshot(data.work);
      state.currentWork = data.work;
      renderPlayer(state.currentWork, state.currentVideo?.id);
      renderMeta(state.currentWork);
      renderWorks();
    }
  } catch (error) {
    alert(error.message);
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function toggleFavorite(workId) {
  const data = await api(`/api/favorites/${encodeURIComponent(workId)}`, { method: "POST" });
  state.favoriteFolders = data.folders || state.favoriteFolders;
  updateWorkFavorite(workId, data.favorite, data.favoriteFolder);
  state.library.user = data.user;
  renderSummary();

  if (state.currentWork?.id === workId) {
    state.currentWork.favorite = data.favorite;
    if (data.favoriteFolder) {
      state.currentWork.favoriteFolderId = data.favoriteFolder.folderId;
      state.currentWork.favoriteFolderName = data.favoriteFolder.folderName;
    } else {
      state.currentWork.favoriteFolderId = "";
      state.currentWork.favoriteFolderName = "";
    }
    renderPlayer(state.currentWork, state.currentVideo?.id);
  }

  if (state.activeView === "favorites" && !data.favorite) {
    state.works = state.works.filter((work) => work.id !== workId);
  }

  if (state.activeView === "favorites") {
    renderStatsForWorks(state.works);
    renderFavoriteFolderControls();
  }
  renderWorks(state.activeView === "favorites" ? "还没有收藏。" : "没有匹配的作品。");
}

async function moveFavoriteToFolder(work, folderId, control) {
  const previous = work.favoriteFolderId || "default";
  control.disabled = true;
  try {
    const data = await api(`/api/favorites/${encodeURIComponent(work.id)}/folder`, { method: "PUT", body: { folderId } });
    state.favoriteFolders = data.folders || state.favoriteFolders;
    updateWorkFavoriteFolder(work.id, data.favorite);
    state.library.user = data.user;
    renderSummary();

    if (state.currentWork?.id === work.id) {
      state.currentWork.favoriteFolderId = data.favorite.folderId;
      state.currentWork.favoriteFolderName = data.favorite.folderName;
    }

    if (state.activeView === "favorites" && state.selectedFavoriteFolderId !== "all" && data.favorite.folderId !== state.selectedFavoriteFolderId) {
      state.works = state.works.filter((item) => item.id !== work.id);
    }
    renderStatsForWorks(state.works);
    renderFavoriteFolderControls();
    renderWorks("还没有收藏。");
  } catch (error) {
    control.value = previous;
    alert(error.message);
  } finally {
    control.disabled = false;
  }
}

function updateWorkFavorite(workId, favorite, favoriteFolder = null) {
  for (const work of state.works) {
    if (work.id !== workId) continue;
    work.favorite = favorite;
    if (favorite && favoriteFolder) {
      work.favoriteFolderId = favoriteFolder.folderId;
      work.favoriteFolderName = favoriteFolder.folderName;
    }
    if (!favorite) {
      work.favoriteFolderId = "";
      work.favoriteFolderName = "";
    }
  }
}

function updateWorkFavoriteFolder(workId, favoriteFolder) {
  for (const work of state.works) {
    if (work.id !== workId) continue;
    work.favoriteFolderId = favoriteFolder.folderId;
    work.favoriteFolderName = favoriteFolder.folderName;
  }
}

function updateWorkSnapshot(nextWork) {
  const index = state.works.findIndex((work) => work.id === nextWork.id);
  if (index >= 0) state.works[index] = { ...state.works[index], ...nextWork };
}

function startProgressReporting() {
  stopProgressReporting();
  state.progressTimer = window.setInterval(reportCurrentProgress, 5000);
}

function stopProgressReporting() {
  if (state.progressTimer) {
    window.clearInterval(state.progressTimer);
    state.progressTimer = null;
  }
}

function stopTimelineSync() {
  if (state.timelineTimer) {
    window.clearInterval(state.timelineTimer);
    state.timelineTimer = null;
  }
  if (state.timelineAbortController) {
    state.timelineAbortController.abort();
    state.timelineAbortController = null;
  }
}

function activeVideoElement() {
  return els.playerArea.querySelector("video");
}

function reportCurrentProgress(options = {}) {
  const video = activeVideoElement();
  const duration = timelineDuration(video);
  if (!state.currentVideo || !state.currentWork || !video || !Number.isFinite(duration) || duration <= 0) {
    return;
  }

  const now = Date.now();
  if (!options.force && now - state.lastProgressReport < 1400) return;
  state.lastProgressReport = now;

  api(`/api/progress/${encodeURIComponent(state.currentVideo.id)}`, {
    method: "POST",
    body: {
      workId: state.currentWork.id,
      position: currentPlaybackPosition(video),
      duration
    }
  })
    .then((data) => {
      state.currentVideo.progress = data.progress;
      state.currentWork.progress = data.progress;
      state.library.user = data.user;
      renderSummary();
    })
    .catch(() => {});
}

els.personSearch.addEventListener("input", (event) => {
  state.personQuery = event.target.value;
  window.clearTimeout(state.personSearchTimer);
  state.personSearchTimer = window.setTimeout(() => {
    resetPersonPaging();
    renderPeople();
    if (state.activeView === "people" && !state.selectedPersonId) {
      renderPeopleIndexStats();
      renderPeopleIndex();
    }
  }, 140);
});

els.workSearch.addEventListener("input", (event) => {
  state.workQuery = event.target.value;
  window.clearTimeout(state.searchTimer);
  state.searchTimer = window.setTimeout(() => {
    loadSearchResults(state.workQuery);
  }, 180);
});

els.sortSelect.addEventListener("change", (event) => {
  state.sortMode = event.target.value;
  resetWorkPaging();
  if (state.activeView === "search" && state.searchQuery) {
    loadSearchResults(state.searchQuery);
    return;
  }
  if (state.activeView === "people" && state.selectedPersonId) {
    selectPerson(state.selectedPersonId, { resetFilter: false });
    return;
  }
  if (state.activeView === "rankings") {
    renderRankingStats();
  }
  renderWorks();
});

els.filterSelect.addEventListener("change", (event) => {
  state.filterMode = event.target.value;
  resetWorkPaging();
  if (state.activeView === "search" && state.searchQuery) {
    loadSearchResults(state.searchQuery);
    return;
  }
  if (state.activeView === "people" && state.selectedPersonId) {
    selectPerson(state.selectedPersonId, { resetFilter: false });
    return;
  }
  if (state.activeView === "rankings") {
    renderRankingStats();
  }
  renderWorks();
});

els.missingLocalToggle?.addEventListener("change", (event) => {
  state.showMissingLocalWorks = Boolean(event.target.checked);
  writeStoredFlag("fanhao.showMissingLocalWorks", state.showMissingLocalWorks);
  resetWorkPaging();
  renderWorks();
});

els.collectionToggle?.addEventListener("change", (event) => {
  state.showCompilationWorks = Boolean(event.target.checked);
  writeStoredFlag("fanhao.showCompilationWorks", state.showCompilationWorks);
  resetWorkPaging();
  if (state.activeView === "people" && !state.selectedPersonId) {
    renderPeopleIndexStats();
    renderPeopleIndex();
    return;
  }
  renderWorks();
});

els.backToPeopleIndex?.addEventListener("click", returnToPeopleIndex);

for (const button of els.viewTabs) {
  button.addEventListener("click", () => {
    clearWorkSearch();
    setActiveView(button.dataset.view);
  });
}

els.rescanButton.addEventListener("click", async () => {
  const confirmed = window.confirm("全库重新扫描会遍历所有盘和文件，可能很慢。确定现在开始吗？");
  if (!confirmed) return;

  els.rescanButton.disabled = true;
  els.librarySummary.textContent = "正在重新扫描";
  try {
    const data = await api("/api/rescan", { method: "POST" });
    state.library = { ...(state.library || {}), ...data };
    await loadLibrary();
  } catch (error) {
    alert(error.message);
  } finally {
    els.rescanButton.disabled = false;
  }
});

els.adminButton?.addEventListener("click", openAdminModal);
els.closeAdmin?.addEventListener("click", closeAdminModal);
els.adminBackdrop?.addEventListener("click", closeAdminModal);
els.adminRescanPerson?.addEventListener("click", adminRescanSelectedPerson);
els.adminRefreshActor?.addEventListener("click", adminRefreshActorMovies);
els.adminRefreshRankings?.addEventListener("click", adminRefreshRankings);
els.adminPreviewActorAvatars?.addEventListener("click", adminPreviewActorAvatarCandidates);
els.adminImportActorAvatars?.addEventListener("click", adminImportActorAvatars);
els.adminGenerateCovers?.addEventListener("click", adminGenerateMissingCovers);
els.adminSaveCompilationConfig?.addEventListener("click", adminSaveCompilationConfig);
els.compilationConfigButton?.addEventListener("click", openCompilationConfig);

els.closeDrawer.addEventListener("click", closeDrawer);
els.drawerBackdrop.addEventListener("click", closeDrawer);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && els.adminModal?.classList.contains("open")) {
    closeAdminModal();
    return;
  }

  const drawerOpen = els.detailDrawer.classList.contains("open");
  if (event.key === "Escape" && drawerOpen) {
    closeDrawer();
    return;
  }
  if (event.key === "Tab" && drawerOpen) {
    trapDrawerFocus(event);
  }
});

window.addEventListener("popstate", () => {
  if (!state.routeReady) return;
  applyRoute(routeFromUrl()).catch((error) => {
    console.error(error);
  });
});

window.addEventListener("beforeunload", reportCurrentProgress);
installAndroidClientReturn();

async function applyInitialUrlState() {
  await applyRoute(routeFromUrl());
}

loadLibrary()
  .then(async () => {
    await applyInitialUrlState();
    initializeRouteHistory();
  })
  .catch((error) => {
    els.librarySummary.textContent = "索引读取失败";
    renderEmpty(error.message);
  });
