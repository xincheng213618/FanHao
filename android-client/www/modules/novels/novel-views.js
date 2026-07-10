import { fetchJson, postJson } from "../../js/api.js?v=20260702-novel-local-manage-74";
import { cacheAgeText, readCachedJson, writeCachedJson } from "../../js/cache.js?v=20260702-novel-local-manage-74";
import { formatBytes, formatNumber } from "../../js/format.js";
import { deleteLocalNovelEntry, loadLocalNovelEntries, readLocalNovelEntry, saveLocalNovelEntry, saveLocalNovelProgress } from "../../js/local-novels.js?v=20260702-novel-local-manage-74";

const NOVEL_SETTINGS_KEY = "fanhao.android.novel.settings";
const DEVICE_TEXT_SCAN_LIMIT = 50000;
const DEFAULT_QUERY_STATE = {
  query: "",
  category: "all",
  sort: "updated",
  searchOpen: false,
  source: "local",
  sourceTouched: false
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

  const listState = { ...DEFAULT_QUERY_STATE, uploading: false, busyAction: "" };
  const localBooks = new Map();
  const selectedLocalBookIds = new Set();
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
    nativeBrightnessSet: false,
    nativeImmersiveSet: false,
    menuAutoHideTimer: null
  };

  installReaderProgress();
  installNativeTextIntentHandler();
  installReaderLifecycle();

  async function renderNovelList(isActive = () => true) {
    deactivateReader();
    setActiveBottom("novels");
    const loadingTitle = listState.sourceTouched ? sourceTitle() : "书库";
    els.viewKicker.textContent = listState.sourceTouched ? sourceKicker() : "小说";
    els.viewTitle.textContent = loadingTitle;
    els.viewMeta.textContent = "正在读取";
    els.viewContent.innerHTML = `<div class="loading-row">正在读取${loadingTitle}</div>`;

    const path = novelListPath();
    const activeUrl = getActiveUrl();
    let renderedCache = false;
    const localData = await loadLocalListData().catch((error) => {
      setStatus?.(`本地小说库读取失败：${error.message || error}`, "error");
      return emptyLocalListData();
    });
    if (!isActive()) return;
    const cached = await readCachedJson(activeUrl, path).catch(() => null);
    if (!isActive()) return;
    if (cached?.payload?.books) {
      renderedCache = true;
      renderNovelListData(mergeNovelListData(cached.payload, localData), cached);
    } else if (localData.total) {
      renderNovelListData(mergeNovelListData({}, localData));
    }

    try {
      const data = await fetchJson(activeUrl, path, { timeoutMs: 16000, signal: isActive.signal });
      writeCachedJson(activeUrl, path, data).catch(() => {});
      if (!isActive()) return;
      renderNovelListData(mergeNovelListData(data, localData));
    } catch (error) {
      if (!isActive()) return;
      if (renderedCache) {
        renderMessage("电脑端暂时连不上，当前显示的是本地缓存小说。", "quiet", false);
      } else if (localData.total) {
        renderNovelListData(mergeNovelListData({}, localData));
        renderMessage("电脑端暂时连不上，当前只显示手机本地小说。", "quiet", false);
      } else {
        renderMessage(error.message || "小说书库读取失败", "error");
      }
    }
  }

  function renderNovelListData(data = {}, cacheEntry = null) {
    const books = Array.isArray(data.books) ? data.books : [];
    const summary = data.summary || {};
    const listTotals = visibleBookTotals(books);
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";

    els.viewKicker.textContent = sourceKicker();
    els.viewTitle.textContent = sourceTitle();
    els.viewMeta.textContent = `${formatNumber(data.total || books.length)} 本 · ${formatNumber(listTotals.chapters)} 章${suffix}`;
    els.viewContent.innerHTML = "";
    notifyLibrarySourceChanged();

    els.viewContent.append(createNovelControls(data));
    const recent = createRecentStrip(summary.recent || []);
    if (recent) els.viewContent.append(recent);

    if (!books.length) {
      els.viewContent.append(createNovelEmptyState(data));
      return;
    }

    const list = document.createElement("div");
    list.className = "novel-mobile-list";
    if (listState.source === "local") list.classList.add("manage");
    if (isLocalSelectionMode()) list.classList.add("selecting");
    if (listState.source === "remote") list.classList.add("bookstore");
    for (const book of books) list.append(createNovelCard(book));
    els.viewContent.append(list);
  }

  async function loadLocalListData() {
    const entries = await loadPersistentLocalLibrary();
    return localListData(entries);
  }

  async function loadPersistentLocalLibrary() {
    const entries = await loadLocalNovelEntries();
    localBooks.clear();
    for (const entry of entries) localBooks.set(entry.book.id, entry);
    return entries;
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
    listState.source = "local";
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
    if (next !== "local") exitLocalSelectionMode();
    notifyLibrarySourceChanged();
    return true;
  }

  function notifyLibrarySourceChanged() {
    window.dispatchEvent(new CustomEvent("fanhaoNovelSourceChanged", {
      detail: { source: getLibrarySource() }
    }));
  }

  function visibleLocalBooksForRemote(remoteBooks = [], localBooksList = []) {
    if (!remoteBooks.length) return localBooksList;
    const visibleRemoteIds = new Set(remoteBooks.map((book) => remoteBookSourceId(book)).filter(Boolean));
    if (!visibleRemoteIds.size) return localBooksList;
    return localBooksList.filter((book) => !isRemoteCacheBook(book) || !visibleRemoteIds.has(remoteCacheSourceId(book)));
  }

  function markRemoteBookWithCache(book = {}) {
    if (!book?.id || isLocalBookId(book.id)) return book;
    const entry = cachedRemoteEntryForSourceId(book.id);
    const cachedBook = entry?.book;
    if (!cachedBook) return book;
    return {
      ...book,
      cachedLocal: true,
      cachedLocalId: cachedBook.id,
      cachedAt: cachedBook.cachedAt || entry.updatedAt || cachedBook.updatedAt || "",
      localProgress: cachedBook.progress || null,
      progress: book.progress || cachedBook.progress || null
    };
  }

  function cachedRemoteEntryForSourceId(sourceId) {
    const id = remoteCacheIdFromSourceId(sourceId);
    if (!id) return null;
    const direct = localBooks.get(id);
    if (direct?.book && isRemoteCacheBook(direct.book)) return direct;
    for (const entry of localBooks.values()) {
      if (isRemoteCacheBook(entry?.book) && remoteCacheSourceId(entry.book) === String(sourceId || "")) return entry;
    }
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

  function remoteCacheIdFromSourceId(sourceId) {
    const id = String(sourceId || "").trim();
    return id ? `local:remote:${id}` : "";
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

    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "搜索书名、作者、分类或章节";
    search.setAttribute("aria-label", "搜索小说");
    search.value = listState.query;
    const applySearch = () => {
      listState.query = search.value.trim();
      listState.searchOpen = Boolean(listState.query);
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
    for (const [value, label, title] of [
      ["updated", "最近", "最近更新"],
      ["progress", "阅读", "最近阅读"],
      ["chapters", "章节", "章节最多"],
      ["size", "大小", "文件最大"],
      ["title", "书名", "按书名排序"]
    ]) {
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
    smartImport.textContent = busyButtonLabel("scan", "扫描");
    smartImport.title = "全盘扫描手机里的 TXT";
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
    categoryRow.append(createCategoryButton("all", "全部", data.summary?.totals?.books || data.total || 0));
    for (const item of data.facets || data.summary?.categories || []) {
      categoryRow.append(createCategoryButton(item.name, item.name, item.count));
    }

    const filterRow = document.createElement("div");
    filterRow.className = "novel-mobile-filter-row";
    filterRow.append(categoryRow, sortSelect);

    wrap.append(toolRow, uploadInput, localInput);
    wrap.append(filterRow);
    if (isLocalSelectionMode()) wrap.append(createLocalSelectionBar(data));
    return wrap;
  }

  function emptyNovelListMessage() {
    if (listState.query) return `没有搜到「${listState.query}」。`;
    if (listState.source === "local") return "手机本地书库还没有书，可以点「导入」加入 TXT。";
    if (listState.source === "remote") return "书城还没有书，或电脑端暂时连不上。";
    return "书城还没有书，或电脑端暂时连不上。";
  }

  function createNovelEmptyState(data = {}) {
    const box = document.createElement("div");
    box.className = "novel-mobile-empty";

    const title = document.createElement("strong");
    title.textContent = listState.query ? "没有匹配的小说" : listState.source === "local" ? "本地书库是空的" : "书城暂时没有内容";

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
        renderCurrentView();
      });
      actions.append(clear);
    }

    if (listState.source === "local" && !listState.query) {
      const localInput = createLocalNovelInput();
      const localImport = document.createElement("button");
      localImport.type = "button";
      localImport.className = "primary";
      localImport.textContent = busyButtonLabel("local", "导入本地");
      localImport.disabled = listState.uploading;
      localImport.addEventListener("click", () => localInput.click());
      actions.append(localImport, localInput);

      const remoteCount = Number(data.summary?.sourceTotals?.remoteBooks || 0);
      if (remoteCount > 0) {
        const bookstore = document.createElement("button");
        bookstore.type = "button";
        bookstore.textContent = "去书城";
        bookstore.addEventListener("click", () => {
          setLibrarySource("bookstore");
          renderCurrentView();
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
        actions.append(bookstore);
      }
    }

    box.append(title, message);
    if (actions.childElementCount) box.append(actions);
    return box;
  }

  function setNovelBusy(action) {
    listState.uploading = true;
    listState.busyAction = action || "";
  }

  function clearNovelBusy() {
    listState.uploading = false;
    listState.busyAction = "";
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

  function shouldShowInContinueReading(book = {}) {
    if (!book?.progress) return false;
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
    card.className = `novel-mobile-card${book.cachedLocal ? " cached-local" : ""}`;
    const selectable = isLocalSelectionMode() && book.local && isLocalBookId(book.id);
    const selected = selectable && selectedLocalBookIds.has(book.id);
    if (selectable) card.classList.add("selectable");
    if (selected) card.classList.add("selected");
    card.role = "button";
    card.tabIndex = 0;
    const openDetail = () => {
      const detailId = detailBookId(book);
      if (detailId) showView("novelDetail", { id: detailId }, { push: true });
      else openReader(book);
    };
    const toggleSelection = () => {
      if (!selectable) return false;
      if (selectedLocalBookIds.has(book.id)) selectedLocalBookIds.delete(book.id);
      else selectedLocalBookIds.add(book.id);
      renderCurrentViewPreservingScroll();
      return true;
    };
    card.addEventListener("click", () => {
      if (toggleSelection()) return;
      openReader(book);
    });
    card.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (toggleSelection()) return;
      openReader(book);
    });

    const cover = createCover(book);
    if (selectable) {
      const check = document.createElement("span");
      check.className = "novel-mobile-select-mark";
      check.textContent = selected ? "✓" : "";
      check.setAttribute("aria-hidden", "true");
      cover.append(check);
    }
    const body = document.createElement("div");
    body.className = "novel-mobile-card-body";
    const title = document.createElement("strong");
    title.textContent = book.title || "未命名小说";
    const cacheBadge = document.createElement("small");
    cacheBadge.className = "novel-mobile-cache-badge";
    cacheBadge.textContent = "已缓存";
    const meta = document.createElement("span");
    meta.textContent = [book.author || "未知作者", bookCategoryLabel(book), `${formatNumber(book.chapterCount)} 章`, formatBytes(book.sizeBytes)].filter(Boolean).join(" · ");
    const summary = document.createElement("p");
    summary.textContent = book.summary || book.latestChapterTitle || book.relativePath || "";
    const progress = document.createElement("small");
    progress.className = "novel-mobile-card-progress";
    progress.textContent = readingProgressText(book);
    const latest = document.createElement("small");
    latest.className = "novel-mobile-card-chapter";
    latest.textContent = book.progress
      ? `读到第 ${book.progress.chapterIndex || 1} 章`
      : book.cachedLocal
        ? "已缓存整本"
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
      openDetail();
    });
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = secondaryBookActionLabel(book);
    download.disabled = Boolean(!book.local && !book.cachedLocal && cachingBookId);
    download.addEventListener("click", (event) => {
      event.stopPropagation();
      handleSecondaryBookAction(book);
    });
    actions.append(detail, download);
    if (book.local) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "danger";
      remove.textContent = "移除";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        removeLocalBook(book);
      });
      actions.append(remove);
    }

    body.append(title);
    if (book.cachedLocal && !book.local) body.append(cacheBadge);
    body.append(progress, latest, meta, summary, actions);
    card.append(cover, body);
    return card;
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

    if (isLocalBookId(bookId)) {
      const entry = await ensureLocalNovelEntry(bookId).catch(() => null);
      if (!isActive()) return;
      if (!entry) {
        renderMessage("这本本地小说已经不在手机本地库里。", "error");
        return;
      }
      focusLocalSource();
      renderNovelDetailData(localDetailData(entry));
      return;
    }

    const cachedRemoteEntry = await ensureLocalNovelEntry(remoteCacheIdFromSourceId(bookId)).catch(() => null);
    if (!isActive()) return;
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
      } else if (cachedRemoteEntry) {
        focusLocalSource();
        renderNovelDetailData(localDetailData(cachedRemoteEntry));
        renderMessage("电脑端暂时连不上，当前显示的是手机离线缓存。", "quiet", false);
      } else {
        renderMessage(error.message || "书籍详情读取失败", "error");
      }
    }
  }

  function renderNovelDetailData(data = {}, cacheEntry = null) {
    const book = markRemoteBookWithCache(data.book || {});
    const chapters = Array.isArray(data.chapters) ? data.chapters : [];
    const suffix = cacheEntry ? ` · 缓存 ${cacheAgeText(cacheEntry.updatedAt)}` : "";

    els.viewKicker.textContent = bookCategoryLabel(book) || "小说";
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
    const latest = document.createElement("small");
    latest.textContent = cachedRemote
      ? `已缓存到手机 · ${book.latestChapterTitle ? `最新：${book.latestChapterTitle}` : "可离线阅读"}`
      : book.latestChapterTitle ? `最新：${book.latestChapterTitle}` : "本地 TXT 导入";

    const actions = document.createElement("div");
    actions.className = "novel-mobile-detail-actions";
    const read = document.createElement("button");
    read.type = "button";
    read.className = "primary";
    read.textContent = cachedRemote
      ? (book.progress ? "继续离线" : "离线阅读")
      : (book.progress ? "继续阅读" : "开始阅读");
    read.addEventListener("click", () => openReader(book, chapters[0]?.index || 1));
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
        cacheWholeBook(book, chapters);
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

    body.append(title, meta, latest, actions);
    panel.append(body);
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
    button.addEventListener("click", () => openReader(book, chapter.index || 1, { exactChapter: true }));
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
      await renderLocalNovelReader(bookId, index);
      return;
    }

    const cachedRemoteEntry = await ensureLocalNovelEntry(remoteCacheIdFromSourceId(bookId)).catch(() => null);
    if (!isActive()) return;
    if (cachedRemoteEntry?.book) {
      await renderLocalNovelReader(cachedRemoteEntry.book.id, index);
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
      Number(book.progress?.chapterIndex || 0) === Number(chapter.index || 0) ? book.progress?.scrollRatio : 0
    ) ?? 0);
    const toolbar = createReaderToolbar(Math.max(0, Math.min(1, ratioForControls)));

    screen.append(dimmer, topBar, title, meta, content, toolbar);
    if (readerState.settingsOpen) screen.append(createReaderSettingsPanel());
    els.viewContent.append(screen);
    if (readerState.catalogOpen) els.viewContent.append(createCatalogDrawer());
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
    slider.setAttribute("aria-label", "阅读进度");
    slider.addEventListener("input", () => {
      keepReaderMenuVisible();
      scrollReaderToRatio(Number(slider.value) / 100);
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
    flushReaderProgress();
    showView("novelReader", { id: readerState.book.id, chapterIndex: String(target.index || 1) }, { push: true });
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
    const chapterIndex = options.exactChapter
      ? fallbackIndex
      : target.progress?.chapterIndex || fallbackIndex || 1;
    showView("novelReader", {
      id: target.id,
      chapterIndex: String(chapterIndex)
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
      progress: book.localProgress || book.progress || null
    };
  }

  function detailBookId(book = {}) {
    return String(book.cachedLocalId || book.id || "").trim();
  }

  function createCover(book = {}, size = "") {
    const cover = document.createElement("div");
    cover.className = `novel-mobile-cover ${size}`.trim();
    const label = document.createElement("span");
    label.textContent = bookCategoryLabel(book).slice(0, 4);
    const title = document.createElement("strong");
    title.textContent = book.title || "小说";
    cover.append(label, title);
    return cover;
  }

  function scanLocalNovelFiles() {
    const plugin = nativeNovelPlugin();
    if (!plugin?.scanTextFiles || !plugin?.readScannedTextFile) {
      setStatus?.("当前环境不能直接扫描系统 TXT，请用「导入」选择文件。", "error");
      return;
    }
    if (listState.uploading) return;
    setNovelBusy("scan");
    setStatus?.("正在检查本机 TXT 扫描权限");
    renderCurrentView();

    Promise.resolve()
      .then(async () => {
        const access = await plugin.hasTextScanAccess?.().catch(() => null);
        if (access && access.hasAccess === false) {
          clearNovelBusy();
          setStatus?.("需要开启所有文件访问权限，开启后回到这里再点「扫描」。", "error");
          renderCurrentView();
          await plugin.requestTextScanAccess?.();
          return;
        }

        setStatus?.("正在全盘扫描手机里的 TXT");
        const scan = await plugin.scanTextFiles({ maxFiles: DEVICE_TEXT_SCAN_LIMIT, maxDepth: 64 });
        if (scan?.hasAccess === false) {
          clearNovelBusy();
          setStatus?.(scan.message || "需要开启所有文件访问权限，才能扫描 TXT。", "error");
          renderCurrentView();
          await plugin.requestTextScanAccess?.().catch(() => {});
          return;
        }

        const items = Array.isArray(scan?.items) ? scan.items : [];
        if (!items.length) {
          clearNovelBusy();
          setStatus?.("没有扫描到可导入的 TXT。");
          renderCurrentView();
          return;
        }

        const selectedItems = await confirmScanImport(items, Boolean(scan?.truncated));
        if (!selectedItems?.length) {
          clearNovelBusy();
          setStatus?.("已取消扫描导入。");
          renderCurrentView();
          return;
        }

        let imported = 0;
        let skipped = 0;
        for (const item of selectedItems) {
          try {
            const file = await plugin.readScannedTextFile({ path: item.path, uri: item.uri || "" });
            await saveLocalTextFile({
              fileName: file.fileName || item.fileName,
              sizeBytes: Number(file.sizeBytes || item.sizeBytes || 0),
              lastModified: Number(item.lastModified || Date.now()),
              encoding: file.encoding,
              text: file.text,
              sourceUri: file.uri || item.uri || item.path,
              sourceType: "device-scan"
            });
            imported += 1;
            setStatus?.(`扫描导入 ${formatNumber(imported + skipped)}/${formatNumber(selectedItems.length)}：${file.fileName || item.fileName || "TXT"}`);
          } catch (error) {
            skipped += 1;
            setStatus?.(`已跳过 ${formatNumber(skipped)} 本读取失败的 TXT：${item.fileName || "TXT"}`);
          }
        }

        clearNovelBusy();
        focusLocalLibraryAfterImport();
        setStatus?.(skipped
          ? `已导入 ${formatNumber(imported)} 本，跳过 ${formatNumber(skipped)} 本读取失败的 TXT`
          : `已扫描导入 ${formatNumber(imported)} 本到手机本地书库`);
        renderCurrentView();
      })
      .catch((error) => {
        clearNovelBusy();
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
    setNovelBusy("picker");
    setStatus?.("正在打开系统文件管理器");
    renderCurrentView();

    Promise.resolve()
      .then(async () => {
        const result = await plugin.openTextDocumentPicker();
        const items = Array.isArray(result?.items) ? result.items : [];
        const errors = Array.isArray(result?.errors) ? result.errors : [];
        if (result?.canceled) {
          clearNovelBusy();
          setStatus?.("已取消文件管理器导入。");
          renderCurrentView();
          return;
        }
        if (!items.length) {
          clearNovelBusy();
          setStatus?.(errors.length ? `没有导入 TXT，${formatNumber(errors.length)} 个文件读取失败或不是 TXT。` : "没有选择可导入的 TXT。", errors.length ? "error" : "");
          renderCurrentView();
          return;
        }

        let imported = 0;
        let skipped = 0;
        for (const file of items) {
          try {
            await saveLocalTextFile({
              fileName: file.fileName || "local-text.txt",
              sizeBytes: Number(file.sizeBytes || 0),
              lastModified: Date.now(),
              encoding: file.encoding,
              text: file.text,
              sourceUri: file.uri || "",
              sourceType: "system-picker"
            });
            imported += 1;
            setStatus?.(`文件管理器导入 ${formatNumber(imported)}/${formatNumber(items.length)}：${file.fileName || "TXT"}`);
          } catch (error) {
            skipped += 1;
            setStatus?.(`已跳过 ${formatNumber(skipped)} 本导入失败的 TXT：${file.fileName || "TXT"}`);
          }
        }

        clearNovelBusy();
        focusLocalLibraryAfterImport();
        setStatus?.(skipped || errors.length
          ? `已导入 ${formatNumber(imported)} 本，跳过 ${formatNumber(skipped + errors.length)} 个文件`
          : `已从文件管理器导入 ${formatNumber(imported)} 本`);
        renderCurrentView();
      })
      .catch((error) => {
        clearNovelBusy();
        setStatus?.(`文件管理器导入失败：${error.message || error}`, "error");
        renderCurrentView();
      });
  }

  function confirmScanImport(items = [], truncated = false) {
    const countText = formatNumber(items.length);
    const recommendedCount = items.filter((item) => item?.recommended !== false).length;
    const truncatedText = truncated ? `，先显示最近的 ${countText} 个` : "";
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
        meta.textContent = `${formatBytes(item.sizeBytes)} · ${item.hint || (item.recommended === false ? "可选" : "推荐")}`;
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
    setNovelBusy("upload");
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
        clearNovelBusy();
        if (localImported) focusLocalLibraryAfterImport();
        setStatus?.(
          localImported
            ? `已上传 ${formatNumber(uploaded)} 本，另有 ${formatNumber(localImported)} 本保存到手机本地`
            : `已上传 ${formatNumber(uploaded)} 本小说`
        );
        renderCurrentView();
      })
      .catch((error) => {
        clearNovelBusy();
        setStatus?.(`上传失败：${error.message || error}`, "error");
        renderCurrentView();
      });
  }

  function importLocalNovelFiles(files = []) {
    const txtFiles = files.filter((file) => file && (/\.txt$/i.test(file.name) || String(file.type || "").startsWith("text/")));
    if (!txtFiles.length) return;
    setNovelBusy("local");
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
        clearNovelBusy();
        focusLocalLibraryAfterImport();
        setStatus?.(`已导入 ${formatNumber(imported)} 本到手机本地书库`);
        renderCurrentView();
      })
      .catch((error) => {
        clearNovelBusy();
        setStatus?.(`本地导入失败：${error.message || error}`, "error");
        renderCurrentView();
      });
  }

  async function downloadBook(bookId) {
    if (!bookId) return;
    if (isLocalBookId(bookId)) {
      const entry = await ensureLocalNovelEntry(bookId).catch(() => null);
      if (!entry) {
        setStatus?.("这本本地小说已经不在手机本地库里。", "error");
        return;
      }
      downloadTextFile(entry.book.fileName || `${entry.book.title || "本地小说"}.txt`, composeLocalNovelText(entry));
      return;
    }
    const href = `${getActiveUrl()}/api/novels/${encodeURIComponent(bookId)}/download`;
    const link = document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.rel = "noreferrer";
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function cacheBookFromList(book = {}) {
    if (!book.id || cachingBookId) return;
    setStatus?.(`正在准备缓存《${book.title || "小说"}》`);
    try {
      const path = novelDetailPath(book.id);
      const cached = await readCachedJson(getActiveUrl(), path).catch(() => null);
      let data = cached?.payload || null;
      if (!data?.book || !Array.isArray(data.chapters)) {
        data = await fetchJson(getActiveUrl(), path, { timeoutMs: 18000 });
        writeCachedJson(getActiveUrl(), path, data).catch(() => {});
      }
      const detailBook = { ...book, ...(data.book || {}) };
      const chapters = Array.isArray(data.chapters) ? data.chapters : [];
      if (!chapters.length) throw new Error("没有读到目录");
      const saved = await cacheWholeBook(detailBook, chapters, { renderDetail: false });
      if (saved?.book) localBooks.set(saved.book.id, saved);
    } catch (error) {
      setStatus?.(`缓存失败：${error.message || error}`, "error");
    } finally {
      renderCurrentViewPreservingScroll();
    }
  }

  async function openLocalTextReader(file = {}) {
    const entry = await saveLocalTextFile(file);
    focusLocalLibraryAfterImport();
    setStatus?.(`已加入手机本地书库：${entry.book.title}`);
    openReader(entry.book, 1);
  }

  async function renderLocalNovelReader(bookId, chapterIndex) {
    const entry = await ensureLocalNovelEntry(bookId).catch(() => null);
    if (!entry) {
      renderMessage("这本本地小说已经不在手机本地库里，请重新导入。", "error");
      return;
    }
    focusLocalSource();
    const index = Math.max(1, Number(chapterIndex || 1));
    const chapter = entry.chapters.find((item) => item.index === index) || entry.chapters[0];
    const currentIndex = entry.chapters.findIndex((item) => item.index === chapter.index);
    renderNovelReaderData({
      book: entry.book,
      chapter,
      chapters: entry.chapters.map(({ content, ...summary }) => summary),
      prev: currentIndex > 0 ? entry.chapters[currentIndex - 1] : null,
      next: currentIndex >= 0 && currentIndex < entry.chapters.length - 1 ? entry.chapters[currentIndex + 1] : null
    });
  }

  async function saveLocalTextFile(file = {}) {
    const entry = createLocalBookEntry(file);
    const existing = await readLocalNovelEntry(entry.book.id).catch(() => null);
    if (existing) {
      entry.createdAt = existing.createdAt || entry.createdAt;
      const progress = existing.book?.progress;
      if (progress && entry.chapters.some((chapter) => Number(chapter.index) === Number(progress.chapterIndex))) {
        entry.book.progress = progress;
      }
    }
    const saved = await saveLocalNovelEntry(entry);
    localBooks.set(saved.book.id, saved);
    return saved;
  }

  async function ensureLocalNovelEntry(bookId) {
    const id = String(bookId || "");
    if (localBooks.has(id)) return localBooks.get(id);
    const entry = await readLocalNovelEntry(id);
    if (entry) localBooks.set(id, entry);
    return entry;
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
    await deleteLocalNovelEntry(book.id);
    localBooks.delete(book.id);
    setStatus?.(`已移除${cachedRemote ? "缓存" : "本地小说"}：${title}`);
    showView("novels", {}, { resetStack: true });
  }

  async function removeSelectedLocalBooks() {
    const ids = Array.from(selectedLocalBookIds).filter((id) => isLocalBookId(id) && localBooks.has(id));
    if (!ids.length) return;
    if (!window.confirm(`从手机本地书架移除选中的 ${formatNumber(ids.length)} 本？不会删除原始 TXT 文件。`)) return;
    setNovelBusy("remove");
    setStatus?.(`正在移除 ${formatNumber(ids.length)} 本本地小说`);
    try {
      let removed = 0;
      for (const id of ids) {
        await deleteLocalNovelEntry(id);
        localBooks.delete(id);
        selectedLocalBookIds.delete(id);
        removed += 1;
      }
      exitLocalSelectionMode();
      setStatus?.(`已从书架移除 ${formatNumber(removed)} 本本地小说`);
    } catch (error) {
      setStatus?.(`删除书架失败：${error.message || error}`, "error");
    } finally {
      clearNovelBusy();
      renderCurrentView();
    }
  }

  async function removeCachedRemoteBook(book = {}) {
    const cachedId = book.cachedLocalId || remoteCacheIdFromSourceId(book.id);
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
    const sourceUri = String(file.uri || "").trim();
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
        id: `${bookId}-${String(chapter.index).padStart(5, "0")}`,
        bookId,
        updatedAt: now
      }))
    };
  }

  function createCachedRemoteBookEntry(book = {}, chapters = []) {
    const now = new Date().toISOString();
    const remoteId = String(book.id || `${book.title || "novel"}:${book.author || ""}`);
    const localId = `local:remote:${remoteId}`;
    const normalizedChapters = chapters
      .map((chapter, index) => {
        const chapterIndex = Math.max(1, Number(chapter?.index || index + 1) || index + 1);
        const content = String(chapter?.content || "").trim();
        if (!content) return null;
        return {
          ...chapter,
          id: `${localId}-${String(chapterIndex).padStart(5, "0")}`,
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
      sourceType: "remote-cache",
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
    const title = entry.book?.title ? `${entry.book.title}\n\n` : "";
    return title + (entry.chapters || [])
      .map((chapter) => `${chapter.title || `正文 ${chapter.index || ""}`.trim()}\n\n${chapter.content || ""}`.trim())
      .join("\n\n");
  }

  function downloadTextFile(fileName, content) {
    const blob = new Blob([String(content || "")], { type: "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = sanitizeTxtFileName(fileName);
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
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
      let cached = 0;
      const localChapters = [];
      let latestBook = book;
      for (const chapter of chapters) {
        const index = chapter.index || cached + 1;
        const path = novelChapterPath(book.id, index);
        const cachedEntry = await readCachedJson(getActiveUrl(), path).catch(() => null);
        let data = cachedEntry?.payload || null;
        if (!data?.chapter?.content) {
          data = await fetchJson(getActiveUrl(), path, { timeoutMs: 22000 });
          await writeCachedJson(getActiveUrl(), path, data);
        }
        if (data?.book) latestBook = { ...latestBook, ...data.book };
        if (data?.chapter?.content) localChapters.push(data.chapter);
        cached += 1;
        if (cached === 1 || cached === chapters.length || cached % 20 === 0) {
          setStatus?.(`已缓存 ${formatNumber(cached)}/${formatNumber(chapters.length)} 章`);
        }
      }
      if (!localChapters.length) throw new Error("没有读到可保存的章节正文");
      const saved = await saveLocalNovelEntry(createCachedRemoteBookEntry(latestBook, localChapters));
      localBooks.set(saved.book.id, saved);
      savedEntry = saved;
      setStatus?.(`《${book.title || "小说"}》已保存到手机离线缓存`);
      return savedEntry;
    } catch (error) {
      setStatus?.(`缓存失败：${error.message || error}`, "error");
      return null;
    } finally {
      cachingBookId = "";
      if (renderDetail) renderNovelDetailData(savedEntry ? localDetailData(savedEntry) : { book, chapters });
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
    window.addEventListener("fanhaoViewChanged", (event) => {
      if (event.detail?.view !== "novelReader") deactivateReader();
    });
    window.addEventListener("pagehide", deactivateReader);
  }

  function deactivateReader() {
    flushReaderProgress();
    window.clearTimeout(readerState.menuAutoHideTimer);
    clearNativeReaderBrightness();
    applyNativeReaderImmersive(false, true);
    document.body.classList.remove("novel-reader-immersive");
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
    if (!plugin?.consumePendingTextFile || importingNativeText) return;
    importingNativeText = true;
    try {
      const file = await plugin.consumePendingTextFile();
      if (!file?.available || typeof file.text !== "string") {
        if (file?.message) setStatus?.(file.message, "error");
        return;
      }
      await importNativeTextFile(file);
    } catch (error) {
      setStatus?.(`本地文本读取失败：${error.message || error}`, "error");
    } finally {
      importingNativeText = false;
    }
  }

  async function importNativeTextFile(file = {}) {
    const fileName = file.fileName || "local-text.txt";
    setNovelBusy("local");
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
      clearNovelBusy();
      focusLocalLibraryAfterImport();
      setStatus?.(`已加入手机本地书库：${entry.book.title || fileName}`);
      openReader(entry.book, 1);
    } catch (error) {
      clearNovelBusy();
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
    if (!readerState.active || !readerState.book?.id || !readerState.chapter?.index) return;
    window.clearTimeout(readerState.progressTimer);
    readerState.progressTimer = window.setTimeout(saveReaderProgress, 600);
  }

  function saveReaderProgress() {
    if (!readerState.active || !readerState.book?.id || !readerState.chapter?.index) return;
    const ratio = captureReaderRatio();
    if (isLocalBookId(readerState.book.id)) {
      saveLocalNovelProgress(readerState.book.id, {
        chapterIndex: readerState.chapter.index,
        scrollRatio: ratio
      })
        .then((entry) => {
          if (entry) {
            localBooks.set(entry.book.id, entry);
            readerState.book = entry.book;
          }
        })
        .catch(() => {});
      return;
    }
    postJson(getActiveUrl(), `/api/novels/${encodeURIComponent(readerState.book.id)}/progress`, {
      chapterIndex: readerState.chapter.index,
      scrollRatio: ratio
    }).catch(() => {});
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
    const ratio = Math.max(0, Math.min(1, Number(forcedRatio ?? readerState.pendingScrollRatio ?? 0)));
    readerState.pendingScrollRatio = 0;
    window.requestAnimationFrame(() => {
      scrollReaderToRatio(ratio);
      window.clearTimeout(readerState.progressTimer);
      readerState.progressTimer = window.setTimeout(saveReaderProgress, 80);
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
    renderNovelReader,
    getLibrarySource,
    setLibrarySource,
    focusLocalSource
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







