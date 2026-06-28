import { CLIENT_VERSION, DEFAULT_URL, LAST_VIEW_STORAGE_KEY, SEARCH_HISTORY_STORAGE_KEY, STORAGE_KEY, THEME_STORAGE_KEY } from "./js/config.js?v=20260629-tools-native-01";
import { fetchJson } from "./js/api.js";
import { cacheAgeText, clearCachedData, getCacheStats, readCachedJson, writeCachedJson } from "./js/cache.js";
import { createChannelViews } from "./js/channel-views.js?v=20260629-tools-native-01";
import { createDetailViews } from "./js/detail-views.js";
import { getElements } from "./js/dom.js?v=20260629-tools-native-01";
import { formatBytes, formatCompact, formatNumber, normalizeUrl } from "./js/format.js";
import { createMediaViewer } from "./js/media-viewer.js";
import { createPeopleViews } from "./js/people-views.js";
import { createSearchHistory } from "./js/search-history.js";
import { createToolViews } from "./js/tool-views.js?v=20260629-tools-native-01";
import { createWorkViews } from "./js/work-views.js";

const els = getElements();
let activeUrl = normalizeUrl(localStorage.getItem(STORAGE_KEY) || DEFAULT_URL);
const RESTORABLE_VIEWS = new Set(["home", "people", "works", "rankings", "favorites", "history", "search", "personDetail", "workDetail", "channel", "photoDetail", "mangaDetail", "mangaChapter", "mediaDetail", "tools"]);
const initialViewState = readInitialViewState();
let library = null;
let currentView = initialViewState.view;
let currentViewParams = initialViewState.params;
let peopleLimit = 80;
let worksLimit = defaultWorksLimitForView(initialViewState.view);
let channelLimit = defaultChannelLimitForView(initialViewState.view);
let photoImageLimit = defaultPhotoImageLimitForView(initialViewState.view);
let mangaImageLimit = defaultMangaImageLimitForView(initialViewState.view);
let viewStack = [];
let detailViews = null;
let peopleViews = null;
let workViews = null;
let channelViews = null;
let toolViews = null;
let mediaViewer = null;
let searchHistory = null;
let viewRenderToken = 0;
let activeViewController = null;
let pendingScrollRestore = null;
const HISTORY_MARKER = "fanhao-android";
const LIBRARY_CACHE_PATH = "/api/library";
const IMAGE_LIBRARY_SUMMARY_CACHE_PATH = "/api/image-library/summary";
let themePreference = localStorage.getItem(THEME_STORAGE_KEY) || "system";
let imageLibrarySummary = null;

function readInitialViewState() {
  return readViewStateFromHash() || readLastViewState();
}

function readLastViewState() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_VIEW_STORAGE_KEY) || "null");
    if (!raw || !shouldRememberView(raw.view, raw.params || {})) return { view: "home", params: {} };
    return { view: raw.view, params: sanitizeViewParams(raw.view, raw.params || {}) };
  } catch {
    return { view: "home", params: {} };
  }
}

function rememberViewState(view = currentView, params = currentViewParams) {
  const cleanParams = sanitizeViewParams(view, params || {});
  if (!shouldRememberView(view, cleanParams)) return;
  localStorage.setItem(LAST_VIEW_STORAGE_KEY, JSON.stringify({
    view,
    params: cleanParams,
    updatedAt: new Date().toISOString()
  }));
}

function shouldRememberView(view, params = {}) {
  if (!RESTORABLE_VIEWS.has(view)) return false;
  if (view === "search") return Boolean(String(params.query || "").trim());
  if (view === "personDetail") return Boolean(params.personId);
  if (view === "workDetail") return Boolean(params.workId);
  if (view === "channel") return Boolean(params.mode);
  if (view === "photoDetail") return Boolean(params.id);
  if (view === "mangaDetail") return Boolean(params.id);
  if (view === "mangaChapter") return Boolean(params.id && params.chapterIndex);
  if (view === "mediaDetail") return Boolean(params.id);
  return true;
}

function sanitizeViewParams(view, params = {}) {
  if (view === "search") return { query: String(params.query || "").trim() };
  if (view === "personDetail") return { personId: String(params.personId || "") };
  if (view === "workDetail") return { workId: String(params.workId || "") };
  if (view === "photoDetail") return { id: String(params.id || "") };
  if (view === "mangaDetail") return { id: String(params.id || "") };
  if (view === "mangaChapter") return { id: String(params.id || ""), chapterIndex: String(params.chapterIndex || params.chapter || "") };
  if (view === "mediaDetail") return { id: String(params.id || "") };
  if (view === "channel") {
    const query = String(params.q || params.query || "").trim();
    return {
      mode: normalizeChannelMode(params.mode),
      ...(query ? { query } : {})
    };
  }
  return {};
}

function normalizeChannelMode(value) {
  const mode = String(value || "").trim();
  if (mode === "movies") return "movie";
  return ["photo", "manga", "western", "movie", "tv"].includes(mode) ? mode : "";
}

function readViewStateFromHash(hash = window.location.hash) {
  const raw = String(hash || "").replace(/^#/, "");
  if (!raw) return null;

  const [rawView, rawQuery = ""] = raw.split("?");
  const view = decodeURIComponent(rawView || "");
  if (view !== "settings" && !RESTORABLE_VIEWS.has(view)) return null;

  const params = Object.fromEntries(new URLSearchParams(rawQuery));
  const cleanParams = sanitizeViewParams(view, params);
  if (view !== "settings" && !shouldRememberView(view, cleanParams)) return null;
  return { view, params: cleanParams };
}

function viewRouteHash(view, params = {}) {
  const cleanParams = sanitizeViewParams(view, params || {});
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(cleanParams)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  }
  const suffix = query.toString();
  return `#${encodeURIComponent(view)}${suffix ? `?${suffix}` : ""}`;
}

function setStatus(message, type = "normal") {
  els.statusText.textContent = message;
  els.statusText.classList.toggle("error", type === "error");
}

function setConnection(label, online) {
  els.connectionBadge.textContent = label;
  els.connectionBadge.classList.toggle("offline", !online);
}

function connectionModeLabel(url = activeUrl, access = null) {
  const parsed = parseServerUrl(url);
  if (!parsed) return access?.mode === "lan" ? "局域网" : "远程";
  if (isLocalHost(parsed.hostname)) return "本机";
  if (isPrivateHost(parsed.hostname)) return "局域网";
  return "远程";
}

function parseServerUrl(value) {
  try {
    return new URL(normalizeUrl(value));
  } catch {
    return null;
  }
}

function isLocalHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return true;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;

  const first = Number(ipv4[1]);
  const second = Number(ipv4[2]);
  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;
  return false;
}

function invalidateViewRender() {
  viewRenderToken += 1;
  activeViewController?.abort();
  activeViewController = null;
}

function beginViewRender(view, params = {}) {
  viewRenderToken += 1;
  activeViewController?.abort();
  const controller = new AbortController();
  activeViewController = controller;
  const token = viewRenderToken;
  const expectedView = view;
  const expectedParams = { ...(params || {}) };
  const guard = () =>
    !controller.signal.aborted &&
    token === viewRenderToken &&
    currentView === expectedView &&
    sameViewParams(currentViewParams, expectedParams);
  guard.signal = controller.signal;
  return guard;
}

function sameViewParams(a = {}, b = {}) {
  const aKeys = Object.keys(a || {}).sort();
  const bKeys = Object.keys(b || {}).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, index) => key === bKeys[index] && String(a[key] ?? "") === String(b[key] ?? ""));
}

function currentScrollY() {
  return Math.max(0, Math.round(window.scrollY || document.documentElement.scrollTop || 0));
}

function queueScrollRestore(value = 0) {
  const target = Math.max(0, Math.round(Number(value) || 0));
  pendingScrollRestore = {
    target,
    token: viewRenderToken,
    attempts: 0
  };
  requestAnimationFrame(restorePendingScroll);
}

function restorePendingScroll() {
  const pending = pendingScrollRestore;
  if (!pending || pending.token !== viewRenderToken) return;

  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  window.scrollTo({ top: Math.min(pending.target, maxScroll), behavior: "auto" });
  pending.attempts += 1;

  const closeEnough = Math.abs(currentScrollY() - Math.min(pending.target, maxScroll)) < 3;
  const settled = closeEnough && (pending.target === 0 || maxScroll >= pending.target);
  if (settled || pending.attempts >= 24) {
    pendingScrollRestore = null;
    return;
  }

  window.setTimeout(restorePendingScroll, pending.attempts < 4 ? 80 : 220);
}

async function updateCacheStatus() {
  if (!els.cacheStatus) return;
  try {
    const stats = await getCacheStats(activeUrl);
    if (!stats.count) {
      els.cacheStatus.textContent = "当前服务暂无缓存";
      renderCacheMetrics(stats);
      return;
    }
    const size = formatBytes(stats.bytes) || "0 B";
    const parts = [];
    if (stats.responseCount) parts.push(`数据 ${formatNumber(stats.responseCount)} 项`);
    if (stats.imageCount) parts.push(`图片 ${formatNumber(stats.imageCount)} 张`);
    els.cacheStatus.textContent = `${parts.join(" · ")} · ${size} · ${cacheAgeText(stats.latestUpdatedAt)}`;
    renderCacheMetrics(stats);
  } catch (error) {
    els.cacheStatus.textContent = `缓存不可用：${error.message}`;
    renderCacheMetrics(null);
  }
}

function renderCacheMetrics(stats) {
  const empty = !stats || !stats.count;
  if (els.cacheBytes) els.cacheBytes.textContent = empty ? "0 B" : formatBytes(stats.bytes);
  if (els.cacheResponseCount) els.cacheResponseCount.textContent = empty ? "0" : formatNumber(stats.responseCount);
  if (els.cacheImageCount) els.cacheImageCount.textContent = empty ? "0" : formatNumber(stats.imageCount);
  if (els.cacheUpdated) els.cacheUpdated.textContent = empty ? "-" : cacheAgeText(stats.latestUpdatedAt);
}

function setCacheActionsDisabled(disabled) {
  if (els.refreshCacheButton) els.refreshCacheButton.disabled = disabled;
  if (els.clearCacheButton) els.clearCacheButton.disabled = disabled;
}

async function loadImageLibrarySummary() {
  if (!els.omniGrid) return false;
  const requestUrl = activeUrl;
  if (!imageLibrarySummary) renderOmniSummary(null, { loading: true });

  const cached = await readCachedJson(requestUrl, IMAGE_LIBRARY_SUMMARY_CACHE_PATH).catch(() => null);
  if (requestUrl !== activeUrl) return false;
  if (cached?.payload) {
    imageLibrarySummary = cached.payload;
    renderOmniSummary(imageLibrarySummary, { cachedAt: cached.updatedAt });
  }

  try {
    const summary = await fetchJson(requestUrl, IMAGE_LIBRARY_SUMMARY_CACHE_PATH, { timeoutMs: 12000 });
    if (requestUrl !== activeUrl) return false;
    imageLibrarySummary = summary;
    writeCachedJson(requestUrl, IMAGE_LIBRARY_SUMMARY_CACHE_PATH, summary).catch(() => {});
    renderOmniSummary(imageLibrarySummary);
    return true;
  } catch (error) {
    if (requestUrl !== activeUrl) return false;
    renderOmniSummary(imageLibrarySummary, { error });
    return false;
  }
}

function renderOmniSummary(summary, state = {}) {
  if (!els.omniGrid) return;
  syncChannelCounts(summary);
  els.omniGrid.innerHTML = "";

  if (!summary && state.loading) {
    els.omniMeta.textContent = "正在读取";
    els.omniGrid.innerHTML = `<div class="loading-row">正在读取图像和媒体资料库</div>`;
    return;
  }

  if (!summary) {
    els.omniMeta.textContent = state.error ? "暂不可用" : "等待数据";
    els.omniGrid.innerHTML = `<div class="loading-row">图像和媒体资料库暂时不可用</div>`;
    return;
  }

  els.omniMeta.textContent = omniMetaText(summary, state);
  for (const channel of omniChannels(summary)) {
    els.omniGrid.append(createOmniCard(channel));
  }
}

function omniMetaText(summary, state = {}) {
  if (state.error) return "离线缓存";
  if (state.cachedAt) return `缓存 ${cacheAgeText(state.cachedAt)}`;
  if (summary.scannedAt) return `更新 ${cacheAgeText(summary.scannedAt)}`;
  return "已连接";
}

function omniChannels(summary = {}) {
  const totals = summary.totals || {};
  const workTotals = library?.totals || {};
  return [
    {
      label: "番号库",
      value: formatCompact(workTotals.works),
      unit: "作品",
      detail: `${formatCompact(workTotals.videos)} 视频 · ${formatCompact(workTotals.infoFiles)} 资料`,
      view: "works"
    },
    {
      label: "套图",
      value: formatCompact(totals.photoSets),
      unit: "图包",
      detail: [formatBytes(totals.photoBytes), rootStatusText(summary.photoRoots)].filter(Boolean).join(" · "),
      mode: "photo"
    },
    {
      label: "韩漫",
      value: formatCompact(totals.manga),
      unit: "部",
      detail: rootStatusText(summary.mangaRoot),
      mode: "manga"
    },
    {
      label: "欧美",
      value: formatCompact(totals.western),
      unit: "视频",
      detail: mediaRootText(summary, "western"),
      mode: "western"
    },
    {
      label: "电影",
      value: formatCompact(totals.movies),
      unit: "影片",
      detail: mediaRootText(summary, "movie"),
      mode: "movie"
    },
    {
      label: "电视剧",
      value: formatCompact(totals.tv),
      unit: "集",
      detail: mediaRootText(summary, "tv"),
      mode: "tv"
    },
    {
      label: "TXT 工具",
      value: "排版",
      unit: "工具",
      detail: "小说文本整理",
      view: "tools"
    }
  ];
}

function createOmniCard(channel) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "omni-card";
  card.addEventListener("click", () => {
    if (channel.view) {
      showView(channel.view, {}, { resetStack: true });
      return;
    }
    if (channel.mode) {
      showView("channel", { mode: channel.mode }, { resetStack: true });
      return;
    }
    openInLibrary(channel.path || "/");
  });

  const head = document.createElement("span");
  head.className = "omni-card-label";
  head.textContent = channel.label;

  const value = document.createElement("strong");
  value.className = "omni-card-value";
  value.textContent = channel.value || "0";

  const unit = document.createElement("span");
  unit.className = "omni-card-unit";
  unit.textContent = channel.unit || "";

  const detail = document.createElement("span");
  detail.className = "omni-card-detail";
  detail.textContent = channel.detail || "打开频道";

  card.append(head, value, unit, detail);
  return card;
}

function rootStatusText(roots) {
  const list = Array.isArray(roots) ? roots : roots ? [roots] : [];
  if (!list.length) return "";
  const available = list.filter((item) => item.exists !== false).length;
  if (available === list.length) return `${formatNumber(available)} 个目录可用`;
  return `${formatNumber(available)}/${formatNumber(list.length)} 目录可用`;
}

function mediaRootText(summary = {}, kind) {
  const roots = (summary.mediaRoots || []).filter((item) => item.kind === kind);
  return rootStatusText(roots) || "媒体目录";
}

function syncChannelCounts(summary = imageLibrarySummary) {
  const totals = summary?.totals || {};
  if (els.channelWorksCount) els.channelWorksCount.textContent = library?.totals?.works ? `${formatCompact(library.totals.works)} 作品` : "默认库";
  if (els.channelPhotoCount) els.channelPhotoCount.textContent = totals.photoSets ? `${formatCompact(totals.photoSets)} 图包` : "图包 / 合集";
  if (els.channelMangaCount) els.channelMangaCount.textContent = totals.manga ? `${formatCompact(totals.manga)} 部` : "章节阅读";
  if (els.channelWesternCount) els.channelWesternCount.textContent = totals.western ? `${formatCompact(totals.western)} 视频` : "视频";
  if (els.channelMovieCount) els.channelMovieCount.textContent = totals.movies ? `${formatCompact(totals.movies)} 影片` : "影片";
  if (els.channelTvCount) els.channelTvCount.textContent = totals.tv ? `${formatCompact(totals.tv)} 集` : "剧集";
}

async function updateServiceHealth() {
  if (!els.serviceHealthStatus) return;
  const requestUrl = activeUrl;
  els.serviceHealthStatus.textContent = "正在检查服务状态";
  renderServiceHealth(null);
  try {
    const health = await fetchJson(requestUrl, "/api/health", { timeoutMs: 8000 });
    if (requestUrl !== activeUrl) return;
    renderServiceHealth(health);
  } catch (error) {
    if (requestUrl !== activeUrl) return;
    renderServiceHealth(null, error);
  }
}

function renderServiceHealth(health, error = null) {
  if (!els.serviceHealthStatus) return;
  const mode = health?.access ? connectionModeLabel(activeUrl, health.access) : connectionModeLabel(activeUrl);

  if (error) {
    els.serviceHealthStatus.textContent = `无法连接：${error.message}`;
    els.serviceHealthStatus.classList.add("error");
    setHealthMetric(els.healthMode, mode);
    setHealthMetric(els.healthRoots, "-");
    setHealthMetric(els.healthWorks, "-");
    setHealthMetric(els.healthScannedAt, "-");
    return;
  }

  if (!health) {
    els.serviceHealthStatus.textContent = "等待服务状态";
    els.serviceHealthStatus.classList.remove("error");
    setHealthMetric(els.healthMode, mode);
    setHealthMetric(els.healthRoots, "-");
    setHealthMetric(els.healthWorks, "-");
    setHealthMetric(els.healthScannedAt, "-");
    return;
  }

  const missingCount = Number(health.missingRootCount || 0);
  const availableCount = Number(health.availableRootCount || 0);
  const totalRoots = availableCount + missingCount;
  els.serviceHealthStatus.textContent = health.lastScanError
    ? `索引异常：${health.lastScanError}`
    : missingCount
      ? `有 ${formatNumber(missingCount)} 个根目录不可用`
      : "服务正常，全部根目录可用";
  els.serviceHealthStatus.classList.toggle("error", Boolean(health.lastScanError || missingCount));
  setHealthMetric(els.healthMode, mode);
  setHealthMetric(els.healthRoots, totalRoots ? `${formatNumber(availableCount)}/${formatNumber(totalRoots)}` : formatNumber(availableCount));
  setHealthMetric(els.healthWorks, formatCompact(health.totals?.works));
  setHealthMetric(els.healthScannedAt, health.scannedAt ? cacheAgeText(health.scannedAt) : "-");
}

function setHealthMetric(element, text) {
  if (element) element.textContent = text || "-";
}

function applyTheme(value) {
  themePreference = ["light", "dark", "system"].includes(value) ? value : "system";
  localStorage.setItem(THEME_STORAGE_KEY, themePreference);
  if (themePreference === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = themePreference;
  }
  for (const button of els.themeButtons || []) {
    button.classList.toggle("active", button.dataset.themeChoice === themePreference);
  }
}

function updateServer(url) {
  activeUrl = normalizeUrl(url);
  localStorage.setItem(STORAGE_KEY, activeUrl);
  els.serverUrl.value = activeUrl;
  els.serverLabel.textContent = activeUrl;
  imageLibrarySummary = null;
  renderOmniSummary(null, { loading: true });

  for (const button of els.quickServers) {
    button.classList.toggle("active", normalizeUrl(button.dataset.url) === activeUrl);
  }
}

function openInLibrary(target = {}) {
  const options = typeof target === "string" ? { path: target } : target;
  const url = new URL(options.path || "/", activeUrl);
  url.searchParams.set("client", "android");
  url.searchParams.set("appv", CLIENT_VERSION);
  url.searchParams.set("returnTo", androidReturnUrl());
  for (const [key, value] of Object.entries(options)) {
    if (key === "path") continue;
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  window.location.assign(url.toString());
}

function androidReturnUrl() {
  const current = window.location.href;
  try {
    const url = new URL(current);
    const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    if (url.protocol === "capacitor:" || ((url.protocol === "http:" || url.protocol === "https:") && localHosts.has(url.hostname))) {
      return url.toString();
    }
  } catch {
    // Fall through to the Capacitor home origin.
  }
  return "http://localhost/";
}

async function loadDashboard() {
  setConnection("连接中", true);
  els.personPreview.innerHTML = `<div class="loading-row">正在读取资料库</div>`;
  loadImageLibrarySummary();

  const cached = await readCachedJson(activeUrl, LIBRARY_CACHE_PATH).catch(() => null);
  if (cached?.payload) {
    library = cached.payload;
    renderDashboard(library);
    workViews.renderContinuePreview({ preferCache: true });
    const targetMode = connectionModeLabel(activeUrl);
    setConnection(`${targetMode} · 缓存`, false);
    setStatus(`已显示${targetMode}服务的本地缓存：${cacheAgeText(cached.updatedAt)}，正在连接电脑端。`);
    renderCurrentView();
  }

  try {
    library = await fetchJson(activeUrl, LIBRARY_CACHE_PATH);
    writeCachedJson(activeUrl, LIBRARY_CACHE_PATH, library).catch(() => {});
    renderDashboard(library);
    workViews.renderContinuePreview();
    setConnection(connectionModeLabel(activeUrl, library.access), true);
    setStatus(`索引时间：${library.scannedAt ? new Date(library.scannedAt).toLocaleString() : "未知"}`);
    updateServiceHealth();
    renderCurrentView();
    updateCacheStatus();
    return true;
  } catch (error) {
    const targetMode = connectionModeLabel(activeUrl);
    setConnection(`${targetMode} · 离线`, false);
    if (cached?.payload) {
      setStatus(`电脑端暂时连不上，继续显示本地缓存：${cacheAgeText(cached.updatedAt)}。`, "error");
      updateServiceHealth();
      updateCacheStatus();
      return false;
    }
    library = null;
    setStatus(`连接失败：${error.message}`, "error");
    renderOffline();
    showHome();
    els.settingsPanel.hidden = false;
    updateServiceHealth();
    updateCacheStatus();
    return false;
  }
}

function renderDashboard(data) {
  const totals = data.totals || {};
  const user = data.user || {};
  const people = data.people || [];

  els.statRoots.textContent = formatNumber(data.availableRoots?.length || 0);
  els.statPeople.textContent = formatNumber(totals.people);
  els.statVideos.textContent = formatCompact(totals.videos);
  els.statInfo.textContent = formatCompact(totals.infoFiles);
  renderUserState(user);
  els.peopleCount.textContent = formatNumber(totals.people);
  if (els.worksCount) els.worksCount.textContent = formatCompact(totals.works);
  if (els.rankingsCount) els.rankingsCount.textContent = "TOP";
  syncChannelCounts(imageLibrarySummary);
  renderOmniSummary(imageLibrarySummary, { loading: !imageLibrarySummary });

  const previewPeople = [...people]
    .sort((a, b) => {
      const aVisual = a.actorProfile?.avatarUrl ? 2 : a.coverId ? 1 : 0;
      const bVisual = b.actorProfile?.avatarUrl ? 2 : b.coverId ? 1 : 0;
      return bVisual - aVisual || (b.videoCount || 0) - (a.videoCount || 0);
    })
    .slice(0, 10);
  peopleViews.renderPreviewPeople(previewPeople);
}

function renderUserState(user = {}) {
  els.historyCount.textContent = formatNumber(user.historyCount || user.history || 0);
  els.favoriteCount.textContent = formatNumber(user.favoriteCount || user.favorites || 0);
}

function showHome(options = {}) {
  invalidateViewRender();
  currentView = "home";
  currentViewParams = {};
  viewStack = [];
  syncSearchSurface();
  els.quickStrip.hidden = false;
  els.continueSection.hidden = els.continuePreview.dataset.hasItems !== "1";
  els.statusCard.hidden = false;
  if (els.omniSection) els.omniSection.hidden = false;
  if (els.libraryChannelStrip) els.libraryChannelStrip.hidden = false;
  els.previewSection.hidden = false;
  els.contentPanel.hidden = true;
  els.settingsPanel.hidden = true;
  els.viewBack.hidden = true;
  setActiveBottom("home");
  rememberViewState("home", {});
  if (!options.skipHistory) replaceCurrentHistory();
  queueScrollRestore(options.restoreScrollY ?? 0);
}

function showSettings(options = {}) {
  invalidateViewRender();
  currentView = "settings";
  currentViewParams = {};
  viewStack = [];
  syncSearchSurface();
  els.quickStrip.hidden = true;
  els.continueSection.hidden = true;
  els.statusCard.hidden = true;
  if (els.omniSection) els.omniSection.hidden = true;
  if (els.libraryChannelStrip) els.libraryChannelStrip.hidden = true;
  els.previewSection.hidden = true;
  els.contentPanel.hidden = true;
  els.settingsPanel.hidden = false;
  els.viewBack.hidden = true;
  setActiveBottom("settings");
  updateCacheStatus();
  updateServiceHealth();
  if (!options.skipHistory) pushViewHistory("settings", {});
  queueScrollRestore(options.restoreScrollY ?? 0);
}

function showView(view, params = {}, navigation = {}) {
  if (!library && view !== "home" && view !== "tools") {
    toggleSettings(true);
    return;
  }

  const shouldWriteHistory = !navigation.skipHistory;
  if (shouldWriteHistory) rememberCurrentScrollInHistory();
  if (navigation.resetStack) viewStack = [];
  if (navigation.push && currentView) {
    viewStack.push({ view: currentView, params: currentViewParams, scrollY: currentScrollY() });
  }
  currentView = view;
  currentViewParams = sanitizeViewParams(view, params);
  peopleLimit = 80;
  worksLimit = defaultWorksLimitForView(view);
  channelLimit = defaultChannelLimitForView(view);
  photoImageLimit = defaultPhotoImageLimitForView(view);
  mangaImageLimit = defaultMangaImageLimitForView(view);
  els.settingsPanel.hidden = true;
  rememberViewState(currentView, currentViewParams);
  if (shouldWriteHistory) pushViewHistory(view, currentViewParams, navigation.restoreScrollY ?? 0);
  else if (navigation.replaceHistory) replaceCurrentHistory();
  renderCurrentView();
  queueScrollRestore(navigation.restoreScrollY ?? 0);
}

function defaultWorksLimitForView(view) {
  if (view === "rankings") return 120;
  if (view === "works") return 80;
  if (view === "search" || view === "personDetail") return 60;
  return 40;
}

function defaultChannelLimitForView(view) {
  return view === "channel" ? 48 : 40;
}

function defaultPhotoImageLimitForView(view) {
  return view === "photoDetail" ? 24 : 12;
}

function defaultMangaImageLimitForView(view) {
  return view === "mangaChapter" ? 12 : 8;
}

function goBack() {
  if (mediaViewer?.close()) return;
  if (currentView !== "home" && window.history.state?.marker === HISTORY_MARKER && window.history.length > 1) {
    window.history.back();
    return;
  }
  applyBackState();
}

function applyBackState() {
  const previous = viewStack.pop();
  if (!previous || previous.view === "home") {
    showHome({ skipHistory: true, restoreScrollY: previous?.scrollY ?? 0 });
    return;
  }
  showView(previous.view, previous.params, { skipHistory: true, restoreScrollY: previous.scrollY ?? 0 });
}

function routeHistoryState(view, params = {}, scrollY = currentScrollY()) {
  return {
    marker: HISTORY_MARKER,
    view,
    params: sanitizeViewParams(view, params || {}),
    scrollY: Math.max(0, Math.round(Number(scrollY) || 0))
  };
}

function rememberCurrentScrollInHistory() {
  if (window.history.state?.marker !== HISTORY_MARKER) return;
  const state = {
    ...window.history.state,
    scrollY: currentScrollY()
  };
  const view = state.view === "settings" || RESTORABLE_VIEWS.has(state.view) ? state.view : currentView;
  const params = sanitizeViewParams(view, state.params || {});
  window.history.replaceState({ ...state, view, params }, "", viewRouteHash(view, params));
}

function pushViewHistory(view, params = {}, scrollY = 0) {
  window.history.pushState(routeHistoryState(view, params, scrollY), "", viewRouteHash(view, params));
}

function replaceCurrentHistory() {
  window.history.replaceState(routeHistoryState(currentView, currentViewParams), "", viewRouteHash(currentView, currentViewParams));
}

function restoreFromHistoryState(historyState) {
  if (mediaViewer?.close()) return;
  const hashState = !historyState || historyState.marker !== HISTORY_MARKER ? readViewStateFromHash() : null;
  if ((!historyState || historyState.marker !== HISTORY_MARKER) && !hashState) {
    showHome({ skipHistory: true });
    return;
  }

  const view = hashState?.view || (historyState.view === "settings" || RESTORABLE_VIEWS.has(historyState.view) ? historyState.view : "home");
  const params = hashState?.params || sanitizeViewParams(view, historyState.params || {});
  const restoreScrollY = Number(hashState ? 0 : historyState.scrollY || 0);
  viewStack = [];

  if (view === "home") {
    showHome({ skipHistory: true, restoreScrollY });
    return;
  }
  if (view === "settings") {
    showSettings({ skipHistory: true, restoreScrollY });
    return;
  }
  showView(view, params, { skipHistory: true, restoreScrollY });
}

function renderCurrentView() {
  if (currentView === "home") {
    showHome();
    return;
  }
  if (currentView === "settings") {
    showSettings({ skipHistory: true });
    return;
  }

  els.statusCard.hidden = true;
  if (els.omniSection) els.omniSection.hidden = true;
  if (els.libraryChannelStrip) els.libraryChannelStrip.hidden = true;
  els.previewSection.hidden = true;
  els.continueSection.hidden = true;
  els.quickStrip.hidden = true;
  els.settingsPanel.hidden = true;
  els.contentPanel.hidden = false;
  els.viewBack.hidden = currentView === "home";
  els.viewContent.innerHTML = "";
  syncSearchSurface();
  const renderGuard = beginViewRender(currentView, currentViewParams);

  if (currentView === "people") {
    peopleViews.renderPeopleIndex();
    return;
  }
  if (currentView === "works") {
    workViews.renderAllWorks(renderGuard);
    return;
  }
  if (currentView === "rankings") {
    workViews.renderRankings(renderGuard);
    return;
  }
  if (currentView === "favorites") {
    workViews.renderWorkCollection("favorites", renderGuard);
    return;
  }
  if (currentView === "history") {
    workViews.renderWorkCollection("history", renderGuard);
    return;
  }
  if (currentView === "search") {
    workViews.renderSearchResults(currentViewParams.query || "", renderGuard);
    return;
  }
  if (currentView === "personDetail") {
    detailViews.renderPersonDetail(currentViewParams.personId, renderGuard);
    return;
  }
  if (currentView === "workDetail") {
    detailViews.renderWorkDetail(currentViewParams.workId, renderGuard);
    return;
  }
  if (currentView === "channel") {
    channelViews.renderChannel(currentViewParams, renderGuard);
    return;
  }
  if (currentView === "photoDetail") {
    channelViews.renderPhotoDetail(currentViewParams.id, renderGuard);
    return;
  }
  if (currentView === "mangaDetail") {
    channelViews.renderMangaDetail(currentViewParams.id, renderGuard);
    return;
  }
  if (currentView === "mangaChapter") {
    channelViews.renderMangaChapter(currentViewParams.id, currentViewParams.chapterIndex, renderGuard);
    return;
  }
  if (currentView === "mediaDetail") {
    channelViews.renderMediaDetail(currentViewParams.id, renderGuard);
    return;
  }
  if (currentView === "tools") {
    toolViews.renderTxtTool(renderGuard);
  }
}

function renderOffline() {
  els.statRoots.textContent = "-";
  els.statPeople.textContent = "-";
  els.statVideos.textContent = "-";
  els.statInfo.textContent = "-";
  els.historyCount.textContent = "0";
  els.favoriteCount.textContent = "0";
  els.peopleCount.textContent = "0";
  if (els.worksCount) els.worksCount.textContent = "0";
  if (els.rankingsCount) els.rankingsCount.textContent = "TOP";
  syncChannelCounts(imageLibrarySummary);
  els.continueSection.hidden = true;
  els.continuePreview.dataset.hasItems = "0";
  els.continuePreview.innerHTML = "";
  els.personPreview.innerHTML = `<div class="loading-row">电脑端服务未连接，可检查地址或 29998 服务。</div>`;
}

function toggleSettings(force) {
  const shouldShow = typeof force === "boolean" ? force : currentView !== "settings";
  if (shouldShow) showSettings();
  else showHome();
}

function setActiveBottom(name) {
  for (const button of els.bottomNav) {
    const active =
      (name === "home" && button.dataset.home !== undefined) ||
      (name === "search" && button.dataset.focusSearch !== undefined) ||
      (name === "settings" && button.dataset.settings !== undefined) ||
      button.dataset.openView === name;
    button.classList.toggle("active", active);
  }
}

function syncSearchSurface() {
  const isSearch = currentView === "search";
  const isChannel = currentView === "channel";
  if (els.searchHistory) els.searchHistory.hidden = !isSearch;
  if (els.bottomNavBar) els.bottomNavBar.hidden = isSearch;
  els.searchForm.classList.toggle("search-mode", isSearch);
  els.searchForm.classList.toggle("channel-mode", isChannel);
  document.body.classList.toggle("search-view", isSearch);
  const channelLabel = isChannel ? channelViews?.channelLabel(currentViewParams.mode) : "";
  els.searchInput.placeholder = isChannel ? `搜${channelLabel || "频道"}` : "搜作品/人物，频道看图包";
  if (isChannel) {
    els.searchInput.value = currentViewParams.query || "";
    return;
  }
  if (!isSearch) {
    els.searchInput.value = "";
    if (document.activeElement === els.searchInput) els.searchInput.blur();
  }
}

workViews = createWorkViews({
  els,
  getActiveUrl: () => activeUrl,
  getWorksLimit: () => worksLimit,
  increaseWorksLimit: (amount) => {
    worksLimit += amount;
  },
  showView,
  openInLibrary,
  setActiveBottom,
  renderCurrentView,
  isHomeView: () => currentView === "home"
});

channelViews = createChannelViews({
  els,
  getActiveUrl: () => activeUrl,
  getChannelLimit: () => channelLimit,
  increaseChannelLimit: (amount) => {
    channelLimit += amount;
  },
  getPhotoImageLimit: () => photoImageLimit,
  increasePhotoImageLimit: (amount) => {
    photoImageLimit += amount;
  },
  getMangaImageLimit: () => mangaImageLimit,
  increaseMangaImageLimit: (amount) => {
    mangaImageLimit += amount;
  },
  openInLibrary,
  showPhotoDetail: (id) => showView("photoDetail", { id }, { push: true }),
  showMangaDetail: (id) => showView("mangaDetail", { id }, { push: true }),
  showMangaChapter: (id, chapterIndex) => showView("mangaChapter", { id, chapterIndex }, { push: true }),
  showMediaDetail: (id) => showView("mediaDetail", { id }, { push: true }),
  setActiveBottom,
  renderCurrentView,
  getMediaViewer: () => mediaViewer,
  updateChannelQuery: (query) => {
    showView("channel", { ...currentViewParams, query }, { skipHistory: true, replaceHistory: true });
  }
});

toolViews = createToolViews({
  els,
  getActiveUrl: () => activeUrl,
  openInLibrary,
  setActiveBottom
});

mediaViewer = createMediaViewer();

peopleViews = createPeopleViews({
  els,
  getActiveUrl: () => activeUrl,
  getLibrary: () => library,
  getPeopleLimit: () => peopleLimit,
  increasePeopleLimit: (amount) => {
    peopleLimit += amount;
  },
  showView,
  openInLibrary,
  setActiveBottom,
  createLoadMoreButton: workViews.createLoadMoreButton
});

detailViews = createDetailViews({
  els,
  getActiveUrl: () => activeUrl,
  getLibrary: () => library,
  openInLibrary,
  showView,
  setActiveBottom,
  renderWorks: workViews.renderWorks,
  renderMessage: workViews.renderMessage,
  createChip: workViews.createChip,
  mediaViewer,
  onUserStateChange: renderUserState
});

function runSearch(query) {
  if (currentView === "channel") {
    showView("channel", { ...currentViewParams, query: String(query || "").trim() }, { skipHistory: true, replaceHistory: true });
    return;
  }
  const navigation = currentView === "search"
    ? { skipHistory: true }
    : { resetStack: true };
  showView("search", { query }, navigation);
}

searchHistory = createSearchHistory({
  container: els.searchHistory,
  input: els.searchInput,
  storageKey: SEARCH_HISTORY_STORAGE_KEY,
  defaults: ["[A]"],
  onSearch: runSearch
});

window.addEventListener("popstate", (event) => restoreFromHistoryState(event.state));

window.fanhaoHandleNativeBack = () => {
  if (mediaViewer?.close()) return true;
  if (currentView === "home") return false;
  if (window.history.state?.marker === HISTORY_MARKER && window.history.length > 1) {
    window.history.back();
    return true;
  }
  applyBackState();
  return true;
};

applyTheme(themePreference);
replaceCurrentHistory();

els.settingsButton?.addEventListener("click", () => toggleSettings());
els.viewBack.addEventListener("click", goBack);

els.openLibraryButton.addEventListener("click", () => {
  els.settingsPanel.hidden = true;
  showView("people", {}, { resetStack: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
});

els.searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (currentView === "channel") {
    runSearch(els.searchInput.value);
    return;
  }
  searchHistory.run(els.searchInput.value);
});

els.searchInput.addEventListener("focus", () => {
  if (currentView === "search") return;
  if (currentView === "channel") return;
  const navigation = currentView === "home" || currentView === "settings"
    ? { resetStack: true }
    : { push: true };
  showView("search", { query: "" }, navigation);
  requestAnimationFrame(() => els.searchInput.focus());
});

els.connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    updateServer(els.serverUrl.value);
    setStatus("服务地址已保存，正在刷新状态。");
    await loadDashboard();
  } catch {
    setStatus("地址格式不对，可以写成 192.168.31.86:29998。", "error");
  }
});

els.refreshCacheButton?.addEventListener("click", async () => {
  setCacheActionsDisabled(true);
  setStatus("正在刷新本地缓存。");
  try {
    const refreshed = await loadDashboard();
    const rankingCache = refreshed ? await workViews.refreshRankingCache() : null;
    await updateCacheStatus();
    const rankingText = rankingCache?.cachedLists
      ? `，排行榜 ${formatNumber(rankingCache.cachedLists)} 个榜单已预缓存`
      : "，排行榜也已预缓存";
    const imageText = rankingCache?.cachedImages ? `，含 ${formatNumber(rankingCache.cachedImages)} 张榜单封面` : "";
    setStatus(refreshed ? `本地缓存已刷新${rankingText}${imageText}。` : "电脑端暂时连不上，保留已有本地缓存。", refreshed ? "normal" : "error");
  } catch (error) {
    setStatus(`刷新失败：${error.message}`, "error");
  } finally {
    setCacheActionsDisabled(false);
  }
});

els.clearCacheButton?.addEventListener("click", async () => {
  setCacheActionsDisabled(true);
  setStatus("正在清理本地缓存。");
  try {
    await clearCachedData(activeUrl);
    await updateCacheStatus();
    setStatus("当前服务的本地缓存已清理。");
  } catch (error) {
    setStatus(`清理失败：${error.message}`, "error");
  } finally {
    setCacheActionsDisabled(false);
  }
});

for (const button of els.quickServers) {
  button.addEventListener("click", async () => {
    updateServer(button.dataset.url);
    await loadDashboard();
  });
}

for (const button of els.openTargets) {
  button.addEventListener("click", () => {
    if (button.dataset.openView) {
      showView(button.dataset.openView, {}, { resetStack: true });
      return;
    }
    if (button.dataset.openChannel) {
      showView("channel", { mode: button.dataset.openChannel }, { resetStack: true });
      return;
    }
    openInLibrary(button.dataset.openUrl || "/");
  });
}

for (const button of els.bottomNav) {
  button.addEventListener("click", () => {
    if (button.dataset.focusSearch !== undefined) {
      searchHistory.run(els.searchInput.value);
      els.searchInput.focus();
      return;
    }
    if (button.dataset.settings !== undefined) {
      showSettings();
      return;
    }
    if (button.dataset.home !== undefined) {
      els.settingsPanel.hidden = true;
      showHome();
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (button.dataset.openView) {
      els.settingsPanel.hidden = true;
      showView(button.dataset.openView, {}, { resetStack: true });
    }
  });
}

for (const button of els.themeButtons) {
  button.addEventListener("click", () => applyTheme(button.dataset.themeChoice));
}

updateServer(activeUrl);
updateCacheStatus();
loadDashboard();
