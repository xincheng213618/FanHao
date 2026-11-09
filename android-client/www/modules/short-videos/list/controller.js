import { AUTHOR_APPEND_COUNT, AUTHOR_INITIAL_COUNT, DEFAULT_LIMIT, DEFAULT_SORT, DEFAULT_SOURCE, normalizeAuthorAccountStatus, normalizeFollowingAuthorFilter, normalizeFollowingAuthorSort, normalizeSearchTab, normalizeSortForSource, normalizeSource } from "../shared.js?v=assets-76f4b0fadf4d";
import { isStaleResponseEnvelope } from "../api.js?v=assets-76f4b0fadf4d";
export function createShortVideoListController(context = {}) {
  const { api, getActiveUrl, listState, showView } = context;
  let listLoadMoreObserver = null;
  let listEventsInstalled = false;
  let listRequestGeneration = 0;
  let listAppendRequestId = 0;
  let listAppendRevision = 0;
  let listRenderGuard = null;
  let acceptedListScope = null;
  let nativeOpenOwner = null;
  let listNextOffset = 0;
  let listAppendPause = "";
  let listVideoOffsets = new WeakMap();
  let videoPrefixCheck = null;
  let videoPrefixError = "";
  let videoAppendError = "";
  const openNativeShortVideoFeed = (...args) => context.openNativeShortVideoFeed(...args);
  const renderListShell = (...args) => context.renderListShell(...args);
  const appendListVideos = (...args) => context.appendListVideos?.(...args);
  const appendListAuthors = (...args) => context.appendListAuthors?.(...args);
  const setAuthorIndexLoading = (...args) => context.setAuthorIndexLoading?.(...args);
  const releaseAuthorIndex = (...args) => context.releaseAuthorIndex?.(...args);
  const isAuthorIndexMounted = (...args) => context.isAuthorIndexMounted?.(...args);
  const hasAuthorIndexShell = (...args) => context.hasAuthorIndexShell?.(...args);
  const refreshVideoCards = (...args) => context.refreshVideoCards?.(...args);
  const updateSearchAuthorMatches = (...args) => context.updateSearchAuthorMatches?.(...args);
  const setListLoadingMore = (...args) => context.setListLoadingMore?.(...args);
  const syncVideoPaging = (...args) => context.syncVideoPaging?.(...args);
  const setListRefreshing = (...args) => context.setListRefreshing?.(...args);
  const shortVideoToast = (...args) => context.shortVideoToast(...args);

  function cancelShortVideoListRequests() {
    // Pagination has no route render guard. Retire every read owned by the
    // mounted list before another module or a new render takes its place.
    listRequestGeneration += 1;
    listAppendRequestId += 1;
    listState.loading = false;
    listState.loadingMore = false;
    listState.allowLoadMore = false;
    listRenderGuard = null;
    videoPrefixCheck = null;
    videoPrefixError = "";
    videoAppendError = "";
    listAppendPause = "";
    releaseAuthorIndex();
  }

  function captureListRenderOwner() {
    const generation = listRequestGeneration;
    const baseUrl = getActiveUrl();
    const scope = listScopeKey(baseUrl);
    return { isCurrent: () => generation === listRequestGeneration
      && baseUrl === getActiveUrl() && scope === listScopeKey(baseUrl)
      && (!listRenderGuard || listRenderGuard()) };
  }

  function listDataScope(baseUrl = getActiveUrl()) {
    return JSON.stringify([baseUrl, listScopeKey(baseUrl)]);
  }

  function needsFirstPageRetry() {
    // Legacy hosts may seed data before the first successful controller read.
    return Boolean(listState.data) && acceptedListScope !== null
      && acceptedListScope !== listDataScope();
  }

  function needsAuthorIndexRetry() {
    return isAuthorIndexView() && needsFirstPageRetry();
  }

  function getVideoPagingStatus() {
    const retryFirstPage = Boolean(videoPrefixError || needsFirstPageRetry());
    return {
      checking: Boolean(videoPrefixCheck),
      retryFirstPage,
      pause: listAppendPause,
      message: videoPrefixError || videoAppendError || (retryFirstPage ? "短视频列表暂未更新" : "")
    };
  }

  function cancelShortVideoNativeOpen(preserveOwner = null) {
    if (preserveOwner && nativeOpenOwner === preserveOwner) return;
    nativeOpenOwner?.controller.abort();
    nativeOpenOwner = null;
  }

  function beginNativeOpen() {
    cancelShortVideoNativeOpen();
    const owner = { controller: new AbortController(), baseUrl: getActiveUrl(), scope: listScopeKey(getActiveUrl()) };
    nativeOpenOwner = owner;
    owner.isCurrent = () => nativeOpenOwner === owner && !owner.controller.signal.aborted
      && owner.scope === listScopeKey(getActiveUrl());
    return owner;
  }

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
      cancelShortVideoNativeOpen();
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
    const authorIndex = isAuthorIndexView();
    if (options.append && !authorIndex && videoPrefixCheck) {
      // All scroll and button intents share the same first-page confirmation.
      const check = videoPrefixCheck;
      check.continuation ??= check.done.then((confirmed) => {
        if (confirmed && check.isCurrent() && listState.data?.hasMore) return loadList(null, { append: true });
      });
      return check.continuation;
    }
    const retryFirstPage = Boolean(options.append && (needsFirstPageRetry() || !authorIndex && videoPrefixError));
    const append = Boolean(options.append && !retryFirstPage);
    const preserveShell = Boolean((options.preserveShell || retryFirstPage) && !append);
    const preservedAuthorIndex = preserveShell && hasAuthorIndexShell();
    const isSearch = listState.searchPage;
    const entryKey = authorIndex ? "authors" : "videos";
    if (options.append && (listState.loading || listState.loadingMore || !retryFirstPage && !listState.data?.hasMore)) return;
    if (options.append && authorIndex && !isAuthorIndexMounted()) return;
    const inheritedRenderGuard = renderGuard || listRenderGuard;
    const requestGeneration = append ? listRequestGeneration : ++listRequestGeneration;
    if (!append) listRenderGuard = retryFirstPage ? inheritedRenderGuard : renderGuard;
    const appendRequestId = append ? ++listAppendRequestId : 0;
    const requestUrl = getActiveUrl();
    const params = new URLSearchParams();
    const requestRenderGuard = renderGuard || listRenderGuard;
    const appendedVideos = [];
    const previousCount = listState.data?.[entryKey]?.length || 0;
    const pageOffset = append ? (!authorIndex || isSearch ? listNextOffset : previousCount) : 0;
    if (listState.query) params.set("q", listState.query);
    if (authorIndex) {
      params.set("limit", String(append ? AUTHOR_APPEND_COUNT : AUTHOR_INITIAL_COUNT));
      params.set("offset", String(pageOffset));
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
      params.set("users", "0");
      if (append) params.set("offset", String(pageOffset));
    }
    if (append) {
      listState.loadingMore = true;
      if (authorIndex) setAuthorIndexLoading(true);
      else setListLoadingMore(true);
    } else {
      listState.allowLoadMore = false;
      listState.loading = true;
      videoPrefixCheck = null;
      if (!retryFirstPage) videoPrefixError = "";
      videoAppendError = "";
      listAppendPause = "";
      listState.status = listState.data ? "" : "正在读取短视频";
      if (preserveShell) {
        setListRefreshing(true);
        if (retryFirstPage && !authorIndex) syncVideoPaging();
      }
      else renderListShell();
    }
    const endpoint = authorIndex ? "/api/short-videos/authors" : "/api/short-videos";
    const requestPath = `${endpoint}?${params}`;
    const requestScope = listScopeKey(requestUrl);
    const isCurrentRequest = () => requestGeneration === listRequestGeneration
      && (!append || appendRequestId === listAppendRequestId)
      && requestUrl === getActiveUrl()
      && requestScope === listScopeKey(getActiveUrl())
      && (!requestRenderGuard || requestRenderGuard())
      && (!append || !authorIndex || isAuthorIndexMounted());
    try {
      const requireAuthoritative = !authorIndex && (append || retryFirstPage);
      const primaryResult = api.fetchCachedRevalidated && !append && !requireAuthoritative
        ? await api.fetchCachedRevalidated(requestUrl, requestPath, {
            timeoutMs: 16000
          })
        : {
            data: await api.fetchCached(requestUrl, requestPath, {
              timeoutMs: 16000,
              cacheMaxAgeMs: append ? 2 * 60 * 1000 : 5 * 60 * 1000,
              forceRefresh: append && isSearch && authorIndex && listAppendPause === "retry",
              requireAuthoritative,
              staleWhileRevalidate: false
            }),
            revalidation: null
          };
      const data = primaryResult.data;
      const revalidation = primaryResult.revalidation;
      revalidation?.catch(() => {});
      if (!isCurrentRequest()) return;
      const marked = isStaleResponseEnvelope(data);
      if (requireAuthoritative && marked) throw new Error("电脑端列表暂未更新，请重试");
      applyLoadedListData(data, { append, authorIndex, appendedVideos, pageOffset });
      acceptedListScope = listDataScope(requestUrl);
      if (append && authorIndex) listAppendRevision += 1;
      if (!append && !authorIndex) videoPrefixError = "";
      if (revalidation) startListRevalidation(revalidation, data, authorIndex, entryKey, isSearch, isCurrentRequest);
      else if (!authorIndex && (marked || primaryResult.fromCache || primaryResult.nonAuthoritative)) {
        videoPrefixError = "电脑端列表暂未更新";
        listState.allowLoadMore = false;
      }
      // Enqueue author hints after the video page: both queries share the
      // catalogue worker, so starting authors first would delay the first page.
      const relatedAuthorsRequest = listState.searchPage
        && listState.searchTab === "all"
        && Boolean(listState.query)
        && !authorIndex
        && !append
        ? api.fetchCached(requestUrl, `/api/short-videos/authors?${new URLSearchParams({ q: listState.query, limit: "6", offset: "0" })}`, {
            timeoutMs: 10000,
            cacheMaxAgeMs: 5 * 60 * 1000
          }).catch(() => null)
        : Promise.resolve(null);
      relatedAuthorsRequest.then((relatedAuthors) => {
        if (!relatedAuthors || !isCurrentRequest()) return;
        const authors = Array.isArray(relatedAuthors.authors) ? relatedAuthors.authors : [];
        if (JSON.stringify(authors) === JSON.stringify(listState.searchAuthors)) return;
        listState.searchAuthors = authors;
        updateSearchAuthorMatches();
      }).catch(() => {});
      if (append && !authorIndex) appendListVideos(appendedVideos);
      else if (append && authorIndex) {
        if (!appendListAuthors()) renderListShell();
      }
      else renderListShell({ preserveVideoPagingFocus: retryFirstPage && !authorIndex });
    } catch (error) {
      if (!isCurrentRequest()) return;
      listState.loading = false;
      listState.loadingMore = false;
      const message = shortVideoErrorMessage(error, "短视频读取失败，请检查服务连接");
      listState.status = preserveShell ? "" : message;
      if (append && (!authorIndex || isSearch)) {
        listState.allowLoadMore = false;
        listAppendPause = "retry";
        if (!authorIndex) videoAppendError = message;
      }
      if (append && !authorIndex) {
        setListLoadingMore(false, message);
      }
      else if (append && authorIndex) {
        if (!setAuthorIndexLoading(false, isSearch ? listState.status : "")) renderListShell();
      }
      else if (preserveShell) {
        setListRefreshing(false);
        // The preserved author controls were retired when navigation began.
        // A failed refresh needs a fresh mount for the retained data.
        if (!authorIndex) videoPrefixError = message;
        if (authorIndex || preservedAuthorIndex) renderListShell();
        else syncVideoPaging();
        shortVideoToast(`${message}，已保留当前内容`);
      } else {
        if (!authorIndex) videoPrefixError = message;
        renderListShell();
      }
    }
  }

  function startListRevalidation(revalidation, data, authorIndex, entryKey, isSearch, isCurrentRequest) {
    const snapshot = captureListRevalidationContext(data, authorIndex);
    const check = authorIndex ? null : { isCurrent: isCurrentRequest, continuation: null, done: null };
    if (check) videoPrefixCheck = check;
    const done = revalidation.then((freshData) => {
      if (!isCurrentRequest()) return false;
      if (check && isStaleResponseEnvelope(freshData)) throw new Error("电脑端列表暂未更新，请重试");
      if (!authorIndex || isSearch) readListPageRows(freshData, entryKey, 0);
      const renderMode = applyRevalidatedListData(freshData, authorIndex, snapshot);
      acceptedListScope = listDataScope();
      if (check) videoPrefixCheck = null;
      if (renderMode === "full") renderListShell({ preserveVideoPagingFocus: Boolean(check) });
      else if (check) syncVideoPaging();
      return true;
    }).catch((error) => {
      if (check && videoPrefixCheck === check && isCurrentRequest()) {
        videoPrefixCheck = null;
        videoPrefixError = shortVideoErrorMessage(error, "短视频列表校验失败");
        listState.allowLoadMore = false;
        syncVideoPaging();
      }
      return false;
    });
    if (check) check.done = done;
  }

  function applyRevalidatedListData(data, authorIndex, snapshot) {
    const previousVideos = listState.data?.videos;
    const nextVideos = data?.videos;
    if (authorIndex || !Array.isArray(previousVideos) || !Array.isArray(nextVideos)
      || listEnvelopeSignature(data) !== snapshot.envelope
      || JSON.stringify(nextVideos.map(revalidationVideoId)) !== snapshot.ids
      || JSON.stringify(nextVideos.map(videoContent)) !== snapshot.content) {
      if (authorIndex && listState.searchPage && listAppendRequestId !== snapshot.appendRequestId) return "retained";
      replaceWithRevalidatedList(data, authorIndex, snapshot);
      return "full";
    }
    const currentById = new Map(previousVideos.map((video) => [revalidationVideoId(video), video]));
    for (const fresh of nextVideos) {
      const video = currentById.get(revalidationVideoId(fresh));
      if (!video) continue;
      const actionsChanged = JSON.stringify(video.actions || {}) !== JSON.stringify(fresh.actions || {});
      const statsChanged = JSON.stringify(video.stats || {}) !== JSON.stringify(fresh.stats || {});
      if (!actionsChanged && !statsChanged) continue;
      video.actions = fresh.actions && typeof fresh.actions === "object" ? { ...fresh.actions } : {};
      video.stats = fresh.stats && typeof fresh.stats === "object" ? { ...fresh.stats } : {};
      refreshVideoCards(video);
    }
    return "targeted";
  }

  function captureListRevalidationContext(data, authorIndex) {
    const source = authorIndex ? data?.authors : data?.videos;
    const entries = Array.isArray(source) ? source : [];
    if (authorIndex) {
      return { appendRequestId: listAppendRequestId, appendRevision: listAppendRevision, baseCount: entries.length };
    }
    return {
      envelope: listEnvelopeSignature(data),
      ids: JSON.stringify(entries.map(revalidationVideoId)),
      content: JSON.stringify(entries.map(videoContent))
    };
  }

  function replaceWithRevalidatedList(data, authorIndex, context = {}) {
    if (!authorIndex) {
      applyLoadedListData(data, { append: false, authorIndex: false, pageOffset: 0 });
      return;
    }
    const appendAdvanced = listAppendRevision !== context.appendRevision;
    const currentData = listState.data && typeof listState.data === "object" ? listState.data : {};
    let nextData = data;
    if (appendAdvanced) {
      const tail = (currentData.authors || []).slice(Math.max(0, Number(context.baseCount || 0)));
      const merged = mergeUniqueEntries(data?.authors, tail, shortVideoAuthorFilterValue);
      nextData = { ...data, ...currentData, authors: merged, offset: 0 };
    }
    if (listState.searchPage) {
      const rows = data.authors;
      listState.data = { ...nextData, authors: mergeUniqueEntries(rows, [], shortVideoAuthorFilterValue) };
      recordListPage(rows, "authors", 0, 0);
    } else listState.data = nextData;
    listState.loading = false;
    const finalEntries = nextData?.authors;
    const hasResults = Number(nextData?.total || 0) > 0 || Boolean(finalEntries?.length);
    listState.status = hasResults ? "" : listState.source === "following" && listState.authorFilter === "unliked"
        ? "没有未点赞的关注账号。"
        : listState.source === "following"
          ? "还没有关注账号。"
          : listState.authorAccountStatus === "banned"
            ? "没有已封禁的作者。"
            : "还没有作者数据。";
  }

  function mergeUniqueEntries(primary = [], tail = [], keyOf = () => "") {
    const merged = [];
    const seen = new Set();
    for (const entry of [...(primary || []), ...(tail || [])]) {
      const key = keyOf(entry);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
    return merged;
  }

  function listEnvelopeSignature(data) {
    if (!data || typeof data !== "object") return "null";
    const { videos: _videos, ...envelope } = data;
    return JSON.stringify(envelope);
  }

  function revalidationVideoId(video) {
    return String(video?.id || "");
  }

  function videoContent(video) {
    const { actions: _actions, stats: _stats, ...content } = video || {};
    return content;
  }

  function applyLoadedListData(data, { append, authorIndex, appendedVideos, pageOffset }) {
    const entryKey = authorIndex ? "authors" : "videos";
    const rawRows = !authorIndex || listState.searchPage ? readListPageRows(data, entryKey, pageOffset) : null;
    const previousCount = append ? listState.data?.[entryKey]?.length || 0 : 0;
    if (rawRows && append && data.hasMore && !rawRows.length) {
      throw new Error(listState.searchPage ? "搜索续页没有返回结果" : "列表续页没有返回结果");
    }
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
      const seen = new Set((listState.data.videos || []).map(revalidationVideoId));
      const merged = [...(listState.data.videos || [])];
      for (const video of rawRows) {
        const id = revalidationVideoId(video);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        merged.push(video);
        appendedVideos.push(video);
      }
      listState.data = { ...data, videos: merged, offset: 0, limit: merged.length };
    } else if (rawRows) {
      listState.data = { ...data, [entryKey]: mergeUniqueEntries(rawRows, [], authorIndex ? shortVideoAuthorFilterValue : revalidationVideoId) };
    } else {
      listState.data = data;
    }
    if (rawRows) recordListPage(rawRows, entryKey, pageOffset, previousCount);
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

  function readListPageRows(data, entryKey, offset) {
    const rows = data?.[entryKey];
    if (!Array.isArray(rows) || (data.offset != null && Number(data.offset) !== offset)) {
      throw new Error(listState.searchPage ? "搜索续页位置不一致" : "列表续页位置不一致");
    }
    return rows;
  }

  function recordListPage(rows, entryKey, offset, previousCount) {
    if (offset === 0) listVideoOffsets = new WeakMap();
    if (entryKey === "videos") {
      rows.forEach((video, index) => {
        if (video && typeof video === "object" && !listVideoOffsets.has(video)) {
          listVideoOffsets.set(video, offset + index + 1);
        }
      });
    }
    listNextOffset = offset + rows.length;
    listAppendPause = "";
    videoAppendError = "";
    if (listState.data.hasMore && listState.data[entryKey].length === previousCount) {
      listAppendPause = rows.length ? "no-new-items" : "retry";
      listState.allowLoadMore = false;
    }
  }

  function listFeedNextOffset(video, atLoadedEnd) {
    if (!listVideoOffsets.has(video)) return undefined;
    return atLoadedEnd ? listNextOffset : listVideoOffsets.get(video);
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
    if (listState.loading || listState.loadingMore || !listState.data?.hasMore && !needsAuthorIndexRetry()) return;
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
    cancelShortVideoNativeOpen();
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
    const owner = captureListRenderOwner();
    const observer = new IntersectionObserver((entries) => {
      if (listLoadMoreObserver !== observer || !owner.isCurrent()) return;
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (!listState.allowLoadMore || listAppendPause || videoPrefixError || needsFirstPageRetry()) return;
      if ((!listState.data?.hasMore && !videoPrefixCheck) || listState.loading || listState.loadingMore) return;
      loadList(null, { append: true }).catch((error) => {
        listState.loadingMore = false;
        listState.status = shortVideoErrorMessage(error, "加载失败，请稍后重试");
        renderListShell();
      });
    }, { root: null, rootMargin: "180px 0px", threshold: 0.01 });
    listLoadMoreObserver = observer;
    observer.observe(sentinel);
  }

  function installListEvents() {
    if (listEventsInstalled) return;
    listEventsInstalled = true;
    window.addEventListener("scroll", () => {
      const isSearchResults = listState.searchPage && Boolean(listState.query)
        && document.body.classList.contains("short-video-search-page-view");
      if (!document.body.classList.contains("short-video-mobile-view") && !isSearchResults) return;
      if (listRenderGuard && !listRenderGuard()) return;
      if (listAppendPause || videoPrefixError || !isAuthorIndexView() && needsFirstPageRetry()) return;
      listState.allowLoadMore = true;
      if (isAuthorIndexView()) {
        appendVisibleAuthors();
        return;
      }
      if ((!listState.data?.hasMore && !videoPrefixCheck) || listState.loading || listState.loadingMore) return;
      const doc = document.documentElement;
      const remaining = doc.scrollHeight - window.scrollY - window.innerHeight;
      if (remaining < 700) loadList(null, { append: true }).catch(() => {
        listState.loadingMore = false;
        renderListShell();
      });
    }, { passive: true });
  }

  async function openShortVideoFromList(video) {
    if (needsFirstPageRetry()) {
      shortVideoToast("短视频列表暂未更新，请重试");
      return false;
    }
    const owner = beginNativeOpen();
    const opened = await openNativeShortVideoFeed(video, {
      owner,
      baseUrl: owner.baseUrl,
      isCurrent: owner.isCurrent,
      allowContinuation: !listState.loading && !videoPrefixCheck && !videoPrefixError
    });
    if (!opened && owner.isCurrent()) shortVideoToast("当前设备无法打开原生短视频播放器");
    return opened;
  }

  async function openShortVideoAuthor(author = {}) {
    const authorFilter = shortVideoAuthorFilterValue(author);
    if (!authorFilter) {
      shortVideoToast("该作者缺少可识别信息");
      return false;
    }
    const owner = beginNativeOpen();
    const params = new URLSearchParams({
      author: authorFilter,
      source: "all",
      sort: listState.sort || DEFAULT_SORT,
      limit: String(DEFAULT_LIMIT),
      facets: "0",
      stats: "0"
    });
    try {
      const routePath = `/api/short-videos?${params}`;
      const readOptions = {
        signal: owner.controller.signal,
        timeoutMs: 16000,
        cacheMaxAgeMs: 5 * 60 * 1000
      };
      let { data, source } = await api.fetchCached(owner.baseUrl, routePath, { ...readOptions, withSource: true });
      if (!owner.isCurrent()) return false;
      if (source === "cache" && Array.isArray(data?.videos) && !data.videos.length) {
        // A cached empty page does not establish that the author has no works.
        data = await api.fetchCached(owner.baseUrl, routePath, { ...readOptions, requireAuthoritative: true });
        if (!owner.isCurrent()) return false;
        source = "network";
      }
      if (!Array.isArray(data?.videos)) throw new Error("作者列表响应格式异常，请重试");
      const authoritative = source === "network" && !isStaleResponseEnvelope(data);
      if (!data.videos.length) {
        if (!authoritative) throw new Error("电脑端暂时无法确认作者作品，请重试");
        const profileUrl = authorOriginalUrl(author);
        if (!profileUrl) {
          shortVideoToast("该作者还没有本地作品或可打开的主页");
          return false;
        }
        shortVideoToast("该作者还没有本地作品，正在打开抖音主页");
        window.open(profileUrl, "_blank", "noreferrer");
        return true;
      }
      const first = data.videos[0];
      if (!first?.id) throw new Error("作者列表响应格式异常，请重试");
      const opened = await openNativeShortVideoFeed(first, {
        owner,
        baseUrl: owner.baseUrl,
        isCurrent: owner.isCurrent,
        videos: data.videos,
        hasMore: data.hasMore,
        allowContinuation: authoritative,
        query: "",
        author: authorFilter,
        source: "all",
        sort: listState.sort || DEFAULT_SORT,
        openAuthorPanel: true
      });
      if (!opened && owner.isCurrent()) shortVideoToast("当前设备无法打开原生作者主页");
      return opened;
    } catch (error) {
      if (!owner.isCurrent()) return false;
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
    cancelShortVideoListRequests,
    cancelShortVideoNativeOpen,
    captureListRenderOwner,
    needsAuthorIndexRetry,
    getVideoPagingStatus,
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
    listFeedNextOffset,
    shortVideoErrorMessage,
    shortVideoApiSource
  };
}
