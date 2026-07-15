import { absoluteUrl, loadPreviewImage } from "../../../js/image.js?v=20260706-mobile-web-sync-01";
import { formatCompact } from "../../../js/format.js";
import { DEFAULT_SORT, initials } from "../shared.js?v=20260713-follow-toggle-08";
import { renderFollowingAuthorTools } from "./following-view.js?v=20260713-follow-toggle-08";
export function createShortVideoListView(context = {}) {
  const { els, getActiveUrl, goBack, listState, openSettings, showView } = context;
  const appendVisibleAuthors = (...args) => context.appendVisibleAuthors(...args);
  const createIcon = (...args) => context.createIcon(...args);
  const clearSearchHistory = (...args) => context.clearSearchHistory(...args);
  const currentAuthorFacet = (...args) => context.currentAuthorFacet(...args);
  const fetchSearchSuggestions = (...args) => context.fetchSearchSuggestions(...args);
  const isAuthorFeedView = (...args) => context.isAuthorFeedView(...args);
  const isAuthorIndexView = (...args) => context.isAuthorIndexView(...args);
  const observeListLoadMore = (...args) => context.observeListLoadMore(...args);
  const openShortVideoFromList = (...args) => context.openShortVideoFromList(...args);
  const resetListLoadMoreObserver = (...args) => context.resetListLoadMoreObserver(...args);
  const openShortVideoAuthor = (...args) => context.openShortVideoAuthor(...args);
  const readSearchHistory = (...args) => context.readSearchHistory(...args);
  const sortedAuthorFacets = (...args) => context.sortedAuthorFacets(...args);
  const submitSearch = (...args) => context.submitSearch(...args);
  const updateListParams = (...args) => context.updateListParams(...args);
  let searchSuggestionTimer = 0;

  function renderListShell() {
    els.viewContent.innerHTML = "";
    resetListLoadMoreObserver();
    const shell = document.createElement("section");
    shell.className = "short-video-mobile-list";
    bindSettingsLongPress(shell);
    if (listState.searchPage) {
      shell.append(renderDedicatedSearchHeader());
      if (!listState.query) {
        shell.append(renderSearchLanding());
        els.viewContent.append(shell);
        return;
      }
      shell.append(renderSearchResultTabs(), renderSearchResultMeta());
      if (listState.searchTab === "all" && listState.searchAuthors.length) {
        shell.append(renderSearchAuthorMatches());
      }
    }
    const toolbar = listState.searchPage ? null : renderListToolbar();
    if (toolbar) shell.append(toolbar);
    if (isAuthorIndexView()) {
      if (listState.source === "following") {
        shell.append(renderFollowingAuthorTools({ listState, onChange: updateListParams }));
      }
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
    syncListLoadMoreSentinel(shell);
    els.viewContent.append(shell);
  }

  function appendListVideos(videos = []) {
    const shell = els.viewContent.querySelector(".short-video-mobile-list");
    const grid = shell?.querySelector(".short-video-mobile-grid");
    if (!shell || !grid || isAuthorIndexView()) return renderListShell();
    grid.querySelector(".short-video-mobile-empty")?.remove();
    for (const video of videos) grid.append(renderCard(video));
    syncListLoadMoreSentinel(shell);
  }

  function setListLoadingMore(loading, message = "") {
    const shell = els.viewContent.querySelector(".short-video-mobile-list");
    const sentinel = shell?.querySelector(".short-video-mobile-load-more");
    if (!sentinel) return;
    resetListLoadMoreObserver();
    sentinel.classList.toggle("is-loading", Boolean(loading));
    sentinel.textContent = loading ? "正在加载" : String(message || "");
    sentinel.toggleAttribute("aria-hidden", !sentinel.textContent);
    if (!loading && listState.data?.hasMore) observeListLoadMore(sentinel);
  }

  function syncListLoadMoreSentinel(shell) {
    resetListLoadMoreObserver();
    shell?.querySelector(".short-video-mobile-load-more")?.remove();
    if (!shell || !listState.data?.hasMore) return;
    const sentinel = document.createElement("div");
    sentinel.className = "short-video-mobile-load-more";
    sentinel.setAttribute("aria-hidden", "true");
    shell.append(sentinel);
    observeListLoadMore(sentinel);
  }

  function renderDedicatedSearchHeader() {
    const wrap = document.createElement("div");
    wrap.className = "short-video-search-page-head";
    const form = document.createElement("form");
    form.className = "short-video-search-page-form";
    form.setAttribute("role", "search");

    const back = document.createElement("button");
    back.type = "button";
    back.className = "short-video-search-page-back";
    back.setAttribute("aria-label", "返回短视频");
    back.append(createIcon("chevronLeft"));
    back.addEventListener("click", () => goBack());

    const field = document.createElement("div");
    field.className = "short-video-search-page-field";
    field.append(createIcon("search"));
    const input = document.createElement("input");
    input.type = "search";
    input.value = listState.query || "";
    input.placeholder = "搜作品、作者、话题";
    input.setAttribute("aria-label", "搜索短视频");
    input.autocomplete = "off";
    input.enterKeyHint = "search";

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "short-video-search-page-clear";
    clear.setAttribute("aria-label", "清除搜索内容");
    clear.append(createIcon("close"));
    clear.hidden = !input.value;
    field.append(input, clear);

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "short-video-search-page-submit";
    submit.textContent = "搜索";
    form.append(back, field, submit);

    const suggestions = document.createElement("div");
    suggestions.className = "short-video-search-suggestions";
    suggestions.hidden = true;

    const renderSuggestions = (items = []) => {
      suggestions.replaceChildren();
      const values = Array.isArray(items) ? items.filter((item) => item?.label || item?.query) : [];
      if (!values.length) {
        suggestions.hidden = true;
        return;
      }
      for (const item of values) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "short-video-search-suggestion";
        const icon = document.createElement("span");
        icon.className = "short-video-search-suggestion-kind";
        icon.textContent = item.kind === "author" ? "用户" : item.kind === "tag" ? "话题" : item.kind === "recent" ? "历史" : "作品";
        const copy = document.createElement("span");
        copy.className = "short-video-search-suggestion-copy";
        const label = document.createElement("strong");
        label.textContent = item.label || item.query;
        copy.append(label);
        if (item.detail) {
          const detail = document.createElement("small");
          detail.textContent = item.detail;
          copy.append(detail);
        }
        button.append(icon, copy, createIcon("chevronRight"));
        button.addEventListener("pointerdown", (event) => event.preventDefault());
        button.addEventListener("click", () => {
          input.value = item.query || item.label || "";
          submitSearch(input.value, { searchTab: item.kind === "author" ? "authors" : "all" });
          input.blur();
        });
        suggestions.append(button);
      }
      suggestions.hidden = false;
    };

    const requestSuggestions = (value) => {
      window.clearTimeout(searchSuggestionTimer);
      const query = String(value || "").trim();
      if (!query) {
        suggestions.hidden = true;
        return;
      }
      searchSuggestionTimer = window.setTimeout(async () => {
        try {
          const result = await fetchSearchSuggestions(query);
          if (!result || input.value.trim() !== query || !input.isConnected) return;
          renderSuggestions(result.suggestions || []);
        } catch {
          suggestions.hidden = true;
        }
      }, 220);
    };

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const query = input.value.trim();
      if (!query) return;
      suggestions.hidden = true;
      submitSearch(query, { searchTab: listState.searchTab, sort: listState.sort || DEFAULT_SORT });
      input.blur();
    });
    input.addEventListener("focus", () => requestSuggestions(input.value));
    input.addEventListener("input", () => {
      clear.hidden = !input.value;
      requestSuggestions(input.value);
    });
    input.addEventListener("blur", () => window.setTimeout(() => {
      if (!wrap.contains(document.activeElement)) suggestions.hidden = true;
    }, 80));
    clear.addEventListener("click", () => {
      input.value = "";
      clear.hidden = true;
      if (listState.query) submitSearch("", { searchTab: "all", remember: false });
      else {
        input.focus();
        suggestions.hidden = true;
      }
    });

    wrap.append(form, suggestions);
    if (!listState.query) requestAnimationFrame(() => input.focus());
    return wrap;
  }

  function renderSearchLanding() {
    const landing = document.createElement("section");
    landing.className = "short-video-search-landing";
    const history = readSearchHistory();
    if (history.length) {
      const head = document.createElement("div");
      head.className = "short-video-search-section-head";
      const title = document.createElement("strong");
      title.textContent = "搜索历史";
      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "清空";
      clear.addEventListener("click", () => {
        clearSearchHistory();
        landing.replaceWith(renderSearchLanding());
      });
      head.append(title, clear);
      const chips = document.createElement("div");
      chips.className = "short-video-search-history";
      for (const query of history) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.textContent = query;
        chip.addEventListener("click", () => submitSearch(query, { searchTab: "all" }));
        chips.append(chip);
      }
      landing.append(head, chips);
    }
    const prompt = document.createElement("div");
    prompt.className = "short-video-search-page-prompt";
    prompt.append(createIcon("search"));
    const title = document.createElement("strong");
    title.textContent = "搜索本地短视频";
    const copy = document.createElement("span");
    copy.textContent = "支持作品标题、文案、作者和话题";
    prompt.append(title, copy);
    landing.append(prompt);
    return landing;
  }

  function renderSearchResultTabs() {
    const tabs = document.createElement("div");
    tabs.className = "short-video-search-result-tabs";
    tabs.setAttribute("role", "tablist");
    for (const [value, label] of [["all", "综合"], ["videos", "视频"], ["authors", "用户"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.classList.toggle("active", listState.searchTab === value);
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(listState.searchTab === value));
      button.textContent = label;
      button.addEventListener("click", () => {
        if (listState.searchTab === value) return;
        updateListParams({
          searchTab: value,
          source: value === "authors" ? "authors" : "all",
          author: "all"
        });
      });
      tabs.append(button);
    }
    return tabs;
  }

  function renderSearchResultMeta() {
    const meta = document.createElement("div");
    meta.className = "short-video-search-result-meta";
    if (listState.loading) meta.textContent = `正在搜索“${listState.query}”`;
    else if (listState.searchTab === "authors") meta.textContent = `${formatCompact(listState.data?.total || 0)} 位相关用户`;
    else meta.textContent = `${formatCompact(listState.data?.total || 0)} 条相关内容`;
    return meta;
  }

  function renderSearchAuthorMatches() {
    const section = document.createElement("section");
    section.className = "short-video-search-authors";
    const head = document.createElement("div");
    head.className = "short-video-search-section-head";
    const title = document.createElement("strong");
    title.textContent = "相关用户";
    const more = document.createElement("button");
    more.type = "button";
    more.textContent = "查看全部";
    more.addEventListener("click", () => updateListParams({ searchTab: "authors", source: "authors", author: "all" }));
    head.append(title, more);
    const list = document.createElement("div");
    list.className = "short-video-search-author-list";
    for (const author of listState.searchAuthors) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "short-video-search-author-item";
      const avatar = document.createElement("span");
      avatar.className = "short-video-search-author-avatar";
      const imageUrl = author.avatarUrl || author.fallbackCoverUrl || "";
      if (imageUrl) {
        const image = document.createElement("img");
        image.src = absoluteUrl(getActiveUrl(), imageUrl);
        image.alt = "";
        image.loading = "lazy";
        image.addEventListener("error", () => {
          image.remove();
          avatar.textContent = initials(author.name || "?");
        }, { once: true });
        avatar.append(image);
      } else {
        avatar.textContent = initials(author.name || "?");
      }
      const copy = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = author.name || "未知作者";
      const count = document.createElement("small");
      count.textContent = `${formatCompact(author.count || 0)} 条作品`;
      copy.append(name, count);
      button.append(avatar, copy, createIcon("chevronRight"));
      button.addEventListener("click", () => openShortVideoAuthor(author));
      list.append(button);
    }
    section.append(head, list);
    return section;
  }

  function renderListToolbar() {
    if (isAuthorIndexView() || !isAuthorFeedView()) return null;
    const toolbar = document.createElement("div");
    toolbar.className = "short-video-mobile-toolbar author-context";
    const copy = document.createElement("div");
    copy.className = "short-video-mobile-toolbar-copy";
    if (isAuthorFeedView()) {
      const author = currentAuthorFacet();
      const title = document.createElement("strong");
      title.textContent = author.name || "作者作品";
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
    }
    toolbar.append(copy);
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
      status.textContent = listState.query
        ? `没有匹配“${listState.query}”的作者`
        : listState.source === "following" && listState.authorFilter === "unliked"
          ? "没有未点赞的关注账号"
          : listState.source === "following"
            ? "还没有关注账号"
            : "还没有作者数据";
      wrap.append(status);
      return wrap;
    }
    for (const author of authors) wrap.append(renderAuthorIndexCard(author));
    if (listState.data?.hasMore || listState.loadingMore) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "short-video-mobile-author-index-more";
      more.disabled = Boolean(listState.loadingMore);
      more.textContent = listState.loadingMore ? "正在加载更多作者" : "继续加载更多作者";
      more.addEventListener("click", () => appendVisibleAuthors(true));
      wrap.append(more);
    }
    return wrap;
  }

  function renderAuthorIndexCard(author = {}) {
    const card = document.createElement("article");
    card.className = "short-video-mobile-author-card";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "short-video-mobile-author-card-main";
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
    button.append(avatar, name);
    if (listState.source === "following") {
      const meta = document.createElement("small");
      meta.className = "short-video-mobile-author-card-meta";
      meta.textContent = `视频 ${formatCompact(author.count || 0)} · 喜欢 ${formatCompact(author.likedCount || 0)}`;
      button.append(meta);
    }
    bindReliableTap(button, () => openShortVideoAuthor(author));
    card.append(button);
    return card;
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
    } else {
      const fallback = document.createElement("span");
      fallback.textContent = "PLAY";
      thumb.append(fallback);
    }
    const metric = document.createElement("span");
    metric.className = "short-video-mobile-thumb-metric";
    const liked = Boolean(video.actions?.liked);
    metric.classList.toggle("is-liked", liked);
    metric.append(createIcon(liked ? "heart" : "heartOutline"), document.createTextNode(formatCompact(video.stats?.likes || 0)));
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
    element.addEventListener("touchcancel", () => { touchStart = null; }, { passive: true });
  }

  function shortVideoToast(message) {
    document.querySelector(".short-video-mobile-toast")?.remove();
    const toast = document.createElement("div");
    toast.className = "short-video-mobile-toast";
    toast.textContent = message;
    document.body.append(toast);
    window.setTimeout(() => toast.remove(), 2200);
  }

  return {
    renderListShell,
    appendListVideos,
    setListLoadingMore,
    renderListToolbar,
    renderAuthorIndex,
    renderAuthorIndexCard,
    renderCard,
    bindReliableTap,
    shortVideoToast
  };
}
