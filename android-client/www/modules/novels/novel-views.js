import { deleteJson, fetchJson, postJson } from "../../js/api.js?v=20260702-novel-local-manage-74";
import { cacheAgeText, clearCachedJsonByPrefix, readCachedJson, writeCachedJson } from "../../js/cache.js?v=20260830-novel-chapters-75";
import { formatBytes, formatNumber } from "../../js/format.js";
import { deleteLocalNovelEntry, loadLocalNovelSummaries, readLocalNovelSummary, readLocalNovelCatalog, readLocalNovelChapter, readLocalNovelEntry, saveLocalNovelEntry, saveLocalNovelProgress, listLocalNovelRecoveryBooks, readLocalNovelRecoveryEntry } from "../../js/local-novels.js?v=20260830-novel-chapters-75";
import { openMobileActionSheet } from "../../js/mobile-action-sheet.js?v=20260731-mobile-action-sheet-01";

const NOVEL_SETTINGS_KEY = "fanhao.android.novel.settings";
const NOVEL_SORT_STORAGE_KEY = "fanhao.android.novelSort";
const DEVICE_TEXT_SCAN_LIMIT = 5000;
const DEVICE_TEXT_SCAN_DEPTH = 32;
const DEVICE_TEXT_SCAN_NODE_LIMIT = 20000;
const NOVEL_CATALOG_PAGE_SIZE = 80;
const NOVEL_READING_CHARS_PER_MINUTE = 450;
const NOVEL_REMOTE_PAGE_SIZE = 80;
const NOVEL_AUTHOR_PAGE_SIZE = 60;
const NOVEL_CHAPTER_PREFETCH_LIMIT = 6;
const NOVEL_SORT_OPTIONS = Object.freeze([
  { value: "updated", label: "最近更新" },
  { value: "progress", label: "最近阅读" },
  { value: "title", label: "书名排序" },
  { value: "chapters", label: "章节最多" },
  { value: "chars", label: "篇幅最长" }
]);
const DEFAULT_QUERY_STATE = {
  query: "",
  category: "all",
  author: "",
  mode: "books",
  sort: "updated",
  searchOpen: false,
  searchPage: false,
  source: "remote",
  sourceTouched: true,
  facets: [],
  total: 0,
  remoteLimit: NOVEL_REMOTE_PAGE_SIZE,
  authorLimit: NOVEL_AUTHOR_PAGE_SIZE
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

  const listState = { ...DEFAULT_QUERY_STATE, sort: readNovelSort(), uploading: false, busyAction: "" };
  const novelBusyOwners = new Map();
  const localBooks = new Map();
  const localBookReadVersions = new Map();
  const localBookProgressVersions = new Map();
  const remoteSourceRealms = new Map();
  const remoteSourceReceiptWrites = new Map();
  const remoteBookOrigins = new WeakMap();
  let localLibraryVersion = 0;
  let localLibraryRequestId = 0;
  const selectedLocalBookIds = new Set();
  let novelPage = null;
  let recoveryPanel = null;
  let recoveryExportInFlight = false;
  const catalogState = {
    bookId: "",
    query: "",
    page: 0,
    descending: false,
    remotePaged: false,
    total: 0,
    filteredTotal: 0,
    offset: 0
  };
  let catalogSearchTimer = null;
  let catalogRequestId = 0;
  let detailCatalogRequestId = 0;
  const detailState = { book: null, cacheEntry: null, chapters: [], progressChapterTitle: "" };
  let importingNativeText = false;
  let nativeTextDrainRequested = false;
  let nativeTextRetryTimer = null;
  let cachingBookId = "";
  let preparingCache = false;
  const prefetchedRemoteChapters = new Map();
  const remoteChapterPrefetchRequests = new Map();
  const localProgressWriteIds = new Map();
  const remoteProgressWrites = new Map();
  let progressWriteId = 0;
  const readerState = {
    active: false,
    session: null,
    screen: null,
    restoreFrame: null,
    restoreEpoch: 0,
    restoreRatio: null,
    book: null,
    bookSourceUrl: null,
    chapter: null,
    progressTimer: null,
    settings: normalizeSettings(readSettings()),
    menuOpen: false,
    settingsOpen: false,
    catalogOpen: false,
    catalogLoading: false,
    catalogError: "",
    pendingScrollRatio: 0,
    nativeBrightnessSet: false,
    nativeImmersiveSet: false,
    menuAutoHideTimer: null,
    progressFrame: null
  };

  installReaderProgress();
  installNativeTextIntentHandler();
  installReaderLifecycle();
  installLocalRecoveryLifecycle();

  function beginNovelPage(routeGuard, kind) {
    closeLocalRecovery(false);
    const page = { kind, routeGuard, sourceUrl: getActiveUrl(), issue: null, retryBusy: false, localData: null, remoteData: null, remoteCache: null };
    page.isActive = () => novelPage === page && routeGuard() && page.sourceUrl === getActiveUrl();
    page.isActive.signal = routeGuard.signal;
    novelPage = page;
    return page;
  }

  function installLocalRecoveryLifecycle() {
    const leave = () => { novelPage = null; closeLocalRecovery(false); };
    window.addEventListener("fanhaoViewWillRender", leave);
    window.addEventListener("fanhaoViewChanged", (event) => {
      if (!["novels", "novelSearch", "novelDetail", "novelReader"].includes(event.detail?.view)) leave();
    });
    window.addEventListener("pagehide", leave);
  }

  function recordLocalLibraryError(page, error, retry, retryLabel = "重试读取") {
    if (!page?.isActive()) return;
    page.issue = { message: String(error?.message || error || "本机小说库读取失败"), retry, retryLabel };
    renderLocalLibraryErrorCard();
  }

  function clearLocalLibraryError(page) {
    if (!page?.isActive()) return;
    page.issue = null;
    renderLocalLibraryErrorCard();
  }

  function renderLocalLibraryErrorCard() {
    els.viewContent.querySelector("[data-local-novel-error]")?.remove();
    const page = novelPage;
    if (!page?.isActive() || !page.issue) return;
    const card = document.createElement("section");
    card.className = "novel-local-library-error";
    card.setAttribute("data-local-novel-error", "");
    card.setAttribute("role", "alert");
    const title = document.createElement("strong");
    title.textContent = "本机小说库暂时无法读取";
    const message = document.createElement("p");
    message.textContent = page.issue.message;
    const explanation = document.createElement("p");
    explanation.textContent = "读取失败不表示书籍已删除。已有摘要和选择仍保留，但未能刷新；远程内容仍可查看。不会自动清库、修复或上传。";
    const actions = document.createElement("div");
    actions.className = "novel-local-recovery-actions";
    actions.append(actionButton(page.retryBusy ? "正在重试读取…" : page.issue.retryLabel, () => retryLocalLibraryRead(page), page.retryBusy));
    const recover = actionButton("只读取回旧库正文", () => openLocalRecovery(page, recover));
    recover.setAttribute("data-local-novel-recovery", "");
    actions.append(recover);
    card.append(title, message, explanation, actions);
    els.viewContent.prepend(card);
    if (page.kind === "collection") {
      els.viewMeta.textContent = listState.source === "local"
        ? (localBooks.size ? `本机库未能刷新 · 保留 ${formatNumber(localBooks.size)} 本旧摘要` : "本机库读取失败 · 数量未知")
        : "远程内容可查看 · 本机库读取失败，数量未知";
    }
  }

  async function retryLocalLibraryRead(page) {
    if (!page?.isActive() || page.retryBusy || !page.issue?.retry) return;
    const retry = page.issue.retry;
    const retryLabel = page.issue.retryLabel;
    const owner = setNovelBusy("local-retry");
    page.retryBusy = true;
    renderLocalLibraryErrorCard();
    try { await retry(); }
    catch (error) { recordLocalLibraryError(page, error, retry, retryLabel); }
    finally {
      clearNovelBusy(owner);
      page.retryBusy = false;
      if (page.isActive()) renderLocalLibraryErrorCard();
    }
  }

  function isCurrentRecovery(state) {
    return recoveryPanel === state && state.page.isActive() && state.overlay.isConnected;
  }

  function closeLocalRecovery(restoreFocus = true) {
    const state = recoveryPanel;
    if (!state) return;
    recoveryPanel = null;
    window.removeEventListener("keydown", state.keydown);
    state.overlay.remove();
    if (restoreFocus && state.page.isActive()) {
      const target = state.trigger?.isConnected ? state.trigger : els.viewContent.querySelector("[data-local-novel-recovery]");
      target?.focus();
    }
  }

  function openLocalRecovery(page, trigger) {
    if (!page?.isActive()) return;
    closeLocalRecovery(false);
    const overlay = document.createElement("div");
    overlay.className = "novel-local-recovery-overlay";
    const dialog = document.createElement("section");
    dialog.className = "novel-local-recovery-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "只读取回旧库正文");
    dialog.tabIndex = -1;
    overlay.append(dialog);
    const state = { page, trigger, overlay, dialog, items: [], version: null, afterKey: undefined,
      history: [], nextKey: null, hasMore: false, busy: false, error: false, expired: false, notice: "", retry: null };
    state.keydown = (event) => {
      if (!isCurrentRecovery(state)) return;
      if (event.key === "Escape") { event.preventDefault(); closeLocalRecovery(); }
      if (event.key !== "Tab") return;
      const buttons = [...dialog.querySelectorAll("button")].filter((button) => !button.disabled);
      const target = event.shiftKey ? buttons.at(-1) : buttons[0];
      if (!dialog.contains(document.activeElement) || (event.shiftKey ? document.activeElement === buttons[0] : document.activeElement === buttons.at(-1))) {
        event.preventDefault(); target?.focus();
      }
    };
    recoveryPanel = state;
    document.body.append(overlay);
    window.addEventListener("keydown", state.keydown);
    renderLocalRecovery(state);
    void loadLocalRecoveryPage(state, undefined, []);
  }

  function renderLocalRecovery(state) {
    if (!isCurrentRecovery(state)) return;
    state.dialog.innerHTML = "";
    const heading = document.createElement("h2");
    heading.textContent = "只读取回旧库正文";
    const close = actionButton("关闭取回窗口", () => closeLocalRecovery());
    close.className = "novel-local-recovery-close";
    const warning = document.createElement("p");
    warning.textContent = "只读旧库，不升级、不修改、不删除。逐本主动导出 TXT，仅包含可读正文，不是包含阅读进度和元数据的完整备份。";
    const version = document.createElement("p");
    version.className = "novel-local-recovery-version";
    version.textContent = state.version === 1 ? "v1：尚未升级的旧库正文。"
      : state.version === 2 || state.version === 3 ? `v${state.version}：升级前保留的旧副本，可能不是当前最新正文。` : "点击入口后才读取旧库，每页最多 10 本。";
    state.dialog.append(heading, close, warning, version);
    const status = document.createElement("p");
    status.className = "novel-local-recovery-status";
    status.setAttribute("role", state.error ? "alert" : "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = state.notice;
    state.dialog.append(status);
    if (state.error && !state.busy) {
      state.dialog.append(actionButton(state.expired ? "重新打开旧库" : state.retryLabel || "重试读取旧库", () => {
        if (state.expired) openLocalRecovery(state.page, state.trigger);
        else state.retry?.();
      }));
    }
    const list = document.createElement("div");
    list.className = "novel-local-recovery-list";
    for (const item of state.items) {
      const row = document.createElement("article");
      const name = document.createElement("strong"); name.textContent = item.title || item.fileName || "未命名旧书";
      const count = document.createElement("p");
      count.textContent = `可读 ${formatNumber(item.readableChapters)}/${formatNumber(item.totalChapters)} 章` + (item.omittedChapters ? ` · 不完整，遗漏 ${formatNumber(item.omittedChapters)} 章` : "");
      const label = !item.exportable ? "没有可读正文" : item.omittedChapters
        ? `导出可读正文（不完整，遗漏 ${formatNumber(item.omittedChapters)} 章）` : "取回正文并导出 TXT";
      row.append(name, count, actionButton(label, () => exportLocalRecoveryBook(state, item), state.busy || state.expired || recoveryExportInFlight || !item.exportable));
      list.append(row);
    }
    state.dialog.append(list);
    const pages = document.createElement("div");
    pages.className = "novel-local-recovery-actions";
    pages.append(actionButton("上一页", () => loadLocalRecoveryPage(state, state.history.at(-1), state.history.slice(0, -1)), state.busy || state.expired || !state.history.length),
      actionButton("下一页", () => loadLocalRecoveryPage(state, state.nextKey, [...state.history, state.afterKey]), state.busy || state.expired || !state.hasMore));
    state.dialog.append(pages);
    if (!state.dialog.contains(document.activeElement)) close.focus();
  }

  async function loadLocalRecoveryPage(state, afterKey, history) {
    if (!isCurrentRecovery(state) || state.busy) return;
    const owner = setNovelBusy("recovery-read");
    state.busy = true; state.error = false; state.notice = "正在只读旧库摘要…";
    state.retry = () => loadLocalRecoveryPage(state, afterKey, history);
    state.retryLabel = "重试读取旧库";
    renderLocalRecovery(state);
    try {
      const result = await listLocalNovelRecoveryBooks({ afterKey, limit: 10, ...(state.version == null ? {} : { expectedVersion: state.version }) });
      if (!isCurrentRecovery(state)) return;
      if (![1, 2, 3].includes(result?.version) || (state.version != null && state.version !== result.version)) throw Object.assign(new Error("旧库版本已变化，请重新打开。"), { code: "RECOVERY_STALE_VERSION" });
      state.version = result.version;
      state.items = (Array.isArray(result.items) ? result.items : []).slice(0, 10).map((item) => ({
        key: item.key, title: item.title, fileName: item.fileName, totalChapters: item.totalChapters,
        readableChapters: item.readableChapters, omittedChapters: item.omittedChapters, exportable: item.exportable === true
      }));
      state.afterKey = afterKey; state.history = history; state.nextKey = result.nextKey; state.hasMore = result.hasMore === true;
      state.notice = state.items.length ? `当前第 ${history.length + 1} 页；点击单本按钮才读取该书正文。` : "这页旧副本没有可列出的书籍；这不代表当前本机库没有书。";
    } catch (error) {
      if (!isCurrentRecovery(state)) return;
      state.error = true;
      state.expired = ["RECOVERY_STALE_VERSION", "RECOVERY_VERSION_CHANGED"].includes(error?.code);
      state.notice = state.expired ? "旧库版本已变化。本次列表已失效，请重新打开旧库后再取回。" : `旧库读取失败：${error?.message || error}。原库未更改，可重试。`;
    } finally {
      clearNovelBusy(owner); state.busy = false;
      if (isCurrentRecovery(state)) renderLocalRecovery(state);
    }
  }

  async function exportLocalRecoveryBook(state, item) {
    if (!isCurrentRecovery(state) || state.busy || state.expired || recoveryExportInFlight || !item.exportable) return;
    const owner = setNovelBusy("recovery-export");
    recoveryExportInFlight = true; state.busy = true; state.error = false; state.notice = "正在取回这一本的可读正文…";
    state.retry = () => exportLocalRecoveryBook(state, item);
    state.retryLabel = "重试取回并导出 TXT";
    renderLocalRecovery(state);
    try {
      const result = await readLocalNovelRecoveryEntry(item.key, { expectedVersion: state.version });
      if (!isCurrentRecovery(state)) return;
      if (!result) throw new Error("这本旧书已经不可读取，请重新打开旧库列表");
      if (result.version !== state.version) throw Object.assign(new Error("旧库版本已变化"), { code: "RECOVERY_STALE_VERSION" });
      const chapters = (Array.isArray(result.entry?.chapters) ? result.entry.chapters : []).filter((chapter) => typeof chapter?.content === "string" && chapter.content.trim());
      const total = Math.max(chapters.length, Number(result.totalChapters) || 0);
      const omitted = Math.max(Number(result.omittedChapters) || 0, total - chapters.length);
      if (!chapters.length) throw new Error("没有可读正文，不能导出空白 TXT");
      const limit = 80 * 1024 * 1024;
      const parts = [];
      let minimumBytes = 0;
      for (const chapter of chapters) {
        const heading = !chapter.preamble && typeof chapter.title === "string" && chapter.title.trim() ? `${chapter.title}\n\n` : "";
        minimumBytes += heading.length + chapter.content.length + 2;
        if (minimumBytes > limit) throw new Error("可读正文超过 80 MiB 导出上限；原库未更改");
        parts.push(heading, chapter.content, "\n\n");
      }
      if (new Blob(parts, { type: "text/plain;charset=utf-8" }).size > limit) throw new Error("可读正文按 UTF-8 编码超过 80 MiB 导出上限；原库未更改");
      const countsChanged = total !== item.totalChapters || chapters.length !== item.readableChapters || omitted !== item.omittedChapters;
      if ((omitted > 0 || countsChanged) && !window.confirm(`本次可取回 ${chapters.length}/${total} 章，遗漏 ${omitted} 章。${omitted ? "导出的 TXT 不完整。" : "数量与列表显示不同。"}\n仅包含正文，不是含进度和元数据的完整备份。继续导出？`)) {
        state.notice = "已取消导出，原库未更改。"; return;
      }
      if (!isCurrentRecovery(state)) return;
      const fileName = sanitizeTxtFileName(item.fileName || result.entry?.book?.fileName || `${item.title || "取回的旧书"}.txt`);
      const content = parts.join("");
      const plugin = nativeNovelPlugin();
      if (plugin?.exportTextFile) {
        const saved = await plugin.exportTextFile({ fileName, text: content });
        if (!isCurrentRecovery(state)) return;
        if (saved?.canceled) { state.notice = "已取消导出，原库未更改。"; return; }
        if (saved?.available === false) throw new Error(saved.message || "保存入口不可用");
        state.notice = `已保存${omitted ? "不完整的" : ""}正文 TXT：${saved?.fileName || fileName}；遗漏 ${omitted} 章。不是完整备份，原库未更改。`;
      } else {
        downloadTextFile(fileName, content);
        state.notice = `已发起${omitted ? "不完整的" : ""}正文 TXT 下载；遗漏 ${omitted} 章。请检查下载结果，原库未更改。`;
      }
    } catch (error) {
      if (!isCurrentRecovery(state)) return;
      state.error = true;
      state.expired = ["RECOVERY_STALE_VERSION", "RECOVERY_VERSION_CHANGED"].includes(error?.code);
      state.notice = state.expired ? "旧库版本已变化，请重新打开旧库。未启动新的导出。" : `正文取回或导出失败：${error?.message || error}。原库未更改，可重试。`;
    } finally {
      clearNovelBusy(owner); recoveryExportInFlight = false; state.busy = false;
      if (recoveryPanel) renderLocalRecovery(recoveryPanel);
    }
  }

  async function renderNovelList(isActive = () => true) {
    listState.searchPage = false;
    listState.query = "";
    listState.mode = "books";
    listState.source = "remote";
    listState.sourceTouched = true;
    return renderNovelCollection(isActive);
  }

  async function renderNovelSearch(params = {}, isActive = () => true) {
    listState.searchPage = true;
    listState.query = String(params.query || "").trim();
    listState.mode = "books";
    listState.source = "remote";
    listState.sourceTouched = true;
    if (!listState.query) {
      beginNovelPage(isActive, "collection");
      deactivateReader();
      setActiveBottom("novels");
      renderNovelSearchData({ books: [], total: 0 });
      return;
    }
    return renderNovelCollection(isActive);
  }

  async function renderNovelCollection(isActive = () => true) {
    const page = beginNovelPage(isActive, "collection");
    isActive = page.isActive;
    deactivateReader();
    setActiveBottom("novels");
    const loadingTitle = listState.searchPage ? "搜索" : "小说";
    els.viewKicker.textContent = "小说";
    els.viewTitle.textContent = loadingTitle;
    els.viewMeta.textContent = "正在读取";
    els.viewContent.innerHTML = `<div class="loading-row">正在读取${loadingTitle}</div>`;

    const path = novelListPath();
    const activeUrl = getActiveUrl();
    let renderedCache = false;
    const refreshLocal = async () => {
      const data = await loadLocalListData();
      if (!isActive()) return;
      page.localData = data;
      clearLocalLibraryError(page);
      renderNovelListData(mergeNovelListData(page.remoteData || {}, data), page.remoteCache);
    };
    try { page.localData = await loadLocalListData(); }
    catch (error) {
      if (!isActive()) return;
      page.localData = { ...localListData([...localBooks.values()]), unavailable: true };
      recordLocalLibraryError(page, error, refreshLocal);
    }
    if (!isActive()) return;
    renderNovelListData(mergeNovelListData({}, page.localData));
    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload?.books && canUseRemotePayload(activeUrl, cached.payload)) {
      rememberRemoteSourceRealm(activeUrl, cached.payload, { cached: true });
      renderedCache = true;
      page.remoteData = cached.payload; page.remoteCache = cached;
      renderNovelListData(mergeNovelListData(page.remoteData, page.localData), cached);
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 16000, signal: isActive.signal });
      if (!isActive()) return;
      rememberRemoteSourceRealm(activeUrl, data);
      writeCachedJson(activeUrl, path, data).catch(() => {});
      page.remoteData = data; page.remoteCache = null;
      renderNovelListData(mergeNovelListData(data, page.localData));
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是上次内容。", "quiet", false);
      } else {
        renderMessage(error.message || "小说内容读取失败", "error", listState.source !== "local");
      }
    }
  }

  function renderNovelListData(data = {}, cacheEntry = null) {
    const books = Array.isArray(data.books) ? data.books : [];

    if (listState.searchPage) {
      renderNovelSearchData(data, cacheEntry);
      return;
    }
    listState.facets = Array.isArray(data.facets || data.summary?.categories) ? [...(data.facets || data.summary?.categories)] : [];
    listState.total = Number(data.total || books.length || 0);

    els.viewKicker.textContent = "小说";
    els.viewTitle.textContent = listState.category === "all" ? "全部小说" : displayCategory(listState.category);
    els.viewMeta.textContent = `${formatNumber(data.total || books.length)} 本`;
    els.viewContent.innerHTML = "";
    els.viewContent.className = "content-list novel-mobile-library-content";
    notifyLibrarySourceChanged();
    renderLocalLibraryErrorCard();

    if (!books.length) {
      if (!novelPage?.issue || listState.source !== "local") els.viewContent.append(createNovelEmptyState(data));
      return;
    }

    const list = document.createElement("div");
    list.className = "novel-mobile-list";
    for (const entry of books) list.append(createNovelCard(entry));
    els.viewContent.append(list);
    const more = createNovelLoadMore(Number(data.total || 0), books.length, "books");
    if (more) els.viewContent.append(more);
  }

  function renderNovelSearchData(data = {}) {
    const books = Array.isArray(data.books) ? data.books : [];
    els.viewKicker.textContent = "小说";
    els.viewTitle.textContent = "搜索";
    els.viewMeta.textContent = listState.query ? `${formatNumber(data.total || books.length)} 本` : "";
    els.viewContent.innerHTML = "";
    els.viewContent.className = "content-list novel-mobile-search-page-content";
    els.viewContent.append(createNovelSearchHeader());
    renderLocalLibraryErrorCard();

    if (!listState.query) {
      const prompt = document.createElement("div");
      prompt.className = "novel-mobile-search-prompt";
      prompt.textContent = "搜索书名、作者或分类";
      els.viewContent.append(prompt);
      return;
    }
    if (!books.length) {
      const empty = document.createElement("div");
      empty.className = "novel-mobile-search-prompt";
      empty.textContent = `没有搜到「${listState.query}」`;
      els.viewContent.append(empty);
      return;
    }

    const meta = document.createElement("div");
    meta.className = "novel-mobile-search-result-meta";
    meta.textContent = `${formatNumber(data.total || books.length)} 本结果`;
    const list = document.createElement("div");
    list.className = "novel-mobile-list";
    for (const book of books) list.append(createNovelCard(book));
    els.viewContent.append(meta, list);
    const more = createNovelLoadMore(Number(data.total || 0), books.length, "books");
    if (more) els.viewContent.append(more);
  }

  function createNovelSearchHeader() {
    const head = document.createElement("div");
    head.className = "novel-mobile-search-page-head";
    const form = document.createElement("form");
    form.className = "novel-mobile-search-page-form";
    form.setAttribute("role", "search");
    const back = document.createElement("button");
    back.type = "button";
    back.className = "novel-mobile-search-page-back";
    back.setAttribute("aria-label", "返回小说");
    back.textContent = "‹";
    back.addEventListener("click", () => goBack());
    const field = document.createElement("div");
    field.className = "novel-mobile-search-page-field";
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "⌕";
    const input = document.createElement("input");
    input.type = "search";
    input.value = listState.query;
    input.placeholder = "搜书名、作者或分类";
    input.setAttribute("aria-label", "搜索小说");
    input.autocomplete = "off";
    input.enterKeyHint = "search";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "novel-mobile-search-page-clear";
    clear.setAttribute("aria-label", "清除搜索内容");
    clear.textContent = "×";
    clear.hidden = !input.value;
    clear.addEventListener("click", () => {
      input.value = "";
      clear.hidden = true;
      input.focus();
    });
    input.addEventListener("input", () => {
      clear.hidden = !input.value;
    });
    field.append(icon, input, clear);
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "novel-mobile-search-page-submit";
    submit.textContent = "搜索";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      showView("novelSearch", { query: input.value.trim() }, { skipHistory: true, replaceHistory: true });
    });
    form.append(back, field, submit);
    head.append(form);
    window.requestAnimationFrame(() => input.focus({ preventScroll: true }));
    return head;
  }

  function renderNovelAuthorListData(data = {}, localData = emptyLocalListData(), cacheEntry = null) {
    const remoteAuthors = Array.isArray(data.authors) ? data.authors : [];
    const localAuthors = aggregateNovelAuthors(localData.books || [], listState.query);
    const authors = listState.source === "remote"
      ? remoteAuthors
      : mergeNovelAuthors(remoteAuthors, localAuthors);
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
    const total = listState.source === "remote" ? Number(data.total || remoteAuthors.length) : authors.length;
    els.viewKicker.textContent = sourceKicker();
    els.viewTitle.textContent = "作者";
    els.viewMeta.textContent = `${formatNumber(total)} 位作者${suffix}`;
    els.viewContent.innerHTML = "";
    notifyLibrarySourceChanged();
    els.viewContent.append(createNovelControls({ ...data, total, facets: [], summary: data.summary || {} }));
    if (!authors.length) {
      els.viewContent.append(createNovelEmptyState({ ...data, total: 0 }));
      return;
    }
    const list = document.createElement("div");
    list.className = "novel-mobile-author-list";
    for (const author of authors) list.append(createNovelAuthorCard(author));
    els.viewContent.append(list);
    if (listState.source !== "local") {
      const more = createNovelLoadMore(Number(data.total || 0), remoteAuthors.length, "authors");
      if (more) els.viewContent.append(more);
    }
  }

  async function loadLocalListData() {
    const entries = await loadPersistentLocalLibrary();
    return localListData(entries);
  }

  async function loadPersistentLocalLibrary() {
    const version = localLibraryVersion;
    const progressVersions = new Map(localBookProgressVersions);
    const requestId = ++localLibraryRequestId;
    const entries = await loadLocalNovelSummaries();
    if (version !== localLibraryVersion || requestId !== localLibraryRequestId) return Array.from(localBooks.values());
    const present = new Set();
    for (const entry of entries) {
      const summary = rememberLocalBookSummary(entry, progressVersions.get(entry.book.id) || 0);
      if (summary) present.add(summary.book.id);
    }
    for (const id of localBooks.keys()) if (!present.has(id)) localBooks.delete(id);
    return Array.from(localBooks.values());
  }

  function rememberLocalBookSummary(entry, progressVersion = localBookProgressVersions.get(entry?.book?.id) || 0) {
    if (!entry?.book?.id) return null;
    const previous = localBooks.get(entry.book.id);
    const generation = entry.generation ?? entry.book.localGeneration;
    const keepProgress = generation != null && previous?.generation === generation
      && progressVersion !== (localBookProgressVersions.get(entry.book.id) || 0);
    // Never retain a catalog or a full import/export entry in the shelf cache.
    // A same-generation read begun before a local progress commit must not
    // overwrite that commit. Content reads use a separate invalidation epoch.
    const summary = {
      id: entry.book.id, book: { ...entry.book, ...(keepProgress ? { progress: previous.book.progress,
        progressRecovery: previous.book.progressRecovery || null } : {}) }, generation,
      createdAt: entry.createdAt ?? previous?.createdAt, updatedAt: entry.updatedAt ?? previous?.updatedAt,
      bytes: entry.bytes ?? previous?.bytes
    };
    localBooks.set(summary.book.id, summary);
    return summary;
  }

  function invalidateLocalBookReads(bookId) {
    localBookReadVersions.set(bookId, (localBookReadVersions.get(bookId) || 0) + 1);
    localLibraryVersion += 1;
    localProgressWriteIds.delete(bookId);
  }

  function emptyLocalListData() {
    return {
      books: [],
      total: 0,
      facets: [],
      summary: { totals: { books: 0, chapters: 0, chars: 0, bytes: 0 }, categories: [], recent: [] }
    };
  }

  function visibleBookTotals(books = []) {
    return books.reduce((totals, book) => {
      totals.chapters += Number(book?.chapterCount || 0);
      totals.chars += Number(book?.charCount || 0);
      totals.bytes += Number(book?.sizeBytes || 0);
      return totals;
    }, { chapters: 0, chars: 0, bytes: 0 });
  }

  function localListData(entries = []) {
    const allBooks = entries.map((entry) => entry.book).filter(isVisibleLocalLibraryBook);
    const books = sortNovelBooks(allBooks.filter(matchesLocalListFilter));
    const summary = localSummary(allBooks);
    return {
      books,
      total: books.length,
      facets: summary.categories,
      summary
    };
  }

  function matchesLocalListFilter(book = {}) {
    if (listState.category && listState.category !== "all" && bookCategoryLabel(book) !== listState.category) return false;
    if (listState.author && String(book.author || "").trim() !== listState.author) return false;
    const query = listState.query.trim().toLowerCase();
    if (!query) return true;
    return [
      book.title,
      book.author,
      bookCategoryLabel(book),
      book.latestChapterTitle,
      book.summary,
      book.fileName
    ].some((value) => String(value || "").toLowerCase().includes(query));
  }

  function localSummary(books = []) {
    const categoryCounts = new Map();
    let chapters = 0;
    let chars = 0;
    let bytes = 0;
    let updatedAt = "";
    for (const book of books) {
      const category = bookCategoryLabel(book) || "本地";
      categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
      chapters += Number(book.chapterCount || 0);
      chars += Number(book.charCount || 0);
      bytes += Number(book.sizeBytes || 0);
      const stamp = String(book.progress?.updatedAt || book.updatedAt || "");
      if (stamp > updatedAt) updatedAt = stamp;
    }
    const categories = Array.from(categoryCounts, ([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-Hans-CN"));
    const recent = books
      .filter((book) => book.progress)
      .filter(shouldShowInContinueReading)
      .sort((a, b) => String(b.progress?.updatedAt || "").localeCompare(String(a.progress?.updatedAt || "")))
      .slice(0, 6);
    return {
      totals: { books: books.length, localBooks: books.length, chapters, chars, bytes, updatedAt },
      categories,
      recent
    };
  }

  function mergeNovelListData(remote = {}, local = emptyLocalListData()) {
    const remoteBooks = Array.isArray(remote.books) ? remote.books : [];
    const localBooksList = Array.isArray(local.books) ? local.books : [];
    const localSummaryData = local.summary || localSummary(localBooksList);
    const sourceTotals = novelSourceTotals(remote, local);
    syncDefaultNovelSource();
    if (listState.source === "local") {
      return {
        ...local,
        books: sortNovelBooks(localBooksList),
        total: Number(local.total || localBooksList.length || 0),
        facets: local.facets || localSummaryData.categories || [],
        summary: { ...localSummaryData, sourceTotals }
      };
    }
    const markedRemoteBooks = remoteBooks.map(markRemoteBookWithCache);
    if (listState.source === "remote") {
      const remoteSummary = remote.summary || {};
      return {
        ...remote,
        books: sortNovelBooks(markedRemoteBooks),
        total: Number(remote.total || markedRemoteBooks.length || 0),
        facets: remote.facets || remoteSummary.categories || [],
        summary: {
          ...remoteSummary,
          totals: {
            ...(remoteSummary.totals || {}),
            remoteBooks: Number(remote.total || remoteSummary.totals?.books || markedRemoteBooks.length || 0),
            localBooks: 0
          },
          sourceTotals
        }
      };
    }
    const visibleLocalBooks = visibleLocalBooksForRemote(markedRemoteBooks, localBooksList);
    const visibleLocalSummary = localSummary(visibleLocalBooks);
    const books = sortNovelBooksLocalFirst([...visibleLocalBooks, ...markedRemoteBooks]);
    const remoteSummary = remote.summary || {};
    const summary = {
      ...remoteSummary,
      totals: mergeTotals(remoteSummary.totals || {}, visibleLocalSummary.totals || {}),
      sourceTotals,
      categories: mergeFacets(remoteSummary.categories || remote.facets || [], visibleLocalSummary.categories || []),
      recent: sortNovelBooksLocalFirst([...(visibleLocalSummary.recent || []), ...(remoteSummary.recent || [])], "progress").slice(0, 6)
    };
    return {
      ...remote,
      books,
      total: Number(remote.total || remoteBooks.length || 0) + Number(visibleLocalBooks.length || 0),
      facets: mergeFacets(remote.facets || remoteSummary.categories || [], visibleLocalSummary.categories || []),
      summary
    };
  }

  function novelSourceTotals(remote = {}, local = {}) {
    const remoteSummary = remote.summary || {};
    const localSummaryData = local.summary || {};
    const localBooks = Number(localSummaryData.totals?.localBooks || localSummaryData.totals?.books || local.total || local.books?.length || 0);
    const remoteBooks = Number(remoteSummary.totals?.remoteBooks || remoteSummary.totals?.books || remote.total || remote.books?.length || 0);
    return {
      localBooks,
      remoteBooks,
      books: localBooks + remoteBooks
    };
  }

  function syncDefaultNovelSource() {
    if (listState.sourceTouched) return;
    listState.source = "remote";
  }

  function normalizeLibrarySource(source) {
    const value = String(source || "").trim().toLowerCase();
    if (value === "local") return "local";
    if (value === "remote" || value === "bookstore" || value === "store") return "remote";
    return "all";
  }

  function getLibrarySource() {
    return listState.source === "local" ? "local" : "bookstore";
  }

  function setLibrarySource(source) {
    const next = normalizeLibrarySource(source);
    if (listState.source === next) return false;
    listState.source = next;
    listState.sourceTouched = true;
    listState.category = "all";
    listState.author = "";
    resetNovelRemoteLimits();
    if (next !== "local") exitLocalSelectionMode();
    notifyLibrarySourceChanged();
    return true;
  }

  function notifyLibrarySourceChanged() {
    window.dispatchEvent(new CustomEvent("fanhaoNovelSourceChanged", {
      detail: { source: getLibrarySource() }
    }));
  }

  function getNovelNavigationState() {
    return {
      category: listState.category || "all",
      sort: listState.sort || "updated",
      total: Number(listState.total || 0),
      categories: (listState.facets || []).map((item) => ({
        name: String(item?.name || "").trim(),
        label: displayCategory(item?.name),
        count: Number(item?.count || 0)
      })).filter((item) => item.name && item.name !== "待分类")
    };
  }

  function getNovelSortOptions() {
    return NOVEL_SORT_OPTIONS.map((option) => ({ ...option }));
  }

  function setNovelCategory(category) {
    const next = String(category || "all").trim() || "all";
    if (listState.category === next) return false;
    listState.category = next;
    listState.author = "";
    resetNovelRemoteLimits();
    return true;
  }

  function setNovelSort(sort) {
    const next = normalizeNovelSort(sort);
    if (listState.sort === next) return false;
    listState.sort = next;
    try {
      localStorage.setItem(NOVEL_SORT_STORAGE_KEY, next);
    } catch {}
    resetNovelRemoteLimits();
    return true;
  }

  function readNovelSort() {
    try {
      return normalizeNovelSort(localStorage.getItem(NOVEL_SORT_STORAGE_KEY));
    } catch {
      return "updated";
    }
  }

  function normalizeNovelSort(sort) {
    const value = String(sort || "").trim();
    return NOVEL_SORT_OPTIONS.some((option) => option.value === value) ? value : "updated";
  }

  function visibleLocalBooksForRemote(remoteBooks = [], localBooksList = []) {
    if (!remoteBooks.length) return localBooksList;
    const visibleRemoteIds = new Set(remoteBooks.map((book) => remoteCacheIdFromSourceId(remoteBookSourceId(book), book.sourceRealm)).filter(Boolean));
    if (!visibleRemoteIds.size) return localBooksList;
    return localBooksList.filter((book) => !isRemoteCacheBook(book)
      || !visibleRemoteIds.has(remoteCacheIdFromSourceId(remoteCacheSourceId(book), book.sourceRealm)));
  }

  function markRemoteBookWithCache(book = {}) {
    if (!book?.id || isLocalBookId(book.id)) return book;
    const entry = cachedRemoteEntryForSourceId(book.id, book.sourceRealm);
    const cachedBook = entry?.book;
    const marked = {
      ...book,
      cachedLocal: Boolean(cachedBook),
      cachedLocalId: cachedBook?.id || "",
      cachedAt: cachedBook?.cachedAt || entry?.updatedAt || cachedBook?.updatedAt || "",
      localProgress: cachedBook?.progress || null,
      localProgressRecovery: cachedBook?.progressRecovery || null,
      progress: book.progress || (book.progressRecovery ? null : cachedBook?.progress) || null
    };
    remoteBookOrigins.set(marked, { sourceUrl: getActiveUrl(), page: novelPage });
    return marked;
  }

  function cachedRemoteEntryForSourceId(sourceId, sourceRealm) {
    const id = remoteCacheIdFromSourceId(sourceId, sourceRealm);
    if (!id) return null;
    const direct = localBooks.get(id);
    if (direct?.book && isRemoteCacheBook(direct.book)
      && remoteCacheSourceId(direct.book) === String(sourceId || "").trim()
      && normalizeSourceRealm(direct.book.sourceRealm) === normalizeSourceRealm(sourceRealm)) return direct;
    return null;
  }

  function isRemoteCacheBook(book = {}) {
    return Boolean(book?.local && book.sourceType === "remote-cache" && remoteCacheSourceId(book));
  }

  function bookCategoryLabel(book = {}) {
    const category = displayCategory(book.category || "小说");
    if (isRemoteCacheBook(book) && category === "本机缓存") return "离线缓存";
    if (book?.local && category === "本机") return "本地";
    return category;
  }

  function remoteCacheSourceId(book = {}) {
    return String(book.sourceBookId || "").trim();
  }

  function remoteBookSourceId(book = {}) {
    return String(book.sourceBookId || book.id || "").trim();
  }

  function remoteCacheIdFromSourceId(sourceId, sourceRealm) {
    const id = String(sourceId || "").trim();
    const realm = normalizeSourceRealm(sourceRealm);
    // A reversible tuple, not a lossy hash or an address-derived identity.
    return id && realm ? `local:remote:v2:${encodeURIComponent(realm)}:${encodeURIComponent(id)}` : "";
  }

  function normalizeSourceRealm(value) {
    return typeof value === "string" && /^server:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ? value : "";
  }

  function remotePayloadRealm(data = {}) {
    const values = [data.sourceRealm, data.book?.sourceRealm, ...(Array.isArray(data.books) ? data.books : []).map((book) => book.sourceRealm)]
      .filter((value) => value !== undefined && value !== null && value !== "");
    if (!values.length) return ""; // Older servers remain readable, but unbound.
    const realm = normalizeSourceRealm(values[0]);
    if (!realm || values.some((value) => value !== realm)) throw new Error("小说响应的书库来源不一致，请重新打开书库");
    return realm;
  }

  function rememberRemoteSourceRealm(sourceUrl, data, { cached = false } = {}) {
    const realm = remotePayloadRealm(data);
    if (cached && remoteSourceRealms.has(sourceUrl)) return remoteSourceRealms.get(sourceUrl);
    remoteSourceRealms.set(sourceUrl, realm);
    if (!cached) {
      // This receipt only remembers the server's last assertion. Losing it must
      // disable automatic linking, never guess a realm from the current URL.
      const previous = remoteSourceReceiptWrites.get(sourceUrl) || Promise.resolve();
      const pending = previous.catch(() => {}).then(() => writeCachedJson(sourceUrl, "/api/novels/source-identity", { sourceRealm: realm })).catch(() => {});
      remoteSourceReceiptWrites.set(sourceUrl, pending);
      pending.finally(() => { if (remoteSourceReceiptWrites.get(sourceUrl) === pending) remoteSourceReceiptWrites.delete(sourceUrl); });
    }
    return realm;
  }

  async function readRemoteSourceRealm(sourceUrl) {
    if (remoteSourceRealms.has(sourceUrl)) return remoteSourceRealms.get(sourceUrl);
    const receipt = await readCachedJson(sourceUrl, "/api/novels/source-identity").catch(() => null);
    if (!remoteSourceRealms.has(sourceUrl) && receipt?.payload) {
      remoteSourceRealms.set(sourceUrl, normalizeSourceRealm(receipt.payload.sourceRealm));
    }
    return remoteSourceRealms.get(sourceUrl) || "";
  }

  function matchesRemotePayload(data, bookId, sourceRealm, chapterIndex, anchor = {}) {
    if (!data || String(data.book?.id || data.bookId || "") !== String(bookId)) return false;
    let realm;
    try { realm = remotePayloadRealm(data); } catch { return false; }
    if (sourceRealm !== undefined && realm !== sourceRealm) return false;
    if (anchor.sourceRealm && realm !== anchor.sourceRealm) return false;
    if (data.chapter?.bookId !== undefined && String(data.chapter.bookId) !== String(bookId)) return false;
    const revision = data.book?.catalogRevision ?? data.catalogRevision;
    if (data.catalogRevision && data.book?.catalogRevision && data.catalogRevision !== data.book.catalogRevision) return false;
    if (anchor.catalogRevision && revision !== anchor.catalogRevision) return false;
    if (anchor.chapterId && data.chapter?.id !== anchor.chapterId) return false;
    return chapterIndex === undefined || Number(data.chapter?.index) === Number(chapterIndex);
  }

  function chapterAnchor(book = {}, chapter = {}) {
    return book.catalogRevision ? { catalogRevision: book.catalogRevision,
      ...(chapter.id ? { chapterId: chapter.id } : {}),
      ...(normalizeSourceRealm(book.sourceRealm) ? { sourceRealm: book.sourceRealm } : {}) } : {};
  }

  function addCatalogPreconditions(params, book) {
    for (const [key, value] of Object.entries(chapterAnchor(book))) params.set(key, value);
  }

  function progressMatchesChapter(book, chapter) {
    const progress = book.progress;
    if (!progress || book.progressRecovery) return false;
    if (book.catalogRevision) return progress.catalogRevision === book.catalogRevision && progress.chapterId === chapter.id;
    return Number(progress.chapterIndex || 0) === Number(chapter.index || 0);
  }

  function canUseRemotePayload(sourceUrl, data) {
    try { const realm = remotePayloadRealm(data); return !remoteSourceRealms.has(sourceUrl) || remoteSourceRealms.get(sourceUrl) === realm; }
    catch { return false; }
  }

  function captureRemoteOperation(book) {
    const origin = remoteBookOrigins.get(book) || { sourceUrl: getActiveUrl(), page: novelPage };
    const sourceRealm = normalizeSourceRealm(book.sourceRealm);
    const isActive = () => origin.sourceUrl === getActiveUrl() && (!origin.page || origin.page.isActive())
      && (!remoteSourceRealms.has(origin.sourceUrl) || remoteSourceRealms.get(origin.sourceUrl) === sourceRealm);
    return { ...origin, sourceRealm, isActive };
  }

  function requireRemoteOperation(operation) {
    if (!operation.isActive()) throw new Error("书库或页面已切换，请在当前书库重新操作");
  }

  function mergeTotals(remote = {}, local = {}) {
    const updatedAt = [remote.updatedAt, local.updatedAt].filter(Boolean).sort().pop() || "";
    const remoteBooks = Number(remote.books || 0);
    const localBooks = Number(local.books || local.localBooks || 0);
    return {
      ...remote,
      books: remoteBooks + localBooks,
      localBooks,
      remoteBooks,
      chapters: Number(remote.chapters || 0) + Number(local.chapters || 0),
      chars: Number(remote.chars || 0) + Number(local.chars || 0),
      bytes: Number(remote.bytes || 0) + Number(local.bytes || 0),
      updatedAt
    };
  }

  function mergeFacets(remote = [], local = []) {
    const counts = new Map();
    for (const item of [...remote, ...local]) {
      const name = displayCategory(item?.name || "全部");
      if (!name || name === "全部") continue;
      counts.set(name, (counts.get(name) || 0) + Number(item.count || 0));
    }
    return Array.from(counts, ([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-Hans-CN"));
  }

  function sortNovelBooks(books = [], forcedSort = "") {
    const sort = forcedSort || listState.sort || "updated";
    return [...books].sort((a, b) => {
      if (sort === "progress") {
        return String(b.progress?.updatedAt || "").localeCompare(String(a.progress?.updatedAt || ""))
          || String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
      }
      if (sort === "chapters") return Number(b.chapterCount || 0) - Number(a.chapterCount || 0);
      if (sort === "chars") return Number(b.charCount || 0) - Number(a.charCount || 0);
      if (sort === "size") return Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0);
      if (sort === "title") return String(a.title || "").localeCompare(String(b.title || ""), "zh-Hans-CN");
      return String(b.updatedAt || b.progress?.updatedAt || "").localeCompare(String(a.updatedAt || a.progress?.updatedAt || ""));
    });
  }

  function sortNovelBooksLocalFirst(books = [], forcedSort = "") {
    return sortNovelBooks(books, forcedSort).sort((a, b) => {
      const aLocal = isLocalPriorityBook(a) ? 0 : 1;
      const bLocal = isLocalPriorityBook(b) ? 0 : 1;
      return aLocal - bLocal;
    });
  }

  function isLocalPriorityBook(book = {}) {
    return Boolean(book.local || book.cachedLocal || isLocalBookId(book.id));
  }

  function createNovelControls(data = {}) {
    const wrap = document.createElement("div");
    wrap.className = `novel-mobile-controls${listState.searchOpen || listState.query ? " is-searching" : ""}`;

    const tabs = document.createElement("div");
    tabs.className = "novel-mobile-library-tabs";
    for (const [mode, label] of [["books", "书库"], ["authors", "作者"]]) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = listState.mode === mode ? "active" : "";
      tab.textContent = label;
      tab.addEventListener("click", () => {
        if (listState.mode === mode) return;
        listState.mode = mode;
        listState.author = "";
        listState.category = "all";
        listState.query = "";
        listState.sort = mode === "authors" ? "books" : "updated";
        resetNovelRemoteLimits();
        renderCurrentView();
      });
      tabs.append(tab);
    }

    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = listState.mode === "authors" ? "搜索作者" : "搜索书名、作者、分类或章节";
    search.setAttribute("aria-label", "搜索小说");
    search.value = listState.query;
    const applySearch = () => {
      listState.query = search.value.trim();
      listState.searchOpen = Boolean(listState.query);
      resetNovelRemoteLimits();
      renderCurrentView();
    };
    search.addEventListener("change", applySearch);
    search.addEventListener("search", applySearch);
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      applySearch();
    });

    const searchToggle = document.createElement("button");
    searchToggle.type = "button";
    searchToggle.className = `novel-mobile-search-pill${listState.query ? " has-query" : ""}`;
    searchToggle.textContent = listState.query ? `搜：${listState.query}` : "搜书名/作者";
    searchToggle.title = listState.query ? `搜索：${listState.query}` : "搜索小说";
    searchToggle.addEventListener("click", () => {
      listState.searchOpen = !listState.searchOpen || Boolean(listState.query);
      renderCurrentView();
    });

    const searchBox = document.createElement("div");
    searchBox.className = `novel-mobile-search-box${listState.searchOpen || listState.query ? " open" : ""}`;
    if (listState.searchOpen || listState.query) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "novel-mobile-search-cancel";
      clear.textContent = "取消";
      clear.addEventListener("click", () => {
        listState.query = "";
        listState.searchOpen = false;
        resetNovelRemoteLimits();
        renderCurrentView();
      });
      searchBox.append(search, clear);
      window.requestAnimationFrame(() => search.focus());
    } else {
      searchBox.append(searchToggle);
    }

    const sortSelect = document.createElement("select");
    sortSelect.className = "novel-mobile-sort-select";
    sortSelect.setAttribute("aria-label", "小说排序");
    const sortOptions = listState.mode === "authors"
      ? [["books", "作品", "作品最多"], ["name", "姓名", "按作者名排序"], ["chapters", "章节", "章节最多"], ["size", "总量", "作品总量最大"], ["updated", "最近", "最近更新"]]
      : [["updated", "最近", "最近更新"], ["progress", "阅读", "最近阅读"], ["chapters", "章节", "章节最多"], ["size", "大小", "文件最大"], ["title", "书名", "按书名排序"]];
    for (const [value, label, title] of sortOptions) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.title = title;
      option.selected = listState.sort === value;
      sortSelect.append(option);
    }
    sortSelect.addEventListener("change", () => {
      if (listState.sort === sortSelect.value) return;
      listState.sort = sortSelect.value;
      resetNovelRemoteLimits();
      renderCurrentViewPreservingScroll();
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

    const localInput = createLocalNovelInput();

    const localImport = document.createElement("button");
    localImport.type = "button";
    localImport.className = "novel-mobile-tool-button local";
    localImport.textContent = busyButtonLabel("local", "导入");
    localImport.title = "选择 TXT 文件导入";
    localImport.disabled = listState.uploading;
    localImport.addEventListener("click", () => localInput.click());

    const smartImport = document.createElement("button");
    smartImport.type = "button";
    smartImport.className = "novel-mobile-tool-button local";
    smartImport.textContent = busyButtonLabel("scan", "目录");
    smartImport.title = "选择一个目录扫描 TXT";
    smartImport.disabled = listState.uploading;
    smartImport.addEventListener("click", scanLocalNovelFiles);

    const fileManagerImport = document.createElement("button");
    fileManagerImport.type = "button";
    fileManagerImport.className = "novel-mobile-tool-button local";
    fileManagerImport.textContent = busyButtonLabel("picker", "文件");
    fileManagerImport.title = "用系统文件管理器选择 TXT";
    fileManagerImport.disabled = listState.uploading;
    fileManagerImport.addEventListener("click", importFromSystemFileManager);

    const upload = document.createElement("button");
    upload.type = "button";
    upload.className = "novel-mobile-tool-button";
    upload.textContent = busyButtonLabel("upload", "上传");
    upload.title = "上传到远端书库";
    upload.disabled = listState.uploading;
    upload.addEventListener("click", () => uploadInput.click());
    const actionGroup = document.createElement("div");
    actionGroup.className = "novel-mobile-action-group";
    actionGroup.append(smartImport, fileManagerImport, localImport, upload);
    if (listState.source === "local") {
      const manage = document.createElement("button");
      manage.type = "button";
      manage.className = `novel-mobile-tool-button manage${isLocalSelectionMode() ? " active" : ""}`;
      manage.textContent = isLocalSelectionMode() ? "取消" : "管理";
      manage.title = isLocalSelectionMode() ? "退出书架管理" : "管理本地书架";
      manage.disabled = listState.uploading;
      manage.addEventListener("click", () => {
        if (isLocalSelectionMode()) {
          exitLocalSelectionMode();
        } else {
          listState.selectionMode = true;
        }
        renderCurrentViewPreservingScroll();
      });
      actionGroup.append(manage);
    }

    const toolRow = document.createElement("div");
    toolRow.className = "novel-mobile-tool-row";
    toolRow.append(searchBox, actionGroup);

    const categoryRow = document.createElement("div");
    categoryRow.className = "novel-mobile-category-row";
    if (listState.mode === "books") {
      categoryRow.append(createCategoryButton("all", "全部", data.summary?.totals?.books || data.total || 0));
      for (const item of data.facets || data.summary?.categories || []) {
        categoryRow.append(createCategoryButton(item.name, item.name, item.count));
      }
    }

    const filterRow = document.createElement("div");
    filterRow.className = "novel-mobile-filter-row";
    filterRow.append(categoryRow, sortSelect);

    wrap.append(tabs, toolRow, uploadInput, localInput);
    if (listState.mode === "books") wrap.append(filterRow);
    if (listState.author && listState.mode === "books") wrap.append(createNovelAuthorFilter());
    if (isLocalSelectionMode()) wrap.append(createLocalSelectionBar(data));
    return wrap;
  }

  function aggregateNovelAuthors(books = [], query = "") {
    const needle = String(query || "").trim().toLocaleLowerCase("zh-Hans-CN");
    const authors = new Map();
    for (const book of books) {
      const name = String(book.author || "").trim();
      if (!name || name === "未知作者") continue;
      if (needle && !name.toLocaleLowerCase("zh-Hans-CN").includes(needle)) continue;
      const item = authors.get(name) || { name, bookCount: 0, chapterCount: 0, sizeBytes: 0 };
      item.bookCount += 1;
      item.chapterCount += Number(book.chapterCount || 0);
      item.sizeBytes += Number(book.sizeBytes || 0);
      authors.set(name, item);
    }
    return sortNovelAuthors(Array.from(authors.values()));
  }

  function sortNovelAuthors(authors = []) {
    return [...authors].sort((a, b) => {
      if (listState.sort === "name") return a.name.localeCompare(b.name, "zh-Hans-CN");
      if (listState.sort === "chapters") return Number(b.chapterCount || 0) - Number(a.chapterCount || 0) || a.name.localeCompare(b.name, "zh-Hans-CN");
      if (listState.sort === "size") return Number(b.sizeBytes || 0) - Number(a.sizeBytes || 0) || a.name.localeCompare(b.name, "zh-Hans-CN");
      return Number(b.bookCount || 0) - Number(a.bookCount || 0) || a.name.localeCompare(b.name, "zh-Hans-CN");
    });
  }

  function mergeNovelAuthors(remote = [], local = []) {
    const authors = new Map();
    for (const item of [...remote, ...local]) {
      const name = String(item?.name || "").trim();
      if (!name) continue;
      const current = authors.get(name) || { name, bookCount: 0, chapterCount: 0, charCount: 0, sizeBytes: 0, updatedAt: "" };
      current.bookCount += Number(item.bookCount || 0);
      current.chapterCount += Number(item.chapterCount || 0);
      current.charCount += Number(item.charCount || 0);
      current.sizeBytes += Number(item.sizeBytes || 0);
      current.updatedAt = [current.updatedAt, item.updatedAt].filter(Boolean).sort().pop() || "";
      authors.set(name, current);
    }
    return sortNovelAuthors(Array.from(authors.values()));
  }

  function createNovelAuthorCard(author) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "novel-mobile-author-card";
    const avatar = document.createElement("span");
    avatar.textContent = author.name.slice(0, 1).toLocaleUpperCase();
    const body = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = author.name;
    const meta = document.createElement("small");
    meta.textContent = `${formatNumber(author.bookCount)} 本 · ${formatNumber(author.chapterCount)} 章 · ${formatBytes(author.sizeBytes)}`;
    body.append(name, meta);
    button.append(avatar, body);
    button.addEventListener("click", () => {
      listState.mode = "books";
      listState.author = author.name;
      listState.query = "";
      listState.category = "all";
      listState.sort = "title";
      resetNovelRemoteLimits();
      renderCurrentView();
    });
    return button;
  }

  function createNovelAuthorFilter() {
    const bar = document.createElement("div");
    bar.className = "novel-mobile-author-filter";
    const label = document.createElement("span");
    label.textContent = `只看 ${listState.author}`;
    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "查看全部";
    clear.addEventListener("click", () => {
      listState.author = "";
      listState.sort = "updated";
      resetNovelRemoteLimits();
      renderCurrentView();
    });
    bar.append(label, clear);
    return bar;
  }

  function createNovelLoadMore(total, visible, kind) {
    const remaining = Math.max(0, Number(total || 0) - Number(visible || 0));
    if (!remaining) return null;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "novel-mobile-load-more";
    button.textContent = `加载更多 · 还剩 ${formatNumber(remaining)} ${kind === "authors" ? "位作者" : "本"}`;
    button.addEventListener("click", () => {
      if (kind === "authors") listState.authorLimit += NOVEL_AUTHOR_PAGE_SIZE;
      else listState.remoteLimit += NOVEL_REMOTE_PAGE_SIZE;
      renderCurrentViewPreservingScroll();
    });
    return button;
  }

  function resetNovelRemoteLimits() {
    listState.remoteLimit = NOVEL_REMOTE_PAGE_SIZE;
    listState.authorLimit = NOVEL_AUTHOR_PAGE_SIZE;
  }

  function emptyNovelListMessage() {
    if (listState.query) return `没有搜到「${listState.query}」。`;
    if (listState.category !== "all") return `「${displayCategory(listState.category)}」分类暂时没有内容。`;
    return "小说库暂时没有内容，或电脑端暂时连不上。";
  }

  function createNovelEmptyState(data = {}) {
    const box = document.createElement("div");
    box.className = "novel-mobile-empty";

    const title = document.createElement("strong");
    title.textContent = listState.query ? "没有匹配的小说" : "暂时没有小说";

    const message = document.createElement("p");
    message.textContent = emptyNovelListMessage();

    const actions = document.createElement("div");
    actions.className = "novel-mobile-empty-actions";

    if (listState.query) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.textContent = "清空搜索";
      clear.addEventListener("click", () => {
        listState.query = "";
        listState.searchOpen = false;
        resetNovelRemoteLimits();
        renderCurrentView();
      });
      actions.append(clear);
    }

    box.append(title, message);
    if (actions.childElementCount) box.append(actions);
    return box;
  }

  function setNovelBusy(action) {
    // External text intents can overlap a picker or browser import. Each task
    // releases only its own busy state; action labels are not unique owners.
    const owner = {};
    novelBusyOwners.set(owner, action || "");
    listState.uploading = true;
    listState.busyAction = action || "";
    return owner;
  }

  function clearNovelBusy(owner) {
    if (!novelBusyOwners.delete(owner)) return;
    listState.uploading = novelBusyOwners.size > 0;
    listState.busyAction = "";
    for (const action of novelBusyOwners.values()) listState.busyAction = action;
  }

  function busyButtonLabel(action, label) {
    return listState.uploading && listState.busyAction === action ? `${label}中` : label;
  }

  function isLocalSelectionMode() {
    return listState.source === "local" && Boolean(listState.selectionMode);
  }

  function exitLocalSelectionMode() {
    listState.selectionMode = false;
    selectedLocalBookIds.clear();
  }

  function createLocalSelectionBar(data = {}) {
    const books = Array.isArray(data.books) ? data.books.filter((book) => book?.local && isLocalBookId(book.id)) : [];
    const bar = document.createElement("div");
    bar.className = "novel-mobile-selection-bar";
    const count = document.createElement("strong");
    count.textContent = `已选 ${formatNumber(selectedLocalBookIds.size)} 项`;

    const selectAll = document.createElement("button");
    selectAll.type = "button";
    selectAll.textContent = selectedLocalBookIds.size >= books.length && books.length ? "清空" : "全选";
    selectAll.addEventListener("click", () => {
      if (selectedLocalBookIds.size >= books.length && books.length) {
        selectedLocalBookIds.clear();
      } else {
        for (const book of books) selectedLocalBookIds.add(book.id);
      }
      renderCurrentViewPreservingScroll();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "删除书架";
    remove.disabled = selectedLocalBookIds.size <= 0;
    remove.addEventListener("click", removeSelectedLocalBooks);

    bar.append(count, selectAll, remove);
    return bar;
  }

  function createLocalNovelInput() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt,text/plain";
    input.multiple = true;
    input.className = "novel-mobile-upload-input";
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []);
      input.value = "";
      importLocalNovelFiles(files);
    });
    return input;
  }

  function sourceKicker() {
    if (listState.source === "local") return "本地小说";
    if (listState.source === "remote") return "书城";
    return "小说";
  }

  function sourceTitle() {
    if (listState.source === "local") return "本地书库";
    if (listState.source === "remote") return "书城";
    return "书城";
  }

  function visibleLocalBookCount() {
    let count = 0;
    for (const entry of localBooks.values()) {
      if (isVisibleLocalLibraryBook(entry?.book)) count += 1;
    }
    return count;
  }

  function isVisibleLocalLibraryBook(book = {}) {
    if (!book) return false;
    return !isSmallSharedTextBook(book);
  }

  function createCategoryButton(value, label, count) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = listState.category === value ? "active" : "";
    const name = displayCategory(label);
    button.textContent = value === "all" ? `${name} ${formatNumber(count || 0)}` : name;
    button.title = `${name} · ${formatNumber(count || 0)} 本`;
    button.addEventListener("click", () => {
      if (listState.category === value) return;
      listState.category = value || "all";
      resetNovelRemoteLimits();
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
    meta.textContent = compactBookProgress(book);
    button.append(title, meta);
    return button;
  }

  function readingProgressText(book = {}) {
    if (book.progressRecovery) return "续读位置待确认";
    if (!book.progress) return book.chapterCount ? `共 ${formatNumber(book.chapterCount)} 章` : "未读";
    return `已读 ${Math.round(readingProgress(book).overallRatio * 1000) / 10}%`;
  }

  function shouldShowInContinueReading(book = {}) {
    if (!book?.progress && !book?.progressRecovery) return false;
    if (!book.local) return true;
    if (book.sourceType === "remote-cache") return true;
    return !isSmallSharedTextBook(book);
  }

  function isSmallSharedTextBook(book = {}) {
    const title = String(book.title || "").trim().toLowerCase();
    const sourceType = String(book.sourceType || "").trim().toLowerCase();
    const looksShared = sourceType === "shared-text" && (title === "shared-text" || title === "shared text");
    if (!looksShared) return false;
    return Number(book.chapterCount || 0) <= 1 && Number(book.charCount || book.sizeBytes || 0) < 1200;
  }

  function createNovelCard(book = {}) {
    const card = document.createElement("article");
    card.className = "novel-mobile-card";
    card.role = "button";
    card.tabIndex = 0;
    const longPress = installNovelLongPress(card, () => openNovelBookActions(book));
    card.addEventListener("click", () => {
      if (longPress.consumeClick()) return;
      openReader(book);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        openNovelBookActions(book);
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openReader(book);
    });

    const cover = createCover(book);
    const body = document.createElement("div");
    body.className = "novel-mobile-card-body";
    const meta = document.createElement("span");
    meta.textContent = book.author && book.author !== "未知作者" ? book.author : "";
    if (meta.textContent) body.append(meta);
    card.setAttribute("aria-label", `${[book.title || "未命名小说", meta.textContent].filter(Boolean).join("，")}，长按管理`);
    card.append(cover, body);
    return card;
  }

  function installNovelLongPress(element, activate) {
    const LONG_PRESS_MS = 480;
    const MOVE_TOLERANCE_PX = 12;
    let timer = 0;
    let startX = 0;
    let startY = 0;
    let suppressClickUntil = 0;
    let lastActivatedAt = 0;

    const cancel = () => {
      if (timer) window.clearTimeout(timer);
      timer = 0;
      element.classList.remove("pressing");
    };
    const open = () => {
      cancel();
      suppressClickUntil = Date.now() + 800;
      lastActivatedAt = Date.now();
      navigator.vibrate?.(18);
      activate();
    };

    element.addEventListener("pointerdown", (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      startX = event.clientX;
      startY = event.clientY;
      cancel();
      element.classList.add("pressing");
      timer = window.setTimeout(open, LONG_PRESS_MS);
    }, { passive: true });
    element.addEventListener("pointermove", (event) => {
      if (!timer) return;
      if (Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_TOLERANCE_PX) cancel();
    }, { passive: true });
    element.addEventListener("pointerup", cancel, { passive: true });
    element.addEventListener("pointercancel", cancel, { passive: true });
    element.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse") cancel();
    }, { passive: true });
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (Date.now() - lastActivatedAt < 800) return;
      open();
    });

    return {
      consumeClick() {
        return Date.now() < suppressClickUntil;
      }
    };
  }

  function openNovelBookActions(book = {}) {
    const localBook = Boolean(book.local || isLocalBookId(book.id));
    const cachedRemote = Boolean(book.cachedLocal && !localBook);
    openMobileActionSheet({
      title: "小说操作",
      options: [
        {
          label: "查看详情",
          hidden: !detailBookId(book),
          select: () => showView("novelDetail", { id: detailBookId(book) }, { push: true })
        },
        {
          label: localBook || cachedRemote ? "导出 TXT" : "下载 TXT",
          select: () => downloadBook(book.cachedLocalId || book.id)
        },
        {
          label: cachedRemote ? "更新离线缓存" : "缓存整本",
          hidden: localBook,
          disabled: Boolean(cachingBookId),
          select: () => cacheBookFromList(book)
        },
        {
          label: "移除离线缓存",
          variant: "danger wide",
          hidden: !cachedRemote,
          select: () => removeCachedRemoteBook(book)
        },
        {
          label: localBook ? "从手机书架移除" : "删除小说",
          variant: "danger wide",
          closeOnSelect: false,
          select: (_value, button, close) => deleteNovelBook(book, button, close)
        }
      ]
    });
  }

  async function deleteNovelBook(book = {}, button, close) {
    if (!book.id) return;
    if (book.local || isLocalBookId(book.id)) {
      close?.();
      await removeLocalBook(book);
      return;
    }
    const operation = captureRemoteOperation(book);
    const title = book.title || "这本小说";
    if (!window.confirm(`确认从书库删除《${title}》？\n\n磁盘中的原始 TXT 不会删除，这本书也不会在重新扫描后自动恢复。`)) return;
    if (button) {
      button.disabled = true;
      button.textContent = "正在删除";
    }
    try {
      requireRemoteOperation(operation);
      const suffix = operation.sourceRealm ? `?sourceRealm=${encodeURIComponent(operation.sourceRealm)}` : "";
      await deleteJson(operation.sourceUrl, novelDetailPath(book.id) + suffix);
      if (book.cachedLocalId) {
        invalidateLocalBookReads(book.cachedLocalId);
        await deleteLocalNovelEntry(book.cachedLocalId).catch(() => {});
        invalidateLocalBookReads(book.cachedLocalId);
        localBooks.delete(book.cachedLocalId);
      }
      await clearCachedJsonByPrefix(operation.sourceUrl, "/api/novels").catch(() => {});
      if (!operation.isActive()) return;
      close?.();
      setStatus?.(`已删除小说：${title}`);
      renderCurrentViewPreservingScroll();
    } catch (error) {
      setStatus?.(`删除小说失败：${error.message || error}`, "error");
      if (button) {
        button.disabled = false;
        button.textContent = "删除小说";
      }
    }
  }

  function secondaryBookActionLabel(book = {}) {
    if (book.local || book.cachedLocal) return "导出";
    return cachingBookId === book.id ? "缓存中" : "缓存";
  }

  function handleSecondaryBookAction(book = {}) {
    if (book.local || book.cachedLocal) {
      downloadBook(book.cachedLocalId || book.id);
      return;
    }
    cacheBookFromList(book);
  }

  async function renderNovelDetail(id, isActive = () => true) {
    const page = beginNovelPage(isActive, "detail");
    isActive = page.isActive;
    deactivateReader();
    const bookId = String(id || "").trim();
    const path = novelMetaPath(bookId);
    const fullDetailPath = novelDetailPath(bookId);
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

    if (isLocalBookId(bookId)) {
      await renderLocalNovelDetail(bookId, page);
      return;
    }

    let sourceRealm = await readRemoteSourceRealm(activeUrl);
    const cached = await readCachedJson(activeUrl, fullDetailPath).catch(() => null);
    if (!isActive()) return;
    if (matchesRemotePayload(cached?.payload, bookId) && canUseRemotePayload(activeUrl, cached.payload)) {
      sourceRealm = rememberRemoteSourceRealm(activeUrl, cached.payload, { cached: true });
      renderedCache = true;
      renderNovelDetailData(cached.payload, cached);
    }
    let cachedRemoteEntry = await readOptionalLocalSummary(remoteCacheIdFromSourceId(bookId, sourceRealm), page,
      (entry, guard) => renderLocalNovelDetail(entry.book.id, page, guard));
    if (!isActive()) return;

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 16000, signal: isActive.signal });
      if (!isActive() || page.preferRecoveredLocal) return;
      if (!matchesRemotePayload(data, bookId)) throw new Error("返回的小说与请求不一致");
      const nextRealm = rememberRemoteSourceRealm(activeUrl, data);
      if (nextRealm !== sourceRealm) { renderedCache = false; cachedRemoteEntry = null; }
      sourceRealm = nextRealm;
      writeCachedJson(activeUrl, path, data).catch(() => {});
      await readOptionalLocalSummary(remoteCacheIdFromSourceId(bookId, sourceRealm), page);
      if (!isActive() || page.preferRecoveredLocal) return;
      await renderRemoteNovelDetailMeta(data, isActive);
    } catch (error) {
      if (!isActive() || page.preferRecoveredLocal) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存详情。", "quiet", false);
      } else if (cachedRemoteEntry) {
        await renderLocalNovelDetail(cachedRemoteEntry.book.id, page);
      } else {
        renderMessage(error.message || "书籍详情读取失败", "error");
      }
    }
  }

  async function readOptionalLocalSummary(bookId, page, onRecovered) {
    if (!bookId) return null;
    const retry = async () => {
      const entry = await ensureLocalNovelEntry(bookId);
      if (!page.isActive()) return null;
      clearLocalLibraryError(page);
      if (entry && !page.contentReady && onRecovered) {
        const didRecover = await onRecovered(entry, () => page.isActive() && !page.contentReady);
        if (page.isActive() && didRecover) page.preferRecoveredLocal = true;
      }
      return entry;
    };
    try { return await ensureLocalNovelEntry(bookId); }
    catch (error) { recordLocalLibraryError(page, error, retry); return null; }
  }

  async function renderLocalNovelDetail(bookId, page, isActive = page.isActive) {
    const retry = () => renderLocalNovelDetail(bookId, page, isActive);
    try {
      const entry = await readLocalCatalog(bookId);
      if (!isActive()) return;
      clearLocalLibraryError(page);
      if (!entry) { renderMessage("这本本地小说已经不在手机本地库里。", "error"); return; }
      focusLocalSource();
      renderNovelDetailData(localDetailData(entry));
      return true;
    } catch (error) {
      if (!isActive()) return;
      els.viewMeta.textContent = "本机库未能读取，书籍是否存在尚未确认";
      renderMessage("无法读取本地目录，请重试。旧库正文只能通过下方入口主动取回。", "error");
      recordLocalLibraryError(page, error, retry);
    }
  }

  async function renderRemoteNovelDetailMeta(data = {}, isActive = () => true) {
    const book = markRemoteBookWithCache(data.book || {});
    const sameDetailBook = String(detailState.book?.id || "") === String(book.id || "")
      && detailState.book?.sourceRealm === book.sourceRealm
      && detailState.book?.catalogRevision === book.catalogRevision;
    const fallbackChapters = sameDetailBook
      ? detailState.chapters
      : [];
    if (!sameDetailBook) detailState.progressChapterTitle = "";
    detailState.book = book;
    detailState.cacheEntry = null;
    detailState.chapters = fallbackChapters;
    catalogState.bookId = String(book.id || "");
    catalogState.query = "";
    catalogState.descending = false;
    catalogState.page = 0;
    catalogState.remotePaged = true;
    catalogState.total = Number(book.chapterCount || data.chapterTotal || 0);
    catalogState.filteredTotal = catalogState.total;
    catalogState.offset = 0;
    await loadRemoteDetailCatalogPage({
      anchor: book.progress?.chapterIndex || 1,
      isActive,
      render: true
    });
  }

  function renderNovelDetailData(data = {}, cacheEntry = null, options = {}) {
    if (novelPage?.isActive()) novelPage.contentReady = true;
    const book = markRemoteBookWithCache(data.book || {});
    const chapters = Array.isArray(data.chapters) ? data.chapters : [];
    const remotePaged = Boolean(options.remotePaged);
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";

    if (String(detailState.book?.id || "") !== String(book.id || "")) detailState.progressChapterTitle = "";
    detailState.book = book;
    detailState.cacheEntry = cacheEntry;
    detailState.chapters = chapters;
    const detailProgressIndex = Number((book.localProgress || book.progress)?.chapterIndex || 0);
    const detailProgressChapter = detailProgressIndex
      ? chapters.find((chapter) => Number(chapter.index) === detailProgressIndex)
      : null;
    if (detailProgressChapter?.title) detailState.progressChapterTitle = detailProgressChapter.title;

    els.viewKicker.textContent = bookCategoryLabel(book) || "小说";
    els.viewTitle.textContent = book.title || "小说详情";
    els.viewMeta.textContent = `${formatNumber(book.chapterCount || chapters.length || 0)} 章 · ${formatBytes(book.sizeBytes)}${suffix}`;
    els.viewContent.innerHTML = "";
    prepareCatalogState(book, chapters, book.progress?.chapterIndex || 1);
    if (remotePaged) {
      catalogState.remotePaged = true;
      catalogState.total = Number(options.catalog?.total || book.chapterCount || 0);
      catalogState.filteredTotal = Number(options.catalog?.filteredTotal ?? chapters.length);
      catalogState.offset = Number(options.catalog?.offset || 0);
      catalogState.page = Math.floor(catalogState.offset / NOVEL_CATALOG_PAGE_SIZE);
    }

    els.viewContent.append(createDetailHero(book, chapters));
    const recoveryBook = readableBookForReader(book);
    if (recoveryBook.progressRecovery) els.viewContent.append(createProgressRecoveryPanel(recoveryBook));
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
    meta.textContent = `${formatNumber(book.chapterCount || chapters.length || 0)} 章`;
    head.append(title, meta);
    catalog.append(head);
    if (options.catalogError) {
      const error = document.createElement("div");
      error.className = "novel-reader-catalog-loading error";
      error.textContent = options.catalogError;
      catalog.append(error);
    } else {
      catalog.append(createCatalogBrowser(book, chapters, {
        meta,
        serverPaged: remotePaged,
        loadPage: loadRemoteDetailCatalogPage,
        anchorIndex: book.progress?.chapterIndex || 1
      }));
    }
    els.viewContent.append(catalog);
    renderLocalLibraryErrorCard();
  }

  function createDetailHero(book, chapters) {
    const cachedRemote = isCachedRemoteBookForUi(book);
    const panel = document.createElement("section");
    panel.className = "novel-mobile-detail-hero";
    panel.append(createCover(book, "large"));

    const body = document.createElement("div");
    body.className = "novel-mobile-detail-body";
    const title = document.createElement("strong");
    title.textContent = book.title || "未命名小说";
    const meta = document.createElement("span");
    meta.textContent = [book.author || "未知作者", bookCategoryLabel(book), `${formatNumber(book.chapterCount)} 章`, formatBytes(book.sizeBytes)].filter(Boolean).join(" · ");
    const reading = document.createElement("div");
    reading.className = "novel-mobile-reading-status";
    if (cachedRemote) {
      const offline = document.createElement("small");
      offline.textContent = isRemoteCacheBook(book) && !normalizeSourceRealm(book.sourceRealm)
        ? "旧缓存来源未绑定，可本地阅读或导出，不会自动关联当前书库"
        : "已缓存到手机，可离线阅读";
      reading.append(offline);
    }
    const activeProgress = cachedRemote ? book.localProgress || book.progress : book.progress;
    const progressChapter = activeProgress
      ? chapters.find((chapter) => Number(chapter.index) === Number(activeProgress.chapterIndex)) || {
          index: Number(activeProgress.chapterIndex),
          title: detailState.progressChapterTitle || `第 ${formatNumber(activeProgress.chapterIndex)} 章`
        }
      : null;
    const latestChapter = book.chapterCount
      ? {
          index: Number(book.chapterCount),
          title: book.latestChapterTitle || `第 ${formatNumber(book.chapterCount)} 章`
        }
      : null;
    if (progressChapter) {
      reading.append(createMobileChapterShortcut("上次读到", book, progressChapter, false));
    } else {
      const unread = document.createElement("small");
      unread.textContent = "还没有阅读记录";
      reading.append(unread);
    }
    if (latestChapter && Number(latestChapter.index) !== Number(progressChapter?.index)) {
      reading.append(createMobileChapterShortcut("最新章节", book, latestChapter, true));
    }

    const actions = document.createElement("div");
    actions.className = "novel-mobile-detail-actions";
    const read = document.createElement("button");
    read.type = "button";
    read.className = "primary";
    read.textContent = readableBookForReader(book).progressRecovery ? "选择续读位置" : cachedRemote
      ? (book.progress ? "继续离线" : "离线阅读")
      : (book.progress ? "继续阅读" : "开始阅读");
    read.addEventListener("click", () => openReader(book, 1));
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = book.local || book.cachedLocal ? "导出TXT" : "下载TXT";
    download.addEventListener("click", () => downloadBook(book.cachedLocalId || book.id));
    actions.append(read, download);
    if (book.local) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = cachedRemote ? "移除缓存" : "移除本地";
      remove.addEventListener("click", () => removeLocalBook(book));
      actions.append(remove);
    } else {
      const cache = document.createElement("button");
      cache.type = "button";
      cache.textContent = book.cachedLocal ? "更新缓存" : cachingBookId === book.id ? "缓存中" : "缓存整本";
      cache.disabled = Boolean(cachingBookId);
      cache.addEventListener("click", () => {
        cacheBookFromList(book);
      });
      actions.append(cache);
      if (book.cachedLocal) {
        const removeCache = document.createElement("button");
        removeCache.type = "button";
        removeCache.className = "danger";
        removeCache.textContent = "移除缓存";
        removeCache.addEventListener("click", () => removeCachedRemoteBook(book));
        actions.append(removeCache);
      }
    }

    body.append(title, meta, reading, actions);
    panel.append(body);
    return panel;
  }

  function createMobileChapterShortcut(label, book, chapter, exactChapter) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "novel-mobile-chapter-shortcut";
    const caption = document.createElement("span");
    caption.textContent = label;
    const title = document.createElement("strong");
    title.textContent = `${formatNumber(chapter.index)} · ${chapter.title}`;
    button.append(caption, title);
    button.addEventListener("click", () => openReader(book, chapter.index, { exactChapter, chapter }));
    return button;
  }

  function createProgressRecoveryPanel(book) {
    const recovery = book.progressRecovery || {};
    const previous = recovery.previous || {};
    const panel = document.createElement("section");
    panel.className = "novel-mobile-summary-panel novel-progress-recovery";
    panel.setAttribute("role", "status");
    const title = document.createElement("strong");
    title.textContent = "续读位置待确认";
    const text = document.createElement("p");
    const oldPosition = previous.title || (previous.chapterIndex ? `原第 ${previous.chapterIndex} 章` : "原阅读位置");
    const oldRatio = Number.isFinite(previous.scrollRatio)
      ? `（旧章内 ${Math.round(previous.scrollRatio * 100)}%）` : "";
    text.textContent = recovery.reason === "legacy_unverified"
      ? `已保留${oldPosition}${oldRatio}的旧记录，但旧数据没有可验证的内容版本。请从目录确认续读章节。`
      : `已保留${oldPosition}${oldRatio}的旧记录。正文或目录已变化，暂不自动恢复阅读位置，请确认后继续。`;
    panel.append(title, text);
    const candidate = recovery.candidate;
    if (candidate?.chapterId && candidate.catalogRevision === book.catalogRevision) {
      const button = actionButton(`查看候选：${candidate.title || `第 ${candidate.chapterIndex} 章`}（从章首）`, () =>
        openReader(book, candidate.chapterIndex, { exactChapter: true,
          chapter: { id: candidate.chapterId, index: candidate.chapterIndex } }));
      panel.append(button);
    }
    const hint = document.createElement("small");
    hint.textContent = "选择目录中的章节或候选章节后，才会建立新的续读位置。";
    panel.append(hint);
    return panel;
  }

  function isCachedRemoteBookForUi(book = {}) {
    return Boolean((book.cachedLocal && !book.local) || isRemoteCacheBook(book));
  }

  function createChapterButton(book, chapter = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "novel-mobile-chapter";
    if (book.progress?.chapterIndex === chapter.index) button.classList.add("active");
    button.addEventListener("click", () => openReader(book, chapter.index || 1, { exactChapter: true, chapter }));
    const title = document.createElement("strong");
    title.textContent = chapter.title || `第 ${chapter.index || ""} 章`.trim();
    const meta = document.createElement("span");
    meta.textContent = `${formatNumber(chapter.charCount || 0)} 字`;
    button.append(title, meta);
    return button;
  }

  function prepareCatalogState(book, chapters, chapterIndex) {
    if (catalogState.bookId === String(book?.id || "")) return;
    catalogState.bookId = String(book?.id || "");
    catalogState.query = "";
    catalogState.descending = false;
    catalogState.page = catalogPageForChapter(chapters, chapterIndex, false);
    catalogState.remotePaged = false;
    catalogState.total = chapters.length;
    catalogState.filteredTotal = chapters.length;
    catalogState.offset = catalogState.page * NOVEL_CATALOG_PAGE_SIZE;
  }

  function createCatalogBrowser(book, chapters, options = {}) {
    const source = Array.isArray(chapters) ? chapters : [];
    const serverPaged = Boolean(options.serverPaged);
    const loadPage = options.loadPage || loadRemoteReaderCatalogPage;
    prepareCatalogState(book, source, book?.progress?.chapterIndex || readerState.chapter?.index || 1);
    const shell = document.createElement("div");
    shell.className = `novel-mobile-catalog-browser${options.drawer ? " drawer" : ""}`;
    const tools = document.createElement("div");
    tools.className = "novel-mobile-catalog-tools";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "搜索章节名或章数";
    search.setAttribute("aria-label", "搜索章节");
    search.value = catalogState.query;
    const order = actionButton(catalogState.descending ? "倒序" : "正序", () => {
      catalogState.descending = !catalogState.descending;
      catalogState.page = 0;
      if (serverPaged) {
        loadPage({ page: 0, anchor: catalogState.query ? 0 : options.anchorIndex || readerState.chapter?.index }).catch(() => {});
      } else {
        refresh();
      }
    });
    order.className = "novel-mobile-catalog-order";
    const previous = actionButton("上一段", () => {
      const page = Math.max(0, catalogState.page - 1);
      if (serverPaged) loadPage({ page }).catch(() => {});
      else {
        catalogState.page = page;
        refresh();
      }
    });
    const range = document.createElement("select");
    range.setAttribute("aria-label", "目录分段");
    const next = actionButton("下一段", () => {
      const page = catalogState.page + 1;
      if (serverPaged) loadPage({ page }).catch(() => {});
      else {
        catalogState.page = page;
        refresh();
      }
    });
    const status = document.createElement("span");
    status.className = "novel-mobile-catalog-status";
    const list = document.createElement("div");
    list.className = "novel-mobile-catalog-list";

    function refresh() {
      const query = String(catalogState.query || "").trim().toLocaleLowerCase("zh-Hans-CN");
      let filtered = source;
      let visible = source;
      let filteredTotal = Number(catalogState.filteredTotal || source.length);
      if (!serverPaged) {
        filtered = query
          ? source.filter((chapter) => String(chapter.title || "").toLocaleLowerCase("zh-Hans-CN").includes(query) || String(chapter.index || "").includes(query))
          : [...source];
        if (catalogState.descending) filtered.reverse();
        filteredTotal = filtered.length;
      }
      const pageCount = Math.max(1, Math.ceil(filteredTotal / NOVEL_CATALOG_PAGE_SIZE));
      if (serverPaged) catalogState.page = Math.floor(Number(catalogState.offset || 0) / NOVEL_CATALOG_PAGE_SIZE);
      catalogState.page = Math.max(0, Math.min(pageCount - 1, Number(catalogState.page || 0)));
      const start = catalogState.page * NOVEL_CATALOG_PAGE_SIZE;
      if (!serverPaged) visible = filtered.slice(start, start + NOVEL_CATALOG_PAGE_SIZE);

      order.textContent = catalogState.descending ? "倒序" : "正序";
      previous.disabled = catalogState.page <= 0;
      next.disabled = catalogState.page >= pageCount - 1;
      range.innerHTML = "";
      for (let page = 0; page < pageCount; page += 1) {
        const first = page * NOVEL_CATALOG_PAGE_SIZE + 1;
        const last = Math.min(filteredTotal, first + NOVEL_CATALOG_PAGE_SIZE - 1);
        const option = document.createElement("option");
        option.value = String(page);
        option.textContent = filteredTotal ? `${formatNumber(first)}–${formatNumber(last)}` : "无结果";
        option.selected = page === catalogState.page;
        range.append(option);
      }
      range.disabled = pageCount <= 1;
      status.textContent = query
        ? `找到 ${formatNumber(filteredTotal)} 章`
        : `每段 ${formatNumber(NOVEL_CATALOG_PAGE_SIZE)} 章`;
      if (options.meta) {
        options.meta.textContent = query
          ? `${formatNumber(filteredTotal)} / ${formatNumber(serverPaged ? catalogState.total : source.length)} 章`
          : `${formatNumber(serverPaged ? catalogState.total : source.length)} 章`;
      }
      list.innerHTML = "";
      for (const chapter of visible) {
        const button = createChapterButton(book, chapter);
        if (Number(chapter.index) === Number(readerState.chapter?.index)) button.classList.add("active");
        list.append(button);
      }
      if (!visible.length) {
        const empty = document.createElement("p");
        empty.className = "novel-mobile-catalog-empty";
        empty.textContent = "没有匹配的章节";
        list.append(empty);
      }
    }

    search.addEventListener("input", () => {
      catalogState.query = search.value;
      catalogState.page = 0;
      if (!serverPaged) {
        refresh();
        return;
      }
      window.clearTimeout(catalogSearchTimer);
      catalogSearchTimer = window.setTimeout(() => {
        loadPage({ page: 0, query: search.value }).catch(() => {});
      }, 260);
    });
    range.addEventListener("change", () => {
      const page = Math.max(0, Number(range.value || 0));
      if (serverPaged) loadPage({ page }).catch(() => {});
      else {
        catalogState.page = page;
        refresh();
      }
    });

    const pagination = document.createElement("div");
    pagination.className = "novel-mobile-catalog-pagination";
    pagination.append(previous, range, next);
    tools.append(search, order, pagination, status);
    shell.append(tools, list);
    refresh();
    return shell;
  }

  async function renderNovelReader(id, chapterIndex, isActive = () => true, anchor = {}) {
    const page = beginNovelPage(isActive, "reader");
    isActive = page.isActive;
    deactivateReader();
    const bookId = String(id || "").trim();
    const index = String(chapterIndex || "1").trim();
    const path = novelChapterPath(bookId, index, anchor);
    const activeUrl = getActiveUrl();
    const previousProgress = readerState.bookSourceUrl === activeUrl && String(readerState.book?.id || "") === bookId
      ? readerState.book?.progress || null : null;
    const previousRealm = normalizeSourceRealm(readerState.book?.sourceRealm);
    let renderedCache = false;

    const routeGuard = isActive;
    const session = { sourceUrl: activeUrl, routeGuard, bookId, anchor,
      confirmProgress: anchor.confirmProgress === "1" };
    readerState.session = session;
    readerState.progressBlocked = false;
    readerState.active = true;
    readerState.book = null;
    readerState.chapter = null;
    readerState.chapters = [];
    readerState.screen = null;
    isActive = () => isCurrentReaderSession(session);
    isActive.signal = routeGuard.signal;
    readerState.catalogOpen = false;
    readerState.catalogLoading = false;
    readerState.catalogError = "";
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
      await renderLocalNovelReader(bookId, index, isActive);
      return;
    }

    const sourceRealm = await readRemoteSourceRealm(activeUrl);
    if (!isActive()) return;
    session.sourceRealm = sourceRealm;
    const cachedRemoteEntry = await readOptionalLocalSummary(remoteCacheIdFromSourceId(bookId, sourceRealm), page,
      (entry, guard) => renderCachedReader(entry, index, anchor, () => isActive() && guard()));
    if (!isActive()) return;
    if (cachedRemoteEntry?.book) {
      try {
        if (await renderCachedReader(cachedRemoteEntry, index, anchor, isActive)) return;
      } catch (error) {
        if (!isActive()) return;
        recordLocalLibraryError(page, error, () => renderCachedReader(cachedRemoteEntry, index, anchor, isActive));
      }
    }

    const prefetchKey = remoteChapterPrefetchKey(activeUrl, bookId, index, sourceRealm, anchor.catalogRevision);
    const prefetched = takePrefetchedRemoteChapter(prefetchKey);
    if (matchesRemotePayload(prefetched, bookId, sourceRealm, index, anchor)) {
      const data = {
        ...prefetched,
        book: {
          ...prefetched.book,
          progress: (!prefetched.book?.progressRecovery && previousRealm === remotePayloadRealm(prefetched)
            && previousProgress?.catalogRevision === prefetched.book?.catalogRevision ? previousProgress : null)
            || prefetched.book?.progress || null
        }
      };
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      renderNovelReaderData(data);
      prefetchNextRemoteChapter(activeUrl, data);
      return;
    }

    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (matchesRemotePayload(cached?.payload, bookId, undefined, index, anchor) && canUseRemotePayload(activeUrl, cached.payload)) {
      session.sourceRealm = rememberRemoteSourceRealm(activeUrl, cached.payload, { cached: true });
      renderedCache = true;
      renderNovelReaderData(cached.payload, cached);
    }

    try {
      const pendingPrefetch = remoteChapterPrefetchRequests.get(prefetchKey);
      const data = await (pendingPrefetch || fetchJson(activeUrl, path, { timeoutMs: 18000, signal: isActive.signal }));
      prefetchedRemoteChapters.delete(prefetchKey);
      if (!isActive() || page.preferRecoveredLocal) return;
      if (!matchesRemotePayload(data, bookId, undefined, index, anchor)) {
        const error = new Error("章节或内容版本已变化，请返回详情重新选择续读位置");
        error.status = 409;
        throw error;
      }
      const nextRealm = rememberRemoteSourceRealm(activeUrl, data);
      if (session.sourceRealm !== nextRealm) renderedCache = false;
      session.sourceRealm = nextRealm;
      writeCachedJson(activeUrl, path, data).catch(() => {});
      const sameContent = readerState.book?.catalogRevision === data.book?.catalogRevision
        && readerState.chapter?.id === data.chapter?.id && readerState.chapter?.content === data.chapter?.content;
      const restoreRatio = renderedCache && sameContent && isReaderScreenMounted()
        ? readerState.restoreFrame !== null ? readerState.restoreRatio : captureReaderRatio()
        : undefined;
      renderNovelReaderData(data, null, restoreRatio === undefined ? {} : { restoreRatio });
      prefetchNextRemoteChapter(activeUrl, data);
    } catch (error) {
      if (!isActive() || page.preferRecoveredLocal) return;
      if (error.status === 409 || error.statusCode === 409) {
        readerState.progressBlocked = true;
        renderMessage("目录已更新，旧位置未覆盖。请返回详情确认续读章节。", "error");
        els.viewContent.append(actionButton("重新打开详情", () => showView("novelDetail", { id: bookId }, { push: true })));
        return;
      }
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存章节。", "quiet", false);
      } else {
        renderMessage(error.message || "章节读取失败", "error");
      }
    }
  }

  function remoteChapterPrefetchKey(activeUrl, bookId, chapterIndex, sourceRealm = remoteSourceRealms.get(activeUrl) || "", catalogRevision = "") {
    const tuple = [String(activeUrl || "").replace(/\/+$/, ""), sourceRealm, String(bookId || ""), String(chapterIndex || "")];
    if (catalogRevision) tuple.push(catalogRevision);
    return JSON.stringify(tuple);
  }

  function takePrefetchedRemoteChapter(key) {
    const data = prefetchedRemoteChapters.get(key) || null;
    if (data) prefetchedRemoteChapters.delete(key);
    return data;
  }

  function storePrefetchedRemoteChapter(key, data) {
    if (!data?.chapter) return;
    prefetchedRemoteChapters.delete(key);
    prefetchedRemoteChapters.set(key, data);
    while (prefetchedRemoteChapters.size > NOVEL_CHAPTER_PREFETCH_LIMIT) {
      const oldest = prefetchedRemoteChapters.keys().next().value;
      if (oldest === undefined) break;
      prefetchedRemoteChapters.delete(oldest);
    }
  }

  function prefetchNextRemoteChapter(activeUrl, data = {}) {
    const bookId = String(data.book?.id || "");
    const chapterIndex = Number(data.next?.index || 0);
    if (!bookId || !chapterIndex || remoteChapterPrefetchRequests.size >= NOVEL_CHAPTER_PREFETCH_LIMIT) return;
    const sourceRealm = remotePayloadRealm(data);
    const key = remoteChapterPrefetchKey(activeUrl, bookId, chapterIndex, sourceRealm, data.book?.catalogRevision);
    if (prefetchedRemoteChapters.has(key) || remoteChapterPrefetchRequests.has(key)) return;
    const anchor = chapterAnchor(data.book, data.next);
    const path = novelChapterPath(bookId, chapterIndex, anchor);
    const request = fetchJson(activeUrl, path, { timeoutMs: 12000 })
      .then((chapterData) => {
        if (!matchesRemotePayload(chapterData, bookId, sourceRealm, chapterIndex, anchor)
          || (remoteSourceRealms.has(activeUrl) && remoteSourceRealms.get(activeUrl) !== sourceRealm)) {
          throw new Error("预取章节来源已变化");
        }
        storePrefetchedRemoteChapter(key, chapterData);
        return chapterData;
      })
      .finally(() => remoteChapterPrefetchRequests.delete(key));
    remoteChapterPrefetchRequests.set(key, request);
    request.catch(() => {});
  }

  function renderNovelReaderData(data = {}, cacheEntry = null, options = {}) {
    if (!isCurrentReaderSession(readerState.session)) return;
    if (novelPage?.isActive()) novelPage.contentReady = true;
    cancelReaderRestore();
    window.clearTimeout(readerState.progressTimer);
    readerState.progressTimer = null;
    if (readerState.progressFrame !== null) window.cancelAnimationFrame(readerState.progressFrame);
    readerState.progressFrame = null;
    const book = data.book || {};
    const chapter = data.chapter || {};
    if (book.progressRecovery && !readerState.session.confirmProgress) {
      readerState.book = book;
      readerState.chapter = null;
      readerState.screen = null;
      els.viewContent.innerHTML = "";
      els.viewContent.append(createProgressRecoveryPanel(book),
        actionButton("打开目录确认位置", () => showView("novelDetail", { id: book.id }, { push: true })));
      return;
    }
    const settings = readerState.settings;
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";
    const previousBookId = String(readerState.book?.id || "");
    const previousSourceRealm = readerState.book?.sourceRealm;
    const previousRevision = readerState.book?.catalogRevision;
    const previousChapters = Array.isArray(readerState.chapters) ? readerState.chapters : [];

    readerState.book = book;
    readerState.bookSourceUrl = readerState.session.sourceUrl;
    readerState.chapter = chapter;
    readerState.prev = data.prev || null;
    readerState.next = data.next || null;
    const incomingChapters = Array.isArray(data.chapters) ? data.chapters : [];
    readerState.chapters = incomingChapters.length
      ? incomingChapters
      : previousBookId === String(book.id || "") && previousSourceRealm === book.sourceRealm
        && previousRevision === book.catalogRevision ? previousChapters : [];
    if (options.restore !== false) {
      readerState.pendingScrollRatio = progressMatchesChapter(book, chapter)
        ? Number(book.progress?.scrollRatio || 0)
        : 0;
    }

    els.viewKicker.textContent = book.title || "小说阅读";
    els.viewTitle.textContent = chapter.title || "章节";
    els.viewMeta.textContent = `${book.author || "未知作者"} · ${formatNumber(chapter.charCount || 0)} 字${suffix}`;
    els.viewContent.innerHTML = "";

    const screen = document.createElement("article");
    readerState.screen = screen;
    screen.className = [
      "novel-reader-screen",
      `theme-${settings.theme}`,
      `mode-${settings.readingMode}`,
      settings.night ? "night" : "",
      settings.eyeCare ? "eye-care" : "",
      readerState.settingsOpen ? "settings-open" : "",
      readerState.menuOpen ? "menu-open" : ""
    ].filter(Boolean).join(" ");
    screen.style.setProperty("--novel-reader-font", `${settings.fontSize}px`);
    screen.style.setProperty("--novel-reader-line", String(settings.lineHeight));
    screen.style.setProperty("--novel-reader-dim", readerBrightnessDim(settings));
    applyReaderBrightness(settings);
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
      progressMatchesChapter(book, chapter) ? book.progress?.scrollRatio : 0
    ) ?? 0);
    const toolbar = createReaderToolbar(Math.max(0, Math.min(1, ratioForControls)));

    screen.append(dimmer, topBar, title, meta, content, toolbar);
    if (readerState.settingsOpen) screen.append(createReaderSettingsPanel());
    els.viewContent.append(screen);
    if (readerState.catalogOpen) els.viewContent.append(createCatalogDrawer());
    renderLocalLibraryErrorCard();
    applyReaderImmersiveState();
    scheduleReaderMenuAutoHide();
    if (options.restoreRatio !== undefined) restoreReaderScroll(options.restoreRatio);
    else if (options.restore !== false) restoreReaderScroll();
  }

  function createCatalogDrawer() {
    const drawer = document.createElement("aside");
    drawer.className = "novel-reader-catalog-drawer";
    const head = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `目录 · ${formatNumber(readerState.book?.chapterCount || readerState.chapters?.length || 0)} 章`;
    const close = actionButton("关闭", () => toggleCatalog(false));
    head.append(title, close);
    drawer.append(head);
    if (readerState.catalogLoading) {
      const loading = document.createElement("div");
      loading.className = "novel-reader-catalog-loading";
      loading.textContent = "正在读取章节目录…";
      drawer.append(loading);
    } else if (readerState.catalogError) {
      const error = document.createElement("div");
      error.className = "novel-reader-catalog-loading error";
      error.textContent = readerState.catalogError;
      drawer.append(error);
    } else {
      drawer.append(createCatalogBrowser(readerState.book, readerState.chapters || [], {
        drawer: true,
        serverPaged: catalogState.remotePaged
      }));
    }
    return drawer;
  }

  function createReaderSettingsPanel() {
    const settings = readerState.settings;
    const panel = document.createElement("div");
    panel.className = "novel-reader-settings-panel";

    panel.append(
      createSwitchRow("跟随系统", settings.brightnessMode === "system", (enabled) => {
        updateSettings({ brightnessMode: enabled ? "system" : "custom" });
      }),
      createSliderRow("亮度", settings.brightnessMode === "system" ? "系统" : `${settings.brightness}%`, {
        min: 35,
        max: 100,
        step: 5,
        value: settings.brightness,
        formatValue: (value) => `${Math.round(value)}%`,
        onInput: (value, context) => {
          context.value.textContent = `${Math.round(value)}%`;
          syncBrightnessSystemButton(context.input, false);
          updateSettings({ brightness: value, brightnessMode: "custom" }, { live: true });
        },
        onChange: (value, context) => {
          context.value.textContent = `${Math.round(value)}%`;
          syncBrightnessSystemButton(context.input, false);
          updateSettings({ brightness: value, brightnessMode: "custom" }, { live: true, persist: true });
        }
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
      createSwitchRow("夜间模式", settings.night, (night) => updateSettings({ night, eyeCare: night ? false : settings.eyeCare }))
    );
    return panel;
  }

  function createReaderToolbar(ratio = 0) {
    const toolbar = document.createElement("nav");
    toolbar.className = "novel-reader-toolbar";
    toolbar.addEventListener("pointerdown", keepReaderMenuVisible, { passive: true });
    toolbar.addEventListener("focusin", keepReaderMenuVisible);

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
    slider.dataset.novelChapterSlider = "";
    slider.setAttribute("aria-label", "阅读进度");
    slider.addEventListener("input", () => {
      keepReaderMenuVisible();
      const nextRatio = Number(slider.value) / 100;
      scrollReaderToRatio(nextRatio);
      updateReaderProgressUi(nextRatio);
    });
    slider.addEventListener("change", scheduleReaderProgress);
    progressRow.append(prev, slider, next);

    const actionRow = document.createElement("div");
    actionRow.className = "novel-reader-action-row";
    actionRow.append(
      readerToolButton("目录", () => toggleCatalog()),
      readerToolButton("书库", () => openNovelLibrary()),
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
    input.addEventListener("input", () => {
      const number = Number(input.value);
      if (typeof options.formatValue === "function") value.textContent = options.formatValue(number);
      options.onInput?.(number, { input, value });
    });
    input.addEventListener("change", () => {
      const number = Number(input.value);
      if (typeof options.formatValue === "function") value.textContent = options.formatValue(number);
      options.onChange?.(number, { input, value });
    });
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

  function syncBrightnessSystemButton(input, enabled) {
    const panel = input?.closest?.(".novel-reader-settings-panel");
    const button = panel?.querySelector(".novel-reader-setting-row:first-child button");
    if (!button) return;
    button.textContent = enabled ? "开启" : "关闭";
    button.classList.toggle("active", enabled);
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
    prepareCatalogState(readerState.book, readerState.chapters || [], readerState.chapter?.index || 1);
    readerState.catalogOpen = force === undefined ? !readerState.catalogOpen : Boolean(force);
    const needsCatalog = readerState.catalogOpen && !hasReaderCatalogForCurrentChapter();
    if (needsCatalog) {
      readerState.catalogLoading = true;
      readerState.catalogError = "";
    }
    if (readerState.catalogOpen) {
      readerState.menuOpen = true;
      readerState.settingsOpen = false;
      if (!catalogState.query) {
        catalogState.page = catalogPageForChapter(readerState.chapters, readerState.chapter?.index, catalogState.descending);
      }
    }
    renderNovelReaderData({
      book: readerState.book,
      chapter: readerState.chapter,
      chapters: readerState.chapters,
      prev: readerState.prev,
      next: readerState.next
    }, null, { restoreRatio: ratio });
    if (needsCatalog) loadReaderCatalog().catch(() => {});
  }

  function hasReaderCatalogForCurrentChapter() {
    const total = Number(readerState.book?.chapterCount || 0);
    if (total > 0 && Number(readerState.chapters?.length || 0) >= total) return true;
    if (!catalogState.remotePaged || catalogState.bookId !== String(readerState.book?.id || "")) return false;
    if (catalogState.query) return true;
    const current = Number(readerState.chapter?.index || 0);
    return current > 0 && readerState.chapters.some((chapter) => Number(chapter.index) === current);
  }

  async function loadReaderCatalog() {
    const page = novelPage;
    const session = readerState.session;
    const book = readerState.book || {};
    const bookId = String(book.id || "");
    if (!bookId) return;
    if (!isLocalBookId(bookId)) {
      return loadRemoteReaderCatalogPage({ anchor: readerState.chapter?.index || 1 });
    }
    const requestId = ++catalogRequestId;
    const isCurrent = () => isCurrentReaderSession(session) && requestId === catalogRequestId
      && bookId === String(readerState.book?.id || "");
    let catalogReadFinished = false;
    try {
      const entry = await readLocalCatalog(bookId);
      catalogReadFinished = true;
      if (!isCurrent()) return;
      if (!entry || entry.generation !== readerState.book?.localGeneration) throw new Error("本地内容已更新，请重新打开章节。");
      const chapters = (entry?.chapters || []).map(({ content, ...summary }) => summary);
      if (!isCurrent()) return;
      readerState.chapters = chapters;
      catalogState.remotePaged = false;
      catalogState.bookId = bookId;
      catalogState.total = chapters.length;
      catalogState.filteredTotal = chapters.length;
      catalogState.offset = 0;
      readerState.catalogError = "";
      clearLocalLibraryError(page);
      if (!catalogState.query) {
        catalogState.page = catalogPageForChapter(readerState.chapters, readerState.chapter?.index, catalogState.descending);
      }
    } catch (error) {
      if (!isCurrent()) return;
      readerState.catalogError = error.message || "章节目录读取失败";
      if (!catalogReadFinished) recordLocalLibraryError(page, error, () => loadReaderCatalog());
    } finally {
      if (!isCurrent()) return;
      readerState.catalogLoading = false;
      if (readerState.catalogOpen) {
        const ratio = captureReaderRatio();
        renderNovelReaderData(currentReaderData(), null, { restoreRatio: ratio });
      }
    }
  }

  async function loadRemoteReaderCatalogPage(options = {}) {
    const session = readerState.session;
    const book = readerState.book || {};
    const bookId = String(readerState.book?.id || "");
    if (!bookId) return;
    const requestId = ++catalogRequestId;
    const isCurrent = () => isCurrentReaderSession(session) && requestId === catalogRequestId
      && bookId === String(readerState.book?.id || "");
    const query = String(options.query ?? catalogState.query ?? "").replace(/\s+/g, " ").trim();
    catalogState.query = query;
    const params = new URLSearchParams({
      limit: String(NOVEL_CATALOG_PAGE_SIZE),
      order: catalogState.descending ? "desc" : "asc"
    });
    if (query) params.set("q", query);
    if (!query && Number(options.anchor || 0) > 0) params.set("anchor", String(options.anchor));
    else params.set("offset", String(Math.max(0, Number(options.page ?? catalogState.page ?? 0)) * NOVEL_CATALOG_PAGE_SIZE));
    addCatalogPreconditions(params, book);
    const ratio = captureReaderRatio();
    readerState.catalogLoading = true;
    readerState.catalogError = "";
    if (readerState.catalogOpen) renderNovelReaderData(currentReaderData(), null, { restoreRatio: ratio });
    try {
      const data = await fetchJson(session.sourceUrl, novelCatalogPath(bookId, params), { timeoutMs: 16000, signal: session.routeGuard.signal });
      if (!isCurrent()) return;
      if (!canUseRemotePayload(session.sourceUrl, data)
        || !matchesRemotePayload(data, bookId, session.sourceRealm || "", undefined, chapterAnchor(book))) throw new Error("目录所属书库、书籍或内容版本已变化，请重新打开详情");
      readerState.chapters = Array.isArray(data.chapters) ? data.chapters : [];
      catalogState.remotePaged = true;
      catalogState.bookId = bookId;
      catalogState.total = Number(data.total || readerState.book?.chapterCount || 0);
      catalogState.filteredTotal = Number(data.filteredTotal || 0);
      catalogState.offset = Number(data.offset || 0);
      catalogState.page = Math.floor(catalogState.offset / NOVEL_CATALOG_PAGE_SIZE);
      readerState.catalogError = "";
    } catch (error) {
      if (!isCurrent()) return;
      readerState.catalogError = error.message || "章节目录读取失败";
    } finally {
      if (!isCurrent()) return;
      readerState.catalogLoading = false;
      if (readerState.catalogOpen) {
        const nextRatio = captureReaderRatio();
        renderNovelReaderData(currentReaderData(), null, { restoreRatio: nextRatio });
      }
    }
  }

  async function loadRemoteDetailCatalogPage(options = {}) {
    const book = detailState.book || {};
    const operation = captureRemoteOperation(book);
    const bookId = String(book.id || "");
    if (!bookId) return;
    const requestId = ++detailCatalogRequestId;
    const isActive = options.isActive || (() => true);
    const query = String(options.query ?? catalogState.query ?? "").replace(/\s+/g, " ").trim();
    catalogState.query = query;
    const params = new URLSearchParams({
      limit: String(NOVEL_CATALOG_PAGE_SIZE),
      order: catalogState.descending ? "desc" : "asc"
    });
    if (query) params.set("q", query);
    if (!query && Number(options.anchor || 0) > 0) params.set("anchor", String(options.anchor));
    else params.set("offset", String(Math.max(0, Number(options.page ?? catalogState.page ?? 0)) * NOVEL_CATALOG_PAGE_SIZE));
    addCatalogPreconditions(params, book);
    const path = novelCatalogPath(bookId, params);
    const scrollY = window.scrollY;
    try {
      let data;
      try {
        requireRemoteOperation(operation);
        data = await fetchJson(operation.sourceUrl, path, { timeoutMs: 16000, signal: isActive.signal });
        requireRemoteOperation(operation);
        if (!canUseRemotePayload(operation.sourceUrl, data)
          || !matchesRemotePayload(data, bookId, operation.sourceRealm, undefined, chapterAnchor(book))) throw new Error("目录所属书库、书籍或内容版本已变化，请重新打开详情");
        writeCachedJson(operation.sourceUrl, path, data).catch(() => {});
      } catch (error) {
        requireRemoteOperation(operation);
        const cached = await readCachedJson(operation.sourceUrl, path).catch(() => null);
        if (!cached?.payload?.chapters) throw error;
        if (!canUseRemotePayload(operation.sourceUrl, cached.payload)
          || !matchesRemotePayload(cached.payload, bookId, operation.sourceRealm, undefined, chapterAnchor(book))) throw error;
        data = cached.payload;
      }
      if (!isActive() || !operation.isActive() || requestId !== detailCatalogRequestId || bookId !== String(detailState.book?.id || "")
        || book.sourceRealm !== detailState.book?.sourceRealm) return;
      detailState.chapters = Array.isArray(data.chapters) ? data.chapters : [];
      catalogState.remotePaged = true;
      catalogState.bookId = bookId;
      catalogState.total = Number(data.total || book.chapterCount || 0);
      catalogState.filteredTotal = Number(data.filteredTotal || 0);
      catalogState.offset = Number(data.offset || 0);
      catalogState.page = Math.floor(catalogState.offset / NOVEL_CATALOG_PAGE_SIZE);
      if (options.render !== false) {
        renderNovelDetailData({ book, chapters: detailState.chapters }, detailState.cacheEntry, {
          remotePaged: true,
          catalog: data
        });
        window.requestAnimationFrame(() => {
          if (!isActive() || !operation.isActive() || requestId !== detailCatalogRequestId
            || bookId !== String(detailState.book?.id || "") || book.sourceRealm !== detailState.book?.sourceRealm) return;
          window.scrollTo({ top: scrollY, behavior: "auto" });
        });
      }
    } catch (error) {
      if (!isActive() || !operation.isActive() || requestId !== detailCatalogRequestId || bookId !== String(detailState.book?.id || "")
        || book.sourceRealm !== detailState.book?.sourceRealm) return;
      if (detailState.chapters.length >= Number(book.chapterCount || 0)) {
        renderNovelDetailData({ book, chapters: detailState.chapters }, detailState.cacheEntry);
        renderMessage("目录服务暂时不可用，当前显示完整缓存目录。", "quiet", false);
      } else {
        renderNovelDetailData({ book, chapters: detailState.chapters }, detailState.cacheEntry, {
          remotePaged: true,
          catalogError: error.message || "章节目录读取失败"
        });
      }
    }
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
    if (readerState.settingsOpen) {
      readerState.catalogOpen = false;
    }
    renderNovelReaderData(currentReaderData(), null, { restoreRatio: ratio });
  }

  function openAdjacent(direction) {
    const target = direction < 0 ? readerState.prev : readerState.next;
    if (!target || !readerState.book?.id) return;
    openReader(readerState.book, target.index || 1, { exactChapter: true, chapter: target });
  }

  function openNovelLibrary() {
    flushReaderProgress();
    readerState.menuOpen = false;
    readerState.settingsOpen = false;
    readerState.catalogOpen = false;
    showView("novels", {}, { resetStack: true });
  }

  function openReader(book = {}, fallbackIndex = 1, options = {}) {
    const target = readableBookForReader(book);
    if (!target?.id) return;
    flushReaderProgress();
    if (!options.exactChapter && target.progressRecovery) {
      showView("novelDetail", { id: target.id }, { push: true });
      return;
    }
    const chapterIndex = options.exactChapter
      ? fallbackIndex
      : target.progress?.chapterIndex || fallbackIndex || 1;
    // A remote catalog cannot select an ordinal in a different offline edition.
    if (options.exactChapter && target.id !== book.id) {
      showView("novelDetail", { id: target.id }, { push: true });
      setStatus?.("已打开本机缓存目录，请在此选择离线章节");
      return;
    }
    const chapter = options.exactChapter ? options.chapter || {} : { id: target.progress?.chapterId };
    showView("novelReader", {
      id: target.id,
      chapterIndex: String(chapterIndex),
      ...chapterAnchor(target, chapter),
      ...(options.exactChapter ? { confirmProgress: "1" } : {})
    }, { push: true });
  }

  function readableBookForReader(book = {}) {
    if (!book.cachedLocalId) return book;
    const entry = localBooks.get(book.cachedLocalId);
    if (entry?.book) return entry.book;
    return {
      ...book,
      id: book.cachedLocalId,
      local: true,
      progress: book.localProgress || null,
      progressRecovery: book.localProgressRecovery || null,
      catalogRevision: undefined
    };
  }

  function detailBookId(book = {}) {
    return String(book.cachedLocalId || book.id || "").trim();
  }

  function createCover(book = {}, size = "") {
    const cover = document.createElement("div");
    cover.className = `novel-mobile-cover ${size}`.trim();
    const title = document.createElement("strong");
    title.textContent = book.title || "小说";
    cover.append(title);
    return cover;
  }

  function scanLocalNovelFiles() {
    const plugin = nativeNovelPlugin();
    if (!plugin?.openTextDirectoryPicker || !plugin?.readScannedTextFile) {
      setStatus?.("当前环境不能扫描目录，请用「导入」选择文件。", "error");
      return;
    }
    if (listState.uploading) return;
    const busyOwner = setNovelBusy("scan");
    setStatus?.("请选择一个目录扫描 TXT");
    renderCurrentView();

    Promise.resolve()
      .then(async () => {
        const scan = await plugin.openTextDirectoryPicker({
          maxFiles: DEVICE_TEXT_SCAN_LIMIT,
          maxDepth: DEVICE_TEXT_SCAN_DEPTH,
          maxNodes: DEVICE_TEXT_SCAN_NODE_LIMIT
        });
        if (scan?.canceled) {
          clearNovelBusy(busyOwner);
          setStatus?.("已取消目录扫描。");
          renderCurrentView();
          return;
        }
        const errors = Array.isArray(scan?.errors) ? scan.errors : [];
        const scanTruncated = Boolean(scan?.truncated);
        if (scan?.rootFailed) {
          clearNovelBusy(busyOwner);
          setStatus?.("所选目录无法读取，请重新选择一个可访问的目录。", "error");
          renderCurrentView();
          return;
        }

        const items = Array.isArray(scan?.items) ? scan.items : [];
        if (!items.length) {
          clearNovelBusy(busyOwner);
          const partialText = scanTruncated ? "扫描已达到安全上限，可能仍有目录未检查。" : "";
          setStatus?.(errors.length
            ? `目录中没有可导入的 TXT，另有 ${formatNumber(errors.length)} 个子目录无法读取。${partialText}`
            : `所选目录中没有可导入的 TXT。${partialText}`, errors.length || scanTruncated ? "error" : "");
          renderCurrentView();
          return;
        }

        const selectedItems = await confirmScanImport(items, scanTruncated);
        if (!selectedItems?.length) {
          clearNovelBusy(busyOwner);
          setStatus?.("已取消扫描导入。");
          renderCurrentView();
          return;
        }

        let imported = 0;
        let skipped = 0;
        for (const item of selectedItems) {
          try {
            const file = await plugin.readScannedTextFile({ uri: item.uri || "" });
            await saveLocalTextFile({
              fileName: file.fileName || item.fileName,
              sizeBytes: Number(file.sizeBytes || item.sizeBytes || 0),
              lastModified: Number(file.lastModified || item.lastModified || 0),
              encoding: file.encoding,
              text: file.text,
              sourceUri: file.uri || item.uri || "",
              sourceType: "document-tree"
            });
            imported += 1;
            setStatus?.(`扫描导入 ${formatNumber(imported + skipped)}/${formatNumber(selectedItems.length)}：${file.fileName || item.fileName || "TXT"}`);
          } catch (error) {
            skipped += 1;
            setStatus?.(`已跳过 ${formatNumber(skipped)} 本读取失败的 TXT：${item.fileName || "TXT"}`);
          }
        }

        clearNovelBusy(busyOwner);
        focusLocalLibraryAfterImport();
        const directorySkips = errors.length;
        const partialText = scanTruncated ? "；扫描已达到安全上限，可能仍有目录未检查" : "";
        setStatus?.(`${skipped || directorySkips
          ? `已导入 ${formatNumber(imported)} 本，跳过 ${formatNumber(skipped)} 本 TXT，${formatNumber(directorySkips)} 个子目录无法读取`
          : `已从所选目录导入 ${formatNumber(imported)} 本到手机本地书库`}${partialText}`);
        renderCurrentView();
      })
      .catch((error) => {
        clearNovelBusy(busyOwner);
        setStatus?.(`扫描导入失败：${error.message || error}`, "error");
        renderCurrentView();
      });
  }

  function importFromSystemFileManager() {
    const plugin = nativeNovelPlugin();
    if (!plugin?.openTextDocumentPicker) {
      const localInput = createLocalNovelInput();
      localInput.click();
      return;
    }
    if (listState.uploading) return;
    const busyOwner = setNovelBusy("picker");
    setStatus?.("正在打开系统文件管理器");
    renderCurrentView();

    Promise.resolve()
      .then(async () => {
        const result = await plugin.openTextDocumentPicker({ deferredRead: true });
        const errors = Array.isArray(result?.errors) ? result.errors : [];
        if (result?.canceled) {
          clearNovelBusy(busyOwner);
          setStatus?.("已取消文件管理器导入。");
          renderCurrentView();
          return;
        }
        if (result?.available === false) throw new Error(result.message || "文件管理器暂时不可用");
        // Older native versions ignore deferredRead and return complete items.
        // A documents array is authoritative even when empty: never import both.
        const deferredRead = Array.isArray(result?.documents);
        const selected = deferredRead ? result.documents : Array.isArray(result?.items) ? result.items : [];
        const seenUris = new Set();
        const items = selected.filter((item) => {
          const uri = typeof item?.uri === "string" ? item.uri.trim() : "";
          if (!uri) return true;
          if (seenUris.has(uri)) return false;
          seenUris.add(uri);
          return true;
        });
        if (!items.length) {
          clearNovelBusy(busyOwner);
          setStatus?.(errors.length ? `没有导入 TXT，${formatNumber(errors.length)} 个文件读取失败或不是 TXT。` : "没有选择可导入的 TXT。", errors.length ? "error" : "");
          renderCurrentView();
          return;
        }
        if (deferredRead && typeof plugin.readPickedTextFile !== "function") {
          throw new Error("当前原生组件不支持逐本读取 TXT，请更新应用后重试");
        }

        let imported = 0;
        let skipped = 0;
        let firstFailure = "";
        for (const item of items) {
          try {
            setStatus?.(`文件管理器读取 ${formatNumber(imported + skipped + 1)}/${formatNumber(items.length)}：${item?.fileName || "TXT"}`);
            const uri = typeof item?.uri === "string" ? item.uri.trim() : "";
            if (deferredRead && !uri) throw new Error("所选文档缺少 URI");
            const file = deferredRead ? await plugin.readPickedTextFile({ uri }) : item;
            if (file?.available === false || typeof file?.text !== "string") {
              throw new Error(file?.message || "未读取到 TXT 正文");
            }
            if (!/\S/.test(file.text)) throw new Error("TXT 内容为空，未替换已保存的小说");
            // Keep this read + durable save serial; the next document's text is
            // not requested while this document is being decoded or persisted.
            await saveLocalTextFile({
              fileName: file.fileName || item?.fileName || "local-text.txt",
              sizeBytes: Number(file.sizeBytes || item?.sizeBytes || 0),
              lastModified: Number(file.lastModified || item?.lastModified || 0),
              encoding: file.encoding,
              text: file.text,
              sourceUri: file.sourceUri || file.uri || uri,
              sourceType: "system-picker"
            });
            imported += 1;
            setStatus?.(`文件管理器导入 ${formatNumber(imported + skipped)}/${formatNumber(items.length)}：${file.fileName || item?.fileName || "TXT"}`);
          } catch (error) {
            skipped += 1;
            const reason = String(error?.message || error || "未知错误");
            firstFailure ||= reason;
            setStatus?.(`已跳过 ${formatNumber(skipped)} 本导入失败的 TXT：${item?.fileName || "TXT"}；${reason}`, "error");
          }
        }

        clearNovelBusy(busyOwner);
        focusLocalLibraryAfterImport();
        firstFailure ||= String(errors.find((error) => error?.message)?.message || "");
        const summary = skipped || errors.length
          ? `已导入 ${formatNumber(imported)} 本，跳过 ${formatNumber(skipped + errors.length)} 个文件`
          : `已从文件管理器导入 ${formatNumber(imported)} 本`;
        setStatus?.(`${summary}${firstFailure ? `；首个失败原因：${firstFailure}` : ""}`, skipped || errors.length ? "error" : "");
        renderCurrentView();
      })
      .catch((error) => {
        clearNovelBusy(busyOwner);
        setStatus?.(`文件管理器导入失败：${error.message || error}`, "error");
        renderCurrentView();
      });
  }

  function confirmScanImport(items = [], truncated = false) {
    const countText = formatNumber(items.length);
    const recommendedCount = items.filter((item) => item?.recommended !== false).length;
    const truncatedText = truncated ? "，扫描已达到安全上限，可能还有文件未显示" : "";
    if (typeof document === "undefined" || !document.body) {
      return Promise.resolve(window.confirm(`扫描到 ${countText} 个 TXT${truncatedText}。导入推荐的 ${formatNumber(recommendedCount)} 个？`)
        ? items.filter((item) => item?.recommended !== false)
        : []);
    }

    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "novel-scan-confirm-overlay";

      const dialog = document.createElement("div");
      dialog.className = "novel-scan-confirm-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");

      const title = document.createElement("strong");
      title.textContent = "扫描到的 TXT";

      const message = document.createElement("p");
      message.textContent = `共 ${countText} 个 TXT${truncatedText}，默认选中 ${formatNumber(recommendedCount)} 个更像小说的文件。`;

      const tools = document.createElement("div");
      tools.className = "novel-scan-confirm-tools";
      const selectedText = document.createElement("span");
      const selectRecommended = document.createElement("button");
      selectRecommended.type = "button";
      selectRecommended.textContent = "推荐";
      const selectAll = document.createElement("button");
      selectAll.type = "button";
      selectAll.textContent = "全选";
      const selectNone = document.createElement("button");
      selectNone.type = "button";
      selectNone.textContent = "清空";
      tools.append(selectedText, selectRecommended, selectAll, selectNone);

      const list = document.createElement("div");
      list.className = "novel-scan-confirm-list";
      const checks = [];
      for (const item of items) {
        const row = document.createElement("label");
        row.className = item.recommended === false ? "optional" : "recommended";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = item.recommended !== false;
        const name = document.createElement("span");
        name.textContent = item.fileName || "TXT";
        const meta = document.createElement("small");
        const sizeText = item.sizeKnown === false ? "大小未知" : formatBytes(item.sizeBytes);
        meta.textContent = `${sizeText || "大小未知"} · ${item.hint || (item.recommended === false ? "可选" : "推荐")}`;
        row.append(checkbox, name, meta);
        list.append(row);
        checks.push({ checkbox, item });
      }

      const actions = document.createElement("div");
      actions.className = "novel-scan-confirm-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "取消";
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "primary";
      confirm.textContent = "导入已选";
      actions.append(cancel, confirm);

      const selectedItems = () => checks.filter((entry) => entry.checkbox.checked).map((entry) => entry.item);
      const updateSelectedText = () => {
        const selectedCount = selectedItems().length;
        selectedText.textContent = `已选 ${formatNumber(selectedCount)} 项`;
        confirm.disabled = selectedCount <= 0;
      };
      for (const entry of checks) entry.checkbox.addEventListener("change", updateSelectedText);
      selectRecommended.addEventListener("click", () => {
        for (const entry of checks) entry.checkbox.checked = entry.item?.recommended !== false;
        updateSelectedText();
      });
      selectAll.addEventListener("click", () => {
        for (const entry of checks) entry.checkbox.checked = true;
        updateSelectedText();
      });
      selectNone.addEventListener("click", () => {
        for (const entry of checks) entry.checkbox.checked = false;
        updateSelectedText();
      });

      const close = (value) => {
        document.removeEventListener("keydown", onKeydown);
        overlay.remove();
        resolve(value);
      };
      const onKeydown = (event) => {
        if (event.key === "Escape") close(false);
      };

      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) close(false);
      });
      cancel.addEventListener("click", () => close(false));
      confirm.addEventListener("click", () => close(selectedItems()));
      document.addEventListener("keydown", onKeydown);

      updateSelectedText();
      dialog.append(title, message, tools, list, actions);
      overlay.append(dialog);
      document.body.append(overlay);
      confirm.focus();
    });
  }

  function uploadNovelFiles(files = []) {
    const txtFiles = files.filter((file) => file && (/\.txt$/i.test(file.name) || String(file.type || "").startsWith("text/")));
    if (!txtFiles.length) return;
    const busyOwner = setNovelBusy("upload");
    setStatus?.(`正在上传 ${formatNumber(txtFiles.length)} 本小说`);
    renderCurrentView();

    Promise.resolve()
      .then(async () => {
        let uploaded = 0;
        let localImported = 0;
        for (const file of txtFiles) {
          const decoded = await readNovelFileText(file);
          try {
            await postJson(getActiveUrl(), "/api/novels/upload", {
              fileName: file.name,
              sizeBytes: file.size,
              encoding: decoded.encoding,
              text: decoded.text
            });
            uploaded += 1;
            setStatus?.(`已上传 ${formatNumber(uploaded)}/${formatNumber(txtFiles.length)}：${file.name}`);
          } catch {
            await saveLocalTextFile({
              fileName: file.name,
              sizeBytes: file.size,
              lastModified: file.lastModified,
              encoding: decoded.encoding,
              text: decoded.text
            });
            localImported += 1;
            setStatus?.(`电脑书库不可用，已保存到手机本地：${file.name}`);
          }
        }
        clearNovelBusy(busyOwner);
        if (localImported) focusLocalLibraryAfterImport();
        setStatus?.(
          localImported
            ? `已上传 ${formatNumber(uploaded)} 本，另有 ${formatNumber(localImported)} 本保存到手机本地`
            : `已上传 ${formatNumber(uploaded)} 本小说`
        );
        renderCurrentView();
      })
      .catch((error) => {
        clearNovelBusy(busyOwner);
        setStatus?.(`上传失败：${error.message || error}`, "error");
        renderCurrentView();
      });
  }

  function importLocalNovelFiles(files = []) {
    const txtFiles = files.filter((file) => file && (/\.txt$/i.test(file.name) || String(file.type || "").startsWith("text/")));
    if (!txtFiles.length) return;
    const busyOwner = setNovelBusy("local");
    setStatus?.(`正在导入 ${formatNumber(txtFiles.length)} 本到手机本地`);
    renderCurrentView();

    Promise.resolve()
      .then(async () => {
        let imported = 0;
        for (const file of txtFiles) {
          const decoded = await readNovelFileText(file);
          await saveLocalTextFile({
            fileName: file.name,
            sizeBytes: file.size,
            lastModified: file.lastModified,
            encoding: decoded.encoding,
            text: decoded.text
          });
          imported += 1;
          setStatus?.(`已本地导入 ${formatNumber(imported)}/${formatNumber(txtFiles.length)}：${file.name}`);
        }
        clearNovelBusy(busyOwner);
        focusLocalLibraryAfterImport();
        setStatus?.(`已导入 ${formatNumber(imported)} 本到手机本地书库`);
        renderCurrentView();
      })
      .catch((error) => {
        clearNovelBusy(busyOwner);
        setStatus?.(`本地导入失败：${error.message || error}`, "error");
        renderCurrentView();
      });
  }

  async function downloadBook(bookId) {
    if (!bookId) return;
    if (isLocalBookId(bookId)) {
      const page = novelPage;
      let entry;
      try { entry = await readLocalNovelEntry(bookId); }
      catch (error) {
        if (page && !page.isActive()) return;
        recordLocalLibraryError(page, error, () => downloadBook(bookId), "重试导出");
        setStatus?.(`本地正文读取失败，尚未开始导出：${error.message || error}`, "error");
        return;
      }
      if (page && !page.isActive()) return;
      clearLocalLibraryError(page);
      if (!entry) {
        setStatus?.("这本本地小说已经不在手机本地库里。", "error");
        return;
      }
      const fileName = sanitizeTxtFileName(entry.book.fileName || `${entry.book.title || "本地小说"}.txt`);
      const content = composeLocalNovelText(entry);
      const plugin = nativeNovelPlugin();
      if (plugin?.exportTextFile) {
        setStatus?.(`请选择《${entry.book.title || "本地小说"}》的保存位置`);
        try {
          const result = await plugin.exportTextFile({ fileName, text: content });
          if (result?.canceled) {
            setStatus?.("已取消导出 TXT");
          } else {
            setStatus?.(`已保存 TXT：${result?.fileName || fileName}`);
          }
        } catch (error) {
          setStatus?.(`导出 TXT 失败：${error.message || error}`, "error");
        }
        return;
      }
      downloadTextFile(fileName, content);
      return;
    }
    const href = `${getActiveUrl()}/api/novels/${encodeURIComponent(bookId)}/download`;
    const link = document.createElement("a");
    link.href = href;
    link.download = "";
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function cacheBookFromList(book = {}) {
    if (!book.id || cachingBookId || preparingCache) return;
    const operation = captureRemoteOperation(book);
    preparingCache = true;
    setStatus?.(`正在准备缓存《${book.title || "小说"}》`);
    try {
      requireRemoteOperation(operation);
      if (!operation.sourceRealm) throw new Error("电脑端尚未提供稳定书库身份，请更新电脑端后再缓存");
      const path = novelDetailPath(book.id);
      const cached = await readCachedJson(operation.sourceUrl, path).catch(() => null);
      requireRemoteOperation(operation);
      let data = cached?.payload || null;
      if (book.cachedLocal || !matchesRemotePayload(data, book.id, operation.sourceRealm, undefined, chapterAnchor(book)) || !Array.isArray(data.chapters)) {
        data = await fetchJson(operation.sourceUrl, path, { timeoutMs: 18000 });
        requireRemoteOperation(operation);
        if (!matchesRemotePayload(data, book.id, operation.sourceRealm)) throw new Error("小说目录的来源已变化，请重新打开书库");
        writeCachedJson(operation.sourceUrl, path, data).catch(() => {});
      }
      const detailBook = { ...book, ...(data.book || {}) };
      const chapters = Array.isArray(data.chapters) ? data.chapters : [];
      if (!chapters.length) throw new Error("没有读到目录");
      await cacheWholeBook(detailBook, chapters, { renderDetail: false, operation });
    } catch (error) {
      setStatus?.(`缓存失败：${error.message || error}`, "error");
    } finally {
      preparingCache = false;
      if (operation.isActive()) renderCurrentViewPreservingScroll();
    }
  }

  async function openLocalTextReader(file = {}) {
    const entry = await saveLocalTextFile(file);
    focusLocalLibraryAfterImport();
    setStatus?.(`已加入手机本地书库：${entry.book.title}`);
    openReader(entry.book, 1);
  }

  async function renderCachedReader(entry, chapterIndex, anchor, isActive) {
    if (anchor.sourceRealm && normalizeSourceRealm(entry.book.sourceRealm) !== anchor.sourceRealm) return false;
    if (anchor.catalogRevision && entry.book.sourceCatalogRevision !== anchor.catalogRevision) return false;
    let localAnchor = {};
    if (anchor.chapterId) {
      const catalog = await readLocalCatalog(entry.book.id);
      if (!isActive()) return false;
      const chapter = catalog?.chapters.find((item) => item.sourceChapterId === anchor.chapterId
        && item.sourceCatalogRevision === anchor.catalogRevision);
      if (!chapter) return false;
      chapterIndex = chapter.index;
      localAnchor = chapterAnchor(catalog.book, chapter);
    }
    return renderLocalNovelReader(entry.book.id, chapterIndex, isActive, localAnchor);
  }

  async function renderLocalNovelReader(bookId, chapterIndex, isActive = () => true, anchor = readerState.session?.anchor || {}) {
    const page = novelPage;
    const version = localBookReadVersions.get(bookId) || 0;
    const progressVersion = localBookProgressVersions.get(bookId) || 0;
    let data;
    try { data = await readLocalNovelChapter(bookId, Math.max(1, Number(chapterIndex || 1)), anchor); }
    catch (error) {
      if (!isActive() || version !== (localBookReadVersions.get(bookId) || 0)) return;
      els.viewMeta.textContent = "本机库未能读取，章节是否存在尚未确认";
      renderMessage("本地章节读取失败，请重试。没有改用旧副本继续阅读。", "error");
      recordLocalLibraryError(page, error, () => renderLocalNovelReader(bookId, chapterIndex, isActive, anchor));
      return;
    }
    if (!isActive() || version !== (localBookReadVersions.get(bookId) || 0)) return;
    clearLocalLibraryError(page);
    if (!data?.chapter) {
      if (anchor.catalogRevision || anchor.chapterId) {
        readerState.progressBlocked = true;
        renderMessage("本地章节已更新或不再存在，旧位置未覆盖。请重新打开详情确认续读位置。", "error");
        els.viewContent.append(actionButton("重新打开详情", () => showView("novelDetail", { id: bookId }, { push: true })));
      } else renderMessage("这本本地小说或章节已经不在手机本地库里，请重新打开或导入。", "error");
      return;
    }
    const summary = rememberLocalBookSummary(data, progressVersion);
    focusLocalSource();
    renderNovelReaderData({ ...data, book: summary.book });
    return true;
  }

  async function saveLocalTextFile(file = {}) {
    const entry = createLocalBookEntry(file);
    if (readerState.active && (readerState.book?.id === entry.book.id || readerState.session?.bookId === entry.book.id)) deactivateReader();
    invalidateLocalBookReads(entry.book.id);
    const existing = await readLocalNovelEntry(entry.book.id);
    if (existing) {
      entry.createdAt = existing.createdAt || entry.createdAt;
    }
    const saved = await saveLocalNovelEntry(entry, { expectedGeneration: existing?.generation ?? null });
    if (!saved) throw new Error("本地小说已被其他操作更新，未覆盖内容；请重新导入");
    invalidateLocalBookReads(saved.book.id);
    return rememberLocalBookSummary(saved);
  }

  async function ensureLocalNovelEntry(bookId) {
    // Metadata-only lookup; whole-book reads are reserved for export/reimport.
    const id = String(bookId || "");
    if (localBooks.has(id)) return localBooks.get(id);
    const version = localBookReadVersions.get(id) || 0;
    const progressVersion = localBookProgressVersions.get(id) || 0;
    const entry = await readLocalNovelSummary(id);
    if (version !== (localBookReadVersions.get(id) || 0)) return localBooks.get(id) || null;
    return entry ? rememberLocalBookSummary(entry, progressVersion) : null;
  }

  async function readLocalCatalog(bookId) {
    const version = localBookReadVersions.get(bookId) || 0;
    const progressVersion = localBookProgressVersions.get(bookId) || 0;
    const entry = await readLocalNovelCatalog(bookId);
    if (version !== (localBookReadVersions.get(bookId) || 0)) return null;
    const summary = entry ? rememberLocalBookSummary(entry, progressVersion) : null;
    return summary ? { ...entry, book: summary.book } : null;
  }

  function localDetailData(entry) {
    return {
      book: entry.book,
      chapters: entry.chapters.map(({ content, ...summary }) => summary)
    };
  }

  async function removeLocalBook(book = {}) {
    if (!book.id || !isLocalBookId(book.id)) return;
    const cachedRemote = isCachedRemoteBookForUi(book);
    const title = book.title || (cachedRemote ? "缓存小说" : "本地小说");
    const target = cachedRemote ? "离线缓存" : "本地书库";
    if (!window.confirm(`从手机${target}移除《${title}》？`)) return;
    invalidateLocalBookReads(book.id);
    await deleteLocalNovelEntry(book.id);
    invalidateLocalBookReads(book.id);
    localBooks.delete(book.id);
    setStatus?.(`已移除${cachedRemote ? "缓存" : "本地小说"}：${title}`);
    showView("novels", {}, { resetStack: true });
  }

  async function removeSelectedLocalBooks() {
    const ids = Array.from(selectedLocalBookIds).filter((id) => isLocalBookId(id) && localBooks.has(id));
    if (!ids.length) return;
    if (!window.confirm(`从手机本地书架移除选中的 ${formatNumber(ids.length)} 本？不会删除原始 TXT 文件。`)) return;
    const busyOwner = setNovelBusy("remove");
    setStatus?.(`正在移除 ${formatNumber(ids.length)} 本本地小说`);
    try {
      let removed = 0;
      for (const id of ids) {
        invalidateLocalBookReads(id);
        await deleteLocalNovelEntry(id);
        invalidateLocalBookReads(id);
        localBooks.delete(id);
        selectedLocalBookIds.delete(id);
        removed += 1;
      }
      exitLocalSelectionMode();
      setStatus?.(`已从书架移除 ${formatNumber(removed)} 本本地小说`);
    } catch (error) {
      setStatus?.(`删除书架失败：${error.message || error}`, "error");
    } finally {
      clearNovelBusy(busyOwner);
      renderCurrentView();
    }
  }

  async function removeCachedRemoteBook(book = {}) {
    const cachedId = book.cachedLocalId || remoteCacheIdFromSourceId(book.id, book.sourceRealm);
    if (!cachedId) return;
    const entry = await ensureLocalNovelEntry(cachedId).catch(() => null);
    await removeLocalBook(entry?.book || { ...book, id: cachedId, local: true });
  }

  function createLocalBookEntry(file = {}) {
    const fileName = sanitizeTxtFileName(file.fileName || file.name || "local-text.txt");
    const text = String(file.text || "").trim() || "空白文本";
    const chapters = splitLocalTextChapters(text);
    const charCount = chapters.reduce((sum, chapter) => sum + chapter.charCount, 0);
    const now = new Date().toISOString();
    const sourceUri = String(file.sourceUri || "").trim() || String(file.uri || "").trim();
    const sourceType = file.sourceType || (sourceUri ? "native-file" : "local-file");
    const title = localBookTitle(fileName, text, sourceType);
    const lastModified = Number(file.lastModified || 0) || 0;
    const sizeBytes = Number(file.sizeBytes || new Blob([text]).size || text.length || 0);
    const sourceKey = sourceUri
      ? `uri:${sourceUri}`
      : `file:${fileName}|${sizeBytes}|${lastModified}|${text.length}|${text.slice(0, 512)}|${text.slice(-512)}`;
    const bookId = `local:file:${hashString(sourceKey)}`;
    const book = {
      id: bookId,
      local: true,
      sourceKey,
      sourceUri,
      sourceType,
      title,
      author: "本地文件",
      category: "本地",
      fileName,
      sizeBytes,
      lastModified,
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
        bookId,
        updatedAt: now
      }))
    };
  }

  function createCachedRemoteBookEntry(book = {}, chapters = []) {
    const now = new Date().toISOString();
    const remoteId = String(book.id || `${book.title || "novel"}:${book.author || ""}`);
    const sourceRealm = normalizeSourceRealm(book.sourceRealm);
    const localId = remoteCacheIdFromSourceId(remoteId, sourceRealm);
    if (!localId) throw new Error("电脑端尚未提供稳定书库身份，请更新电脑端后再缓存；已有本机小说仍可阅读和导出");
    const normalizedChapters = chapters
      .map((chapter, index) => {
        const chapterIndex = Math.max(1, Number(chapter?.index || index + 1) || index + 1);
        const content = String(chapter?.content || "").trim();
        if (!content) return null;
        return {
          ...chapter,
          id: undefined,
          sourceChapterId: chapter.id,
          sourceCatalogRevision: book.catalogRevision,
          bookId: localId,
          index: chapterIndex,
          title: String(chapter?.title || `正文 ${chapterIndex}`).trim(),
          content,
          charCount: Number(chapter?.charCount || content.length || 0),
          updatedAt: chapter?.updatedAt || book.updatedAt || now
        };
      })
      .filter(Boolean)
      .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
    const combinedText = normalizedChapters.map((chapter) => chapter.content).join("\n\n");
    const charCount = normalizedChapters.reduce((sum, chapter) => sum + Number(chapter.charCount || 0), 0);
    const title = String(book.title || "缓存小说").trim();
    const bookRow = {
      ...book,
      id: localId,
      local: true,
      sourceBookId: book.id || "",
      sourceRealm,
      sourceType: "remote-cache",
      catalogRevision: undefined,
      sourceCatalogRevision: book.catalogRevision,
      sourceProgress: book.progress || null,
      sourceProgressRecovery: book.progressRecovery || null,
      progress: null,
      progressRecovery: null,
      title,
      author: book.author || "远端书库",
      category: book.category || "离线缓存",
      fileName: sanitizeTxtFileName(book.fileName || title),
      sizeBytes: new Blob([combinedText]).size,
      charCount,
      chapterCount: normalizedChapters.length,
      latestChapterTitle: normalizedChapters[normalizedChapters.length - 1]?.title || book.latestChapterTitle || "正文",
      summary: book.summary || summarizeLocalText(combinedText),
      updatedAt: book.updatedAt || now,
      cachedAt: now
    };
    return {
      id: localId,
      book: bookRow,
      chapters: normalizedChapters,
      createdAt: now,
      updatedAt: now
    };
  }

  function splitLocalTextChapters(text) {
    const source = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
    const pattern = /(?:^|\n)(第[0-9零一二三四五六七八九十百千万两]+[章节卷回部篇][^\n]{0,40}|正文\s*[0-9零一二三四五六七八九十百千万两]+|Chapter\s+\d+[^\n]{0,40})\s*\n/gi;
    const matches = Array.from(source.matchAll(pattern));
    if (matches.length >= 2) {
      const chapters = [];
      const preamble = source.slice(0, matches[0].index).trim();
      if (preamble) chapters.push({ index: 1, title: "序言", content: preamble, charCount: preamble.length, preamble: true });
      for (let index = 0; index < matches.length; index += 1) {
        const match = matches[index];
        const start = match.index + match[0].length;
        const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
        const title = String(match[1] || `正文 ${index + 1}`).trim();
        const content = source.slice(start, end).trim() || title;
        chapters.push({ index: chapters.length + 1, title, content, charCount: content.length });
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

  function localBookTitle(fileName, text, sourceType) {
    const baseTitle = String(fileName || "").replace(/\.[^.]+$/, "").trim();
    if (String(sourceType || "").trim().toLowerCase() !== "shared-text") {
      return baseTitle || "本地文本";
    }
    if (baseTitle && baseTitle.toLowerCase() !== "shared-text") return baseTitle;
    return titleFromLocalText(text) || "本地文本";
  }

  function titleFromLocalText(text) {
    const line = String(text || "")
      .split(/\r?\n/)
      .map((item) => item.replace(/\s+/g, " ").trim())
      .find(Boolean) || "";
    return line.slice(0, 28);
  }

  function composeLocalNovelText(entry = {}) {
    // Imported TXT already has its title in the filename. An added heading here
    // becomes another preamble on every export/reimport cycle.
    const title = entry.book?.sourceType === "remote-cache" && entry.book?.title ? `${entry.book.title}\n\n` : "";
    return title + (entry.chapters || [])
      .map((chapter) => chapter.preamble || (entry.chapters.length === 1 && chapter.title === "正文")
        ? String(chapter.content || "").trim()
        : `${chapter.title || `正文 ${chapter.index || ""}`.trim()}\n\n${chapter.content || ""}`.trim())
      .join("\n\n");
  }

  function downloadTextFile(fileName, content) {
    const blob = new Blob([String(content || "")], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    try {
      link.href = href;
      link.download = sanitizeTxtFileName(fileName);
      document.body.append(link);
      link.click();
    } finally {
      link.remove();
      try { window.setTimeout(() => URL.revokeObjectURL(href), 1000); }
      catch { URL.revokeObjectURL(href); }
    }
  }

  function sanitizeTxtFileName(value) {
    const clean = String(value || "本地小说.txt").replace(/[\\/:*?"<>|\r\n]+/g, "_").trim() || "本地小说.txt";
    return /\.txt$/i.test(clean) ? clean : `${clean}.txt`;
  }

  function hashString(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function isLocalBookId(bookId) {
    return String(bookId || "").startsWith("local:");
  }

  async function cacheWholeBook(book = {}, chapters = [], options = {}) {
    if (!book.id || !chapters.length || cachingBookId) return;
    const operation = options.operation || captureRemoteOperation(book);
    const renderDetail = options.renderDetail !== false;
    if (options.confirmLarge !== false && !confirmWholeBookCache(book, chapters)) {
      setStatus?.("已取消整本缓存。");
      return null;
    }
    cachingBookId = book.id;
    let savedEntry = null;
    setStatus?.(`正在缓存《${book.title || "小说"}》到手机离线缓存`);
    if (renderDetail) renderNovelDetailData({ book, chapters });
    try {
      requireRemoteOperation(operation);
      if (!operation.sourceRealm) throw new Error("电脑端尚未提供稳定书库身份，请更新电脑端后再缓存");
      if (normalizeSourceRealm(book.sourceRealm) !== operation.sourceRealm) throw new Error("小说目录的书库来源不一致");
      if (!book.catalogRevision) throw new Error("电脑端尚未提供内容版本，请更新电脑端后再缓存；已有本机缓存仍可阅读");
      const localId = remoteCacheIdFromSourceId(book.id, operation.sourceRealm);
      const existing = await readLocalNovelSummary(localId);
      requireRemoteOperation(operation);
      const chapterIndexes = chapters.map((chapter) => Number(chapter.index));
      const chapterIds = chapters.map((chapter) => chapter.id);
      if (new Set(chapterIndexes).size !== chapters.length || chapterIndexes.some((index) => !Number.isInteger(index) || index < 1)
        || chapterIds.some((id) => typeof id !== "string" || !id) || new Set(chapterIds).size !== chapters.length
        || Number(book.chapterCount) !== chapters.length) {
        throw new Error("小说目录含重复或无效章节，尚未缓存");
      }
      let cached = 0;
      const localChapters = [];
      let latestBook = book;
      for (const chapter of chapters) {
        requireRemoteOperation(operation);
        const index = chapter.index || cached + 1;
        const anchor = chapterAnchor(book, chapter);
        const path = novelChapterPath(book.id, index, anchor);
        const cachedEntry = await readCachedJson(operation.sourceUrl, path).catch(() => null);
        requireRemoteOperation(operation);
        let data = cachedEntry?.payload || null;
        if (!matchesRemotePayload(data, book.id, operation.sourceRealm, index, anchor) || typeof data?.chapter?.content !== "string" || !data.chapter.content.trim()) {
          data = await fetchJson(operation.sourceUrl, path, { timeoutMs: 22000 });
          requireRemoteOperation(operation);
          if (!matchesRemotePayload(data, book.id, operation.sourceRealm, index, anchor)) throw new Error("章节来源、身份或内容版本已变化，未保存整本缓存");
          if (typeof data?.chapter?.content !== "string" || !data.chapter.content.trim()) throw new Error("章节正文为空，未保存整本缓存");
          await writeCachedJson(operation.sourceUrl, path, data);
          requireRemoteOperation(operation);
        }
        if (data?.book) latestBook = { ...latestBook, ...data.book };
        if (data?.chapter?.content) localChapters.push(data.chapter);
        cached += 1;
        if (cached === 1 || cached === chapters.length || cached % 20 === 0) {
          setStatus?.(`已缓存 ${formatNumber(cached)}/${formatNumber(chapters.length)} 章`);
        }
      }
      if (!localChapters.length) throw new Error("没有读到可保存的章节正文");
      requireRemoteOperation(operation);
      const entry = createCachedRemoteBookEntry(latestBook, localChapters);
      invalidateLocalBookReads(entry.book.id);
      const saved = await saveLocalNovelEntry(entry, { expectedGeneration: existing?.generation ?? null });
      if (!saved) throw new Error("本机缓存已被其他操作更新或移除，未覆盖内容；请重新操作");
      invalidateLocalBookReads(saved.book.id);
      rememberLocalBookSummary(saved);
      savedEntry = saved;
      if (operation.isActive()) setStatus?.(`《${book.title || "小说"}》已保存到手机离线缓存`);
      return savedEntry;
    } catch (error) {
      setStatus?.(`缓存失败：${error.message || error}`, "error");
      return null;
    } finally {
      const catalog = renderDetail && savedEntry ? await readLocalCatalog(savedEntry.book.id).catch(() => null) : null;
      cachingBookId = "";
      if (renderDetail && operation.isActive()) {
        renderNovelDetailData(catalog ? localDetailData(catalog) : { book: savedEntry?.book || book,
          chapters: chapters.map(({ content, ...summary }) => summary) });
      }
    }
  }

  function confirmWholeBookCache(book = {}, chapters = []) {
    const chapterCount = Number(chapters.length || book.chapterCount || 0);
    if (chapterCount <= 200) return true;
    return window.confirm(`《${book.title || "这本小说"}》共有 ${formatNumber(chapterCount)} 章，缓存整本会花比较久。继续缓存？`);
  }

  function installNativeTextIntentHandler() {
    if (typeof window === "undefined") return;
    const handler = () => importPendingNativeTextFile();
    window.addEventListener("fanhaoNativeTextFile", handler);
    window.addEventListener("load", handler);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) handler();
    });
    for (const delay of [0, 250, 800, 1600, 3200, 5000, 8000, 12000, 18000]) {
      window.setTimeout(handler, delay);
    }
  }

  function nativeNovelPlugin() {
    return window.Capacitor?.Plugins?.FanHaoNovel || null;
  }

  function installReaderLifecycle() {
    if (typeof window === "undefined") return;
    window.addEventListener("fanhaoViewWillRender", deactivateReader);
    window.addEventListener("fanhaoViewChanged", (event) => {
      if (event.detail?.view !== "novelReader") deactivateReader();
    });
    window.addEventListener("pagehide", deactivateReader);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flushReaderProgress();
      else if (isCurrentReaderSession(readerState.session) && isReaderScreenMounted()) {
        applyNativeReaderImmersive(!readerState.settingsOpen, true);
        applyReaderBrightness();
      }
    });
    for (const type of ["pointerdown", "touchstart", "wheel", "keydown"]) {
      window.addEventListener(type, (event) => {
        if (type === "keydown") {
          if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
          if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
          if (event.target?.closest?.("input, textarea, select, [contenteditable]")) return;
        }
        cancelReaderRestore();
      }, { passive: true });
    }
  }

  function deactivateReader() {
    if (!readerState.active && !readerState.session) return;
    flushReaderProgress();
    cancelReaderRestore();
    catalogRequestId += 1;
    window.clearTimeout(catalogSearchTimer);
    catalogSearchTimer = null;
    window.clearTimeout(readerState.menuAutoHideTimer);
    if (readerState.progressFrame !== null) {
      window.cancelAnimationFrame(readerState.progressFrame);
      readerState.progressFrame = null;
    }
    clearNativeReaderBrightness();
    applyNativeReaderImmersive(false, true);
    document.body.classList.remove("novel-reader-immersive");
    readerState.active = false;
    readerState.session = null;
    readerState.screen = null;
    readerState.menuOpen = false;
    readerState.settingsOpen = false;
    readerState.catalogOpen = false;
    readerState.catalogLoading = false;
    readerState.catalogError = "";
  }

  function isCurrentReaderSession(session) {
    return Boolean(session && readerState.active && readerState.session === session
      && session.routeGuard() && session.sourceUrl === getActiveUrl());
  }

  function isReaderScreenMounted() {
    return Boolean(readerState.active && readerState.screen
      && els.viewContent.contains(readerState.screen));
  }

  function cancelReaderRestore() {
    readerState.restoreEpoch += 1;
    if (readerState.restoreFrame !== null) window.cancelAnimationFrame(readerState.restoreFrame);
    readerState.restoreFrame = null;
    readerState.restoreRatio = null;
  }

  function applyNativeReaderBrightness(percent) {
    const plugin = nativeNovelPlugin();
    if (!readerState.active || !plugin?.setReaderBrightness) return;
    const brightness = clampNumber(percent, 35, 100, 100) / 100;
    readerState.nativeBrightnessSet = true;
    plugin.setReaderBrightness({ brightness }).catch(() => {});
  }

  function clearNativeReaderBrightness(force = false) {
    const plugin = nativeNovelPlugin();
    if ((!force && !readerState.nativeBrightnessSet) || !plugin?.clearReaderBrightness) return;
    readerState.nativeBrightnessSet = false;
    plugin.clearReaderBrightness().catch(() => {});
  }

  function applyReaderBrightness(settings = readerState.settings) {
    if (settings.brightnessMode === "system") {
      clearNativeReaderBrightness(true);
      return;
    }
    applyNativeReaderBrightness(settings.brightness);
  }

  function applyReaderSettingsLive(settings = readerState.settings) {
    const screen = els.viewContent?.querySelector(".novel-reader-screen");
    if (screen) screen.style.setProperty("--novel-reader-dim", readerBrightnessDim(settings));
    applyReaderBrightness(settings);
  }

  function applyReaderImmersiveState() {
    const immersive = readerState.active && !readerState.settingsOpen;
    applyNativeReaderImmersive(immersive);
    document.body.classList.toggle("novel-reader-immersive", immersive);
  }

  function applyNativeReaderImmersive(immersive, force = false) {
    const plugin = nativeNovelPlugin();
    if (!plugin?.setReaderImmersive) return;
    if (!force && readerState.nativeImmersiveSet === immersive) return;
    readerState.nativeImmersiveSet = immersive;
    plugin.setReaderImmersive({ immersive }).catch(() => {});
  }

  function scheduleReaderMenuAutoHide() {
    window.clearTimeout(readerState.menuAutoHideTimer);
    if (!readerState.active || !readerState.menuOpen || readerState.settingsOpen || readerState.catalogOpen) return;
    readerState.menuAutoHideTimer = window.setTimeout(() => {
      if (!readerState.active || !readerState.menuOpen || readerState.settingsOpen || readerState.catalogOpen) return;
      const ratio = captureReaderRatio();
      readerState.menuOpen = false;
      renderNovelReaderData(currentReaderData(), null, { restoreRatio: ratio });
    }, 3600);
  }

  function keepReaderMenuVisible() {
    if (!readerState.active || !readerState.menuOpen || readerState.settingsOpen || readerState.catalogOpen) return;
    scheduleReaderMenuAutoHide();
  }

  async function importPendingNativeTextFile() {
    const plugin = nativeNovelPlugin();
    if (!plugin?.consumePendingTextFile) return;
    if (importingNativeText) {
      nativeTextDrainRequested = true;
      return;
    }
    window.clearTimeout(nativeTextRetryTimer);
    nativeTextRetryTimer = null;
    importingNativeText = true;
    try {
      do {
        nativeTextDrainRequested = false;
        try {
          const file = await plugin.consumePendingTextFile();
          if (file?.busy) {
            // A previous bridge instance may still own native IO after recreation.
            // Retry later without spinning or relying on another user notification.
            nativeTextRetryTimer = window.setTimeout(() => {
              nativeTextRetryTimer = null;
              importPendingNativeTextFile();
            }, 500);
            return;
          }
          if (file?.available && typeof file.text === "string") {
            await importNativeTextFile(file);
            // Successful consumption may expose another already queued share,
            // including notifications received before this module was ready.
            nativeTextDrainRequested = true;
          } else {
            if (file?.message) setStatus?.(file.message, "error");
            nativeTextDrainRequested ||= file?.hasPending === true;
          }
        } catch (error) {
          setStatus?.(`本地文本读取失败：${error.message || error}`, "error");
          nativeTextDrainRequested ||= error?.data?.hasPending === true;
        }
      } while (nativeTextDrainRequested);
    } finally {
      importingNativeText = false;
    }
  }

  async function importNativeTextFile(file = {}) {
    const fileName = file.fileName || "local-text.txt";
    const busyOwner = setNovelBusy("local");
    setStatus?.(`正在加入手机本地书库：${fileName}`);
    renderCurrentView();
    try {
      const entry = await saveLocalTextFile({
        fileName,
        sizeBytes: Number(file.sizeBytes || file.text.length || 0),
        uri: file.uri || "",
        sourceType: file.uri ? "native-file" : "shared-text",
        encoding: file.encoding || "utf-8",
        text: file.text
      });
      clearNovelBusy(busyOwner);
      focusLocalLibraryAfterImport();
      setStatus?.(`已加入手机本地书库：${entry.book.title || fileName}`);
      openReader(entry.book, 1);
    } catch (error) {
      clearNovelBusy(busyOwner);
      setStatus?.(`本地文本导入失败：${error.message || error}`, "error");
      renderCurrentView();
    }
  }

  function updateSettings(patch = {}, options = {}) {
    const ratio = options.live ? null : captureReaderRatio();
    readerState.settings = normalizeSettings({ ...readerState.settings, ...patch });
    writeSettings(readerState.settings);
    if (options.live) {
      applyReaderSettingsLive(readerState.settings);
      return;
    }
    renderNovelReaderData(currentReaderData(), null, { restoreRatio: ratio, restore: !options.live });
  }

  function focusLocalLibraryAfterImport() {
    focusLocalSource({ resetFilters: true });
  }

  function focusLocalSource(options = {}) {
    const resetFilters = Boolean(options.resetFilters);
    const changed = listState.source !== "local";
    listState.source = "local";
    listState.sourceTouched = true;
    if (resetFilters) {
      listState.category = "all";
      listState.query = "";
      listState.searchOpen = false;
      listState.sort = "updated";
      listState.author = "";
      listState.mode = "books";
      resetNovelRemoteLimits();
    }
    if (changed || resetFilters) notifyLibrarySourceChanged();
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
    if (!isReaderScreenMounted() || !readerState.book?.id || !readerState.chapter?.index) return;
    const session = readerState.session;
    const screen = readerState.screen;
    if (readerState.progressFrame === null) {
      readerState.progressFrame = window.requestAnimationFrame(() => {
        if (readerState.session !== session || readerState.screen !== screen) return;
        readerState.progressFrame = null;
        updateReaderProgressUi();
      });
    }
    window.clearTimeout(readerState.progressTimer);
    readerState.progressTimer = window.setTimeout(() => {
      if (readerState.session !== session || readerState.screen !== screen) return;
      readerState.progressTimer = null;
      saveReaderProgress();
    }, 600);
  }

  function updateReaderProgressUi(inputRatio = captureReaderRatio()) {
    if (!readerState.book?.id || !readerState.chapter?.index) return;
    const ratio = clampRatio(inputRatio);
    const progress = readingProgress(readerState.book, readerState.chapters, readerState.chapter.index, ratio);
    const screen = els.viewContent.querySelector(".novel-reader-screen");
    const summary = screen?.querySelector("[data-novel-progress-summary]");
    const slider = screen?.querySelector("[data-novel-chapter-slider]");
    if (summary) summary.textContent = readerProgressSummary(progress);
    if (slider && document.activeElement !== slider) slider.value = String(Math.round(ratio * 100));
  }

  function saveReaderProgress() {
    if (!isReaderScreenMounted() || readerState.restoreFrame !== null
      || readerState.progressBlocked || !readerState.book?.id || !readerState.chapter?.index) return;
    const session = readerState.session;
    const bookId = readerState.book.id;
    const chapterIndex = readerState.chapter.index;
    const chapterId = readerState.chapter.id;
    const catalogRevision = readerState.book.catalogRevision;
    const ratio = captureReaderRatio();
    readerState.book = {
      ...readerState.book,
      progress: {
        chapterIndex: Number(readerState.chapter.index),
        ...(catalogRevision ? { chapterId, catalogRevision } : {}),
        scrollRatio: ratio,
        updatedAt: new Date().toISOString()
      }
    };
    if (isLocalBookId(bookId)) {
      const expectedGeneration = readerState.book.localGeneration;
      const writeId = ++progressWriteId;
      localProgressWriteIds.set(bookId, writeId);
      saveLocalNovelProgress(bookId, {
        chapterIndex,
        ...(catalogRevision ? { chapterId, catalogRevision } : {}),
        scrollRatio: ratio
      }, { expectedGeneration })
        .then((entry) => {
          if (!entry && isCurrentReaderSession(session)) {
            readerState.progressBlocked = true;
            setStatus?.("本地内容已更新，旧位置未覆盖；请重新打开详情确认续读章节", "error");
          }
          if (entry && localProgressWriteIds.get(bookId) === writeId) {
            localBookProgressVersions.set(bookId, (localBookProgressVersions.get(bookId) || 0) + 1);
            rememberLocalBookSummary(entry);
            if (isCurrentReaderSession(session) && readerState.book?.id === bookId
              && readerState.chapter?.id === chapterId && readerState.book?.catalogRevision === catalogRevision) {
              readerState.book = { ...readerState.book, progress: entry.book.progress,
                progressRecovery: entry.book.progressRecovery || null };
            }
          }
        })
        .catch((error) => {
          if (isCurrentReaderSession(session)) setStatus?.(`阅读位置尚未保存：${error.message || error}`, "error");
        })
        .finally(() => {
          if (localProgressWriteIds.get(bookId) === writeId) localProgressWriteIds.delete(bookId);
        });
      return;
    }
    queueRemoteReaderProgress(session.sourceUrl, bookId, {
      chapterIndex,
      ...(catalogRevision ? { chapterId, catalogRevision } : {}),
      scrollRatio: ratio,
      ...(normalizeSourceRealm(readerState.book.sourceRealm) ? { sourceRealm: readerState.book.sourceRealm } : {})
    }, session);
  }

  function queueRemoteReaderProgress(sourceUrl, bookId, progress, session = readerState.session) {
    const key = remoteChapterPrefetchKey(sourceUrl, bookId, "progress", progress.sourceRealm || "");
    let pending = remoteProgressWrites.get(key);
    if (pending) {
      pending.next = { progress, session };
      return;
    }
    pending = { next: { progress, session } };
    remoteProgressWrites.set(key, pending);
    void (async () => {
      try {
        while (pending.next) {
          const { progress: snapshot, session: owner } = pending.next;
          pending.next = null;
          try {
            const result = await fetchJson(sourceUrl, `/api/novels/${encodeURIComponent(bookId)}/progress`, {
              method: "POST", body: snapshot, timeoutMs: 12000
            });
            if (isCurrentReaderSession(owner) && readerState.book?.id === bookId
              && readerState.book?.catalogRevision === snapshot.catalogRevision
              && readerState.chapter?.id === snapshot.chapterId) {
              readerState.book = { ...readerState.book, progress: result?.progress || snapshot, progressRecovery: null };
            }
          } catch (error) {
            if (isCurrentReaderSession(owner) && readerState.book?.id === bookId
              && readerState.book?.catalogRevision === snapshot.catalogRevision) {
              if (error.status === 409 || error.statusCode === 409) {
                readerState.progressBlocked = true;
                setStatus?.("目录已更新，旧位置未覆盖；请返回详情确认续读章节", "error");
              } else setStatus?.(`阅读位置尚未同步：${error.message || error}`, "error");
            }
          }
        }
      } finally {
        if (remoteProgressWrites.get(key) === pending) remoteProgressWrites.delete(key);
      }
    })().catch(() => {});
  }

  function flushReaderProgress() {
    window.clearTimeout(readerState.progressTimer);
    readerState.progressTimer = null;
    saveReaderProgress();
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
    cancelReaderRestore();
    const ratio = Math.max(0, Math.min(1, Number(forcedRatio ?? readerState.pendingScrollRatio ?? 0)));
    readerState.restoreRatio = ratio;
    readerState.pendingScrollRatio = 0;
    const session = readerState.session;
    const screen = readerState.screen;
    const epoch = readerState.restoreEpoch;
    readerState.restoreFrame = window.requestAnimationFrame(() => {
      if (epoch !== readerState.restoreEpoch || !isCurrentReaderSession(session)
        || readerState.screen !== screen || !isReaderScreenMounted()) return;
      readerState.restoreFrame = null;
      scrollReaderToRatio(ratio);
      window.clearTimeout(readerState.progressTimer);
      readerState.progressTimer = window.setTimeout(() => {
        if (!isCurrentReaderSession(session) || readerState.screen !== screen) return;
        readerState.progressTimer = null;
        saveReaderProgress();
      }, 80);
    });
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
      updateReaderProgressUi(ratio);
      return;
    }
    const top = screen.getBoundingClientRect().top + window.scrollY;
    if (ratio <= 0.001) {
      window.scrollTo({ top, behavior: "auto" });
      updateReaderProgressUi(0);
      return;
    }
    const readable = Math.max(0, screen.scrollHeight - window.innerHeight);
    window.scrollTo({ top: top + readable * ratio, behavior: "auto" });
    updateReaderProgressUi(ratio);
  }

  function novelListPath() {
    const params = new URLSearchParams();
    if (listState.query) params.set("q", listState.query);
    if (!listState.searchPage && listState.category && listState.category !== "all") params.set("category", listState.category);
    if (!listState.searchPage && listState.author) params.set("author", listState.author);
    if (listState.sort && listState.sort !== "updated") params.set("sort", listState.sort);
    params.set("limit", String(Math.max(NOVEL_REMOTE_PAGE_SIZE, Number(listState.remoteLimit || NOVEL_REMOTE_PAGE_SIZE))));
    return `/api/novels${params.toString() ? `?${params}` : ""}`;
  }

  function novelAuthorListPath() {
    const params = new URLSearchParams();
    if (listState.query) params.set("q", listState.query);
    if (listState.sort && listState.sort !== "books") params.set("sort", listState.sort);
    params.set("limit", String(Math.max(NOVEL_AUTHOR_PAGE_SIZE, Number(listState.authorLimit || NOVEL_AUTHOR_PAGE_SIZE))));
    return `/api/novels/authors?${params}`;
  }

  function novelDetailPath(id) {
    return `/api/novels/${encodeURIComponent(String(id || ""))}`;
  }

  function novelMetaPath(id) {
    return `${novelDetailPath(id)}?catalog=0`;
  }

  function novelCatalogPath(id, params = new URLSearchParams()) {
    const query = params.toString();
    return `/api/novels/${encodeURIComponent(String(id || ""))}/catalog${query ? `?${query}` : ""}`;
  }

  function novelChapterPath(id, chapterIndex, anchor = {}) {
    const params = new URLSearchParams();
    for (const key of ["catalogRevision", "chapterId", "sourceRealm"]) {
      if (anchor[key]) params.set(key, anchor[key]);
    }
    const query = params.toString();
    return `/api/novels/${encodeURIComponent(String(id || ""))}/chapters/${encodeURIComponent(String(chapterIndex || "1"))}${query ? `?${query}` : ""}`;
  }

  function renderMessage(message, tone = "quiet", replace = true) {
    if (replace) els.viewContent.innerHTML = "";
    const box = document.createElement("div");
    box.className = `message-box ${tone}`;
    box.textContent = message;
    els.viewContent.append(box);
    renderLocalLibraryErrorCard();
  }

  return {
    renderNovelList,
    renderNovelSearch,
    renderNovelDetail,
    renderNovelReader,
    getNovelNavigationState,
    getNovelSortOptions,
    setNovelCategory,
    setNovelSort,
    getLibrarySource,
    setLibrarySource,
    focusLocalSource
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

function compactBookProgress(book = {}) {
  const progress = readingProgress(book);
  return `第 ${progress.chapterIndex}/${progress.chapterCount} 章 · 全书 ${Math.round(progress.overallRatio * 1000) / 10}%`;
}

function readerProgressSummary(progress) {
  const whole = Math.round(progress.overallRatio * 1000) / 10;
  const chapter = Math.round(progress.chapterRatio * 100);
  const remaining = progress.remainingChars > 0
    ? formatRemainingReadingTime(progress.remainingChars)
    : progress.overallRatio >= 0.999 ? "已读完" : "";
  return `第 ${progress.chapterIndex}/${progress.chapterCount} 章 · 全书 ${whole}% · 本章 ${chapter}%${remaining ? ` · ${remaining}` : ""}`;
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

function brightnessDim(value) {
  const brightness = clampNumber(value, 35, 100, 100);
  return String(((100 - brightness) / 100 * 0.55).toFixed(3));
}

function readerBrightnessDim(settings = {}) {
  if (settings.brightnessMode === "system") return "0";
  return brightnessDim(settings.brightness);
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
  const hasBrightnessMode = input.brightnessMode === "system" || input.brightnessMode === "custom";
  const hasLegacyBrightness = Object.prototype.hasOwnProperty.call(input, "brightness");
  const brightness = Math.round(clampNumber(input.brightness, 35, 100, 100));
  const brightnessMode = hasBrightnessMode
    ? input.brightnessMode
    : hasLegacyBrightness && brightness !== 100 ? "custom" : "system";
  return {
    theme: ["paper", "white", "green", "rose"].includes(input.theme) ? input.theme : "paper",
    night: Boolean(input.night),
    eyeCare: Boolean(input.eyeCare),
    readingMode: ["scroll", "page"].includes(input.readingMode) ? input.readingMode : "scroll",
    brightnessMode,
    brightness,
    fontSize: clampNumber(input.fontSize, 16, 28, 20),
    lineHeight: clampNumber(input.lineHeight, 1.55, 2.35, 1.9)
  };
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}







