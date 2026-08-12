import { api, post } from "../core/api.js";
import { $, escapeHtml, safeUrl, toast } from "../core/dom.js";
import { createLatestRequestLifecycle } from "../core/latest-request.js";

const PAGE_SIZE = 48;

export function createLibraryFeature(options) {
  const showPage = options.showPage;
  let rows = [];
  let total = 0;
  let offset = 0;
  let hasMore = false;
  let loading = false;
  let searchTimer = null;
  const requests = createLatestRequestLifecycle();

  function currentQuerySnapshot() {
    return String($("librarySearch")?.value || "").trim();
  }

  function libraryCard(item) {
    const cover = item.cover_url
      ? `<img src="${safeUrl(item.cover_url)}" alt="" loading="lazy" />`
      : `<div class="library-placeholder"><span>${item.media_type === "gallery" ? "▦" : "▶"}</span></div>`;
    const typeLabel = item.media_type === "gallery" ? `${item.asset_count} 张/段` : "视频";
    const timestamp = item.create_time ? new Date(Number(item.create_time) * 1000).toLocaleDateString() : "";
    return `
      <article class="library-card" data-library-open="${escapeHtml(item.id || "")}" tabindex="0">
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
          <button data-library-folder="${escapeHtml(item.id || "")}">打开目录</button>
        </div>
      </article>
    `;
  }

  function renderLibrary() {
    const grid = $("libraryGrid");
    grid.innerHTML = rows.map(libraryCard).join("") || `
      <div class="library-empty">
        <strong>${loading ? "正在读取…" : "还没有可显示的本地作品"}</strong>
        <span>下载完成并写入 manifest 后，会自动出现在这里。</span>
      </div>
    `;
    $("librarySummary").textContent = `已显示 ${rows.length} / ${total} 个本地作品`;
    $("libraryLoadMore").hidden = !hasMore;
    $("libraryLoadMore").disabled = loading;
    $("libraryLoadMore").textContent = loading ? "加载中" : "加载更多";
  }

  async function loadLibrary(options = {}) {
    const append = Boolean(options.append);
    if (append && requests.inFlight) return;
    const querySnapshot = currentQuerySnapshot();
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(append ? offset : 0),
    });
    const search = querySnapshot;
    if (search) params.set("q", search);
    if (!append) {
      rows = [];
      total = 0;
      offset = 0;
      hasMore = false;
    }
    const request = requests.begin(querySnapshot);
    loading = true;
    renderLibrary();
    try {
      const result = await api(`/api/library?${params.toString()}`, { signal: request.signal });
      if (!requests.canCommit(request, currentQuerySnapshot())) return;
      total = Number(result.total || 0);
      rows = append ? [...rows, ...(result.items || [])] : result.items || [];
      offset = Number(result.next_offset || 0);
      hasMore = Boolean(result.has_more);
    } catch (error) {
      if (!requests.canCommit(request, currentQuerySnapshot())) return;
      throw error;
    } finally {
      if (requests.finish(request)) {
        loading = false;
        renderLibrary();
      }
    }
  }

  function openPlayer(item) {
    if (!item?.id) return;
    window.location.assign(`/short-videos/${encodeURIComponent(item.id)}`);
  }

  function showLibraryPage() {
    showPage();
    loadLibrary().catch((err) => toast(err.message));
  }

  function bind() {
    $("openLibraryQuick").addEventListener("click", showLibraryPage);
    $("openLibraryHome").addEventListener("click", showLibraryPage);
    $("libraryRefresh").addEventListener("click", () => loadLibrary().catch((err) => toast(err.message)));
    $("libraryLoadMore").addEventListener("click", () => loadLibrary({ append: true }).catch((err) => toast(err.message)));
    $("librarySearch").addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => loadLibrary().catch((err) => toast(err.message)), 250);
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
      const item = rows.find((row) => Number(row.id) === Number(card.dataset.libraryOpen));
      if (item) openPlayer(item);
    });
    $("libraryGrid").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const card = event.target.closest("[data-library-open]");
      if (!card) return;
      event.preventDefault();
      const item = rows.find((row) => Number(row.id) === Number(card.dataset.libraryOpen));
      if (item) openPlayer(item);
    });
  }

  function render() {}

  return { bind, render, activate: loadLibrary };
}
