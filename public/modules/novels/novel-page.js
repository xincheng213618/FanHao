import { createNovelCollectionAdmin } from "./collection-admin.js?v=20261004-novel-reader-owner-01";
import { createNovelProgressWriter } from "./progress-writer.js?v=20261004-novel-progress-01";
import { createNovelListReturnRestore } from "./list-return.js";
import { createNovelReaderFullscreen } from "./reader-fullscreen.js";
import { createNovelBookmarksPanel } from "./bookmarks.js";
import { createNovelAuthorBrowser } from "./author-browser.js";
import { captureWebAccount } from "../../platform/accounts/session-context.js";

const NOVEL_BOOK_PAGE_SIZE = 48;
const NOVEL_RANKING_PAGE_SIZE = 48;
const NOVEL_PREFIX_PAGE_SIZE = 5000;
const NOVEL_CHAPTER_CACHE_LIMIT = 8;
const NOVEL_CATALOG_PAGE_SIZE = 120;
const NOVEL_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

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
  let catalogController = null;
  let progressTimer = null;
  let progressRevision = 0;
  // Revisions increase for this page lifetime; only an applied receipt confirms one.
  let confirmedProgressRevision = 0;
  const recoveryWrites = new Map();
  const progressSessions = new Map();
  let progressClockSupported = false;
  let progressClockRefresh = null;
  let navigationId = 0;
  let navigationController = null;
  let libraryRequestId = 0;
  let libraryRequestController = null;
  let readerStatusTimer = null;
  let progressSaveFailure = null;
  let failedChapterNavigation = null;
  let adjacentNavigation = null;
  let bookRecovery = null;
  let pendingBookList = null;
  const detailCatalogViews = new WeakMap();
  let readerScrollFrame = null;
  let readerScrollRevision = 0;
  let scrollInputRevision = 0;
  let pendingScrollRestore = null;
  let appliedRouteNavigation = null;
  let scrollListenerInstalled = false;
  let progressLifecycleInstalled = false;
  let keyboardListenerInstalled = false;
  let readerFocusRevision = 0;
  let libraryObserver = null;
  let libraryList = null;
  let libraryFooter = null;
  let libraryPresentation = null;
  let novelMenuRevision = 0;
  let libraryReturnContext = null;
  let libraryReturnRestore = null;
  const invalidLibraryReturnData = new WeakSet();
  let libraryMutationRevision = 0;
  let authorBrowser = null;
  let uploadJob = null;
  const chapterCache = new Map();
  const chapterRequests = new Map();
  const readerFullscreen = createNovelReaderFullscreen({
    isReader: () => state.activeView === "novels" && Boolean(state.novel?.chapter),
    captureReader: () => {
      const owner = navigationId, book = state.novel.book, chapterId = state.novel.chapter?.id;
      const page = els.workGrid?.querySelector(".novel-reader-page");
      return page && { page, isCurrent: () => page.isConnected && state.activeView === "novels" && owner === navigationId
        && sameBookSnapshot(book, state.novel.book) && chapterId === state.novel.chapter?.id };
    },
    onChange: updateReaderFullscreenControl
  });
  const progressWriter = createNovelProgressWriter({
    send: record => api(`/api/novels/${encodeURIComponent(record.bookId)}/progress`, { method: "POST", body: record.body }),
    sendKeepalive: record => window.fetch(`/api/novels/${encodeURIComponent(record.bookId)}/progress`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(record.body),
      credentials: "same-origin", keepalive: true
    }).then(async response => {
      if (typeof response?.json !== "function") return response;
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data.error || "阅读进度保存失败"), { code: data.code });
      return data;
    }),
    onResult: applyProgressReceipt,
    onError: (record, error) => {
      if (!isCurrentProgress(record)) return;
      if (record.revision <= confirmedProgressRevision) return;
      if (record.explicit) setReaderNavigationStatus(error.message || "进度保存失败，旧位置仍保留", "error");
      else showProgressSaveFailure(record, error);
      if (error.code === "NOVEL_PROGRESS_SESSION_EXPIRED") refreshProgressSession(record);
    },
    onSettled: finishProgressWrite
  });
  const collectionAdmin = createNovelCollectionAdmin({
    api,
    state,
    formatDateTime,
    formatNumber,
    openBook,
    isActive: canRenderManagement,
    rerender: () => {
      if (canRenderManagement()) renderView();
      else collectionAdmin.stopPolling();
    },
    onLibraryChanged: async () => {
      if (!canRenderManagement()) return;
      const requestId = libraryRequestId;
      try {
        const summary = await api("/api/novels/summary");
        if (!canRenderManagement() || requestId !== libraryRequestId) return;
        state.novel.summary = summary;
        state.novel.data = { summary, books: [], total: 0, limit: NOVEL_BOOK_PAGE_SIZE, offset: 0 };
      } catch {
        if (!canRenderManagement() || requestId !== libraryRequestId) return;
        state.novel.data = null;
        state.novel.summary = null;
      }
    }
  });

  function canRenderManagement() {
    return state.activeView === "novels" && state.novel?.mode === "manage"
      && !state.novel.book && !state.novel.chapter && !navigationController;
  }

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
    state.novel.libraryError = state.novel.libraryError || "";
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
      cancelChapterRequests();
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
    if (route.novelBookId) captureLibraryReturn(route.novelBookId);
    else clearLibraryReturn();
    novelMenuRevision += 1;
    appliedRouteNavigation = resetReader({ keepFullscreen: Boolean(route.novelBookId && route.novelChapterIndex) });
    state.novel.query = route.novelQuery || "";
    state.novel.category = route.novelCategory || "all";
    state.novel.sort = route.novelSort || "updated";
    state.novel.author = route.novelAuthor || "";
    state.novel.mode = ["mine", "author", "rankings", "manage"].includes(route.novelMode) ? route.novelMode : "books";
    state.novel.page = Math.max(0, Number(route.novelPage || 0));
  }

  async function openRouteTarget(route = {}) {
    ensureState();
    if (appliedRouteNavigation !== navigationId) resetReader({ keepFullscreen: Boolean(route.novelBookId && route.novelChapterIndex) });
    appliedRouteNavigation = null;
    if (route.novelBookId && route.novelChapterIndex) {
      await openChapter(route.novelBookId, route.novelChapterIndex, { skipRoute: true, restoreProgress: true, skipProgressFlush: true, skipListCapture: true });
      return;
    }
    if (route.novelBookId) {
      await openBook(route.novelBookId, { skipRoute: true, skipProgressFlush: true, skipListCapture: true });
      return;
    }
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
    if (libraryReturnContext?.retry && !options.restoreCount) clearLibraryReturn();
    if (!options.append && !options.keepBook && !options.keepChapter) resetReader();
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
    state.novel.libraryError = "";
    state.novel.libraryErrorAppend = null;
    if (append) state.novel.loadingMore = true;
    else state.novel.loading = true;
    if (!append) state.novel.status = "正在读取小说书库";
    state.novel.book = options.keepBook ? state.novel.book : null;
    state.novel.chapter = options.keepChapter ? state.novel.chapter : null;
    setReaderBodyClass();
    if (append && libraryList) updateLibraryTail();
    else renderView();
    const params = new URLSearchParams();
    if (query.query) params.set("q", query.query);
    if (query.mode === "mine") params.set("reading", "1");
    if (["books", "author"].includes(query.mode) && query.category !== "all") params.set("category", query.category);
    if (query.mode === "books" && query.author) params.set("author", query.author);
    if (query.sort !== "updated") params.set("sort", query.sort);
    const pageSize = paged ? NOVEL_RANKING_PAGE_SIZE : NOVEL_BOOK_PAGE_SIZE;
    params.set("limit", String(pageSize));
    const existingData = state.novel.data;
    const existingEntries = existingData?.books || [];
    const requestOffset = paged ? query.page * pageSize : append ? novelNextOffset(existingData, 0) : 0;
    params.set("offset", String(requestOffset));
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
    let rebased = false;
    try {
      response = !paged && !append && options.restoreCount
        ? await reloadNovelPrefix(endpoint, params, request, options.restoreCount)
        : await api(`${endpoint}${query.mode !== "manage" && params.toString() ? `?${params}` : ""}`, {
          signal: request.controller.signal
        });
      if (!isCurrentLibraryRequest(request)) return false;
      if (append && novelListChanged(existingData, response)) {
        response = await reloadNovelPrefix(endpoint, params, request, requestOffset + pageSize);
        if (!response) return false;
        rebased = true;
      }
    } catch (error) {
      if (!isCurrentLibraryRequest(request)) return false;
      finishLibraryRequest(request);
      state.novel.loading = false;
      state.novel.loadingMore = false;
      state.novel.status = error.message || (append ? "继续加载失败" : "小说书库读取失败");
      state.novel.libraryError = state.novel.status;
      state.novel.libraryErrorAppend = append;
      renderStats();
      if (append && libraryList) updateLibraryTail();
      else renderView();
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
        return loadNovels({ ...options, pageClamped: true, skipRoute: false, replaceRoute: true });
      }
    }
    const merged = mergeNovelBooks(append && !rebased ? existingEntries : [], data.books || [], existingData?.sourceRealm, data.sourceRealm);
    state.novel.data = {
      ...data,
      books: merged.books,
      nextOffset: rebased ? data.nextOffset : novelNextOffset(data, requestOffset)
    };
    if (request.mutationRevision !== libraryMutationRevision) invalidLibraryReturnData.add(state.novel.data);
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
    state.novel.hasMore = !paged && query.mode !== "manage" && state.novel.data.nextOffset < Number(data.total || 0) && (data.hasMore ?? Boolean(data.books?.length));
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
    if (append && !rebased && libraryList) updateLibraryTail(merged.added, merged.updated);
    else renderView();
  }

  function novelBookKey(book, realm = "") {
    return JSON.stringify([String(book.sourceRealm || realm || ""), String(book.id)]);
  }

  function novelNextOffset(data, requestedOffset) {
    const nextOffset = Number(data?.nextOffset);
    return Number.isSafeInteger(nextOffset) && nextOffset >= requestedOffset
      ? nextOffset
      : requestedOffset + (data?.books?.length || 0);
  }

  function novelListChanged(previous, current) {
    return Boolean(previous?.sourceRealm && current?.sourceRealm && previous.sourceRealm !== current.sourceRealm)
      || Boolean(previous?.listRevision && current?.listRevision && previous.listRevision !== current.listRevision);
  }

  function mergeNovelBooks(previous, incoming, previousRealm, incomingRealm) {
    const books = [];
    const indexes = new Map();
    const added = new Map();
    const updated = new Map();
    for (const book of previous) {
      const key = novelBookKey(book, previousRealm);
      if (!indexes.has(key)) { indexes.set(key, books.length); books.push(book); }
    }
    for (const book of incoming) {
      const key = novelBookKey(book, incomingRealm);
      if (indexes.has(key)) {
        books[indexes.get(key)] = book;
        if (added.has(key)) added.set(key, book);
        else updated.set(key, book);
      } else {
        indexes.set(key, books.length);
        books.push(book);
        added.set(key, book);
      }
    }
    return { books, added: [...added.values()], updated: [...updated.values()] };
  }

  async function reloadNovelPrefix(endpoint, initialParams, request, targetOffset) {
    // A changed page cannot be joined to an older prefix. Re-read enough of one
    // revision to preserve the displayed range and include the requested page.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let first = null;
      let last = null;
      let books = [];
      let offset = 0;
      while (offset < targetOffset) {
        if (!isCurrentLibraryRequest(request)) return null;
        const params = new URLSearchParams(initialParams);
        params.set("offset", String(offset));
        params.set("limit", String(Math.min(NOVEL_PREFIX_PAGE_SIZE, targetOffset - offset)));
        const page = await api(`${endpoint}?${params}`, { signal: request.controller.signal });
        if (!isCurrentLibraryRequest(request)) return null;
        if (first && novelListChanged(first, page)) break;
        first ||= page;
        last = page;
        books = mergeNovelBooks(books, page.books || [], first.sourceRealm, page.sourceRealm).books;
        const nextOffset = novelNextOffset(page, offset);
        if (nextOffset <= offset || !(page.books?.length) || nextOffset >= Number(page.total || 0)) {
          return { ...last, offset: 0, nextOffset, books, hasMore: Boolean(page.books?.length) && nextOffset < Number(page.total || 0) };
        }
        offset = nextOffset;
        if (offset >= targetOffset) return { ...last, offset: 0, nextOffset: offset, books, hasMore: offset < Number(page.total || 0) };
      }
    }
    throw new Error("书库持续变化，请重试加载。");
  }

  async function openBook(bookId, options = {}) {
    ensureState();
    if (!bookId) return;
    const sourceList = capturePendingBookList(bookId);
    if (!options.skipListCapture) captureLibraryReturn(bookId);
    if (!options.skipProgressFlush) flushProgress();
    const navigation = beginNavigation();
    if (sourceList) pendingBookList = { ...sourceList, owner: navigation.id, controller: navigation.controller };
    if (options.bookRecovery) bookRecovery = { ...options.bookRecovery, owner: navigation.id };
    state.novel.loading = true;
    state.novel.status = "正在读取书籍详情";
    state.novel.chapter = null;
    if (state.novel.book && String(state.novel.book.id) !== String(bookId)) state.novel.book = null;
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
      bookRecovery = { owner: navigation.id, bookId: String(bookId), message: state.novel.status,
        skipRoute: options.skipRoute, title: state.novel.book?.title || state.novel.data?.books?.find(book => String(book.id) === String(bookId))?.title || "" };
      renderView();
      restoreBookRetryFocus(options);
      return false;
    }
    if (!isCurrentNavigation(navigation)) return false;
    noteProgressClock(data);
    noteLibraryReturnBook(data.book);
    state.novel.book = data.book;
    if (bookRecovery) bookRecovery.message = "";
    state.novel.chapters = [];
    state.novel.progressChapterTitle = "";
    state.novel.catalogLoading = false;
    state.novel.catalogError = "";
    state.novel.catalogRemotePaged = false;
    state.novel.catalogTotal = Number(data.chapterTotal || data.book?.chapterCount || 0);
    state.novel.catalogFilteredTotal = state.novel.catalogTotal;
    state.novel.catalogOffset = 0;
    resetCatalogState(data.book, state.novel.chapters, data.book?.progress?.chapterIndex || 1);
    finishNavigation(navigation);
    state.novel.loading = false;
    state.novel.status = "";
    renderStats();
    if (!options.bookRecovery || (options.retryFocusRevision === readerFocusRevision && options.retryScrollRevision === scrollInputRevision)) {
      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    }
    // The detail is usable as soon as its metadata arrives. The catalog owns
    // its own cancellable request and must not keep the standalone host hidden.
    loadRemoteCatalogPage().catch(() => {});
    restoreBookRetryFocus(options);
    if (!options.skipRoute) pushRoute({ view: "novels", novelBookId: bookId, novelChapterIndex: "" });
    return true;
  }

  async function openChapter(bookId, chapterIndex, options = {}) {
    ensureState();
    if (!bookId || !chapterIndex) return;
    const sourceList = capturePendingBookList(bookId, { kind: "chapter", chapterIndex, restoreProgress: options.restoreProgress });
    if (!options.skipListCapture) captureLibraryReturn(bookId);
    const previousBookId = String(state.novel.book?.id || "");
    const previousBook = state.novel.book;
    const previousChapterIndex = Number(state.novel.chapter?.index || 0);
    const previousChapters = Array.isArray(state.novel.chapters) ? state.novel.chapters : [];
    if (!options.skipProgressFlush && previousBookId && previousChapterIndex) flushProgress();
    const navigation = beginNavigation({ bookId, chapterIndex, allowCache: options.restoreProgress === false });
    if (sourceList) pendingBookList = { ...sourceList, owner: navigation.id, controller: navigation.controller };
    const readerVisible = Boolean(state.novel.chapter && document.querySelector(".novel-reader-page"));
    state.novel.loading = true;
    state.novel.status = "正在翻开章节";
    if (!setReaderNavigationStatus("正在翻开章节…")) renderView();
    let data;
    try {
      data = await fetchChapterData(bookId, chapterIndex, {
        allowCache: options.restoreProgress === false,
        expectedChapterId: options.bookmark?.chapterId,
        signal: navigation.controller.signal
      });
      if (options.bookmark && (!sameBookSnapshot(options.bookmark, data.book) || options.bookmark.chapterId !== data.chapter?.id)) {
        throw new Error("书签对应的目录或章节已变化，请重新打开书籍后核对。");
      }
    } catch (error) {
      if (!isCurrentNavigation(navigation)) return false;
      finishNavigation(navigation);
      state.novel.loading = false;
      state.novel.status = readerNavigationErrorMessage(error);
      failedChapterNavigation = readerVisible ? {
        owner: navigationId, book: state.novel.book, chapterId: state.novel.chapter?.id,
        bookId, chapterIndex, message: state.novel.status,
        options: { restoreProgress: options.restoreProgress, skipRoute: options.skipRoute, skipProgressFlush: options.skipProgressFlush, bookmark: options.bookmark }
      } : null;
      if (!readerVisible || !setReaderNavigationStatus(state.novel.status, "error", failedChapterNavigation)) renderView();
      if (options.retryFocus && options.retryFocusRevision === readerFocusRevision) focusReaderControl("chapter-retry");
      return false;
    }
    if (!isCurrentNavigation(navigation)) return false;
    const restoreRetryFocus = options.retryFocus && options.retryFocusRevision === readerFocusRevision;
    noteProgressClock(data);
    noteLibraryReturnBook(data.book);
    finishNavigation(navigation);
    const sameSnapshot = sameBookSnapshot(previousBook, data.book);
    const currentProgress = sameSnapshot ? state.novel.book?.progress : null;
    state.novel.book = {
      ...data.book,
      progress: options.restoreProgress === false && currentProgress ? currentProgress : data.book?.progress || null,
      progressRecovery: options.restoreProgress === false && currentProgress ? null : data.book?.progressRecovery || null
    };
    state.novel.chapter = data.chapter;
    const incomingChapters = Array.isArray(data.chapters) ? data.chapters : [];
    state.novel.chapters = incomingChapters.length
      ? incomingChapters
      : sameSnapshot ? previousChapters : [];
    if (!sameSnapshot && !incomingChapters.length) {
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
    const restore = options.restoreProgress !== false && Number(progress?.chapterIndex || 0) === Number(data.chapter?.index || 0)
      && (!data.book?.catalogRevision || (progress?.catalogRevision === data.book.catalogRevision && progress.chapterId === data.chapter?.id));
    state.novel.pendingScrollRatio = options.bookmark ? options.bookmark.ratio : restore ? Number(progress?.scrollRatio || 0) : 0;
    setReaderBodyClass();
    renderStats();
    renderView();
    restoreReaderScroll({ saveProgress: true });
    if (restoreRetryFocus) {
      const heading = document.querySelector(".novel-reader-paper h1");
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
    if (!options.skipRoute) pushRoute({ view: "novels", novelBookId: bookId, novelChapterIndex: String(chapterIndex) });
    prefetchNextChapter(state.novel.book?.id, state.novel.next);
    return true;
  }

  function beginNavigation(chapterTarget) {
    clearProgressSaveFailure();
    clearPendingBookList();
    authorBrowser?.close();
    uploadJob?.summaryController?.abort();
    failedChapterNavigation = null;
    bookRecovery = null;
    invalidateLibraryRequest();
    invalidateProgressClock();
    navigationId += 1;
    navigationController?.abort();
    navigationController = new AbortController();
    invalidateCatalogRequest();
    cancelChapterRequests(chapterTarget);
    cancelReaderScroll();
    window.clearTimeout(progressTimer);
    progressTimer = null;
    collectionAdmin.stopPolling();
    libraryObserver?.disconnect();
    libraryObserver = null;
    clearReaderNavigationStatus();
    return { id: navigationId, controller: navigationController };
  }

  function isCurrentNavigation(navigation) {
    return state.activeView === "novels" && navigation?.id === navigationId
      && navigation?.controller === navigationController
      && !navigation.controller.signal.aborted;
  }

  function finishNavigation(navigation) {
    if (navigation?.controller === navigationController) {
      clearPendingBookList();
      navigationController = null;
    }
  }

  function invalidateNavigation() {
    clearProgressSaveFailure();
    clearPendingBookList();
    authorBrowser?.close();
    uploadJob?.summaryController?.abort();
    failedChapterNavigation = null;
    bookRecovery = null;
    invalidateProgressClock();
    navigationId += 1;
    navigationController?.abort();
    navigationController = null;
    invalidateCatalogRequest();
    cancelChapterRequests();
    cancelReaderScroll();
    window.clearTimeout(progressTimer);
    progressTimer = null;
    clearReaderNavigationStatus();
  }

  function resetReader(options = {}) {
    if (!options.keepFullscreen) void readerFullscreen.leave();
    flushProgress();
    invalidateNavigation();
    invalidateLibraryRequest();
    collectionAdmin.stopPolling();
    libraryObserver?.disconnect();
    libraryObserver = null;
    if (state.novel) {
      state.novel.loading = false;
      state.novel.loadingMore = false;
      state.novel.catalogLoading = false;
      state.novel.catalogOpen = false;
      state.novel.settingsOpen = false;
      state.novel.status = "";
    }
    return navigationId;
  }

  function invalidateCatalogRequest() {
    catalogRequestId += 1;
    catalogController?.abort();
    catalogController = null;
    if (state.novel) state.novel.catalogLoading = false;
  }

  function cancelReaderScroll() {
    readerScrollRevision += 1;
    if (readerScrollFrame != null) window.cancelAnimationFrame?.(readerScrollFrame);
    readerScrollFrame = null;
    pendingScrollRestore = null;
  }

  function beginLibraryRequest() {
    libraryRequestId += 1;
    libraryRequestController?.abort();
    libraryRequestController = new AbortController();
    return { id: libraryRequestId, controller: libraryRequestController, mutationRevision: libraryMutationRevision };
  }

  function isCurrentLibraryRequest(request) {
    return state.activeView === "novels" && request?.id === libraryRequestId
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

  function isCurrentChapterFailure(failure) {
    return Boolean(failure && failure === failedChapterNavigation && failure.owner === navigationId
      && state.activeView === "novels" && !state.novel.loading
      && sameBookSnapshot(failure.book, state.novel.book) && failure.chapterId === state.novel.chapter?.id);
  }

  function setReaderNavigationStatus(message, tone = "loading", retryFailure = null) {
    const page = document.querySelector(".novel-reader-page");
    if (!page) return false;
    if (tone === "error" && !retryFailure && isCurrentChapterFailure(failedChapterNavigation)) return true;
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
    status.inert = Boolean(state.novel.catalogOpen);
    if (isCurrentChapterFailure(retryFailure)) {
      const failure = retryFailure;
      const detail = document.createElement("span");
      detail.className = "novel-reader-error-message";
      detail.textContent = message;
      detail.tabIndex = 0;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "novel-reader-retry";
      retry.dataset.readerFocus = "chapter-retry";
      retry.textContent = "重试章节";
      retry.addEventListener("click", () => {
        if (!isCurrentChapterFailure(failure)) return;
        void openChapter(failure.bookId, failure.chapterIndex, {
          ...failure.options, retryFocus: document.activeElement === retry, retryFocusRevision: readerFocusRevision
        });
      });
      status.textContent = "";
      status.append(detail, retry);
    }
    page.setAttribute("aria-busy", tone === "loading" ? "true" : "false");
    if (tone === "error" && !retryFailure) {
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

  function currentProgressSaveFailure() {
    const failure = progressSaveFailure;
    return failure && failure.record.owner === navigationId && matchesProgressReader(failure.record)
      && progressAccountCurrent(failure.record) && !state.novel.book?.progressRecovery ? failure : null;
  }

  function showProgressSaveFailure(record, error) {
    progressSaveFailure = { record, message: error?.message || "进度保存失败，旧位置仍保留", pendingRevision: 0 };
    syncProgressSaveFeedback();
  }

  function clearProgressSaveFailure({ restoreFocus = false } = {}) {
    const page = els.workGrid?.querySelector(".novel-reader-page");
    const status = page?.querySelector(".novel-reader-progress-status");
    const focused = restoreFocus && status?.contains(document.activeElement);
    progressSaveFailure = null;
    status?.remove();
    if (focused && page?.isConnected) {
      const heading = page.querySelector(".novel-reader-paper h1");
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
  }

  function syncProgressSaveFeedback() {
    const page = els.workGrid?.querySelector(".novel-reader-page");
    if (!page) return;
    const failure = currentProgressSaveFailure();
    let status = page.querySelector(".novel-reader-progress-status");
    if (!failure) { status?.remove(); return; }
    if (!status) {
      status = document.createElement("div");
      status.className = "novel-reader-progress-status";
      status.setAttribute("role", "alert");
      const message = document.createElement("span");
      message.className = "novel-progress-save-error";
      message.tabIndex = 0;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "novel-progress-save-retry";
      retry.textContent = "重试保存进度";
      retry.addEventListener("click", () => {
        const current = currentProgressSaveFailure();
        if (!status.isConnected || status.hidden || page !== els.workGrid?.querySelector(".novel-reader-page")
            || !current || current.pendingRevision || state.novel.loading || navigationController) return;
        window.clearTimeout(progressTimer);
        progressTimer = null;
        saveProgress();
      });
      status.append(message, retry);
      page.append(status);
    }
    const message = status.querySelector(".novel-progress-save-error");
    if (message.textContent !== failure.message) message.textContent = failure.message;
    const busy = Boolean(failure.pendingRevision), retry = status.querySelector("button");
    if (retry.getAttribute("aria-busy") !== String(busy)) retry.setAttribute("aria-busy", String(busy));
    if (retry.getAttribute("aria-disabled") !== String(busy)) retry.setAttribute("aria-disabled", String(busy));
    status.hidden = Boolean(state.novel.catalogOpen || state.novel.settingsOpen);
    status.inert = status.hidden;
  }

  function readerNavigationErrorMessage(error) {
    const message = String(error?.message || "").trim();
    if (!message || /failed to fetch|network\s*error|load failed/i.test(message)) {
      return "章节读取失败，请检查网络后重试";
    }
    return message;
  }

  function sameBookSnapshot(left, right) {
    return Boolean(left && right && left.id === right.id && left.sourceRealm === right.sourceRealm && left.catalogRevision === right.catalogRevision);
  }

  function hasPendingRecoveryWrite(book, chapter) {
    return recoveryWrites.has(JSON.stringify([book?.id, book?.sourceRealm, book?.catalogRevision, chapter?.id]));
  }

  function chapterCacheKey(bookId, chapterIndex, book) {
    return `${String(bookId || "")}::${JSON.stringify([book?.sourceRealm || "", book?.catalogRevision || "", String(chapterIndex || "")])}`;
  }

  function cachedChapter(bookId, chapterIndex, book) {
    if (!book?.catalogRevision) return null;
    const key = chapterCacheKey(bookId, chapterIndex, book);
    const data = chapterCache.get(key);
    if (!data) return null;
    chapterCache.delete(key);
    chapterCache.set(key, data);
    return data;
  }

  function storeChapterCache(bookId, chapterIndex, data) {
    if (!data.book?.catalogRevision) return;
    const key = chapterCacheKey(bookId, chapterIndex, data.book);
    chapterCache.delete(key);
    chapterCache.set(key, data);
    while (chapterCache.size > NOVEL_CHAPTER_CACHE_LIMIT) {
      const oldest = chapterCache.keys().next().value;
      if (oldest === undefined) break;
      chapterCache.delete(oldest);
    }
  }

  function fetchChapterData(bookId, chapterIndex, options = {}) {
    const book = state.novel.book?.id === bookId ? state.novel.book : null;
    const target = book ? [state.novel.chapter, state.novel.prev, state.novel.next, ...(state.novel.chapters || [])]
      .find(chapter => chapter && Number(chapter.index) === Number(chapterIndex)) : null;
    if (options.allowCache) {
      const cached = cachedChapter(bookId, chapterIndex, book);
      if (cached) return options.expectedChapterId && cached.chapter?.id !== options.expectedChapterId
        ? Promise.reject(new Error("书签对应的章节已变化，请重新打开书籍后核对。")) : Promise.resolve(cached);
    }
    const key = chapterCacheKey(bookId, chapterIndex, book);
    const pending = chapterRequests.get(key);
    if (pending && !pending.controller.signal.aborted && options.allowCache && pending.prefetch) {
      pending.navigation = navigationId;
      pending.prefetch = Boolean(options.prefetch);
      attachChapterSignal(pending, options.signal);
      return pending.promise;
    }
    if (pending) {
      pending.controller.abort();
      chapterRequests.delete(key);
    }
    const params = new URLSearchParams();
    if (book?.sourceRealm) params.set("sourceRealm", book.sourceRealm);
    if (book?.catalogRevision) params.set("catalogRevision", book.catalogRevision);
    if (book?.catalogRevision && (options.expectedChapterId || target?.id)) params.set("chapterId", options.expectedChapterId || target.id);
    const request = { controller: new AbortController(), navigation: navigationId, prefetch: Boolean(options.prefetch), detach: null };
    attachChapterSignal(request, options.signal);
    chapterRequests.set(key, request);
    request.promise = api(`/api/novels/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapterIndex)}${params.size ? `?${params}` : ""}`, {
      signal: request.controller.signal
    })
      .then((data) => {
        if (state.activeView !== "novels" || request.controller.signal.aborted || request.navigation !== navigationId || chapterRequests.get(key) !== request) {
          throw new Error("章节读取已取消");
        }
        if (String(data.book?.id || "") !== String(bookId) || Number(data.chapter?.index) !== Number(chapterIndex)
            || (book?.sourceRealm && data.book?.sourceRealm !== book.sourceRealm)
            || (book?.catalogRevision && (data.book?.catalogRevision !== book.catalogRevision || data.catalogRevision !== book.catalogRevision))
            || (book?.catalogRevision && target?.id && data.chapter?.id !== target.id)
            || (options.expectedChapterId && data.chapter?.id !== options.expectedChapterId)) throw new Error("书籍或章节版本已变化，请重新打开书籍");
        storeChapterCache(bookId, chapterIndex, data);
        return data;
      })
      .finally(() => {
        request.detach?.();
        if (chapterRequests.get(key) === request) chapterRequests.delete(key);
      });
    return request.promise;
  }

  function attachChapterSignal(request, signal) {
    request.detach?.();
    request.detach = null;
    if (!signal) return;
    const abort = () => request.controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    request.detach = () => signal.removeEventListener("abort", abort);
  }

  function cancelChapterRequests(target) {
    const book = state.novel?.book;
    const retainedKey = target?.allowCache && book?.catalogRevision && String(book.id) === String(target.bookId)
      ? chapterCacheKey(target.bookId, target.chapterIndex, book) : null;
    for (const [key, request] of chapterRequests) {
      if (key === retainedKey && request.prefetch && !request.controller.signal.aborted) {
        request.navigation = navigationId;
        continue;
      }
      request.controller.abort();
      request.detach?.();
      chapterRequests.delete(key);
    }
  }

  function prefetchNextChapter(bookId, chapter) {
    if (!bookId || !chapter?.index) return;
    fetchChapterData(bookId, chapter.index, { allowCache: true, prefetch: true }).catch(() => {});
  }

  function openAdjacent(direction) {
    ensureState();
    const target = direction < 0 ? state.novel.prev : state.novel.next;
    if (!target || !state.novel.book) return;
    const bookId = state.novel.book.id;
    if (adjacentNavigation?.owner === navigationId && adjacentNavigation.bookId === bookId && adjacentNavigation.index === target.index) return;
    const pending = { bookId, index: target.index };
    adjacentNavigation = pending;
    const opening = openChapter(bookId, target.index, { restoreProgress: false });
    pending.owner = navigationId;
    opening.catch((error) => {
      if (pending.owner !== navigationId) return;
      state.novel.status = error.message || "章节切换失败";
      renderView();
    }).finally(() => {
      if (adjacentNavigation === pending) adjacentNavigation = null;
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
    document.title = state.novel.chapter
      ? `${state.novel.chapter.title} · ${state.novel.book?.title || "小说阅读"}`
      : state.novel.book ? `${state.novel.book.title} · 小说书库`
        : `${({ mine: "我的阅读", rankings: "小说排行", manage: "小说管理", author: state.novel.author })[state.novel.mode] || "小说书库"} · 本地阅读`;
    const readerFocus = document.activeElement?.dataset?.readerFocus;
    setReaderBodyClass();
    if (updatePendingBookListView()) return;
    if (updatePendingLibraryView()) return;
    libraryObserver?.disconnect();
    const previousLibraryPresentation = libraryPresentation;
    libraryList = null;
    libraryFooter = null;
    libraryPresentation = null;
    if (reuseBookRecoveryMenu()) return;
    if (currentBookRecovery()?.message) {
      els.workGrid.innerHTML = "";
      renderBookFailure();
      return;
    }
    if (reuseNovelLibraryMenu(previousLibraryPresentation)) return;
    els.workGrid.innerHTML = "";
    if (state.novel.loading && !state.novel.data && !state.novel.book && !state.novel.chapter) {
      renderHomeLoading("正在读取小说书库");
      return;
    }
    if (state.novel.chapter) {
      renderReader();
      if (readerFocus) focusReaderControl(readerFocus);
      return;
    }
    if (state.novel.book) {
      renderBookDetail();
      return;
    }
    renderHome();
  }

  function novelSearchContext() {
    return JSON.stringify([state.novel.mode, state.novel.author, state.novel.query, currentBookRecovery()?.bookId || state.novel.book?.id || "", novelMenuRevision]);
  }

  function currentBookRecovery() {
    return state.activeView === "novels" && bookRecovery?.owner === navigationId && !state.novel.chapter ? bookRecovery : null;
  }

  function renderBookFailure(target = els.workGrid) {
    const failure = currentBookRecovery();
    if (!failure?.message) return;
    const shell = document.createElement("section");
    shell.className = "novel-detail novel-book-recovery";
    shell.dataset.novelBookRecovery = failure.bookId;
    shell.append(renderNovelMenu(), renderBreadcrumbs([{ label: "小说书库", action: showHome }, { label: "书籍详情" }], failure.bookId));
    const error = document.createElement("div");
    error.className = "novel-empty-card";
    error.setAttribute("role", "alert");
    const heading = document.createElement("h1");
    heading.textContent = failure.title ? `无法打开《${failure.title}》` : "书籍详情暂时无法读取";
    const message = document.createElement("p");
    message.textContent = failure.message;
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "novel-secondary-button novel-book-retry";
    retry.textContent = state.novel.loading ? "正在重新打开…" : "重试打开书籍";
    retry.disabled = state.novel.loading;
    retry.addEventListener("click", () => {
      if (!retry.isConnected || currentBookRecovery() !== failure || !failure.message || state.novel.loading || navigationController) return;
      void openBook(failure.bookId, { skipRoute: failure.skipRoute, skipListCapture: true, bookRecovery: failure,
        retryFocus: document.activeElement === retry, retryFocusRevision: readerFocusRevision, retryScrollRevision: scrollInputRevision });
    });
    error.append(heading, message, retry);
    shell.append(error);
    target.append(shell);
  }

  function reuseBookRecoveryMenu() {
    const recovery = currentBookRecovery();
    const shell = els.workGrid.querySelector("[data-novel-book-recovery]");
    const menu = shell?.querySelector(".novel-section-menu");
    if (!recovery || shell?.dataset.novelBookRecovery !== recovery.bookId || !menu
        || menu.dataset.novelMenuContext !== novelSearchContext()) return false;
    const keepTitleFocus = document.activeElement === shell.querySelector(".novel-detail-title");
    const staging = document.createElement("div");
    if (recovery.message) renderBookFailure(staging);
    else renderBookDetail(staging);
    const replacement = staging.children[0];
    shell.className = replacement.className;
    // Keep retry-time search input and IME selection in the live document.
    for (const child of [...shell.children]) if (child !== menu) child.remove();
    for (const child of [...replacement.children]) if (!child.classList.contains("novel-section-menu")) shell.append(child);
    const detailView = detailCatalogViews.get(replacement);
    if (detailView) detailCatalogViews.set(shell, detailView);
    else detailCatalogViews.delete(shell);
    if (keepTitleFocus) {
      const title = shell.querySelector(".novel-detail-title");
      if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); }
    }
    return true;
  }

  function restoreBookRetryFocus(options) {
    if (!options.retryFocus || options.retryFocusRevision !== readerFocusRevision || options.retryScrollRevision !== scrollInputRevision
        || document.activeElement !== document.body || !document.hasFocus()) return;
    const target = els.workGrid.querySelector(".novel-book-retry, .novel-detail-title");
    if (target) { target.tabIndex = target.matches("button") ? 0 : -1; target.focus({ preventScroll: true }); }
  }

  function isCurrentNovelSearch(form, context) {
    return form.isConnected && state.activeView === "novels" && context === novelSearchContext();
  }

  function capturePendingBookList(bookId, { kind = "book", chapterIndex = 0, restoreProgress } = {}) {
    const opening = currentPendingBookList();
    if (state.activeView !== "novels" || state.novel.book || state.novel.chapter
        || !["books", "author"].includes(state.novel.mode) || (state.novel.loading && !opening)) return null;
    const home = els.workGrid?.querySelector(".novel-library");
    const menu = home?.querySelector(".novel-section-menu");
    const data = state.novel.data;
    const book = data?.books?.find(book => String(book.id) === String(bookId));
    if (!home || !book || menu?.dataset.novelMenuContext !== novelSearchContext() || !libraryPresentation?.results.isConnected
        || !home.contains(libraryPresentation.results)
        || ["mode", "author", "query", "category"].some(key => libraryPresentation[key] !== state.novel[key])
        || libraryPresentation.sort?.value !== state.novel.sort) return null;
    const key = novelBookKey(book, data.sourceRealm);
    const row = [...home.querySelectorAll("[data-novel-book-key]")].find(row => row.dataset.novelBookKey === key);
    const button = row?.querySelector(kind === "chapter" ? ".novel-book-read" : ".novel-book-detail");
    if (!button) return null;
    const sameButton = opening?.button === button;
    return {
      home, menu, row, button, data, bookId: String(bookId), title: book.title,
      kind, chapterIndex: Number(chapterIndex), restoreProgress: restoreProgress !== false,
      conditions: ["mode", "author", "query", "category", "sort", "page"].map(key => [key, state.novel[key]]),
      menuRevision: novelMenuRevision,
      sourceStatus: opening?.sourceStatus ?? state.novel.status,
      // A redirected or programmatic reopening inherits the accepted list's
      // original presentation, not the previous opening's temporary busy state.
      text: sameButton ? opening.text : button.textContent,
      attributes: sameButton ? opening.attributes : ["aria-busy", "aria-disabled", "aria-label"].map(name => [name, button.getAttribute(name)]),
      results: libraryPresentation.results,
      resultsBusy: opening?.results === libraryPresentation.results ? opening.resultsBusy : libraryPresentation.results.getAttribute("aria-busy")
    };
  }

  function currentPendingBookList() {
    const pending = pendingBookList;
    return pending && state.activeView === "novels" && state.novel.loading && !state.novel.book && !state.novel.chapter
      && pending.owner === navigationId && pending.controller === navigationController && !pending.controller.signal.aborted
      && pending.home.isConnected && pending.row.isConnected && pending.button.isConnected
      && pending.results.isConnected && pending.home.contains(pending.row) && pending.home.contains(pending.results)
      && pending.menu.isConnected && pending.menu.dataset.novelMenuContext === novelSearchContext()
      && pending.data === state.novel.data && pending.menuRevision === novelMenuRevision
      && pending.conditions.every(([key, value]) => state.novel[key] === value) ? pending : null;
  }

  function updatePendingBookListView() {
    const pending = currentPendingBookList();
    if (!pending) return false;
    const action = pending.kind === "chapter" ? "正在翻开" : "正在打开";
    if (pending.button.textContent !== action) pending.button.textContent = action;
    pending.button.setAttribute("aria-label", `${action}《${pending.title || "小说"}》${pending.kind === "chapter" ? `第 ${formatNumber(pending.chapterIndex)} 章` : ""}`);
    pending.button.setAttribute("aria-busy", "true");
    pending.button.setAttribute("aria-disabled", "true");
    pending.results.setAttribute("aria-busy", "true");
    return true;
  }

  function clearPendingBookList() {
    const pending = pendingBookList;
    pendingBookList = null;
    if (!pending) return;
    if (pending.button.isConnected) {
      pending.button.textContent = pending.text;
      for (const [name, value] of pending.attributes) {
        if (value === null) pending.button.removeAttribute(name);
        else pending.button.setAttribute(name, value);
      }
    }
    if (pending.results.isConnected) {
      if (pending.resultsBusy === null) pending.results.removeAttribute("aria-busy");
      else pending.results.setAttribute("aria-busy", pending.resultsBusy);
    }
  }

  function reuseNovelLibraryMenu(previous) {
    if (state.activeView !== "novels" || navigationController || state.novel.book || state.novel.chapter
      || !["books", "mine", "author", "rankings"].includes(state.novel.mode)) return false;
    const home = els.workGrid.querySelector(".novel-home");
    const menu = home?.querySelector(".novel-section-menu");
    if (!menu || menu.dataset.novelMenuContext !== novelSearchContext()) return false;
    const staging = document.createElement("div");
    if (state.novel.loading && !state.novel.data) renderHomeLoading("正在读取小说书库", staging);
    else renderHome(staging);
    const replacement = staging.children[0];
    home.className = replacement.className;
    const retained = retainNovelLibrarySort(home, replacement, previous);
    // Keep the navigation/search in the live document so IME composition,
    // focus and selection never pass through a detached input on result refresh.
    for (const child of [...home.children]) if (child !== menu && child !== retained?.workspace) child.remove();
    for (const child of [...replacement.children]) {
      if (child.classList.contains("novel-section-menu") || child === retained?.replacement) continue;
      home.insertBefore(child, retained?.workspace || null);
    }
    armLibraryAutoload();
    return true;
  }

  function retainNovelLibrarySort(home, replacement, previous) {
    const next = libraryPresentation;
    if (!["books", "author"].includes(state.novel.mode) || !previous || !next
        || ["mode", "author", "query", "category"].some(key => previous[key] !== next[key])) return null;
    const workspace = home.querySelector(".novel-library-workspace"), nextWorkspace = replacement.querySelector(".novel-library-workspace");
    const results = previous.results, nextResults = next.results, sort = previous.sort, nextSort = next.sort;
    const controls = sort?.parentElement, nextControls = nextSort?.parentElement;
    if (!workspace || !nextWorkspace || !results?.isConnected || !controls?.isConnected || !sort?.options || !nextSort?.options
        || sort.options.length !== nextSort.options.length || [...sort.options].some((option, index) => option.value !== nextSort.options[index].value)) return null;
    // Moving even the unchanged select or one of its ancestors blurs native
    // keyboard selection. Only move newly rendered siblings into the live tree.
    if (sort.value !== nextSort.value) sort.value = nextSort.value;
    sort.disabled = nextSort.disabled;
    for (const child of [...controls.children]) if (child !== sort) child.remove();
    for (const child of [...nextControls.children]) if (child !== nextSort) controls.insertBefore(child, sort);
    for (const child of [...results.children]) if (child !== controls) child.remove();
    for (const child of [...nextResults.children]) if (child !== nextControls) results.append(child);
    results.setAttribute("aria-busy", nextResults.getAttribute("aria-busy"));
    for (const child of [...workspace.children]) if (child !== results) child.remove();
    for (const child of [...nextWorkspace.children]) if (child !== nextResults) workspace.insertBefore(child, results);
    workspace.className = nextWorkspace.className;
    next.results = results;
    next.sort = sort;
    return { workspace, replacement: nextWorkspace };
  }

  function updatePendingLibraryView() {
    if (state.activeView !== "novels" || !state.novel.loading || !libraryRequestController || navigationController
        || state.novel.book || state.novel.chapter || !state.novel.data?.books?.length
        || !libraryList?.isConnected || !libraryFooter?.isConnected || !libraryPresentation
        || libraryPresentation.mode !== state.novel.mode
        || libraryPresentation.author !== state.novel.author
        || libraryPresentation.query !== state.novel.query) return false;
    const { results, title, count, sort, categories, status } = libraryPresentation;
    results.setAttribute("aria-busy", "true");
    title.textContent = libraryResultTitle();
    count.textContent = "正在读取…";
    sort.value = state.novel.sort;
    for (const button of categories.children) {
      const active = button.dataset.novelCategory === state.novel.category;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    status.textContent = state.novel.status;
    status.hidden = !state.novel.status;
    updateLibraryTail();
    return true;
  }

  function libraryResultTitle() {
    return state.novel.query ? `“${state.novel.query}”的搜索结果`
      : state.novel.mode === "mine" ? "阅读记录"
        : state.novel.category !== "all" ? displayNovelCategory(state.novel.category) : "全部作品";
  }

  function renderHomeLoading(message, target = els.workGrid) {
    const shell = document.createElement("section");
    shell.className = "novel-home";
    shell.append(renderNovelMenu());

    const loading = document.createElement("div");
    loading.className = "novel-empty-card novel-home-loading";
    loading.setAttribute("role", "status");
    loading.textContent = message;
    shell.append(loading);
    target.append(shell);
  }

  function renderLoading(message) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = message;
    els.workGrid.append(empty);
  }

  function renderHome(target = els.workGrid) {
    const data = state.novel.data || {};
    const summary = state.novel.summary || data.summary || {};
    const shell = document.createElement("section");
    shell.className = "novel-home";
    shell.append(renderNovelMenu());

    if (state.novel.mode === "manage") {
      shell.classList.add("novel-home-manage");
      shell.append(renderManagementPage(summary));
      target.append(shell);
      return;
    }

    if (state.novel.mode === "rankings") {
      libraryObserver?.disconnect();
      libraryObserver = null;
      shell.append(renderRankingBoard(data));
      target.append(shell);
      return;
    }

    shell.classList.add("novel-library");
    const head = document.createElement("header");
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
    eyebrow.textContent = authorProfile ? "作者作品" : "本地藏书";
    const title = document.createElement("h1");
    title.textContent = authorProfile?.name || (state.novel.mode === "mine" ? "我的阅读" : "小说书库");
    const meta = document.createElement("p");
    const totals = summary.totals || {};
    meta.textContent = authorProfile
      ? `${formatNumber(authorProfile.bookCount || 0)} 本作品 · ${formatNumber(authorProfile.chapterCount || 0)} 章 · ${formatNumber(authorProfile.charCount || 0)} 字 · ${formatBytes(authorProfile.sizeBytes || 0)}`
      : state.novel.mode === "mine"
        ? "从上次读到的地方继续。"
        : `${formatNumber(totals.books || 0)} 本藏书 · ${formatNumber(totals.authors || 0)} 位作者`;
    titleWrap.append(eyebrow, title, meta);
    head.append(titleWrap);
    if (state.novel.mode === "books") {
      const authors = document.createElement("button");
      authors.type = "button";
      authors.className = "novel-secondary-button novel-browse-authors";
      authors.textContent = "浏览作者";
      authors.addEventListener("click", () => {
        if (!authors.isConnected || state.activeView !== "novels" || state.novel.book || state.novel.chapter || state.novel.mode !== "books") return;
        authorBrowser?.close();
        const owner = navigationId, revision = novelMenuRevision;
        const browser = createNovelAuthorBrowser({ api,
          isCurrent: () => state.activeView === "novels" && owner === navigationId && revision === novelMenuRevision && !state.novel.book && !state.novel.chapter,
          selectAuthor: name => openNovelAuthor(name, { focus: true, allowUnknownAuthor: true }),
          onClose: () => { if (authorBrowser === browser) authorBrowser = null; }
        });
        authorBrowser = browser; browser.open(authors);
      });
      head.append(authors);
    }

    const workspace = document.createElement("div");
    workspace.className = "novel-library-workspace";
    const sidebar = document.createElement("aside");
    sidebar.className = "novel-library-sidebar";
    const results = document.createElement("section");
    results.className = "novel-library-results";
    results.setAttribute("aria-label", "小说列表");
    results.setAttribute("aria-busy", String(state.novel.loading));
    const controls = document.createElement("div");
    controls.className = "novel-controls";
    const resultHeading = document.createElement("div");
    resultHeading.className = "novel-results-heading";
    const resultTitle = document.createElement("h2");
    resultTitle.textContent = libraryResultTitle();
    const resultCount = document.createElement("span");
    resultCount.className = "novel-results-count";
    resultCount.textContent = `${formatNumber(data.total || 0)} 本`;
    resultHeading.append(resultTitle, resultCount);
    controls.append(resultHeading);
    if (state.novel.query) {
      const clearSearch = document.createElement("button");
      clearSearch.type = "button";
      clearSearch.className = "novel-text-button";
      clearSearch.textContent = "清除搜索";
      clearSearch.addEventListener("click", () => openNovelSearch(""));
      controls.append(clearSearch);
    }
    const sort = document.createElement("select");
    sort.className = "novel-sort";
    sort.setAttribute("aria-label", "小说排序");
    const sortOptions = [["updated", "最近更新"], ["chars", "字数最多"], ["progress", "最近阅读"], ["chapters", "章节最多"], ["size", "文件最大"], ["title", "书名"]];
    for (const option of sortOptions) {
      const item = document.createElement("option");
      item.value = option[0];
      item.textContent = option[1];
      sort.append(item);
    }
    sort.value = state.novel.sort || "updated";
    const sortContext = novelSearchContext();
    sort.addEventListener("change", () => {
      if (!sort.isConnected || state.activeView !== "novels" || state.novel.book || state.novel.chapter || sortContext !== novelSearchContext()) return;
      state.novel.sort = sort.value;
      state.novel.page = 0;
      loadNovels({ replaceRoute: true }).catch(() => {});
    });
    if (state.novel.mode !== "mine") controls.append(sort);

    const categories = document.createElement("div");
    categories.className = "novel-category-row";
    categories.setAttribute("aria-label", "书库分类，数量为全库统计");
    if (state.novel.mode === "books") {
      const categoryHeading = document.createElement("h2");
      categoryHeading.className = "novel-sidebar-heading";
      categoryHeading.textContent = "分类";
      const categoryHint = document.createElement("span");
      categoryHint.textContent = "全库";
      categoryHeading.append(categoryHint);
      sidebar.append(categoryHeading);
      categories.append(categoryButton("all", "全部", summary.totals?.books || 0));
      for (const item of data.facets || summary.categories || []) {
        categories.append(categoryButton(item.name, item.name, item.count));
      }
      sidebar.append(categories);
      const recentBook = summary.recent?.[0];
      if (recentBook) {
        const resume = document.createElement("section");
        resume.className = "novel-resume";
        const caption = document.createElement("h2");
        caption.textContent = "接着上次读";
        const bookTitle = document.createElement("button");
        bookTitle.type = "button";
        bookTitle.className = "novel-resume-title";
        bookTitle.textContent = recentBook.title;
        bookTitle.addEventListener("click", () => openBook(recentBook.id));
        const progress = document.createElement("p");
        progress.textContent = recentBook.progressRecovery ? "旧阅读位置待确认" : compactBookProgress(recentBook);
        const resumeRead = document.createElement("button");
        resumeRead.type = "button";
        resumeRead.className = "novel-resume-read";
        resumeRead.textContent = recentBook.progressRecovery ? "查看阅读位置 →" : "继续阅读 →";
        resumeRead.addEventListener("click", () => openReading(recentBook));
        resume.append(caption, bookTitle, progress, resumeRead);
        sidebar.append(resume);
      }
    }

    const entries = data.books || [];
    let list = state.novel.mode === "mine" ? renderRecent(entries) : null;
    if (!list) {
      list = document.createElement("div");
      list.className = "novel-book-list";
      for (const entry of entries) {
        list.append(renderBookRow(entry));
      }
    }
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "novel-empty-card";
      empty.setAttribute("role", "status");
      const emptyTitle = document.createElement("h3");
      emptyTitle.textContent = state.novel.loading ? "正在读取书库" : state.novel.libraryError ? "书库暂时无法读取" : state.novel.query ? "没有找到这本书" : state.novel.mode === "mine" ? "还没有阅读记录" : "这里还没有小说";
      const emptyCopy = document.createElement("p");
      emptyCopy.textContent = state.novel.libraryError || (state.novel.query ? "试试其他书名或作者，也可以清除搜索后浏览。" : state.novel.mode === "mine" ? "在书库打开一本书，阅读位置会自动保存在这里。" : "可以在管理页面导入本地 TXT 文件。");
      empty.append(emptyTitle, emptyCopy);
      if (!state.novel.loading) {
        const action = document.createElement("button");
        action.type = "button";
        action.className = "novel-secondary-button";
        action.textContent = state.novel.libraryError ? "重试" : state.novel.query ? "清除搜索" : state.novel.mode === "mine" ? "浏览书库" : "导入小说";
        action.addEventListener("click", () => state.novel.libraryError ? retryLibraryRead({ skipRoute: true }).catch(() => {}) : state.novel.query ? openNovelSearch("") : openNovelSection(state.novel.mode === "mine" ? "books" : "manage"));
        empty.append(action);
      }
      list.append(empty);
    }

    shell.append(head);
    results.append(controls);
    const status = document.createElement("div");
    status.className = "novel-status-line";
    status.textContent = entries.length ? state.novel.status : "";
    status.hidden = !status.textContent;
    results.append(status);
    results.append(list);
    libraryList = state.novel.mode === "mine" ? list.querySelector(".novel-recent-strip") || list : list;
    libraryFooter = document.createElement("div");
    libraryFooter.className = "novel-library-autoload";
    results.append(libraryFooter);
    libraryPresentation = {
      mode: state.novel.mode, author: state.novel.author, query: state.novel.query, category: state.novel.category,
      results, title: resultTitle, count: resultCount, sort, categories, status
    };
    if (sidebar.childElementCount) workspace.append(sidebar);
    else workspace.classList.add("without-sidebar");
    workspace.append(results);
    shell.append(workspace);
    target.append(shell);
    updateLibraryTail();
  }

  function updateLibraryTail(newBooks = [], updatedBooks = []) {
    if (!libraryList || !libraryFooter) return;
    if (updatedBooks.length) {
      const rows = new Map([...libraryList.children].map(row => [row.dataset.novelBookKey, row]));
      for (const book of updatedBooks) {
        const row = rows.get(novelBookKey(book, state.novel.data?.sourceRealm));
        if (row) row.replaceWith(state.novel.mode === "mine" ? renderRecentItem(book) : renderBookRow(book));
      }
    }
    for (const book of newBooks) libraryList.append(state.novel.mode === "mine" ? renderRecentItem(book) : renderBookRow(book));
    libraryFooter.replaceChildren();
    const loaded = state.novel.data?.books?.length || 0;
    const count = document.createElement("span");
    count.setAttribute("role", "status");
    count.textContent = state.novel.loading ? "正在读取小说书库…" : state.novel.loadingMore ? "正在继续加载…" : state.novel.libraryError ? `加载中断：${state.novel.libraryError}` : loaded ? `已显示 ${formatNumber(loaded)} / ${formatNumber(state.novel.data?.total || loaded)} 本` : "";
    libraryFooter.append(count);
    libraryPresentation?.results.setAttribute("aria-busy", String(state.novel.loading || state.novel.loadingMore));
    const retryRead = state.novel.libraryError && state.novel.libraryErrorAppend !== true;
    if ((retryRead || state.novel.hasMore) && !state.novel.loading && !state.novel.loadingMore) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "novel-text-button";
      more.textContent = retryRead ? "重新读取" : state.novel.libraryError ? "重试加载" : "加载更多";
      more.addEventListener("click", () => retryLibraryRead({ append: !retryRead, skipRoute: true }).catch(() => {}));
      libraryFooter.append(more);
    }
    armLibraryAutoload();
  }

  function armLibraryAutoload() {
    libraryObserver?.disconnect();
    libraryObserver = null;
    const sentinel = document.querySelector(".novel-library-autoload");
    if (!sentinel || !state.novel.hasMore || state.novel.loading || state.novel.loadingMore || state.novel.libraryError) return;
    const owner = navigationId;
    const observer = new IntersectionObserver(
      (entries) => {
        if (libraryObserver !== observer || owner !== navigationId || !sentinel.isConnected
            || state.activeView !== "novels" || state.novel.book || state.novel.chapter) return;
        if (!entries.some((entry) => entry.isIntersecting)) return;
        libraryObserver?.disconnect();
        libraryObserver = null;
        loadNovels({ append: true, skipRoute: true }).catch(() => {});
      },
      { rootMargin: "600px 0px" }
    );
    libraryObserver = observer;
    observer.observe(sentinel);
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
    const menuContext = novelSearchContext();
    nav.dataset.novelMenuContext = menuContext;
    nav.setAttribute("aria-label", "小说功能");
    const brand = document.createElement("a");
    brand.className = "novel-brand";
    brand.href = "/novels";
    brand.textContent = "小说";
    nav.append(brand);
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
      if (!isCurrentNovelSearch(search, menuContext)) return;
      openNovelSearch(input.value, { restoreFocus: search.contains(document.activeElement) });
    });
    nav.append(search);
    return nav;
  }

  function openNovelSection(mode) {
    if (!["books", "mine", "rankings", "manage"].includes(mode)) return;
    clearLibraryReturn();
    novelMenuRevision += 1;
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

  function openNovelSearch(value, options = {}) {
    clearLibraryReturn();
    novelMenuRevision += 1;
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
    if (options.restoreFocus) {
      const input = els.workGrid.querySelector(".novel-section-search input");
      input?.focus({ preventScroll: true });
      input?.setSelectionRange(input.value.length, input.value.length);
    }
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
        uploadJob?.summaryController?.abort();
        state.novel.manageSection = value;
        renderView();
        if (value === "upload" && currentUploadJob()?.summaryDirty) {
          const job = currentUploadJob();
          refreshUploadSummary(job).then(() => { if (currentUploadJob() === job) updateUploadView(); });
        }
      });
      nav.append(button);
    }

    const sidebarStatus = document.createElement("div");
    sidebarStatus.className = "novel-management-sidebar-status";
    const sidebarStatusLabel = document.createElement("span");
    sidebarStatusLabel.textContent = "书库状态";
    const sidebarStatusValue = document.createElement("strong");
    sidebarStatusValue.dataset.novelUploadMetric = "library";
    sidebarStatusValue.textContent = `${formatNumber(totals.books || 0)} 本 · ${formatNumber(totals.chapters || 0)} 章`;
    const sidebarStatusTime = document.createElement("small");
    sidebarStatusTime.dataset.novelUploadMetric = "scannedAt";
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
      for (const [label, value, key] of [
        ["书籍", formatNumber(totals.books || 0), "books"],
        ["章节", formatNumber(totals.chapters || 0), "chapters"],
        ["正文", formatNumber(totals.chars || 0), "chars"],
        ["最近扫描", summary.scannedAt ? formatDateTime(summary.scannedAt) : "暂无记录", "latestScan"]
      ]) {
        const item = document.createElement("div");
        const span = document.createElement("span");
        span.textContent = label;
        const strong = document.createElement("strong");
        strong.dataset.novelUploadMetric = key;
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
      uploadDescription.textContent = "支持一次选择多个 TXT 文件；兼容 UTF-8、带 BOM 的 UTF-16 和常见中文编码，上传后自动解析书名、作者与章节。";
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
      const uploading = Boolean(currentUploadJob()?.running);
      uploadButton.dataset.novelUpload = "picker";
      uploadButton.textContent = uploading ? "正在上传" : "选择 TXT 文件";
      uploadButton.disabled = uploading;
      uploadButton.addEventListener("click", () => uploadInput.click());
      uploadInput.addEventListener("change", () => {
        if (!uploadInput.isConnected || state.activeView !== "novels" || state.novel.mode !== "manage" || state.novel.manageSection !== "upload") return;
        const files = Array.from(uploadInput.files || []);
        uploadInput.value = "";
        uploadNovelFiles(files).catch((error) => {
          if (uploadInput.isConnected) {
            state.novel.status = error.message || "上传失败";
            updateUploadView();
          }
        });
      });
      const refreshButton = document.createElement("button");
      refreshButton.type = "button";
      refreshButton.className = "novel-secondary-button";
      refreshButton.textContent = "刷新整本书库";
      refreshButton.dataset.novelUpload = "refresh";
      refreshButton.disabled = uploading;
      refreshButton.addEventListener("click", () => openAdminScript("novel-library-rescan"));
      actions.append(uploadInput, uploadButton, refreshButton);
      uploadCard.append(uploadCopy, actions);
      overview.append(metrics);
      main.append(header, overview, uploadCard);
    } else {
      main.append(collectionAdmin.render({ section: state.novel.manageSection }));
    }
    const uploadSection = state.novel.manageSection === "upload";
    const statusText = uploadSection ? uploadStatus() : state.novel.status;
    if (statusText || uploadSection) {
      const status = document.createElement("div");
      status.className = `novel-management-status${uploadSection ? " novel-upload-status" : ""}`;
      status.textContent = statusText;
      status.hidden = !statusText;
      main.prepend(status);
    }
    shell.append(sidebar, main);
    panel.append(shell);
    return panel;
  }

  function rankingQueryKey() {
    return JSON.stringify([state.novel.query, state.novel.sort, state.novel.page, state.novel.author, state.novel.category]);
  }

  function matchesRankingContext(context) {
    return state.activeView === "novels" && state.novel.mode === "rankings" && !state.novel.book && !state.novel.chapter
      && context === rankingQueryKey();
  }

  function isCurrentRankingRetry(panel, context) {
    return panel.isConnected && matchesRankingContext(context) && !navigationController && !state.novel.loading && Boolean(state.novel.libraryError);
  }

  function renderRankingBoard(data = {}) {
    const books = Array.isArray(data.books) ? data.books : [];
    const panel = document.createElement("section");
    panel.className = "novel-ranking-board";
    panel.setAttribute("aria-busy", String(Boolean(state.novel.loading)));

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

    if (state.novel.loading || state.novel.libraryError) {
      const status = document.createElement("div");
      status.className = "novel-ranking-status";
      status.setAttribute("role", "status");
      const message = document.createElement("span");
      message.textContent = state.novel.loading ? "正在读取排行榜…" : state.novel.libraryError;
      status.append(message);
      if (!state.novel.loading) {
        const hint = document.createElement("span");
        hint.textContent = books.length ? "仍显示上次结果；重试会保留当前排序和页码。" : "重试会保留当前排序和页码。";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "novel-secondary-button novel-ranking-retry";
        retry.textContent = "重试排行榜";
        const retryContext = rankingQueryKey();
        retry.addEventListener("click", () => {
          if (!isCurrentRankingRetry(panel, retryContext)) return;
          const restoreFocus = document.activeElement === retry;
          const focusRevision = readerFocusRevision;
          const pending = retryLibraryRead({ skipRoute: true });
          const requestOwner = libraryRequestId;
          pending.catch(() => {}).then(() => {
            if (!restoreFocus || focusRevision !== readerFocusRevision || requestOwner !== libraryRequestId
                || !matchesRankingContext(retryContext) || navigationController || state.novel.loading) return;
            const target = els.workGrid.querySelector(".novel-ranking-retry") || els.workGrid.querySelector(".novel-ranking-heading h2");
            if (target) {
              target.tabIndex = target.tagName === "H2" ? -1 : 0;
              target.focus({ preventScroll: true });
              target.scrollIntoView({ block: "nearest", behavior: "auto" });
            }
          });
        });
        status.append(hint, retry);
      }
      panel.append(status);
    }

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
    const rankingOffset = Math.max(0, Number(data.offset ?? state.novel.page * limit));
    for (const [index, book] of books.entries()) {
      body.append(renderRankingRow(book, rankingOffset + index + 1));
    }
    if (!books.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.className = "novel-ranking-empty";
      cell.textContent = state.novel.libraryError ? "排行榜尚未载入，可在上方重试。" : state.novel.status || "排行榜暂时没有小说。";
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
    row.dataset.novelBookKey = novelBookKey(book, state.novel.data?.sourceRealm);
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

  function openNovelAuthor(authorName, options = {}) {
    const name = String(authorName || "").trim();
    if (!name || (name === "未知作者" && !options.allowUnknownAuthor)) return;
    clearLibraryReturn();
    novelMenuRevision += 1;
    state.novel.mode = "author";
    state.novel.author = name;
    state.novel.query = "";
    state.novel.category = "all";
    state.novel.page = 0;
    state.novel.sort = "title";
    state.novel.data = null;
    const focus = readerFocusRevision;
    const pending = loadNovels();
    const owner = navigationId, request = libraryRequestId;
    return pending.then(result => {
      if (options.focus && result !== false && focus === readerFocusRevision && owner === navigationId && request === libraryRequestId
          && state.activeView === "novels" && state.novel.mode === "author" && state.novel.author === name && !state.novel.loading) {
        const heading = els.workGrid.querySelector(".novel-home-head h1");
        if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
      }
    }).catch(() => {});
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
    const length = book.charCount >= 10000 ? `${formatNumber(Math.round(book.charCount / 1000) / 10)} 万字` : book.charCount ? `${formatNumber(book.charCount)} 字` : `${formatNumber(book.chapterCount)} 章`;
    for (const value of [displayNovelCategory(book.category), length].filter(Boolean)) {
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
    button.dataset.novelCategory = value;
    button.setAttribute("aria-pressed", String(state.novel.category === value));
    const name = document.createElement("span");
    name.textContent = displayNovelCategory(label);
    const total = document.createElement("small");
    total.textContent = formatNumber(count || 0);
    button.append(name, total);
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
    for (const book of items) strip.append(renderRecentItem(book));
    panel.append(title, strip);
    return panel;
  }

  function renderRecentItem(book) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "novel-recent-item";
    button.dataset.novelBookKey = novelBookKey(book, state.novel.data?.sourceRealm);
    const strong = document.createElement("strong");
    strong.textContent = book.title;
    const span = document.createElement("span");
    span.textContent = book.progressRecovery ? "旧阅读位置待确认" : compactBookProgress(book);
    button.append(strong, span);
    button.addEventListener("click", () => openReading(book));
    return button;
  }

  function renderBookRow(book, rank = 0) {
    const row = document.createElement("article");
    row.className = `novel-book-row${rank ? " ranking" : ""}`;
    row.dataset.novelBookKey = novelBookKey(book, state.novel.data?.sourceRealm);
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
    const titleLink = document.createElement("button");
    titleLink.type = "button";
    titleLink.className = "novel-book-title";
    titleLink.textContent = book.title;
    titleLink.addEventListener("click", () => {
      const pending = currentPendingBookList();
      if (pending?.kind !== "book" || pending.bookId !== String(book.id)) openBook(book.id);
    });
    title.append(titleLink);
    const meta = renderBookMeta(book, rank);
    const summary = document.createElement("p");
    summary.className = "novel-book-summary";
    summary.textContent = book.summary || "暂无简介，可打开目录浏览章节。";
    const latest = document.createElement("div");
    latest.className = "novel-book-latest";
    latest.textContent = book.progressRecovery ? "阅读位置待确认" : book.progress ? compactBookProgress(book) : `${formatNumber(book.chapterCount)} 章${book.updatedAt ? ` · ${formatNovelDate(book.updatedAt)} 更新` : ""}`;
    body.append(title, meta, summary, latest);
    const actions = document.createElement("div");
    actions.className = "novel-book-actions";
    const detail = document.createElement("button");
    detail.type = "button";
    detail.className = "novel-book-detail";
    detail.textContent = "书籍详情";
    detail.addEventListener("click", (event) => {
      event.stopPropagation();
      const pending = currentPendingBookList();
      if (pending?.kind !== "book" || pending.bookId !== String(book.id)) openBook(book.id);
    });
    const read = document.createElement("button");
    read.type = "button";
    read.className = book.progress || book.progressRecovery ? "primary" : "novel-read-link";
    read.classList.add("novel-book-read");
    read.textContent = book.progressRecovery ? "查看进度" : book.progress ? "继续阅读" : "开始阅读";
    read.addEventListener("click", (event) => {
      event.stopPropagation();
      const pending = currentPendingBookList();
      if (pending?.kind === "chapter" && pending.bookId === String(book.id)
          && pending.chapterIndex === Number(book.progress?.chapterIndex || 1) && pending.restoreProgress === Boolean(book.progress)) return;
      openReading(book);
    });
    actions.append(detail, read);
    row.append(body, actions);
    return row;
  }

  function renderBookDetail(target = els.workGrid) {
    const book = state.novel.book;
    const chapters = state.novel.chapters || [];
    const shell = document.createElement("section");
    shell.className = "novel-detail";
    shell.append(renderNovelMenu(), renderBreadcrumbs([{ label: "小说书库", action: showHome }, { label: book.title }]));
    if (state.novel.status) {
      const status = document.createElement("div");
      status.className = "novel-status-line";
      status.setAttribute("role", "status");
      status.textContent = state.novel.status;
      shell.append(status);
    }

    const hero = document.createElement("section");
    hero.className = "novel-detail-hero";
    hero.append(renderCover(book, "large"));
    const info = document.createElement("div");
    info.className = "novel-detail-info";
    const eyebrow = document.createElement("p");
    eyebrow.className = "novel-detail-eyebrow";
    eyebrow.textContent = "本地藏书";
    const title = document.createElement("h2");
    title.className = "novel-detail-title";
    title.textContent = book.title;
    const meta = document.createElement("p");
    meta.className = "novel-detail-byline";
    const authorName = String(book.author || "未知作者").trim() || "未知作者";
    if (authorName === "未知作者") {
      const author = document.createElement("span");
      author.textContent = authorName;
      meta.append(author);
    } else {
      const author = document.createElement("button");
      author.type = "button";
      author.className = "novel-detail-author";
      author.textContent = authorName;
      author.title = `查看 ${authorName} 的作品`;
      author.addEventListener("click", () => openNovelAuthor(authorName));
      meta.append(author);
    }
    if (book.category) {
      const category = document.createElement("span");
      category.className = "novel-detail-category";
      category.textContent = book.category;
      meta.append(category);
    }
    const metrics = document.createElement("div");
    metrics.className = "novel-detail-metrics";
    for (const item of [
      ["字", `${formatNumber(book.charCount)}`],
      ["章", `${formatNumber(book.chapterCount)}`]
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
    start.addEventListener("click", () => openReading(book));
    const catalogButton = document.createElement("button");
    catalogButton.type = "button";
    catalogButton.className = "novel-secondary-button";
    catalogButton.textContent = "查看目录";
    catalogButton.addEventListener("click", () => document.querySelector(".novel-catalog")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    actions.append(start, catalogButton);
    const tools = document.createElement("details");
    tools.className = "novel-detail-tools";
    const toolsSummary = document.createElement("summary");
    toolsSummary.textContent = "书籍工具";
    const toolsContent = document.createElement("div");
    toolsContent.className = "novel-detail-tools-content";
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
    toolsContent.append(download, reimport, correct);
    if (book.sizeBytes) {
      const fileSize = document.createElement("span");
      fileSize.className = "novel-detail-file-size";
      fileSize.textContent = `TXT · ${formatBytes(book.sizeBytes)}`;
      toolsContent.append(fileSize);
    }
    tools.append(toolsSummary, toolsContent);
    info.append(eyebrow, title, meta, metrics, actions, tools);
    const side = document.createElement("aside");
    side.className = "novel-detail-reading";
    const sideTitle = document.createElement("strong");
    sideTitle.textContent = "阅读记录";
    side.append(sideTitle);
    side.append(novelBookmarksControl(book));
    if (book.progressRecovery) {
      const recovery = document.createElement("p");
      recovery.className = "novel-detail-recovery-note";
      recovery.textContent = "阅读位置有变化，打开正文后可确认接续位置。";
      side.append(recovery);
    } else if (book.progress) {
      const progress = document.createElement("p");
      progress.className = "novel-detail-progress";
      progress.textContent = `已读 ${Math.round(readingProgress(book).overallRatio * 1000) / 10}%`;
      side.append(progress);
    }
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
    let progressTitle = null;
    if (progressChapter) {
      const progressAction = createDetailChapterAction("上次读到", book, progressChapter, true);
      progressTitle = progressAction.querySelector("button");
      side.append(progressAction);
    } else if (!book.progressRecovery) {
      const unread = document.createElement("p");
      unread.textContent = "尚未开始阅读";
      side.append(unread);
    }
    if (latestChapter && Number(latestChapter.index) !== Number(progressChapter?.index)) {
      side.append(createDetailChapterAction("最新章节", book, latestChapter));
    }
    const updated = document.createElement("span");
    updated.className = "novel-detail-updated";
    updated.textContent = book.updatedAt ? `书库更新于 ${formatDateTime(book.updatedAt)}` : "";
    if (book.updatedAt) side.append(updated);
    hero.append(info, side);

    const intro = document.createElement("section");
    intro.className = "novel-intro";
    const introTitle = document.createElement("h3");
    introTitle.textContent = "作品简介";
    const introText = document.createElement("p");
    introText.textContent = String(book.summary || "").trim() || "这本书还没有简介。先翻开正文看看，也可以在书籍工具中补充简介。";
    intro.append(introTitle, introText);

    const catalog = renderBookCatalog(book, chapters);
    shell.append(hero, intro, catalog);
    target.append(shell);
    detailCatalogViews.set(shell, { owner: navigationId, book, catalog, progressTitle, progressIndex: Number(progressChapter?.index || 0) });
  }

  function renderBookCatalog(book, chapters) {
    const owner = navigationId;
    const catalog = document.createElement("section");
    catalog.className = "novel-catalog";
    const catalogHead = document.createElement("div");
    catalogHead.className = "novel-detail-catalog-head";
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
    } else if (state.novel.catalogError || !hasCatalogForCurrentChapter()) {
      const error = document.createElement("div");
      error.className = "novel-catalog-loading error";
      error.textContent = state.novel.catalogError || "章节目录读取已中断，请重试";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "novel-secondary-button";
      retry.textContent = "重试目录";
      retry.addEventListener("click", () => {
        if (!catalog.isConnected || state.activeView !== "novels" || owner !== navigationId || state.novel.chapter
            || !sameBookSnapshot(book, state.novel.book)) return;
        loadRemoteCatalogPage().catch(() => {});
      });
      grid.append(error, retry);
    } else {
      grid.append(createCatalogBrowser(chapters, {
        compact: false,
        meta: catalogMeta
      }));
    }
    catalog.append(catalogHead, grid);
    return catalog;
  }

  function updateCurrentBookDetailCatalog(owner, book) {
    const detail = els.workGrid?.querySelector(".novel-detail");
    const view = detail && detailCatalogViews.get(detail);
    if (!detail?.isConnected || !view || state.activeView !== "novels" || state.novel.chapter
        || owner !== navigationId || view.owner !== owner || view.book !== state.novel.book || !sameBookSnapshot(book, state.novel.book)
        || !sameBookSnapshot(view.book, book) || view.catalog.parentElement !== detail) return false;
    const chapters = state.novel.chapters || [];
    const catalog = renderBookCatalog(state.novel.book, chapters);
    view.catalog.replaceWith(catalog);
    view.catalog = catalog;
    const progressIndex = Number(state.novel.book.progress?.chapterIndex || 0);
    if (view.progressTitle?.isConnected && detail.contains(view.progressTitle) && progressIndex === view.progressIndex) {
      const chapter = chapters.find(chapter => Number(chapter.index) === progressIndex);
      if (chapter) view.progressTitle.textContent = `${formatNumber(chapter.index)} · ${chapter.title}`;
    }
    return true;
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
    const owner = navigationId;
    const isCurrentReimport = () => dialog.isConnected && dialog.open && state.activeView === "novels"
      && owner === navigationId && sameBookSnapshot(book, state.novel.book);
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
      if (!isCurrentReimport()) return;
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
        if (result.kind !== "collection") invalidateLibraryReturnData();
        if (!isCurrentReimport()) return;
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
    const owner = navigationId;
    let mutationPending = false;
    const isCurrentCorrection = () => dialog.isConnected && dialog.open && state.activeView === "novels"
      && owner === navigationId && sameBookSnapshot(book, state.novel.book);
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
    const composingFields = new Set();
    for (const input of [titleInput, authorInput, categoryInput, summaryInput]) {
      input.addEventListener("compositionstart", () => composingFields.add(input));
      input.addEventListener("compositionend", () => composingFields.delete(input));
    }
    const readCorrectionDraft = () => ({
      title: titleInput.value,
      author: authorInput.value,
      category: categoryInput.value,
      summary: summaryInput.value
    });

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
      if (mutationPending || !isCurrentCorrection()) return;
      const deletionTitle = state.novel.book.title;
      if (!deleteArmed) {
        deleteArmed = true;
        deleteButton.classList.add("confirm");
        deleteButton.textContent = "确认删除";
        message.textContent = `将《${deletionTitle}》从书库移除，磁盘原始 TXT 不会删除。再次点击确认。`;
        return;
      }
      mutationPending = true;
      deleteButton.disabled = true;
      save.disabled = true;
      deleteButton.textContent = "正在删除";
      try {
        await api(`/api/novels/${encodeURIComponent(book.id)}`, { method: "DELETE" });
        invalidateLibraryReturnData();
        if (!isCurrentCorrection()) return;
        dialog.close();
        if (libraryReturnContext?.bookId === String(book.id)) {
          await returnToLibrary(libraryReturnContext, { removedBookId: book.id, status: `已删除《${deletionTitle}》` });
          return;
        }
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
        const reload = loadNovels({ replaceRoute: true });
        const reloadOwner = navigationId;
        const refreshed = await reload;
        if (refreshed === false || reloadOwner !== navigationId || state.activeView !== "novels") return;
        state.novel.status = `已删除《${deletionTitle}》`;
        renderView();
      } catch (error) {
        if (!isCurrentCorrection()) return;
        message.textContent = error.message || "删除失败";
        deleteButton.disabled = false;
        save.disabled = false;
        deleteButton.textContent = "确认删除";
      } finally {
        mutationPending = false;
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
      if (mutationPending || !isCurrentCorrection()) return;
      const submitted = readCorrectionDraft();
      deleteArmed = false;
      deleteButton.classList.remove("confirm");
      deleteButton.textContent = "删除小说";
      mutationPending = true;
      save.disabled = true;
      deleteButton.disabled = true;
      save.textContent = "正在保存";
      message.textContent = "";
      try {
        const result = await api(`/api/novels/${encodeURIComponent(book.id)}`, {
          method: "PATCH",
          body: submitted
        });
        invalidateLibraryReturnData();
        if (!isCurrentCorrection()) return;
        state.novel.book = { ...state.novel.book, ...result.book };
        state.novel.data = null;
        const currentDraft = readCorrectionDraft();
        const hasNewDraft = composingFields.size > 0 || Object.keys(submitted).some(key => currentDraft[key] !== submitted[key]);
        if (hasNewDraft) {
          message.textContent = "提交内容已保存，当前修改尚未保存";
          save.disabled = false;
          deleteButton.disabled = false;
          save.textContent = "保存校正";
        } else dialog.close();
        renderStats();
        renderView();
      } catch (error) {
        if (!isCurrentCorrection()) return;
        message.textContent = error.message || "保存失败";
        save.disabled = false;
        deleteButton.disabled = false;
        save.textContent = "保存校正";
      } finally {
        mutationPending = false;
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
    const page = document.createElement("section");
    applyReaderAppearance(page);

    const paper = document.createElement("article");
    paper.className = "novel-reader-paper";
    paper.inert = state.novel.catalogOpen;
    paper.append(renderBreadcrumbs([{ label: "小说书库", action: showHome }, { label: book.title, action: () => openBook(book.id) }, { label: chapter.title }]));
    if (book.progressRecovery) {
      const notice = document.createElement("div");
      notice.className = "novel-reader-meta";
      const message = document.createElement("p");
      const candidate = book.progressRecovery.candidate;
      message.textContent = candidate
        ? `旧阅读位置需要确认。可能对应：${candidate.title || `第 ${candidate.chapterIndex} 章`}；未保留原百分比。请在目录选择核实，旧进度暂时保留。`
        : "旧阅读位置尚未验证，自动保存已暂停。请通过目录选择并核实章节后确认；旧进度暂时保留。";
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "novel-progress-recovery-confirm";
      confirm.textContent = "确认从当前章节重新记录进度";
      confirm.disabled = hasPendingRecoveryWrite(book, chapter);
      confirm.addEventListener("click", async () => {
        if (!sameBookSnapshot(book, state.novel.book) || state.novel.chapter?.id !== chapter.id || hasPendingRecoveryWrite(book, chapter)) return;
        confirm.disabled = true;
        const saved = await saveProgress({ confirmRecovery: true });
        if (!sameBookSnapshot(book, state.novel.book) || state.novel.chapter?.id !== chapter.id) return;
        confirm.disabled = false;
        if (saved) { state.novel.pendingScrollRatio = currentReaderRatio(); renderView(); restoreReaderScroll(); }
      });
      notice.append(message, confirm);
      paper.append(notice);
    }
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
    if (isCurrentChapterFailure(failedChapterNavigation) && !state.novel.catalogOpen) {
      setReaderNavigationStatus(failedChapterNavigation.message, "error", failedChapterNavigation);
    }
    syncProgressSaveFeedback();
  }

  function applyReaderAppearance(page) {
    const settings = state.novel.settings;
    page.className = `novel-reader-page theme-${settings.theme}${settings.night ? " night" : ""}`;
    page.style.setProperty("--novel-font-size", `${settings.fontSize}px`);
    page.style.setProperty("--novel-line-height", String(settings.lineHeight));
    page.style.setProperty("--novel-reader-width", `${settings.width}px`);
    page.style.setProperty("--novel-font-family", readerFontFamily(settings.font));
  }

  function updateReaderPanels() {
    const page = els.workGrid?.querySelector(".novel-reader-page");
    if (!page || !state.novel.chapter) return false;
    const focusKey = document.activeElement?.dataset?.readerFocus;
    page.querySelector(".novel-reader-drawer")?.remove();
    page.querySelector(".novel-settings-panel")?.remove();
    page.querySelector(".novel-reader-paper").inert = state.novel.catalogOpen;
    page.querySelector(".novel-reader-toolbar").inert = state.novel.catalogOpen;
    page.querySelector('[data-reader-focus="toolbar-目录"]')?.setAttribute("aria-expanded", String(state.novel.catalogOpen));
    page.querySelector('[data-reader-focus="toolbar-设置"]')?.setAttribute("aria-expanded", String(state.novel.settingsOpen));
    if (state.novel.catalogOpen) {
      clearReaderNavigationStatus();
      page.append(renderCatalogDrawer());
    }
    if (state.novel.settingsOpen) page.append(renderSettingsPanel());
    if (isCurrentChapterFailure(failedChapterNavigation) && !state.novel.catalogOpen) {
      setReaderNavigationStatus(failedChapterNavigation.message, "error", failedChapterNavigation);
    }
    syncProgressSaveFeedback();
    if (focusKey) focusReaderControl(focusKey);
    return true;
  }

  function updateReaderSettingsControls(page) {
    const settings = state.novel.settings;
    page.querySelector('[data-reader-focus="toolbar-夜间"]')?.setAttribute("aria-pressed", String(settings.night));
    for (const button of page.querySelectorAll(".novel-theme-buttons button")) {
      const selected = button.dataset.readerFocus === `theme-${settings.theme}`;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected && !settings.night));
    }
    for (const button of page.querySelectorAll(".novel-font-buttons button")) {
      const selected = button.dataset.readerFocus === `font-${settings.font}`;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    for (const [key, min, max] of [["fontSize", 16, 30], ["lineHeight", 1.5, 2.4], ["width", 760, 1080]]) {
      const minus = page.querySelector(`[data-reader-focus="${key}-minus"]`);
      const plus = page.querySelector(`[data-reader-focus="${key}-plus"]`);
      if (!minus || !plus) continue;
      minus.disabled = settings[key] <= min;
      plus.disabled = settings[key] >= max;
      minus.parentElement.querySelector("span").textContent = key === "lineHeight" ? settings[key].toFixed(1) : `${settings[key]}px`;
    }
    const focused = document.activeElement;
    if (focused?.disabled && focused.dataset.readerFocus) focusReaderControl(focused.dataset.readerFocus);
  }

  function renderReaderToolbar() {
    const toolbar = document.createElement("aside");
    toolbar.className = "novel-reader-toolbar";
    toolbar.inert = state.novel.catalogOpen;
    toolbar.setAttribute("aria-label", "阅读工具");
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
    button.dataset.readerFocus = `toolbar-${label}`;
    button.setAttribute("aria-label", label);
    if (label === "夜间") button.setAttribute("aria-pressed", String(state.novel.settings.night));
    if (label === "目录" || label === "设置") button.setAttribute("aria-expanded", String(label === "目录" ? state.novel.catalogOpen : state.novel.settingsOpen));
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
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "章节目录");
    const head = document.createElement("div");
    head.className = "novel-reader-drawer-head";
    const title = document.createElement("strong");
    title.textContent = `章节目录 · ${formatNumber(state.novel.book?.chapterCount || state.novel.chapters?.length || 0)} 章`;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.dataset.readerFocus = "catalog-close";
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
    const owner = navigationId;
    const book = state.novel.book;
    const shell = document.createElement("div");
    shell.className = `novel-catalog-browser-inner${options.compact ? " compact" : ""}`;
    const tools = document.createElement("div");
    tools.className = "novel-catalog-tools";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "搜索章节名或章数";
    search.setAttribute("aria-label", "搜索章节");
    if (options.compact) search.dataset.readerFocus = "catalog-search";
    search.value = state.novel.catalogQuery || "";
    const order = document.createElement("button");
    order.type = "button";
    order.className = "novel-catalog-order";
    const status = document.createElement("span");
    status.className = "novel-catalog-status";
    const list = document.createElement("div");
    list.className = options.compact ? "novel-reader-catalog-list" : "novel-catalog-grid";
    const pagination = document.createElement("div");
    pagination.className = "novel-catalog-pagination";
    pagination.setAttribute("aria-label", "章节目录分页");
    const previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = "上一页";
    previous.setAttribute("aria-label", "上一页目录");
    const pageInput = document.createElement("input");
    pageInput.type = "number";
    pageInput.min = "1";
    pageInput.step = "1";
    pageInput.setAttribute("aria-label", "目录页码");
    const pageCountLabel = document.createElement("span");
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "下一页";
    next.setAttribute("aria-label", "下一页目录");
    const locate = document.createElement("button");
    locate.type = "button";
    locate.className = "novel-catalog-locate";
    locate.textContent = state.novel.chapter ? "当前章节" : "阅读进度";
    const anchorIndex = Number(state.novel.chapter?.index || state.novel.book?.progress?.chapterIndex || 0);
    const sourceAnchor = source.findIndex(chapter => Number(chapter.index) === anchorIndex);
    locate.hidden = sourceAnchor < 0;
    pagination.hidden = source.length <= NOVEL_CATALOG_PAGE_SIZE;
    pagination.append(previous, pageInput, pageCountLabel, next, locate);
    let searchIndex = null;
    if (options.compact && !state.novel.catalogQuery && sourceAnchor >= 0) {
      const anchorPosition = state.novel.catalogDescending ? source.length - sourceAnchor - 1 : sourceAnchor;
      state.novel.catalogPage = Math.floor(anchorPosition / NOVEL_CATALOG_PAGE_SIZE);
    }

    function refresh({ locateCurrent = false } = {}) {
      const query = String(state.novel.catalogQuery || "").trim().toLocaleLowerCase("zh-Hans-CN");
      const visible = query
        ? (searchIndex ||= source.map(chapter => ({ chapter, title: String(chapter.title || "").toLocaleLowerCase("zh-Hans-CN"), index: String(chapter.index || "") })))
          .filter(entry => entry.title.includes(query) || entry.index.includes(query)).map(entry => entry.chapter)
        : [...source];
      if (state.novel.catalogDescending) visible.reverse();
      const filteredTotal = visible.length;
      const pageCount = Math.max(1, Math.ceil(filteredTotal / NOVEL_CATALOG_PAGE_SIZE));
      if (locateCurrent) {
        const position = visible.findIndex(chapter => Number(chapter.index) === anchorIndex);
        state.novel.catalogPage = Math.floor(Math.max(0, position) / NOVEL_CATALOG_PAGE_SIZE);
      }
      state.novel.catalogPage = Math.min(pageCount - 1, Math.max(0, Math.floor(Number(state.novel.catalogPage) || 0)));
      const offset = state.novel.catalogPage * NOVEL_CATALOG_PAGE_SIZE;
      const pageChapters = visible.slice(offset, offset + NOVEL_CATALOG_PAGE_SIZE);
      pageInput.value = String(state.novel.catalogPage + 1);
      pageInput.max = String(pageCount);
      pageInput.disabled = pageCount <= 1;
      pageCountLabel.textContent = `/ ${formatNumber(pageCount)} 页`;
      previous.disabled = state.novel.catalogPage <= 0;
      next.disabled = state.novel.catalogPage >= pageCount - 1;

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
      for (const chapter of pageChapters) list.append(chapterButton(chapter, Boolean(options.compact)));
      if (!visible.length) {
        const empty = document.createElement("div");
        empty.className = "novel-catalog-empty";
        empty.textContent = "没有匹配的章节";
        list.append(empty);
      }
    }

    let composing = false;
    function isCurrentCatalogBrowser() {
      return shell.isConnected && state.activeView === "novels" && owner === navigationId && sameBookSnapshot(book, state.novel.book);
    }
    function applySearch() {
      if (!isCurrentCatalogBrowser()) return;
      if (state.novel.catalogQuery === search.value) return;
      state.novel.catalogQuery = search.value;
      state.novel.catalogPage = 0;
      refresh();
    }
    search.addEventListener("compositionstart", () => { composing = true; });
    search.addEventListener("compositionend", () => { composing = false; applySearch(); });
    search.addEventListener("input", event => {
      if (composing || event.isComposing) return;
      applySearch();
    });
    search.addEventListener("keydown", event => {
      if (composing || event.isComposing || event.keyCode === 229) event.stopPropagation();
    });
    order.addEventListener("click", () => {
      state.novel.catalogDescending = !state.novel.catalogDescending;
      state.novel.catalogPage = 0;
      refresh();
    });
    const changePage = (page) => {
      state.novel.catalogPage = Number.isFinite(page) ? page : 0;
      refresh();
      if (document.activeElement?.disabled) pageInput.focus({ preventScroll: true });
    };
    previous.addEventListener("click", () => changePage(state.novel.catalogPage - 1));
    next.addEventListener("click", () => changePage(state.novel.catalogPage + 1));
    pageInput.addEventListener("change", () => changePage(Number(pageInput.value) - 1));
    pageInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      changePage(Number(pageInput.value) - 1);
    });
    locate.addEventListener("click", () => {
      search.value = "";
      state.novel.catalogQuery = "";
      refresh({ locateCurrent: true });
      const current = list.querySelector(`[data-chapter-index="${anchorIndex}"]`);
      current?.focus({ preventScroll: true });
      current?.scrollIntoView({ block: "nearest" });
    });

    tools.append(search, order, status, pagination);
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
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "阅读设置");
    const title = document.createElement("strong");
    title.textContent = "阅读设置";
    panel.append(title);
    panel.append(settingRow("章节位置", readerPositionControl()));
    panel.append(novelBookmarksControl(state.novel.book, state.novel.chapter));
    if (readerFullscreen.state().supported) panel.append(readerFullscreenControl());
    panel.append(settingRow("主题", themeButtons()));
    panel.append(settingRow("字体", fontButtons()));
    panel.append(settingRow("字号", stepper("fontSize", 16, 30, 1, `${state.novel.settings.fontSize}px`)));
    panel.append(settingRow("行距", stepper("lineHeight", 1.5, 2.4, 0.1, state.novel.settings.lineHeight.toFixed(1))));
    panel.append(settingRow("宽度", stepper("width", 760, 1080, 20, `${state.novel.settings.width}px`)));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "novel-secondary-button";
    close.textContent = "完成";
    close.dataset.readerFocus = "settings-close";
    close.addEventListener("click", () => toggleSettings(false));
    panel.append(close);
    return panel;
  }

  function readerFullscreenControl() {
    const wrap = document.createElement("div");
    wrap.className = "novel-reader-fullscreen";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "novel-secondary-button";
    button.dataset.readerFocus = "fullscreen-toggle";
    const owner = navigationId, book = state.novel.book, chapterId = state.novel.chapter?.id;
    button.addEventListener("click", () => {
      if (button.isConnected && state.activeView === "novels" && owner === navigationId && !navigationController
          && !state.novel.loading && sameBookSnapshot(book, state.novel.book) && chapterId === state.novel.chapter?.id) readerFullscreen.toggle();
    });
    const message = document.createElement("span");
    message.setAttribute("role", "status");
    wrap.append(button, message);
    updateReaderFullscreenControl(wrap);
    return wrap;
  }

  function novelBookmarksControl(book, chapter = null) {
    const owner = navigationId;
    const isCurrent = () => state.activeView === "novels" && owner === navigationId && !state.novel.loading && !navigationController
      && sameBookSnapshot(book, state.novel.book) && (chapter ? chapter.id === state.novel.chapter?.id : !state.novel.chapter);
    return createNovelBookmarksPanel({ book, chapter, isCurrent, getRatio: currentReaderRatio,
      openBookmark: (mark, focused) => {
        if (!isCurrent() || mark.catalogRevision !== book.catalogRevision) return false;
        if (mark.chapterId === state.novel.chapter?.id) {
          state.novel.pendingScrollRatio = mark.ratio;
          restoreReaderScroll({ saveProgress: true });
          return true;
        }
        return openChapter(book.id, mark.chapterIndex, { restoreProgress: false,
          bookmark: { ...mark, id: book.id, sourceRealm: book.sourceRealm },
          retryFocus: focused, retryFocusRevision: readerFocusRevision });
      }
    });
  }

  function updateReaderFullscreenControl(scope = els.workGrid) {
    const control = scope?.matches?.(".novel-reader-fullscreen") ? scope : scope?.querySelector(".novel-reader-fullscreen");
    if (!control) return;
    const { available, active, pending, error } = readerFullscreen.state();
    control.hidden = !available;
    const button = control.querySelector("button");
    button.textContent = active ? "退出全屏" : "全屏阅读";
    button.setAttribute("aria-busy", String(pending));
    button.setAttribute("aria-disabled", String(pending));
    control.querySelector('[role="status"]').textContent = error || "全屏时仍可翻章；按 Esc 可退出。";
  }

  function readerPositionControl() {
    const owner = navigationId;
    const book = state.novel.book;
    const chapterId = state.novel.chapter?.id;
    const form = document.createElement("form");
    form.className = "novel-reader-position";
    form.noValidate = true;
    const row = document.createElement("div");
    row.className = "novel-reader-position-controls";
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "100";
    input.step = "0.1";
    input.inputMode = "decimal";
    const ratio = document.querySelector(".novel-reader-page") ? currentReaderRatio() : clampRatio(state.novel.pendingScrollRatio);
    input.value = String(Math.round(ratio * 100000) / 1000);
    input.setAttribute("aria-label", "章节阅读百分比");
    input.dataset.readerFocus = "position-percent";
    const unit = document.createElement("span");
    unit.textContent = "%";
    unit.setAttribute("aria-hidden", "true");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "前往";
    submit.setAttribute("aria-label", "跳转到章节百分比");
    submit.dataset.readerFocus = "position-submit";
    row.append(input, unit, submit);
    const message = document.createElement("span");
    message.className = "novel-reader-position-hint";
    message.id = "novelReaderPositionHint";
    input.setAttribute("aria-describedby", message.id);
    message.setAttribute("role", "status");
    const hint = "输入 0–100，支持小数；按 Enter 或点前往。";
    message.textContent = hint;
    form.append(row, message);
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (!form.isConnected || els.workGrid.querySelector(".novel-reader-position") !== form
          || state.activeView !== "novels" || !state.novel.settingsOpen || state.novel.loading || navigationController
          || owner !== navigationId || !sameBookSnapshot(book, state.novel.book) || chapterId !== state.novel.chapter?.id) return;
      const percent = input.valueAsNumber;
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
        input.setAttribute("aria-invalid", "true");
        message.classList.add("error");
        message.textContent = "请输入 0–100 之间的阅读百分比。";
        return;
      }
      input.removeAttribute("aria-invalid");
      message.classList.remove("error");
      message.textContent = hint;
      input.value = String(percent);
      state.novel.pendingScrollRatio = percent / 100;
      restoreReaderScroll({ saveProgress: true });
    });
    return form;
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
      button.dataset.readerFocus = `theme-${value}`;
      button.setAttribute("aria-pressed", String(state.novel.settings.theme === value && !state.novel.settings.night));
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
      button.dataset.readerFocus = `font-${value}`;
      button.setAttribute("aria-pressed", String(state.novel.settings.font === value));
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
    const settingName = { fontSize: "字号", lineHeight: "行距", width: "宽度" }[key] || key;
    minus.setAttribute("aria-label", `减小${settingName}`);
    minus.dataset.readerFocus = `${key}-minus`;
    minus.disabled = Number(state.novel.settings[key]) <= min;
    const value = document.createElement("span");
    value.textContent = label;
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.setAttribute("aria-label", `增大${settingName}`);
    plus.dataset.readerFocus = `${key}-plus`;
    plus.disabled = Number(state.novel.settings[key]) >= max;
    minus.addEventListener("click", () => updateSettings({ [key]: Math.max(min, Number(state.novel.settings[key]) - step) }));
    plus.addEventListener("click", () => updateSettings({ [key]: Math.min(max, Number(state.novel.settings[key]) + step) }));
    wrap.append(minus, value, plus);
    return wrap;
  }

  function chapterButton(chapter, compact) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `novel-chapter-button${compact ? " compact" : ""}${state.novel.chapter?.index === chapter.index ? " active" : ""}`;
    button.dataset.chapterIndex = String(chapter.index);
    if (state.novel.chapter?.index === chapter.index) button.setAttribute("aria-current", "page");
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
    cover.setAttribute("aria-hidden", "true");
    const hash = Array.from(String(book.id || book.title || "")).reduce((value, char) => (value * 31 + char.codePointAt(0)) >>> 0, 0);
    cover.dataset.tone = String(hash % 5);
    const short = document.createElement("span");
    short.textContent = "藏书";
    const title = document.createElement("strong");
    title.textContent = book.title;
    cover.append(short, title);
    return cover;
  }

  function displayNovelCategory(value) {
    return String(value || "").replace(/^[\[【](.*)[\]】]$/, "$1");
  }

  function retryLibraryRead(options) {
    const context = libraryReturnContext;
    if (context?.retry && !options.append && state.novel.libraryError && !state.novel.book && !state.novel.chapter
        && context.retry.revision === novelMenuRevision && state.novel.page === context.page
        && ["mode", "query", "category", "sort", "author"].every(key => state.novel[key] === context[key])) {
      return returnToLibrary(context, context.retry.options);
    }
    return loadNovels(options);
  }

  function clearLibraryReturn() {
    libraryReturnRestore?.abort();
    libraryReturnRestore = null;
    libraryReturnContext = null;
  }

  function invalidateLibraryReturnData() {
    libraryMutationRevision += 1;
    for (const data of [state.novel.data, libraryReturnContext?.data]) {
      if (data && typeof data === "object") invalidLibraryReturnData.add(data);
    }
  }

  function captureLibraryReturn(bookId) {
    libraryReturnRestore?.abort();
    const home = els.workGrid?.querySelector(".novel-home");
    const data = state.novel.data;
    if (state.novel.book || state.novel.chapter || !home || !data?.books?.length
        || !["books", "author", "mine", "rankings"].includes(state.novel.mode)) {
      if (libraryReturnContext?.bookId !== String(bookId)) libraryReturnContext = null;
      return;
    }
    const index = data.books.findIndex(book => String(book.id) === String(bookId));
    const book = data.books[index] || state.novel.summary?.recent?.find(book => String(book.id) === String(bookId));
    const key = book ? novelBookKey(book, data.sourceRealm) : "";
    const entries = [...home.querySelectorAll("[data-novel-book-key]")];
    const entry = entries.find(entry => entry.dataset.novelBookKey === key);
    const active = document.activeElement;
    const resume = home.querySelector(".novel-resume")?.contains(active) || false;
    const anchor = resume ? home.querySelector(".novel-resume") : entry;
    const opening = currentPendingBookList();
    libraryReturnContext = {
      bookId: String(bookId), data, summary: state.novel.summary, hasMore: state.novel.hasMore,
      query: state.novel.query, category: state.novel.category, sort: state.novel.sort,
      mode: state.novel.mode, author: state.novel.author, page: state.novel.page,
      status: opening?.sourceStatus ?? state.novel.status, libraryError: state.novel.libraryError, libraryErrorAppend: state.novel.libraryErrorAppend,
      invalid: Boolean(state.novel.loading && !opening) || invalidLibraryReturnData.has(data),
      bookSnapshot: book?.catalogRevision ? { id: book.id, sourceRealm: book.sourceRealm || data.sourceRealm, catalogRevision: book.catalogRevision } : null,
      anchor: {
        key, index: Math.max(0, index), resume, top: anchor?.getBoundingClientRect().top || 0,
        focus: Boolean(anchor?.contains(active)), focusClass: active !== anchor ? active?.classList?.[0] || "" : ""
      }
    };
  }

  function noteLibraryReturnBook(book) {
    if (libraryReturnContext?.bookId === String(book?.id) && !libraryReturnContext.bookSnapshot) {
      libraryReturnContext.bookSnapshot = { id: book.id, sourceRealm: book.sourceRealm, catalogRevision: book.catalogRevision };
    }
  }

  async function returnToLibrary(context, options = {}) {
    if (!context || context !== libraryReturnContext || state.activeView !== "novels") return false;
    const owner = navigationId;
    await readerFullscreen.leave();
    if (context !== libraryReturnContext || state.activeView !== "novels" || owner !== navigationId) return false;
    const retry = Boolean(context.retry);
    flushProgress();
    const currentBook = state.novel.book;
    const unopenedSource = !currentBook && currentBookRecovery()?.bookId === context.bookId;
    const cached = !options.removedBookId && !context.invalid && !invalidLibraryReturnData.has(context.data) && !["mine", "rankings"].includes(context.mode)
      && state.novel.data === context.data && (unopenedSource || !context.bookSnapshot || sameBookSnapshot(context.bookSnapshot, currentBook));
    if (cached) {
      const entry = context.data.books.find(book => String(book.id) === context.bookId);
      if (entry && currentBook) Object.assign(entry, { progress: currentBook.progress || null, progressRecovery: currentBook.progressRecovery || null });
    }
    clearLibraryReturn();
    resetReader();
    const revision = retry ? novelMenuRevision : ++novelMenuRevision;
    for (const key of ["mode", "query", "category", "sort", "author", "page"]) state.novel[key] = context[key];
    state.novel.book = null;
    state.novel.chapter = null;
    state.novel.chapters = [];
    state.novel.data = cached ? context.data : null;
    state.novel.summary = context.summary;
    state.novel.hasMore = cached ? context.hasMore : false;
    state.novel.status = cached ? context.status : "";
    state.novel.libraryError = cached ? context.libraryError : "";
    state.novel.libraryErrorAppend = cached ? context.libraryErrorAppend : null;
    let expectedPage = context.page;
    const matchesConditions = () => state.activeView === "novels" && revision === novelMenuRevision
      && !state.novel.book && !state.novel.chapter && !state.novel.loading
      && ["mode", "query", "category", "sort", "author"].every(key => state.novel[key] === context[key]);
    const isCurrent = () => matchesConditions() && state.novel.page === expectedPage;
    const restore = createNovelListReturnRestore({
      grid: els.workGrid, anchor: context.anchor, isCurrent,
      onFinish: () => { if (libraryReturnRestore === restore) libraryReturnRestore = null; }
    });
    libraryReturnRestore = restore;
    if (!retry) pushRoute({ view: "novels", novelBookId: "", novelChapterIndex: "", novelMode: context.mode,
      novelQuery: context.query, novelCategory: context.category, novelSort: context.sort,
      novelAuthor: context.author, novelPage: context.page });
    try {
      if (cached) { renderStats(); renderView(); }
      else {
        const result = await loadNovels({ skipRoute: true, restoreCount: Math.max(context.data.books.length, novelNextOffset(context.data, 0)) });
        if (result === false || !matchesConditions()) { restore.abort(); return false; }
        expectedPage = state.novel.page;
      }
      if (!isCurrent()) { restore.abort(); return false; }
      if (options.status) { state.novel.status = options.status; renderView(); }
      restore.restore();
      return true;
    } catch {
      restore.abort();
      if (matchesConditions()) {
        context.invalid = true;
        context.page = state.novel.page;
        context.retry = { revision, options };
        libraryReturnContext = context;
      }
      return false;
    }
  }

  function renderBreadcrumbs(items, bookId = state.novel.book?.id) {
    const nav = document.createElement("nav");
    nav.className = "novel-breadcrumbs";
    if (libraryReturnContext?.bookId === String(bookId)) {
      const context = libraryReturnContext;
      const owner = navigationId;
      const back = document.createElement("button");
      back.type = "button";
      back.className = "novel-list-return";
      back.textContent = "← 返回列表";
      back.setAttribute("aria-label", "返回列表");
      back.addEventListener("click", () => {
        if (back.isConnected && state.activeView === "novels" && owner === navigationId && context === libraryReturnContext) returnToLibrary(context);
      });
      nav.append(back);
    }
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

  function currentUploadJob() {
    try {
      const account = captureWebAccount();
      return uploadJob && account.owner === uploadJob.account.owner && account.revision === uploadJob.account.revision ? uploadJob : null;
    } catch { return null; }
  }

  function updateUploadView() {
    if (state.activeView !== "novels" || state.novel.mode !== "manage" || state.novel.manageSection !== "upload" || state.novel.book || state.novel.chapter) return;
    const job = currentUploadJob(), status = els.workGrid.querySelector(".novel-upload-status");
    if (status) { status.textContent = uploadStatus(); status.hidden = !status.textContent; }
    for (const button of els.workGrid.querySelectorAll("[data-novel-upload]")) {
      button.disabled = Boolean(job?.running);
      if (button.dataset.novelUpload === "picker") button.textContent = job?.running ? "正在上传" : "选择 TXT 文件";
    }
  }

  function uploadStatus() {
    const job = currentUploadJob();
    return job ? job.status + (job.summaryError || "") : state.novel.status;
  }

  function updateUploadSummary(summary) {
    state.novel.summary = summary;
    if (state.novel.data) state.novel.data.summary = summary;
    const totals = summary.totals || {};
    const values = { books: formatNumber(totals.books || 0), chapters: formatNumber(totals.chapters || 0), chars: formatNumber(totals.chars || 0),
      library: `${formatNumber(totals.books || 0)} 本 · ${formatNumber(totals.chapters || 0)} 章`,
      scannedAt: summary.scannedAt ? `更新 ${formatDateTime(summary.scannedAt)}` : "尚未扫描",
      latestScan: summary.scannedAt ? formatDateTime(summary.scannedAt) : "暂无记录" };
    for (const element of els.workGrid.querySelectorAll("[data-novel-upload-metric]")) element.textContent = values[element.dataset.novelUploadMetric];
    renderStats();
  }

  async function refreshUploadSummary(job) {
    const navigation = navigationId, menu = novelMenuRevision, confirmed = job.confirmed;
    job.summaryController?.abort();
    const controller = new AbortController();
    job.summaryController = controller;
    const isCurrentSummary = () => currentUploadJob() === job && job.summaryController === controller && !controller.signal.aborted
      && navigation === navigationId && menu === novelMenuRevision && state.activeView === "novels"
      && state.novel.mode === "manage" && state.novel.manageSection === "upload" && !state.novel.book && !state.novel.chapter;
    try {
      const summary = await api("/api/novels/summary", { signal: controller.signal });
      if (!isCurrentSummary()) return;
      if (confirmed !== job.confirmed) return refreshUploadSummary(job);
      updateUploadSummary(summary);
      if (confirmed === job.confirmed) job.summaryDirty = false;
      job.summaryError = "";
    } catch (error) {
      if (isCurrentSummary()) job.summaryError = `；书库统计暂未更新：${error.message || error}`;
    } finally { if (job.summaryController === controller) job.summaryController = null; }
  }

  async function uploadNovelFiles(files) {
    ensureState();
    if (currentUploadJob()?.running) return;
    const txtFiles = files.filter((file) => file && (/\.txt$/i.test(file.name) || String(file.type || "").startsWith("text/")));
    if (!txtFiles.length) return;
    let account;
    try { account = captureWebAccount(); } catch { return; }
    const job = { account, navigation: navigationId, menu: novelMenuRevision, running: true, confirmed: 0, summaryDirty: false,
      status: `正在上传 ${formatNumber(txtFiles.length)} 本小说` };
    uploadJob = job;
    const isCurrentUpload = () => currentUploadJob() === job;
    const ownsSummary = () => isCurrentUpload() && job.navigation === navigationId && job.menu === novelMenuRevision
      && state.activeView === "novels" && state.novel.mode === "manage" && state.novel.manageSection === "upload" && !state.novel.book && !state.novel.chapter;
    state.novel.uploading = true;
    updateUploadView();
    let uploaded = 0;
    let failed = 0;
    const failures = [];
    try {
      for (const file of txtFiles) {
        try {
          if (!isCurrentUpload()) return;
          const decoded = await readNovelFileText(file);
          if (!isCurrentUpload()) return;
          const result = await api("/api/novels/upload", {
            method: "POST",
            body: {
              fileName: file.name,
              sizeBytes: file.size,
              encoding: decoded.encoding,
              text: decoded.text
            }
          });
          if (!isCurrentUpload()) return;
          invalidateLibraryReturnData();
          job.confirmed += 1;
          job.summaryDirty = true;
          uploaded += 1;
          job.status = `已上传 ${formatNumber(uploaded)}/${formatNumber(txtFiles.length)}：${result.book?.title || file.name}`;
        } catch (error) {
          if (!isCurrentUpload()) return;
          failed += 1;
          const message = `${file.name}：${error.message || error}`;
          if (failures.length < 3) failures.push(message);
          job.status = `上传失败：${message}`;
        }
        updateUploadView();
      }
      if (ownsSummary()) {
        await refreshUploadSummary(job);
      }
      if (!isCurrentUpload()) return;
      job.status = failed
        ? `已上传 ${formatNumber(uploaded)} 本，失败 ${formatNumber(failed)} 本：${failures.join("；")}${failed > failures.length ? `（另 ${formatNumber(failed - failures.length)} 本失败）` : ""}`
        : `已上传 ${formatNumber(uploaded)} 本小说`;
    } finally {
      job.running = false;
      if (uploadJob === job) { state.novel.uploading = false; updateUploadView(); }
    }
  }

  function showHome() {
    ensureState();
    clearLibraryReturn();
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
    if (needsCatalog) {
      // The catalog loader renders its loading state before the first await.
      loadReaderCatalog().catch(() => {});
    } else {
      state.novel.pendingScrollRatio = ratio;
      if (!updateReaderPanels()) renderView();
      restoreReaderScroll();
    }
    focusReaderControl(opening ? state.novel.catalogLoading ? "catalog-close" : "catalog-search" : "toolbar-目录");
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
    const book = state.novel.book;
    const bookId = String(state.novel.book?.id || "");
    if (!bookId) return;
    const owner = navigationId;
    const requestId = ++catalogRequestId;
    catalogController?.abort();
    const controller = new AbortController();
    catalogController = controller;
    const isCurrent = () => state.activeView === "novels" && owner === navigationId
      && requestId === catalogRequestId && catalogController === controller && !controller.signal.aborted
      && sameBookSnapshot(book, state.novel.book) && (!options.navigation || isCurrentNavigation(options.navigation));
    const params = new URLSearchParams({
      all: "1",
      order: "asc"
    });
    if (book?.sourceRealm) params.set("sourceRealm", book.sourceRealm);
    if (book?.catalogRevision) params.set("catalogRevision", book.catalogRevision);
    const ratio = state.novel.chapter ? currentReaderRatio() : 0;
    const detailScrollY = state.novel.chapter ? 0 : window.scrollY;
    const renderDetail = options.render !== false && Boolean(state.novel.book) && !state.novel.chapter;
    state.novel.catalogLoading = true;
    state.novel.catalogError = "";
    if (state.novel.catalogOpen) {
      state.novel.pendingScrollRatio = ratio;
      if (!updateReaderPanels()) renderView();
      restoreReaderScroll();
    } else if (renderDetail) {
      if (!updateCurrentBookDetailCatalog(owner, book)) renderView();
      restoreDetailScroll(detailScrollY, owner, book);
    }
    try {
      const data = await api(`/api/novels/${encodeURIComponent(bookId)}/catalog?${params}`, { signal: controller.signal });
      if (!isCurrent()) return;
      if ((book.catalogRevision && data.catalogRevision !== book.catalogRevision) || (book.sourceRealm && data.sourceRealm !== book.sourceRealm)) throw new Error("目录版本已变化，请重新打开书籍");
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
      if (!isCurrent()) return;
      state.novel.catalogError = error.message || "章节目录读取失败";
    } finally {
      if (!isCurrent()) return;
      catalogController = null;
      state.novel.catalogLoading = false;
      if (state.novel.catalogOpen) {
        const ratio = currentReaderRatio();
        state.novel.pendingScrollRatio = ratio;
        if (!updateReaderPanels()) renderView();
        restoreReaderScroll();
      } else if (renderDetail) {
        const currentDetailScrollY = window.scrollY;
        if (!updateCurrentBookDetailCatalog(owner, book)) renderView();
        restoreDetailScroll(currentDetailScrollY, owner, book);
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
    if (!updateReaderPanels()) renderView();
    restoreReaderScroll();
    focusReaderControl(state.novel.settingsOpen ? `theme-${state.novel.settings.theme}` : "toolbar-设置");
  }

  function focusReaderControl(key) {
    const control = Array.from(document.querySelectorAll("[data-reader-focus]")).find((item) => item.dataset.readerFocus === key);
    if (control?.disabled) control.parentElement?.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
    else control?.focus({ preventScroll: true });
  }

  function updateSettings(patch) {
    const ratio = state.novel.chapter ? currentReaderRatio() : 0;
    state.novel.settings = normalizeSettings({ ...state.novel.settings, ...patch });
    writeSettings(state.novel.settings);
    setReaderBodyClass();
    state.novel.pendingScrollRatio = ratio;
    const page = state.novel.chapter && els.workGrid?.querySelector(".novel-reader-page");
    if (page) {
      // Settings only change appearance and controls; keep long chapter text mounted.
      applyReaderAppearance(page);
      updateReaderSettingsControls(page);
      syncProgressSaveFeedback();
    } else {
      renderView();
    }
    restoreReaderScroll();
  }

  function currentReaderRatio() {
    if (pendingScrollRestore && pendingScrollRestore.navigation === navigationId
        && sameBookSnapshot(pendingScrollRestore.book, state.novel.book)
        && pendingScrollRestore.chapterId === state.novel.chapter?.id) return pendingScrollRestore.ratio;
    const page = document.querySelector(".novel-reader-page");
    if (!page) return 0;
    const top = page.getBoundingClientRect().top + window.scrollY;
    const readable = Math.max(1, page.scrollHeight - window.innerHeight);
    return clampRatio((window.scrollY - top) / readable);
  }

  function restoreDetailScroll(top, owner, book) {
    const detail = document.querySelector(".novel-detail");
    const inputRevision = scrollInputRevision;
    window.requestAnimationFrame(() => {
      if (state.activeView !== "novels" || owner !== navigationId || state.novel.chapter
          || inputRevision !== scrollInputRevision || !sameBookSnapshot(book, state.novel.book)
          || !detail || detail !== document.querySelector(".novel-detail")) return;
      window.scrollTo({ top, left: 0, behavior: "auto" });
    });
  }

  function restoreReaderScroll(options = {}) {
    const ratio = Math.max(0, Math.min(1, Number(state.novel.pendingScrollRatio || 0)));
    const saveAfterRestore = Boolean(options.saveProgress || pendingScrollRestore?.saveProgress);
    state.novel.pendingScrollRatio = 0;
    cancelReaderScroll();
    const owner = { navigation: navigationId, revision: readerScrollRevision, book: state.novel.book, ratio, saveProgress: saveAfterRestore,
      chapterId: state.novel.chapter?.id, page: document.querySelector(".novel-reader-page") };
    pendingScrollRestore = owner;
    readerScrollFrame = window.requestAnimationFrame(() => {
      if (pendingScrollRestore !== owner) return;
      readerScrollFrame = null;
      if (owner.navigation !== navigationId || owner.revision !== readerScrollRevision
          || state.activeView !== "novels" || state.novel.loading || !sameBookSnapshot(owner.book, state.novel.book)
          || owner.chapterId !== state.novel.chapter?.id) { pendingScrollRestore = null; return; }
      const page = document.querySelector(".novel-reader-page");
      if (!page) { pendingScrollRestore = null; return; }
      if (page !== owner.page) {
        state.novel.pendingScrollRatio = ratio;
        restoreReaderScroll({ saveProgress: saveAfterRestore });
        return;
      }
      pendingScrollRestore = null;
      if (ratio === 0) {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      } else {
        const top = page.getBoundingClientRect().top + window.scrollY;
        const readable = Math.max(0, page.scrollHeight - window.innerHeight);
        window.scrollTo({ top: top + readable * ratio, left: 0, behavior: "auto" });
      }
      if (saveAfterRestore) scheduleProgressSave(120);
    });
  }

  function installScrollProgress() {
    if (scrollListenerInstalled) return;
    scrollListenerInstalled = true;
    window.addEventListener(
      "scroll",
      () => {
        if (state.activeView !== "novels" || state.novel?.loading || navigationController
            || !state.novel?.book || !state.novel?.chapter) return;
        scheduleProgressSave(500);
      },
      { passive: true }
    );
    const cancelRestoreForInput = (event) => {
      if (event.type === "keydown" && !["PageUp", "PageDown", "Home", "End", " ", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, select, textarea, button, a")) return;
      if (state.activeView !== "novels") return;
      scrollInputRevision += 1;
      if (!pendingScrollRestore) return;
      cancelReaderScroll();
      scheduleProgressSave();
    };
    window.addEventListener("wheel", cancelRestoreForInput, { passive: true });
    window.addEventListener("touchstart", cancelRestoreForInput, { passive: true });
    window.addEventListener("keydown", cancelRestoreForInput);
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
      // Also flush books left earlier, even when the current view has no reader.
      if (saveProgress({ keepalive: true }) !== true) progressWriter.flushKeepalive();
    });
    window.addEventListener("pageshow", () => progressWriter.resume());
  }

  function scheduleProgressSave(delay = 500) {
    window.clearTimeout(progressTimer);
    const owner = navigationId;
    const book = state.novel.book;
    const chapterId = state.novel.chapter?.id;
    const page = document.querySelector(".novel-reader-page");
    progressTimer = window.setTimeout(() => {
      progressTimer = null;
      if (state.activeView !== "novels" || state.novel.loading || navigationController || owner !== navigationId
          || !sameBookSnapshot(book, state.novel.book) || chapterId !== state.novel.chapter?.id
          || !page || page !== document.querySelector(".novel-reader-page")) return;
      saveProgress();
    }, delay);
  }

  function flushProgress() {
    window.clearTimeout(progressTimer);
    progressTimer = null;
    if (!state.novel?.book || !state.novel?.chapter) return;
    saveProgress();
  }

  function saveProgress(options = {}) {
    const book = state.novel?.book;
    const chapter = state.novel?.chapter;
    if (state.activeView !== "novels" || state.novel?.loading || navigationController || !book || !chapter
        || !document.querySelector(".novel-reader-page")) return;
    if (!options.confirmRecovery && pendingScrollRestore) return;
    if (book.progressRecovery && !options.confirmRecovery) return;
    if (options.confirmRecovery && hasPendingRecoveryWrite(book, chapter)) return;
    let account;
    try { account = captureWebAccount(); } catch { return; }
    const recoveryKey = options.confirmRecovery ? JSON.stringify([book.id, book.sourceRealm, book.catalogRevision, chapter.id]) : "";
    const ratio = currentReaderRatio();
    const revision = ++progressRevision;
    const progress = {
      chapterId: chapter.id,
      catalogRevision: book.catalogRevision,
      chapterIndex: Number(chapter.index),
      scrollRatio: ratio,
      updatedAt: new Date().toISOString()
    };
    if (!book.progressRecovery) state.novel.book = { ...book, progress };
    const body = { chapterIndex: chapter.index, scrollRatio: ratio,
      ...(book.sourceRealm ? { sourceRealm: book.sourceRealm } : {}),
      ...(book.catalogRevision ? { catalogRevision: book.catalogRevision, chapterId: chapter.id } : {}) };
    const record = { bookId: book.id, sourceRealm: book.sourceRealm, catalogRevision: book.catalogRevision,
      chapterId: chapter.id, owner: navigationId, revision, recoveryKey, body,
      accountOwner: account.owner, accountRevision: account.revision };
    const session = progressSessions.get(book.sourceRealm);
    if (session && book.catalogRevision) {
      body.progressSessionId = session.id;
      body.progressSessionStartedAt = session.startedAt;
      body.progressSequence = ++session.sequence;
    } else if (progressClockSupported) {
      const error = new Error("阅读进度会话暂忙，请重新打开页面后保存");
      if (options.confirmRecovery) setReaderNavigationStatus(error.message, "error");
      else showProgressSaveFailure(record, error);
      return options.confirmRecovery ? Promise.resolve(false) : undefined;
    }
    const failure = currentProgressSaveFailure();
    if (failure && !options.confirmRecovery) {
      failure.pendingRevision = revision;
      syncProgressSaveFeedback();
    }
    if (options.keepalive) {
      progressWriter.flushKeepalive(record);
      return true;
    }
    if (!options.confirmRecovery) {
      progressWriter.save(record);
      return;
    }
    recoveryWrites.set(recoveryKey, revision);
    return progressWriter.save(record, { explicit: true })
      .then(data => validProgressReceipt(record, data) && isCurrentProgress(record))
      .catch(() => false);
  }

  function matchesProgressReader(record) {
    const book = state.novel?.book;
    return state.activeView === "novels" && String(book?.id || "") === String(record.bookId)
      && book?.sourceRealm === record.sourceRealm && book?.catalogRevision === record.catalogRevision
      && state.novel.chapter?.id === record.chapterId;
  }

  function isCurrentProgress(record) {
    return record.owner === navigationId && record.revision === progressRevision && matchesProgressReader(record) && progressAccountCurrent(record);
  }

  function progressAccountCurrent(record) {
    try {
      const account = captureWebAccount();
      return account.owner === record.accountOwner && account.revision === record.accountRevision;
    } catch { return false; }
  }

  function validProgressReceipt(record, data) {
    return Boolean(data?.progress && data.progress.applied !== false
      && (!record.catalogRevision || (data.progress.catalogRevision === record.catalogRevision && data.progress.chapterId === record.chapterId)));
  }

  function applyProgressReceipt(record, data) {
    if (isCurrentProgress(record) && validProgressReceipt(record, data)) {
      confirmedProgressRevision = Math.max(confirmedProgressRevision, record.revision);
      state.novel.book = { ...state.novel.book, progress: data.progress, progressRecovery: null };
      const failure = currentProgressSaveFailure();
      if (failure && record.revision >= failure.record.revision) clearProgressSaveFailure({ restoreFocus: true });
    }
  }

  function finishProgressWrite(record) {
    if (progressSaveFailure?.pendingRevision === record.revision) {
      progressSaveFailure.pendingRevision = 0;
      syncProgressSaveFeedback();
    }
    if (!record.explicit || recoveryWrites.get(record.recoveryKey) !== record.revision) return;
    recoveryWrites.delete(record.recoveryKey);
    if (matchesProgressReader(record)) {
      document.querySelectorAll(".novel-progress-recovery-confirm").forEach(button => {
        button.disabled = hasPendingRecoveryWrite(state.novel.book, state.novel.chapter);
      });
    }
  }

  function noteProgressClock(data) {
    const clock = data?.serverClockMs;
    progressClockSupported = Number.isSafeInteger(clock) && clock >= 0;
    if (!progressClockSupported || !data.book?.sourceRealm) return;
    const realm = data.book.sourceRealm;
    const previous = progressSessions.get(realm);
    if (previous && clock < previous.startedAt + 24 * 60 * 60 * 1000) return;
    if (!previous && progressSessions.size >= 32) return;
    // Server time avoids device wall-clock skew. Renew only after a fresh read
    // proves the old session expired; old queued records keep their old identity.
    progressSessions.set(realm, { id: newProgressSessionId(), startedAt: clock, sequence: 0 });
  }

  function refreshProgressSession(record) {
    if (progressClockRefresh) return;
    const refresh = { controller: new AbortController() };
    progressClockRefresh = refresh;
    void api(`/api/novels/${encodeURIComponent(record.bookId)}?catalog=0`, { signal: refresh.controller.signal }).then(data => {
      if (refresh.controller.signal.aborted || progressClockRefresh !== refresh || record.owner !== navigationId
          || !matchesProgressReader(record) || !sameBookSnapshot(data.book, state.novel.book)) return;
      noteProgressClock(data);
      if (!record.explicit && !state.novel.book.progressRecovery) scheduleProgressSave(0);
    }).catch(() => {}).finally(() => {
      if (progressClockRefresh === refresh) progressClockRefresh = null;
    });
  }

  function invalidateProgressClock() {
    progressClockRefresh?.controller.abort();
    progressClockRefresh = null;
  }

  function installReaderKeyboard() {
    if (keyboardListenerInstalled) return;
    keyboardListenerInstalled = true;
    window.addEventListener("focusin", () => { readerFocusRevision += 1; });
    window.addEventListener("keydown", (event) => {
      if (state.activeView !== "novels" || !state.novel?.chapter) return;
      if (event.key === "Escape" && (state.novel.catalogOpen || state.novel.settingsOpen)) {
        event.preventDefault();
        const returnFocus = state.novel.catalogOpen ? "toolbar-目录" : "toolbar-设置";
        const ratio = currentReaderRatio();
        state.novel.catalogOpen = false;
        state.novel.settingsOpen = false;
        state.novel.pendingScrollRatio = ratio;
        if (!updateReaderPanels()) renderView();
        restoreReaderScroll();
        focusReaderControl(returnFocus);
        return;
      }
      if (event.key === "Tab" && state.novel.catalogOpen) {
        const panel = document.querySelector(".novel-reader-drawer-panel");
        const controls = Array.from(panel?.querySelectorAll("button:not(:disabled), input:not(:disabled)") || [])
          .filter(control => control.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
        return;
      }
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".novel-reader-progress-status")) return;
      if (target?.closest("input, select, textarea, button, a")) return;
      if (state.novel.catalogOpen || state.novel.settingsOpen) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
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
    if (state.activeView !== "novels" || !state.novel?.chapter) void readerFullscreen.leave();
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
    renderView,
    resetReader
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
  return NOVEL_DATE_FORMATTER.format(date).replaceAll("/", "-");
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
  const header = new Uint8Array(buffer, 0, Math.min(2, buffer.byteLength));
  const unicodeEncoding = header[0] === 0xff && header[1] === 0xfe ? "utf-16le"
    : header[0] === 0xfe && header[1] === 0xff ? "utf-16be" : "";
  if (unicodeEncoding) {
    try {
      return { text: new TextDecoder(unicodeEncoding, { fatal: true }).decode(buffer), encoding: unicodeEncoding };
    } catch {
      throw new Error(`${unicodeEncoding.toUpperCase()} 文本不完整或包含无效字符，请检查文件编码后重试。`);
    }
  }
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

function newProgressSessionId() {
  if (typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  // LAN HTTP has getRandomValues, while randomUUID requires a secure context.
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
