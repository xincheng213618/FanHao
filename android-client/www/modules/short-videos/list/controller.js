import { AUTHOR_APPEND_COUNT, AUTHOR_INITIAL_COUNT, DEFAULT_LIMIT, DEFAULT_SORT, DEFAULT_SOURCE, normalizeAuthorAccountStatus, normalizeFollowingAuthorFilter, normalizeFollowingAuthorSort, normalizeSearchTab, normalizeSortForSource, normalizeSource } from "../shared.js?v=20260811-android-author-status-01";
export function createShortVideoListController(context = {}) {
  const { api, getActiveUrl, listState, showView } = context;
  let listLoadMoreObserver = null;
  let listEventsInstalled = false;
  let listRequestGeneration = 0;
  const openNativeShortVideoFeed = (...args) => context.openNativeShortVideoFeed(...args);
  const renderListShell = (...args) => context.renderListShell(...args);
  const appendListVideos = (...args) => context.appendListVideos?.(...args);
  const refreshVideoCards = (...args) => context.refreshVideoCards?.(...args);
  const setListLoadingMore = (...args) => context.setListLoadingMore?.(...args);
  const setListRefreshing = (...args) => context.setListRefreshing?.(...args);
  const shortVideoToast = (...args) => context.shortVideoToast(...args);

  function shortVideoApiSource() {
    const source = normalizeSource(listState.source);
    return source === "authors" ? "liked" : source;
  }
  function applyListParams(params = {}, options = {}) {
    const nextQuery = String(params.query || params.q || "").trim();
    let nextAuthor = String(params.author || "all").trim() || "all";
    let nextSource = normalizeSource(params.source || params.origin);
    const nextSort = normalizeSortForSource(nextSource, params.sort);
    const nextAuthorSort = normalizeFollowingAuthorSort(params.authorSort || listState.authorSort);
    const nextAuthorFilter = normalizeFollowingAuthorFilter(params.authorFilter || listState.authorFilter);
    const nextAuthorAccountStatus = nextSource === "authors"
      ? normalizeAuthorAccountStatus(params.authorAccountStatus || params.account)
      : normalizeAuthorAccountStatus(listState.authorAccountStatus);
    const nextSearchTab = normalizeSearchTab(params.searchTab || params.tab || (nextSource === "authors" ? "authors" : listState.searchTab));
    if (["authors", "following"].includes(nextSource)) nextAuthor = "all";
    if (nextAuthor === "all" && !["all", "liked", "following", "authors"].includes(nextSource)) nextSource = DEFAULT_SOURCE;
    const scopeChanged = nextQuery !== listState.query
      || nextAuthor !== listState.author
      || nextSource !== listState.source
      || nextSort !== listState.sort
      || nextAuthorSort !== listState.authorSort
      || nextAuthorFilter !== listState.authorFilter
      || nextAuthorAccountStatus !== listState.authorAccountStatus
      || nextSearchTab !== listState.searchTab;
    listState.query = nextQuery;
    listState.author = nextAuthor;
    listState.source = nextSource;
    listState.sort = nextSort;
    listState.authorSort = nextAuthorSort;
    listState.authorFilter = nextAuthorFilter;
    listState.authorAccountStatus = nextAuthorAccountStatus;
    listState.searchTab = nextSearchTab;
    if (scopeChanged) {
      if (!options.preserveData) {
        listState.data = null;
        listState.status = "";
        listState.searchAuthors = [];
      }
      listState.allowLoadMore = false;
    }
    return scopeChanged;
  }

  async function loadList(renderGuard = null, options = {}) {
    const append = Boolean(options.append);
    const preserveShell = Boolean(options.preserveShell && !append);
    if (append && (listState.loading || listState.loadingMore || !listState.data?.hasMore)) return;
    const requestGeneration = ++listRequestGeneration;
    const requestUrl = getActiveUrl();
    const params = new URLSearchParams();
    const authorIndex = isAuthorIndexView();
    const appendedVideos = [];
    if (listState.query) params.set("q", listState.query);
    if (authorIndex) {
      params.set("limit", String(append ? AUTHOR_APPEND_COUNT : AUTHOR_INITIAL_COUNT));
      params.set("offset", String(append ? listState.data?.authors?.length || 0 : 0));
      if (listState.source === "following") {
        params.set("scope", "following");
        params.set("sort", listState.authorSort);
        params.set("filter", listState.authorFilter);
      } else {
        params.set("filter", listState.authorAccountStatus);
      }
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
      if (!authorIndex) setListLoadingMore(true);
    } else {
      listState.allowLoadMore = false;
      listState.loading = true;
      listState.status = listState.data ? "" : "正在读取短视频";
      if (preserveShell) setListRefreshing(true);
      else renderListShell();
    }
    const endpoint = authorIndex ? "/api/short-videos/authors" : "/api/short-videos";
    const requestPath = `${endpoint}?${params}`;
    const requestScope = listScopeKey(requestUrl);
    const isCurrentRequest = () => requestGeneration === listRequestGeneration
      && requestScope === listScopeKey(getActiveUrl())
      && (!renderGuard || renderGuard());
    try {
      const relatedAuthorsRequest = listState.searchPage
        && listState.searchTab === "all"
        && Boolean(listState.query)
        && !append
        ? api.fetchCached(requestUrl, `/api/short-videos/authors?${new URLSearchParams({ q: listState.query, limit: "6", offset: "0" })}`, {
            timeoutMs: 10000,
            cacheMaxAgeMs: 5 * 60 * 1000
          }).catch(() => null)
        : Promise.resolve(null);
      const primaryResult = api.fetchCachedRevalidated && !append
        ? await api.fetchCachedRevalidated(requestUrl, requestPath, {
            timeoutMs: 16000
          })
        : {
            data: await api.fetchCached(requestUrl, requestPath, {
              timeoutMs: 16000,
              cacheMaxAgeMs: append ? 2 * 60 * 1000 : 5 * 60 * 1000,
              staleWhileRevalidate: false
            }),
            revalidation: null
          };
      const data = primaryResult.data;
      if (!isCurrentRequest()) return;
      applyLoadedListData(data, { append, authorIndex, appendedVideos });
      if (primaryResult.revalidation) {
        primaryResult.revalidation.then((freshData) => {
          if (!isCurrentRequest()) return;
          const renderMode = applyRevalidatedListData(freshData, authorIndex);
          if (renderMode === "full") renderListShell();
        }).catch(() => {});
      }
      relatedAuthorsRequest.then((relatedAuthors) => {
        if (!relatedAuthors || !isCurrentRequest()) return;
        const authors = Array.isArray(relatedAuthors.authors) ? relatedAuthors.authors : [];
        if (JSON.stringify(authors) === JSON.stringify(listState.searchAuthors)) return;
        listState.searchAuthors = authors;
        renderListShell();
      }).catch(() => {});
      if (append && !authorIndex) appendListVideos(appendedVideos);
      else renderListShell();
    } catch (error) {
      if (!isCurrentRequest()) return;
      listState.loading = false;
      listState.loadingMore = false;
      const message = shortVideoErrorMessage(error, "短视频读取失败，请检查服务连接");
      listState.status = preserveShell ? "" : message;
      if (append && !authorIndex) setListLoadingMore(false, listState.status);
      else if (preserveShell) {
        setListRefreshing(false);
        shortVideoToast(`${message}，已保留当前内容`);
      } else renderListShell();
    }
  }

  function applyRevalidatedListData(data, authorIndex) {
    const previousVideos = listState.data?.videos;
    const nextVideos = data?.videos;
    if (authorIndex || !Array.isArray(previousVideos) || !Array.isArray(nextVideos)
      || previousVideos.length !== nextVideos.length) {
      applyLoadedListData(data, { append: false, authorIndex, appendedVideos: [] });
      return "full";
    }
    const nextById = new Map(nextVideos.map((video) => [String(video?.id || ""), video]));
    if (previousVideos.some((video) => !sameVideoContent(video, nextById.get(String(video?.id || ""))))) {
      applyLoadedListData(data, { append: false, authorIndex, appendedVideos: [] });
      return "full";
    }
    for (const video of previousVideos) {
      const fresh = nextById.get(String(video?.id || ""));
      const actionsChanged = JSON.stringify(video.actions || {}) !== JSON.stringify(fresh.actions || {});
      const statsChanged = JSON.stringify(video.stats || {}) !== JSON.stringify(fresh.stats || {});
      if (!actionsChanged && !statsChanged) continue;
      video.actions = fresh.actions && typeof fresh.actions === "object" ? { ...fresh.actions } : {};
      video.stats = fresh.stats && typeof fresh.stats === "object" ? { ...fresh.stats } : {};
      refreshVideoCards(video);
    }
    Object.assign(listState.data, data, { videos: previousVideos });
    listState.loading = false;
    listState.loadingMore = false;
    listState.status = data.total ? "" : "还没有短视频。";
    return "targeted";
  }

  function sameVideoContent(previous, next) {
    if (!previous || !next || String(previous.id || "") !== String(next.id || "")) return false;
    const { actions: _previousActions, stats: _previousStats, ...previousContent } = previous;
    const { actions: _nextActions, stats: _nextStats, ...nextContent } = next;
    return JSON.stringify(previousContent) === JSON.stringify(nextContent);
  }

  function applyLoadedListData(data, { append, authorIndex, appendedVideos }) {
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
        appendedVideos.push(video);
      }
      listState.data = { ...data, videos: merged, offset: 0, limit: merged.length };
    } else {
      listState.data = data;
    }
    if (!isAuthorIndexView()) listState.source = normalizeSource(data.source || listState.source);
    listState.loading = false;
    listState.loadingMore = false;
    listState.status = data.total
      ? ""
      : authorIndex
        ? listState.source === "following" && listState.authorFilter === "unliked"
          ? "没有未点赞的关注账号。"
          : listState.source === "following"
            ? "还没有关注账号。"
            : listState.authorAccountStatus === "banned"
              ? "没有已封禁的作者。"
              : "还没有作者数据。"
        : "还没有短视频。";
  }

  function listScopeKey(baseUrl) {
    return JSON.stringify({
      origin: serverOrigin(baseUrl),
      query: listState.query,
      author: listState.author,
      source: listState.source,
      sort: listState.sort,
      authorSort: listState.authorSort,
      authorFilter: listState.authorFilter,
      authorAccountStatus: listState.authorAccountStatus,
      searchPage: listState.searchPage,
      searchTab: listState.searchTab
    });
  }

  function serverOrigin(baseUrl) {
    try {
      return new URL(baseUrl).origin;
    } catch {
      return String(baseUrl || "").replace(/\/+$/, "");
    }
  }

  function sortedAuthorFacets(options = {}) {
    const query = options.ignoreQuery ? "" : listState.query.toLocaleLowerCase("zh-CN");
    const authors = [...(listState.data?.authors || [])]
      .filter((author) => author && shortVideoAuthorFilterValue(author))
      .filter((author) => !query || `${author.name || ""} ${author.secUid || ""}`.toLocaleLowerCase("zh-CN").includes(query));
    if (listState.source === "following") return authors;
    return authors.sort((a, b) => Number(b.count || 0) - Number(a.count || 0) || String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));
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
    return ["authors", "following"].includes(listState.source) && listState.author === "all";
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
      authorSort: listState.authorSort,
      authorFilter: listState.authorFilter,
      authorAccountStatus: listState.authorAccountStatus,
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
      authorSort: listState.authorSort || "followed",
      authorFilter: listState.authorFilter || "all",
      authorAccountStatus: listState.authorAccountStatus || "all",
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
        const profileUrl = authorOriginalUrl(author);
        if (!profileUrl) {
          shortVideoToast("该作者还没有本地作品或可打开的主页");
          return false;
        }
        shortVideoToast("该作者还没有本地作品，正在打开抖音主页");
        window.open(profileUrl, "_blank", "noreferrer");
        return true;
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

  function authorOriginalUrl(author = {}) {
    const profileUrl = String(author.profileUrl || "").trim();
    if (/^https?:\/\//i.test(profileUrl)) return profileUrl;
    const secUid = String(author.secUid || "").trim();
    return secUid ? `https://www.douyin.com/user/${encodeURIComponent(secUid)}` : "";
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
