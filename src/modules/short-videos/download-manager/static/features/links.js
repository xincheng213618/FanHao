import { api, post } from "../core/api.js";
import { $, escapeHtml, safeUrl, toast } from "../core/dom.js";
import { formatCompact, formatDateTime, statusLabel } from "../core/format.js";

const PAGE_SIZE = 100;

export function createLinksFeature(options) {
  const settings = options.settings;
  const refreshState = options.refreshState;
  const supportsLinkRetry = options.supportsLinkRetry || (() => true);
  let currentFilter = "";
  let rows = [];
  let total = 0;
  let loading = false;
  let searchTimer = null;
  let summary = null;

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

  function renderTable() {
    const tableWrap = document.querySelector(".home-links-panel .table-wrap");
    const scrollTop = tableWrap?.scrollTop || 0;
    const scrollLeft = tableWrap?.scrollLeft || 0;
    $("linksBody").innerHTML =
      rows
        .map(
          (link) => {
            const status = String(link.status || "");
            const statusClass = ["pending", "downloading", "downloaded", "failed"].includes(status) ? status : "pending";
            const href = safeUrl(link.url);
            const profileHref = safeUrl(link.profile_url);
            const profileName = String(link.profile_nickname || link.profile_title || `主页 #${link.profile_id || ""}`).trim();
            const profileTab = link.profile_tab === "like" ? "我的喜欢" : "作者作品";
            const authorName = String(link.author_nickname || "").trim();
            const rawTitle = String(link.desc || "").trim();
            const title = !rawTitle || rawTitle === "no_title" ? "未命名作品" : rawTitle;
            const kindLabel = link.media_type === "gallery" || link.kind === "note" ? "图集" : "视频";
            const createDate = link.create_time ? new Date(Number(link.create_time) * 1000).toLocaleDateString() : "日期未知";
            const issue = String(link.last_error || link.actual_probe_error || "").trim()
              || (link.download_intent === "quality_upgrade" ? "等待最高画质重下" : "");
            const issueIsWarning = status === "failed" || link.download_intent === "quality_upgrade";
            return `
            <tr>
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
                <span class="badge ${statusClass}">${escapeHtml(statusLabel(status))}</span>
                ${link.download_intent === "quality_upgrade" ? '<span class="badge quality-upgrade">高清重下</span>' : ""}
              </td>
              <td class="time-cell">
                ${renderLinkTime(link)}
                <div class="muted">尝试 ${escapeHtml(link.attempts ?? 0)} 次</div>
              </td>
              <td class="issue-cell">
                <div class="link-issue ${issueIsWarning ? "has-issue" : ""}">${escapeHtml(issue || "—")}</div>
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
                  ${status === "failed" && supportsLinkRetry() ? `
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
                    title="只删除这条数据库记录"
                  >删除数据库记录</button>
                </details>
              </td>
            </tr>
          `;
          }
        )
        .join("") || '<tr><td colspan="6" class="muted empty-links-cell">没有符合条件的链接</td></tr>';
    if (tableWrap) {
      tableWrap.scrollTop = scrollTop;
      tableWrap.scrollLeft = scrollLeft;
    }
    renderSummary();
    renderPager();
  }

  function renderPager() {
    const loaded = Math.min(rows.length, total || rows.length);
    $("linksPager").textContent = `已加载 ${loaded} / ${total || 0}`;
    $("loadMoreLinks").hidden = loaded >= total;
    $("loadMoreLinks").disabled = loading;
    $("loadMoreLinks").textContent = loading ? "加载中" : "加载更多";
  }

  async function load(options = {}) {
    if (loading) return;
    const reset = options.reset !== false && !options.append;
    const preserve = Boolean(options.preserve);
    const offset = options.append ? rows.length : 0;
    const limit = preserve ? Math.max(PAGE_SIZE, rows.length || PAGE_SIZE) : PAGE_SIZE;
    const params = new URLSearchParams();
    if (currentFilter) params.set("status", currentFilter);
    const search = $("linksSearch")?.value.trim();
    if (search) params.set("q", search);
    params.set("view", "manager");
    params.set("include_summary", "1");
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (reset && !preserve) {
      rows = [];
      total = 0;
    }
    loading = true;
    renderPager();
    try {
      const data = await api(`/api/links?${params.toString()}`);
      total = Number(data.total || 0);
      if (data.summary) summary = data.summary;
      rows = options.append ? [...rows, ...(data.links || [])] : data.links || [];
      renderTable();
    } finally {
      loading = false;
      renderPager();
    }
  }

  function refresh() {
    return load({ reset: true });
  }

  async function loadMore() {
    if (rows.length >= total) return;
    return load({ append: true, reset: false });
  }

  async function refreshLoaded() {
    if (rows.length > PAGE_SIZE) return;
    return load({ preserve: true });
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
    document.querySelector(".home-links-panel .table-wrap")?.addEventListener("scroll", (event) => {
      const node = event.currentTarget;
      if (node.scrollTop + node.clientHeight >= node.scrollHeight - 120) {
        loadMore().catch((err) => toast(err.message));
      }
    });
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

  return { bind, render, refresh, refreshLoaded };
}
