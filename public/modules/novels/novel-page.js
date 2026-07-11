const NOVEL_CATALOG_PAGE_SIZE = 120;
const NOVEL_BOOK_PAGE_SIZE = 48;
const NOVEL_AUTHOR_PAGE_SIZE = 60;
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

  let searchTimer = null;
  let catalogSearchTimer = null;
  let catalogRequestId = 0;
  let progressTimer = null;
  let progressWrite = Promise.resolve();
  let progressRevision = 0;
  let navigationId = 0;
  let navigationController = null;
  let readerStatusTimer = null;
  let scrollListenerInstalled = false;
  let progressLifecycleInstalled = false;
  let keyboardListenerInstalled = false;
  let libraryObserver = null;
  const chapterCache = new Map();
  const chapterRequests = new Map();

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
    if (!state.novel.data || options.reload) {
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
    state.novel.mode = ["mine", "authors", "author", "search", "rankings", "manage"].includes(route.novelMode) ? route.novelMode : "books";
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
    if (state.novel.mode === "rankings") state.novel.sort = "chars";
    const append = Boolean(options.append && state.novel.data && !state.novel.loading && !state.novel.loadingMore);
    if (options.append && !append) return;
    if (append) state.novel.loadingMore = true;
    else state.novel.loading = true;
    if (!append) state.novel.status = "正在读取小说书库";
    state.novel.book = options.keepBook ? state.novel.book : null;
    state.novel.chapter = options.keepChapter ? state.novel.chapter : null;
    setReaderBodyClass();
    renderView();
    const params = new URLSearchParams();
    if (state.novel.query) params.set("q", state.novel.query);
    if (state.novel.mode === "mine") params.set("reading", "1");
    if (["books", "author"].includes(state.novel.mode) && state.novel.category && state.novel.category !== "all") params.set("category", state.novel.category);
    if (state.novel.mode === "books" && state.novel.author) params.set("author", state.novel.author);
    if (state.novel.sort && state.novel.sort !== "updated") params.set("sort", state.novel.sort);
    const pageSize = state.novel.mode === "authors" ? NOVEL_AUTHOR_PAGE_SIZE : NOVEL_BOOK_PAGE_SIZE;
    params.set("limit", String(pageSize));
    const existingEntries = state.novel.mode === "authors" ? state.novel.data?.authors || [] : state.novel.data?.books || [];
    params.set("offset", String(append ? existingEntries.length : 0));
    const endpoint = state.novel.mode === "authors"
      ? "/api/novels/authors"
      : state.novel.mode === "author" && state.novel.author
        ? `/api/novels/authors/${encodeURIComponent(state.novel.author)}`
        : state.novel.mode === "manage"
          ? "/api/novels/summary"
          : "/api/novels";
    const emptySearch = state.novel.mode === "search" && !state.novel.query;
    const requestEndpoint = emptySearch ? "/api/novels/summary" : endpoint;
    const response = await api(`${requestEndpoint}${!emptySearch && state.novel.mode !== "manage" && params.toString() ? `?${params}` : ""}`);
    const data = state.novel.mode === "manage" || emptySearch
      ? { summary: response, books: [], total: 0, limit: pageSize, offset: 0 }
      : response;
    if (append) {
      const key = state.novel.mode === "authors" ? "authors" : "books";
      state.novel.data = { ...data, [key]: [...existingEntries, ...(data[key] || [])] };
    } else {
      state.novel.data = data;
    }
    state.novel.summary = data.summary || state.novel.summary;
    state.novel.loading = false;
    state.novel.loadingMore = false;
    const loadedEntries = state.novel.mode === "authors" ? state.novel.data?.authors || [] : state.novel.data?.books || [];
    state.novel.hasMore = !["manage"].includes(state.novel.mode) && !emptySearch && loadedEntries.length < Number(data.total || 0);
    state.novel.page = 0;
    state.novel.status = state.novel.mode === "manage"
      ? ""
      : emptySearch
        ? "输入书名、作者、分类或简介关键词开始搜索。"
      : data.total
        ? ""
        : state.novel.mode === "authors"
          ? "没有匹配的作者。"
          : state.novel.mode === "author"
            ? "这位作者还没有作品。"
            : state.novel.mode === "mine"
              ? "还没有阅读记录。"
            : state.novel.mode === "search"
              ? "没有找到匹配的小说。"
              : state.novel.mode === "rankings"
                ? "排行榜暂时没有小说。"
            : "这里还没有小说，请到“管理”页面刷新书库。";
    renderStats();
    renderView();
    if (!options.skipRoute) {
      const writer = options.replaceRoute ? replaceRoute : pushRoute;
      writer({
        view: "novels",
        novelBookId: "",
        novelChapterIndex: "",
        novelQuery: state.novel.query,
        novelCategory: state.novel.category,
        novelSort: state.novel.sort,
        novelMode: state.novel.mode,
        novelAuthor: state.novel.author,
        novelPage: state.novel.page
      });
    }
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
    await loadRemoteCatalogPage({
      anchor: data.book?.progress?.chapterIndex || 1,
      render: false
    });
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
    if (!state.novel.catalogQuery) {
      state.novel.catalogPage = catalogPageForChapter(state.novel.chapters, data.chapter?.index, state.novel.catalogDescending);
    }
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
      renderLoading("正在读取小说书库");
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
      shell.append(renderManagementPage(summary));
      els.workGrid.append(shell);
      return;
    }

    if (state.novel.mode === "mine") {
      shell.append(renderNovelPageHeading("我的阅读", "阅读记录和继续阅读入口"));
    } else if (state.novel.mode === "search") {
      shell.append(renderNovelPageHeading("搜索小说", "集中查找书名、作者、分类和作品简介"));
    } else if (state.novel.mode === "rankings") {
      shell.append(renderNovelPageHeading("字数排行榜", "按照正文总字数从高到低排列"));
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
    title.textContent = authorProfile?.name || (state.novel.mode === "authors" ? "作者" : "小说书库");
    const meta = document.createElement("p");
    const totals = summary.totals || {};
    meta.textContent = authorProfile
      ? `${formatNumber(authorProfile.bookCount || 0)} 本作品 · ${formatNumber(authorProfile.chapterCount || 0)} 章 · ${formatNumber(authorProfile.charCount || 0)} 字 · ${formatBytes(authorProfile.sizeBytes || 0)}`
      : `${formatNumber(totals.books || 0)} 本 · ${formatNumber(totals.authors || 0)} 位作者 · ${formatNumber(totals.chapters || 0)} 章 · ${formatBytes(totals.bytes || 0)}`;
    titleWrap.append(eyebrow, title, meta);
    head.append(titleWrap);

    const controls = document.createElement("div");
    controls.className = "novel-controls";
    const search = document.createElement("label");
    search.className = "novel-search";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.placeholder = "搜索书名、作者、分类或简介";
    searchInput.value = state.novel.query || "";
    searchInput.addEventListener("input", () => {
      state.novel.query = searchInput.value.trim();
      state.novel.page = 0;
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => loadNovels({ replaceRoute: true }).catch(() => {}), 260);
    });
    search.append(searchInput);
    const sort = document.createElement("select");
    sort.className = "novel-sort";
    const sortOptions = state.novel.mode === "authors"
      ? [["books", "作品最多"], ["name", "作者名"], ["chapters", "章节最多"], ["size", "总量最大"], ["updated", "最近更新"]]
      : [["updated", "最近更新"], ["chars", "字数最多"], ["progress", "最近阅读"], ["chapters", "章节最多"], ["size", "文件最大"], ["title", "书名"]];
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
    if (state.novel.mode === "search") controls.append(search);
    if (!authorProfile && !["mine", "rankings"].includes(state.novel.mode)) controls.append(sort);
    if (controls.childElementCount === 1) controls.classList.add("single");

    const categories = document.createElement("div");
    categories.className = "novel-category-row";
    if (state.novel.mode === "books") {
      categories.append(categoryButton("all", "全部", summary.totals?.books || 0));
      for (const item of data.facets || summary.categories || []) {
        categories.append(categoryButton(item.name, item.name, item.count));
      }
    }

    const entries = state.novel.mode === "authors" ? data.authors || [] : data.books || [];
    let list = state.novel.mode === "mine" ? renderRecent(entries) : null;
    if (!list) {
      list = document.createElement("div");
      list.className = state.novel.mode === "authors" ? "novel-author-list" : "novel-book-list";
      for (const [index, entry] of entries.entries()) {
        list.append(state.novel.mode === "authors" ? renderAuthorRow(entry) : renderBookRow(entry, state.novel.mode === "rankings" ? index + 1 : 0));
      }
    }
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "novel-empty-card";
      empty.textContent = state.novel.status || (state.novel.mode === "authors" ? "没有匹配的作者。" : "没有匹配的小说。");
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
    for (const [mode, label] of [["books", "书库"], ["mine", "我的"], ["authors", "作者"], ["search", "搜索"], ["rankings", "排行"], ["manage", "管理"]]) {
      const button = document.createElement("button");
      button.type = "button";
      const active = mode === "authors" ? ["authors", "author"].includes(state.novel.mode) : state.novel.mode === mode;
      button.className = active ? "active" : "";
      button.textContent = label;
      if (active) button.setAttribute("aria-current", "page");
      button.addEventListener("click", () => openNovelSection(mode));
      nav.append(button);
    }
    return nav;
  }

  function openNovelSection(mode) {
    if (!["books", "mine", "authors", "search", "rankings", "manage"].includes(mode)) return;
    flushProgress();
    invalidateNavigation();
    state.novel.book = null;
    state.novel.chapter = null;
    state.novel.mode = mode;
    state.novel.query = "";
    state.novel.category = "all";
    state.novel.author = "";
    state.novel.page = 0;
    state.novel.sort = mode === "mine" ? "progress" : mode === "rankings" ? "chars" : mode === "authors" ? "books" : "updated";
    state.novel.data = null;
    loadNovels().catch((error) => {
      state.novel.loading = false;
      state.novel.status = error.message || "页面读取失败";
      renderView();
    });
  }

  function renderManagementPage(summary = {}) {
    const panel = document.createElement("section");
    panel.className = "novel-management";
    const header = document.createElement("div");
    header.className = "novel-management-head";
    const titleWrap = document.createElement("div");
    const eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "书库维护";
    const title = document.createElement("h2");
    title.textContent = "小说管理";
    const description = document.createElement("p");
    description.textContent = "上传本地 TXT，或重新扫描已配置的小说目录。阅读功能不受管理操作影响。";
    titleWrap.append(eyebrow, title, description);
    header.append(titleWrap);

    const actions = document.createElement("div");
    actions.className = "novel-management-actions";
    const uploadCard = document.createElement("article");
    uploadCard.className = "novel-management-card";
    const uploadTitle = document.createElement("h3");
    uploadTitle.textContent = "上传 TXT";
    const uploadText = document.createElement("p");
    uploadText.textContent = "支持一次选择多个 TXT 文件，系统会自动识别编码并拆分章节。";
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
    uploadCard.append(uploadTitle, uploadText, uploadInput, uploadButton);

    const refreshCard = document.createElement("article");
    refreshCard.className = "novel-management-card";
    const refreshTitle = document.createElement("h3");
    refreshTitle.textContent = "刷新书库";
    const refreshText = document.createElement("p");
    refreshText.textContent = "重新扫描小说目录。手工校正过的书名、作者、分类和简介会继续保留。";
    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "novel-secondary-button";
    refreshButton.textContent = "打开刷新任务";
    refreshButton.disabled = state.novel.uploading;
    refreshButton.addEventListener("click", () => openAdminScript("novel-library-rescan"));
    refreshCard.append(refreshTitle, refreshText, refreshButton);
    actions.append(uploadCard, refreshCard);

    const totals = summary.totals || {};
    const status = document.createElement("div");
    status.className = "novel-management-status";
    status.textContent = state.novel.status || `当前共 ${formatNumber(totals.books || 0)} 本、${formatNumber(totals.chapters || 0)} 章；最近扫描：${summary.scannedAt ? formatDateTime(summary.scannedAt) : "暂无记录"}`;
    panel.append(header, actions, status);
    return panel;
  }

  function renderLibraryPagination(data = {}) {
    const total = Math.max(0, Number(data.total || 0));
    const limit = Math.max(1, Number(data.limit || (state.novel.mode === "authors" ? NOVEL_AUTHOR_PAGE_SIZE : NOVEL_BOOK_PAGE_SIZE)));
    const pageCount = Math.max(1, Math.ceil(total / limit));
    if (pageCount <= 1) return null;
    const page = Math.max(0, Math.min(pageCount - 1, Number(state.novel.page || 0)));
    const start = total ? page * limit + 1 : 0;
    const end = Math.min(total, start + limit - 1);
    const nav = document.createElement("nav");
    nav.className = "novel-library-pagination";
    nav.setAttribute("aria-label", state.novel.mode === "authors" ? "作者分页" : "书库分页");
    const previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = "上一页";
    previous.disabled = page <= 0;
    previous.addEventListener("click", () => changeLibraryPage(page - 1));
    const select = document.createElement("select");
    select.setAttribute("aria-label", "选择页码");
    for (let index = 0; index < pageCount; index += 1) {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `第 ${formatNumber(index + 1)} 页`;
      option.selected = index === page;
      select.append(option);
    }
    select.addEventListener("change", () => changeLibraryPage(Number(select.value || 0)));
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "下一页";
    next.disabled = page >= pageCount - 1;
    next.addEventListener("click", () => changeLibraryPage(page + 1));
    const status = document.createElement("span");
    status.textContent = `${formatNumber(start)}–${formatNumber(end)} / ${formatNumber(total)}`;
    nav.append(previous, select, next, status);
    return nav;
  }

  function changeLibraryPage(page) {
    const nextPage = Math.max(0, Number(page || 0));
    if (nextPage === state.novel.page) return;
    state.novel.page = nextPage;
    loadNovels({ replaceRoute: true }).then(() => {
      document.querySelector(".novel-home")?.scrollIntoView({ block: "start", behavior: "auto" });
    }).catch(() => {});
  }

  function renderAuthorRow(author) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "novel-author-card";
    const avatar = document.createElement("span");
    avatar.className = "novel-author-avatar";
    avatar.textContent = String(author.name || "作").slice(0, 1).toLocaleUpperCase();
    const body = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = author.name || "未知作者";
    const meta = document.createElement("small");
    meta.textContent = `${formatNumber(author.bookCount || 0)} 本 · ${formatNumber(author.chapterCount || 0)} 章 · ${formatBytes(author.sizeBytes || 0)}`;
    body.append(name, meta);
    const open = document.createElement("span");
    open.textContent = "查看作品 →";
    button.append(avatar, body, open);
    button.addEventListener("click", () => openNovelAuthor(author.name));
    return button;
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
    const correct = document.createElement("button");
    correct.type = "button";
    correct.className = "novel-secondary-button";
    correct.textContent = "校正信息";
    correct.addEventListener("click", () => openBookCorrectionDialog(book));
    actions.append(start, catalogButton, download, correct);
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
        meta: catalogMeta,
        serverPaged: state.novel.catalogRemotePaged
      }));
    }
    catalog.append(catalogHead, grid);

    shell.append(hero, intro, catalog);
    els.workGrid.append(shell);
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
        compact: true,
        serverPaged: state.novel.catalogRemotePaged
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
    const serverPaged = Boolean(options.serverPaged);
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
    const previous = document.createElement("button");
    previous.type = "button";
    previous.textContent = "上一段";
    const range = document.createElement("select");
    range.setAttribute("aria-label", "目录分段");
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "下一段";
    const status = document.createElement("span");
    status.className = "novel-catalog-status";
    const list = document.createElement("div");
    list.className = options.compact ? "novel-reader-catalog-list" : "novel-catalog-grid";

    function refresh() {
      const query = String(state.novel.catalogQuery || "").trim().toLocaleLowerCase("zh-Hans-CN");
      let filtered = source;
      let visible = source;
      let filteredTotal = Number(state.novel.catalogFilteredTotal || source.length);
      if (!serverPaged) {
        filtered = query
          ? source.filter((chapter) => String(chapter.title || "").toLocaleLowerCase("zh-Hans-CN").includes(query) || String(chapter.index || "").includes(query))
          : [...source];
        if (state.novel.catalogDescending) filtered.reverse();
        filteredTotal = filtered.length;
      }
      const pageCount = Math.max(1, Math.ceil(filteredTotal / NOVEL_CATALOG_PAGE_SIZE));
      if (serverPaged) state.novel.catalogPage = Math.floor(Number(state.novel.catalogOffset || 0) / NOVEL_CATALOG_PAGE_SIZE);
      state.novel.catalogPage = Math.max(0, Math.min(pageCount - 1, Number(state.novel.catalogPage || 0)));
      const start = state.novel.catalogPage * NOVEL_CATALOG_PAGE_SIZE;
      if (!serverPaged) visible = filtered.slice(start, start + NOVEL_CATALOG_PAGE_SIZE);

      order.textContent = state.novel.catalogDescending ? "倒序" : "正序";
      order.title = state.novel.catalogDescending ? "切换为正序" : "切换为倒序";
      previous.disabled = state.novel.catalogPage <= 0;
      next.disabled = state.novel.catalogPage >= pageCount - 1;
      range.innerHTML = "";
      for (let page = 0; page < pageCount; page += 1) {
        const first = page * NOVEL_CATALOG_PAGE_SIZE + 1;
        const last = Math.min(filteredTotal, first + NOVEL_CATALOG_PAGE_SIZE - 1);
        const option = document.createElement("option");
        option.value = String(page);
        option.textContent = filteredTotal ? `${formatNumber(first)}–${formatNumber(last)}` : "无结果";
        option.selected = page === state.novel.catalogPage;
        range.append(option);
      }
      range.disabled = pageCount <= 1;
      status.textContent = query
        ? `找到 ${formatNumber(filteredTotal)} 章`
        : `每段 ${formatNumber(NOVEL_CATALOG_PAGE_SIZE)} 章`;
      if (options.meta) {
        options.meta.textContent = query
          ? `找到 ${formatNumber(filteredTotal)} / ${formatNumber(serverPaged ? state.novel.catalogTotal : source.length)} 章`
          : `共 ${formatNumber(serverPaged ? state.novel.catalogTotal : source.length)} 章`;
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
      state.novel.catalogPage = 0;
      if (!serverPaged) {
        refresh();
        return;
      }
      window.clearTimeout(catalogSearchTimer);
      catalogSearchTimer = window.setTimeout(() => {
        loadRemoteCatalogPage({ page: 0, query: search.value }).catch(() => {});
      }, 260);
    });
    order.addEventListener("click", () => {
      state.novel.catalogDescending = !state.novel.catalogDescending;
      state.novel.catalogPage = 0;
      if (serverPaged) {
        loadRemoteCatalogPage({ page: 0, anchor: state.novel.catalogQuery ? 0 : state.novel.chapter?.index }).catch(() => {});
      } else {
        refresh();
      }
    });
    previous.addEventListener("click", () => {
      const page = Math.max(0, state.novel.catalogPage - 1);
      if (serverPaged) loadRemoteCatalogPage({ page }).catch(() => {});
      else {
        state.novel.catalogPage = page;
        refresh();
      }
    });
    next.addEventListener("click", () => {
      const page = state.novel.catalogPage + 1;
      if (serverPaged) loadRemoteCatalogPage({ page }).catch(() => {});
      else {
        state.novel.catalogPage = page;
        refresh();
      }
    });
    range.addEventListener("change", () => {
      const page = Math.max(0, Number(range.value || 0));
      if (serverPaged) loadRemoteCatalogPage({ page }).catch(() => {});
      else {
        state.novel.catalogPage = page;
        refresh();
      }
    });

    const pagination = document.createElement("div");
    pagination.className = "novel-catalog-pagination";
    pagination.append(previous, range, next);
    tools.append(search, order, pagination, status);
    shell.append(tools, list);
    refresh();
    return shell;
  }

  function resetCatalogState(book, chapters, chapterIndex) {
    state.novel.catalogBookId = book?.id || "";
    state.novel.catalogQuery = "";
    state.novel.catalogDescending = false;
    state.novel.catalogPage = catalogPageForChapter(chapters, chapterIndex, false);
    state.novel.catalogRemotePaged = false;
    state.novel.catalogTotal = Number(chapters.length || book?.chapterCount || 0);
    state.novel.catalogFilteredTotal = state.novel.catalogTotal;
    state.novel.catalogOffset = state.novel.catalogPage * NOVEL_CATALOG_PAGE_SIZE;
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
    panel.append(settingRow("宽度", stepper("width", 680, 980, 20, `${state.novel.settings.width}px`)));
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
    if (opening && !state.novel.catalogQuery) {
      state.novel.catalogPage = catalogPageForChapter(state.novel.chapters, state.novel.chapter?.index, state.novel.catalogDescending);
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
    if (total > 0 && Number(state.novel.chapters?.length || 0) >= total) return true;
    if (!state.novel.catalogRemotePaged || state.novel.catalogBookId !== state.novel.book?.id) return false;
    if (state.novel.catalogQuery) return true;
    const current = Number(state.novel.chapter?.index || 0);
    return current > 0 && state.novel.chapters.some((chapter) => Number(chapter.index) === current);
  }

  async function loadReaderCatalog() {
    return loadRemoteCatalogPage({ anchor: state.novel.chapter?.index || 1 });
  }

  async function loadRemoteCatalogPage(options = {}) {
    const bookId = String(state.novel.book?.id || "");
    if (!bookId) return;
    const requestId = ++catalogRequestId;
    const query = String(options.query ?? state.novel.catalogQuery ?? "").replace(/\s+/g, " ").trim();
    state.novel.catalogQuery = query;
    const params = new URLSearchParams({
      limit: String(NOVEL_CATALOG_PAGE_SIZE),
      order: state.novel.catalogDescending ? "desc" : "asc"
    });
    if (query) params.set("q", query);
    if (!query && Number(options.anchor || 0) > 0) params.set("anchor", String(options.anchor));
    else params.set("offset", String(Math.max(0, Number(options.page ?? state.novel.catalogPage ?? 0)) * NOVEL_CATALOG_PAGE_SIZE));
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
      state.novel.catalogRemotePaged = true;
      state.novel.catalogBookId = bookId;
      state.novel.catalogTotal = Number(data.total || state.novel.book?.chapterCount || 0);
      state.novel.catalogFilteredTotal = Number(data.filteredTotal || 0);
      state.novel.catalogOffset = Number(data.offset || 0);
      state.novel.catalogPage = Math.floor(state.novel.catalogOffset / NOVEL_CATALOG_PAGE_SIZE);
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

function catalogPageForChapter(chapters, chapterIndex, descending = false) {
  const source = Array.isArray(chapters) ? chapters : [];
  if (!source.length) return 0;
  const position = source.findIndex((chapter) => Number(chapter.index) === Number(chapterIndex));
  if (position < 0) return 0;
  const orderedPosition = descending ? source.length - position - 1 : position;
  return Math.max(0, Math.floor(orderedPosition / NOVEL_CATALOG_PAGE_SIZE));
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
  return {
    theme: ["paper", "green", "white"].includes(input.theme) ? input.theme : "paper",
    night: Boolean(input.night),
    font: ["yahei", "simsun", "kaiti"].includes(input.font) ? input.font : "yahei",
    fontSize: clampNumber(input.fontSize, 16, 30, 20),
    lineHeight: clampNumber(input.lineHeight, 1.5, 2.4, 1.9),
    width: clampNumber(input.width, 680, 980, 820)
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
