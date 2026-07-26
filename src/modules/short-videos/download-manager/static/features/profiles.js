import { api, post } from "../core/api.js";
import { $, escapeHtml, safeUrl, toast } from "../core/dom.js";
import { displayDouyinId, formatCompact, formatDateTime, profileWorkDate } from "../core/format.js";

export function createProfilesFeature(options) {
  const settings = options.settings;
  const refreshState = options.refreshState;
  const refreshLinks = options.refreshLinks;
  let searchTimer = null;
  let rows = [];
  let total = 0;
  let eligibleCount = null;
  let deferredCount = null;
  let loading = false;
  let wasExtractActive = false;
  let extractActive = false;

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

  function renderProfileSelect(profiles, currentProfile) {
    const select = $("profileSelect");
    if (!select || document.activeElement === select) return;
    const profileRows = profiles || [];
    select.innerHTML =
      profileRows
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
          return `<option value="${escapeHtml(profile.url || "")}" data-tab="${escapeHtml(profile.tab || "post")}" ${selected}>#${escapeHtml(profile.id || "")} ${escapeHtml(label)} · ${escapeHtml(profile.url || "")}</option>`;
        })
        .join("") || '<option value="">还没有入库主页</option>';
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
      filteredRows.sort((a, b) => Number(b.is_self || 0) - Number(a.is_self || 0) || String(a.last_extracted_at || "").localeCompare(String(b.last_extracted_at || "")) || Number(a.id) - Number(b.id));
    } else {
      const valueOf = numericSort[sortMode] || numericSort.latest_desc;
      filteredRows.sort((a, b) => Number(b.is_self || 0) - Number(a.is_self || 0) || valueOf(b) - valueOf(a) || Number(b.id) - Number(a.id));
    }

    const localCandidates = allRows.filter(
      (profile) => Number(profile.total || 0) > 0 || Number(profile.is_self || 0) === 1
    );
    const localEligibleCount = localCandidates.filter((profile) => Number(profile.refresh_due || 0) === 1).length;
    const currentEligibleCount = eligibleCount === null ? localEligibleCount : eligibleCount;
    const currentDeferredCount = deferredCount === null
      ? Math.max(0, localCandidates.length - localEligibleCount)
      : deferredCount;
    const visibleRows = filteredRows;
    const totalRows = Math.max(total, filteredRows.length);
    $("profileManagerSummary").textContent = `${totalRows} 个主页 · 已加载 ${visibleRows.length} 个 · 智能判定本次采集 ${currentEligibleCount} 个，暂缓 ${currentDeferredCount} 个`;
    node.innerHTML = visibleRows.map((profile) => {
      const name = String(profile.nickname || profile.title || `主页 #${profile.id}`).trim();
      const douyinId = displayDouyinId(profile) || "-";
      const latestWork = profileWorkDate(profile);
      const lastExtracted = formatDateTime(profile.last_extracted_at);
      const refreshDue = Number(profile.refresh_due || 0) === 1;
      const refreshAt = formatDateTime(profile.refresh_due_at);
      const refreshInterval = formatRefreshInterval(profile.refresh_interval_seconds);
      const cadence = formatRefreshInterval(profile.refresh_cadence_seconds);
      const tabLabel = profile.tab === "like" ? "我的喜欢" : "作者作品";
      const sourceLabel = Number(profile.is_self || 0) === 1 ? "本人" : Number(profile.is_following || 0) === 1 ? "已关注" : "";
      const deletedWorksBadge = Number(profile.has_deleted_works || 0) === 1
        ? ' <span class="profile-manager-badge is-deleted-works" title="仅在全部扫描完成后确认">疑似删过作品</span>'
        : "";
      const refreshBadge = profile.tab === "like"
        ? ""
        : ` <span class="profile-manager-badge ${refreshDue ? "is-refresh-due" : "is-refresh-waiting"}">${refreshDue ? "已到期" : "暂缓"}</span>`;
      const refreshTitle = profile.refresh_basis === "posting_frequency"
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
      const avatar = profile.avatar_url
        ? `<img class="profile-manager-avatar" src="${safeUrl(profile.avatar_url)}" alt="" loading="lazy" />`
        : '<div class="profile-manager-avatar placeholder"></div>';
      return `
        <div class="profile-manager-row">
          <div class="profile-manager-identity">
            ${avatar}
            <div>
              <div class="profile-manager-name">${escapeHtml(name)}${sourceLabel ? ` <span class="profile-manager-badge">${escapeHtml(sourceLabel)}</span>` : ""}${deletedWorksBadge}${refreshBadge}</div>
              <div class="muted">${escapeHtml(tabLabel)} · 抖音号 ${escapeHtml(douyinId)}</div>
            </div>
          </div>
          <div class="profile-manager-metric"><span>作品</span><strong>${formatCompact(profile.aweme_count || profile.total || 0)}</strong><small>入库 ${formatCompact(profile.total || 0)}</small></div>
          <div class="profile-manager-metric"><span>粉丝</span><strong>${formatCompact(profile.follower_count || 0)}</strong></div>
          <div class="profile-manager-metric"><span>获赞</span><strong>${formatCompact(profile.total_favorited || 0)}</strong></div>
          <div class="profile-manager-date"><span>最新作品</span><strong>${escapeHtml(latestWork ? latestWork.slice(0, 10) : "暂无日期")}</strong></div>
          <div class="profile-manager-date" title="${escapeHtml(refreshTitle)}"><span>智能重抓</span><strong>${escapeHtml(refreshDue ? "现在可采集" : refreshAt || "等待判断")}</strong><small>${escapeHtml(refreshMeta)}</small></div>
          <div class="profile-manager-row-actions">
            <a class="queue-link" href="${safeUrl(profile.url)}" target="_blank" rel="noreferrer">主页</a>
            <button data-profile-refresh="${escapeHtml(profile.id || "")}" ${isExtractActive ? "disabled" : ""}>${Number(profile.is_self || 0) === 1 ? "采集喜欢" : "快速采集"}</button>
            ${profile.tab === "post" ? `<button data-profile-full-refresh="${escapeHtml(profile.id || "")}" title="遍历该作者当前全部主页作品，并标记主页已删除作品" ${isExtractActive ? "disabled" : ""}>全量采集</button>` : ""}
            <button class="danger" data-profile-delete="${escapeHtml(profile.id || "")}" ${isExtractActive ? "disabled" : ""}>删除</button>
          </div>
        </div>
      `;
    }).join("") + (totalRows > visibleRows.length
      ? `<div class="profile-manager-load-more"><button data-profile-load-more ${loading ? "disabled" : ""}>${loading ? "加载中" : `显示更多（剩余 ${totalRows - visibleRows.length}）`}</button></div>`
      : "") || '<div class="muted profile-manager-empty">没有符合条件的主页</div>';
  }

  async function load(options = {}) {
    if (loading) return;
    const reset = options.reset !== false;
    loading = true;
    try {
      const params = new URLSearchParams({
        scope: $("profileManagerScope")?.value || "collected",
        q: String($("profileManagerSearch")?.value || "").trim(),
        sort: $("profileManagerSort")?.value || "latest_desc",
        deleted_works: $("profileManagerDeletedWorks")?.value || "all",
        limit: "200",
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
    } finally {
      loading = false;
      renderManager(rows, extractActive);
    }
  }

  async function startExtract() {
    const payload = settings.snapshot();
    await settings.persist(payload);
    settings.markClean("profileUrl");
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

  async function refreshProfiles(profileIds = [], options = {}) {
    const fullScan = options.fullScan === true;
    const payload = settings.snapshot();
    await settings.persist(payload);
    const result = await post("/api/profiles/refresh", {
      max_profiles: 0,
      profile_ids: profileIds,
      max: $("maxItems").value || 0,
      scrolls: payload.scrolls,
      idle_rounds: payload.idle_rounds,
      incremental_stop_existing: payload.incremental_stop_existing || 12,
      full_scan: fullScan,
    });
    $("extractStart").hidden = true;
    $("refreshProfiles").hidden = true;
    $("extractStop").hidden = false;
    $("profileRefreshStop").hidden = false;
    toast(profileIds.length
      ? `${fullScan ? "主页全量采集" : "主页快速采集"}已启动 #${result.job_id}`
      : `一键智能采集已启动 #${result.job_id}`);
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
    $("extractStop").hidden = true;
    $("profileRefreshStop").hidden = true;
    toast("正在停止采集");
  }

  function bind() {
    $("profileSelect").addEventListener("change", () => {
      const value = $("profileSelect").value;
      if (!value) return;
      settings.setProfileUrl(value);
      settings.save()
        .then(() => {
          refreshState();
          refreshLinks();
        })
        .catch((err) => toast(err.message));
    });
    $("extractStart").addEventListener("click", () => startExtract().catch((err) => toast(err.message)));
    $("extractStop").addEventListener("click", () => stopExtractJob().catch((err) => toast(err.message)));
    $("profileRefreshStop").addEventListener("click", () => stopExtractJob().catch((err) => toast(err.message)));
    $("refreshProfiles").addEventListener("click", () => refreshProfiles([]).catch((err) => toast(err.message)));
    $("importFollowing").addEventListener("click", () => importFollowing().catch((err) => toast(err.message)));
    $("profileManagerSearch").addEventListener("input", () => {
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
      refreshProfiles([profileId]).catch((err) => toast(err.message));
    });
  }

  function render(state) {
    const profiles = state.profiles || [];
    extractActive = Boolean(state.extract?.active);
    renderProfileSelect(profiles, state.current_profile || null);
    if (!rows.length) {
      rows = profiles;
      total = profiles.length;
    }
    renderManager(rows, extractActive);
    if (wasExtractActive && !extractActive && location.hash === "#profiles") {
      load({ reset: true }).catch((err) => toast(err.message));
    }
    wasExtractActive = extractActive;
    $("extractState").textContent = extractActive ? "采集中" : "采集空闲";
    $("extractStart").hidden = extractActive;
    $("refreshProfiles").hidden = extractActive;
    $("importFollowing").hidden = extractActive;
    $("extractStop").hidden = !extractActive;
    $("profileRefreshStop").hidden = !extractActive;
  }

  return { bind, render, activate: () => load({ reset: true }) };
}
