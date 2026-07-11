import { AUTHOR_APPEND_COUNT, AUTHOR_INITIAL_COUNT, DEFAULT_LIMIT, DEFAULT_SORT, DEFAULT_SOURCE, normalizeSearchTab, normalizeSort, normalizeSource } from "../shared.js";
export function createShortVideoListController(context = {}) {
  const { api, getActiveUrl, listState, showView } = context;
  let listLoadMoreObserver = null;
  let listEventsInstalled = false;
  const openNativeShortVideoFeed = (...args) => context.openNativeShortVideoFeed(...args);
  const renderListShell = (...args) => context.renderListShell(...args);
  const shortVideoToast = (...args) => context.shortVideoToast(...args);

  function shortVideoApiSource() {
    const source = normalizeSource(listState.source);
    return source === "authors" ? "liked" : source;
  }
  function applyListParams(params = {}) {
    const nextQuery = String(params.query || params.q || "").trim();
    let nextAuthor = String(params.author || "all").trim() || "all";
    let nextSource = normalizeSource(params.source || params.origin);
    const nextSort = normalizeSort(params.sort);
    const nextSearchTab = normalizeSearchTab(params.searchTab || params.tab || (nextSource === "authors" ? "authors" : listState.searchTab));
    if (nextSource === "authors") nextAuthor = "all";
    if (nextAuthor === "all" && !["all", "liked", "authors"].includes(nextSource)) nextSource = DEFAULT_SOURCE;
    const scopeChanged = nextQuery !== listState.query
      || nextAuthor !== listState.author
      || nextSource !== listState.source
      || nextSort !== listState.sort
      || nextSearchTab !== listState.searchTab;
    listState.query = nextQuery;
    listState.author = nextAuthor;
    listState.source = nextSource;
    listState.sort = nextSort;
    listState.searchTab = nextSearchTab;
    if (scopeChanged) {
      listState.data = null;
      listState.status = "";
      listState.searchAuthors = [];
      listState.allowLoadMore = false;
    }
  }

  async function loadList(renderGuard = null, options = {}) {
    const append = Boolean(options.append);
    if (append && (listState.loading || listState.loadingMore || !listState.data?.hasMore)) return;
    const requestUrl = getActiveUrl();
    const params = new URLSearchParams();
    const authorIndex = isAuthorIndexView();
    if (listState.query) params.set("q", listState.query);
    if (authorIndex) {
      params.set("limit", String(append ? AUTHOR_APPEND_COUNT : AUTHOR_INITIAL_COUNT));
      params.set("offset", String(append ? listState.data?.authors?.length || 0 : 0));
    } else {
      if (listState.author && listState.author !== "all") params.set("author", listState.author);
      params.set("source", shortVideoApiSource());
      params.set("sort", listState.sort || DEFAULT_SORT);
      params.set("limit", String(DEFAULT_LIMIT));
      params.set("facets", "0");
      params.set("stats", "0");
      if (append) params.set("offset", String(listState.data?.videos?.length || 0));
    }
    if (append) {
      listState.loadingMore = true;
    } else {
      listState.allowLoadMore = false;
      listState.loading = true;
      listState.status = listState.data ? "" : "正在读取短视频";
    }
    renderListShell();
    try {
      const endpoint = authorIndex ? "/api/short-videos/authors" : "/api/short-videos";
      const relatedAuthorsRequest = listState.searchPage
        && listState.searchTab === "all"
        && Boolean(listState.query)
        && !append
        ? api.fetchCached(requestUrl, `/api/short-videos/authors?${new URLSearchParams({ q: listState.query, limit: "6", offset: "0" })}`, {
            timeoutMs: 10000,
            cacheMaxAgeMs: 5 * 60 * 1000
          }).catch(() => null)
        : Promise.resolve(null);
      const [data, relatedAuthors] = await Promise.all([api.fetchCached(requestUrl, `${endpoint}?${params}`, {
        timeoutMs: 16000,
        cacheMaxAgeMs: append ? 2 * 60 * 1000 : 5 * 60 * 1000,
        staleWhileRevalidate: !append
      }), relatedAuthorsRequest]);
      if (renderGuard && !renderGuard()) return;
      if (append && listState.data && authorIndex) {
        const merged = [...(listState.data.authors || [])];
        const seen = new Set(merged.map((author) => shortVideoAuthorFilterValue(author)).filter(Boolean));
        for (const author of data.authors || []) {
          const key = shortVideoAuthorFilterValue(author);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          merged.push(author);
        }
        listState.data = { ...data, authors: merged, offset: 0 };
      } else if (append && listState.data) {
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
      if (!append) {
        listState.searchAuthors = Array.isArray(relatedAuthors?.authors) ? relatedAuthors.authors : [];
      }
      if (!isAuthorIndexView()) listState.source = normalizeSource(data.source || listState.source);
      listState.loading = false;
      listState.loadingMore = false;
      listState.status = data.total ? "" : (authorIndex ? "还没有作者数据。" : "还没有短视频。");
      renderListShell();
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
    if (!listState.data?.hasMore || listState.loading || listState.loadingMore) return;
    if (!force) {
      const doc = document.documentElement;
      const remaining = doc.scrollHeight - window.scrollY - window.innerHeight;
      if (remaining > 700) return;
    }
    loadList(null, { append: true }).catch((error) => {
      listState.loadingMore = false;
      listState.status = shortVideoErrorMessage(error, "加载失败，请稍后重试");
      renderListShell();
    });
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

  function updateListParams(patch = {}, navigation = {}) {
    const next = {
      query: listState.query,
      author: listState.author,
      source: listState.source,
      sort: listState.sort,
      searchTab: listState.searchTab,
      ...patch
    };
    const targetView = listState.searchPage ? "shortVideoSearch" : "shortVideos";
    const baseNavigation = listState.searchPage
      ? { skipHistory: true, replaceHistory: true }
      : { resetStack: true, skipHistory: true, replaceHistory: true };
    showView(targetView, next, { ...baseNavigation, ...navigation });
  }

  function getSearchState() {
    return {
      query: listState.query || "",
      author: listState.author || "all",
      source: listState.source || DEFAULT_SOURCE,
      sort: listState.sort || DEFAULT_SORT,
      searchTab: listState.searchTab || "all",
      authors: listState.data?.authors || []
    };
  }

  function resetListLoadMoreObserver() {
    listLoadMoreObserver?.disconnect?.();
    listLoadMoreObserver = null;
  }

  function observeListLoadMore(sentinel) {
    if (!sentinel || !("IntersectionObserver" in window)) return;
    listLoadMoreObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (!listState.allowLoadMore) return;
      if (!listState.data?.hasMore || listState.loading || listState.loadingMore) return;
      loadList(null, { append: true }).catch((error) => {
        listState.loadingMore = false;
        listState.status = shortVideoErrorMessage(error, "加载失败，请稍后重试");
        renderListShell();
      });
    }, { root: null, rootMargin: "180px 0px", threshold: 0.01 });
    listLoadMoreObserver.observe(sentinel);
  }

  function installListEvents() {
    if (listEventsInstalled) return;
    listEventsInstalled = true;
    window.addEventListener("scroll", () => {
      if (!document.body.classList.contains("short-video-mobile-view")) return;
      listState.allowLoadMore = true;
      if (isAuthorIndexView()) {
        appendVisibleAuthors();
        return;
      }
      if (!listState.data?.hasMore || listState.loading || listState.loadingMore) return;
      const doc = document.documentElement;
      const remaining = doc.scrollHeight - window.scrollY - window.innerHeight;
      if (remaining < 700) loadList(null, { append: true }).catch(() => {
        listState.loadingMore = false;
        renderListShell();
      });
    }, { passive: true });
  }

  async function openShortVideoFromList(video) {
    const opened = await openNativeShortVideoFeed(video);
    if (!opened) shortVideoToast("当前设备无法打开原生短视频播放器");
    return opened;
  }

  async function openShortVideoAuthor(author = {}) {
    const authorFilter = shortVideoAuthorFilterValue(author);
    if (!authorFilter) {
      shortVideoToast("该作者缺少可识别信息");
      return false;
    }
    const params = new URLSearchParams({
      author: authorFilter,
      source: "all",
      sort: listState.sort || DEFAULT_SORT,
      limit: String(DEFAULT_LIMIT),
      facets: "0",
      stats: "0"
    });
    try {
      const data = await api.fetchCached(getActiveUrl(), `/api/short-videos?${params}`, {
        timeoutMs: 16000,
        cacheMaxAgeMs: 5 * 60 * 1000
      });
      const first = data.videos?.[0];
      if (!first) {
        shortVideoToast("该作者还没有本地作品");
        return false;
      }
      const opened = await openNativeShortVideoFeed(first, {
        videos: data.videos || [],
        hasMore: data.hasMore,
        query: "",
        author: authorFilter,
        source: "all",
        sort: listState.sort || DEFAULT_SORT,
        openAuthorPanel: true
      });
      if (!opened) shortVideoToast("当前设备无法打开原生作者主页");
      return opened;
    } catch (error) {
      shortVideoToast(shortVideoErrorMessage(error, "作者主页打开失败，请稍后重试"));
      return false;
    }
  }

  function shortVideoErrorMessage(error, fallback) {
    const message = String(error?.message || "").trim();
    if (!message || /failed to fetch|network|timeout/i.test(message)) return fallback;
    if (/database disk image|malformed|sqlite/i.test(message)) return "短视频数据正在恢复，请稍后重试";
    return message;
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
    updateListParams,
    getSearchState,
    resetListLoadMoreObserver,
    observeListLoadMore,
    installListEvents,
    openShortVideoFromList,
    openShortVideoAuthor,
    shortVideoErrorMessage,
    shortVideoApiSource
  };
}
