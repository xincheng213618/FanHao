import { loadPreviewImage } from "../../../js/image.js?v=20260706-mobile-web-sync-01";
import { formatCompact } from "../../../js/format.js";
import { AUTHOR_APPEND_COUNT, AUTHOR_INITIAL_COUNT, DEFAULT_LIMIT, DEFAULT_SORT, DEFAULT_SOURCE, SHORT_VIDEO_SORT_OPTIONS, formatDate, formatDuration, initials, normalizeSort, normalizeSource, selectOption, shortVideoSortLabel } from "../shared.js";
export function createShortVideoListController(context = {}) {
  const { api, browserState, els, getActiveUrl, goBack, listState, setActiveBottom, showView } = context;
  let listLoadMoreObserver = null;
  const openNativeShortVideoFeed = (...args) => context.openNativeShortVideoFeed(...args);
  const renderListShell = (...args) => context.renderListShell(...args);
  const shortVideoApiSource = (...args) => context.shortVideoApiSource(...args);
  const shortVideoBrowserParams = (...args) => context.shortVideoBrowserParams(...args);
  const shortVideoErrorMessage = (...args) => context.shortVideoErrorMessage(...args);
  function applyListParams(params = {}) {
    const nextQuery = String(params.query || params.q || "").trim();
    let nextAuthor = String(params.author || "all").trim() || "all";
    let nextSource = normalizeSource(params.source || params.origin);
    const nextSort = normalizeSort(params.sort);
    if (nextSource === "authors") nextAuthor = "all";
    if (nextAuthor === "all" && !["liked", "authors"].includes(nextSource)) nextSource = DEFAULT_SOURCE;
    const scopeChanged = nextQuery !== listState.query
      || nextAuthor !== listState.author
      || nextSource !== listState.source
      || nextSort !== listState.sort;
    listState.query = nextQuery;
    listState.author = nextAuthor;
    listState.source = nextSource;
    listState.sort = nextSort;
    if (scopeChanged) {
      listState.data = null;
      listState.status = "";
      listState.authorVisibleCount = AUTHOR_INITIAL_COUNT;
    }
  }

  async function loadList(renderGuard = null, options = {}) {
    const append = Boolean(options.append);
    if (append && (listState.loading || listState.loadingMore || !listState.data?.hasMore)) return;
    const requestUrl = getActiveUrl();
    const params = new URLSearchParams();
    if (listState.query) params.set("q", listState.query);
    if (listState.author && listState.author !== "all") params.set("author", listState.author);
    params.set("source", shortVideoApiSource());
    params.set("sort", listState.sort || DEFAULT_SORT);
    params.set("limit", String(isAuthorIndexView() ? 1 : DEFAULT_LIMIT));
    params.set("facets", isAuthorIndexView() ? "1" : "0");
    params.set("stats", "0");
    if (append) params.set("offset", String(listState.data?.videos?.length || 0));
    if (append) {
      listState.loadingMore = true;
    } else {
      listState.loading = true;
      listState.status = listState.data ? "" : "正在读取短视频";
    }
    renderListShell();
    try {
      const data = await api.fetch(requestUrl, `/api/short-videos?${params}`, { timeoutMs: 16000 });
      if (renderGuard && !renderGuard()) return;
      if (append && listState.data) {
        const seen = new Set((listState.data.videos || []).map((video) => video.id));
        const merged = [...(listState.data.videos || [])];
        for (const video of data.videos || []) {
          if (seen.has(video.id)) continue;
          seen.add(video.id);
          merged.push(video);
        }
        listState.data = { ...data, videos: merged, offset: 0, limit: merged.length };
      } else {
        listState.data = data;
      }
      if (!isAuthorIndexView()) listState.source = normalizeSource(data.source || listState.source);
      listState.loading = false;
      listState.loadingMore = false;
      listState.status = data.total ? "" : "还没有短视频。";
      renderListShell();
      if (!append && options.autoOpenFirst) {
        const first = data.videos?.[0];
        if (first) await openShortVideoFromList(first, { replace: Boolean(options.replaceOpen) });
      }
    } catch (error) {
      if (renderGuard && !renderGuard()) return;
      listState.loading = false;
      listState.loadingMore = false;
      listState.status = shortVideoErrorMessage(error, "短视频读取失败，请检查服务连接");
      renderListShell();
    }
  }

  function sortedAuthorFacets(options = {}) {
    const query = options.ignoreQuery ? "" : listState.query.toLocaleLowerCase("zh-CN");
    return [...(listState.data?.authors || [])]
      .filter((author) => author && shortVideoAuthorFilterValue(author))
      .filter((author) => !query || `${author.name || ""} ${author.secUid || ""}`.toLocaleLowerCase("zh-CN").includes(query))
      .sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));
  }

  function appendVisibleAuthors(force = false) {
    if (!isAuthorIndexView()) return;
    const total = sortedAuthorFacets().length;
    const current = listState.authorVisibleCount || AUTHOR_INITIAL_COUNT;
    if (!total || current >= total) return;
    if (!force) {
      const doc = document.documentElement;
      const remaining = doc.scrollHeight - window.scrollY - window.innerHeight;
      if (remaining > 700) return;
    }
    listState.authorVisibleCount = Math.min(total, current + AUTHOR_APPEND_COUNT);
    renderListShell();
  }

  function currentAuthorFacet() {
    const filter = String(listState.author || "").trim();
    return (listState.data?.authors || []).find((author) => shortVideoAuthorFilterValue(author) === filter)
      || (listState.data?.videos || []).find((video) => video?.author)?.author
      || {};
  }

  function shortVideoAuthorFilterValue(author = {}) {
    const secUid = String(author.secUid || "").trim();
    if (secUid) return secUid;
    const name = String(author.name || "").trim();
    return name ? `name:${name}` : "";
  }

  function isAuthorIndexView() {
    return listState.source === "authors" && listState.author === "all";
  }

  function isAuthorFeedView() {
    return listState.author !== "all";
  }

  function activeLibraryGroup() {
    return isAuthorIndexView() || isAuthorFeedView() ? "authors" : "liked";
  }

  function updateListParams(patch = {}, navigation = {}) {
    const next = {
      query: listState.query,
      author: listState.author,
      source: listState.source,
      sort: listState.sort,
      ...patch
    };
    showView("shortVideos", next, { resetStack: true, skipHistory: true, replaceHistory: true, ...navigation });
  }

  function getSearchState() {
    return {
      query: listState.query || "",
      author: listState.author || "all",
      source: listState.source || DEFAULT_SOURCE,
      sort: listState.sort || DEFAULT_SORT,
      authors: listState.data?.authors || []
    };
  }

  function submitSearch(query = "", overrides = {}) {
    const group = overrides.source ?? selectedSearchFilterValue("source", activeLibraryGroup());
    const currentAuthor = overrides.author ?? (listState.author || "all");
    const author = group === "authors" ? currentAuthor : "all";
    const source = group === "authors"
      ? (author !== "all" ? "all" : "authors")
      : "liked";
    updateListParams({
      query: String(query || "").trim(),
      author,
      source,
      sort: overrides.sort ?? selectedSearchFilterValue("sort", listState.sort || DEFAULT_SORT)
    });
  }

  function selectedSearchFilterValue(kind, fallback) {
    const selector = kind === "author"
      ? "[data-short-video-search-author]"
      : kind === "source"
        ? "[data-short-video-search-source]"
        : "[data-short-video-search-sort]";
    return listState.searchFiltersEl?.querySelector?.(selector)?.value || fallback;
  }

  function clearSearchFilters(form) {
    form?.querySelector?.(".short-video-search-filters")?.remove();
    if (listState.searchFiltersEl && !listState.searchFiltersEl.isConnected) listState.searchFiltersEl = null;
  }

  function resetListLoadMoreObserver() {
    listLoadMoreObserver?.disconnect?.();
    listLoadMoreObserver = null;
  }

  function observeListLoadMore(sentinel) {
    if (!sentinel || !("IntersectionObserver" in window)) {
      if (listState.data?.hasMore) loadList(null, { append: true }).catch(() => {});
      return;
    }
    listLoadMoreObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (!listState.data?.hasMore || listState.loading || listState.loadingMore) return;
      loadList(null, { append: true }).catch((error) => {
        listState.loadingMore = false;
        listState.status = shortVideoErrorMessage(error, "加载失败，请稍后重试");
        renderListShell();
      });
    }, { root: null, rootMargin: "180px 0px", threshold: 0.01 });
    listLoadMoreObserver.observe(sentinel);
  }

  async function openShortVideoFromList(video, options = {}) {
    const opened = options.skipNative ? false : await openNativeShortVideoFeed(video);
    if (opened) return;
    showView("shortVideoBrowser", shortVideoBrowserParams(video.id), options.replace ? { skipHistory: true, replaceHistory: true } : { push: true });
  }

  return {
    applyListParams,
    loadList,
    sortedAuthorFacets,
    appendVisibleAuthors,
    currentAuthorFacet,
    shortVideoAuthorFilterValue,
    isAuthorIndexView,
    isAuthorFeedView,
    activeLibraryGroup,
    updateListParams,
    getSearchState,
    submitSearch,
    selectedSearchFilterValue,
    clearSearchFilters,
    resetListLoadMoreObserver,
    observeListLoadMore,
    openShortVideoFromList
  };
}
