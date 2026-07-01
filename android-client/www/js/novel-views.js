import { fetchJson, postJson } from "./api.js?v=20260701-novel-reader-05";
import { cacheAgeText, readCachedJson, writeCachedJson } from "./cache.js?v=20260701-novel-reader-05";
import { formatBytes, formatNumber } from "./format.js";

const NOVEL_SETTINGS_KEY = "fanhao.android.novel.settings";
const DEFAULT_QUERY_STATE = {
  query: "",
  category: "all",
  sort: "updated"
};

export function createNovelViews(context) {
  const {
    els,
    getActiveUrl,
    showView,
    goBack = () => window.history.back(),
    setActiveBottom,
    renderCurrentView,
    renderCurrentViewPreservingScroll,
    setStatus
  } = context;

  const listState = { ...DEFAULT_QUERY_STATE, uploading: false };
  const localBooks = new Map();
  let importingNativeText = false;
  let cachingBookId = "";
  const readerState = {
    active: false,
    book: null,
    chapter: null,
    progressTimer: null,
    settings: normalizeSettings(readSettings()),
    menuOpen: false,
    settingsOpen: false,
    catalogOpen: false,
    pendingScrollRatio: 0,
    nativeBrightnessSet: false
  };

  installReaderProgress();
  installNativeTextIntentHandler();
  installReaderLifecycle();

  async function renderNovelList(isActive = () => true) {
    deactivateReader();
    setActiveBottom("novels");
    els.viewKicker.textContent = "本地小说";
    els.viewTitle.textContent = "小说书库";
    els.viewMeta.textContent = "正在读取";
    els.viewContent.innerHTML = `<div class="loading-row">正在读取小说书库</div>`;

    const path = novelListPath();
    const activeUrl = getActiveUrl();
    let renderedCache = false;
    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload?.books) {
      renderedCache = true;
      renderNovelListData(cached.payload, cached);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 16000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      renderNovelListData(data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存小说。", "quiet", false);
      } else {
        renderMessage(error.message || "小说书库读取失败", "error");
      }
    }
  }

  function renderNovelListData(data = {}, cacheEntry = null) {
    const books = Array.isArray(data.books) ? data.books : [];
    const summary = data.summary || {};
    const totals = summary.totals || {};
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";

    els.viewKicker.textContent = "本地小说";
    els.viewTitle.textContent = "小说书库";
    els.viewMeta.textContent = `${formatNumber(data.total || books.length)} 本 · ${formatNumber(totals.chapters || 0)} 章${suffix}`;
    els.viewContent.innerHTML = "";

    els.viewContent.append(createNovelControls(data));
    const recent = createRecentStrip(summary.recent || []);
    if (recent) els.viewContent.append(recent);

    if (!books.length) {
      renderMessage(listState.query ? `没有搜到「${listState.query}」。` : "小说书库还没有书。", "quiet", false);
      return;
    }

    const list = document.createElement("div");
    list.className = "novel-mobile-list";
    for (const book of books) list.append(createNovelCard(book));
    els.viewContent.append(list);
  }

  function createNovelControls(data = {}) {
    const wrap = document.createElement("div");
    wrap.className = "novel-mobile-controls";

    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "搜索书名、作者、分类";
    search.value = listState.query;
    search.addEventListener("change", () => {
      listState.query = search.value.trim();
      renderCurrentView();
    });

    const sort = document.createElement("select");
    for (const [value, label] of [
      ["updated", "最近更新"],
      ["progress", "最近阅读"],
      ["chapters", "章节最多"],
      ["size", "文件最大"],
      ["title", "书名"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      sort.append(option);
    }
    sort.value = listState.sort;
    sort.addEventListener("change", () => {
      listState.sort = sort.value;
      renderCurrentView();
    });

    const uploadInput = document.createElement("input");
    uploadInput.type = "file";
    uploadInput.accept = ".txt,text/plain";
    uploadInput.multiple = true;
    uploadInput.className = "novel-mobile-upload-input";
    uploadInput.addEventListener("change", () => {
      const files = Array.from(uploadInput.files || []);
      uploadInput.value = "";
      uploadNovelFiles(files);
    });

    const upload = document.createElement("button");
    upload.type = "button";
    upload.className = "novel-mobile-upload";
    upload.textContent = listState.uploading ? "上传中" : "上传TXT";
    upload.disabled = listState.uploading;
    upload.addEventListener("click", () => uploadInput.click());

    const categoryRow = document.createElement("div");
    categoryRow.className = "novel-mobile-category-row";
    categoryRow.append(createCategoryButton("all", "全部", data.summary?.totals?.books || data.total || 0));
    for (const item of data.facets || data.summary?.categories || []) {
      categoryRow.append(createCategoryButton(item.name, item.name, item.count));
    }

    wrap.append(search, sort, uploadInput, upload, categoryRow);
    return wrap;
  }

  function createCategoryButton(value, label, count) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = listState.category === value ? "active" : "";
    button.textContent = `${displayCategory(label)} ${formatNumber(count || 0)}`;
    button.addEventListener("click", () => {
      if (listState.category === value) return;
      listState.category = value || "all";
      renderCurrentViewPreservingScroll();
    });
    return button;
  }

  function createRecentStrip(items = []) {
    if (!items.length) return null;
    const panel = document.createElement("section");
    panel.className = "novel-mobile-recent";
    const title = document.createElement("strong");
    title.textContent = "继续阅读";
    const row = document.createElement("div");
    for (const book of items) row.append(createRecentButton(book));
    panel.append(title, row);
    return panel;
  }

  function createRecentButton(book) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "novel-mobile-recent-card";
    button.addEventListener("click", () => openReader(book));
    const title = document.createElement("strong");
    title.textContent = book.title || "未命名小说";
    const meta = document.createElement("span");
    meta.textContent = `第 ${book.progress?.chapterIndex || 1} 章 · ${Math.round((book.progress?.scrollRatio || 0) * 100)}%`;
    button.append(title, meta);
    return button;
  }

  function readingProgressText(book = {}) {
    const progress = book.progress || null;
    if (!progress) return book.chapterCount ? `共 ${formatNumber(book.chapterCount)} 章` : "未读";
    const chapterCount = Math.max(1, Number(book.chapterCount || 0));
    const chapterIndex = Math.max(1, Number(progress.chapterIndex || 1));
    const scrollRatio = Math.max(0, Math.min(1, Number(progress.scrollRatio || 0)));
    const ratio = chapterCount
      ? Math.min(1, ((chapterIndex - 1) + scrollRatio) / chapterCount)
      : scrollRatio;
    return `已读 ${Math.round(ratio * 1000) / 10}%`;
  }

  function createNovelCard(book = {}) {
    const card = document.createElement("article");
    card.className = "novel-mobile-card";
    card.role = "button";
    card.tabIndex = 0;
    const openDetail = () => {
      if (book.id) showView("novelDetail", { id: book.id }, { push: true });
      else openReader(book);
    };
    let detailTimer = null;
    let lastTapAt = 0;
    card.addEventListener("click", () => {
      const now = Date.now();
      window.clearTimeout(detailTimer);
      if (now - lastTapAt < 900) {
        lastTapAt = 0;
        openReader(book);
        return;
      }
      lastTapAt = now;
      detailTimer = window.setTimeout(() => {
        lastTapAt = 0;
        openDetail();
      }, 650);
    });
    card.addEventListener("dblclick", (event) => {
      event.preventDefault();
      window.clearTimeout(detailTimer);
      openReader(book);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (event.key === " ") openReader(book);
      else openDetail();
    });

    const cover = createCover(book);
    const body = document.createElement("div");
    body.className = "novel-mobile-card-body";
    const title = document.createElement("strong");
    title.textContent = book.title || "未命名小说";
    const meta = document.createElement("span");
    meta.textContent = [book.author || "未知作者", displayCategory(book.category), `${formatNumber(book.chapterCount)} 章`, formatBytes(book.sizeBytes)].filter(Boolean).join(" · ");
    const summary = document.createElement("p");
    summary.textContent = book.summary || book.latestChapterTitle || book.relativePath || "";
    const progress = document.createElement("small");
    progress.className = "novel-mobile-card-progress";
    progress.textContent = readingProgressText(book);
    const latest = document.createElement("small");
    latest.className = "novel-mobile-card-chapter";
    latest.textContent = book.progress
      ? `读到第 ${book.progress.chapterIndex || 1} 章`
      : book.latestChapterTitle
        ? book.latestChapterTitle
        : "本地 TXT";

    const actions = document.createElement("div");
    actions.className = "novel-mobile-card-actions";
    const detail = document.createElement("button");
    detail.type = "button";
    detail.textContent = "详情";
    detail.addEventListener("click", (event) => {
      event.stopPropagation();
      showView("novelDetail", { id: book.id }, { push: true });
    });
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "下载";
    download.addEventListener("click", (event) => {
      event.stopPropagation();
      downloadBook(book.id);
    });
    actions.append(detail, download);

    body.append(title, progress, latest, meta, summary, actions);
    card.append(cover, body);
    return card;
  }

  async function renderNovelDetail(id, isActive = () => true) {
    deactivateReader();
    const bookId = String(id || "").trim();
    const path = novelDetailPath(bookId);
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    setActiveBottom("novels");
    els.viewKicker.textContent = "小说详情";
    els.viewTitle.textContent = "小说";
    els.viewMeta.textContent = "正在读取";
    els.viewContent.innerHTML = `<div class="loading-row">正在读取书籍详情</div>`;

    if (!bookId) {
      renderMessage("书籍 ID 无效。", "error");
      return;
    }

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload?.book) {
      renderedCache = true;
      renderNovelDetailData(cached.payload, cached);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 16000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      renderNovelDetailData(data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存详情。", "quiet", false);
      } else {
        renderMessage(error.message || "书籍详情读取失败", "error");
      }
    }
  }

  function renderNovelDetailData(data = {}, cacheEntry = null) {
    const book = data.book || {};
    const chapters = Array.isArray(data.chapters) ? data.chapters : [];
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";

    els.viewKicker.textContent = displayCategory(book.category) || "小说";
    els.viewTitle.textContent = book.title || "小说详情";
    els.viewMeta.textContent = `${formatNumber(chapters.length || book.chapterCount || 0)} 章 · ${formatBytes(book.sizeBytes)}${suffix}`;
    els.viewContent.innerHTML = "";

    els.viewContent.append(createDetailHero(book, chapters));
    if (book.summary) {
      const summary = document.createElement("section");
      summary.className = "novel-mobile-summary-panel";
      const title = document.createElement("strong");
      title.textContent = "作品简介";
      const text = document.createElement("p");
      text.textContent = book.summary;
      summary.append(title, text);
      els.viewContent.append(summary);
    }

    const catalog = document.createElement("section");
    catalog.className = "novel-mobile-catalog";
    const head = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "目录";
    const meta = document.createElement("span");
    meta.textContent = `${formatNumber(chapters.length)} 章`;
    head.append(title, meta);
    const list = document.createElement("div");
    chapters.forEach((chapter) => list.append(createChapterButton(book, chapter)));
    catalog.append(head, list);
    els.viewContent.append(catalog);
  }

  function createDetailHero(book, chapters) {
    const panel = document.createElement("section");
    panel.className = "novel-mobile-detail-hero";
    panel.append(createCover(book, "large"));

    const body = document.createElement("div");
    body.className = "novel-mobile-detail-body";
    const title = document.createElement("strong");
    title.textContent = book.title || "未命名小说";
    const meta = document.createElement("span");
    meta.textContent = [book.author || "未知作者", displayCategory(book.category), `${formatNumber(book.chapterCount)} 章`, formatBytes(book.sizeBytes)].filter(Boolean).join(" · ");
    const latest = document.createElement("small");
    latest.textContent = book.latestChapterTitle ? `最新：${book.latestChapterTitle}` : "本地 TXT 导入";

    const actions = document.createElement("div");
    actions.className = "novel-mobile-detail-actions";
    const read = document.createElement("button");
    read.type = "button";
    read.className = "primary";
    read.textContent = book.progress ? "继续阅读" : "开始阅读";
    read.addEventListener("click", () => openReader(book, chapters[0]?.index || 1));
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "下载TXT";
    download.addEventListener("click", () => downloadBook(book.id));
    const cache = document.createElement("button");
    cache.type = "button";
    cache.textContent = cachingBookId === book.id ? "缓存中" : "缓存整本";
    cache.disabled = Boolean(cachingBookId);
    cache.addEventListener("click", () => cacheWholeBook(book, chapters));
    actions.append(read, download, cache);

    body.append(title, meta, latest, actions);
    panel.append(body);
    return panel;
  }

  function createChapterButton(book, chapter = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "novel-mobile-chapter";
    if (book.progress?.chapterIndex === chapter.index) button.classList.add("active");
    button.addEventListener("click", () => showView("novelReader", { id: book.id, chapterIndex: String(chapter.index || 1) }, { push: true }));
    const title = document.createElement("strong");
    title.textContent = chapter.title || `第 ${chapter.index || ""} 章`.trim();
    const meta = document.createElement("span");
    meta.textContent = `${formatNumber(chapter.charCount || 0)} 字`;
    button.append(title, meta);
    return button;
  }

  async function renderNovelReader(id, chapterIndex, isActive = () => true) {
    const bookId = String(id || "").trim();
    const index = String(chapterIndex || "1").trim();
    const path = novelChapterPath(bookId, index);
    const activeUrl = getActiveUrl();
    let renderedCache = false;

    readerState.active = true;
    readerState.catalogOpen = false;
    readerState.settingsOpen = false;
    readerState.menuOpen = false;
    setActiveBottom("novels");
    els.viewKicker.textContent = "小说阅读";
    els.viewTitle.textContent = "章节";
    els.viewMeta.textContent = "正在读取";
    els.viewContent.innerHTML = `<div class="loading-row">正在翻开章节</div>`;

    if (!bookId || !index) {
      renderMessage("章节参数无效。", "error");
      return;
    }

    if (isLocalBookId(bookId)) {
      renderLocalNovelReader(bookId, index);
      return;
    }

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload?.chapter) {
      renderedCache = true;
      renderNovelReaderData(cached.payload, cached);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 18000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      renderNovelReaderData(data);
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存章节。", "quiet", false);
      } else {
        renderMessage(error.message || "章节读取失败", "error");
      }
    }
  }

  function renderNovelReaderData(data = {}, cacheEntry = null, options = {}) {
    const book = data.book || {};
    const chapter = data.chapter || {};
    const settings = readerState.settings;
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
    if (settings.menuPinned) readerState.menuOpen = true;

    readerState.book = book;
    readerState.chapter = chapter;
    readerState.prev = data.prev || null;
    readerState.next = data.next || null;
    readerState.chapters = Array.isArray(data.chapters) ? data.chapters : [];
    if (options.restore !== false) {
      readerState.pendingScrollRatio = Number(book.progress?.chapterIndex || 0) === Number(chapter.index || 0)
        ? Number(book.progress?.scrollRatio || 0)
        : 0;
    }

    els.viewKicker.textContent = book.title || "小说阅读";
    els.viewTitle.textContent = chapter.title || "章节";
    els.viewMeta.textContent = `${book.author || "未知作者"} · ${formatNumber(chapter.charCount || 0)} 字${suffix}`;
    els.viewContent.innerHTML = "";

    const screen = document.createElement("article");
    screen.className = [
      "novel-reader-screen",
      `theme-${settings.theme}`,
      `mode-${settings.readingMode}`,
      settings.night ? "night" : "",
      settings.eyeCare ? "eye-care" : "",
      readerState.menuOpen ? "menu-open" : ""
    ].filter(Boolean).join(" ");
    screen.style.setProperty("--novel-reader-font", `${settings.fontSize}px`);
    screen.style.setProperty("--novel-reader-line", String(settings.lineHeight));
    screen.style.setProperty("--novel-reader-dim", brightnessDim(settings.brightness));
    applyNativeReaderBrightness(settings.brightness);
    screen.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("button, input, select, a, .novel-reader-toolbar, .novel-reader-settings-panel, .novel-reader-catalog-drawer")) return;
      toggleReaderMenu();
    });

    const dimmer = document.createElement("div");
    dimmer.className = "novel-reader-dimmer";
    dimmer.setAttribute("aria-hidden", "true");

    const topBar = document.createElement("div");
    topBar.className = "novel-reader-topbar";
    const back = actionButton("返回", () => goBack());
    back.className = "novel-reader-back";
    const topTitle = document.createElement("div");
    topTitle.className = "novel-reader-top-title";
    const bookName = document.createElement("strong");
    bookName.textContent = book.title || "小说阅读";
    const chapterName = document.createElement("span");
    chapterName.textContent = chapter.title || "章节";
    topTitle.append(bookName, chapterName);
    topBar.append(back, topTitle);

    const title = document.createElement("h1");
    title.textContent = chapter.title || "章节";
    const meta = document.createElement("div");
    meta.className = "novel-reader-meta";
    meta.textContent = [book.title, book.author || "未知作者", `${formatNumber(chapter.charCount || 0)} 字`].filter(Boolean).join(" · ");

    const content = document.createElement("div");
    content.className = "novel-reader-content";
    content.addEventListener("scroll", scheduleReaderProgress, { passive: true });
    for (const paragraph of paragraphsFromContent(chapter.content)) {
      const p = document.createElement("p");
      p.textContent = paragraph;
      content.append(p);
    }

    const ratioForControls = Number(options.restoreRatio ?? readerState.pendingScrollRatio ?? (
      Number(book.progress?.chapterIndex || 0) === Number(chapter.index || 0) ? book.progress?.scrollRatio : 0
    ) ?? 0);
    const toolbar = createReaderToolbar(Math.max(0, Math.min(1, ratioForControls)));

    screen.append(dimmer, topBar, title, meta, content, toolbar);
    if (readerState.settingsOpen) screen.append(createReaderSettingsPanel());
    els.viewContent.append(screen);
    if (readerState.catalogOpen) els.viewContent.append(createCatalogDrawer());
    if (options.restoreRatio !== undefined) restoreReaderScroll(options.restoreRatio);
    else if (options.restore !== false) restoreReaderScroll();
  }

  function createCatalogDrawer() {
    const drawer = document.createElement("aside");
    drawer.className = "novel-reader-catalog-drawer";
    const head = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = "目录";
    const close = actionButton("关闭", () => toggleCatalog(false));
    head.append(title, close);
    const list = document.createElement("div");
    for (const chapter of readerState.chapters || []) {
      const button = createChapterButton(readerState.book, chapter);
      if (chapter.index === readerState.chapter?.index) button.classList.add("active");
      list.append(button);
    }
    drawer.append(head, list);
    return drawer;
  }

  function createReaderSettingsPanel() {
    const settings = readerState.settings;
    const panel = document.createElement("div");
    panel.className = "novel-reader-settings-panel";

    panel.append(
      createSliderRow("亮度", `${settings.brightness}%`, {
        min: 35,
        max: 100,
        step: 5,
        value: settings.brightness,
        onInput: (value) => updateSettings({ brightness: value }, { live: true })
      }),
      createStepperRow("字号", `${settings.fontSize}px`, [
        { label: "A-", onClick: () => updateSettings({ fontSize: settings.fontSize - 1 }) },
        { label: "A+", onClick: () => updateSettings({ fontSize: settings.fontSize + 1 }) }
      ]),
      createStepperRow("行距", settings.lineHeight.toFixed(2), [
        { label: "紧", onClick: () => updateSettings({ lineHeight: settings.lineHeight - 0.08 }) },
        { label: "松", onClick: () => updateSettings({ lineHeight: settings.lineHeight + 0.08 }) }
      ]),
      createOptionRow("背景", [
        { value: "paper", label: "纸页" },
        { value: "white", label: "白底" },
        { value: "green", label: "护眼底" },
        { value: "rose", label: "暖粉" }
      ], settings.theme, (theme) => updateSettings({ theme, night: false })),
      createOptionRow("阅读方式", [
        { value: "scroll", label: "滚动" },
        { value: "page", label: "翻页" }
      ], settings.readingMode, (readingMode) => updateSettings({ readingMode })),
      createSwitchRow("护眼模式", settings.eyeCare, (eyeCare) => updateSettings({ eyeCare, night: false })),
      createSwitchRow("夜间模式", settings.night, (night) => updateSettings({ night, eyeCare: night ? false : settings.eyeCare })),
      createSwitchRow("菜单常显", settings.menuPinned, (menuPinned) => {
        readerState.menuOpen = menuPinned;
        updateSettings({ menuPinned });
      })
    );
    return panel;
  }

  function createReaderToolbar(ratio = 0) {
    const toolbar = document.createElement("nav");
    toolbar.className = "novel-reader-toolbar";

    const progressRow = document.createElement("div");
    progressRow.className = "novel-reader-progress-row";
    const prev = actionButton("上一章", () => openAdjacent(-1), !readerState.prev);
    prev.className = "novel-reader-page-button";
    const next = actionButton("下一章", () => openAdjacent(1), !readerState.next);
    next.className = "novel-reader-page-button";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(Math.round(ratio * 100));
    slider.setAttribute("aria-label", "阅读进度");
    slider.addEventListener("input", () => scrollReaderToRatio(Number(slider.value) / 100));
    slider.addEventListener("change", scheduleReaderProgress);
    progressRow.append(prev, slider, next);

    const actionRow = document.createElement("div");
    actionRow.className = "novel-reader-action-row";
    actionRow.append(
      readerToolButton("目录", () => toggleCatalog()),
      readerToolButton("亮度", () => toggleSettingsPanel()),
      readerToolButton(readerState.settings.night ? "日间" : "夜间", () => updateSettings({ night: !readerState.settings.night, eyeCare: false })),
      readerToolButton("设置", () => toggleSettingsPanel())
    );

    toolbar.append(progressRow, actionRow);
    return toolbar;
  }

  function createSliderRow(label, valueText, options = {}) {
    const row = document.createElement("label");
    row.className = "novel-reader-setting-row novel-reader-slider-row";
    const title = document.createElement("span");
    title.textContent = label;
    const value = document.createElement("strong");
    value.textContent = valueText;
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(options.min ?? 0);
    input.max = String(options.max ?? 100);
    input.step = String(options.step ?? 1);
    input.value = String(options.value ?? 0);
    input.addEventListener("input", () => options.onInput?.(Number(input.value)));
    row.append(title, value, input);
    return row;
  }

  function createStepperRow(label, valueText, actions = []) {
    const row = document.createElement("div");
    row.className = "novel-reader-setting-row novel-reader-stepper-row";
    const title = document.createElement("span");
    title.textContent = label;
    const value = document.createElement("strong");
    value.textContent = valueText;
    const buttons = document.createElement("div");
    for (const action of actions) buttons.append(actionButton(action.label, action.onClick));
    row.append(title, value, buttons);
    return row;
  }

  function createOptionRow(label, options, activeValue, onSelect) {
    const row = document.createElement("div");
    row.className = "novel-reader-setting-row novel-reader-option-row";
    const title = document.createElement("span");
    title.textContent = label;
    const buttons = document.createElement("div");
    for (const option of options) {
      const button = actionButton(option.label, () => onSelect(option.value));
      button.classList.toggle("active", option.value === activeValue);
      buttons.append(button);
    }
    row.append(title, buttons);
    return row;
  }

  function createSwitchRow(label, checked, onToggle) {
    const row = document.createElement("div");
    row.className = "novel-reader-setting-row novel-reader-switch-row";
    const title = document.createElement("span");
    title.textContent = label;
    const button = actionButton(checked ? "开启" : "关闭", () => onToggle(!checked));
    button.classList.toggle("active", checked);
    row.append(title, button);
    return row;
  }

  function actionButton(label, handler, disabled = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = disabled;
    button.addEventListener("click", handler);
    return button;
  }

  function readerToolButton(label, handler, disabled = false) {
    const button = actionButton(label, handler, disabled);
    button.className = "novel-reader-tool-button";
    return button;
  }

  function toggleCatalog(force) {
    const ratio = captureReaderRatio();
    readerState.catalogOpen = force === undefined ? !readerState.catalogOpen : Boolean(force);
    if (readerState.catalogOpen) {
      readerState.menuOpen = true;
      readerState.settingsOpen = false;
    }
    renderNovelReaderData({
      book: readerState.book,
      chapter: readerState.chapter,
      chapters: readerState.chapters,
      prev: readerState.prev,
      next: readerState.next
    }, null, { restoreRatio: ratio });
  }

  function toggleReaderMenu(force) {
    const ratio = captureReaderRatio();
    readerState.menuOpen = force === undefined ? !readerState.menuOpen : Boolean(force);
    if (!readerState.menuOpen) {
      readerState.settingsOpen = false;
      readerState.catalogOpen = false;
    }
    renderNovelReaderData(currentReaderData(), null, { restoreRatio: ratio });
  }

  function toggleSettingsPanel() {
    const ratio = captureReaderRatio();
    readerState.menuOpen = true;
    readerState.settingsOpen = !readerState.settingsOpen;
    if (readerState.settingsOpen) readerState.catalogOpen = false;
    renderNovelReaderData(currentReaderData(), null, { restoreRatio: ratio });
  }

  function openAdjacent(direction) {
    const target = direction < 0 ? readerState.prev : readerState.next;
    if (!target || !readerState.book?.id) return;
    showView("novelReader", { id: readerState.book.id, chapterIndex: String(target.index || 1) }, { push: true });
  }

  function openReader(book = {}, fallbackIndex = 1) {
    if (!book?.id) return;
    showView("novelReader", {
      id: book.id,
      chapterIndex: String(book.progress?.chapterIndex || fallbackIndex || 1)
    }, { push: true });
  }

  function createCover(book = {}, size = "") {
    const cover = document.createElement("div");
    cover.className = `novel-mobile-cover ${size}`.trim();
    const label = document.createElement("span");
    label.textContent = displayCategory(book.category || "小说").slice(0, 4);
    const title = document.createElement("strong");
    title.textContent = book.title || "小说";
    cover.append(label, title);
    return cover;
  }

  function uploadNovelFiles(files = []) {
    const txtFiles = files.filter((file) => file && (/\.txt$/i.test(file.name) || String(file.type || "").startsWith("text/")));
    if (!txtFiles.length) return;
    listState.uploading = true;
    setStatus?.(`正在上传 ${formatNumber(txtFiles.length)} 本小说`);
    renderCurrentView();

    Promise.resolve()
      .then(async () => {
        let uploaded = 0;
        for (const file of txtFiles) {
          const decoded = await readNovelFileText(file);
          await postJson(getActiveUrl(), "/api/novels/upload", {
            fileName: file.name,
            sizeBytes: file.size,
            encoding: decoded.encoding,
            text: decoded.text
          });
          uploaded += 1;
          setStatus?.(`已上传 ${formatNumber(uploaded)}/${formatNumber(txtFiles.length)}：${file.name}`);
        }
        listState.uploading = false;
        setStatus?.(`已上传 ${formatNumber(uploaded)} 本小说`);
        renderCurrentView();
      })
      .catch((error) => {
        listState.uploading = false;
        setStatus?.(`上传失败：${error.message || error}`, "error");
        renderCurrentView();
      });
  }

  function downloadBook(bookId) {
    if (!bookId) return;
    const href = `${getActiveUrl()}/api/novels/${encodeURIComponent(bookId)}/download`;
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noreferrer";
    document.body.append(link);
    link.click();
    link.remove();
  }

  function openLocalTextReader(file = {}) {
    const entry = createLocalBookEntry(file);
    localBooks.set(entry.book.id, entry);
    setStatus?.(`已用本地阅读器打开：${entry.book.title}`);
    showView("novelReader", { id: entry.book.id, chapterIndex: "1" }, { push: true });
  }

  function renderLocalNovelReader(bookId, chapterIndex) {
    const entry = localBooks.get(bookId);
    if (!entry) {
      renderMessage("本地文本只保留在当前打开会话中，请重新从系统文件管理器打开。", "error");
      return;
    }
    const index = Math.max(1, Number(chapterIndex || 1));
    const chapter = entry.chapters.find((item) => item.index === index) || entry.chapters[0];
    const currentIndex = entry.chapters.findIndex((item) => item.index === chapter.index);
    renderNovelReaderData({
      book: entry.book,
      chapter,
      chapters: entry.chapters.map(({ content, ...summary }) => summary),
      prev: currentIndex > 0 ? entry.chapters[currentIndex - 1] : null,
      next: currentIndex >= 0 && currentIndex < entry.chapters.length - 1 ? entry.chapters[currentIndex + 1] : null
    }, null, { restore: false });
  }

  function createLocalBookEntry(file = {}) {
    const fileName = file.fileName || "local-text.txt";
    const title = fileName.replace(/\.[^.]+$/, "") || "本地文本";
    const text = String(file.text || "").trim() || "空白文本";
    const chapters = splitLocalTextChapters(text);
    const charCount = chapters.reduce((sum, chapter) => sum + chapter.charCount, 0);
    const now = new Date().toISOString();
    const book = {
      id: `local:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      local: true,
      title,
      author: "本地文件",
      category: "本地",
      fileName,
      sizeBytes: Number(file.sizeBytes || text.length || 0),
      charCount,
      chapterCount: chapters.length,
      latestChapterTitle: chapters[chapters.length - 1]?.title || "正文",
      summary: summarizeLocalText(text),
      updatedAt: now
    };
    return {
      book,
      chapters: chapters.map((chapter) => ({
        ...chapter,
        id: `${book.id}-${String(chapter.index).padStart(5, "0")}`,
        bookId: book.id,
        updatedAt: now
      }))
    };
  }

  function splitLocalTextChapters(text) {
    const source = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    const pattern = /(?:^|\n)(第[0-9零一二三四五六七八九十百千万两]+[章节卷回部篇][^\n]{0,40}|正文\s*[0-9零一二三四五六七八九十百千万两]+|Chapter\s+\d+[^\n]{0,40})\s*\n/gi;
    const matches = Array.from(source.matchAll(pattern));
    if (matches.length >= 2) {
      const chapters = [];
      for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index];
        const start = match.index + match[0].length;
        const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
        const title = String(match[1] || `正文 ${index + 1}`).trim();
        const content = source.slice(start, end).trim() || title;
        chapters.push({ index: index + 1, title, content, charCount: content.length });
      }
      return chapters;
    }
    return chunkLocalText(source);
  }

  function chunkLocalText(text) {
    const chunks = [];
    const paragraphs = paragraphsFromContent(text);
    let buffer = [];
    let size = 0;
    for (const paragraph of paragraphs) {
      buffer.push(paragraph);
      size += paragraph.length;
      if (size >= 12000) {
        chunks.push(buffer.join("\n\n"));
        buffer = [];
        size = 0;
      }
    }
    if (buffer.length) chunks.push(buffer.join("\n\n"));
    if (!chunks.length) chunks.push(text || "空白文本");
    return chunks.map((content, index) => ({
      index: index + 1,
      title: chunks.length === 1 ? "正文" : `正文 ${index + 1}`,
      content,
      charCount: content.length
    }));
  }

  function summarizeLocalText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 260);
  }

  function isLocalBookId(bookId) {
    return String(bookId || "").startsWith("local:");
  }

  async function cacheWholeBook(book = {}, chapters = []) {
    if (!book.id || !chapters.length || cachingBookId) return;
    cachingBookId = book.id;
    setStatus?.(`正在缓存《${book.title || "小说"}》到手机本地`);
    renderNovelDetailData({ book, chapters });
    try {
      let cached = 0;
      for (const chapter of chapters) {
        const index = chapter.index || cached + 1;
        const path = novelChapterPath(book.id, index);
        const cachedEntry = await readCachedJson(getActiveUrl(), path).catch(() => null);
        if (!cachedEntry?.payload?.chapter) {
          const data = await fetchJson(getActiveUrl(), path, { timeoutMs: 22000 });
          await writeCachedJson(getActiveUrl(), path, data);
        }
        cached += 1;
        if (cached === 1 || cached === chapters.length || cached % 20 === 0) {
          setStatus?.(`已缓存 ${formatNumber(cached)}/${formatNumber(chapters.length)} 章`);
        }
      }
      setStatus?.(`《${book.title || "小说"}》已缓存到手机本地`);
    } catch (error) {
      setStatus?.(`缓存失败：${error.message || error}`, "error");
    } finally {
      cachingBookId = "";
      renderNovelDetailData({ book, chapters });
    }
  }

  function installNativeTextIntentHandler() {
    if (typeof window === "undefined") return;
    const handler = () => importPendingNativeTextFile();
    window.addEventListener("fanhaoNativeTextFile", handler);
    window.setTimeout(handler, 800);
  }

  function nativeNovelPlugin() {
    return window.Capacitor?.Plugins?.FanHaoNovel || null;
  }

  function installReaderLifecycle() {
    if (typeof window === "undefined") return;
    window.addEventListener("fanhaoViewChanged", (event) => {
      if (event.detail?.view !== "novelReader") deactivateReader();
    });
    window.addEventListener("pagehide", deactivateReader);
  }

  function deactivateReader() {
    window.clearTimeout(readerState.progressTimer);
    clearNativeReaderBrightness();
    readerState.active = false;
    readerState.menuOpen = false;
    readerState.settingsOpen = false;
    readerState.catalogOpen = false;
  }

  function applyNativeReaderBrightness(percent) {
    const plugin = nativeNovelPlugin();
    if (!readerState.active || !plugin?.setReaderBrightness) return;
    const brightness = clampNumber(percent, 35, 100, 100) / 100;
    readerState.nativeBrightnessSet = true;
    plugin.setReaderBrightness({ brightness }).catch(() => {});
  }

  function clearNativeReaderBrightness() {
    const plugin = nativeNovelPlugin();
    if (!readerState.nativeBrightnessSet || !plugin?.clearReaderBrightness) return;
    readerState.nativeBrightnessSet = false;
    plugin.clearReaderBrightness().catch(() => {});
  }

  async function importPendingNativeTextFile() {
    const plugin = nativeNovelPlugin();
    if (!plugin?.consumePendingTextFile || importingNativeText) return;
    importingNativeText = true;
    try {
      const file = await plugin.consumePendingTextFile();
      if (!file?.available || !file.text) return;
      await importNativeTextFile(file);
    } catch (error) {
      setStatus?.(`本地文本读取失败：${error.message || error}`, "error");
    } finally {
      importingNativeText = false;
    }
  }

  async function importNativeTextFile(file = {}) {
    const fileName = file.fileName || "local-text.txt";
    listState.uploading = true;
    setStatus?.(`正在导入本地文本：${fileName}`);
    renderCurrentView();
    try {
      const result = await postJson(getActiveUrl(), "/api/novels/upload", {
        fileName,
        sizeBytes: Number(file.sizeBytes || file.text.length || 0),
        encoding: file.encoding || "utf-8",
        text: file.text
      });
      listState.uploading = false;
      const book = result.book || {};
      setStatus?.(`已导入：${book.title || fileName}`);
      if (book.id) {
        showView("novelReader", { id: book.id, chapterIndex: String(book.firstChapterIndex || 1) }, { push: true });
      } else {
        renderCurrentView();
      }
    } catch (error) {
      listState.uploading = false;
      setStatus?.(`本地文本已读取，电脑书库暂不可用，已切换本地阅读。`);
      openLocalTextReader(file);
    }
  }

  function updateSettings(patch = {}, options = {}) {
    const ratio = captureReaderRatio();
    readerState.settings = normalizeSettings({ ...readerState.settings, ...patch });
    if (readerState.settings.menuPinned) readerState.menuOpen = true;
    writeSettings(readerState.settings);
    renderNovelReaderData(currentReaderData(), null, { restoreRatio: ratio, restore: !options.live });
  }

  function cycleTheme() {
    const order = ["paper", "white", "green", "rose"];
    const current = order.indexOf(readerState.settings.theme);
    updateSettings({ theme: order[(current + 1) % order.length], night: false });
  }

  function currentReaderData() {
    return {
      book: readerState.book,
      chapter: readerState.chapter,
      chapters: readerState.chapters,
      prev: readerState.prev,
      next: readerState.next
    };
  }

  function installReaderProgress() {
    window.addEventListener(
      "scroll",
      scheduleReaderProgress,
      { passive: true }
    );
  }

  function scheduleReaderProgress() {
    if (!readerState.active || !readerState.book?.id || !readerState.chapter?.index) return;
    window.clearTimeout(readerState.progressTimer);
    readerState.progressTimer = window.setTimeout(saveReaderProgress, 600);
  }

  function saveReaderProgress() {
    if (!readerState.active || !readerState.book?.id || !readerState.chapter?.index) return;
    if (isLocalBookId(readerState.book.id)) return;
    const ratio = captureReaderRatio();
    postJson(getActiveUrl(), `/api/novels/${encodeURIComponent(readerState.book.id)}/progress`, {
      chapterIndex: readerState.chapter.index,
      scrollRatio: ratio
    }).catch(() => {});
  }

  function captureReaderRatio() {
    const screen = els.viewContent.querySelector(".novel-reader-screen");
    if (!screen) return 0;
    const content = screen.querySelector(".novel-reader-content");
    if (readerState.settings.readingMode === "page" && content) {
      const readableX = Math.max(1, content.scrollWidth - content.clientWidth);
      return Math.max(0, Math.min(1, content.scrollLeft / readableX));
    }
    const top = screen.getBoundingClientRect().top + window.scrollY;
    const readable = Math.max(1, screen.scrollHeight - window.innerHeight);
    return Math.max(0, Math.min(1, (window.scrollY - top) / readable));
  }

  function restoreReaderScroll(forcedRatio) {
    const ratio = Math.max(0, Math.min(1, Number(forcedRatio ?? readerState.pendingScrollRatio ?? 0)));
    readerState.pendingScrollRatio = 0;
    window.requestAnimationFrame(() => scrollReaderToRatio(ratio));
  }

  function scrollReaderToRatio(inputRatio) {
    const ratio = Math.max(0, Math.min(1, Number(inputRatio || 0)));
    const screen = els.viewContent.querySelector(".novel-reader-screen");
    if (!screen) return;
    const content = screen.querySelector(".novel-reader-content");
    if (readerState.settings.readingMode === "page" && content) {
      const readableX = Math.max(0, content.scrollWidth - content.clientWidth);
      content.scrollLeft = readableX * ratio;
      window.scrollTo({ top: screen.getBoundingClientRect().top + window.scrollY, behavior: "auto" });
      return;
    }
    const top = screen.getBoundingClientRect().top + window.scrollY;
    if (ratio <= 0.001) {
      window.scrollTo({ top, behavior: "auto" });
      return;
    }
    const readable = Math.max(0, screen.scrollHeight - window.innerHeight);
    window.scrollTo({ top: top + readable * ratio, behavior: "auto" });
  }

  function novelListPath() {
    const params = new URLSearchParams();
    if (listState.query) params.set("q", listState.query);
    if (listState.category && listState.category !== "all") params.set("category", listState.category);
    if (listState.sort && listState.sort !== "updated") params.set("sort", listState.sort);
    return `/api/novels${params.toString() ? `?${params}` : ""}`;
  }

  function novelDetailPath(id) {
    return `/api/novels/${encodeURIComponent(String(id || ""))}`;
  }

  function novelChapterPath(id, chapterIndex) {
    return `/api/novels/${encodeURIComponent(String(id || ""))}/chapters/${encodeURIComponent(String(chapterIndex || "1"))}`;
  }

  function renderMessage(message, tone = "quiet", replace = true) {
    if (replace) els.viewContent.innerHTML = "";
    const box = document.createElement("div");
    box.className = `message-box ${tone}`;
    box.textContent = message;
    els.viewContent.append(box);
  }

  return {
    renderNovelList,
    renderNovelDetail,
    renderNovelReader
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
      if (options.fatal || replacements <= Math.max(2, text.length * 0.01)) return { text, encoding };
    } catch {}
  }
  return { text: new TextDecoder().decode(buffer), encoding: "utf-8" };
}

function displayCategory(value) {
  const text = String(value || "").trim();
  if (!text || text === "all") return "全部";
  return text;
}

function themeLabel(value) {
  if (value === "white") return "白底";
  if (value === "green") return "护眼";
  if (value === "rose") return "暖粉";
  return "纸页";
}

function brightnessDim(value) {
  const brightness = clampNumber(value, 35, 100, 100);
  return String(((100 - brightness) / 100 * 0.55).toFixed(3));
}

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(NOVEL_SETTINGS_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  try {
    localStorage.setItem(NOVEL_SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

function normalizeSettings(input = {}) {
  return {
    theme: ["paper", "white", "green", "rose"].includes(input.theme) ? input.theme : "paper",
    night: Boolean(input.night),
    eyeCare: Boolean(input.eyeCare),
    menuPinned: Boolean(input.menuPinned),
    readingMode: ["scroll", "page"].includes(input.readingMode) ? input.readingMode : "scroll",
    brightness: Math.round(clampNumber(input.brightness, 35, 100, 100)),
    fontSize: clampNumber(input.fontSize, 16, 28, 20),
    lineHeight: clampNumber(input.lineHeight, 1.55, 2.35, 1.9)
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}



