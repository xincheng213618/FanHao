const NOVEL_CATALOG_PAGE_SIZE = 120;
const NOVEL_READING_CHARS_PER_MINUTE = 450;
const NOVEL_BOOK_PAGE_SIZE = 48;
const NOVEL_AUTHOR_PAGE_SIZE = 60;

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
  let progressTimer = null;
  let progressFrame = null;
  let scrollListenerInstalled = false;
  let keyboardListenerInstalled = false;

  function ensureState() {
    if (!state.novel) state.novel = {};
    state.novel.query = state.novel.query || "";
    state.novel.category = state.novel.category || "all";
    state.novel.author = state.novel.author || "";
    state.novel.mode = state.novel.mode === "authors" ? "authors" : "books";
    state.novel.page = Math.max(0, Number(state.novel.page || 0));
    state.novel.sort = state.novel.sort || "updated";
    state.novel.data = state.novel.data || null;
    state.novel.summary = state.novel.summary || null;
    state.novel.book = state.novel.book || null;
    state.novel.chapters = state.novel.chapters || [];
    state.novel.chapter = state.novel.chapter || null;
    state.novel.loading = Boolean(state.novel.loading);
    state.novel.uploading = Boolean(state.novel.uploading);
    state.novel.status = state.novel.status || "";
    state.novel.catalogOpen = Boolean(state.novel.catalogOpen);
    state.novel.settingsOpen = Boolean(state.novel.settingsOpen);
    state.novel.textSearchOpen = Boolean(state.novel.textSearchOpen);
    state.novel.catalogQuery = state.novel.catalogQuery || "";
    state.novel.catalogPage = Math.max(0, Number(state.novel.catalogPage || 0));
    state.novel.catalogDescending = Boolean(state.novel.catalogDescending);
    state.novel.settings = normalizeSettings(state.novel.settings || readSettings());
    installScrollProgress();
    installReaderKeyboard();
  }

  function enter(options = {}) {
    ensureState();
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
    state.novel.mode = route.novelMode === "authors" ? "authors" : "books";
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
    state.novel.book = null;
    state.novel.chapter = null;
    state.novel.catalogOpen = false;
    state.novel.settingsOpen = false;
    state.novel.textSearchOpen = false;
    await loadNovels({ skipRoute: true });
  }

  async function loadNovels(options = {}) {
    ensureState();
    state.novel.loading = true;
    state.novel.status = "正在读取小说书库";
    state.novel.book = options.keepBook ? state.novel.book : null;
    state.novel.chapter = options.keepChapter ? state.novel.chapter : null;
    setReaderBodyClass();
    renderView();
    const params = new URLSearchParams();
    if (state.novel.query) params.set("q", state.novel.query);
    if (state.novel.mode === "books" && state.novel.category && state.novel.category !== "all") params.set("category", state.novel.category);
    if (state.novel.mode === "books" && state.novel.author) params.set("author", state.novel.author);
    if (state.novel.sort && state.novel.sort !== "updated") params.set("sort", state.novel.sort);
    const pageSize = state.novel.mode === "authors" ? NOVEL_AUTHOR_PAGE_SIZE : NOVEL_BOOK_PAGE_SIZE;
    params.set("limit", String(pageSize));
    params.set("offset", String(state.novel.page * pageSize));
    const endpoint = state.novel.mode === "authors" ? "/api/novels/authors" : "/api/novels";
    const data = await api(`${endpoint}${params.toString() ? `?${params}` : ""}`);
    const pageCount = Math.max(1, Math.ceil(Number(data.total || 0) / pageSize));
    if (state.novel.page >= pageCount && state.novel.page > 0) {
      state.novel.page = pageCount - 1;
      return loadNovels({ ...options, replaceRoute: true });
    }
    state.novel.data = data;
    state.novel.summary = data.summary || state.novel.summary;
    state.novel.loading = false;
    state.novel.status = data.total ? "" : state.novel.mode === "authors" ? "没有匹配的作者。" : "这里还没有小说，先运行“刷新小说书库”。";
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
    state.novel.loading = true;
    state.novel.status = "正在读取书籍详情";
    state.novel.chapter = null;
    state.novel.catalogOpen = false;
    state.novel.settingsOpen = false;
    state.novel.textSearchOpen = false;
    setReaderBodyClass();
    renderView();
    const data = await api(`/api/novels/${encodeURIComponent(bookId)}`);
    state.novel.book = data.book;
    state.novel.chapters = data.chapters || [];
    resetCatalogState(data.book, state.novel.chapters, data.book?.progress?.chapterIndex || 1);
    state.novel.loading = false;
    state.novel.status = "";
    renderStats();
    renderView();
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    if (!options.skipRoute) pushRoute({ view: "novels", novelBookId: bookId, novelChapterIndex: "" });
  }

  async function openChapter(bookId, chapterIndex, options = {}) {
    ensureState();
    if (!bookId || !chapterIndex) return;
    state.novel.loading = true;
    state.novel.status = "正在翻开章节";
    renderView();
    const data = await api(`/api/novels/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(chapterIndex)}`);
    state.novel.book = data.book;
    state.novel.chapter = data.chapter;
    state.novel.chapters = data.chapters || [];
    state.novel.prev = data.prev || null;
    state.novel.next = data.next || null;
    state.novel.loading = false;
    state.novel.status = "";
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
    if (!options.skipRoute) pushRoute({ view: "novels", novelBookId: bookId, novelChapterIndex: String(chapterIndex) });
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

    const head = document.createElement("div");
    head.className = "novel-home-head";
    const titleWrap = document.createElement("div");
    const eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "本地小说";
    const title = document.createElement("h2");
    title.textContent = state.novel.mode === "authors" ? "作者" : state.novel.author ? `${state.novel.author}的作品` : "小说书库";
    const meta = document.createElement("p");
    const totals = summary.totals || {};
    meta.textContent = `${formatNumber(totals.books || 0)} 本 · ${formatNumber(totals.authors || 0)} 位作者 · ${formatNumber(totals.chapters || 0)} 章 · ${formatBytes(totals.bytes || 0)}`;
    titleWrap.append(eyebrow, title, meta);
    const actions = document.createElement("div");
    actions.className = "novel-home-actions";
    const uploadInput = document.createElement("input");
    uploadInput.type = "file";
    uploadInput.accept = ".txt,text/plain";
    uploadInput.multiple = true;
    uploadInput.className = "novel-upload-input";
    const uploadButton = document.createElement("button");
    uploadButton.type = "button";
    uploadButton.className = "novel-secondary-button";
    uploadButton.textContent = state.novel.uploading ? "上传中" : "上传TXT";
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
    const scanButton = document.createElement("button");
    scanButton.type = "button";
    scanButton.className = "novel-primary-button";
    scanButton.textContent = "刷新书库";
    scanButton.disabled = state.novel.uploading;
    scanButton.addEventListener("click", () => openAdminScript("novel-library-rescan"));
    actions.append(uploadInput, uploadButton, scanButton);
    head.append(titleWrap, actions);

    const tabs = document.createElement("div");
    tabs.className = "novel-library-tabs";
    for (const [mode, label] of [["books", "书库"], ["authors", "作者"]]) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = state.novel.mode === mode ? "active" : "";
      tab.textContent = label;
      tab.addEventListener("click", () => {
        if (state.novel.mode === mode) return;
        state.novel.mode = mode;
        state.novel.query = "";
        state.novel.category = "all";
        state.novel.author = "";
        state.novel.page = 0;
        state.novel.sort = mode === "authors" ? "books" : "updated";
        loadNovels({ replaceRoute: true }).catch(() => {});
      });
      tabs.append(tab);
    }

    const controls = document.createElement("div");
    controls.className = "novel-controls";
    const search = document.createElement("label");
    search.className = "novel-search";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.placeholder = state.novel.mode === "authors" ? "搜索作者" : "搜索书名、作者、分类或章节";
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
      : [["updated", "最近更新"], ["progress", "最近阅读"], ["chapters", "章节最多"], ["size", "文件最大"], ["title", "书名"]];
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
    controls.append(search, sort);

    const categories = document.createElement("div");
    categories.className = "novel-category-row";
    if (state.novel.mode === "books") {
      categories.append(categoryButton("all", "全部", summary.totals?.books || 0));
      for (const item of data.facets || summary.categories || []) {
        categories.append(categoryButton(item.name, item.name, item.count));
      }
    }

    const recent = state.novel.mode === "books" && !state.novel.author ? renderRecent(summary.recent || []) : null;
    const list = document.createElement("div");
    list.className = state.novel.mode === "authors" ? "novel-author-list" : "novel-book-list";
    const entries = state.novel.mode === "authors" ? data.authors || [] : data.books || [];
    for (const entry of entries) {
      list.append(state.novel.mode === "authors" ? renderAuthorRow(entry) : renderBookRow(entry));
    }
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "novel-empty-card";
      empty.textContent = state.novel.status || (state.novel.mode === "authors" ? "没有匹配的作者。" : "没有匹配的小说。");
      list.append(empty);
    }

    shell.append(head, tabs, controls);
    if (state.novel.author && state.novel.mode === "books") shell.append(renderAuthorFilter());
    if (categories.childElementCount) shell.append(categories);
    if (state.novel.status) {
      const status = document.createElement("div");
      status.className = "novel-status-line";
      status.textContent = state.novel.status;
      shell.append(status);
    }
    if (recent) shell.append(recent);
    shell.append(list);
    const pagination = renderLibraryPagination(data);
    if (pagination) shell.append(pagination);
    els.workGrid.append(shell);
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
    button.addEventListener("click", () => {
      state.novel.mode = "books";
      state.novel.author = author.name || "";
      state.novel.query = "";
      state.novel.category = "all";
      state.novel.page = 0;
      state.novel.sort = "title";
      loadNovels({ replaceRoute: true }).catch(() => {});
    });
    return button;
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

  function renderBookRow(book) {
    const row = document.createElement("article");
    row.className = "novel-book-row";
    row.append(renderCover(book));
    const body = document.createElement("div");
    body.className = "novel-book-row-body";
    const title = document.createElement("h3");
    title.textContent = book.title;
    const meta = document.createElement("p");
    meta.textContent = [book.author || "未知作者", book.category, `${formatNumber(book.chapterCount)} 章`, formatBytes(book.sizeBytes)].filter(Boolean).join(" · ");
    const summary = document.createElement("p");
    summary.className = "novel-book-summary";
    summary.textContent = book.summary || book.latestChapterTitle || book.relativePath;
    const latest = document.createElement("div");
    latest.className = "novel-book-latest";
    latest.textContent = book.latestChapterTitle ? `最新：${book.latestChapterTitle}` : "TXT 本地导入";
    body.append(title, meta, summary, latest);
    if (book.progress) body.append(renderBookProgress(book));
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
    row.addEventListener("dblclick", () => openReading(book));
    return row;
  }

  function renderBookDetail() {
    const book = state.novel.book;
    const chapters = state.novel.chapters || [];
    const shell = document.createElement("section");
    shell.className = "novel-detail";
    shell.append(renderBreadcrumbs([{ label: "小说书库", action: showHome }, { label: book.title }]));

    const hero = document.createElement("section");
    hero.className = "novel-detail-hero";
    hero.append(renderCover(book, "large"));
    const info = document.createElement("div");
    info.className = "novel-detail-info";
    const title = document.createElement("h2");
    title.textContent = book.title;
    const meta = document.createElement("p");
    meta.textContent = [book.author || "未知作者", book.category, `${formatNumber(book.chapterCount)} 章`, formatBytes(book.sizeBytes)].join(" · ");
    const latest = document.createElement("p");
    latest.className = "novel-detail-latest";
    latest.textContent = book.latestChapterTitle ? `最新章节：${book.latestChapterTitle}` : "本地 TXT 导入";
    const metrics = document.createElement("div");
    metrics.className = "novel-detail-metrics";
    for (const item of [
      ["字数", `${formatNumber(book.charCount)}`],
      ["章节", `${formatNumber(book.chapterCount)}`],
      ["编码", book.encoding || "-"],
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
    start.addEventListener("click", () => openChapter(book.id, book.progress?.chapterIndex || chapters[0]?.index || 1, { restoreProgress: Boolean(book.progress) }));
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
    actions.append(start, catalogButton, download);
    info.append(title, meta, latest, metrics, actions);
    const side = document.createElement("aside");
    side.className = "novel-detail-side";
    const sideTitle = document.createElement("strong");
    sideTitle.textContent = "本地来源";
    const sidePath = document.createElement("p");
    sidePath.textContent = book.relativePath || book.fileName;
    const updated = document.createElement("span");
    updated.textContent = book.updatedAt ? `入库 ${formatDateTime(book.updatedAt)}` : "";
    side.append(sideTitle, sidePath, updated);
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
    catalogMeta.textContent = `共 ${formatNumber(chapters.length)} 章`;
    catalogHead.append(catalogTitle, catalogMeta);
    const grid = document.createElement("div");
    grid.className = "novel-catalog-browser";
    grid.append(createCatalogBrowser(chapters, { compact: false, meta: catalogMeta }));
    catalog.append(catalogHead, grid);

    shell.append(hero, intro, catalog);
    els.workGrid.append(shell);
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
    title.textContent = `章节目录 · ${formatNumber((state.novel.chapters || []).length)} 章`;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.addEventListener("click", () => toggleCatalog(false));
    head.append(title, close);
    const browser = createCatalogBrowser(state.novel.chapters || [], { compact: true });
    panel.append(head, browser);
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
      let filtered = query
        ? source.filter((chapter) => String(chapter.title || "").toLocaleLowerCase("zh-Hans-CN").includes(query) || String(chapter.index || "").includes(query))
        : [...source];
      if (state.novel.catalogDescending) filtered.reverse();
      const pageCount = Math.max(1, Math.ceil(filtered.length / NOVEL_CATALOG_PAGE_SIZE));
      state.novel.catalogPage = Math.max(0, Math.min(pageCount - 1, Number(state.novel.catalogPage || 0)));
      const start = state.novel.catalogPage * NOVEL_CATALOG_PAGE_SIZE;
      const visible = filtered.slice(start, start + NOVEL_CATALOG_PAGE_SIZE);

      order.textContent = state.novel.catalogDescending ? "倒序" : "正序";
      order.title = state.novel.catalogDescending ? "切换为正序" : "切换为倒序";
      previous.disabled = state.novel.catalogPage <= 0;
      next.disabled = state.novel.catalogPage >= pageCount - 1;
      range.innerHTML = "";
      for (let page = 0; page < pageCount; page += 1) {
        const first = page * NOVEL_CATALOG_PAGE_SIZE + 1;
        const last = Math.min(filtered.length, first + NOVEL_CATALOG_PAGE_SIZE - 1);
        const option = document.createElement("option");
        option.value = String(page);
        option.textContent = filtered.length ? `${formatNumber(first)}–${formatNumber(last)}` : "无结果";
        option.selected = page === state.novel.catalogPage;
        range.append(option);
      }
      range.disabled = pageCount <= 1;
      status.textContent = query
        ? `找到 ${formatNumber(filtered.length)} 章`
        : `每段 ${formatNumber(NOVEL_CATALOG_PAGE_SIZE)} 章`;
      if (options.meta) {
        options.meta.textContent = query
          ? `找到 ${formatNumber(filtered.length)} / ${formatNumber(source.length)} 章`
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
      state.novel.catalogPage = 0;
      refresh();
    });
    order.addEventListener("click", () => {
      state.novel.catalogDescending = !state.novel.catalogDescending;
      state.novel.catalogPage = 0;
      refresh();
    });
    previous.addEventListener("click", () => {
      state.novel.catalogPage = Math.max(0, state.novel.catalogPage - 1);
      refresh();
    });
    next.addEventListener("click", () => {
      state.novel.catalogPage += 1;
      refresh();
    });
    range.addEventListener("change", () => {
      state.novel.catalogPage = Math.max(0, Number(range.value || 0));
      refresh();
    });

    const pagination = document.createElement("div");
    pagination.className = "novel-catalog-pagination";
    pagination.append(previous, range, next);
    tools.append(search, order, pagination, status);
    shell.append(tools, list);
    refresh();
    return shell;
  }

  function createBookTextSearch(book, options = {}) {
    ensureBookTextSearchState(book?.id);
    const panel = document.createElement("section");
    panel.className = `novel-text-search${options.compact ? " compact" : ""}`;
    const head = document.createElement("div");
    head.className = "novel-text-search-head";
    const titleWrap = document.createElement("div");
    const title = document.createElement(options.compact ? "strong" : "h3");
    title.textContent = "书内搜索";
    const description = document.createElement("span");
    description.textContent = "从整本正文中查找，并直接跳到对应章节";
    titleWrap.append(title, description);
    head.append(titleWrap);

    const form = document.createElement("form");
    form.className = "novel-text-search-form";
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "输入正文关键词（至少 2 个字符）";
    input.setAttribute("aria-label", "搜索书内正文");
    input.value = state.novel.textSearchQuery || "";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "搜索正文";
    form.append(input, submit);

    const status = document.createElement("div");
    status.className = "novel-text-search-status";
    const results = document.createElement("div");
    results.className = "novel-text-search-results";
    const more = document.createElement("button");
    more.type = "button";
    more.className = "novel-text-search-more";
    more.textContent = "继续查找";

    function renderResults() {
      const items = state.novel.textSearchResults || [];
      submit.disabled = Boolean(state.novel.textSearchLoading);
      submit.textContent = state.novel.textSearchLoading ? "搜索中" : "搜索正文";
      status.textContent = state.novel.textSearchError
        ? state.novel.textSearchError
        : state.novel.textSearchLoading
          ? "正在扫描这本书的正文"
          : state.novel.textSearchQuery
            ? items.length
              ? `已找到 ${formatNumber(items.length)} 个章节${state.novel.textSearchHasMore ? "，还可以继续查找" : ""}`
              : "没有找到匹配正文"
            : "搜索只在当前这本书中进行，不会增加数据库体积";
      status.classList.toggle("error", Boolean(state.novel.textSearchError));
      results.innerHTML = "";
      for (const item of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "novel-text-search-result";
        const row = document.createElement("span");
        const strong = document.createElement("strong");
        strong.textContent = `第 ${formatNumber(item.chapterIndex)} 章 · ${item.chapterTitle}`;
        const meta = document.createElement("small");
        meta.textContent = `${formatNumber(item.matchCount || 0)} 处匹配 · ${formatNumber(item.charCount || 0)} 字`;
        row.append(strong, meta);
        const excerpt = document.createElement("p");
        appendHighlightedText(excerpt, item.excerpt || "", state.novel.textSearchQuery);
        button.append(row, excerpt);
        button.addEventListener("click", () => {
          state.novel.textSearchOpen = false;
          openChapter(book.id, item.chapterIndex, { restoreProgress: false });
        });
        results.append(button);
      }
      more.hidden = !state.novel.textSearchHasMore || state.novel.textSearchLoading;
    }

    async function search(options = {}) {
      const query = String(input.value || "").replace(/\s+/g, " ").trim();
      if (query.length < 2) {
        state.novel.textSearchError = "请输入至少 2 个字符";
        renderResults();
        return;
      }
      const append = Boolean(options.append) && query === state.novel.textSearchQuery;
      state.novel.textSearchBookId = book.id;
      state.novel.textSearchQuery = query;
      state.novel.textSearchLoading = true;
      state.novel.textSearchError = "";
      if (!append) state.novel.textSearchResults = [];
      renderResults();
      try {
        const offset = append ? state.novel.textSearchResults.length : 0;
        const params = new URLSearchParams({ q: query, limit: options.compact ? "20" : "30", offset: String(offset) });
        const data = await api(`/api/novels/${encodeURIComponent(book.id)}/search?${params}`);
        state.novel.textSearchResults = append
          ? [...state.novel.textSearchResults, ...(data.items || [])]
          : data.items || [];
        state.novel.textSearchHasMore = Boolean(data.hasMore);
      } catch (error) {
        state.novel.textSearchError = error.message || "书内搜索失败";
        state.novel.textSearchHasMore = false;
      } finally {
        state.novel.textSearchLoading = false;
        renderResults();
      }
    }

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      search({ compact: Boolean(options.compact) });
    });
    more.addEventListener("click", () => search({ append: true, compact: Boolean(options.compact) }));
    panel.append(head, form, status, results, more);
    renderResults();
    return panel;
  }

  function ensureBookTextSearchState(bookId) {
    const id = String(bookId || "");
    if (state.novel.textSearchBookId === id) return;
    state.novel.textSearchBookId = id;
    state.novel.textSearchQuery = "";
    state.novel.textSearchResults = [];
    state.novel.textSearchHasMore = false;
    state.novel.textSearchLoading = false;
    state.novel.textSearchError = "";
  }

  function renderTextSearchDrawer() {
    const wrap = document.createElement("div");
    wrap.className = "novel-reader-drawer novel-reader-search-drawer";
    const panel = document.createElement("aside");
    panel.className = "novel-reader-drawer-panel novel-reader-search-panel";
    const head = document.createElement("div");
    head.className = "novel-reader-drawer-head";
    const title = document.createElement("strong");
    title.textContent = `搜索《${state.novel.book?.title || "当前小说"}》`;
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.addEventListener("click", () => toggleTextSearch(false));
    head.append(title, close);
    panel.append(head, createBookTextSearch(state.novel.book, { compact: true }));
    wrap.append(panel);
    wrap.addEventListener("click", (event) => {
      if (event.target === wrap) toggleTextSearch(false);
    });
    return wrap;
  }

  function resetCatalogState(book, chapters, chapterIndex) {
    state.novel.catalogBookId = book?.id || "";
    state.novel.catalogQuery = "";
    state.novel.catalogDescending = false;
    state.novel.catalogPage = catalogPageForChapter(chapters, chapterIndex, false);
  }

  function renderBookProgress(book) {
    const progress = readingProgress(book);
    const wrap = document.createElement("div");
    wrap.className = "novel-book-progress";
    const rail = document.createElement("span");
    const fill = document.createElement("i");
    fill.style.width = `${Math.round(progress.overallRatio * 1000) / 10}%`;
    rail.append(fill);
    const label = document.createElement("small");
    label.textContent = compactBookProgress(book);
    wrap.append(rail, label);
    return wrap;
  }

  function compactBookProgress(book) {
    const progress = readingProgress(book);
    return `第 ${formatNumber(progress.chapterIndex)}/${formatNumber(progress.chapterCount)} 章 · 全书 ${Math.round(progress.overallRatio * 1000) / 10}%`;
  }

  function renderReaderProgress() {
    const book = state.novel.book || {};
    const chapter = state.novel.chapter || {};
    const saved = Number(book.progress?.chapterIndex || 0) === Number(chapter.index || 0)
      ? Number(book.progress?.scrollRatio || 0)
      : 0;
    const ratio = clampRatio(state.novel.pendingScrollRatio ?? saved);
    const progress = readingProgress(book, state.novel.chapters, chapter.index, ratio);
    const card = document.createElement("section");
    card.className = "novel-reader-progress-card";
    const head = document.createElement("div");
    const chapterLabel = document.createElement("strong");
    chapterLabel.textContent = `第 ${formatNumber(progress.chapterIndex)} / ${formatNumber(progress.chapterCount)} 章`;
    const summary = document.createElement("span");
    summary.dataset.novelProgressSummary = "";
    summary.textContent = readerProgressSummary(progress);
    head.append(chapterLabel, summary);
    const rail = document.createElement("div");
    rail.className = "novel-reader-progress-rail";
    const fill = document.createElement("i");
    fill.dataset.novelProgressFill = "";
    fill.style.width = `${progress.overallRatio * 100}%`;
    rail.append(fill);
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(Math.round(ratio * 100));
    slider.dataset.novelChapterSlider = "";
    slider.setAttribute("aria-label", "当前章节进度");
    slider.addEventListener("input", () => {
      const nextRatio = Number(slider.value) / 100;
      scrollReaderToRatio(nextRatio);
      updateReaderProgressUi(nextRatio);
    });
    slider.addEventListener("change", saveProgress);
    card.append(head, rail, slider);
    return card;
  }

  function renderSettingsPanel() {
    const panel = document.createElement("aside");
    panel.className = "novel-settings-panel";
    const title = document.createElement("strong");
    title.textContent = "阅读设置";
    panel.append(title);
    panel.append(settingRow("主题", themeButtons()));
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
    state.novel.book = null;
    state.novel.chapter = null;
    state.novel.catalogOpen = false;
    state.novel.settingsOpen = false;
    state.novel.textSearchOpen = false;
    setReaderBodyClass();
    if (!state.novel.data) loadNovels({ skipRoute: true }).catch(() => {});
    renderStats();
    renderView();
    pushRoute({ view: "novels", novelBookId: "", novelChapterIndex: "" });
  }

  function toggleCatalog(force) {
    const ratio = state.novel.chapter ? currentReaderRatio() : 0;
    const opening = force === undefined ? !state.novel.catalogOpen : Boolean(force);
    state.novel.catalogOpen = opening;
    if (opening && !state.novel.catalogQuery) {
      state.novel.catalogPage = catalogPageForChapter(state.novel.chapters, state.novel.chapter?.index, state.novel.catalogDescending);
    }
    if (state.novel.catalogOpen) {
      state.novel.settingsOpen = false;
      state.novel.textSearchOpen = false;
    }
    state.novel.pendingScrollRatio = ratio;
    renderView();
    restoreReaderScroll();
  }

  function toggleSettings(force) {
    const ratio = state.novel.chapter ? currentReaderRatio() : 0;
    state.novel.settingsOpen = force === undefined ? !state.novel.settingsOpen : Boolean(force);
    if (state.novel.settingsOpen) {
      state.novel.catalogOpen = false;
      state.novel.textSearchOpen = false;
    }
    state.novel.pendingScrollRatio = ratio;
    renderView();
    restoreReaderScroll();
  }

  function toggleTextSearch(force) {
    const ratio = state.novel.chapter ? currentReaderRatio() : 0;
    state.novel.textSearchOpen = force === undefined ? !state.novel.textSearchOpen : Boolean(force);
    if (state.novel.textSearchOpen) {
      state.novel.catalogOpen = false;
      state.novel.settingsOpen = false;
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

  function scrollReaderToRatio(inputRatio) {
    const ratio = clampRatio(inputRatio);
    const page = document.querySelector(".novel-reader-page");
    if (!page) return;
    const top = page.getBoundingClientRect().top + window.scrollY;
    const readable = Math.max(0, page.scrollHeight - window.innerHeight);
    window.scrollTo({ top: top + readable * ratio, left: 0, behavior: "auto" });
  }

  function updateReaderProgressUi(inputRatio = currentReaderRatio()) {
    if (!state.novel?.book || !state.novel?.chapter) return;
    const ratio = clampRatio(inputRatio);
    const progress = readingProgress(state.novel.book, state.novel.chapters, state.novel.chapter.index, ratio);
    const summary = document.querySelector("[data-novel-progress-summary]");
    const fill = document.querySelector("[data-novel-progress-fill]");
    const slider = document.querySelector("[data-novel-chapter-slider]");
    if (summary) summary.textContent = readerProgressSummary(progress);
    if (fill) fill.style.width = `${progress.overallRatio * 100}%`;
    if (slider && document.activeElement !== slider) slider.value = String(Math.round(ratio * 100));
  }

  function restoreReaderScroll() {
    const ratio = Math.max(0, Math.min(1, Number(state.novel.pendingScrollRatio || 0)));
    state.novel.pendingScrollRatio = 0;
    window.requestAnimationFrame(() => {
      const page = document.querySelector(".novel-reader-page");
      if (!page) return;
      if (ratio <= 0.001) {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
        updateReaderProgressUi(0);
        return;
      }
      const top = page.getBoundingClientRect().top + window.scrollY;
      const readable = Math.max(0, page.scrollHeight - window.innerHeight);
      window.scrollTo({ top: top + readable * ratio, left: 0, behavior: "auto" });
      updateReaderProgressUi(ratio);
    });
  }

  function installScrollProgress() {
    if (scrollListenerInstalled) return;
    scrollListenerInstalled = true;
    window.addEventListener(
      "scroll",
      () => {
        if (state.activeView !== "novels" || !state.novel?.book || !state.novel?.chapter) return;
        if (progressFrame === null) {
          progressFrame = window.requestAnimationFrame(() => {
            progressFrame = null;
            updateReaderProgressUi();
          });
        }
        window.clearTimeout(progressTimer);
        progressTimer = window.setTimeout(saveProgress, 500);
      },
      { passive: true }
    );
  }

  function saveProgress() {
    const book = state.novel?.book;
    const chapter = state.novel?.chapter;
    if (!book || !chapter) return;
    const ratio = currentReaderRatio();
    api(`/api/novels/${encodeURIComponent(book.id)}/progress`, {
      method: "POST",
      body: { chapterIndex: chapter.index, scrollRatio: ratio }
    }).catch(() => {});
  }

  function installReaderKeyboard() {
    if (keyboardListenerInstalled) return;
    keyboardListenerInstalled = true;
    window.addEventListener("keydown", (event) => {
      if (state.activeView !== "novels" || !state.novel?.chapter) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, select, textarea, button, a")) return;
      if (event.key === "Escape" && (state.novel.catalogOpen || state.novel.settingsOpen || state.novel.textSearchOpen)) {
        event.preventDefault();
        const ratio = currentReaderRatio();
        state.novel.catalogOpen = false;
        state.novel.settingsOpen = false;
        state.novel.textSearchOpen = false;
        state.novel.pendingScrollRatio = ratio;
        renderView();
        restoreReaderScroll();
        return;
      }
      if (state.novel.catalogOpen || state.novel.settingsOpen || state.novel.textSearchOpen) return;
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
  const remainingChars = Math.max(0, Number(book.charCount || 0) * (1 - overallRatio));

  return {
    chapterCount,
    chapterIndex: currentIndex,
    chapterRatio: currentRatio,
    overallRatio,
    remainingChars
  };
}

function readerProgressSummary(progress) {
  const whole = Math.round(progress.overallRatio * 1000) / 10;
  const chapter = Math.round(progress.chapterRatio * 100);
  const remaining = progress.remainingChars > 0
    ? formatRemainingReadingTime(progress.remainingChars)
    : progress.overallRatio >= 0.999 ? "已读完" : "";
  return `全书 ${whole}% · 本章 ${chapter}%${remaining ? ` · ${remaining}` : ""}`;
}

function formatRemainingReadingTime(chars) {
  const minutes = Math.ceil(Math.max(0, Number(chars || 0)) / NOVEL_READING_CHARS_PER_MINUTE);
  if (!minutes) return "";
  if (minutes < 60) return `约剩 ${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!rest) return `约剩 ${hours} 小时`;
  return `约剩 ${hours} 小时 ${rest} 分钟`;
}

function clampRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function appendHighlightedText(target, text, query) {
  const source = String(text || "");
  const needle = String(query || "").trim();
  if (!needle) {
    target.textContent = source;
    return;
  }
  const lowerSource = source.toLocaleLowerCase();
  const lowerNeedle = needle.toLocaleLowerCase();
  let offset = 0;
  let highlights = 0;
  while (offset < source.length && highlights < 20) {
    const index = lowerSource.indexOf(lowerNeedle, offset);
    if (index < 0) break;
    if (index > offset) target.append(document.createTextNode(source.slice(offset, index)));
    const mark = document.createElement("mark");
    mark.textContent = source.slice(index, index + needle.length);
    target.append(mark);
    highlights += 1;
    offset = index + Math.max(1, needle.length);
  }
  if (offset < source.length) target.append(document.createTextNode(source.slice(offset)));
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
    fontSize: clampNumber(input.fontSize, 16, 30, 20),
    lineHeight: clampNumber(input.lineHeight, 1.5, 2.4, 1.9),
    width: clampNumber(input.width, 680, 980, 820)
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
