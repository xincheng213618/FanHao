const $ = (id) => document.getElementById(id);

let currentFilter = "";
let toastTimer = null;
let saveTimer = null;
let profileSearchTimer = null;
let localQueueOrder = [];
let lastState = null;
let lastDownloadProfileId = null;
const dirtyInputs = new Set();
const LINKS_PAGE_SIZE = 300;
let linksRows = [];
let linksTotal = 0;
let linksLoading = false;
let profileManagerRows = [];
let profileManagerTotal = 0;
let profileManagerEligibleCount = 0;
let profileManagerLoading = false;
let profileManagerWasExtractActive = false;
let previousAuthLoginStatus = "";
const LIBRARY_PAGE_SIZE = 48;
let libraryRows = [];
let libraryTotal = 0;
let libraryOffset = 0;
let libraryHasMore = false;
let libraryLoading = false;
let librarySearchTimer = null;

function setInputValue(id, value, options = {}) {
  const node = $(id);
  if (!node || document.activeElement === node) return;
  if (!options.force && dirtyInputs.has(id)) return;
  node.value = value;
}

function markInputClean(id) {
  dirtyInputs.delete(id);
}

function snapshotSettings() {
  return {
    profile_url: $("profileUrl").value.trim(),
    profile_tab: "auto",
    library_output_dir: $("libraryPath").value.trim(),
    download_proxy: $("downloadProxy").value.trim(),
    concurrency: $("concurrencyNumber").value || $("concurrency").value,
    scrolls: $("scrolls").value,
    idle_rounds: $("idleRounds").value,
    incremental_stop_existing: $("incrementalStopExisting").value,
    profile_refresh_recent_days: $("profileRefreshRecentDays")?.value || 30,
    download_cycle_limit: $("downloadCycleLimit")?.value || 350,
    download_cycle_cooldown_minutes: $("downloadCycleCooldownMinutes")?.value || 30,
    failure_guard_threshold: $("failureGuardThreshold").value,
  };
}

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 3200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(response.ok ? "接口返回格式异常" : `请求失败：${response.status}`);
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.message || `请求失败：${response.status}`);
  }
  return data;
}

function post(path, payload = {}) {
  return api(path, { method: "POST", body: JSON.stringify(payload) });
}

function statusLabel(status) {
  return {
    pending: "待下载",
    downloading: "下载中",
    downloaded: "已完成",
    failed: "失败",
  }[status] || status;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function renderAuth(auth = {}) {
  const login = auth.login || {};
  const loginStatus = login.status || "idle";
  const effectiveStatus = login.active ? "running" : loginStatus === "failed" ? "failed" : auth.status || "missing";
  const labels = {
    ready: "已登录",
    success: "已登录",
    running: "等待登录",
    incomplete: "信息不完整",
    failed: "登录未完成",
    missing: "未设置",
  };
  const badge = $("authStatusBadge");
  badge.className = `auth-status ${effectiveStatus}`;
  badge.textContent = labels[effectiveStatus] || "未设置";
  $("authSummary").textContent = login.active ? login.message : auth.message || "尚未设置抖音登录信息";
  $("authCookiePath").textContent = auth.path || "—";
  $("authCookiePath").title = auth.path || "";
  $("authUpdatedAt").textContent = auth.modified_at ? formatDateTime(auth.modified_at) : "—";
  const sessionText = auth.has_session ? " · 已检测登录凭证" : "";
  $("authCookieCount").textContent = `${Number(auth.cookie_count || 0)} 项${sessionText}`;
  $("authLoginStart").disabled = Boolean(login.active);
  $("authImportCookie").disabled = Boolean(login.active);
  $("authClear").disabled = Boolean(login.active) || !auth.exists;
  $("authLoginHint").textContent = login.active
    ? "请在刚打开的 Edge 窗口中完成抖音登录；成功后窗口会自动关闭。"
    : login.message || "登录成功后会自动保存；Cookie 只保存在当前电脑，不会打进安装包。";
  if (previousAuthLoginStatus === "running" && loginStatus === "success") {
    toast("抖音登录成功，Cookie 已自动保存");
  } else if (previousAuthLoginStatus === "running" && loginStatus === "failed") {
    toast(login.message || "登录未完成");
  }
  previousAuthLoginStatus = login.active ? "running" : loginStatus;
}

async function refreshAuthStatus() {
  const result = await api("/api/auth/status");
  renderAuth(result.auth || {});
  return result.auth || {};
}

async function startAuthLogin() {
  const result = await post("/api/auth/login/start");
  renderAuth(result.auth || {});
  toast(result.message || "已打开 Edge，请完成抖音登录");
}

async function importAuthCookie(file) {
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) throw new Error("Cookie 文件不能超过 2 MB");
  const content = await file.text();
  const result = await post("/api/auth/cookie/import", { content, name: file.name });
  renderAuth(result.auth || {});
  toast(result.auth?.has_session ? "Cookie 已导入，登录信息可用" : "Cookie 已导入，但未检测到登录凭证");
}

async function clearAuthCookie() {
  const ok = window.confirm("确定清除当前电脑上的抖音 Cookie 和登录缓存吗？之后需要重新登录才能采集关注、喜欢等内容。");
  if (!ok) return;
  const result = await post("/api/auth/cookie/clear");
  renderAuth(result.auth || {});
  toast(result.message || "抖音登录信息已清除");
}

function dateInputDaysAgo(value) {
  const days = Math.max(0, Math.floor(Number(value) || 0));
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function profileWorkDate(profile) {
  const timestamp = Number(profile.latest_work_create_time || 0);
  return timestamp > 0 ? formatDateTime(timestamp * 1000) : "";
}

function formatCountdown(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const parts = hours > 0 ? [hours, minutes, remainder] : [minutes, remainder];
  return parts.map((part) => String(part).padStart(2, "0")).join(":");
}

function renderDownloadGuard(state) {
  const guard = state.download?.failure_guard || {};
  const active = Boolean(guard.active);
  const plannedPause = guard.kind === "cycle_limit";
  const banner = $("downloadGuard");
  banner.hidden = !active;
  $("downloadState").classList.toggle("guard-status", active);
  if (!active) return;

  const resumeAt = formatDateTime(guard.until);
  const countdown = formatCountdown(guard.remaining_seconds);
  const proxy = state.download?.proxy ? `当前代理：${state.download.proxy}` : "当前未配置下载代理";
  $("downloadGuardTitle").textContent = plannedPause ? "下载主动休息中" : "下载保护已暂停";
  $("downloadGuardReason").textContent = guard.reason || "详情接口疑似触发平台保护";
  $("downloadGuardTime").textContent = `预计 ${resumeAt || "稍后"} 自动重试（剩余 ${countdown}）`;
  $("downloadGuardHelp").textContent = plannedPause
    ? "本轮达到安全下载量，系统会自动继续处理剩余队列。"
    : "切换代理 IP 或更新 Cookie 后，可立即重新尝试。";
  $("downloadGuard").title = proxy;
}

function renderDownloadCycle(state) {
  const node = $("downloadCycleProgress");
  if (!node) return;
  const cycle = state.download?.cycle || {};
  const completed = Math.max(0, Number(cycle.completed || 0));
  const limit = Math.max(0, Number(cycle.limit || 0));
  const cooldown = Math.max(1, Number(cycle.cooldown_minutes || 30));
  if (limit <= 0) {
    node.innerHTML = '<div class="muted">主动分段已关闭</div>';
    return;
  }
  const percent = Math.min(100, Math.round((completed / limit) * 100));
  node.innerHTML = `
    <div class="download-cycle-head"><span>本轮实际下载</span><strong>${completed} / ${limit}</strong></div>
    <div class="download-cycle-bar"><span style="width:${percent}%"></span></div>
    <div class="muted">达到 ${limit} 后主动休息 ${cooldown} 分钟</div>
  `;
}

function linkStatusTime(link) {
  const status = String(link.status || "");
  if (status === "downloaded") return ["完成", link.downloaded_at];
  if (status === "failed") return ["失败", link.failed_at || link.last_started_at];
  if (status === "downloading") return ["开始", link.last_started_at];
  if (status === "pending") return ["发现", link.discovered_at || link.last_seen_at];
  return ["", link.last_seen_at];
}

function renderLinkTime(link) {
  const [label, value] = linkStatusTime(link);
  const text = formatDateTime(value);
  if (!text) return '<span class="muted">-</span>';
  return `<div>${escapeHtml(label)}</div><div class="muted">${escapeHtml(text)}</div>`;
}

function renderStats(stats) {
  const rows = [
    ["total", "队列合计"],
    ["pending", "待下载"],
    ["downloading", "下载中"],
    ["downloaded", "已完成"],
    ["failed", "失败"],
  ];
  $("queueStats").innerHTML = rows
    .map(
      ([key, label]) => `
        <div class="queue-stat">
          <span>${label}</span>
          <strong>${stats[key] || 0}</strong>
        </div>
      `
    )
    .join("");
}

function statsFromQueue(queue) {
  return (queue || []).reduce(
    (acc, item) => {
      acc.total += Number(item.total || 0);
      acc.pending += Number(item.pending || 0);
      acc.downloading += Number(item.downloading || 0);
      acc.downloaded += Number(item.downloaded || 0);
      acc.failed += Number(item.failed || 0);
      return acc;
    },
    { total: 0, pending: 0, downloading: 0, downloaded: 0, failed: 0 }
  );
}

function renderJobs(jobs) {
  $("jobs").innerHTML =
    jobs
      .map(
        (job) => `
          <div class="list-item">
            <div class="title">#${job.id} ${job.type} · ${job.status}</div>
            <div class="muted">${job.message || ""}</div>
            <div class="muted">${job.started_at || ""}${job.finished_at ? ` -> ${job.finished_at}` : ""}</div>
          </div>
        `
      )
      .join("") || '<div class="muted">暂无任务</div>';
}

function renderEvents(events) {
  $("events").innerHTML =
    events
      .map(
        (event) => `
          <div class="list-item">
            <div class="title">${event.level}</div>
            <div>${escapeHtml(event.message || "")}</div>
            <div class="muted">${event.ts}</div>
          </div>
        `
      )
      .join("") || '<div class="muted">暂无事件</div>';
}

function renderProfiles(profiles, currentProfile) {
  const select = $("profileSelect");
  if (!select || document.activeElement === select) return;
  const rows = profiles || [];
  select.innerHTML =
    rows
      .map((profile) => {
        const tabLabel = profile.tab === "like" ? "喜欢" : "作品";
        const name = String(profile.nickname || profile.title || "").trim();
        const douyinId = displayDouyinId(profile);
        const stats = [
          profile.aweme_count ? `主页 ${formatCompact(profile.aweme_count)} 作品` : "",
          profile.follower_count ? `粉丝 ${formatCompact(profile.follower_count)}` : "",
          profile.total_favorited ? `获赞 ${formatCompact(profile.total_favorited)}` : "",
          profile.ip_location ? `IP ${profile.ip_location}` : "",
          douyinId ? `抖音号 ${douyinId}` : "",
        ].filter(Boolean).join(" / ");
        const title = name ? `${name} · ` : "";
        const extra = stats ? ` · ${stats}` : "";
        const label = `${title}${tabLabel} · ${profile.total || 0} 条 / 完成 ${profile.downloaded || 0} / 待 ${profile.pending || 0}${extra}`;
        const selected = currentProfile && profile.id === currentProfile.id ? "selected" : "";
        return `<option value="${escapeHtml(profile.url)}" data-tab="${escapeHtml(profile.tab || "post")}" ${selected}>#${profile.id} ${escapeHtml(label)} · ${escapeHtml(profile.url)}</option>`;
      })
      .join("") || '<option value="">还没有入库主页</option>';
}

function renderProfileManager(profiles, extractActive = false) {
  const node = $("profileManagerList");
  if (!node) return;
  const query = String($("profileManagerSearch")?.value || "").trim().toLowerCase();
  const sortMode = $("profileManagerSort")?.value || "latest_desc";
  const scope = $("profileManagerScope")?.value || "collected";
  const allRows = Array.isArray(profiles) ? profiles : [];
  const rows = allRows.filter((profile) => {
    const inScope = scope === "all"
      || (scope === "following" && (Number(profile.is_following || 0) === 1 || Number(profile.is_self || 0) === 1))
      || (scope === "collected" && (Number(profile.total || 0) > 0 || Number(profile.is_self || 0) === 1));
    if (!inScope) return false;
    if (!query) return true;
    return [profile.nickname, profile.title, profile.unique_id, profile.short_id, profile.sec_uid]
      .some((value) => String(value || "").toLowerCase().includes(query));
  });
  const numericSort = {
    latest_desc: (profile) => Number(profile.latest_work_create_time || 0),
    works_desc: (profile) => Number(profile.aweme_count || profile.total || 0),
    likes_desc: (profile) => Number(profile.total_favorited || 0),
    followers_desc: (profile) => Number(profile.follower_count || 0),
  };
  if (sortMode === "last_refresh_asc") {
    rows.sort((a, b) => Number(b.is_self || 0) - Number(a.is_self || 0) || String(a.last_extracted_at || "").localeCompare(String(b.last_extracted_at || "")) || Number(a.id) - Number(b.id));
  } else {
    const valueOf = numericSort[sortMode] || numericSort.latest_desc;
    rows.sort((a, b) => Number(b.is_self || 0) - Number(a.is_self || 0) || valueOf(b) - valueOf(a) || Number(b.id) - Number(a.id));
  }

  const since = $("profileRefreshSince")?.value || "";
  const sinceTimestamp = since ? new Date(`${since}T00:00:00`).getTime() / 1000 : 0;
  const localEligibleCount = allRows.filter((profile) => {
    if (!(Number(profile.total || 0) > 0 || Number(profile.is_self || 0) === 1)) return false;
    const latest = Number(profile.latest_work_create_time || 0);
    return !sinceTimestamp || profile.tab === "like" || latest <= 0 || latest >= sinceTimestamp;
  }).length;
  const eligibleCount = profileManagerEligibleCount || localEligibleCount;
  const visibleRows = rows;
  const totalRows = Math.max(profileManagerTotal, rows.length);
  $("profileManagerSummary").textContent = `${totalRows} 个主页 · 已加载 ${visibleRows.length} 个 · 一键采集 ${eligibleCount} 个${since ? `（作品不早于 ${since}）` : ""}`;
  node.innerHTML = visibleRows.map((profile) => {
    const name = String(profile.nickname || profile.title || `主页 #${profile.id}`).trim();
    const douyinId = displayDouyinId(profile) || "-";
    const latestWork = profileWorkDate(profile);
    const lastExtracted = formatDateTime(profile.last_extracted_at);
    const tabLabel = profile.tab === "like" ? "我的喜欢" : "作者作品";
    const sourceLabel = Number(profile.is_self || 0) === 1 ? "本人" : Number(profile.is_following || 0) === 1 ? "已关注" : "";
    const avatar = profile.avatar_url
      ? `<img class="profile-manager-avatar" src="${escapeHtml(profile.avatar_url)}" alt="" loading="lazy" />`
      : '<div class="profile-manager-avatar placeholder"></div>';
    return `
      <div class="profile-manager-row">
        <div class="profile-manager-identity">
          ${avatar}
          <div>
            <div class="profile-manager-name">${escapeHtml(name)}${sourceLabel ? ` <span class="profile-manager-badge">${escapeHtml(sourceLabel)}</span>` : ""}</div>
            <div class="muted">${escapeHtml(tabLabel)} · 抖音号 ${escapeHtml(douyinId)}</div>
          </div>
        </div>
        <div class="profile-manager-metric"><span>作品</span><strong>${formatCompact(profile.aweme_count || profile.total || 0)}</strong><small>入库 ${formatCompact(profile.total || 0)}</small></div>
        <div class="profile-manager-metric"><span>粉丝</span><strong>${formatCompact(profile.follower_count || 0)}</strong></div>
        <div class="profile-manager-metric"><span>获赞</span><strong>${formatCompact(profile.total_favorited || 0)}</strong></div>
        <div class="profile-manager-date"><span>最新作品</span><strong>${escapeHtml(latestWork ? latestWork.slice(0, 10) : "暂无日期")}</strong></div>
        <div class="profile-manager-date"><span>上次采集</span><strong>${escapeHtml(lastExtracted || "尚未采集")}</strong></div>
        <div class="profile-manager-row-actions">
          <a class="queue-link" href="${escapeHtml(profile.url || "")}" target="_blank" rel="noreferrer">主页</a>
          <button data-profile-refresh="${profile.id}" ${extractActive ? "disabled" : ""}>${Number(profile.is_self || 0) === 1 ? "采集喜欢" : "采集作品"}</button>
        </div>
      </div>
    `;
  }).join("") + (totalRows > visibleRows.length
    ? `<div class="profile-manager-load-more"><button data-profile-load-more ${profileManagerLoading ? "disabled" : ""}>${profileManagerLoading ? "加载中" : `显示更多（剩余 ${totalRows - visibleRows.length}）`}</button></div>`
    : "") || '<div class="muted profile-manager-empty">没有符合条件的主页</div>';
}

async function loadProfileManager(options = {}) {
  if (profileManagerLoading) return;
  const reset = options.reset !== false;
  profileManagerLoading = true;
  try {
    const since = $("profileRefreshSince")?.value || "";
    const sinceTimestamp = since ? Math.floor(new Date(`${since}T00:00:00`).getTime() / 1000) : 0;
    const params = new URLSearchParams({
      scope: $("profileManagerScope")?.value || "collected",
      q: String($("profileManagerSearch")?.value || "").trim(),
      sort: $("profileManagerSort")?.value || "latest_desc",
      since: String(sinceTimestamp || 0),
      limit: "200",
      offset: String(reset ? 0 : profileManagerRows.length),
    });
    const data = await api(`/api/profiles?${params.toString()}`);
    const incoming = Array.isArray(data.profiles) ? data.profiles : [];
    if (reset) {
      profileManagerRows = incoming;
    } else {
      const known = new Set(profileManagerRows.map((profile) => Number(profile.id)));
      profileManagerRows.push(...incoming.filter((profile) => !known.has(Number(profile.id))));
    }
    profileManagerTotal = Number(data.total || 0);
    profileManagerEligibleCount = Number(data.eligible_count || 0);
  } finally {
    profileManagerLoading = false;
    renderProfileManager(profileManagerRows, Boolean(lastState?.extract?.active));
  }
}

function renderDownloadQueue(queue, activeProfileId, canSort = true) {
  const node = $("downloadQueue");
  if (!node) return;
  const rows = orderQueue(queue || []);
  node.innerHTML =
    rows
      .map((item, index) => {
        const name = String(item.nickname || item.title || `作者 #${item.profile_id}`).trim();
        const tabLabel = item.tab === "like" ? "我的喜欢" : "作者作品";
        const douyinId = displayDouyinId(item);
        const pending = Number(item.pending || 0);
        const downloading = Number(item.downloading || 0);
        const downloaded = Number(item.downloaded || 0);
        const failed = Number(item.failed || 0);
        const total = Number(item.total || 0);
        const active = downloading > 0 || (activeProfileId && Number(item.profile_id) === Number(activeProfileId));
        const stateLabel = downloading > 0 || active ? "下载中" : pending > 0 ? "待下载" : failed > 0 ? "有失败" : "已完成";
        const progress = total > 0 ? Math.round((downloaded / total) * 100) : 0;
        const details = [
          `${total} 总`,
          `${pending} 待`,
          `${downloading} 下`,
          `${downloaded} 完成`,
          failed ? `${failed} 失败` : "",
          item.aweme_count ? `主页 ${formatCompact(item.aweme_count)} 作品` : "",
          douyinId ? `抖音号 ${escapeHtml(douyinId)}` : "",
        ].filter(Boolean).join(" / ");
        return `
          <div class="queue-item ${active ? "active" : ""}">
            <div class="queue-rank">${index + 1}</div>
            <div class="queue-main">
              <div class="queue-title-row">
                <span class="title">${escapeHtml(name || tabLabel)}</span>
                <span class="queue-chip">${tabLabel}</span>
                <span class="queue-chip ${active ? "active" : ""}">${stateLabel}</span>
                <span class="queue-progress">${progress}%</span>
              </div>
              <div class="muted">${details}</div>
            </div>
            <div class="queue-actions">
              <a class="queue-link" href="${escapeHtml(item.url || "")}" target="_blank" rel="noreferrer">主页</a>
              <button data-queue-move="top" data-profile-id="${item.profile_id}" ${index === 0 ? "disabled" : ""}>置顶</button>
              <button data-queue-move="up" data-profile-id="${item.profile_id}" ${index === 0 ? "disabled" : ""}>上移</button>
              <button data-queue-move="down" data-profile-id="${item.profile_id}" ${index === rows.length - 1 ? "disabled" : ""}>下移</button>
            </div>
          </div>
        `;
      })
      .join("") || '<div class="muted">队列为空</div>';
}

function orderQueue(queue) {
  return queue;
}

function moveLocalQueue(profileId, direction) {
  const id = String(profileId);
  const index = localQueueOrder.indexOf(id);
  if (index < 0) return;
  if (direction === "top") {
    localQueueOrder.splice(index, 1);
    localQueueOrder.unshift(id);
    return;
  }
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= localQueueOrder.length) return;
  [localQueueOrder[index], localQueueOrder[target]] = [localQueueOrder[target], localQueueOrder[index]];
}

function displayDouyinId(profile) {
  const uniqueId = String(profile?.unique_id || "").trim();
  const shortId = String(profile?.short_id || "").trim();
  if (uniqueId && uniqueId !== "0") return uniqueId;
  if (shortId && shortId !== "0") return shortId;
  return "";
}

function queueFromProfiles(profiles) {
  const rows = (profiles || [])
    .filter((profile) => Number(profile.pending || 0) > 0 || Number(profile.downloading || 0) > 0)
    .map((profile) => ({
      profile_id: profile.id,
      url: profile.url,
      tab: profile.tab,
      title: profile.title,
      nickname: profile.nickname,
      short_id: profile.short_id,
      unique_id: profile.unique_id,
      aweme_count: profile.aweme_count,
      total: profile.total || 0,
      pending: profile.pending || 0,
      downloading: profile.downloading || 0,
      downloaded: profile.downloaded || 0,
      failed: profile.failed || 0,
    }));
  if (!localQueueOrder.length) return rows;
  const order = new Map(localQueueOrder.map((id, index) => [String(id), index]));
  return rows.sort((a, b) => {
    const left = order.has(String(a.profile_id)) ? order.get(String(a.profile_id)) : Number.MAX_SAFE_INTEGER;
    const right = order.has(String(b.profile_id)) ? order.get(String(b.profile_id)) : Number.MAX_SAFE_INTEGER;
    return left - right;
    });
}

function activeDownloadProfileId(state) {
  const direct = state.download?.profile_id;
  if (direct) {
    lastDownloadProfileId = direct;
    return direct;
  }
  const runningJob = (state.jobs || []).find((job) => job.type === "download" && job.status === "running" && job.profile_id);
  if (runningJob?.profile_id) {
    lastDownloadProfileId = runningJob.profile_id;
    return runningJob.profile_id;
  }
  if (state.download?.active && lastDownloadProfileId) return lastDownloadProfileId;
  if (!state.download?.active) lastDownloadProfileId = null;
  return null;
}

function formatCompact(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "";
  if (number >= 100000000) return `${(number / 100000000).toFixed(number >= 1000000000 ? 0 : 1)}亿`;
  if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)}万`;
  return String(Math.round(number));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function refreshState() {
  const state = await api("/api/state");
  lastState = state;
  const settings = state.settings || {};
  setInputValue("profileUrl", settings.profile_url || "");
  setInputValue("libraryPath", settings.library_output_dir || state.paths?.library || state.paths?.manifest?.replace(/\\download_manifest\.jsonl$/i, "") || "");
  setInputValue("downloadProxy", settings.download_proxy || "");
  setInputValue("scrolls", settings.scrolls || 12000);
  setInputValue("idleRounds", settings.idle_rounds || 160);
  setInputValue("incrementalStopExisting", settings.incremental_stop_existing || 12);
  setInputValue("downloadCycleLimit", settings.download_cycle_limit || state.download?.cycle?.limit || 350);
  setInputValue("downloadCycleCooldownMinutes", settings.download_cycle_cooldown_minutes || state.download?.cycle?.cooldown_minutes || 30);
  const recentDays = settings.profile_refresh_recent_days || 30;
  setInputValue("profileRefreshRecentDays", recentDays);
  if ($("profileRefreshSince") && !dirtyInputs.has("profileRefreshSince") && document.activeElement !== $("profileRefreshSince")) {
    $("profileRefreshSince").value = dateInputDaysAgo(recentDays);
  }
  setInputValue("failureGuardThreshold", settings.failure_guard_threshold || state.download?.failure_guard?.threshold || 10);
  setInputValue("concurrency", settings.concurrency || 8);
  setInputValue("concurrencyNumber", settings.concurrency || 8);
  renderAuth(state.auth || {});
  $("quitApp").hidden = !(state.app?.desktop || state.app?.frozen);
  const profiles = state.profiles || [];
  const hasServerQueue = Array.isArray(state.download_queue);
  const queue = hasServerQueue ? state.download_queue : queueFromProfiles(profiles);
  if (!localQueueOrder.length && queue.length) localQueueOrder = queue.map((item) => String(item.profile_id));
  const activeProfileId = activeDownloadProfileId(state);
  const extractActive = Boolean(state.extract?.active);
  renderProfiles(profiles, state.current_profile || null);
  if (!profileManagerRows.length) {
    profileManagerRows = profiles;
    profileManagerTotal = profiles.length;
  }
  renderProfileManager(profileManagerRows, extractActive);
  if (profileManagerWasExtractActive && !extractActive && location.hash === "#profiles") {
    loadProfileManager({ reset: true }).catch((err) => toast(err.message));
  }
  profileManagerWasExtractActive = extractActive;
  renderDownloadQueue(queue, activeProfileId, hasServerQueue);
  renderStats(statsFromQueue(queue));
  $("concurrencyValue").textContent = $("concurrencyNumber").value || settings.concurrency || 8;
  $("dbPath").textContent = state.paths?.database || "";
  $("extractState").textContent = extractActive ? "采集中" : "采集空闲";
  $("extractStart").hidden = extractActive;
  $("refreshProfiles").hidden = extractActive;
  $("importFollowing").hidden = extractActive;
  $("extractStop").hidden = !extractActive;
  $("profileRefreshStop").hidden = !extractActive;
  const guard = state.download?.failure_guard || {};
  renderDownloadGuard(state);
  renderDownloadCycle(state);
  $("downloadStart").textContent = guard.active
    ? guard.kind === "cycle_limit" ? "提前继续" : "更换 IP 后立即重试"
    : "开始 / 继续";
  if (state.download?.active) {
    const inflight = state.download.inflight ?? state.download.processes ?? 0;
    const watch = state.download.watch_new ? " · 动态监听" : "";
    const port = state.download.sidecar_port ? ` · sidecar:${state.download.sidecar_port}` : "";
    const proxy = state.download.proxy ? ` · 代理:${state.download.proxy}` : "";
    $("downloadState").textContent = `下载中 · ${inflight} 个任务${watch}${port}${proxy}`;
  } else if (guard.active) {
    const minutes = Math.max(1, Math.ceil(Number(guard.remaining_seconds || 0) / 60));
    const proxy = state.download?.proxy ? ` · 代理:${state.download.proxy}` : "";
    const pauseLabel = guard.kind === "cycle_limit" ? "主动休息" : "下载保护暂停";
    $("downloadState").textContent = `${pauseLabel} · ${minutes} 分钟后自动重试${proxy}`;
  } else {
    const proxy = state.download?.proxy ? ` · 代理:${state.download.proxy}` : "";
    $("downloadState").textContent = state.download?.sidecar_port
      ? `下载空闲 · sidecar:${state.download.sidecar_port}${proxy}`
      : `下载空闲${proxy}`;
  }
  renderJobs(state.jobs || []);
  renderEvents(state.events || []);
}

async function refreshLinks() {
  return loadLinks({ reset: true });
}

function renderLinksTable() {
  $("linksBody").innerHTML =
    linksRows
      .map(
        (link) => `
          <tr>
            <td>${link.aweme_id}</td>
            <td class="preview-cell">${
              link.cover_url
                ? `<img class="thumb" src="${escapeHtml(link.cover_url)}" alt="" loading="lazy" />`
                : `<span class="muted">${escapeHtml(link.preview_path ? "本地" : "")}</span>`
            }</td>
            <td class="desc-cell">
              <div>${escapeHtml(link.desc || "")}</div>
              <div class="muted">${escapeHtml(link.create_time ? new Date(Number(link.create_time) * 1000).toLocaleDateString() : "")}</div>
            </td>
            <td>${link.kind}</td>
            <td><span class="badge ${link.status}">${statusLabel(link.status)}</span></td>
            <td class="time-cell">${renderLinkTime(link)}</td>
            <td>${link.attempts}</td>
            <td class="author">
              <div>${escapeHtml(link.author_nickname || "")}</div>
              <div class="muted">${escapeHtml(link.author_sec_uid || link.author_uid || "")}</div>
            </td>
            <td class="url"><a href="${link.url}" target="_blank">${link.url}</a></td>
            <td class="error">${escapeHtml(link.last_error || "")}</td>
          </tr>
        `
      )
      .join("") || '<tr><td colspan="10" class="muted">没有链接</td></tr>';
  const loaded = Math.min(linksRows.length, linksTotal || linksRows.length);
  $("linksPager").textContent = `已加载 ${loaded} / ${linksTotal || 0}`;
  $("loadMoreLinks").hidden = loaded >= linksTotal;
  $("loadMoreLinks").disabled = linksLoading;
  $("loadMoreLinks").textContent = linksLoading ? "加载中" : "加载更多";
}

async function loadLinks(options = {}) {
  if (linksLoading) return;
  const reset = options.reset !== false && !options.append;
  const preserve = Boolean(options.preserve);
  const offset = options.append ? linksRows.length : 0;
  const limit = preserve ? Math.max(LINKS_PAGE_SIZE, linksRows.length || LINKS_PAGE_SIZE) : LINKS_PAGE_SIZE;
  const params = new URLSearchParams();
  if (currentFilter) params.set("status", currentFilter);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (reset && !preserve) {
    linksRows = [];
    linksTotal = 0;
  }
  linksLoading = true;
  renderLinksTable();
  try {
    const data = await api(`/api/links?${params.toString()}`);
    linksTotal = Number(data.total || 0);
    linksRows = options.append ? [...linksRows, ...(data.links || [])] : data.links || [];
    renderLinksTable();
  } finally {
    linksLoading = false;
    renderLinksTable();
  }
}

async function loadMoreLinks() {
  if (linksRows.length >= linksTotal) return;
  return loadLinks({ append: true, reset: false });
}

async function refreshLoadedLinks() {
  if (linksRows.length > LINKS_PAGE_SIZE) return;
  return loadLinks({ preserve: true });
}

function libraryCard(item) {
  const cover = item.cover_url
    ? `<img src="${escapeHtml(item.cover_url)}" alt="" loading="lazy" />`
    : `<div class="library-placeholder"><span>${item.media_type === "gallery" ? "▦" : "▶"}</span></div>`;
  const typeLabel = item.media_type === "gallery" ? `${item.asset_count} 张/段` : "视频";
  const timestamp = item.create_time ? new Date(Number(item.create_time) * 1000).toLocaleDateString() : "";
  return `
    <article class="library-card" data-library-open="${item.id}" tabindex="0">
      <div class="library-cover">
        ${cover}
        <span class="library-type">${escapeHtml(typeLabel)}</span>
        <span class="library-play">${item.media_type === "gallery" ? "查看" : "播放"}</span>
      </div>
      <div class="library-card-body">
        <strong title="${escapeHtml(item.title || "")}">${escapeHtml(item.title || item.aweme_id)}</strong>
        <div class="library-card-meta">
          <span>${escapeHtml(item.author || "未知作者")}</span>
          <span>${escapeHtml(timestamp)}</span>
        </div>
        <button data-library-folder="${item.id}">打开目录</button>
      </div>
    </article>
  `;
}

function renderLibrary() {
  const grid = $("libraryGrid");
  grid.innerHTML = libraryRows.map(libraryCard).join("") || `
    <div class="library-empty">
      <strong>${libraryLoading ? "正在读取…" : "还没有可显示的本地作品"}</strong>
      <span>下载完成并写入 manifest 后，会自动出现在这里。</span>
    </div>
  `;
  $("librarySummary").textContent = `已显示 ${libraryRows.length} / ${libraryTotal} 个本地作品`;
  $("libraryLoadMore").hidden = !libraryHasMore;
  $("libraryLoadMore").disabled = libraryLoading;
  $("libraryLoadMore").textContent = libraryLoading ? "加载中" : "加载更多";
}

async function loadLibrary(options = {}) {
  if (libraryLoading) return;
  const append = Boolean(options.append);
  const params = new URLSearchParams({
    limit: String(LIBRARY_PAGE_SIZE),
    offset: String(append ? libraryOffset : 0),
  });
  const search = $("librarySearch").value.trim();
  if (search) params.set("q", search);
  if (!append) {
    libraryRows = [];
    libraryTotal = 0;
    libraryOffset = 0;
    libraryHasMore = false;
  }
  libraryLoading = true;
  renderLibrary();
  try {
    const result = await api(`/api/library?${params.toString()}`);
    libraryTotal = Number(result.total || 0);
    libraryRows = append ? [...libraryRows, ...(result.items || [])] : result.items || [];
    libraryOffset = Number(result.next_offset || 0);
    libraryHasMore = Boolean(result.has_more);
  } finally {
    libraryLoading = false;
    renderLibrary();
  }
}

function showLibraryPage() {
  setActivePage("library");
  loadLibrary().catch((err) => toast(err.message));
}

function openLibraryPlayer(item) {
  if (!item?.id) return;
  window.location.assign(`/short-videos/${encodeURIComponent(item.id)}`);
}

async function quitApplication() {
  const busy = Boolean(lastState?.extract?.active || lastState?.download?.active);
  if (busy && !window.confirm("采集或下载仍在进行。退出后未完成任务会在下次启动时继续，确定退出吗？")) return;
  await post("/api/app/quit");
  document.body.innerHTML = `
    <main class="quit-screen">
      <section>
        <div class="eyebrow">Douyin Tool</div>
        <h1>下载管理器已退出</h1>
        <p>后台服务已经停止，现在可以关闭这个浏览器标签页。</p>
      </section>
    </main>
  `;
  window.setTimeout(() => window.close(), 250);
}

async function saveSettings() {
  const payload = snapshotSettings();
  await post("/api/settings", payload);
  Object.keys(payload).forEach((key) => {
    if (key === "profile_url") markInputClean("profileUrl");
    if (key === "library_output_dir") markInputClean("libraryPath");
    if (key === "download_proxy") markInputClean("downloadProxy");
    if (key === "scrolls") markInputClean("scrolls");
    if (key === "idle_rounds") markInputClean("idleRounds");
    if (key === "incremental_stop_existing") markInputClean("incrementalStopExisting");
    if (key === "failure_guard_threshold") markInputClean("failureGuardThreshold");
    if (key === "concurrency") {
      markInputClean("concurrency");
      markInputClean("concurrencyNumber");
    }
  });
  toast("设置已保存");
  refreshLinks().catch(() => {});
  return payload;
}

function saveSettingsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveSettings().catch((err) => toast(err.message));
  }, 450);
}

function setConcurrency(value, shouldSave = true) {
  const parsed = Math.max(1, Math.min(24, Number(value) || 1));
  $("concurrency").value = String(parsed);
  $("concurrencyNumber").value = String(parsed);
  $("concurrencyValue").textContent = String(parsed);
  if (shouldSave) saveSettingsSoon();
}

async function startExtract() {
  const payload = snapshotSettings();
  await post("/api/settings", payload);
  markInputClean("profileUrl");
  const result = await post("/api/extract/start", {
    url: payload.profile_url,
    profile_tab: "auto",
    max: $("maxItems").value || 0,
    scrolls: payload.scrolls,
    idle_rounds: payload.idle_rounds,
    incremental_stop_existing: payload.incremental_stop_existing || 12,
  });
  $("extractStart").hidden = true;
  $("extractStop").hidden = false;
  toast(`采集任务已启动 #${result.job_id}`);
}

async function refreshProfiles(profileIds = []) {
  const payload = snapshotSettings();
  await post("/api/settings", payload);
  const result = await post("/api/profiles/refresh", {
    max_profiles: 0,
    profile_ids: profileIds,
    since_date: profileIds.length ? "" : $("profileRefreshSince").value,
    max: $("maxItems").value || 0,
    scrolls: payload.scrolls,
    idle_rounds: payload.idle_rounds,
    incremental_stop_existing: payload.incremental_stop_existing || 12,
  });
  $("extractStart").hidden = true;
  $("refreshProfiles").hidden = true;
  $("extractStop").hidden = false;
  $("profileRefreshStop").hidden = false;
  toast(profileIds.length ? `主页采集已启动 #${result.job_id}` : `一键采集已启动 #${result.job_id}`);
}

async function importFollowing() {
  const result = await post("/api/profiles/following/import", {
    max: 0,
    scrolls: 1200,
    idle_rounds: 16,
  });
  $("importFollowing").hidden = true;
  $("refreshProfiles").hidden = true;
  $("profileRefreshStop").hidden = false;
  toast(`我的关注提取已启动 #${result.job_id}`);
}

async function stopExtractJob() {
  await post("/api/extract/stop");
  $("extractStart").hidden = false;
  $("refreshProfiles").hidden = false;
  $("extractStop").hidden = true;
  $("profileRefreshStop").hidden = true;
  toast("正在停止采集");
}

async function startDownload(retryFailed = false) {
  await saveSettings();
  const result = await post("/api/download/start", {
    concurrency: $("concurrency").value,
    retry_failed: retryFailed,
    limit: 0,
    watch_new: $("watchQueue").checked,
  });
  const mode = result.watch_new ? "动态监听" : `本次 ${result.run_total} 条`;
  toast(`下载任务已启动：${mode}，待处理 ${result.pending} 条`);
}

async function syncManifest() {
  await saveSettings();
  const result = await post("/api/manifest/import", {
    manifest_path: "",
  });
  toast(`manifest 已同步：${result.unique} 条，新 ${result.inserted}，更新 ${result.updated}，文件 ${result.files || 0}`);
  refreshState();
  refreshLinks();
}

async function resetFailed(scope = "current") {
  const result = await post("/api/links/reset-failed", { scope });
  const label = scope === "all" ? "全部主页" : "当前主页";
  toast(`${label}失败已转为待下载：${result.changed || 0} 条`);
  refreshState().catch(() => {});
  refreshLinks().catch(() => {});
}

async function backfillGalleryMusic() {
  const preview = await post("/api/links/backfill-gallery-music", { scope: "all", dry_run: true });
  const eligible = Number(preview.eligible || 0);
  if (!eligible) {
    toast("没有需要补齐背景音乐的图集");
    return;
  }
  const ok = window.confirm(`检测到 ${eligible} 个已下载但缺少背景音乐的图集。确认重新加入下载队列吗？完成后会同步写入下载库和 FanHao。`);
  if (!ok) return;
  const result = await post("/api/links/backfill-gallery-music", { scope: "all" });
  toast(`图集音乐补齐任务已加入队列：${result.changed || 0} 条`);
  refreshState().catch(() => {});
  refreshLinks().catch(() => {});
}

async function deleteEmptyFailed() {
  const ok = window.confirm("删除全库里标题、作者、封面都为空的失败链接？删除后“失败转待下载”不会再重试这些记录。");
  if (!ok) return;
  const result = await post("/api/links/delete-empty-failed", { scope: "all" });
  toast(`空壳失败已删除：${result.changed || 0} 条`);
  linksRows = [];
  linksTotal = 0;
  refreshState().catch(() => {});
  refreshLinks().catch(() => {});
}

async function deleteAllFailed() {
  const ok = window.confirm("确定删除全库所有失败链接吗？有标题、作者、封面的失败记录也会一起从数据库删除，后续不会再重试。");
  if (!ok) return;
  const result = await post("/api/links/delete-failed", { scope: "all" });
  toast(`所有失败已删除：${result.changed || 0} 条`);
  linksRows = [];
  linksTotal = 0;
  refreshState().catch(() => {});
  refreshLinks().catch(() => {});
}

async function sortQueueByPending() {
  const result = await post("/api/download-queue/sort", { mode: "pending_asc" });
  toast(`队列已按待下载数量排序：${result.changed || 0} 个作者`);
  refreshState().catch(() => {});
}

function setActivePage(page) {
  const target = page || "home";
  const panels = Array.from(document.querySelectorAll("[data-page-panel]"));
  const buttons = Array.from(document.querySelectorAll("[data-page-target]"));
  const exists = panels.some((panel) => panel.dataset.pagePanel === target);
  const activePage = exists ? target : "home";
  panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.pagePanel === activePage));
  buttons.forEach((button) => button.classList.toggle("active", button.dataset.pageTarget === activePage));
  if (location.hash !== `#${activePage}`) {
    history.replaceState(null, "", `#${activePage}`);
  }
}

function bindPageTabs() {
  document.querySelectorAll("[data-page-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const page = button.dataset.pageTarget || "home";
      setActivePage(page);
      if (page === "links") refreshLinks().catch((err) => toast(err.message));
      if (page === "library") loadLibrary().catch((err) => toast(err.message));
      if (page === "profiles") loadProfileManager({ reset: true }).catch((err) => toast(err.message));
      if (page === "settings") refreshAuthStatus().catch((err) => toast(err.message));
    });
  });
  window.addEventListener("hashchange", () => setActivePage(location.hash.replace(/^#/, "") || "home"));
  const initialPage = location.hash.replace(/^#/, "") || "home";
  setActivePage(initialPage);
  if (initialPage === "library") loadLibrary().catch((err) => toast(err.message));
  if (initialPage === "profiles") loadProfileManager({ reset: true }).catch((err) => toast(err.message));
}

function bind() {
  bindPageTabs();
  $("openLibraryQuick").addEventListener("click", showLibraryPage);
  $("openLibraryHome").addEventListener("click", showLibraryPage);
  $("quitApp").addEventListener("click", () => quitApplication().catch((err) => toast(err.message)));
  $("libraryRefresh").addEventListener("click", () => loadLibrary().catch((err) => toast(err.message)));
  $("libraryLoadMore").addEventListener("click", () => loadLibrary({ append: true }).catch((err) => toast(err.message)));
  $("librarySearch").addEventListener("input", () => {
    clearTimeout(librarySearchTimer);
    librarySearchTimer = setTimeout(() => loadLibrary().catch((err) => toast(err.message)), 250);
  });
  $("libraryGrid").addEventListener("click", (event) => {
    const folder = event.target.closest("button[data-library-folder]");
    if (folder) {
      event.stopPropagation();
      post("/api/library/open-folder", { id: Number(folder.dataset.libraryFolder || 0) })
        .then((result) => toast(result.message))
        .catch((err) => toast(err.message));
      return;
    }
    const card = event.target.closest("[data-library-open]");
    if (!card) return;
    const item = libraryRows.find((row) => Number(row.id) === Number(card.dataset.libraryOpen));
    if (item) openLibraryPlayer(item);
  });
  $("libraryGrid").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest("[data-library-open]");
    if (!card) return;
    event.preventDefault();
    const item = libraryRows.find((row) => Number(row.id) === Number(card.dataset.libraryOpen));
    if (item) openLibraryPlayer(item);
  });
  [
    "profileUrl",
    "libraryPath",
    "downloadProxy",
    "scrolls",
    "idleRounds",
    "incrementalStopExisting",
    "profileRefreshRecentDays",
    "profileRefreshSince",
    "downloadCycleLimit",
    "downloadCycleCooldownMinutes",
    "failureGuardThreshold",
    "concurrency",
    "concurrencyNumber",
  ].forEach((id) => {
    const node = $(id);
    if (!node) return;
    node.addEventListener("input", () => dirtyInputs.add(id));
  });
  $("concurrency").addEventListener("input", () => {
    setConcurrency($("concurrency").value);
  });
  $("concurrencyNumber").addEventListener("input", () => {
    setConcurrency($("concurrencyNumber").value);
  });
  $("saveSettings").addEventListener("click", () => saveSettings().catch((err) => toast(err.message)));
  $("authLoginStart").addEventListener("click", () => startAuthLogin().catch((err) => toast(err.message)));
  $("authImportCookie").addEventListener("click", () => $("authCookieFile").click());
  $("authCookieFile").addEventListener("change", () => {
    const file = $("authCookieFile").files?.[0];
    importAuthCookie(file)
      .catch((err) => toast(err.message))
      .finally(() => {
        $("authCookieFile").value = "";
      });
  });
  $("authCheck").addEventListener("click", () =>
    refreshAuthStatus().then((auth) => toast(auth.message || "登录状态已刷新")).catch((err) => toast(err.message))
  );
  $("authOpenFolder").addEventListener("click", () =>
    post("/api/auth/cookie/open-folder").then((result) => toast(result.message)).catch((err) => toast(err.message))
  );
  $("authClear").addEventListener("click", () => clearAuthCookie().catch((err) => toast(err.message)));
  $("profileSelect").addEventListener("change", () => {
    const value = $("profileSelect").value;
    if (!value) return;
    $("profileUrl").value = value;
    markInputClean("profileUrl");
    saveSettings()
      .then(() => {
        refreshState();
        refreshLinks();
      })
      .catch((err) => toast(err.message));
  });
  $("extractStart").addEventListener("click", () => startExtract().catch((err) => toast(err.message)));
  $("extractStop").addEventListener("click", () => stopExtractJob().catch((err) => toast(err.message)));
  $("profileRefreshStop").addEventListener("click", () => stopExtractJob().catch((err) => toast(err.message)));
  $("syncManifest").addEventListener("click", () => syncManifest().catch((err) => toast(err.message)));
  $("refreshProfiles").addEventListener("click", () => refreshProfiles([]).catch((err) => toast(err.message)));
  $("importFollowing").addEventListener("click", () => importFollowing().catch((err) => toast(err.message)));
  $("profileRefreshRecentDays").addEventListener("input", () => {
    $("profileRefreshSince").value = dateInputDaysAgo($("profileRefreshRecentDays").value);
    dirtyInputs.add("profileRefreshSince");
    loadProfileManager({ reset: true }).catch((err) => toast(err.message));
  });
  $("profileRefreshSince").addEventListener("input", () => {
    loadProfileManager({ reset: true }).catch((err) => toast(err.message));
  });
  $("profileManagerSearch").addEventListener("input", () => {
    clearTimeout(profileSearchTimer);
    profileSearchTimer = setTimeout(() => loadProfileManager({ reset: true }).catch((err) => toast(err.message)), 250);
  });
  $("profileManagerSort").addEventListener("change", () => {
    loadProfileManager({ reset: true }).catch((err) => toast(err.message));
  });
  $("profileManagerScope").addEventListener("change", () => {
    loadProfileManager({ reset: true }).catch((err) => toast(err.message));
  });
  $("profileManagerList").addEventListener("click", (event) => {
    const loadMore = event.target.closest("button[data-profile-load-more]");
    if (loadMore) {
      loadProfileManager({ reset: false }).catch((err) => toast(err.message));
      return;
    }
    const button = event.target.closest("button[data-profile-refresh]");
    if (!button) return;
    const profileId = Number(button.dataset.profileRefresh || 0);
    if (!profileId) return;
    refreshProfiles([profileId]).catch((err) => toast(err.message));
  });
  $("downloadStart").addEventListener("click", () => startDownload(false).catch((err) => toast(err.message)));
  $("downloadStop").addEventListener("click", () =>
    post("/api/download/stop").then(() => toast("正在停止下载")).catch((err) => toast(err.message))
  );
  $("resetFailedCurrent").addEventListener("click", () => resetFailed("current").catch((err) => toast(err.message)));
  $("resetFailedAll").addEventListener("click", () => resetFailed("all").catch((err) => toast(err.message)));
  $("backfillGalleryMusic").addEventListener("click", () => backfillGalleryMusic().catch((err) => toast(err.message)));
  $("sortQueueByPending").addEventListener("click", () => sortQueueByPending().catch((err) => toast(err.message)));
  $("deleteEmptyFailed").addEventListener("click", () => deleteEmptyFailed().catch((err) => toast(err.message)));
  $("deleteAllFailed").addEventListener("click", () => deleteAllFailed().catch((err) => toast(err.message)));
  $("loadMoreLinks").addEventListener("click", () => loadMoreLinks().catch((err) => toast(err.message)));
  document.querySelector(".table-wrap")?.addEventListener("scroll", (event) => {
    const node = event.currentTarget;
    if (node.scrollTop + node.clientHeight >= node.scrollHeight - 120) {
      loadMoreLinks().catch((err) => toast(err.message));
    }
  });
  $("downloadQueue").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const profileId = button.dataset.profileId;
    if (!profileId) return;
    if (button.dataset.queueMove) {
      if (!Array.isArray(lastState?.download_queue)) {
        moveLocalQueue(profileId, button.dataset.queueMove);
        refreshState().catch((err) => toast(err.message));
        return;
      }
      post("/api/download-queue/move", { profile_id: profileId, direction: button.dataset.queueMove })
        .then(() => refreshState())
        .catch((err) => toast(err.message));
      return;
    }
  });
  $("importLinks").addEventListener("click", () =>
    post("/api/links/import", {
      profile_url: $("profileUrl").value.trim() || "manual",
      profile_tab: "auto",
      text: $("manualLinks").value,
    })
      .then((data) => {
        toast(`导入 ${data.count} 条，新 ${data.inserted} 条`);
        $("manualLinks").value = "";
        refreshLinks();
        refreshState();
      })
      .catch((err) => toast(err.message))
  );
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-filter]").forEach((node) => node.classList.remove("active"));
      button.classList.add("active");
      currentFilter = button.dataset.filter || "";
      linksRows = [];
      linksTotal = 0;
      refreshLinks().catch((err) => toast(err.message));
    });
  });
}

bind();
refreshState().catch((err) => toast(err.message));
refreshLinks().catch((err) => toast(err.message));
setInterval(() => refreshState().catch(() => {}), 5000);
setInterval(() => refreshLoadedLinks().catch(() => {}), 10000);
