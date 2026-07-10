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
  let scrollListenerInstalled = false;

  function ensureState() {
    if (!state.novel) state.novel = {};
    state.novel.query = state.novel.query || "";
    state.novel.category = state.novel.category || "all";
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
    state.novel.settings = normalizeSettings(state.novel.settings || readSettings());
    installScrollProgress();
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
    if (state.novel.category && state.novel.category !== "all") params.set("category", state.novel.category);
    if (state.novel.sort && state.novel.sort !== "updated") params.set("sort", state.novel.sort);
    const data = await api(`/api/novels${params.toString() ? `?${params}` : ""}`);
    state.novel.data = data;
    state.novel.summary = data.summary || state.novel.summary;
    state.novel.loading = false;
    state.novel.status = data.total ? "" : "这里还没有小说，先运行“刷新小说书库”。";
    renderStats();
    renderView();
    if (!options.skipRoute) {
      const writer = options.replaceRoute ? replaceRoute : pushRoute;
      writer({ view: "novels", novelBookId: "", novelChapterIndex: "" });
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
    setReaderBodyClass();
    renderView();
    const data = await api(`/api/novels/${encodeURIComponent(bookId)}`);
    state.novel.book = data.book;
    state.novel.chapters = data.chapters || [];
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
    title.textContent = "小说书库";
    const meta = document.createElement("p");
    const totals = summary.totals || {};
    meta.textContent = `${formatNumber(totals.books || 0)} 本 · ${formatNumber(totals.chapters || 0)} 章 · ${formatBytes(totals.bytes || 0)}`;
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

    const controls = document.createElement("div");
    controls.className = "novel-controls";
    const search = document.createElement("label");
    search.className = "novel-search";
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.placeholder = "搜索书名、作者、分类或章节";
    searchInput.value = state.novel.query || "";
    searchInput.addEventListener("input", () => {
      state.novel.query = searchInput.value.trim();
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => loadNovels({ replaceRoute: true }).catch(() => {}), 260);
    });
    search.append(searchInput);
    const sort = document.createElement("select");
    sort.className = "novel-sort";
    for (const option of [
      ["updated", "最近更新"],
      ["progress", "最近阅读"],
      ["chapters", "章节最多"],
      ["size", "文件最大"],
      ["title", "书名"]
    ]) {
      const item = document.createElement("option");
      item.value = option[0];
      item.textContent = option[1];
      sort.append(item);
    }
    sort.value = state.novel.sort || "updated";
    sort.addEventListener("change", () => {
      state.novel.sort = sort.value;
      loadNovels({ replaceRoute: true }).catch(() => {});
    });
    controls.append(search, sort);

    const categories = document.createElement("div");
    categories.className = "novel-category-row";
    categories.append(categoryButton("all", "全部", summary.totals?.books || 0));
    for (const item of data.facets || summary.categories || []) {
      categories.append(categoryButton(item.name, item.name, item.count));
    }

    const recent = renderRecent(summary.recent || []);
    const list = document.createElement("div");
    list.className = "novel-book-list";
    for (const book of data.books || []) {
      list.append(renderBookRow(book));
    }
    if (!(data.books || []).length) {
      const empty = document.createElement("div");
      empty.className = "novel-empty-card";
      empty.textContent = state.novel.status || "没有匹配的小说。";
      list.append(empty);
    }

    shell.append(head, controls, categories);
    if (state.novel.status) {
      const status = document.createElement("div");
      status.className = "novel-status-line";
      status.textContent = state.novel.status;
      shell.append(status);
    }
    if (recent) shell.append(recent);
    shell.append(list);
    els.workGrid.append(shell);
  }

  function categoryButton(value, label, count) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `novel-chip${state.novel.category === value ? " active" : ""}`;
    button.textContent = `${label} ${formatNumber(count || 0)}`;
    button.addEventListener("click", () => {
      if (state.novel.category === value) return;
      state.novel.category = value;
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
      span.textContent = `第 ${book.progress?.chapterIndex || 1} 章 · ${Math.round((book.progress?.scrollRatio || 0) * 100)}%`;
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
      ["编码", book.encoding || "-"]
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
    grid.className = "novel-catalog-grid";
    for (const chapter of chapters) {
      grid.append(chapterButton(chapter, false));
    }
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
    title.textContent = "章节目录";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";
    close.addEventListener("click", () => toggleCatalog(false));
    head.append(title, close);
    const list = document.createElement("div");
    list.className = "novel-reader-catalog-list";
    for (const chapter of state.novel.chapters || []) {
      list.append(chapterButton(chapter, true));
    }
    panel.append(head, list);
    wrap.append(panel);
    wrap.addEventListener("click", (event) => {
      if (event.target === wrap) toggleCatalog(false);
    });
    return wrap;
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
    button.textContent = chapter.title;
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
    setReaderBodyClass();
    if (!state.novel.data) loadNovels({ skipRoute: true }).catch(() => {});
    renderStats();
    renderView();
    pushRoute({ view: "novels", novelBookId: "", novelChapterIndex: "" });
  }

  function toggleCatalog(force) {
    state.novel.catalogOpen = force === undefined ? !state.novel.catalogOpen : Boolean(force);
    if (state.novel.catalogOpen) state.novel.settingsOpen = false;
    renderView();
  }

  function toggleSettings(force) {
    state.novel.settingsOpen = force === undefined ? !state.novel.settingsOpen : Boolean(force);
    if (state.novel.settingsOpen) state.novel.catalogOpen = false;
    renderView();
  }

  function updateSettings(patch) {
    state.novel.settings = normalizeSettings({ ...state.novel.settings, ...patch });
    writeSettings(state.novel.settings);
    setReaderBodyClass();
    renderView();
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
    const page = document.querySelector(".novel-reader-page");
    if (!page) return;
    const top = page.getBoundingClientRect().top + window.scrollY;
    const readable = Math.max(1, page.scrollHeight - window.innerHeight);
    const ratio = Math.max(0, Math.min(1, (window.scrollY - top) / readable));
    api(`/api/novels/${encodeURIComponent(book.id)}/progress`, {
      method: "POST",
      body: { chapterIndex: chapter.index, scrollRatio: ratio }
    }).catch(() => {});
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
