import { createNovelCollectionAdmin } from "./collection-admin.js?v=20260727-novel-task-log-04";

const NOVEL_BOOK_PAGE_SIZE = 48;
const NOVEL_RANKING_PAGE_SIZE = 48;
const NOVEL_CHAPTER_CACHE_LIMIT = 8;

export function createNovelPage(deps) {
  const {
    api,
    cancelScheduledWorkRendering,
    disconnectPeopleIndexAutoload,
    els,
    formatBytes,
    formatDateTime,
    formatNumber,
    hidePersonProfile,
    openAdminScript,
    pushRoute,
    replaceRoute,
    resetProgressiveCoverLoading,
    setMainHeader,
    state,
    syncRouteAfterNavigation
  } = deps;

  let catalogRequestId = 0;
  let progressTimer = null;
  let progressWrite = Promise.resolve();
  let progressRevision = 0;
  let navigationId = 0;
  let navigationController = null;
  let libraryRequestId = 0;
  let libraryRequestController = null;
  let readerStatusTimer = null;
  let scrollListenerInstalled = false;
  let progressLifecycleInstalled = false;
  let keyboardListenerInstalled = false;
  let libraryObserver = null;
  const chapterCache = new Map();
  const chapterRequests = new Map();
  const collectionAdmin = createNovelCollectionAdmin({
    api,
    state,
    formatDateTime,
    formatNumber,
    openBook,
    rerender: renderView,
    onLibraryChanged: async () => {
      try {
        const summary = await api("/api/novels/summary");
        state.novel.summary = summary;
        state.novel.data = state.novel.mode === "manage"
          ? { summary, books: [], total: 0, limit: NOVEL_BOOK_PAGE_SIZE, offset: 0 }
          : null;
      } catch {
        state.novel.data = null;
        state.novel.summary = null;
      }
    }
  });

  function ensureState() {
    if (!state.novel) state.novel = {};
    state.novel.query = state.novel.query || "";
    state.novel.category = state.novel.category || "all";
    state.novel.author = state.novel.author || "";
    state.novel.mode = ["mine", "authors", "author", "search", "rankings", "manage"].includes(state.novel.mode) ? state.novel.mode : "books";
    state.novel.page = Math.max(0, Number(state.novel.page || 0));
    state.novel.sort = state.novel.sort || "updated";
    state.novel.data = state.novel.data || null;
    state.novel.summary = state.novel.summary || null;
    state.novel.book = state.novel.book || null;
    state.novel.chapters = state.novel.chapters || [];
    state.novel.chapter = state.novel.chapter || null;
    state.novel.loading = Boolean(state.novel.loading);
    state.novel.loadingMore = Boolean(state.novel.loadingMore);
    state.novel.hasMore = Boolean(state.novel.hasMore);
    state.novel.uploading = Boolean(state.novel.uploading);
    state.novel.status = state.novel.status || "";
    state.novel.catalogOpen = Boolean(state.novel.catalogOpen);
    state.novel.catalogLoading = Boolean(state.novel.catalogLoading);
    state.novel.catalogError = state.novel.catalogError || "";
    state.novel.catalogRemotePaged = Boolean(state.novel.catalogRemotePaged);
    state.novel.catalogTotal = Math.max(0, Number(state.novel.catalogTotal || 0));
    state.novel.catalogFilteredTotal = Math.max(0, Number(state.novel.catalogFilteredTotal || 0));
    state.novel.catalogOffset = Math.max(0, Number(state.novel.catalogOffset || 0));
    state.novel.progressChapterTitle = state.novel.progressChapterTitle || "";
    state.novel.settingsOpen = Boolean(state.novel.settingsOpen);
    state.novel.catalogQuery = state.novel.catalogQuery || "";
    state.novel.catalogPage = Math.max(0, Number(state.novel.catalogPage || 0));
    state.novel.catalogDescending = Boolean(state.novel.catalogDescending);
    state.novel.settings = normalizeSettings(state.novel.settings || readSettings());
    collectionAdmin.ensureState();
    installScrollProgress();
    installProgressLifecycle();
    installReaderKeyboard();
  }

  function enter(options = {}) {
    ensureState();
    if (options.reload) {
      chapterCache.clear();
      chapterRequests.clear();
    }
    state.selectedPersonId = null;
    state.selectedPerson = null;
    state.works = [];
    state.personWorksTotal = 0;
    state.personWorksFacets = null;
    hidePersonProfile();
    disconnectPeopleIndexAutoload();
    cancelScheduledWorkRendering();
    resetProgressiveCoverLoading();
    setMainHeader("小说", "本地 TXT 阅读器");
    setReaderBodyClass();
    renderStats();
    if (options.deferInitialLoad) {
      renderView();
    } else if (!state.novel.data || options.reload) {
      loadNovels({ skipRoute: true }).catch((error) => {
        state.novel.status = error.message || "小说书库读取失败";
        renderView();
      });
    } else {
      renderView();
    }
    syncRouteAfterNavigation(options);
  }

  function applyRouteState(route = {}) {
    ensureState();
    state.novel.query = route.novelQuery || "";
    state.novel.category = route.novelCategory || "all";
    state.novel.sort = route.novelSort || "updated";
    state.novel.author = route.novelAuthor || "";
    state.novel.mode = ["mine", "author", "rankings", "manage"].includes(route.novelMode) ? route.novelMode : "books";
    state.novel.page = Math.max(0, Number(route.novelPage || 0));
  }

  async function openRouteTarget(route = {}) {
    ensureState();
    if (route.novelBookId && route.novelChapterIndex) {
      await openChapter(route.novelBookId, route.novelChapterIndex, { skipRoute: true, restoreProgress: true });
      return;
    }
    if (route.novelBookId) {
      await openBook(route.novelBookId, { skipRoute: true });
      return;
    }
    flushProgress();
    invalidateNavigation();
    state.novel.loading = false;
    state.novel.status = "";
    state.novel.book = null;
    state.novel.chapter = null;
    state.novel.catalogOpen = false;
    state.novel.settingsOpen = false;
    await loadNovels({ skipRoute: true });
  }

  async function loadNovels(options = {}) {
    ensureState();
    if (state.novel.mode === "mine") state.novel.sort = "progress";
    if (state.novel.mode === "rankings" && !["chars", "updated"].includes(state.novel.sort)) state.novel.sort = "chars";
    const query = Object.freeze({
      author: String(state.novel.author || ""),
      category: String(state.novel.category || "all"),
      mode: String(state.novel.mode || "books"),
      page: Math.max(0, Number(state.novel.page || 0)),
      query: String(state.novel.query || ""),
      sort: String(state.novel.sort || "updated")
    });
    const paged = query.mode === "rankings";
    const append = Boolean(!paged && options.append && state.novel.data && !state.novel.loading && !state.novel.loadingMore);
    if (options.append && !append) return;
    const request = beginLibraryRequest();
    if (append) state.novel.loadingMore = true;
    else state.novel.loading = true;
    if (!append) state.novel.status = "正在读取小说书库";
    state.novel.book = options.keepBook ? state.novel.book : null;
    state.novel.chapter = options.keepChapter ? state.novel.chapter : null;
    setReaderBodyClass();
    renderView();
    const params = new URLSearchParams();
    if (query.query) params.set("q", query.query);
    if (query.mode === "mine") params.set("reading", "1");
    if (["books", "author"].includes(query.mode) && query.category !== "all") params.set("category", query.category);
    if (query.mode === "books" && query.author) params.set("author", query.author);
    if (query.sort !== "updated") params.set("sort", query.sort);
    const pageSize = paged ? NOVEL_RANKING_PAGE_SIZE : NOVEL_BOOK_PAGE_SIZE;
    params.set("limit", String(pageSize));
    const existingEntries = state.novel.data?.books || [];
    params.set("offset", String(paged ? query.page * pageSize : append ? existingEntries.length : 0));
    const endpoint = query.mode === "author" && query.author
      ? `/api/novels/authors/${encodeURIComponent(query.author)}`
      : query.mode === "manage"
        ? "/api/novels/summary"
        : "/api/novels";
    if (!options.skipRoute) {
      const writer = options.replaceRoute ? replaceRoute : pushRoute;
      writer({
        view: "novels",
        novelBookId: "",
        novelChapterIndex: "",
        novelQuery: query.query,
        novelCategory: query.category,
        novelSort: query.sort,
        novelMode: query.mode,
        novelAuthor: query.author,
        novelPage: query.page
      });
    }
    let response;
    try {
      response = await api(`${endpoint}${query.mode !== "manage" && params.toString() ? `?${params}` : ""}`, {
        signal: request.controller.signal
      });
    } catch (error) {
      if (!isCurrentLibraryRequest(request)) return false;
      finishLibraryRequest(request);
      state.novel.loading = false;
      state.novel.loadingMore = false;
      throw error;
    }
    if (!isCurrentLibraryRequest(request)) return false;
    const data = query.mode === "manage"
      ? { summary: response, books: [], total: 0, limit: pageSize, offset: 0 }
      : response;
    if (paged && Number(data.total || 0) > 0) {
      const pageCount = Math.max(1, Math.ceil(Number(data.total || 0) / pageSize));
      const clampedPage = Math.min(pageCount - 1, query.page);
      if (clampedPage !== query.page && !options.pageClamped) {
        state.novel.page = clampedPage;
        state.novel.loading = false;
        state.novel.loadingMore = false;
        return loadNovels({ ...options, pageClamped: true });
      }
    }
    if (append) {
      state.novel.data = { ...data, books: [...existingEntries, ...(data.books || [])] };
    } else {
      state.novel.data = data;
    }
    if (query.mode === "manage") {
      await collectionAdmin.load({ silent: true });
    } else {
      collectionAdmin.stopPolling();
    }
    if (!isCurrentLibraryRequest(request)) return false;
    finishLibraryRequest(request);
    state.novel.summary = data.summary || state.novel.summary;
    state.novel.loading = false;
    state.novel.loadingMore = false;
    const loadedEntries = state.novel.data?.books || [];
    state.novel.hasMore = !paged && query.mode !== "manage" && loadedEntries.length < Number(data.total || 0);
    if (!paged) state.novel.page = 0;
    state.novel.status = query.mode === "manage"
      ? ""
      : data.total
        ? ""
        : query.mode === "author"
          ? "这位作者还没有作品。"
          : query.mode === "mine"
            ? "还没有阅读记录。"
            : query.mode === "rankings"
              ? "排行榜暂时没有小说。"
              : query.query
                ? "没有找到匹配的小说。"
                : "这里还没有小说，请到“管理”页面刷新书库。";
    renderStats();
    renderView();
  }

  async function openBook(bookId, options = {}) {
    ensureState();
    if (!bookId) return;
    flushProgress();
    const navigation = beginNavigation();
    state.novel.loading = true;
    state.novel.status = "正在读取书籍详情";
    state.novel.chapter = null;
    state.novel.catalogOpen = false;
    state.novel.settingsOpen = false;
    setReaderBodyClass();
    renderView();
    let data;
    try {
      data = await api(`/api/novels/${encodeURIComponent(bookId)}?catalog=0`, {
        signal: navigation.controller.signal
      });
    } catch (error) {
      if (!isCurrentNavigation(navigation)) return false;
      finishNavigation(navigation);
      state.novel.loading = false;
      state.novel.status = error.message || "书籍详情读取失败";
      renderView();
      return false;
    }
    if (!isCurrentNavigation(navigation)) return false;
    state.novel.book = data.book;
    state.novel.chapters = [];
    state.novel.progressChapterTitle = "";
    state.novel.catalogLoading = false;
    state.novel.catalogError = "";
    state.novel.catalogRemotePaged = false;
    state.novel.catalogTotal = Number(data.chapterTotal || data.book?.chapterCount || 0);
    state.novel.catalogFilteredTotal = state.novel.catalogTotal;
    state.novel.catalogOffset = 0;
    resetCatalogState(data.book, state.novel.chapters, data.book?.progress?.chapterIndex || 1);
    await loadRemoteCatalogPage({ render: false });
    if (!isCurrentNavigation(navigation)) return false;
    finishNavigation(navigation);
    state.novel.loading = false;
    state.novel.status = "";
    renderStats();
    renderView();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    if (!options.skipRoute) pushRoute({ view: "novels", novelBookId: bookId, novelChapterIndex: "" });
    return true;
  }

  async function openChapter(bookId, chapterIndex, options = {}) {
    ensureState();
    if (!bookId || !chapterIndex) return;
    const previousBookId = String(state.novel.book?.id || "");
    const previousChapterIndex = Number(state.novel.chapter?.index || 0);
    const previousChapters = Array.isArray(state.novel.chapters) ? state.novel.chapters : [];
    if (previousBookId && previousChapterIndex && (
      previousBookId !== String(bookId) || previousChapterIndex !== Number(chapterIndex)
    )) {
      flushProgress();
    }
    const navigation = beginNavigation();
    const readerVisible = Boolean(state.novel.chapter && document.querySelector(".novel-reader-page"));
    state.novel.loading = true;
    state.novel.status = "正在翻开章节";
    if (!setReaderNavigationStatus("正在翻开章节…")) renderView();
    let data;
    try {
      data = await fetchChapterData(bookId, chapterIndex, {
        allowCache: options.restoreProgress === false,
        signal: navigation.controller.signal
      });
    } catch (error) {
      if (!isCurrentNavigation(navigation)) return false;
      finishNavigation(navigation);
      state.novel.loading = false;
      state.novel.status = readerNavigationErrorMessage(error);
      if (!readerVisible || !setReaderNavigationStatus(state.novel.status, "error")) renderView();
      return false;
    }
    if (!isCurrentNavigation(navigation)) return false;
    finishNavigation(navigation);
    const currentProgress = previousBookId === String(data.book?.id || "") ? state.novel.book?.progress : null;
    state.novel.book = {
      ...data.book,
      progress: options.restoreProgress === false && currentProgress ? currentProgress : data.book?.progress || null
    };
    state.novel.chapter = data.chapter;
    const incomingChapters = Array.isArray(data.chapters) ? data.chapters : [];
    state.novel.chapters = incomingChapters.length
      ? incomingChapters
      : previousBookId === String(data.book?.id || "") ? previousChapters : [];
    if (previousBookId !== String(data.book?.id || "") && !incomingChapters.length) {
      state.novel.catalogRemotePaged = false;
      state.novel.catalogBookId = "";
      state.novel.catalogTotal = Number(data.chapterTotal || data.book?.chapterCount || 0);
      state.novel.catalogFilteredTotal = state.novel.catalogTotal;
      state.novel.catalogOffset = 0;
    }
    state.novel.catalogLoading = false;
    state.novel.catalogError = "";
    state.novel.prev = data.prev || null;
    state.novel.next = data.next || null;
    state.novel.loading = false;
    state.novel.status = "";
    clearReaderNavigationStatus();
    const progress = data.book?.progress;
    const restore = options.restoreProgress !== false && Number(progress?.chapterIndex || 0) === Number(data.chapter?.index || 0);
    state.novel.pendingScrollRatio = restore ? Number(progress?.scrollRatio || 0) : 0;
    setReaderBodyClass();
    renderStats();
    renderView();
    restoreReaderScroll();
    scheduleProgressSave(120);
    if (!options.skipRoute) pushRoute({ view: "novels", novelBookId: bookId, novelChapterIndex: String(chapterIndex) });
    prefetchNextChapter(state.novel.book?.id, state.novel.next);
    return true;
  }

  function beginNavigation() {
    invalidateLibraryRequest();
    navigationId += 1;
    navigationController?.abort();
    navigationController = new AbortController();
    clearReaderNavigationStatus();
    return { id: navigationId, controller: navigationController };
  }

  function isCurrentNavigation(navigation) {
    return navigation?.id === navigationId
      && navigation?.controller === navigationController
      && !navigation.controller.signal.aborted;
  }

  function finishNavigation(navigation) {
    if (navigation?.controller === navigationController) navigationController = null;
  }

  function invalidateNavigation() {
    navigationId += 1;
    navigationController?.abort();
    navigationController = null;
    clearReaderNavigationStatus();
  }

  function beginLibraryRequest() {
    libraryRequestId += 1;
    libraryRequestController?.abort();
    libraryRequestController = new AbortController();
    return { id: libraryRequestId, controller: libraryRequestController };
  }

  function isCurrentLibraryRequest(request) {
    return request?.id === libraryRequestId
      && request?.controller === libraryRequestController
      && !request.controller.signal.aborted;
  }

  function finishLibraryRequest(request) {
    if (request?.controller === libraryRequestController) libraryRequestController = null;
  }

  function invalidateLibraryRequest() {
    libraryRequestId += 1;
    libraryRequestController?.abort();
    libraryRequestController = null;
  }

  function setReaderNavigationStatus(message, tone = "loading") {
    const page = document.querySelector(".novel-reader-page");
    if (!page) return false;
    window.clearTimeout(readerStatusTimer);
    readerStatusTimer = null;
    let status = page.querySelector(".novel-reader-navigation-status");
    if (!status) {
      status = document.createElement("div");
      status.className = "novel-reader-navigation-status";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      page.append(status);
    }
    status.className = `novel-reader-navigation-status ${tone}`;
    status.textContent = message;
    page.setAttribute("aria-busy", tone === "loading" ? "true" : "false");
    if (tone === "error") {
      readerStatusTimer = window.setTimeout(() => {
        status.remove();
        page.removeAttribute("aria-busy");
        if (!state.novel.loading && state.novel.status === message) state.novel.status = "";
      }, 3600);
    }
    return true;
  }

  function clearReaderNavigationStatus() {
    window.clearTimeout(readerStatusTimer);
    readerStatusTimer = null;
    const page = document.querySelector(".novel-reader-page");
    page?.querySelector(".novel-reader-navigation-status")?.remove();
    page?.removeAttribute("aria-busy");
  }

  function readerNavigationErrorMessage(error) {
    const message = String(error?.message || "").trim();
    if (!message || /failed to fetch|network\s*error|load failed/i.test(message)) {
      return "章节读取失败，请检查网络后重试";
    }
    return message;
  }

  function chapterCacheKey(bookId, chapterIndex) {
    return `${String(bookId || "")}::${String(chapterIndex || "")}`;
  }

  function cachedChapter(bookId, chapterIndex) {
    const key = chapterCacheKey(bookId, chapterIndex);
    const data = chapterCache.get(key);
    if (!data) return null;
    chapterCache.delete(key);
    chapterCache.set(key, data);
    return data;
  }

  function storeChapterCache(bookId, chapterIndex, data) {
    const key = chapterCacheKey(bookId, chapterIndex);
    chapterCache.delete(key);
    chapterCache.set(key, data);
    while (chapterCache.size > NOVEL_CHAPTER_CACHE_LIMIT) {
      const oldest = chapterCache.keys().next().value;
      if (oldest === undefined) break;
      chapterCache.delete(oldest);
    }
  }

  function fetchChapterData(bookId, chapterIndex, options = {}) {
    if (options.allowCache) {
      const cached = cachedChapter(bookId, chapterIndex);
      if (cached) return Promise.resolve(cached);
    }
    const key = chapterCacheKey(bookId, chapterIndex);
    const pending = chapterRequests.get(key);
    if (pending && !pending.signal?.aborted) return pending.promise;
    if (pending) chapterRequests.delete(key);
    const request = api(`/api/novels/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapterIndex)}`, {
      signal: options.signal
    })
      .then((data) => {
        storeChapterCache(bookId, chapterIndex, data);
        return data;
      })
      .finally(() => {
        if (chapterRequests.get(key)?.promise === request) chapterRequests.delete(key);
      });
    chapterRequests.set(key, { promise: request, signal: options.signal });
    return request;
  }

  function prefetchNextChapter(bookId, chapter) {
    if (!bookId || !chapter?.index) return;
    fetchChapterData(bookId, chapter.index, { allowCache: true }).catch(() => {});
  }

  function openAdjacent(direction) {
    ensureState();
    const target = direction < 0 ? state.novel.prev : state.novel.next;
    if (!target || !state.novel.book) return;
    openChapter(state.novel.book.id, target.index, { restoreProgress: false }).catch((error) => {
      state.novel.status = error.message || "章节切换失败";
      renderView();
    });
  }

  function renderStats() {
    ensureState();
    if (!els.statsRow) return;
    els.statsRow.innerHTML = "";
    const totals = state.novel.summary?.totals || state.novel.data?.summary?.totals || {};
    const stats = [
      ["书籍", formatNumber(totals.books || 0)],
      ["章节", formatNumber(totals.chapters || 0)],
      ["正文", formatNumber(totals.chars || 0)],
      ["容量", formatBytes(totals.bytes || 0)]
    ];
    for (const [label, value] of stats) {
      const stat = document.createElement("div");
      stat.className = "stat novel-stat";
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      const span = document.createElement("span");
      span.textContent = label;
      stat.append(strong, span);
      els.statsRow.append(stat);
    }
  }

  function renderView() {
    ensureState();
    if (!els.workGrid) return;
    els.workGrid.innerHTML = "";
    setReaderBodyClass();
    if (state.novel.loading && !state.novel.data && !state.novel.book && !state.novel.chapter) {
      renderHomeLoading("正在读取小说书库");
      return;
    }
    if (state.novel.chapter) {
      renderReader();
      return;
    }
    if (state.novel.book) {
      renderBookDetail();
      return;
    }
    renderHome();
  }

  function renderHomeLoading(message) {
    const shell = document.createElement("section");
    shell.className = "novel-home";
    shell.append(renderNovelMenu());

    const loading = document.createElement("div");
    loading.className = "novel-empty-card novel-home-loading";
    loading.setAttribute("role", "status");
    loading.textContent = message;
    shell.append(loading);
    els.workGrid.append(shell);
  }

  function renderLoading(message) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = message;
    els.workGrid.append(empty);
  }

  function renderHome() {
    const data = state.novel.data || {};
    const summary = state.novel.summary || data.summary || {};
    const shell = document.createElement("section");
    shell.className = "novel-home";
    shell.append(renderNovelMenu());

    if (state.novel.mode === "manage") {
      shell.classList.add("novel-home-manage");
      shell.append(renderManagementPage(summary));
      els.workGrid.append(shell);
      return;
    }

    if (state.novel.mode === "rankings") {
      libraryObserver?.disconnect();
      libraryObserver = null;
      shell.append(renderRankingBoard(data));
      els.workGrid.append(shell);
      return;
    }

    if (state.novel.mode === "mine") {
      shell.append(renderNovelPageHeading("我的阅读", "阅读记录和继续阅读入口"));
    }

    const head = document.createElement("div");
    head.className = "novel-home-head";
    const authorProfile = state.novel.mode === "author" ? data.author || null : null;
    if (authorProfile) {
      head.classList.add("novel-author-profile-head");
      const avatar = document.createElement("div");
      avatar.className = "novel-author-profile-avatar";
      avatar.textContent = String(authorProfile.name || "作").slice(0, 1).toLocaleUpperCase();
      head.append(avatar);
    }
    const titleWrap = document.createElement("div");
    const eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = authorProfile ? "小说作者" : "本地小说";
    const title = document.createElement("h2");
    title.textContent = authorProfile?.name || "小说书库";
    const meta = document.createElement("p");
    const totals = summary.totals || {};
    meta.textContent = authorProfile
      ? `${formatNumber(authorProfile.bookCount || 0)} 本作品 · ${formatNumber(authorProfile.chapterCount || 0)} 章 · ${formatNumber(authorProfile.charCount || 0)} 字 · ${formatBytes(authorProfile.sizeBytes || 0)}`
      : `${formatNumber(totals.books || 0)} 本 · ${formatNumber(totals.authors || 0)} 位作者 · ${formatNumber(totals.chapters || 0)} 章 · ${formatBytes(totals.bytes || 0)}`;
    titleWrap.append(eyebrow, title, meta);
    head.append(titleWrap);

    const controls = document.createElement("div");
    controls.className = "novel-controls";
    const sort = document.createElement("select");
    sort.className = "novel-sort";
    const sortOptions = [["updated", "最近更新"], ["chars", "字数最多"], ["progress", "最近阅读"], ["chapters", "章节最多"], ["size", "文件最大"], ["title", "书名"]];
    for (const option of sortOptions) {
      const item = document.createElement("option");
      item.value = option[0];
      item.textContent = option[1];
      sort.append(item);
    }
    sort.value = state.novel.sort || "updated";
    sort.addEventListener("change", () => {
      state.novel.sort = sort.value;
      state.novel.page = 0;
      loadNovels({ replaceRoute: true }).catch(() => {});
    });
    if (!authorProfile && state.novel.mode !== "mine") controls.append(sort);
    if (controls.childElementCount === 1) controls.classList.add("single");

    const categories = document.createElement("div");
    categories.className = "novel-category-row";
    if (state.novel.mode === "books") {
      categories.append(categoryButton("all", "全部", summary.totals?.books || 0));
      for (const item of data.facets || summary.categories || []) {
        categories.append(categoryButton(item.name, item.name, item.count));
      }
    }

    const entries = data.books || [];
    let list = state.novel.mode === "mine" ? renderRecent(entries) : null;
    if (!list) {
      list = document.createElement("div");
      list.className = "novel-book-list";
      for (const [index, entry] of entries.entries()) {
        list.append(renderBookRow(entry));
      }
    }
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "novel-empty-card";
      empty.textContent = state.novel.status || (state.novel.query ? "没有找到匹配的小说。" : "没有匹配的小说。");
      list.append(empty);
    }

    if (authorProfile) shell.append(head);
    if (controls.childElementCount) shell.append(controls);
    if (categories.childElementCount) shell.append(categories);
    if (state.novel.status && entries.length) {
      const status = document.createElement("div");
      status.className = "novel-status-line";
      status.textContent = state.novel.status;
      shell.append(status);
    }
    shell.append(list);
    if (state.novel.hasMore || state.novel.loadingMore) {
      const sentinel = document.createElement("div");
      sentinel.className = "novel-library-autoload";
      sentinel.setAttribute("role", "status");
      sentinel.textContent = state.novel.loadingMore ? "正在继续加载…" : "继续向下滚动加载更多";
      shell.append(sentinel);
    }
    els.workGrid.append(shell);
    armLibraryAutoload();
  }

  function armLibraryAutoload() {
    libraryObserver?.disconnect();
    libraryObserver = null;
    const sentinel = document.querySelector(".novel-library-autoload");
    if (!sentinel || !state.novel.hasMore || state.novel.loading || state.novel.loadingMore) return;
    libraryObserver = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        libraryObserver?.disconnect();
        libraryObserver = null;
        loadNovels({ append: true, skipRoute: true }).catch((error) => {
          state.novel.loadingMore = false;
          state.novel.status = error.message || "继续加载失败";
          renderView();
        });
      },
      { rootMargin: "600px 0px" }
    );
    libraryObserver.observe(sentinel);
  }

  function renderNovelPageHeading(titleText, descriptionText) {
    const heading = document.createElement("header");
    heading.className = "novel-page-heading";
    const title = document.createElement("h2");
    title.textContent = titleText;
    const description = document.createElement("p");
    description.textContent = descriptionText;
    heading.append(title, description);
    return heading;
  }

  function renderNovelMenu() {
    const nav = document.createElement("nav");
    nav.className = "novel-section-menu";
    nav.setAttribute("aria-label", "小说功能");
    for (const [mode, label] of [["books", "书库"], ["mine", "我的"], ["rankings", "排行榜"], ["manage", "管理"]]) {
      const button = document.createElement("button");
      button.type = "button";
      const active = mode === "books" ? ["books", "author"].includes(state.novel.mode) : state.novel.mode === mode;
      button.className = active ? "active" : "";
      button.textContent = label;
      if (active) button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => openNovelSection(mode));
      nav.append(button);
    }
    const search = document.createElement("form");
    search.className = "novel-section-search";
    search.setAttribute("role", "search");
    const input = document.createElement("input");
    input.type = "search";
    input.value = state.novel.query || "";
    input.placeholder = "搜索书名、作者、分类或简介";
    input.autocomplete = "off";
    input.setAttribute("aria-label", "搜索小说");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "搜索";
    search.append(input, submit);
    search.addEventListener("submit", (event) => {
      event.preventDefault();
      openNovelSearch(input.value);
    });
    nav.append(search);
    return nav;
  }

  function openNovelSection(mode) {
    if (!["books", "mine", "rankings", "manage"].includes(mode)) return;
    if (mode !== "manage") collectionAdmin.stopPolling();
    flushProgress();
    invalidateNavigation();
    state.novel.book = null;
    state.novel.chapter = null;
    state.novel.mode = mode;
    state.novel.query = "";
    state.novel.category = "all";
    state.novel.author = "";
    state.novel.page = 0;
    state.novel.sort = mode === "mine" ? "progress" : mode === "rankings" ? "chars" : "updated";
    state.novel.data = null;
    loadNovels().catch((error) => {
      state.novel.loading = false;
      state.novel.status = error.message || "页面读取失败";
      renderView();
    });
  }

  function openNovelSearch(value) {
    collectionAdmin.stopPolling();
    flushProgress();
    invalidateNavigation();
    state.novel.book = null;
    state.novel.chapter = null;
    state.novel.mode = "books";
    state.novel.query = String(value || "").trim();
    state.novel.category = "all";
    state.novel.author = "";
    state.novel.page = 0;
    state.novel.sort = "updated";
    state.novel.data = null;
    loadNovels().catch((error) => {
      state.novel.loading = false;
      state.novel.status = error.message || "搜索失败";
      renderView();
    });
  }

  function renderManagementPage(summary = {}) {
    const panel = document.createElement("section");
    panel.className = "novel-management";
    const sections = new Set(["upload", "collect", "config"]);
    state.novel.manageSection = sections.has(state.novel.manageSection) ? state.novel.manageSection : "collect";
    const totals = summary.totals || {};
    const shell = document.createElement("div");
    shell.className = "novel-management-console";
    const sidebar = document.createElement("aside");
    sidebar.className = "novel-management-sidebar";
    const brand = document.createElement("div");
    brand.className = "novel-management-brand";
    const brandMark = document.createElement("span");
    brandMark.textContent = "TXT";
    const brandCopy = document.createElement("div");
    const brandTitle = document.createElement("strong");
    brandTitle.textContent = "小说管理台";
    const brandSubtitle = document.createElement("span");
    brandSubtitle.textContent = "本地书库后台";
    brandCopy.append(brandTitle, brandSubtitle);
    brand.append(brandMark, brandCopy);

    const nav = document.createElement("nav");
    nav.className = "novel-management-side-nav";
    nav.setAttribute("aria-label", "小说管理功能");
    const sectionItems = [
      ["upload", "01", "书库上传", "TXT 导入与书库刷新"],
      ["collect", "02", "采集任务", "队列、进度与运行日志"],
      ["config", "03", "站点配置", "登录凭据与站点适配器"]
    ];
    for (const [value, index, label, description] of sectionItems) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "novel-management-side-item";
      if (state.novel.manageSection === value) {
        button.classList.add("active");
        button.setAttribute("aria-current", "page");
      }
      const number = document.createElement("span");
      number.className = "novel-management-side-index";
      number.textContent = index;
      const copy = document.createElement("span");
      copy.className = "novel-management-side-copy";
      const strong = document.createElement("strong");
      strong.textContent = label;
      const small = document.createElement("small");
      small.textContent = description;
      copy.append(strong, small);
      button.append(number, copy);
      button.addEventListener("click", () => {
        if (state.novel.manageSection === value) return;
        state.novel.manageSection = value;
        renderView();
      });
      nav.append(button);
    }

    const sidebarStatus = document.createElement("div");
    sidebarStatus.className = "novel-management-sidebar-status";
    const sidebarStatusLabel = document.createElement("span");
    sidebarStatusLabel.textContent = "书库状态";
    const sidebarStatusValue = document.createElement("strong");
    sidebarStatusValue.textContent = `${formatNumber(totals.books || 0)} 本 · ${formatNumber(totals.chapters || 0)} 章`;
    const sidebarStatusTime = document.createElement("small");
    sidebarStatusTime.textContent = summary.scannedAt ? `更新 ${formatDateTime(summary.scannedAt)}` : "尚未扫描";
    sidebarStatus.append(sidebarStatusLabel, sidebarStatusValue, sidebarStatusTime);
    sidebar.append(brand, nav, sidebarStatus);

    const main = document.createElement("section");
    main.className = "novel-management-main";
    if (state.novel.manageSection === "upload") {
      const header = document.createElement("header");
      header.className = "novel-management-page-head";
      const eyebrow = document.createElement("div");
      eyebrow.className = "eyebrow";
      eyebrow.textContent = "书库维护";
      const title = document.createElement("h2");
      title.textContent = "书库上传";
      const description = document.createElement("p");
      description.textContent = "批量导入 TXT 小说，查看书库规模并执行完整扫描。";
      header.append(eyebrow, title, description);

      const overview = document.createElement("section");
      overview.className = "novel-management-overview";
      const metrics = document.createElement("div");
      metrics.className = "novel-management-metrics";
      for (const [label, value] of [
        ["书籍", formatNumber(totals.books || 0)],
        ["章节", formatNumber(totals.chapters || 0)],
        ["正文", formatNumber(totals.chars || 0)],
        ["最近扫描", summary.scannedAt ? formatDateTime(summary.scannedAt) : "暂无记录"]
      ]) {
        const item = document.createElement("div");
        const span = document.createElement("span");
        span.textContent = label;
        const strong = document.createElement("strong");
        strong.textContent = String(value);
        item.append(span, strong);
        metrics.append(item);
      }

      const uploadCard = document.createElement("section");
      uploadCard.className = "novel-management-action-card";
      const uploadCopy = document.createElement("div");
      const uploadTitle = document.createElement("h3");
      uploadTitle.textContent = "导入本地小说";
      const uploadDescription = document.createElement("p");
      uploadDescription.textContent = "支持一次选择多个 TXT 文件；上传完成后会自动解析书名、作者与章节。";
      uploadCopy.append(uploadTitle, uploadDescription);
      const actions = document.createElement("div");
      actions.className = "novel-management-quick-actions";
      const uploadInput = document.createElement("input");
      uploadInput.type = "file";
      uploadInput.accept = ".txt,text/plain";
      uploadInput.multiple = true;
      uploadInput.className = "novel-upload-input";
      const uploadButton = document.createElement("button");
      uploadButton.type = "button";
      uploadButton.className = "novel-primary-button";
      uploadButton.textContent = state.novel.uploading ? "正在上传" : "选择 TXT 文件";
      uploadButton.disabled = state.novel.uploading;
      uploadButton.addEventListener("click", () => uploadInput.click());
      uploadInput.addEventListener("change", () => {
        const files = Array.from(uploadInput.files || []);
        uploadInput.value = "";
        uploadNovelFiles(files).catch((error) => {
          state.novel.uploading = false;
          state.novel.status = error.message || "上传失败";
          renderView();
        });
      });
      const refreshButton = document.createElement("button");
      refreshButton.type = "button";
      refreshButton.className = "novel-secondary-button";
      refreshButton.textContent = "刷新整本书库";
      refreshButton.disabled = state.novel.uploading;
      refreshButton.addEventListener("click", () => openAdminScript("novel-library-rescan"));
      actions.append(uploadInput, uploadButton, refreshButton);
      uploadCard.append(uploadCopy, actions);
      overview.append(metrics);
      main.append(header, overview, uploadCard);
    } else {
      main.append(collectionAdmin.render({ section: state.novel.manageSection }));
    }
    if (state.novel.status) {
      const status = document.createElement("div");
      status.className = "novel-management-status";
      status.textContent = state.novel.status;
      main.prepend(status);
    }
    shell.append(sidebar, main);
    panel.append(shell);
    return panel;
  }

  function renderRankingBoard(data = {}) {
    const books = Array.isArray(data.books) ? data.books : [];
    const panel = document.createElement("section");
    panel.className = "novel-ranking-board";

    const toolbar = document.createElement("header");
    toolbar.className = "novel-ranking-toolbar";
    const heading = document.createElement("div");
    heading.className = "novel-ranking-heading";
    const title = document.createElement("h2");
    title.textContent = "排行榜";
    const description = document.createElement("p");
    const total = Math.max(0, Number(data.total || 0));
    const limit = Math.max(1, Number(data.limit || NOVEL_RANKING_PAGE_SIZE));
    const pageCount = Math.max(1, Math.ceil(total / limit));
    description.textContent = `共 ${formatNumber(total)} 本 · 第 ${formatNumber(state.novel.page + 1)} / ${formatNumber(pageCount)} 页`;
    heading.append(title, description);

    const sorts = document.createElement("div");
    sorts.className = "novel-ranking-sorts";
    sorts.setAttribute("role", "group");
    sorts.setAttribute("aria-label", "排行榜排序");
    for (const [value, label, titleText] of [
      ["updated", "按日期", "按照书库更新时间从新到旧排序"],
      ["chars", "按字数", "按照正文总字数从高到低排序"]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.novel.sort === value ? "active" : "";
      button.textContent = label;
      button.title = titleText;
      button.setAttribute("aria-pressed", state.novel.sort === value ? "true" : "false");
      button.addEventListener("click", () => {
        if (state.novel.sort === value) return;
        state.novel.sort = value;
        state.novel.page = 0;
        loadNovels({ replaceRoute: true }).catch(() => {});
      });
      sorts.append(button);
    }
    toolbar.append(heading, sorts);
    panel.append(toolbar);

    const tableWrap = document.createElement("div");
    tableWrap.className = "novel-ranking-table-wrap";
    const table = document.createElement("table");
    table.className = "novel-ranking-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const label of ["序号", "小说分类", "书名", "最新章节", "作者", "字数", "更新时间"]) {
      const cell = document.createElement("th");
      cell.scope = "col";
      cell.textContent = label;
      headRow.append(cell);
    }
    head.append(headRow);
    table.append(head);

    const body = document.createElement("tbody");
    const rankingOffset = Math.max(0, Number(data.offset || state.novel.page * limit));
    for (const [index, book] of books.entries()) {
      body.append(renderRankingRow(book, rankingOffset + index + 1));
    }
    if (!books.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.className = "novel-ranking-empty";
      cell.textContent = state.novel.status || "排行榜暂时没有小说。";
      row.append(cell);
      body.append(row);
    }
    table.append(body);
    tableWrap.append(table);
    panel.append(tableWrap);

    const pagination = renderLibraryPagination(data);
    if (pagination) panel.append(pagination);
    return panel;
  }

  function renderRankingRow(book, rank) {
    const row = document.createElement("tr");
    row.className = "novel-ranking-row";
    row.tabIndex = 0;
    row.setAttribute("aria-label", `第 ${rank} 名，《${book.title}》`);

    const rankCell = document.createElement("td");
    rankCell.className = `novel-ranking-position${rank <= 3 ? " top" : ""}`;
    rankCell.textContent = formatNumber(rank);

    const category = document.createElement("td");
    category.textContent = book.category || "未分类";

    const titleCell = document.createElement("td");
    const title = document.createElement("button");
    title.type = "button";
    title.className = "novel-ranking-book";
    title.textContent = book.title || "未命名小说";
    title.addEventListener("click", (event) => {
      event.stopPropagation();
      openBook(book.id);
    });
    titleCell.append(title);

    const latestCell = document.createElement("td");
    if (book.latestChapterTitle && book.chapterCount) {
      const latest = document.createElement("button");
      latest.type = "button";
      latest.className = "novel-ranking-latest";
      latest.textContent = book.latestChapterTitle;
      latest.title = "打开最新章节";
      latest.addEventListener("click", (event) => {
        event.stopPropagation();
        openChapter(book.id, book.chapterCount, { restoreProgress: false });
      });
      latestCell.append(latest);
    } else {
      latestCell.textContent = "—";
    }

    const authorCell = document.createElement("td");
    const authorName = String(book.author || "").trim();
    if (authorName) {
      const author = document.createElement("button");
      author.type = "button";
      author.className = "novel-ranking-author";
      author.textContent = authorName;
      author.addEventListener("click", (event) => {
        event.stopPropagation();
        openNovelAuthor(authorName);
      });
      authorCell.append(author);
    } else {
      authorCell.textContent = "未知作者";
    }

    const chars = document.createElement("td");
    chars.className = "novel-ranking-number";
    chars.textContent = formatNumber(book.charCount || 0);

    const updated = document.createElement("td");
    updated.className = "novel-ranking-date";
    updated.textContent = formatNovelDate(book.updatedAt);

    row.append(rankCell, category, titleCell, latestCell, authorCell, chars, updated);
    row.addEventListener("click", () => openBook(book.id));
    row.addEventListener("keydown", (event) => {
      if (event.target !== row || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      openBook(book.id);
    });
    return row;
  }

  function renderLibraryPagination(data = {}) {
    const total = Math.max(0, Number(data.total || 0));
    const limit = Math.max(1, Number(data.limit || NOVEL_RANKING_PAGE_SIZE));
    const pageCount = Math.max(1, Math.ceil(total / limit));
    if (pageCount <= 1) return null;
    const page = Math.max(0, Math.min(pageCount - 1, Number(state.novel.page || 0)));
    const nav = document.createElement("nav");
    nav.className = "novel-library-pagination";
    nav.setAttribute("aria-label", "排行榜分页");
    const previous = document.createElement("button");
    previous.type = "button";
    previous.className = "novel-pagination-direction";
    previous.textContent = "上一页";
    previous.disabled = page <= 0;
    previous.addEventListener("click", () => changeLibraryPage(page - 1));

    const pages = document.createElement("div");
    pages.className = "novel-pagination-pages";
    let previousPage = -1;
    for (const index of rankingPaginationPages(pageCount, page)) {
      if (previousPage >= 0 && index - previousPage > 1) {
        const ellipsis = document.createElement("span");
        ellipsis.className = "novel-pagination-ellipsis";
        ellipsis.textContent = "…";
        ellipsis.setAttribute("aria-hidden", "true");
        pages.append(ellipsis);
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = index === page ? "active" : "";
      button.textContent = formatNumber(index + 1);
      button.setAttribute("aria-label", `第 ${formatNumber(index + 1)} 页`);
      if (index === page) button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => changeLibraryPage(index));
      pages.append(button);
      previousPage = index;
    }

    const next = document.createElement("button");
    next.type = "button";
    next.className = "novel-pagination-direction";
    next.textContent = "下一页";
    next.disabled = page >= pageCount - 1;
    next.addEventListener("click", () => changeLibraryPage(page + 1));
    nav.append(previous, pages, next);
    return nav;
  }

  function rankingPaginationPages(pageCount, page) {
    const pages = new Set([0, 1, pageCount - 2, pageCount - 1]);
    for (let index = page - 3; index <= page + 3; index += 1) pages.add(index);
    return [...pages].filter((index) => index >= 0 && index < pageCount).sort((a, b) => a - b);
  }

  function changeLibraryPage(page) {
    const total = Math.max(0, Number(state.novel.data?.total || 0));
    const limit = Math.max(1, Number(state.novel.data?.limit || NOVEL_RANKING_PAGE_SIZE));
    const lastPage = Math.max(0, Math.ceil(total / limit) - 1);
    const nextPage = Math.max(0, Math.min(lastPage, Number(page || 0)));
    if (nextPage === state.novel.page) return;
    state.novel.page = nextPage;
    loadNovels({ replaceRoute: true }).then(() => {
      document.querySelector(".novel-home")?.scrollIntoView({ block: "start", behavior: "auto" });
    }).catch(() => {});
  }

  function openNovelAuthor(authorName) {
    const name = String(authorName || "").trim();
    if (!name || name === "未知作者") return;
    state.novel.mode = "author";
    state.novel.author = name;
    state.novel.query = "";
    state.novel.category = "all";
    state.novel.page = 0;
    state.novel.sort = "title";
    state.novel.data = null;
    loadNovels().catch(() => {});
  }

  function renderBookMeta(book, rank = 0) {
    const meta = document.createElement("p");
    meta.className = "novel-book-meta";
    if (rank) meta.append(document.createTextNode(`${formatNumber(book.charCount)} 字 · `));
    const authorName = String(book.author || "未知作者").trim() || "未知作者";
    if (authorName === "未知作者") {
      meta.append(document.createTextNode(authorName));
    } else {
      const author = document.createElement("button");
      author.type = "button";
      author.className = "novel-book-author";
      author.textContent = authorName;
      author.title = `查看 ${authorName} 的作品`;
      author.addEventListener("click", (event) => {
        event.stopPropagation();
        openNovelAuthor(authorName);
      });
      meta.append(author);
    }
    for (const value of [book.category, `${formatNumber(book.chapterCount)} 章`, formatBytes(book.sizeBytes)].filter(Boolean)) {
      meta.append(document.createTextNode(` · ${value}`));
    }
    return meta;
  }

  function renderAuthorFilter() {
    const bar = document.createElement("div");
    bar.className = "novel-author-filter";
    const label = document.createElement("span");
    label.textContent = `只看 ${state.novel.author} 的作品`;
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "查看全部";
    clear.addEventListener("click", () => {
      state.novel.author = "";
      state.novel.page = 0;
      state.novel.sort = "updated";
      loadNovels({ replaceRoute: true }).catch(() => {});
    });
    bar.append(label, clear);
    return bar;
  }

  function categoryButton(value, label, count) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `novel-chip${state.novel.category === value ? " active" : ""}`;
    button.textContent = `${label} ${formatNumber(count || 0)}`;
    button.addEventListener("click", () => {
      if (state.novel.category === value) return;
      state.novel.category = value;
      state.novel.page = 0;
      loadNovels({ replaceRoute: true }).catch(() => {});
    });
    return button;
  }

  function renderRecent(items) {
    if (!items.length) return null;
    const panel = document.createElement("section");
    panel.className = "novel-recent";
    const title = document.createElement("h3");
    title.textContent = "继续阅读";
    const strip = document.createElement("div");
    strip.className = "novel-recent-strip";
    for (const book of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "novel-recent-item";
      const strong = document.createElement("strong");
      strong.textContent = book.title;
      const span = document.createElement("span");
      span.textContent = compactBookProgress(book);
      button.append(strong, span);
      button.addEventListener("click", () => openChapter(book.id, book.progress?.chapterIndex || 1, { restoreProgress: true }));
      strip.append(button);
    }
    panel.append(title, strip);
    return panel;
  }

  function renderBookRow(book, rank = 0) {
    const row = document.createElement("article");
    row.className = `novel-book-row${rank ? " ranking" : ""}`;
    if (rank) {
      const badge = document.createElement("span");
      badge.className = `novel-rank-number${rank <= 3 ? " top" : ""}`;
      badge.textContent = String(rank);
      badge.setAttribute("aria-label", `第 ${rank} 名`);
      row.append(badge);
    }
    row.append(renderCover(book));
    const body = document.createElement("div");
    body.className = "novel-book-row-body";
    const title = document.createElement("h3");
    title.textContent = book.title;
    const meta = renderBookMeta(book, rank);
    const summary = document.createElement("p");
    summary.className = "novel-book-summary";
    summary.textContent = book.summary || book.latestChapterTitle || book.relativePath;
    const latest = document.createElement(book.latestChapterTitle && book.chapterCount ? "button" : "div");
    latest.className = "novel-book-latest";
    latest.textContent = book.latestChapterTitle ? `最新：${book.latestChapterTitle}` : "TXT 本地导入";
    if (latest instanceof HTMLButtonElement) {
      latest.type = "button";
      latest.title = "打开最新章节";
      latest.addEventListener("click", (event) => {
        event.stopPropagation();
        openChapter(book.id, book.chapterCount, { restoreProgress: false });
      });
    }
    body.append(title, meta, summary, latest);
    const actions = document.createElement("div");
    actions.className = "novel-book-actions";
    const detail = document.createElement("button");
    detail.type = "button";
    detail.textContent = "书籍详情";
    detail.addEventListener("click", (event) => {
      event.stopPropagation();
      openBook(book.id);
    });
    const read = document.createElement("button");
    read.type = "button";
    read.className = "primary";
    read.textContent = book.progress ? "继续阅读" : "开始阅读";
    read.addEventListener("click", (event) => {
      event.stopPropagation();
      openReading(book);
    });
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "下载TXT";
    download.addEventListener("click", (event) => downloadBook(book, event));
    actions.append(read, detail, download);
    row.append(body, actions);
    row.tabIndex = 0;
    row.addEventListener("click", () => openBook(book.id));
    row.addEventListener("keydown", (event) => {
      if (event.target !== row || !["Enter", " "].includes(event.key)) return;
      event.preventDefault();
      openBook(book.id);
    });
    return row;
  }

  function renderBookDetail() {
    const book = state.novel.book;
    const chapters = state.novel.chapters || [];
    const shell = document.createElement("section");
    shell.className = "novel-detail";
    shell.append(renderNovelMenu(), renderBreadcrumbs([{ label: "小说书库", action: showHome }, { label: book.title }]));

    const hero = document.createElement("section");
    hero.className = "novel-detail-hero";
    hero.append(renderCover(book, "large"));
    const info = document.createElement("div");
    info.className = "novel-detail-info";
    const title = document.createElement("h2");
    title.textContent = book.title;
    const meta = document.createElement("p");
    meta.textContent = [book.author || "未知作者", book.category, `${formatNumber(book.chapterCount)} 章`, formatBytes(book.sizeBytes)].join(" · ");
    const metrics = document.createElement("div");
    metrics.className = "novel-detail-metrics";
    for (const item of [
      ["字数", `${formatNumber(book.charCount)}`],
      ["章节", `${formatNumber(book.chapterCount)}`],
      ["进度", book.progress ? `${Math.round(readingProgress(book).overallRatio * 1000) / 10}%` : "未读"]
    ]) {
      const metric = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = item[1];
      const small = document.createElement("small");
      small.textContent = item[0];
      metric.append(strong, small);
      metrics.append(metric);
    }
    const actions = document.createElement("div");
    actions.className = "novel-detail-actions";
    const start = document.createElement("button");
    start.type = "button";
    start.className = "novel-primary-button";
    start.textContent = book.progress ? "继续阅读" : "开始阅读";
    start.addEventListener("click", () => openChapter(book.id, book.progress?.chapterIndex || 1, { restoreProgress: Boolean(book.progress) }));
    const catalogButton = document.createElement("button");
    catalogButton.type = "button";
    catalogButton.className = "novel-secondary-button";
    catalogButton.textContent = "查看目录";
    catalogButton.addEventListener("click", () => document.querySelector(".novel-catalog")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    const download = document.createElement("button");
    download.type = "button";
    download.className = "novel-secondary-button";
    download.textContent = "下载TXT";
    download.addEventListener("click", (event) => downloadBook(book, event));
    const reimport = document.createElement("button");
    reimport.type = "button";
    reimport.className = "novel-secondary-button";
    reimport.textContent = "重新导入";
    reimport.addEventListener("click", () => openBookReimportDialog(book));
    const correct = document.createElement("button");
    correct.type = "button";
    correct.className = "novel-secondary-button";
    correct.textContent = "校正信息";
    correct.addEventListener("click", () => openBookCorrectionDialog(book));
    actions.append(start, catalogButton, download, reimport, correct);
    info.append(title, meta, metrics, actions);
    const side = document.createElement("aside");
    side.className = "novel-detail-reading";
    const sideTitle = document.createElement("strong");
    sideTitle.textContent = "阅读状态";
    const progressChapter = book.progress
      ? chapters.find((chapter) => Number(chapter.index) === Number(book.progress.chapterIndex)) || {
          index: Number(book.progress.chapterIndex),
          title: state.novel.progressChapterTitle || `第 ${formatNumber(book.progress.chapterIndex)} 章`
        }
      : null;
    const latestChapter = book.chapterCount
      ? {
          index: Number(book.chapterCount),
          title: book.latestChapterTitle || `第 ${formatNumber(book.chapterCount)} 章`
        }
      : null;
    if (progressChapter) {
      side.append(createDetailChapterAction("上次读到", book, progressChapter, true));
    } else {
      const unread = document.createElement("p");
      unread.textContent = "还没有阅读记录，从第一章开始即可。";
      side.append(unread);
    }
    if (latestChapter && Number(latestChapter.index) !== Number(progressChapter?.index)) {
      side.append(createDetailChapterAction("最新章节", book, latestChapter));
    }
    const updated = document.createElement("span");
    updated.textContent = book.updatedAt ? `书库更新于 ${formatDateTime(book.updatedAt)}` : "";
    side.prepend(sideTitle);
    side.append(updated);
    hero.append(info, side);

    const intro = document.createElement("section");
    intro.className = "novel-intro";
    const introTitle = document.createElement("h3");
    introTitle.textContent = "作品简介";
    const introText = document.createElement("p");
    introText.textContent = book.summary || "本地 TXT 暂无简介，已按章节切分并保存到独立数据库。";
    intro.append(introTitle, introText);

    const catalog = document.createElement("section");
    catalog.className = "novel-catalog";
    const catalogHead = document.createElement("div");
    const catalogTitle = document.createElement("h3");
    catalogTitle.textContent = "目录";
    const catalogMeta = document.createElement("span");
    catalogMeta.textContent = `共 ${formatNumber(book.chapterCount || state.novel.catalogTotal || 0)} 章`;
    catalogHead.append(catalogTitle, catalogMeta);
    const grid = document.createElement("div");
    grid.className = "novel-catalog-browser";
    if (state.novel.catalogLoading) {
      const loading = document.createElement("div");
      loading.className = "novel-catalog-loading";
      loading.textContent = "正在读取章节目录…";
      grid.append(loading);
    } else if (state.novel.catalogError) {
      const error = document.createElement("div");
      error.className = "novel-catalog-loading error";
      error.textContent = state.novel.catalogError;
      grid.append(error);
    } else {
      grid.append(createCatalogBrowser(chapters, {
        compact: false,
        meta: catalogMeta
      }));
    }
    catalog.append(catalogHead, grid);

    shell.append(hero, intro, catalog);
    els.workGrid.append(shell);
  }

  function openBookReimportDialog(book) {
    if (!book?.id) return;
    const sourcePath = String(book.sourcePath || "");
    const sourceKind = sourcePath.startsWith("collector://")
      ? "collector"
      : sourcePath.startsWith("upload://")
        ? "upload"
        : "local";
    const dialog = document.createElement("dialog");
    dialog.className = "novel-correction-dialog novel-reimport-dialog";
    const form = document.createElement("form");
    form.method = "dialog";
    form.addEventListener("submit", (event) => event.preventDefault());
    const header = document.createElement("div");
    header.className = "novel-correction-head";
    const heading = document.createElement("h2");
    heading.textContent = `重新导入《${book.title}》`;
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "关闭");
    close.textContent = "×";
    close.addEventListener("click", () => dialog.close());
    header.append(heading, close);

    const copy = document.createElement("div");
    copy.className = "novel-reimport-copy";
    const description = document.createElement("p");
    description.textContent = sourceKind === "collector"
      ? "选择一个 TXT 覆盖当前章节；也可以按原网址重新创建完整采集任务。"
      : sourceKind === "upload"
        ? "选择新的 TXT 覆盖当前章节，并重新识别编码和章节。"
        : "选择一个 TXT 覆盖当前章节；也可以直接重新读取登记的原始文件。";
    const preserved = document.createElement("p");
    preserved.className = "novel-reimport-preserved";
    preserved.textContent = "阅读进度和手工校正的书名、作者、分类、简介都会保留。";
    const source = document.createElement("div");
    source.className = "novel-reimport-source";
    const sourceLabel = document.createElement("span");
    sourceLabel.textContent = sourceKind === "collector" ? "原始网址" : sourceKind === "upload" ? "当前文件" : "原始文件";
    const sourceValue = document.createElement("code");
    sourceValue.textContent = sourceKind === "collector"
      ? book.relativePath || "未记录"
      : sourceKind === "upload"
        ? book.fileName || "上传 TXT"
        : sourcePath || "未记录";
    sourceValue.title = sourceValue.textContent;
    source.append(sourceLabel, sourceValue);
    copy.append(description, preserved, source);

    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,text/plain";
    input.className = "novel-upload-input";
    const message = document.createElement("div");
    message.className = "novel-correction-message";
    message.setAttribute("role", "status");
    const footer = document.createElement("div");
    footer.className = "novel-correction-actions";
    const sourceAction = sourceKind === "upload" ? null : document.createElement("button");
    if (sourceAction) {
      sourceAction.type = "button";
      sourceAction.className = "novel-secondary-button";
      sourceAction.textContent = sourceKind === "collector" ? "按原网址重新采集" : "直接读取原文件";
    } else {
      footer.classList.add("single");
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "novel-secondary-button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => dialog.close());
    const primary = document.createElement("button");
    primary.type = "button";
    primary.className = "novel-primary-button";
    primary.textContent = "选择 TXT 重新导入";
    let completedKind = "";

    async function execute(body = {}, operation = "source") {
      close.disabled = true;
      cancel.disabled = true;
      primary.disabled = true;
      if (sourceAction) sourceAction.disabled = true;
      primary.textContent = operation === "source" && sourceKind === "collector" ? "正在创建任务" : "正在重新导入";
      message.classList.remove("success");
      message.textContent = operation === "source" && sourceKind === "collector"
        ? "正在匹配采集器…"
        : "正在读取并重新拆分章节…";
      try {
        const result = await api(`/api/novels/${encodeURIComponent(book.id)}/reimport`, {
          method: "POST",
          body
        });
        completedKind = result.kind || "book";
        if (completedKind === "collection") {
          message.textContent = result.message || "已创建重新采集任务";
          state.novel.status = message.textContent;
          primary.textContent = "查看采集任务";
        } else {
          for (const key of chapterCache.keys()) {
            if (key.startsWith(`${book.id}::`)) chapterCache.delete(key);
          }
          await openBook(book.id, { skipRoute: true });
          message.textContent = result.message || `重新导入完成：${result.book?.chapterCount || 0} 章`;
          primary.textContent = "完成";
        }
        message.classList.add("success");
        close.disabled = false;
        cancel.disabled = false;
        cancel.textContent = "关闭";
        primary.disabled = false;
        if (sourceAction) sourceAction.disabled = true;
      } catch (error) {
        message.textContent = error.message || "重新导入失败";
        close.disabled = false;
        cancel.disabled = false;
        primary.disabled = false;
        primary.textContent = "重新选择 TXT";
        if (sourceAction) sourceAction.disabled = false;
      }
    }

    input.addEventListener("change", () => {
      const file = Array.from(input.files || [])[0];
      input.value = "";
      if (!file) return;
      if (!/\.txt$/i.test(file.name) && !String(file.type || "").startsWith("text/")) {
        message.textContent = "请选择 TXT 文件";
        return;
      }
      primary.disabled = true;
      if (sourceAction) sourceAction.disabled = true;
      message.textContent = `正在读取 ${file.name}…`;
      readNovelFileText(file)
        .then((decoded) => execute(
          {
            fileName: file.name,
            sizeBytes: file.size,
            encoding: decoded.encoding,
            text: decoded.text
          },
          "file"
        ))
        .catch((error) => {
          message.textContent = error.message || "TXT 文件读取失败";
          primary.disabled = false;
          if (sourceAction) sourceAction.disabled = false;
        });
    });
    sourceAction?.addEventListener("click", () => execute({}, "source"));
    primary.addEventListener("click", () => {
      if (completedKind === "collection") {
        dialog.close();
        openNovelSection("manage");
        return;
      }
      if (completedKind === "book") {
        dialog.close();
        return;
      }
      input.click();
    });
    const primaryActions = document.createElement("div");
    primaryActions.className = "novel-correction-primary-actions";
    primaryActions.append(cancel, primary);
    if (sourceAction) footer.append(sourceAction);
    footer.append(primaryActions);
    form.append(header, copy, input, message, footer);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    primary.focus();
  }

  function openBookCorrectionDialog(book) {
    if (!book?.id) return;
    const dialog = document.createElement("dialog");
    dialog.className = "novel-correction-dialog";
    const form = document.createElement("form");
    form.method = "dialog";
    const header = document.createElement("div");
    header.className = "novel-correction-head";
    const heading = document.createElement("h2");
    heading.textContent = "校正书籍信息";
    const close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "关闭");
    close.textContent = "×";
    close.addEventListener("click", () => dialog.close());
    header.append(heading, close);

    const fields = document.createElement("div");
    fields.className = "novel-correction-fields";
    const titleInput = correctionField(fields, "书名", "text", book.title || "");
    titleInput.required = true;
    titleInput.maxLength = 180;
    const authorInput = correctionField(fields, "作者", "text", book.author || "");
    authorInput.maxLength = 80;
    const categoryInput = correctionField(fields, "分类", "text", book.category || "");
    categoryInput.maxLength = 80;
    const summaryInput = correctionField(fields, "作品简介", "textarea", book.summary || "");
    summaryInput.maxLength = 2000;

    const message = document.createElement("div");
    message.className = "novel-correction-message";
    message.setAttribute("role", "status");
    const footer = document.createElement("div");
    footer.className = "novel-correction-actions";
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "novel-danger-button";
    deleteButton.textContent = "删除小说";
    let deleteArmed = false;
    deleteButton.addEventListener("click", async () => {
      if (!deleteArmed) {
        deleteArmed = true;
        deleteButton.classList.add("confirm");
        deleteButton.textContent = "确认删除";
        message.textContent = `将《${book.title}》从书库移除，磁盘原始 TXT 不会删除。再次点击确认。`;
        return;
      }
      deleteButton.disabled = true;
      save.disabled = true;
      deleteButton.textContent = "正在删除";
      try {
        await api(`/api/novels/${encodeURIComponent(book.id)}`, { method: "DELETE" });
        dialog.close();
        invalidateNavigation();
        state.novel.book = null;
        state.novel.chapter = null;
        state.novel.chapters = [];
        state.novel.mode = "books";
        state.novel.author = "";
        state.novel.query = "";
        state.novel.category = "all";
        state.novel.sort = "updated";
        state.novel.page = 0;
        state.novel.data = null;
        await loadNovels({ replaceRoute: true });
        state.novel.status = `已删除《${book.title}》`;
        renderView();
      } catch (error) {
        message.textContent = error.message || "删除失败";
        deleteButton.disabled = false;
        save.disabled = false;
        deleteButton.textContent = "确认删除";
      }
    });
    const primaryActions = document.createElement("div");
    primaryActions.className = "novel-correction-primary-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "novel-secondary-button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => dialog.close());
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "novel-primary-button";
    save.textContent = "保存校正";
    primaryActions.append(cancel, save);
    footer.append(deleteButton, primaryActions);
    form.append(header, fields, message, footer);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      save.disabled = true;
      save.textContent = "正在保存";
      message.textContent = "";
      try {
        const result = await api(`/api/novels/${encodeURIComponent(book.id)}`, {
          method: "PATCH",
          body: {
            title: titleInput.value,
            author: authorInput.value,
            category: categoryInput.value,
            summary: summaryInput.value
          }
        });
        state.novel.book = { ...state.novel.book, ...result.book };
        state.novel.data = null;
        dialog.close();
        renderStats();
        renderView();
      } catch (error) {
        message.textContent = error.message || "保存失败";
        save.disabled = false;
        save.textContent = "保存校正";
      }
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    titleInput.focus();
    titleInput.select();
  }

  function correctionField(container, labelText, kind, value) {
    const label = document.createElement("label");
    const title = document.createElement("span");
    title.textContent = labelText;
    const input = kind === "textarea" ? document.createElement("textarea") : document.createElement("input");
    if (kind !== "textarea") input.type = kind;
    input.value = value;
    label.append(title, input);
    container.append(label);
    return input;
  }

  function createDetailChapterAction(label, book, chapter, restoreProgress = false) {
    const item = document.createElement("div");
    item.className = "novel-detail-chapter-action";
    const caption = document.createElement("span");
    caption.textContent = label;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${formatNumber(chapter.index)} · ${chapter.title}`;
    button.addEventListener("click", () => openChapter(book.id, chapter.index, { restoreProgress }));
    item.append(caption, button);
    return item;
  }

  function renderReader() {
    const book = state.novel.book;
    const chapter = state.novel.chapter;
    const settings = state.novel.settings;
    const page = document.createElement("section");
    page.className = `novel-reader-page theme-${settings.theme}${settings.night ? " night" : ""}`;
    page.style.setProperty("--novel-font-size", `${settings.fontSize}px`);
    page.style.setProperty("--novel-line-height", String(settings.lineHeight));
    page.style.setProperty("--novel-reader-width", `${settings.width}px`);
    page.style.setProperty("--novel-font-family", readerFontFamily(settings.font));

    const paper = document.createElement("article");
    paper.className = "novel-reader-paper";
    paper.append(renderBreadcrumbs([{ label: "小说书库", action: showHome }, { label: book.title, action: () => openBook(book.id) }, { label: chapter.title }]));
    const title = document.createElement("h1");
    title.textContent = chapter.title;
    const meta = document.createElement("div");
    meta.className = "novel-reader-meta";
    meta.textContent = [book.title, book.author || "未知作者", `${formatNumber(chapter.charCount)} 字`].join(" · ");
    const content = document.createElement("div");
    content.className = "novel-reader-content";
    for (const paragraph of paragraphsFromContent(chapter.content)) {
      const p = document.createElement("p");
      p.textContent = paragraph;
      content.append(p);
    }
    const bottom = document.createElement("nav");
    bottom.className = "novel-reader-bottom";
    bottom.append(navButton("上一章", () => openAdjacent(-1), !state.novel.prev));
    bottom.append(navButton("目录", () => toggleCatalog(true), false));
    bottom.append(navButton("下一章", () => openAdjacent(1), !state.novel.next));
    paper.append(title, meta, content, bottom);
    page.append(paper, renderReaderToolbar());
    if (state.novel.catalogOpen) page.append(renderCatalogDrawer());
    if (state.novel.settingsOpen) page.append(renderSettingsPanel());
    els.workGrid.append(page);
  }

  function renderReaderToolbar() {
    const toolbar = document.createElement("aside");
    toolbar.className = "novel-reader-toolbar";
    toolbar.append(toolbarButton("目录", "☰", () => toggleCatalog()));
    toolbar.append(toolbarButton("书页", "□", () => openBook(state.novel.book.id)));
    toolbar.append(toolbarButton("夜间", "☾", () => updateSettings({ night: !state.novel.settings.night })));
    toolbar.append(toolbarButton("下载", "↓", () => downloadBook(state.novel.book)));
    toolbar.append(toolbarButton("设置", "Aa", () => toggleSettings()));
    return toolbar;
  }

  function toolbarButton(label, icon, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "novel-toolbar-button";
    const strong = document.createElement("strong");
    strong.textContent = icon;
    const span = document.createElement("span");
    span.textContent = label;
    button.append(strong, span);
    button.addEventListener("click", action);
    return button;
  }

  function renderCatalogDrawer() {
    const wrap = document.createElement("div");
    wrap.className = "novel-reader-drawer";
    const panel = document.createElement("aside");
    panel.className = "novel-reader-drawer-panel";
    const head = document.createElement("div");
    head.className = "novel-reader-drawer-head";
    const title = document.createElement("strong");
    title.textContent = `章节目录 · ${formatNumber(state.novel.book?.chapterCount || state.novel.chapters?.length || 0)} 章`;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.addEventListener("click", () => toggleCatalog(false));
    head.append(title, close);
    panel.append(head);
    if (state.novel.catalogLoading) {
      const loading = document.createElement("div");
      loading.className = "novel-catalog-loading";
      loading.textContent = "正在读取章节目录…";
      panel.append(loading);
    } else if (state.novel.catalogError) {
      const error = document.createElement("div");
      error.className = "novel-catalog-loading error";
      error.textContent = state.novel.catalogError;
      panel.append(error);
    } else {
      panel.append(createCatalogBrowser(state.novel.chapters || [], {
        compact: true
      }));
    }
    wrap.append(panel);
    wrap.addEventListener("click", (event) => {
      if (event.target === wrap) toggleCatalog(false);
    });
    return wrap;
  }

  function createCatalogBrowser(chapters, options = {}) {
    const source = Array.isArray(chapters) ? chapters : [];
    const shell = document.createElement("div");
    shell.className = `novel-catalog-browser-inner${options.compact ? " compact" : ""}`;
    const tools = document.createElement("div");
    tools.className = "novel-catalog-tools";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "搜索章节名或章数";
    search.setAttribute("aria-label", "搜索章节");
    search.value = state.novel.catalogQuery || "";
    const order = document.createElement("button");
    order.type = "button";
    order.className = "novel-catalog-order";
    const status = document.createElement("span");
    status.className = "novel-catalog-status";
    const list = document.createElement("div");
    list.className = options.compact ? "novel-reader-catalog-list" : "novel-catalog-grid";

    function refresh() {
      const query = String(state.novel.catalogQuery || "").trim().toLocaleLowerCase("zh-Hans-CN");
      const visible = query
        ? source.filter((chapter) => String(chapter.title || "").toLocaleLowerCase("zh-Hans-CN").includes(query) || String(chapter.index || "").includes(query))
        : [...source];
      if (state.novel.catalogDescending) visible.reverse();
      const filteredTotal = visible.length;

      order.textContent = state.novel.catalogDescending ? "倒序" : "正序";
      order.title = state.novel.catalogDescending ? "切换为正序" : "切换为倒序";
      status.textContent = query
        ? `找到 ${formatNumber(filteredTotal)} 章`
        : `全部 ${formatNumber(source.length)} 章`;
      if (options.meta) {
        options.meta.textContent = query
          ? `找到 ${formatNumber(filteredTotal)} / ${formatNumber(source.length)} 章`
          : `共 ${formatNumber(source.length)} 章`;
      }

      list.innerHTML = "";
      for (const chapter of visible) list.append(chapterButton(chapter, Boolean(options.compact)));
      if (!visible.length) {
        const empty = document.createElement("div");
        empty.className = "novel-catalog-empty";
        empty.textContent = "没有匹配的章节";
        list.append(empty);
      }
    }

    search.addEventListener("input", () => {
      state.novel.catalogQuery = search.value;
      refresh();
    });
    order.addEventListener("click", () => {
      state.novel.catalogDescending = !state.novel.catalogDescending;
      refresh();
    });

    tools.append(search, order, status);
    shell.append(tools, list);
    refresh();
    return shell;
  }

  function resetCatalogState(book, chapters, chapterIndex) {
    state.novel.catalogBookId = book?.id || "";
    state.novel.catalogQuery = "";
    state.novel.catalogDescending = false;
    state.novel.catalogPage = 0;
    state.novel.catalogRemotePaged = false;
    state.novel.catalogTotal = Number(chapters.length || book?.chapterCount || 0);
    state.novel.catalogFilteredTotal = state.novel.catalogTotal;
    state.novel.catalogOffset = 0;
  }

  function compactBookProgress(book) {
    const progress = readingProgress(book);
    return `第 ${formatNumber(progress.chapterIndex)}/${formatNumber(progress.chapterCount)} 章 · 全书 ${Math.round(progress.overallRatio * 1000) / 10}%`;
  }

  function renderSettingsPanel() {
    const panel = document.createElement("aside");
    panel.className = "novel-settings-panel";
    const title = document.createElement("strong");
    title.textContent = "阅读设置";
    panel.append(title);
    panel.append(settingRow("主题", themeButtons()));
    panel.append(settingRow("字体", fontButtons()));
    panel.append(settingRow("字号", stepper("fontSize", 16, 30, 1, `${state.novel.settings.fontSize}px`)));
    panel.append(settingRow("行距", stepper("lineHeight", 1.5, 2.4, 0.1, state.novel.settings.lineHeight.toFixed(1))));
    panel.append(settingRow("宽度", stepper("width", 760, 1080, 20, `${state.novel.settings.width}px`)));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "novel-secondary-button";
    close.textContent = "完成";
    close.addEventListener("click", () => toggleSettings(false));
    panel.append(close);
    return panel;
  }

  function settingRow(label, control) {
    const row = document.createElement("div");
    row.className = "novel-setting-row";
    const span = document.createElement("span");
    span.textContent = label;
    row.append(span, control);
    return row;
  }

  function themeButtons() {
    const wrap = document.createElement("div");
    wrap.className = "novel-theme-buttons";
    for (const [value, label] of [
      ["paper", "纸页"],
      ["green", "护眼"],
      ["white", "白底"]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `theme-${value}${state.novel.settings.theme === value ? " active" : ""}`;
      button.textContent = label;
      button.addEventListener("click", () => updateSettings({ theme: value, night: false }));
      wrap.append(button);
    }
    return wrap;
  }

  function fontButtons() {
    const wrap = document.createElement("div");
    wrap.className = "novel-font-buttons";
    for (const [value, label] of [
      ["yahei", "雅黑"],
      ["simsun", "宋体"],
      ["kaiti", "楷书"]
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = state.novel.settings.font === value ? "active" : "";
      button.textContent = label;
      button.addEventListener("click", () => updateSettings({ font: value }));
      wrap.append(button);
    }
    return wrap;
  }

  function stepper(key, min, max, step, label) {
    const wrap = document.createElement("div");
    wrap.className = "novel-stepper";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "-";
    const value = document.createElement("span");
    value.textContent = label;
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    minus.addEventListener("click", () => updateSettings({ [key]: Math.max(min, Number(state.novel.settings[key]) - step) }));
    plus.addEventListener("click", () => updateSettings({ [key]: Math.min(max, Number(state.novel.settings[key]) + step) }));
    wrap.append(minus, value, plus);
    return wrap;
  }

  function chapterButton(chapter, compact) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `novel-chapter-button${compact ? " compact" : ""}${state.novel.chapter?.index === chapter.index ? " active" : ""}`;
    button.textContent = `${formatNumber(chapter.index)} · ${chapter.title}`;
    button.addEventListener("click", () => {
      toggleCatalog(false);
      openChapter(state.novel.book.id, chapter.index, { restoreProgress: false });
    });
    return button;
  }

  function renderCover(book, size = "") {
    const cover = document.createElement("div");
    cover.className = `novel-cover ${size}`.trim();
    const short = document.createElement("span");
    short.textContent = (book.category || "小说").slice(0, 4);
    const title = document.createElement("strong");
    title.textContent = book.title;
    cover.append(short, title);
    return cover;
  }

  function renderBreadcrumbs(items) {
    const nav = document.createElement("nav");
    nav.className = "novel-breadcrumbs";
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label;
      button.disabled = !item.action;
      if (item.action) button.addEventListener("click", item.action);
      nav.append(button);
    }
    return nav;
  }

  function navButton(label, action, disabled) {
    const button = document.createElement("button");
    button.type = "button";
    button.disabled = disabled;
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  function openReading(book) {
    if (!book?.id) return;
    openChapter(book.id, book.progress?.chapterIndex || 1, { restoreProgress: Boolean(book.progress) }).catch((error) => {
      state.novel.status = error.message || "章节打开失败";
      renderView();
    });
  }

  function downloadBook(book, event) {
    event?.stopPropagation?.();
    const bookId = typeof book === "string" ? book : book?.id;
    if (!bookId) return;
    window.location.assign(`/api/novels/${encodeURIComponent(bookId)}/download`);
  }

  async function uploadNovelFiles(files) {
    ensureState();
    const txtFiles = files.filter((file) => file && (/\.txt$/i.test(file.name) || String(file.type || "").startsWith("text/")));
    if (!txtFiles.length) return;
    state.novel.uploading = true;
    state.novel.status = `正在上传 ${formatNumber(txtFiles.length)} 本小说`;
    renderView();
    let uploaded = 0;
    let failed = 0;
    for (const file of txtFiles) {
      try {
        const decoded = await readNovelFileText(file);
        const result = await api("/api/novels/upload", {
          method: "POST",
          body: {
            fileName: file.name,
            sizeBytes: file.size,
            encoding: decoded.encoding,
            text: decoded.text
          }
        });
        uploaded += 1;
        state.novel.status = `已上传 ${formatNumber(uploaded)}/${formatNumber(txtFiles.length)}：${result.book?.title || file.name}`;
      } catch (error) {
        failed += 1;
        state.novel.status = `${file.name} 上传失败：${error.message || error}`;
      }
      renderView();
    }
    state.novel.uploading = false;
    await loadNovels({ replaceRoute: true });
    state.novel.status = failed
      ? `已上传 ${formatNumber(uploaded)} 本，失败 ${formatNumber(failed)} 本`
      : `已上传 ${formatNumber(uploaded)} 本小说`;
    renderView();
  }

  function showHome() {
    ensureState();
    collectionAdmin.stopPolling();
    flushProgress();
    invalidateNavigation();
    state.novel.loading = false;
    state.novel.status = "";
    state.novel.book = null;
    state.novel.chapter = null;
    state.novel.mode = "books";
    state.novel.author = "";
    state.novel.query = "";
    state.novel.category = "all";
    state.novel.sort = "updated";
    state.novel.page = 0;
    state.novel.data = null;
    state.novel.catalogOpen = false;
    state.novel.settingsOpen = false;
    setReaderBodyClass();
    loadNovels({ skipRoute: true }).catch(() => {});
    renderStats();
    renderView();
    pushRoute({ view: "novels", novelBookId: "", novelChapterIndex: "" });
  }

  function toggleCatalog(force) {
    const ratio = state.novel.chapter ? currentReaderRatio() : 0;
    const opening = force === undefined ? !state.novel.catalogOpen : Boolean(force);
    state.novel.catalogOpen = opening;
    const needsCatalog = opening && !hasCatalogForCurrentChapter();
    if (needsCatalog) {
      state.novel.catalogLoading = true;
      state.novel.catalogError = "";
    }
    if (state.novel.catalogOpen) {
      state.novel.settingsOpen = false;
    }
    state.novel.pendingScrollRatio = ratio;
    renderView();
    restoreReaderScroll();
    if (needsCatalog) loadReaderCatalog().catch(() => {});
  }

  function hasCatalogForCurrentChapter() {
    const total = Number(state.novel.book?.chapterCount || 0);
    if (state.novel.catalogBookId !== state.novel.book?.id) return false;
    return total === 0 || Number(state.novel.chapters?.length || 0) >= total;
  }

  async function loadReaderCatalog() {
    return loadRemoteCatalogPage();
  }

  async function loadRemoteCatalogPage(options = {}) {
    const bookId = String(state.novel.book?.id || "");
    if (!bookId) return;
    const requestId = ++catalogRequestId;
    const params = new URLSearchParams({
      all: "1",
      order: "asc"
    });
    const ratio = state.novel.chapter ? currentReaderRatio() : 0;
    const detailScrollY = state.novel.chapter ? 0 : window.scrollY;
    const renderDetail = options.render !== false && Boolean(state.novel.book) && !state.novel.chapter;
    state.novel.catalogLoading = true;
    state.novel.catalogError = "";
    if (state.novel.catalogOpen) {
      state.novel.pendingScrollRatio = ratio;
      renderView();
      restoreReaderScroll();
    } else if (renderDetail) {
      renderView();
      window.requestAnimationFrame(() => window.scrollTo({ top: detailScrollY, left: 0, behavior: "auto" }));
    }
    try {
      const data = await api(`/api/novels/${encodeURIComponent(bookId)}/catalog?${params}`);
      if (requestId !== catalogRequestId || bookId !== String(state.novel.book?.id || "")) return;
      state.novel.chapters = Array.isArray(data.chapters) ? data.chapters : [];
      const progressIndex = Number(state.novel.book?.progress?.chapterIndex || 0);
      const progressChapter = progressIndex
        ? state.novel.chapters.find((chapter) => Number(chapter.index) === progressIndex)
        : null;
      if (progressChapter?.title) state.novel.progressChapterTitle = progressChapter.title;
      state.novel.catalogRemotePaged = false;
      state.novel.catalogBookId = bookId;
      state.novel.catalogTotal = Number(data.total || state.novel.book?.chapterCount || 0);
      state.novel.catalogFilteredTotal = state.novel.chapters.length;
      state.novel.catalogOffset = 0;
      state.novel.catalogPage = 0;
      state.novel.catalogError = "";
    } catch (error) {
      if (requestId !== catalogRequestId || bookId !== String(state.novel.book?.id || "")) return;
      state.novel.catalogError = error.message || "章节目录读取失败";
    } finally {
      if (requestId !== catalogRequestId || bookId !== String(state.novel.book?.id || "")) return;
      state.novel.catalogLoading = false;
      if (state.novel.catalogOpen) {
        const ratio = currentReaderRatio();
        state.novel.pendingScrollRatio = ratio;
        renderView();
        restoreReaderScroll();
      } else if (renderDetail) {
        renderView();
        window.requestAnimationFrame(() => window.scrollTo({ top: detailScrollY, left: 0, behavior: "auto" }));
      }
    }
  }

  function toggleSettings(force) {
    const ratio = state.novel.chapter ? currentReaderRatio() : 0;
    state.novel.settingsOpen = force === undefined ? !state.novel.settingsOpen : Boolean(force);
    if (state.novel.settingsOpen) {
      state.novel.catalogOpen = false;
    }
    state.novel.pendingScrollRatio = ratio;
    renderView();
    restoreReaderScroll();
  }

  function updateSettings(patch) {
    const ratio = state.novel.chapter ? currentReaderRatio() : 0;
    state.novel.settings = normalizeSettings({ ...state.novel.settings, ...patch });
    writeSettings(state.novel.settings);
    setReaderBodyClass();
    state.novel.pendingScrollRatio = ratio;
    renderView();
    restoreReaderScroll();
  }

  function currentReaderRatio() {
    const page = document.querySelector(".novel-reader-page");
    if (!page) return 0;
    const top = page.getBoundingClientRect().top + window.scrollY;
    const readable = Math.max(1, page.scrollHeight - window.innerHeight);
    return clampRatio((window.scrollY - top) / readable);
  }

  function restoreReaderScroll() {
    const ratio = Math.max(0, Math.min(1, Number(state.novel.pendingScrollRatio || 0)));
    state.novel.pendingScrollRatio = 0;
    window.requestAnimationFrame(() => {
      const page = document.querySelector(".novel-reader-page");
      if (!page) return;
      if (ratio <= 0.001) {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
        return;
      }
      const top = page.getBoundingClientRect().top + window.scrollY;
      const readable = Math.max(0, page.scrollHeight - window.innerHeight);
      window.scrollTo({ top: top + readable * ratio, left: 0, behavior: "auto" });
    });
  }

  function installScrollProgress() {
    if (scrollListenerInstalled) return;
    scrollListenerInstalled = true;
    window.addEventListener(
      "scroll",
      () => {
        if (state.activeView !== "novels" || !state.novel?.book || !state.novel?.chapter) return;
        scheduleProgressSave(500);
      },
      { passive: true }
    );
  }

  function installProgressLifecycle() {
    if (progressLifecycleInstalled) return;
    progressLifecycleInstalled = true;
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flushProgress();
    });
    window.addEventListener("pagehide", () => {
      window.clearTimeout(progressTimer);
      progressTimer = null;
      saveProgress({ keepalive: true });
    });
  }

  function scheduleProgressSave(delay = 500) {
    window.clearTimeout(progressTimer);
    progressTimer = window.setTimeout(() => {
      progressTimer = null;
      saveProgress();
    }, delay);
  }

  function flushProgress() {
    if (!state.novel?.book || !state.novel?.chapter) return;
    window.clearTimeout(progressTimer);
    progressTimer = null;
    saveProgress();
  }

  function saveProgress(options = {}) {
    const book = state.novel?.book;
    const chapter = state.novel?.chapter;
    if (!book || !chapter) return;
    const ratio = currentReaderRatio();
    const revision = ++progressRevision;
    const progress = {
      chapterIndex: Number(chapter.index),
      scrollRatio: ratio,
      updatedAt: new Date().toISOString()
    };
    state.novel.book = { ...book, progress };
    const path = `/api/novels/${encodeURIComponent(book.id)}/progress`;
    const body = { chapterIndex: chapter.index, scrollRatio: ratio };
    if (options.keepalive) {
      window.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
        keepalive: true
      }).catch(() => {});
      return;
    }
    const request = progressWrite
      .catch(() => {})
      .then(() => api(path, { method: "POST", body }));
    progressWrite = request;
    request
      .then((data) => {
        if (revision === progressRevision && state.novel.book?.id === book.id && data?.progress) {
          state.novel.book = { ...state.novel.book, progress: data.progress };
        }
      })
      .catch(() => {});
  }

  function installReaderKeyboard() {
    if (keyboardListenerInstalled) return;
    keyboardListenerInstalled = true;
    window.addEventListener("keydown", (event) => {
      if (state.activeView !== "novels" || !state.novel?.chapter) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, select, textarea, button, a")) return;
      if (event.key === "Escape" && (state.novel.catalogOpen || state.novel.settingsOpen)) {
        event.preventDefault();
        const ratio = currentReaderRatio();
        state.novel.catalogOpen = false;
        state.novel.settingsOpen = false;
        state.novel.pendingScrollRatio = ratio;
        renderView();
        restoreReaderScroll();
        return;
      }
      if (state.novel.catalogOpen || state.novel.settingsOpen) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        openAdjacent(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        openAdjacent(1);
      }
    });
  }

  function setReaderBodyClass() {
    document.body.classList.toggle("novel-reader-active", state.activeView === "novels" && Boolean(state.novel?.chapter));
  }

  return {
    applyRouteState,
    enter,
    loadNovels,
    openAdjacent,
    openBook,
    openChapter,
    openRouteTarget,
    renderStats,
    renderView
  };
}

function readingProgress(book = {}, chapters = [], chapterIndex, scrollRatio) {
  const source = Array.isArray(chapters) ? chapters : [];
  const chapterCount = Math.max(1, Number(book.chapterCount || source.length || 1));
  const currentIndex = Math.max(1, Math.min(chapterCount, Number(chapterIndex || book.progress?.chapterIndex || 1)));
  const currentRatio = clampRatio(scrollRatio ?? book.progress?.scrollRatio ?? 0);
  const overallRatio = clampRatio(((currentIndex - 1) + currentRatio) / chapterCount);

  return {
    chapterCount,
    chapterIndex: currentIndex,
    chapterRatio: currentRatio,
    overallRatio
  };
}

function clampRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function formatNovelDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date).replaceAll("/", "-");
}

function paragraphsFromContent(content) {
  return String(content || "")
    .split(/\n\s*\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function readNovelFileText(file) {
  const buffer = await file.arrayBuffer();
  return decodeNovelBuffer(buffer);
}

function decodeNovelBuffer(buffer) {
  const candidates = [
    ["utf-8", { fatal: true }],
    ["gb18030", {}],
    ["gbk", {}],
    ["big5", {}],
    ["utf-8", {}]
  ];
  for (const [encoding, options] of candidates) {
    try {
      const text = new TextDecoder(encoding, options).decode(buffer);
      const replacements = (text.match(/\uFFFD/g) || []).length;
      if (options.fatal || replacements <= Math.max(2, text.length * 0.01)) {
        return { text, encoding };
      }
    } catch {}
  }
  return { text: new TextDecoder().decode(buffer), encoding: "utf-8" };
}

function readSettings() {
  try {
    return JSON.parse(window.localStorage?.getItem("fanhao.novel.settings") || "{}");
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  try {
    window.localStorage?.setItem("fanhao.novel.settings", JSON.stringify(settings));
  } catch {}
}

function normalizeSettings(input = {}) {
  const legacyWidth = clampNumber(input.width, 680, 980, 820);
  const width = Number(input.widthVersion) >= 2
    ? clampNumber(input.width, 760, 1080, 960)
    : clampNumber(legacyWidth + 140, 760, 1080, 960);
  return {
    theme: ["paper", "green", "white"].includes(input.theme) ? input.theme : "paper",
    night: Boolean(input.night),
    font: ["yahei", "simsun", "kaiti"].includes(input.font) ? input.font : "yahei",
    fontSize: clampNumber(input.fontSize, 16, 30, 20),
    lineHeight: clampNumber(input.lineHeight, 1.5, 2.4, 1.9),
    width,
    widthVersion: 2
  };
}

function readerFontFamily(font) {
  if (font === "simsun") return 'SimSun, "Songti SC", serif';
  if (font === "kaiti") return 'KaiTi, STKaiti, serif';
  return '"Microsoft YaHei", "PingFang SC", sans-serif';
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
