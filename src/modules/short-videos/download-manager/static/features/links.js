import { api, post } from "../core/api.js";
import { $, escapeHtml, safeUrl, toast } from "../core/dom.js";
import { formatCompact, formatDateTime, statusLabel } from "../core/format.js";
import { createLatestRequestLifecycle } from "../core/latest-request.js";
import { createKeyedListRenderer } from "../core/keyed-list.js";

const PAGE_SIZE = 100;

function formatDuration(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${Math.round(bytes)} B`;
}

function downloadProgressText(progress) {
  if (!progress) return "等待下载器返回进度";
  const parts = [String(progress.phase || "下载中"), formatDuration(progress.elapsed_seconds)];
  const downloaded = Math.max(0, Number(progress.bytes_downloaded) || 0);
  const total = Math.max(0, Number(progress.bytes_total) || 0);
  if (total > 0) {
    const percent = Math.min(100, Math.round((downloaded / total) * 100));
    parts.push(`${formatBytes(downloaded)} / ${formatBytes(total)} · ${percent}%`);
  } else if (downloaded > 0) {
    parts.push(formatBytes(downloaded));
  }
  const speed = Math.max(0, Number(progress.speed_bytes_per_second) || 0);
  if (speed > 0) parts.push(`${(speed * 8 / 1000000).toFixed(1)} Mbps`);
  return parts.join(" · ");
}

export function createLinksFeature(options) {
  const settings = options.settings;
  const refreshState = options.refreshState;
  const supportsLinkRetry = options.supportsLinkRetry || (() => true);
  let currentFilter = "";
  let rows = [];
  let total = 0;
  let loading = false;
  let loadMoreCheckScheduled = false;
  let searchTimer = null;
  let summary = null;
  let runtimeProgressByAweme = new Map();
  let pagingMode = "offset";
  let nextCursor = null;
  let pageCursor = null;
  let hasMore = false;
  let legacyOffset = 0;
  let refreshIndex = 0;
  let refreshEndpointAvailable = true;
  let activeAwemeIds = new Set();
  let rowMarkup = new Map();
  const requests = createLatestRequestLifecycle();
  const refreshRequests = createLatestRequestLifecycle();
  const renderRows = createKeyedListRenderer($("linksBody"));

  function isContentUnavailable(link) {
    const issue = String(link.last_error || link.actual_probe_error || "");
    return String(link.status || "") === "failed" && issue.includes("作品已不可用");
  }

  function currentQuerySnapshot() {
    return `${currentFilter}\n${String($("linksSearch")?.value || "").trim()}`;
  }

  function renderSummary() {
    document.querySelectorAll("[data-link-count]").forEach((node) => {
      const key = node.dataset.linkCount || "all";
      const value = summary ? Number(summary[key] || 0) : null;
      node.textContent = value === null ? "" : formatCompact(value) || "0";
      node.hidden = value === null;
    });
  }

  function linkStatusTime(link) {
    const status = String(link.status || "");
    if (status === "downloaded") return ["完成", link.downloaded_at];
    if (isContentUnavailable(link)) return ["确认", link.failed_at || link.last_started_at];
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

  function renderLink(link) {
    const status = String(link.status || "");
    const contentUnavailable = isContentUnavailable(link);
    const statusClass = contentUnavailable
      ? "unavailable"
      : (["pending", "downloading", "downloaded", "failed"].includes(status) ? status : "pending");
    const statusText = contentUnavailable ? "已不可用" : statusLabel(status);
    const href = safeUrl(link.url);
    const profileHref = safeUrl(link.profile_url);
    const profileName = String(link.profile_nickname || link.profile_title || `主页 #${link.profile_id || ""}`).trim();
    const profileTab = link.profile_tab === "like" ? "我的喜欢" : "作者作品";
    const authorName = String(link.author_nickname || "").trim();
    const rawTitle = String(link.desc || "").trim();
    const title = !rawTitle || rawTitle === "no_title" ? "未命名作品" : rawTitle;
    const kindLabel = link.media_type === "gallery" || link.kind === "note" ? "图集" : "视频";
    const createDate = link.create_time ? new Date(Number(link.create_time) * 1000).toLocaleDateString() : "日期未知";
    const rawIssue = String(link.last_error || link.actual_probe_error || "").trim();
    const runtimeProgress = runtimeProgressByAweme.get(String(link.aweme_id || ""));
    const downloadProgress = status === "downloading"
      ? downloadProgressText(runtimeProgress)
      : "";
    const issue = downloadProgress || (contentUnavailable
      ? "作者可能已删除作品或更改可见权限；可移除此记录。"
      : rawIssue)
      || (link.download_intent === "quality_upgrade" ? "等待最高画质重下" : "");
    const issueIsWarning = status === "failed" || link.download_intent === "quality_upgrade";
    return `
    <tr data-link-id="${escapeHtml(link.id)}" data-link-aweme-id="${escapeHtml(link.aweme_id || "")}">
      <td class="work-cell">
        <div class="link-work-summary">
          ${link.cover_url
            ? `<img class="thumb" src="${safeUrl(link.cover_url)}" alt="" loading="lazy" />`
            : '<div class="thumb link-thumb-placeholder" aria-hidden="true"></div>'}
          <div class="link-work-copy">
            <strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong>
            <div class="muted">${escapeHtml(kindLabel)} · ${escapeHtml(createDate)}</div>
          </div>
        </div>
      </td>
      <td class="source-cell">
        <a href="${profileHref}" target="_blank" rel="noreferrer">${escapeHtml(profileName)}</a>
        <div class="muted">${escapeHtml(profileTab)}</div>
        ${authorName && authorName !== profileName ? `<div class="muted">作者 ${escapeHtml(authorName)}</div>` : ""}
      </td>
      <td>
        <span class="badge ${statusClass}">${escapeHtml(statusText)}</span>
        ${link.download_intent === "quality_upgrade" ? '<span class="badge quality-upgrade">高清重下</span>' : ""}
      </td>
      <td class="time-cell">
        ${renderLinkTime(link)}
        <div class="muted">尝试 ${escapeHtml(link.attempts ?? 0)} 次</div>
      </td>
      <td class="issue-cell">
        <div
          class="link-issue ${status === "downloading" ? "is-progress" : ""} ${issueIsWarning ? "has-issue" : ""}"
          ${status === "downloading" ? 'data-download-progress="true"' : ""}
          title="${escapeHtml(runtimeProgress?.current_file || "")}"
        >${escapeHtml(issue || "—")}</div>
        <details class="link-row-details">
          <summary>技术详情</summary>
          <dl>
            <div><dt>作品 ID</dt><dd>${escapeHtml(link.aweme_id || "—")}</dd></div>
            <div><dt>作者标识</dt><dd>${escapeHtml(link.author_sec_uid || link.author_uid || "—")}</dd></div>
          </dl>
        </details>
      </td>
      <td class="link-actions-cell">
        <a class="link-open-button" href="${href}" target="_blank" rel="noreferrer">打开</a>
        <details class="row-actions-menu">
          <summary>更多</summary>
           ${status === "failed" && !contentUnavailable && supportsLinkRetry() ? `
            <button
              class="link-retry-button"
              data-link-retry="${escapeHtml(link.id || "")}"
              data-link-aweme-id="${escapeHtml(link.aweme_id)}"
            >重新加入下载队列</button>
          ` : ""}
          <button
            class="danger link-delete-button"
            data-link-delete="${escapeHtml(link.id || "")}"
            data-link-aweme-id="${escapeHtml(link.aweme_id)}"
            title="${contentUnavailable ? "移除这条已不可用的数据库记录" : "只删除这条数据库记录"}"
          >${contentUnavailable ? "移除已不可用记录" : "删除数据库记录"}</button>
        </details>
      </td>
    </tr>
  `;
  }

  function renderTable() {
    const oldRows = Array.from($("linksBody").querySelectorAll("tr[data-link-id]"));
    const expanded = new Map();
    $("linksBody").querySelectorAll("details[open]").forEach((node) => {
      const row = node.closest("tr[data-link-id]");
      if (row && !expanded.has(row.dataset.linkId)) {
        expanded.set(row.dataset.linkId, Array.from(row.querySelectorAll("details")).map((detail) => detail.open));
      }
    });
    const focused = document.activeElement;
    const focusRow = focused?.closest?.("tr[data-link-id]");
    const focusIndex = focusRow ? Array.from(focusRow.querySelectorAll("a, button, summary")).indexOf(focused) : -1;
    const focusAction = focused?.hasAttribute?.("data-link-delete") ? "[data-link-delete]"
      : focused?.hasAttribute?.("data-link-retry") ? "[data-link-retry]" : null;
    const anchor = oldRows[firstVisibleRowIndex(oldRows)];
    const anchorTop = anchor?.getBoundingClientRect().top;
    const nextMarkup = new Map();
    const retryAllowed = Boolean(supportsLinkRetry());
    renderRows(rows, (link) => link.id, (link) => {
      const key = String(link.id);
      const progress = link.status === "downloading" ? runtimeProgressByAweme.get(String(link.aweme_id || "")) : null;
      const progressKey = progress ? `${downloadProgressText(progress)}\n${progress.current_file || ""}` : "";
      const previous = rowMarkup.get(key);
      const entry = previous?.link === link && previous.progressKey === progressKey && previous.retryAllowed === retryAllowed
        ? previous : { link, progressKey, retryAllowed, html: renderLink(link) };
      nextMarkup.set(key, entry);
      return entry.html;
    },
      '<tr><td colspan="6" class="muted empty-links-cell">没有符合条件的链接</td></tr>');
    rowMarkup = nextMarkup;
    expanded.forEach((state, id) => {
      const row = $("linksBody").querySelector(`tr[data-link-id="${CSS.escape(id)}"]`);
      row?.querySelectorAll("details").forEach((node, index) => { node.open = Boolean(state[index]); });
    });
    if (focusIndex >= 0 && !focused.isConnected) {
      const row = $("linksBody").querySelector(`tr[data-link-id="${CSS.escape(focusRow.dataset.linkId)}"]`);
      const target = focusAction ? row?.querySelector(focusAction) : row?.querySelectorAll("a, button, summary")[focusIndex];
      target?.focus({ preventScroll: true });
    }
    const nextAnchor = anchor && $("linksBody").querySelector(`tr[data-link-id="${CSS.escape(anchor.dataset.linkId)}"]`);
    if (nextAnchor && window.scrollY > 0) {
      const delta = nextAnchor.getBoundingClientRect().top - anchorTop;
      if (delta) window.scrollBy(0, delta);
    }
    renderSummary();
    renderPager();
  }

  function firstVisibleRowIndex(nodes) {
    let low = 0;
    let high = nodes.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (nodes[middle].getBoundingClientRect().bottom <= 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function renderPager() {
    const loaded = rows.length;
    $("linksPager").textContent = `已加载 ${loaded} / ${total || 0}`;
    $("loadMoreLinks").hidden = !hasMore;
    $("loadMoreLinks").disabled = loading;
    $("loadMoreLinks").textContent = loading ? "加载中" : "加载更多";
  }

  async function load(options = {}) {
    const append = Boolean(options.append);
    if (append && requests.inFlight) return;
    const reset = options.reset !== false && !options.append;
    const preserve = Boolean(options.preserve);
    const offset = append ? legacyOffset : 0;
    const limit = preserve ? Math.max(PAGE_SIZE, rows.length || PAGE_SIZE) : PAGE_SIZE;
    const querySnapshot = currentQuerySnapshot();
    const params = new URLSearchParams();
    if (currentFilter) params.set("status", currentFilter);
    const search = String($("linksSearch")?.value || "").trim();
    if (search) params.set("q", search);
    params.set("view", "manager");
    params.set("include_summary", "1");
    params.set("limit", String(limit));
    if (append && pagingMode === "cursor") {
      if (!hasMore || !nextCursor) return;
      params.set("paging", "cursor");
      params.set("cursor", nextCursor);
    } else {
      params.set("offset", String(offset));
      if (!append) params.set("paging", "cursor");
    }
    if (reset && !preserve) {
      rows = [];
      total = 0;
      hasMore = false;
      nextCursor = null;
      pageCursor = null;
      refreshIndex = 0;
    }
    refreshRequests.cancel();
    const request = requests.begin(querySnapshot);
    loading = true;
    renderPager();
    try {
      const data = await api(`/api/links?${params.toString()}`, { signal: request.signal });
      if (!requests.canCommit(request, currentQuerySnapshot())) return;
      total = Number(data.total || 0);
      if (data.summary) summary = data.summary;
      const page = data.links || [];
      if (data.paging === "cursor") {
        pagingMode = "cursor";
        nextCursor = data.next_cursor || null;
        pageCursor = data.page_cursor || pageCursor;
        hasMore = Boolean(data.has_more && nextCursor);
      } else {
        pagingMode = "offset";
        pageCursor = null;
        nextCursor = null;
        legacyOffset = offset + page.length;
        hasMore = page.length > 0 && legacyOffset < total;
      }
      // A live downloaded row can move back across a consumed time boundary.
      // Merge that row by ID; the backend keyset handles queue insert/removal gaps.
      const byId = new Map((append ? rows : []).map((link) => [Number(link.id), link]));
      page.forEach((link) => byId.set(Number(link.id), link));
      rows = Array.from(byId.values());
      renderTable();
    } catch (error) {
      if (!requests.canCommit(request, currentQuerySnapshot())) return;
      throw error;
    } finally {
      if (requests.finish(request)) {
        loading = false;
        renderPager();
      }
    }
  }

  function refresh() {
    return load({ reset: true });
  }

  async function loadMore() {
    if (!hasMore) return;
    return load({ append: true, reset: false });
  }

  function scheduleLoadMoreIfNeeded() {
    if (loadMoreCheckScheduled) return;
    loadMoreCheckScheduled = true;
    window.requestAnimationFrame(() => {
      loadMoreCheckScheduled = false;
      if (loading || !hasMore || (location.hash && location.hash !== "#home")) return;
      const button = $("loadMoreLinks");
      if (!button || button.hidden || !button.getClientRects().length) return;
      if (button.getBoundingClientRect().top > window.innerHeight + 320) return;
      loadMore().catch((err) => toast(err.message));
    });
  }

  async function refreshLoaded(priorityIds = []) {
    if (requests.inFlight || refreshRequests.inFlight) return;
    if (!refreshEndpointAvailable) {
      if (rows.length <= PAGE_SIZE) return load({ preserve: true });
      return;
    }
    const selected = new Set();
    const loadedIds = new Set(rows.map((link) => Number(link.id)));
    const add = (id) => { if (selected.size < PAGE_SIZE && loadedIds.has(Number(id))) selected.add(Number(id)); };
    priorityIds.slice(0, 25).forEach(add);
    const nodes = Array.from($("linksBody").querySelectorAll("tr[data-link-id]"));
    for (let index = firstVisibleRowIndex(nodes); index < nodes.length && selected.size < PAGE_SIZE / 2; index += 1) {
      const row = nodes[index];
      const rect = row.getBoundingClientRect();
      if (rect.top > window.innerHeight) break;
      add(row.dataset.linkId);
    }
    // Reserve a rotating budget even when many loaded rows remain off screen.
    for (let visited = 0; visited < Math.min(PAGE_SIZE, rows.length) && selected.size < PAGE_SIZE; visited += 1) {
      add(rows[refreshIndex % rows.length].id);
      refreshIndex = (refreshIndex + 1) % rows.length;
    }
    const params = new URLSearchParams({ ids: Array.from(selected).join(","), view: "manager", include_summary: "1" });
    if (currentFilter) params.set("status", currentFilter);
    const search = String($("linksSearch")?.value || "").trim();
    if (search) params.set("q", search);
    if (pageCursor) params.set("cursor", pageCursor);
    const request = refreshRequests.begin(currentQuerySnapshot());
    try {
      const data = await api(`/api/links/refresh?${params.toString()}`, { signal: request.signal });
      if (!refreshRequests.canCommit(request, currentQuerySnapshot())) return;
      const updated = new Map((data.links || []).map((link) => [Number(link.id), link]));
      const missing = new Set((data.missing_ids || []).map(Number));
      rows = rows.filter((link) => !missing.has(Number(link.id))).map((link) => updated.get(Number(link.id)) || link);
      total = Number(data.total || 0);
      if (data.summary) summary = data.summary;
      if (currentFilter && total === 0) rows = [];
      // Passive refresh retains the continuation boundary even after row removal.
      renderTable();
    } catch (error) {
      if (!refreshRequests.canCommit(request, currentQuerySnapshot())) return;
      if ([404, 405, 501].includes(Number(error.status)) || error.code === "ENDPOINT_NOT_SUPPORTED") {
        refreshEndpointAvailable = false;
        refreshRequests.finish(request);
        if (rows.length <= PAGE_SIZE) return load({ preserve: true });
        return;
      }
      throw error;
    } finally {
      refreshRequests.finish(request);
    }
  }

  async function syncManifest() {
    await settings.save();
    const result = await post("/api/manifest/import", {
      manifest_path: "",
    });
    toast(`manifest 已同步：${result.unique} 条，新 ${result.inserted}，更新 ${result.updated}，文件 ${result.files || 0}`);
    refreshState();
    refresh();
  }

  async function resetFailed(scope = "current") {
    const result = await post("/api/links/reset-failed", { scope });
    const label = scope === "all" ? "全部主页" : "当前主页";
    toast(`${label}失败已转为待下载：${result.changed || 0} 条`);
    refreshState().catch(() => {});
    refresh().catch(() => {});
  }

  async function deleteEmptyFailed() {
    const ok = window.confirm("删除全库里标题、作者、封面都为空的失败链接？删除后“失败转待下载”不会再重试这些记录。");
    if (!ok) return;
    const result = await post("/api/links/delete-empty-failed", { scope: "all" });
    toast(`空壳失败已删除：${result.changed || 0} 条`);
    rows = [];
    total = 0;
    refreshState().catch(() => {});
    refresh().catch(() => {});
  }

  async function deleteAllFailed() {
    const ok = window.confirm("确定删除全库所有失败链接吗？有标题、作者、封面的失败记录也会一起从数据库删除，后续不会再重试。");
    if (!ok) return;
    const result = await post("/api/links/delete-failed", { scope: "all" });
    toast(`所有失败已删除：${result.changed || 0} 条`);
    rows = [];
    total = 0;
    refreshState().catch(() => {});
    refresh().catch(() => {});
  }

  async function deleteLink(linkId, awemeId, button) {
    const ok = window.confirm(`确定删除作品 ${awemeId || linkId} 的这条数据库记录吗？\n\n只会删除数据库记录，不会删除已经下载到本地的文件。`);
    if (!ok) return;
    if (button) button.disabled = true;
    try {
      const result = await post("/api/links/delete", { id: linkId });
      toast(`已删除作品 ${result.aweme_id || awemeId || linkId}`);
      rows = rows.filter((link) => Number(link.id) !== Number(linkId));
      total = Math.max(0, total - Number(result.changed || 0));
      renderTable();
      refreshState().catch(() => {});
      refreshLoaded().catch(() => {});
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }

  async function retryLink(linkId, awemeId, button) {
    if (button) button.disabled = true;
    try {
      const result = await post("/api/links/retry", { id: linkId });
      toast(`作品 ${result.aweme_id || awemeId || linkId} 已重新加入下载队列`);
      await refresh();
      refreshState().catch(() => {});
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  }

  function bind() {
    $("syncManifest").addEventListener("click", () => syncManifest().catch((err) => toast(err.message)));
    $("resetFailedCurrent").addEventListener("click", () => resetFailed("current").catch((err) => toast(err.message)));
    $("resetFailedAll").addEventListener("click", () => resetFailed("all").catch((err) => toast(err.message)));
    $("deleteEmptyFailed").addEventListener("click", () => deleteEmptyFailed().catch((err) => toast(err.message)));
    $("deleteAllFailed").addEventListener("click", () => deleteAllFailed().catch((err) => toast(err.message)));
    $("loadMoreLinks").addEventListener("click", () => loadMore().catch((err) => toast(err.message)));
    $("linksBody").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-link-delete], button[data-link-retry]");
      if (!button) return;
      const retryId = Number(button.dataset.linkRetry || 0);
      if (retryId) {
        retryLink(retryId, button.dataset.linkAwemeId || "", button).catch((err) => toast(err.message));
        return;
      }
      const linkId = Number(button.dataset.linkDelete || 0);
      if (!linkId) return;
      deleteLink(linkId, button.dataset.linkAwemeId || "", button).catch((err) => toast(err.message));
    });
    window.addEventListener("scroll", scheduleLoadMoreIfNeeded, { passive: true });
    window.addEventListener("resize", scheduleLoadMoreIfNeeded);
    document.querySelectorAll("[data-filter]").forEach((button) => {
      button.setAttribute("aria-pressed", button.classList.contains("active") ? "true" : "false");
      button.addEventListener("click", () => {
        document.querySelectorAll("[data-filter]").forEach((node) => {
          node.classList.remove("active");
          node.setAttribute("aria-pressed", "false");
        });
        button.classList.add("active");
        button.setAttribute("aria-pressed", "true");
        currentFilter = button.dataset.filter || "";
        rows = [];
        total = 0;
        refresh().catch((err) => toast(err.message));
      });
    });
    $("linksSearch").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        rows = [];
        total = 0;
        refresh().catch((err) => toast(err.message));
      }, 300);
    });
  }

  function render(state) {
    $("dbPath").textContent = state.paths?.database || "";
  }

  function renderRuntime(state) {
    const items = Array.isArray(state.download?.items) ? state.download.items : [];
    runtimeProgressByAweme = new Map(
      items.map((item) => [String(item.aweme_id || ""), item])
    );
    document.querySelectorAll("#linksBody [data-download-progress]").forEach((node) => {
      const row = node.closest("tr[data-link-aweme-id]");
      const progress = runtimeProgressByAweme.get(String(row.dataset.linkAwemeId || ""));
      if (!progress) return;
      node.textContent = downloadProgressText(progress);
      node.title = String(progress.current_file || progress.detail || "");
    });
    const nextActive = new Set(items.map((item) => String(item.aweme_id || "")));
    const changedIds = rows.filter((link) => activeAwemeIds.has(String(link.aweme_id || "")) !== nextActive.has(String(link.aweme_id || "")))
      .map((link) => Number(link.id));
    activeAwemeIds = nextActive;
    if (changedIds.length) refreshLoaded(changedIds).catch(() => {});
  }

  return { bind, render, renderRuntime, refresh, refreshLoaded };
}
