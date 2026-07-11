import { absoluteUrl, loadPreviewImage } from "../../../js/image.js?v=20260706-mobile-web-sync-01";
import { formatCompact } from "../../../js/format.js";
import { AUTHOR_INITIAL_COUNT, DEFAULT_LIMIT, DEFAULT_SORT, DEFAULT_SOURCE, SHORT_VIDEO_SORT_OPTIONS, formatDate, formatDuration, initials, normalizeSort, normalizeSource, selectOption, shortVideoSortLabel } from "../shared.js";
export function createShortVideoListView(context = {}) {
  const { browserState, els, getActiveUrl, listState, openSettings, showView } = context;
  const activeLibraryGroup = (...args) => context.activeLibraryGroup(...args);
  const appendVisibleAuthors = (...args) => context.appendVisibleAuthors(...args);
  const createIcon = (...args) => context.createIcon(...args);
  const currentAuthorFacet = (...args) => context.currentAuthorFacet(...args);
  const isAuthorFeedView = (...args) => context.isAuthorFeedView(...args);
  const isAuthorIndexView = (...args) => context.isAuthorIndexView(...args);
  const observeListLoadMore = (...args) => context.observeListLoadMore(...args);
  const openShortVideoFromList = (...args) => context.openShortVideoFromList(...args);
  const requestVideoFirstFrame = (...args) => context.requestVideoFirstFrame(...args);
  const resetListLoadMoreObserver = (...args) => context.resetListLoadMoreObserver(...args);
  const shortVideoAuthorFilterValue = (...args) => context.shortVideoAuthorFilterValue(...args);
  const showAuthorPanel = (...args) => context.showAuthorPanel(...args);
  const sortedAuthorFacets = (...args) => context.sortedAuthorFacets(...args);
  const updateListParams = (...args) => context.updateListParams(...args);
  function renderListShell() {
    els.viewContent.innerHTML = "";
    resetListLoadMoreObserver();
    const shell = document.createElement("section");
    shell.className = "short-video-mobile-list";
    bindSettingsLongPress(shell);
    shell.append(renderLibraryTabs(), renderListToolbar());
    if (isAuthorIndexView()) {
      shell.append(renderAuthorIndex());
      els.viewContent.append(shell);
      return;
    }
    if (listState.status && !(listState.data?.videos || []).length) {
      const status = document.createElement("div");
      status.className = "short-video-mobile-status";
      status.textContent = listState.status;
      shell.append(status);
    }
    const grid = document.createElement("div");
    grid.className = "short-video-mobile-grid";
    for (const video of listState.data?.videos || []) {
      grid.append(renderCard(video));
    }
    if (!(listState.data?.videos || []).length) {
      const empty = document.createElement("div");
      empty.className = "short-video-mobile-empty";
      empty.textContent = listState.loading
        ? "正在读取短视频"
        : listState.status || "没有匹配的视频";
      grid.append(empty);
    }
    shell.append(grid);
    if (listState.data?.hasMore) {
      const sentinel = document.createElement("div");
      sentinel.className = "short-video-mobile-load-more";
      sentinel.setAttribute("aria-hidden", "true");
      shell.append(sentinel);
      observeListLoadMore(sentinel);
    }
    els.viewContent.append(shell);
  }

  function renderLibraryTabs() {
    const navigation = document.createElement("div");
    navigation.className = "short-video-mobile-tabs";
    const tabs = document.createElement("div");
    tabs.className = "short-video-mobile-tab-list";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "短视频分组");
    const activeGroup = activeLibraryGroup();
    for (const [value, label] of [["all", "全部"], ["liked", "我的喜欢"], ["authors", "作者"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-mobile-tab";
      const active = activeGroup === value;
      button.classList.toggle("active", active);
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(active));
      button.textContent = label;
      button.addEventListener("click", () => {
        if (active && !(value === "authors" && isAuthorFeedView())) return;
        showView("shortVideos", {
          query: "",
          author: "all",
          source: value,
          sort: listState.sort || DEFAULT_SORT
        }, { resetStack: true });
      });
      tabs.append(button);
    }
    navigation.append(tabs);
    if (!isAuthorIndexView()) {
      const sortWrap = document.createElement("label");
      sortWrap.className = "short-video-mobile-sort-wrap";
      sortWrap.setAttribute("aria-label", "短视频排序");
      const sort = document.createElement("select");
      sort.className = "short-video-mobile-sort";
      sort.setAttribute("aria-label", "短视频排序");
      for (const item of SHORT_VIDEO_SORT_OPTIONS) sort.append(selectOption(item[0], item[1]));
      sort.value = listState.sort || DEFAULT_SORT;
      sort.addEventListener("change", () => updateListParams({ sort: sort.value || DEFAULT_SORT }));
      sortWrap.append(sort);
      navigation.append(sortWrap);
    }
    return navigation;
  }

  function renderListToolbar() {
    const toolbar = document.createElement("div");
    toolbar.className = "short-video-mobile-toolbar";
    const copy = document.createElement("div");
    copy.className = "short-video-mobile-toolbar-copy";
    const meta = document.createElement("span");
    if (isAuthorIndexView()) {
      meta.textContent = listState.loading && !(listState.data?.authors || []).length
        ? "正在读取作者"
        : `${formatCompact(sortedAuthorFacets({ ignoreQuery: true }).length)} 位作者`;
    } else if (isAuthorFeedView()) {
      const author = currentAuthorFacet();
      const title = document.createElement("strong");
      title.textContent = author.name || "作者作品";
      meta.textContent = `${formatCompact(listState.data?.total || 0)} 条作品`;
      const back = document.createElement("button");
      back.type = "button";
      back.className = "short-video-mobile-author-back";
      back.setAttribute("aria-label", "返回作者列表");
      back.append(createIcon("chevronLeft"));
      back.addEventListener("click", () => {
        showView("shortVideos", { query: "", author: "all", source: "authors", sort: listState.sort }, { resetStack: true });
      });
      toolbar.append(back);
      copy.append(title);
    } else {
      meta.textContent = listState.loading && !listState.data
        ? "正在读取"
        : `${formatCompact(listState.data?.total || 0)} 条`;
    }
    copy.append(meta);
    toolbar.append(copy);
    if (listState.query) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "short-video-mobile-query-clear";
      clear.textContent = `清除“${listState.query}”`;
      clear.addEventListener("click", () => updateListParams({ query: "" }));
      toolbar.append(clear);
    }
    return toolbar;
  }

  function bindSettingsLongPress(target) {
    if (!target || typeof openSettings !== "function") return;
    let timer = 0;
    let startX = 0;
    let startY = 0;
    let fired = false;
    const blocked = (eventTarget) => Boolean(eventTarget?.closest?.("button, a, input, select, textarea, .short-video-mobile-card, .short-video-mobile-author-card"));
    const cancel = () => {
      if (timer) window.clearTimeout(timer);
      timer = 0;
    };
    target.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1 || blocked(event.target)) return;
      startX = event.touches[0].clientX;
      startY = event.touches[0].clientY;
      fired = false;
      cancel();
      timer = window.setTimeout(() => {
        fired = true;
        navigator.vibrate?.(18);
        openSettings();
      }, 560);
    }, { passive: true });
    target.addEventListener("touchmove", (event) => {
      const touch = event.touches[0];
      if (!touch || Math.hypot(touch.clientX - startX, touch.clientY - startY) > 12) cancel();
    }, { passive: true });
    target.addEventListener("touchend", cancel, { passive: true });
    target.addEventListener("touchcancel", cancel, { passive: true });
    target.addEventListener("contextmenu", (event) => {
      if (blocked(event.target)) return;
      event.preventDefault();
      if (!fired) openSettings();
      fired = false;
    });
  }

  function renderAuthorIndex() {
    const wrap = document.createElement("div");
    wrap.className = "short-video-mobile-author-index";
    const authors = sortedAuthorFacets();
    if (listState.loading && !(listState.data?.authors || []).length) {
      for (let index = 0; index < 9; index += 1) {
        const skeleton = document.createElement("span");
        skeleton.className = "short-video-mobile-author-card is-loading";
        skeleton.setAttribute("aria-hidden", "true");
        wrap.append(skeleton);
      }
      return wrap;
    }
    if (!authors.length) {
      const status = document.createElement("div");
      status.className = "short-video-mobile-author-index-status";
      status.textContent = listState.query ? `没有匹配“${listState.query}”的作者` : "还没有作者数据";
      wrap.append(status);
      return wrap;
    }
    const visibleCount = Math.min(listState.authorVisibleCount || AUTHOR_INITIAL_COUNT, authors.length);
    for (const author of authors.slice(0, visibleCount)) wrap.append(renderAuthorIndexCard(author));
    if (visibleCount < authors.length) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "short-video-mobile-author-index-more";
      more.textContent = `继续加载（${formatCompact(visibleCount)} / ${formatCompact(authors.length)}）`;
      more.addEventListener("click", () => appendVisibleAuthors(true));
      wrap.append(more);
    }
    return wrap;
  }

  function renderAuthorIndexCard(author = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-mobile-author-card";
    button.setAttribute("aria-label", `查看 ${author.name || "未知作者"} 的作品`);
    const avatar = document.createElement("span");
    avatar.className = "short-video-mobile-author-card-avatar";
    const imageUrl = author.avatarUrl || author.fallbackCoverUrl || "";
    if (imageUrl) {
      const img = document.createElement("img");
      img.src = absoluteUrl(getActiveUrl(), imageUrl);
      img.alt = author.name || "作者头像";
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => {
        img.remove();
        avatar.textContent = initials(author.name || "?");
      }, { once: true });
      avatar.append(img);
    } else {
      avatar.textContent = initials(author.name || "?");
    }
    const name = document.createElement("strong");
    name.textContent = author.name || "未知作者";
    const count = document.createElement("span");
    count.textContent = `${formatCompact(author.count || 0)} 条视频`;
    button.append(avatar, name, count);
    bindReliableTap(button, () => showAuthorPanel({ authorFilter: shortVideoAuthorFilterValue(author), author }));
    return button;
  }

  function renderSearchFilters(form, onSubmit = null) {
    if (!form) return;
    const existing = form.querySelector(".short-video-search-filters");
    if (existing) existing.remove();
    const filters = document.createElement("div");
    filters.className = "short-video-search-filters";

    const source = document.createElement("select");
    source.dataset.shortVideoSearchSource = "1";
    source.setAttribute("aria-label", "短视频分组");
    for (const item of [
      ["all", "全部"],
      ["liked", "我的喜欢"],
      ["authors", "作者"]
    ]) source.append(selectOption(item[0], item[1]));
    source.value = activeLibraryGroup();

    const sort = document.createElement("select");
    sort.dataset.shortVideoSearchSort = "1";
    sort.setAttribute("aria-label", "短视频排序");
    for (const item of SHORT_VIDEO_SORT_OPTIONS) sort.append(selectOption(item[0], item[1]));
    sort.value = listState.sort || DEFAULT_SORT;

    const apply = () => {
      listState.sort = sort.value || DEFAULT_SORT;
      if (onSubmit) onSubmit();
    };
    source.addEventListener("change", apply);
    sort.addEventListener("change", apply);
    filters.append(source, sort);
    form.append(filters);
    listState.searchFiltersEl = filters;
  }

  function renderCard(video) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "short-video-mobile-card";
    bindReliableTap(card, () => openShortVideoFromList(video));
    const thumb = document.createElement("div");
    thumb.className = "short-video-mobile-thumb";
    if (video.coverUrl) {
      const placeholder = document.createElement("span");
      placeholder.textContent = "PLAY";
      thumb.append(placeholder);
      loadPreviewImage(placeholder, absoluteUrl(getActiveUrl(), video.coverUrl), {
        cacheBaseUrl: getActiveUrl(),
        decorate: (img) => {
          img.alt = video.title || "短视频封面";
        }
      }).catch(() => {});
    } else if (video.streamUrl) {
      const frame = document.createElement("span");
      frame.dataset.shortVideoFrameId = video.id || "";
      thumb.append(frame);
      requestVideoFirstFrame(video).catch(() => {});
    } else {
      const fallback = document.createElement("span");
      fallback.textContent = "PLAY";
      thumb.append(fallback);
    }
    const metric = document.createElement("span");
    metric.className = "short-video-mobile-thumb-metric";
    metric.append(createIcon("heart"), document.createTextNode(formatCompact(video.stats?.likes || 0)));
    thumb.append(metric);
    const galleryCount = String(video.mediaType || "").toLowerCase() === "gallery"
      ? Number(video.galleryCount || video.galleryImages?.length || 0)
      : 0;
    if (galleryCount > 0) {
      const badge = document.createElement("span");
      badge.className = "short-video-mobile-thumb-type";
      badge.textContent = `图文 · ${galleryCount}`;
      thumb.append(badge);
    }
    card.setAttribute("aria-label", video.title || (galleryCount > 0 ? "打开图文作品" : "打开短视频"));
    card.append(thumb);
    return card;
  }

  function bindReliableTap(element, action) {
    let touchStart = null;
    let opened = false;
    const open = () => {
      if (opened) return;
      opened = true;
      Promise.resolve(action?.()).finally(() => {
        window.setTimeout(() => {
          opened = false;
        }, 420);
      });
    };
    element.addEventListener("click", (event) => {
      event.preventDefault();
      open();
    });
    element.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 1) {
        touchStart = null;
        return;
      }
      const touch = event.touches[0];
      touchStart = {
        x: touch.clientX,
        y: touch.clientY,
        at: Date.now()
      };
    }, { passive: true });
    element.addEventListener("touchend", (event) => {
      if (!touchStart || event.changedTouches.length !== 1) return;
      const touch = event.changedTouches[0];
      const dx = Math.abs(touch.clientX - touchStart.x);
      const dy = Math.abs(touch.clientY - touchStart.y);
      const elapsed = Date.now() - touchStart.at;
      touchStart = null;
      if (dx > 14 || dy > 14 || elapsed > 850) return;
      event.preventDefault();
      open();
    }, { passive: false });
    element.addEventListener("touchcancel", () => {
      touchStart = null;
    }, { passive: true });
  }

  return {
    renderListShell,
    renderLibraryTabs,
    renderListToolbar,
    renderAuthorIndex,
    renderAuthorIndexCard,
    renderSearchFilters,
    renderCard,
    bindReliableTap
  };
}
