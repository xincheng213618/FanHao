import { api, post } from "../core/api.js";
import { $, escapeHtml, safeUrl, toast } from "../core/dom.js";
import { formatDateTime, statusLabel } from "../core/format.js";

const PAGE_SIZE = 300;

export function createLinksFeature(options) {
  const settings = options.settings;
  const refreshState = options.refreshState;
  let currentFilter = "";
  let rows = [];
  let total = 0;
  let loading = false;

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
            return `
            <tr>
              <td>${escapeHtml(link.aweme_id || "")}</td>
              <td class="preview-cell">${
                link.cover_url
                  ? `<img class="thumb" src="${safeUrl(link.cover_url)}" alt="" loading="lazy" />`
                  : `<span class="muted">${escapeHtml(link.preview_path ? "本地" : "")}</span>`
              }</td>
              <td class="desc-cell">
                <div>${escapeHtml(link.desc || "")}</div>
                <div class="muted">${escapeHtml(link.create_time ? new Date(Number(link.create_time) * 1000).toLocaleDateString() : "")}</div>
              </td>
              <td>${escapeHtml(link.kind || "")}</td>
              <td>
                <span class="badge ${statusClass}">${escapeHtml(statusLabel(status))}</span>
                ${link.download_intent === "quality_upgrade" ? '<span class="badge quality-upgrade">高清重下</span>' : ""}
              </td>
              <td class="time-cell">${renderLinkTime(link)}</td>
              <td>${escapeHtml(link.attempts ?? 0)}</td>
              <td class="author">
                <div><a href="${profileHref}" target="_blank" rel="noreferrer">${escapeHtml(profileName)}</a></div>
                <div class="muted">${escapeHtml(profileTab)}</div>
              </td>
              <td class="author">
                <div>${escapeHtml(link.author_nickname || "")}</div>
                <div class="muted">${escapeHtml(link.author_sec_uid || link.author_uid || "")}</div>
              </td>
              <td class="url"><a href="${href}" target="_blank" rel="noreferrer">${escapeHtml(link.url || "")}</a></td>
              <td class="error">${escapeHtml(link.last_error || "")}</td>
              <td class="link-actions-cell">
                <button
                  class="danger link-delete-button"
                  data-link-delete="${escapeHtml(link.id || "")}"
                  data-link-aweme-id="${escapeHtml(link.aweme_id)}"
                  title="只删除这条数据库记录"
                >删除</button>
              </td>
            </tr>
          `;
          }
        )
        .join("") || '<tr><td colspan="12" class="muted">没有链接</td></tr>';
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
    params.set("limit", String(limit));
    params.set("offset", String(offset));
    if (reset && !preserve) {
      rows = [];
      total = 0;
    }
    loading = true;
    renderTable();
    try {
      const data = await api(`/api/links?${params.toString()}`);
      total = Number(data.total || 0);
      rows = options.append ? [...rows, ...(data.links || [])] : data.links || [];
      renderTable();
    } finally {
      loading = false;
      renderTable();
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

  function bind() {
    $("syncManifest").addEventListener("click", () => syncManifest().catch((err) => toast(err.message)));
    $("resetFailedCurrent").addEventListener("click", () => resetFailed("current").catch((err) => toast(err.message)));
    $("resetFailedAll").addEventListener("click", () => resetFailed("all").catch((err) => toast(err.message)));
    $("backfillGalleryMusic").addEventListener("click", () => backfillGalleryMusic().catch((err) => toast(err.message)));
    $("deleteEmptyFailed").addEventListener("click", () => deleteEmptyFailed().catch((err) => toast(err.message)));
    $("deleteAllFailed").addEventListener("click", () => deleteAllFailed().catch((err) => toast(err.message)));
    $("loadMoreLinks").addEventListener("click", () => loadMore().catch((err) => toast(err.message)));
    $("linksBody").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-link-delete]");
      if (!button) return;
      const linkId = Number(button.dataset.linkDelete || 0);
      if (!linkId) return;
      deleteLink(linkId, button.dataset.linkAwemeId || "", button).catch((err) => toast(err.message));
    });
    document.querySelector(".table-wrap")?.addEventListener("scroll", (event) => {
      const node = event.currentTarget;
      if (node.scrollTop + node.clientHeight >= node.scrollHeight - 120) {
        loadMore().catch((err) => toast(err.message));
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
          refresh();
          refreshState();
        })
        .catch((err) => toast(err.message))
    );
    document.querySelectorAll("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll("[data-filter]").forEach((node) => node.classList.remove("active"));
        button.classList.add("active");
        currentFilter = button.dataset.filter || "";
        rows = [];
        total = 0;
        refresh().catch((err) => toast(err.message));
      });
    });
  }

  function render(state) {
    $("dbPath").textContent = state.paths?.database || "";
  }

  return { bind, render, refresh, refreshLoaded };
}
