import { api, post } from "../core/api.js";
import { $, escapeHtml, safeUrl, toast } from "../core/dom.js";
import { displayDouyinId, formatCompact, formatDateTime, profileWorkDate } from "../core/format.js";

const PROFILE_AUTO_LOAD_DISTANCE = 320;
const PROFILE_PAGE_SIZE = 40;
const PROFILE_AVATAR_ROOT_MARGIN = "180px 0px";

export function createProfilesFeature(options) {
  const settings = options.settings;
  const refreshState = options.refreshState;
  const refreshLinks = options.refreshLinks;
  let searchTimer = null;
  let rows = [];
  let total = 0;
  let eligibleCount = null;
  let deferredCount = null;
  let fullScanRequiredCount = null;
  let loading = false;
  let loadMoreCheckScheduled = false;
  let avatarObserver = null;
  let wasExtractActive = false;
  let extractActive = false;
  let deepLinkedProfile = "";

  function formatRefreshInterval(value) {
    const seconds = Math.max(0, Number(value) || 0);
    if (!seconds) return "";
    if (seconds >= 86400) {
      const days = seconds / 86400;
      return `${days >= 10 ? Math.round(days) : Number(days.toFixed(1))} 天`;
    }
    const hours = seconds / 3600;
    return `${hours >= 10 ? Math.round(hours) : Number(hours.toFixed(1))} 小时`;
  }

  function needsFullScan(profile) {
    if (String(profile.tab || "post") !== "post") return false;
    if (Number(profile.full_scan_required || 0) === 1) return true;
    if (Number(profile.has_deleted_works || 0) === 1) return false;
    const localCount = Math.max(0, Number(profile.total || 0));
    const observedCount = Number(profile.aweme_count);
    if (!localCount || !Number.isFinite(observedCount) || observedCount < 0) return false;
    const gap = localCount - observedCount;
    return gap >= 10 && gap / localCount >= 0.1;
  }

  function syncProfileAvatarLoading(node) {
    avatarObserver?.disconnect();
    avatarObserver = null;
    const avatars = Array.from(node.querySelectorAll("img[data-profile-avatar-src]"));
    if (!avatars.length) return;

    const loadAvatar = (avatar) => {
      const source = String(avatar.dataset.profileAvatarSrc || "").trim();
      if (!source) return;
      avatar.src = source;
      delete avatar.dataset.profileAvatarSrc;
    };
    if (!("IntersectionObserver" in window)) {
      avatars.forEach(loadAvatar);
      return;
    }
    avatarObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        loadAvatar(entry.target);
        avatarObserver?.unobserve(entry.target);
      });
    }, { root: node, rootMargin: PROFILE_AVATAR_ROOT_MARGIN });
    avatars.forEach((avatar) => avatarObserver.observe(avatar));
  }

  function renderManager(profiles, isExtractActive = false) {
    const node = $("profileManagerList");
    if (!node) return;
    const query = String($("profileManagerSearch")?.value || "").trim().toLowerCase();
    const sortMode = $("profileManagerSort")?.value || "latest_desc";
    const scope = $("profileManagerScope")?.value || "collected";
    const deletedWorks = $("profileManagerDeletedWorks")?.value || "all";
    const allRows = Array.isArray(profiles) ? profiles : [];
    const filteredRows = allRows.filter((profile) => {
      const inScope = scope === "all"
        || (scope === "following" && (Number(profile.is_following || 0) === 1 || Number(profile.is_self || 0) === 1))
        || (scope === "collected" && (Number(profile.total || 0) > 0 || Number(profile.is_self || 0) === 1));
      if (!inScope) return false;
      if (deletedWorks === "flagged" && Number(profile.has_deleted_works || 0) !== 1) return false;
      if (deletedWorks === "pending" && !needsFullScan(profile)) return false;
      if (!query) return true;
      return [profile.nickname, profile.title, profile.unique_id, profile.short_id, profile.sec_uid]
        .some((value) => String(value || "").toLowerCase().includes(query));
    });
    const numericSort = {
      latest_desc: (profile) => Number(profile.latest_work_create_time || 0),
      works_desc: (profile) => Number(profile.aweme_count ?? profile.total ?? 0),
      likes_desc: (profile) => Number(profile.total_favorited || 0),
      followers_desc: (profile) => Number(profile.follower_count || 0),
    };
    if (sortMode === "last_refresh_asc") {
      filteredRows.sort((a, b) => Number(b.is_self || 0) - Number(a.is_self || 0) || String(a.last_extracted_at || "").localeCompare(String(b.last_extracted_at || "")) || Number(a.id) - Number(b.id));
    } else {
      const valueOf = numericSort[sortMode] || numericSort.latest_desc;
      filteredRows.sort((a, b) => Number(b.is_self || 0) - Number(a.is_self || 0) || valueOf(b) - valueOf(a) || Number(b.id) - Number(a.id));
    }

    const localCandidates = allRows.filter(
      (profile) => Number(profile.total || 0) > 0 || Number(profile.is_self || 0) === 1
    );
    const localEligibleCount = localCandidates.filter(
      (profile) => Number(profile.refresh_due || 0) === 1 || needsFullScan(profile)
    ).length;
    const localFullScanCount = localCandidates.filter((profile) => needsFullScan(profile)).length;
    const currentEligibleCount = eligibleCount === null ? localEligibleCount : eligibleCount;
    const currentDeferredCount = deferredCount === null
      ? Math.max(0, localCandidates.length - localEligibleCount)
      : deferredCount;
    const currentFullScanCount = fullScanRequiredCount === null ? localFullScanCount : fullScanRequiredCount;
    const confirmPendingButton = $("confirmPendingProfiles");
    if (confirmPendingButton) {
      confirmPendingButton.textContent = currentFullScanCount > 0
        ? `一键确认待全量（${currentFullScanCount}）`
        : "暂无待确认";
      confirmPendingButton.disabled = isExtractActive || currentFullScanCount <= 0;
      confirmPendingButton.title = currentFullScanCount > 0
        ? `只依次全量扫描 ${currentFullScanCount} 个待确认主页，不采集其他主页`
        : "当前没有待全量确认的主页";
    }
    const visibleRows = filteredRows;
    const totalRows = deletedWorks === "pending" ? filteredRows.length : Math.max(total, filteredRows.length);
    $("profileManagerSummary").textContent = `${totalRows} 个主页 · 已加载 ${visibleRows.length} 个 · 智能判定本次采集 ${currentEligibleCount} 个（其中待全量 ${currentFullScanCount} 个），暂缓 ${currentDeferredCount} 个`;
    node.innerHTML = visibleRows.map((profile) => {
      const name = String(profile.nickname || profile.title || `主页 #${profile.id}`).trim();
      const douyinId = displayDouyinId(profile) || "-";
      const latestWork = profileWorkDate(profile);
      const lastExtracted = formatDateTime(profile.last_extracted_at);
      const fullScanPending = needsFullScan(profile);
      const refreshDue = Number(profile.refresh_due || 0) === 1 || fullScanPending;
      const refreshAt = formatDateTime(profile.refresh_due_at);
      const refreshInterval = formatRefreshInterval(profile.refresh_interval_seconds);
      const cadence = formatRefreshInterval(profile.refresh_cadence_seconds);
      const tabLabel = profile.tab === "like" ? "我的喜欢" : "作者作品";
      const sourceLabel = Number(profile.is_self || 0) === 1 ? "本人" : Number(profile.is_following || 0) === 1 ? "已关注" : "";
      const deletedWorksBadge = Number(profile.has_deleted_works || 0) === 1
        ? ' <span class="profile-manager-badge is-deleted-works" title="已经过一次完整主页扫描确认">主页少作品</span>'
        : "";
      const fullScanReason = String(profile.full_scan_reason || "主页作品数明显少于本地入库，下一次智能采集将执行一次全量确认").trim();
      const fullScanBadge = fullScanPending
        ? ` <span class="profile-manager-badge is-full-scan-required" title="${escapeHtml(fullScanReason)}">待全量确认</span>`
        : "";
      const refreshBadge = profile.tab === "like" || fullScanPending
        ? ""
        : ` <span class="profile-manager-badge ${refreshDue ? "is-refresh-due" : "is-refresh-waiting"}">${refreshDue ? "已到期" : "暂缓"}</span>`;
      const refreshTitle = fullScanPending
        ? fullScanReason
        : profile.refresh_basis === "posting_frequency"
        ? `最近两条作品间隔 ${cadence || "未知"}；智能检查间隔 ${refreshInterval || "未知"}`
        : profile.refresh_basis === "insufficient_history"
          ? "作品时间样本不足，按 1 天兜底"
          : profile.refresh_basis === "never_collected"
            ? "尚未采集，立即执行"
            : "喜欢列表在每次批量采集时检查";
      const refreshMeta = [
        lastExtracted ? `上次 ${lastExtracted}` : "尚未采集",
        cadence ? `发作品约 ${cadence}` : "",
      ].filter(Boolean).join(" · ");
      const observedCount = profile.aweme_count ?? profile.total ?? 0;
      const previousCount = profile.previous_collection_aweme_count;
      const countMeta = [
        `入库 ${formatCompact(profile.total || 0)}`,
        previousCount === null || previousCount === undefined ? "" : `上次 ${formatCompact(previousCount)}`,
      ].filter(Boolean).join(" · ");
      const secUid = String(profile.sec_uid || "").trim();
      const localAuthorUrl = secUid
        ? `http://127.0.0.1:29998/short-videos/authors/${encodeURIComponent(secUid)}`
        : "";
      const avatar = profile.avatar_url
        ? `<img class="profile-manager-avatar" data-profile-avatar-src="${safeUrl(profile.avatar_url)}" alt="" loading="lazy" decoding="async" />`
        : '<div class="profile-manager-avatar placeholder"></div>';
      return `
        <div class="profile-manager-row${fullScanPending ? " is-full-scan-required" : ""}">
          <div class="profile-manager-identity">
            ${avatar}
            <div>
              <div class="profile-manager-name">${escapeHtml(name)}${sourceLabel ? ` <span class="profile-manager-badge">${escapeHtml(sourceLabel)}</span>` : ""}${fullScanBadge}${deletedWorksBadge}${refreshBadge}</div>
              <div class="muted">${escapeHtml(tabLabel)} · 抖音号 ${escapeHtml(douyinId)}</div>
            </div>
          </div>
          <div class="profile-manager-metric"><span>作品</span><strong>${formatCompact(observedCount)}</strong><small>${escapeHtml(countMeta)}</small></div>
          <div class="profile-manager-metric"><span>粉丝</span><strong>${formatCompact(profile.follower_count || 0)}</strong></div>
          <div class="profile-manager-metric"><span>获赞</span><strong>${formatCompact(profile.total_favorited || 0)}</strong></div>
          <div class="profile-manager-date"><span>最新作品</span><strong>${escapeHtml(latestWork ? latestWork.slice(0, 10) : "暂无日期")}</strong></div>
          <div class="profile-manager-date" title="${escapeHtml(refreshTitle)}"><span>智能重抓</span><strong>${escapeHtml(fullScanPending ? "下次全量确认" : refreshDue ? "现在可采集" : refreshAt || "等待判断")}</strong><small>${escapeHtml(refreshMeta)}</small></div>
          <div class="profile-manager-row-actions">
            <span class="profile-manager-page-links" role="group" aria-label="${escapeHtml(name)}的主页">
              ${localAuthorUrl ? `<a class="queue-link is-local" href="${safeUrl(localAuthorUrl)}" target="_blank" rel="noreferrer" title="打开 FanHao 本地短视频作者主页">本地</a>` : ""}
              <a class="queue-link" href="${safeUrl(profile.url)}" target="_blank" rel="noreferrer" title="打开抖音主页">抖音</a>
            </span>
            <button data-profile-refresh="${escapeHtml(profile.id || "")}" ${isExtractActive ? "disabled" : ""}>${Number(profile.is_self || 0) === 1 ? "采集喜欢" : fullScanPending ? "按计划全量" : "快速采集"}</button>
            ${profile.tab === "post" ? `<button data-profile-full-refresh="${escapeHtml(profile.id || "")}" title="遍历该作者当前全部主页作品，并标记主页已删除作品" ${isExtractActive ? "disabled" : ""}>立即全量</button>` : ""}
            <button class="danger" data-profile-delete="${escapeHtml(profile.id || "")}" ${isExtractActive ? "disabled" : ""}>删除</button>
          </div>
        </div>
      `;
    }).join("") + (totalRows > visibleRows.length
      ? `<div class="profile-manager-load-more"><button data-profile-load-more ${loading ? "disabled" : ""}>${loading ? "加载中" : `显示更多（剩余 ${totalRows - visibleRows.length}）`}</button></div>`
      : "") || '<div class="muted profile-manager-empty">没有符合条件的主页</div>';
    syncProfileAvatarLoading(node);
  }

  async function load(options = {}) {
    if (loading) return;
    const reset = options.reset !== false;
    loading = true;
    try {
      const differenceFilter = $("profileManagerDeletedWorks")?.value || "all";
      const params = new URLSearchParams({
        scope: $("profileManagerScope")?.value || "collected",
        q: String($("profileManagerSearch")?.value || "").trim(),
        sort: $("profileManagerSort")?.value || "latest_desc",
        deleted_works: differenceFilter === "pending" ? "all" : differenceFilter,
        limit: differenceFilter === "pending" ? "500" : String(PROFILE_PAGE_SIZE),
        offset: String(reset ? 0 : rows.length),
      });
      const data = await api(`/api/profiles?${params.toString()}`);
      const incoming = Array.isArray(data.profiles) ? data.profiles : [];
      if (reset) {
        rows = incoming;
      } else {
        const known = new Set(rows.map((profile) => Number(profile.id)));
        rows.push(...incoming.filter((profile) => !known.has(Number(profile.id))));
      }
      total = Number(data.total || 0);
      eligibleCount = Number(data.eligible_count || 0);
      deferredCount = Number(data.deferred_count || 0);
      fullScanRequiredCount = Object.prototype.hasOwnProperty.call(data, "full_scan_required_count")
        ? Number(data.full_scan_required_count || 0)
        : null;
    } finally {
      loading = false;
      renderManager(rows, extractActive);
    }
  }

  function scheduleLoadMoreIfNeeded() {
    if (loadMoreCheckScheduled) return;
    loadMoreCheckScheduled = true;
    window.requestAnimationFrame(() => {
      loadMoreCheckScheduled = false;
      const list = $("profileManagerList");
      const differenceFilter = $("profileManagerDeletedWorks")?.value || "all";
      if (!list || location.hash !== "#profiles" || differenceFilter === "pending") return;
      if (loading || rows.length >= total) return;
      const remainingScroll = list.scrollHeight - list.scrollTop - list.clientHeight;
      if (remainingScroll > PROFILE_AUTO_LOAD_DISTANCE) return;
      load({ reset: false }).catch((err) => toast(err.message));
    });
  }

  async function startExtract() {
    const payload = settings.snapshot();
    await settings.persist(payload);
    settings.markClean("profileUrl");
    const result = await post("/api/extract/start", {
      url: payload.profile_url,
      profile_tab: "auto",
      max: 0,
      scrolls: payload.scrolls,
      idle_rounds: payload.idle_rounds,
      incremental_stop_existing: payload.incremental_stop_existing || 12,
    });
    $("extractStart").hidden = true;
    $("extractStop").hidden = false;
    toast(`采集任务已启动 #${result.job_id}`);
  }

  async function refreshProfiles(profileIds = [], options = {}) {
    const fullScan = options.fullScan === true;
    const payload = settings.snapshot();
    await settings.persist(payload);
    const result = await post("/api/profiles/refresh", {
      max_profiles: 0,
      profile_ids: profileIds,
      max: 0,
      scrolls: payload.scrolls,
      idle_rounds: payload.idle_rounds,
      incremental_stop_existing: payload.incremental_stop_existing || 12,
      full_scan: fullScan,
    });
    $("extractStart").hidden = true;
    $("refreshProfiles").hidden = true;
    $("confirmPendingProfiles").hidden = true;
    $("extractStop").hidden = false;
    $("profileRefreshStop").hidden = false;
    toast(profileIds.length
      ? `${fullScan ? "主页全量采集" : "主页快速采集"}已启动 #${result.job_id}`
      : `一键智能采集已启动 #${result.job_id}`);
  }

  async function confirmPendingProfiles() {
    const button = $("confirmPendingProfiles");
    if (extractActive || button?.disabled) return;
    button.disabled = true;
    const params = new URLSearchParams({
      scope: "all",
      q: "",
      sort: "latest_desc",
      deleted_works: "all",
      limit: "500",
      offset: "0",
    });
    try {
      const data = await api(`/api/profiles?${params.toString()}`);
      const pending = (Array.isArray(data.profiles) ? data.profiles : []).filter(needsFullScan);
      if (!pending.length) {
        fullScanRequiredCount = 0;
        renderManager(rows, extractActive);
        toast("当前没有待全量确认的主页");
        return;
      }
      const confirmed = window.confirm(
        `将依次对 ${pending.length} 个“待全量确认”主页执行完整扫描。\n\n只处理这些待确认主页；完成后会记录本次主页作品数，同一差额不会反复全量。`
      );
      if (!confirmed) return;
      await refreshProfiles(pending.map((profile) => Number(profile.id)), { fullScan: true });
      toast(`已开始一键确认 ${pending.length} 个主页`);
    } finally {
      if (!extractActive && !button.hidden) button.disabled = false;
    }
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

  async function deleteProfile(profileId, button) {
    const profile = rows.find((item) => Number(item.id) === Number(profileId));
    if (!profile) return;
    const name = String(profile.nickname || profile.title || `主页 #${profileId}`).trim();
    const linkCount = Number(profile.total || 0);
    const confirmed = window.confirm(
      `确定删除“${name}”的这条主页记录吗？\n\n将从 8765 数据库删除 ${linkCount} 条关联链接和队列记录；不会删除磁盘上的媒体文件。`
    );
    if (!confirmed) return;
    button.disabled = true;
    try {
      const result = await post("/api/profiles/delete", { profile_id: profileId });
      rows = rows.filter((item) => Number(item.id) !== Number(profileId));
      total = Math.max(0, total - 1);
      renderManager(rows, extractActive);
      await Promise.all([load({ reset: true }), refreshState(), refreshLinks()]);
      toast(`已删除“${name}”：${Number(result.links_deleted || 0)} 条数据库链接`);
    } finally {
      button.disabled = false;
    }
  }

  async function stopExtractJob() {
    await post("/api/extract/stop");
    $("extractStart").hidden = false;
    $("refreshProfiles").hidden = false;
    $("confirmPendingProfiles").hidden = false;
    $("extractStop").hidden = true;
    $("profileRefreshStop").hidden = true;
    toast("正在停止采集");
  }

  function bind() {
    const profileParam = String(new URLSearchParams(location.search).get("profile") || "").trim();
    if (profileParam) {
      deepLinkedProfile = profileParam;
      $("profileManagerSearch").value = profileParam;
      $("profileManagerScope").value = "all";
      $("profileManagerDeletedWorks").value = "all";
    }
    $("extractStart").addEventListener("click", () => startExtract().catch((err) => toast(err.message)));
    $("profileUrl").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || extractActive) return;
      event.preventDefault();
      startExtract().catch((err) => toast(err.message));
    });
    $("extractStop").addEventListener("click", () => stopExtractJob().catch((err) => toast(err.message)));
    $("profileRefreshStop").addEventListener("click", () => stopExtractJob().catch((err) => toast(err.message)));
    $("refreshProfiles").addEventListener("click", () => refreshProfiles([]).catch((err) => toast(err.message)));
    $("confirmPendingProfiles").addEventListener("click", () => confirmPendingProfiles().catch((err) => toast(err.message)));
    $("importFollowing").addEventListener("click", () => importFollowing().catch((err) => toast(err.message)));
    $("profileManagerSearch").addEventListener("input", () => {
      deepLinkedProfile = "";
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => load({ reset: true }).catch((err) => toast(err.message)), 250);
    });
    $("profileManagerSort").addEventListener("change", () => {
      load({ reset: true }).catch((err) => toast(err.message));
    });
    $("profileManagerScope").addEventListener("change", () => {
      load({ reset: true }).catch((err) => toast(err.message));
    });
    $("profileManagerDeletedWorks").addEventListener("change", () => {
      load({ reset: true }).catch((err) => toast(err.message));
    });
    $("profileManagerList").addEventListener("scroll", scheduleLoadMoreIfNeeded, { passive: true });
    $("profileManagerList").addEventListener("click", (event) => {
      const loadMore = event.target.closest("button[data-profile-load-more]");
      if (loadMore) {
        load({ reset: false }).catch((err) => toast(err.message));
        return;
      }
      const deleteButton = event.target.closest("button[data-profile-delete]");
      if (deleteButton) {
        const profileId = Number(deleteButton.dataset.profileDelete || 0);
        if (!profileId) return;
        deleteProfile(profileId, deleteButton).catch((err) => toast(err.message));
        return;
      }
      const fullRefreshButton = event.target.closest("button[data-profile-full-refresh]");
      if (fullRefreshButton) {
        const profileId = Number(fullRefreshButton.dataset.profileFullRefresh || 0);
        if (!profileId) return;
        refreshProfiles([profileId], { fullScan: true }).catch((err) => toast(err.message));
        return;
      }
      const button = event.target.closest("button[data-profile-refresh]");
      if (!button) return;
      const profileId = Number(button.dataset.profileRefresh || 0);
      if (!profileId) return;
      const profile = rows.find((item) => Number(item.id) === profileId);
      refreshProfiles([profileId], { fullScan: profile ? needsFullScan(profile) : false }).catch((err) => toast(err.message));
    });
  }

  function renderStatus(state) {
    extractActive = Boolean(state.extract?.active);
    const extractState = $("extractState");
    extractState.textContent = extractActive ? "正在采集" : "采集空闲";
    extractState.classList.toggle("is-active", extractActive);
    extractState.title = extractActive && state.extract?.job_id
      ? `采集任务 #${state.extract.job_id}`
      : "当前没有采集任务";
    if (wasExtractActive && !extractActive && location.hash === "#profiles") {
      load({ reset: true }).catch((err) => toast(err.message));
    }
    wasExtractActive = extractActive;
    $("extractStart").hidden = extractActive;
    $("refreshProfiles").hidden = extractActive;
    $("confirmPendingProfiles").hidden = extractActive;
    $("importFollowing").hidden = extractActive;
    $("extractStop").hidden = !extractActive;
    $("profileRefreshStop").hidden = !extractActive;
  }

  function render(state) {
    renderStatus(state);
  }

  return {
    bind,
    render,
    renderStatus,
    activate: () => load({ reset: true }).then(() => {
      if (!deepLinkedProfile) return;
      const exactMatch = rows.find((profile) => String(profile.sec_uid || "").trim() === deepLinkedProfile);
      if (!exactMatch) {
        toast("没有找到这个作者的采集主页");
        return;
      }
      const friendlyName = String(exactMatch.nickname || exactMatch.title || "").trim();
      if (friendlyName) $("profileManagerSearch").value = friendlyName;
    }),
  };
}
