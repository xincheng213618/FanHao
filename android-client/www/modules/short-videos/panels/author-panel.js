import { absoluteUrl, loadPreviewImage } from "../../../js/image.js?v=20260706-mobile-web-sync-01";
import { formatCompact } from "../../../js/format.js";
import { AUTHOR_PAGE_LIMIT, DEFAULT_SORT, SHORT_VIDEO_SORT_OPTIONS, formatDate, formatDuration, initials, normalizeSort, selectOption, shortVideoSortLabel } from "../shared.js";
export function createShortVideoAuthorPanel(context = {}) {
  const { api, getActiveUrl, listState, showView } = context;
  let authorPanelEl = null;
  let authorPanelLoadObserver = null;
  const bindReliableTap = (...args) => context.bindReliableTap(...args);
  const openNativeShortVideoFeed = (...args) => context.openNativeShortVideoFeed(...args);
  const shortVideoAuthorFilterValue = (...args) => context.shortVideoAuthorFilterValue(...args);
  const shortVideoErrorMessage = (...args) => context.shortVideoErrorMessage(...args);
  function closeAuthorPanel() {
    if (!authorPanelEl) return;
    authorPanelLoadObserver?.disconnect?.();
    authorPanelLoadObserver = null;
    authorPanelEl.remove();
    authorPanelEl = null;
  }

  function shortVideoToast(message) {
    const existing = document.querySelector(".short-video-mobile-toast");
    if (existing) existing.remove();
    const toast = document.createElement("div");
    toast.className = "short-video-mobile-toast";
    toast.textContent = message;
    document.body.append(toast);
    window.setTimeout(() => toast.remove(), 2200);
  }

  async function viewAuthorVideos(secUid, sort = DEFAULT_SORT) {
    if (!secUid) return;
    closeAuthorPanel();
    showView("shortVideos", { query: "", author: secUid, source: "all", sort: sort || DEFAULT_SORT }, { push: true });
  }

  function showAuthorPanel(video, options = {}) {
    const secUid = String(video?.secUid || video?.author?.secUid || "").trim();
    const authorName = String(video?.author?.name || "").trim();
    const authorFilter = String(video?.authorFilter || secUid || (authorName ? `name:${authorName}` : "")).trim();
    if (!authorFilter) {
      shortVideoToast("该视频没有可识别的作者信息");
      return;
    }
    closeAuthorPanel();
    const author = { ...(video?.author || {}), secUid };
    const name = author.name || "未知作者";
    const avatarUrl = author.avatarUrl || "";
    const panelState = {
      author,
      authorFilter,
      videos: [],
      total: 0,
      hasMore: false,
      offset: 0,
      loading: false,
      sort: normalizeSort(options.sort || listState.sort || DEFAULT_SORT)
    };
    if (panelState.videos.length && !panelState.total) panelState.total = panelState.videos.length;

    const overlay = document.createElement("div");
    overlay.className = "short-video-mobile-author-panel";
    ["touchstart", "touchmove", "touchend", "wheel", "click"].forEach((ev) =>
      overlay.addEventListener(ev, (event) => event.stopPropagation(), { passive: false })
    );
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeAuthorPanel();
    });
    let panelTouchStartX = 0;
    let panelTouchStartY = 0;
    let panelTouchDeltaX = 0;
    let panelTouchDeltaY = 0;
    overlay.addEventListener("touchstart", (event) => {
      const touch = event.touches?.[0];
      panelTouchStartX = touch?.clientX || 0;
      panelTouchStartY = touch?.clientY || 0;
      panelTouchDeltaX = 0;
      panelTouchDeltaY = 0;
    }, { passive: true });
    overlay.addEventListener("touchmove", (event) => {
      const touch = event.touches?.[0];
      panelTouchDeltaX = (touch?.clientX || 0) - panelTouchStartX;
      panelTouchDeltaY = (touch?.clientY || 0) - panelTouchStartY;
      if (isHorizontalSwipe(panelTouchDeltaX, panelTouchDeltaY, 28)) event.preventDefault();
    }, { passive: false });
    overlay.addEventListener("touchend", () => {
      if (isHorizontalSwipe(panelTouchDeltaX, panelTouchDeltaY, 72) && panelTouchDeltaX > 0) closeAuthorPanel();
      panelTouchDeltaX = 0;
      panelTouchDeltaY = 0;
    });

    const sheet = document.createElement("div");
    sheet.className = "author-sheet";

    const header = document.createElement("div");
    header.className = "author-sheet-header";
    const avatar = document.createElement("span");
    avatar.className = "short-video-mobile-author-avatar author-sheet-avatar";
    if (avatarUrl) {
      const img = document.createElement("img");
      img.src = avatarUrl;
      img.alt = name;
      avatar.append(img);
    } else {
      avatar.textContent = initials(name || "?");
    }
    const info = document.createElement("div");
    info.className = "author-sheet-info";
    const nameEl = document.createElement("strong");
    nameEl.textContent = `@${name}`;
    const handle = document.createElement("span");
    handle.textContent = authorProfileLineText(author) || (secUid ? `抖音号 ${secUid}` : "本地作者资料");
    const signature = document.createElement("span");
    signature.className = "author-sheet-signature";
    signature.textContent = String(author.signature || "").trim();
    signature.hidden = !signature.textContent;
    const stats = document.createElement("div");
    stats.className = "author-sheet-stats";
    renderAuthorStats(stats, author);
    info.append(nameEl, handle, signature, stats);
    header.append(avatar, info);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "author-sheet-close";
    closeBtn.setAttribute("aria-label", "关闭");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => closeAuthorPanel());

    const actions = document.createElement("div");
    actions.className = "author-sheet-actions";
    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = "author-sheet-action is-primary";
    allBtn.textContent = "只看 TA";
    allBtn.addEventListener("click", () => viewAuthorVideos(authorFilter, panelState.sort));
    const douyinBtn = document.createElement("button");
    douyinBtn.type = "button";
    douyinBtn.className = "author-sheet-action";
    douyinBtn.textContent = "抖音主页";
    douyinBtn.disabled = !authorDouyinUrl(author);
    douyinBtn.addEventListener("click", () => openAuthorDouyinLink(author));
    actions.append(allBtn, douyinBtn);

    const controls = document.createElement("div");
    controls.className = "author-sheet-controls";
    const sortSelect = document.createElement("select");
    sortSelect.setAttribute("aria-label", "作者作品排序");
    for (const item of SHORT_VIDEO_SORT_OPTIONS) sortSelect.append(selectOption(item[0], item[1]));
    sortSelect.value = panelState.sort;
    controls.append(sortSelect);

    const content = document.createElement("div");
    content.className = "author-sheet-content";
    const status = document.createElement("div");
    status.className = "author-sheet-status";
    status.textContent = "正在读取作品";
    const grid = document.createElement("div");
    grid.className = "author-sheet-grid";
    const sentinel = document.createElement("div");
    sentinel.className = "author-sheet-load-more";
    sentinel.setAttribute("aria-hidden", "true");
    content.append(status, grid, sentinel);

    const refreshHeader = () => {
      const richer = panelState.videos.find((item) => authorHasProfileMeta(item.author))?.author || panelState.videos[0]?.author;
      if (richer) Object.assign(author, richer, { secUid });
      nameEl.textContent = `@${author.name || name}`;
      handle.textContent = authorProfileLineText(author) || (secUid ? `抖音号 ${secUid}` : "本地作者资料");
      signature.textContent = String(author.signature || "").trim();
      signature.hidden = !signature.textContent;
      renderAuthorStats(stats, author);
      douyinBtn.disabled = !authorDouyinUrl(author);
    };

    const renderWorks = () => {
      refreshHeader();
      grid.textContent = "";
      for (const item of panelState.videos) {
        grid.append(renderAuthorVideoTile(item, panelState));
      }
      status.textContent = panelState.loading
        ? "正在读取作品"
        : panelState.total
          ? `${formatAuthorNumber(panelState.videos.length)} / ${formatAuthorNumber(panelState.total)} 个作品`
          : "没有本地作品";
      sentinel.hidden = !panelState.hasMore;
    };

    const loadAuthorPage = async (options = {}) => {
      if (panelState.loading) return;
      if (options.append && !panelState.hasMore) return;
      panelState.loading = true;
      renderWorks();
      try {
        const params = new URLSearchParams();
        params.set("author", authorFilter);
        params.set("source", "all");
        params.set("sort", panelState.sort || DEFAULT_SORT);
        params.set("limit", String(AUTHOR_PAGE_LIMIT));
        params.set("facets", "0");
        params.set("stats", "0");
        if (options.append) params.set("offset", String(panelState.videos.length));
        const data = await api.fetchCached(getActiveUrl(), `/api/short-videos?${params}`, {
          timeoutMs: 16000,
          cacheMaxAgeMs: options.append ? 2 * 60 * 1000 : 5 * 60 * 1000
        });
        const incoming = data.videos || [];
        if (options.append) {
          const seen = new Set(panelState.videos.map((item) => item.id));
          for (const item of incoming) {
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            panelState.videos.push(item);
          }
        } else {
          panelState.videos = incoming;
        }
        panelState.total = Number(data.total || panelState.videos.length || 0);
        panelState.hasMore = Boolean(data.hasMore);
        panelState.offset = panelState.videos.length;
        panelState.loading = false;
        renderWorks();
      } catch (error) {
        panelState.loading = false;
        status.textContent = shortVideoErrorMessage(error, "作者作品读取失败，请稍后重试");
      }
    };

    sortSelect.addEventListener("change", () => {
      panelState.sort = normalizeSort(sortSelect.value);
      panelState.videos = [];
      panelState.total = 0;
      panelState.hasMore = false;
      panelState.offset = 0;
      loadAuthorPage().catch(() => {});
    });

    sheet.append(header, closeBtn, actions, controls, content);
    overlay.append(sheet);
    document.body.append(overlay);
    authorPanelEl = overlay;
    observeAuthorLoadMore(sentinel, sheet, () => loadAuthorPage({ append: true }));
    loadAuthorPage().catch(() => {});
  }

  function observeAuthorLoadMore(sentinel, root, loadMore) {
    authorPanelLoadObserver?.disconnect?.();
    authorPanelLoadObserver = null;
    if (!sentinel || !("IntersectionObserver" in window)) return;
    authorPanelLoadObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      loadMore().catch(() => {});
    }, { root, rootMargin: "160px 0px", threshold: 0.01 });
    authorPanelLoadObserver.observe(sentinel);
  }

  function renderAuthorVideoTile(video, panelState) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "author-sheet-tile";
    button.setAttribute("aria-label", video.title || "打开短视频");

    const media = document.createElement("span");
    media.className = "author-sheet-tile-media";
    const coverUrl = video.coverUrl || "";
    if (coverUrl) {
      const placeholder = document.createElement("span");
      placeholder.textContent = "PLAY";
      media.append(placeholder);
      loadPreviewImage(placeholder, absoluteUrl(getActiveUrl(), coverUrl), {
        cacheBaseUrl: getActiveUrl(),
        decorate: (img) => {
          img.alt = video.title || "短视频封面";
        }
      }).catch(() => {});
    } else {
      const placeholder = document.createElement("span");
      placeholder.textContent = "PLAY";
      media.append(placeholder);
    }

    const badge = document.createElement("span");
    badge.className = "author-sheet-tile-badge";
    badge.textContent = formatCompact(video.stats?.likes || 0);
    media.append(badge);
    const title = document.createElement("span");
    title.className = "author-sheet-tile-title";
    title.textContent = video.title || formatDate(video.publishedAt) || "未命名视频";
    button.append(media, title);
    bindReliableTap(button, () => openAuthorPanelVideo(video, panelState));
    return button;
  }

  async function openAuthorPanelVideo(video, panelState) {
    const secUid = panelState.author?.secUid || video.author?.secUid || "";
    const authorFilter = panelState.authorFilter || secUid || shortVideoAuthorFilterValue(video.author || {});
    const videosSnapshot = panelState.videos.map(cloneShortVideo);
    const opened = await openNativeShortVideoFeed(video, {
      videos: videosSnapshot,
      hasMore: panelState.hasMore,
      query: "",
      author: authorFilter || "all",
      source: "all",
      sort: panelState.sort || DEFAULT_SORT
    });
    if (!opened) shortVideoToast("当前设备无法打开原生短视频播放器");
  }

  function cloneShortVideo(video = {}) {
    return {
      ...video,
      author: { ...(video.author || {}) },
      stats: { ...(video.stats || {}) }
    };
  }

  function authorProfileLineText(author = {}) {
    const parts = [];
    const douyinId = String(author.shortId || author.uniqueId || "").trim();
    if (douyinId) parts.push(`抖音号 ${douyinId}`);
    const ip = String(author.ipLocation || "").trim().replace(/^IP属地[:：]?\s*/u, "");
    if (ip) parts.push(`IP ${ip}`);
    const verification = String(author.verification || "").trim();
    if (verification) parts.push(verification);
    if (!parts.length && author.secUid) parts.push(`抖音号 ${author.secUid}`);
    return parts.join(" · ");
  }

  function authorHasProfileMeta(author = {}) {
    return Boolean(authorProfileLineText(author) || String(author.signature || "").trim() || authorStatItems(author).length);
  }

  function authorStatItems(author = {}) {
    return [
      ["关注", authorProfileNumber(author.followingCount)],
      ["粉丝", authorProfileNumber(author.followerCount)],
      ["获赞", authorProfileNumber(author.totalFavorited)],
      ["作品", authorProfileNumber(author.awemeCount)]
    ].filter((item) => item[1] !== null);
  }

  function renderAuthorStats(target, author = {}) {
    target.textContent = "";
    const items = authorStatItems(author);
    target.hidden = !items.length;
    for (const [label, value] of items) {
      const cell = document.createElement("span");
      const strong = document.createElement("b");
      strong.textContent = formatCompact(value);
      const small = document.createElement("small");
      small.textContent = label;
      cell.append(strong, small);
      target.append(cell);
    }
  }

  function authorProfileNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
  }

  function formatAuthorNumber(value) {
    const number = Number(value || 0);
    return Number.isFinite(number) ? number.toLocaleString("zh-CN") : "0";
  }

  function authorDouyinUrl(author = {}) {
    const url = String(author.profileUrl || "").trim();
    if (url) return url;
    const secUid = String(author.secUid || "").trim();
    return secUid ? `https://www.douyin.com/user/${encodeURIComponent(secUid)}` : "";
  }

  function openAuthorDouyinLink(author = {}) {
    const url = authorDouyinUrl(author);
    if (url) window.open(url, "_system");
  }

  function isHorizontalSwipe(deltaX, deltaY, threshold) {
    return Math.abs(deltaX) >= threshold && Math.abs(deltaX) > Math.abs(deltaY) * 1.25;
  }

  return {
    closeAuthorPanel,
    shortVideoToast,
    viewAuthorVideos,
    showAuthorPanel,
    observeAuthorLoadMore,
    renderAuthorVideoTile,
    openAuthorPanelVideo,
    cloneShortVideo,
    authorProfileLineText,
    authorHasProfileMeta,
    authorStatItems,
    renderAuthorStats,
    authorProfileNumber,
    formatAuthorNumber,
    authorDouyinUrl,
    openAuthorDouyinLink
  };
}
