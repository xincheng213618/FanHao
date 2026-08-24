import {
  PHOTO_ALBUM_SORT_OPTIONS,
  PHOTO_COLLECTION_SORT_OPTIONS,
  photoCatalogCollections
} from "./photo-catalog.js?v=20260810-photo-catalog-01";

const DEFAULT_GALLERY_PHOTO_CATEGORY = "all";
const PHOTO_CATEGORY_LABELS = new Map([
  ["我喜欢的", "我喜欢的"],
  ["[XIUREN] 秀人网", "秀人网"],
  ["[COS]", "COS"]
]);
const MEDIA_KIND_CATEGORY_VALUES = {
  movie: "__fanhao_media_kind_movie__",
  tv: "__fanhao_media_kind_tv__",
  anime: "__fanhao_media_kind_anime__"
};
const MEDIA_KIND_CATEGORY_LABELS = {
  [MEDIA_KIND_CATEGORY_VALUES.movie]: "电影",
  [MEDIA_KIND_CATEGORY_VALUES.tv]: "电视剧",
  [MEDIA_KIND_CATEGORY_VALUES.anime]: "动漫"
};
const MEDIA_SORT_OPTIONS = [
  ["updated", "最近更新"],
  ["rating", "豆瓣评分"],
  ["year", "上映年份"],
  ["size", "文件大小"],
  ["title", "标题 A-Z"]
];
const PHOTO_READER_BATCH_SIZES = {
  local: 160,
  lan: 160,
  remote: 24,
  fallback: 48
};
const GALLERY_READER_EAGER_IMAGES = 3;
const GALLERY_READER_IMAGE_CONCURRENCY = 4;
const GALLERY_READER_PRELOAD_ABOVE = 900;
const GALLERY_READER_PRELOAD_BELOW = 1400;
const GALLERY_READER_ROOT_MARGIN = "900px 0px 1400px 0px";
const GALLERY_MORE_AUTO_LOAD_DISTANCE = 1200;
const GALLERY_MORE_SCROLL_INTENT_MS = 1200;
const GALLERY_MORE_GESTURE_IDLE_MS = 320;

export function createGalleryRenderer(deps) {
  const {
    api,
    cancelScheduledWorkRendering,
    disconnectPeopleIndexAutoload,
    els,
    formatBytes,
    formatDateTime,
    formatNumber,
    getGalleryPage,
    includesText,
    openAdminScript,
    resetProgressiveCoverLoading,
    state,
    writeStoredFlag
  } = deps;

  let galleryCoverObserver = null;
  let galleryReaderObserver = null;
  let galleryReaderScrollCleanup = null;
  let galleryReaderImageQueue = [];
  let activeGalleryReaderImageLoads = 0;
  let galleryReaderImageGeneration = 0;
  let galleryReaderStartupFigure = null;
  let galleryMoreScrollCleanup = null;
  let galleryMoreGestureConsumed = false;
  let galleryMoreGestureReleaseTimer = 0;
  let galleryPagerCleanup = null;
  let galleryScrollRestoreGeneration = 0;

function setGalleryStatus(message) {
  getGalleryPage().setStatus(message);
}

function renderGalleryStats() {
  const data = state.gallery.data || {};
  const stats = [
    ["套图", data.totals?.photoSets || 0],
    ["韩漫", data.totals?.manga || 0],
    ["欧美", data.totals?.western || 0],
    ["影视", (data.totals?.movies || 0) + (data.totals?.tv || 0) + (data.totals?.anime || 0)]
  ];

  els.statsRow.innerHTML = "";
  for (const [label, value] of stats) {
    const stat = document.createElement("div");
    stat.className = "stat";
    const strong = document.createElement("strong");
    strong.textContent = String(value);
    const span = document.createElement("span");
    span.textContent = label;
    stat.append(strong, span);
    els.statsRow.append(stat);
  }
}

async function loadImageLibrary(options = {}) {
  await getGalleryPage().loadImageLibrary(options);
}

function resetGalleryReader() {
  getGalleryPage().resetReader();
}

function syncGalleryRoute(mode = "push") {
  getGalleryPage().syncRoute(mode);
}

function galleryModeLabel(mode) {
  const labels = {
    photo: "套图",
    manga: "韩漫",
    western: "欧美",
    media: "影视作品",
    movie: "电影",
    tv: "电视剧",
    anime: "动漫",
    cache: "缓存"
  };
  return labels[mode] || mode;
}

function galleryMediaKindForMode(mode) {
  if (mode === "western") return "western";
  if (mode === "movie") return "movie";
  if (mode === "tv") return "tv";
  if (mode === "anime") return "anime";
  if (mode === "media") return "media";
  return "";
}

function galleryImageModuleButton(mode, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `gallery-submode-button${state.gallery.mode === mode ? " active" : ""}`;
  button.textContent = label;
  button.setAttribute("aria-pressed", String(state.gallery.mode === mode));
  const total = mode === "manga" ? state.gallery.data?.totals?.manga : state.gallery.data?.totals?.photoSets;
  if (total !== undefined) {
    button.title = `${label} · ${formatNumber(total)}`;
    button.setAttribute("aria-label", `${label}，${formatNumber(total)} 项`);
  }
  button.addEventListener("click", () => {
    if (state.gallery.mode === mode) return;
    state.gallery.mode = mode;
    state.gallery.photoView = "collections";
    state.gallery.photoCollection = null;
    state.gallery.category = mode === "photo" ? DEFAULT_GALLERY_PHOTO_CATEGORY : "all";
    state.gallery.subCategory = "all";
    state.gallery.person = "all";
    state.gallery.seriesKey = "";
    state.gallery.photoDate = "all";
    state.gallery.sort = "updated";
    state.gallery.visibleLimit = 80;
    resetGalleryReader();
    renderGalleryView();
    syncGalleryRoute();
  });
  return button;
}

function createGalleryImageModuleSwitch() {
  const row = document.createElement("div");
  row.className = "gallery-submodes gallery-image-modules";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "内容类型");
  row.append(galleryImageModuleButton("photo", "套图"), galleryImageModuleButton("manga", "韩漫"));
  return row;
}

function galleryPhotoViewButton(view, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `gallery-submode-button${state.gallery.photoView === view ? " active" : ""}`;
  button.textContent = label;
  button.setAttribute("aria-pressed", String(state.gallery.photoView === view));
  button.addEventListener("click", () => {
    state.gallery.photoView = view;
    state.gallery.photoCollection = null;
    if (view === "albums" && state.gallery.sort === "count") state.gallery.sort = "updated";
    if (view === "collections" && state.gallery.sort === "updated") state.gallery.sort = "count";
    state.gallery.person = "all";
    state.gallery.seriesKey = "";
    state.gallery.subCategory = "all";
    state.gallery.photoDate = "all";
    state.gallery.visibleLimit = 80;
    resetGalleryReader();
    renderGalleryView();
    syncGalleryRoute();
  });
  return button;
}

function createGalleryControlGroup(label, control, className = "") {
  const group = document.createElement("div");
  group.className = `gallery-control-group${className ? ` ${className}` : ""}`;
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", label);

  const title = document.createElement("span");
  title.className = "gallery-control-label";
  title.textContent = label;
  group.append(title, control);
  return group;
}

function createGalleryFilterField(label, control, className = "") {
  const field = document.createElement("label");
  field.className = `gallery-filter-field${className ? ` ${className}` : ""}`;

  const title = document.createElement("span");
  title.className = "gallery-control-label";
  title.textContent = label;
  field.append(title, control);
  return field;
}

function photoCategoryDisplayName(value) {
  const text = String(value || "").trim();
  if (!text) return "未归类";
  if (PHOTO_CATEGORY_LABELS.has(text)) return PHOTO_CATEGORY_LABELS.get(text);
  const bracketOnly = text.match(/^\[([^\]]+)\]$/);
  return bracketOnly ? bracketOnly[1].trim() || text : text;
}

function createPhotoCategoryStrip() {
  const strip = document.createElement("div");
  strip.className = "gallery-category-strip gallery-photo-category-strip";
  strip.setAttribute("role", "group");
  strip.setAttribute("aria-label", "套图大类");

  const addChip = (value, label, count) => {
    const active = (state.gallery.category || "all") === value;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `gallery-category-chip${active ? " active" : ""}`;
    button.textContent = label;
    button.setAttribute("aria-pressed", String(active));
    if (count !== undefined) {
      button.title = `${label} · ${formatNumber(count)} 期`;
      button.setAttribute("aria-label", `${label}，${formatNumber(count)} 期`);
    }
    button.addEventListener("click", () => {
      if ((state.gallery.category || "all") === value && !state.gallery.photoCollection) return;
      state.gallery.photoView = "collections";
      state.gallery.photoCollection = null;
      state.gallery.sort = "count";
      state.gallery.category = value;
      state.gallery.subCategory = "all";
      state.gallery.person = "all";
      state.gallery.seriesKey = "";
      state.gallery.photoDate = "all";
      state.gallery.visibleLimit = 80;
      resetGalleryReader();
      renderGalleryView();
      syncGalleryRoute();
    });
    strip.append(button);
  };

  const facets = currentGalleryCategoryFacets().filter((item) => !Object.values(MEDIA_KIND_CATEGORY_VALUES).includes(item.value));
  addChip("all", "全部大类", facets.reduce((sum, item) => sum + Number(item.count || 0), 0));
  for (const item of facets) addChip(item.value, photoCategoryDisplayName(item.value), item.count);
  return strip;
}

function appendFacetOption(select, label, value, count) {
  const option = new Option(label, value);
  if (count !== undefined) option.title = `${label} · ${formatNumber(count)}`;
  select.append(option);
}

function mediaItemsForMode(mode = state.gallery.mode) {
  const kind = galleryMediaKindForMode(mode);
  const list = currentImageLibraryList();
  const source = list && ["western", "media", "movie", "tv", "anime"].includes(state.gallery.mode)
    ? list.items || []
    : state.gallery.data?.mediaItems || [];
  if (kind === "media") return source.filter((item) => ["movie", "tv", "anime"].includes(item.mediaKind));
  return kind ? source.filter((item) => item.mediaKind === kind) : [];
}

function galleryMediaPlayerUrl(item) {
  const params = new URLSearchParams({ mediaId: String(item?.id || "") });
  params.set("returnTo", window.location.pathname + window.location.search);
  return `/player.html?${params.toString()}`;
}

function openScreenMediaPlayer(item) {
  if (!item?.id) return;
  window.location.href = galleryMediaPlayerUrl(item);
}

function tvSeriesGroupCountForItems(items = []) {
  const groups = new Set();
  for (const item of items) {
    const seriesName = String(item.seriesName || item.subCategory || item.category || "未归类").trim();
    const region = String(item.category || "电视剧").trim();
    groups.add(`${region}\n${seriesName}`);
  }
  return groups.size;
}

function mediaKindFromCategory(value) {
  const entry = Object.entries(MEDIA_KIND_CATEGORY_VALUES).find(([, categoryValue]) => categoryValue === value);
  return entry ? entry[0] : "";
}

function galleryCategoryDisplayName(value) {
  const text = String(value || "").trim();
  return MEDIA_KIND_CATEGORY_LABELS[text] || text;
}

function galleryCategoryMatchesItem(item, category = state.gallery.category) {
  if (!category || category === "all") return true;
  const mediaKind = mediaKindFromCategory(category);
  if (mediaKind) return item?.mediaKind === mediaKind;
  return item?.category === category;
}

function createMovieCategoryStrip() {
  const list = currentImageLibraryList();
  const kindCounts = new Map((list?.facets?.mediaKinds || []).map((item) => [item.value, Number(item.count || 0)]));
  const total = [...kindCounts.values()].reduce((sum, count) => sum + count, 0) || Number(list?.total || 0);
  const strip = document.createElement("div");
  strip.className = "gallery-media-kind-switch";

  const addChip = (value, label, count) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `gallery-media-kind-button${(state.gallery.mediaKind || "all") === value ? " active" : ""}`;
    button.textContent = label;
    button.title = `${label} · ${formatNumber(count)}`;
    button.setAttribute("aria-label", `${label}，${formatNumber(count)} 项`);
    button.setAttribute("aria-pressed", String((state.gallery.mediaKind || "all") === value));
    button.addEventListener("click", () => {
      state.gallery.mediaKind = value;
      state.gallery.person = "all";
      state.gallery.seriesKey = "";
      state.gallery.visibleLimit = 80;
      resetGalleryReader();
      renderGalleryView();
      syncGalleryRoute();
    });
    strip.append(button);
  };

  addChip("all", "全部", total);
  addChip("movie", "电影", kindCounts.get("movie") || 0);
  addChip("tv", "电视剧", kindCounts.get("tv") || 0);
  addChip("anime", "动漫", kindCounts.get("anime") || 0);

  return strip;
}

function galleryRescanScopeForMode() {
  if (state.gallery.mode === "photo") return "photo";
  if (state.gallery.mode === "media") return "media";
  if (["western", "movie", "tv", "anime"].includes(state.gallery.mode)) return state.gallery.mode;
  return "all";
}

function renderGalleryControls(options = {}) {
  const controls = document.createElement("div");
  controls.className = "gallery-controls";
  const imageModule = ["photo", "manga"].includes(state.gallery.mode);
  if (imageModule) controls.classList.add("gallery-image-controls");

  const photoViews = document.createElement("div");
  photoViews.className = "gallery-submodes";
  photoViews.setAttribute("role", "group");
  photoViews.setAttribute("aria-label", "套图浏览方式");
  photoViews.append(galleryPhotoViewButton("collections", "按合集"), galleryPhotoViewButton("albums", "全部套图"));

  const search = document.createElement("input");
  search.type = "search";
  search.className = "gallery-search";
  const mediaModule = ["western", "media", "movie", "tv"].includes(state.gallery.mode);
  search.placeholder = state.gallery.mode === "manga"
    ? "搜索韩漫标题、分类或站点"
    : mediaModule
      ? "搜索片名、演员、导演或类型"
      : "搜索标题、人物、合集；多个词可同时匹配";
  search.setAttribute("aria-label", state.gallery.mode === "manga" ? "搜索韩漫" : mediaModule ? "搜索影视资料库" : "搜索套图");
  search.value = options.searchValue ?? state.gallery.query;
  search.addEventListener("search", () => {
    if (!search.value && state.gallery.query) submitGallerySearch("");
  });
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitGallerySearch(search.value, { restoreFocus: true });
      return;
    }
    if (event.key === "Escape" && search.value) {
      event.preventDefault();
      search.value = "";
      submitGallerySearch("", { restoreFocus: true });
    }
  });

  const category = document.createElement("select");
  category.className = "gallery-select";
  category.setAttribute("aria-label", state.gallery.mode === "photo" ? "套图分类" : "分类");
  category.append(new Option(state.gallery.mode === "photo" ? "全部大类" : state.gallery.mode === "tv" ? "全部地区" : "全部片库分区", "all"));
  const categoryFacets = currentGalleryCategoryFacets().filter((item) => !Object.values(MEDIA_KIND_CATEGORY_VALUES).includes(item.value));
  for (const item of categoryFacets) {
    const label = state.gallery.mode === "photo" ? photoCategoryDisplayName(item.value) : galleryCategoryDisplayName(item.value);
    appendFacetOption(category, label, item.value, item.count);
  }
  if (
    state.gallery.category !== "all" &&
    !categoryFacets.some((item) => item.value === state.gallery.category)
  ) {
    const label = state.gallery.mode === "photo" ? photoCategoryDisplayName(state.gallery.category) : galleryCategoryDisplayName(state.gallery.category);
    category.append(new Option(label, state.gallery.category));
  }
  category.value = state.gallery.category;
  category.addEventListener("change", () => {
    state.gallery.category = category.value || "all";
    state.gallery.subCategory = "all";
    state.gallery.photoCollection = null;
    state.gallery.person = "all";
    state.gallery.seriesKey = "";
    state.gallery.photoDate = "all";
    state.gallery.visibleLimit = 80;
    resetGalleryReader();
    renderGalleryView();
    syncGalleryRoute();
  });

  const people = document.createElement("select");
  people.className = "gallery-select";
  people.append(new Option(state.gallery.mode === "tv" ? "全部作品" : "全部人物", "all"));
  const peopleFacets = currentGalleryPeopleFacets().slice(0, state.gallery.mode === "tv" ? 1000 : 300);
  for (const item of peopleFacets) {
    appendFacetOption(people, state.gallery.mode === "photo" ? photoPersonDisplayName(item.value) : item.value, item.value, item.count);
  }
  if (
    state.gallery.person !== "all" &&
    !peopleFacets.some((item) => item.value === state.gallery.person)
  ) {
    people.append(new Option(photoPersonDisplayName(state.gallery.person), state.gallery.person));
  }
  people.value = state.gallery.person;
  people.addEventListener("change", () => {
    const nextPerson = people.value || "all";
    state.gallery.photoCollection = null;
    state.gallery.person = nextPerson;
    state.gallery.seriesKey = "";
    state.gallery.visibleLimit = 80;
    resetGalleryReader();
    renderGalleryView();
    syncGalleryRoute();
  });

  const sort = document.createElement("select");
  sort.className = "gallery-select gallery-sort-select";
  const photoSearchActive = state.gallery.mode === "photo" && Boolean(String(state.gallery.query || "").trim());
  const sortOptions = photoSearchActive
    ? [["updated", "相关性排序"]]
    : state.gallery.mode === "photo"
      ? state.gallery.photoView === "collections" && !state.gallery.photoCollection
        ? PHOTO_COLLECTION_SORT_OPTIONS
        : PHOTO_ALBUM_SORT_OPTIONS
      : MEDIA_SORT_OPTIONS;
  for (const [value, label] of sortOptions) sort.append(new Option(label, value));
  if (!sortOptions.some(([value]) => value === state.gallery.sort)) state.gallery.sort = "updated";
  sort.value = state.gallery.sort || "updated";
  sort.setAttribute("aria-label", "排序");
  sort.disabled = photoSearchActive;
  sort.addEventListener("change", () => {
    state.gallery.sort = sort.value || "updated";
    state.gallery.visibleLimit = 80;
    resetGalleryReader();
    renderGalleryView();
    syncGalleryRoute();
  });

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "text-button";
  const rescanScope = galleryRescanScopeForMode();
  refresh.textContent = imageModule ? "图库维护" : "维护";
  if (!imageModule) refresh.title = `后台刷新${galleryModeLabel(state.gallery.mode)}索引`;
  if (imageModule) refresh.title = "打开图库索引与刷新工具";
  refresh.disabled = state.gallery.loading;
  refresh.addEventListener("click", () => openAdminScript?.("image-library-rescan", { defaults: { scope: rescanScope } }));

  const status = document.createElement("span");
  status.className = "gallery-status";
  status.textContent = state.gallery.status || "";

  if (imageModule) {
    const searchRow = document.createElement("div");
    searchRow.className = "gallery-control-row gallery-search-row";
    const hierarchy = document.createElement("div");
    hierarchy.className = "gallery-control-row gallery-hierarchy-row";
    const maintenance = document.createElement("div");
    maintenance.className = "gallery-maintenance";
    maintenance.append(refresh, status);

    if (state.gallery.mode === "photo") {
      controls.classList.add("gallery-photo-controls");
      searchRow.classList.add("gallery-photo-primary-row");
      const title = document.createElement("h1");
      title.className = "gallery-photo-title";
      title.textContent = "套图图库";
      search.placeholder = "搜索标题、人物、合集";
      searchRow.append(
        title,
        createGalleryFilterField("搜索", search, "gallery-search-field gallery-photo-search-field"),
        createGalleryControlGroup("内容", createGalleryImageModuleSwitch(), "gallery-photo-module-switch"),
        maintenance
      );

      hierarchy.classList.add("gallery-photo-secondary-row");
      hierarchy.append(
        createPhotoCategoryStrip(),
        createGalleryControlGroup("浏览", photoViews, "gallery-photo-view-switch"),
        createGalleryControlGroup("排序", sort, "gallery-photo-sort")
      );
    } else {
      searchRow.append(createGalleryFilterField("搜索", search, "gallery-search-field"));
      hierarchy.append(createGalleryControlGroup("内容", createGalleryImageModuleSwitch()), maintenance);
    }
    controls.append(searchRow, hierarchy);
    return controls;
  }

  controls.classList.add("gallery-media-controls");
  const searchRow = document.createElement("div");
  searchRow.className = "gallery-media-search-row";
  const searchBox = document.createElement("div");
  searchBox.className = "gallery-media-search-box";
  const searchSubmit = document.createElement("button");
  searchSubmit.type = "button";
  searchSubmit.className = "gallery-media-search-submit";
  searchSubmit.textContent = "搜索";
  searchSubmit.addEventListener("click", () => submitGallerySearch(search.value, { restoreFocus: true }));
  searchBox.append(search, searchSubmit);
  searchRow.append(createGalleryFilterField("搜索影视", searchBox, "gallery-media-search-field"));
  if (state.gallery.mode === "media") searchRow.append(createGalleryControlGroup("内容类型", createMovieCategoryStrip()));

  const filterRow = document.createElement("div");
  filterRow.className = "gallery-media-filter-row";
  if (["western", "media", "movie", "tv"].includes(state.gallery.mode)) {
    filterRow.append(createGalleryControlGroup(state.gallery.mode === "tv" ? "地区" : "片库分区", category));
  }
  if (["western", "tv"].includes(state.gallery.mode)) filterRow.append(createGalleryControlGroup(state.gallery.mode === "tv" ? "剧集" : "人物", people));
  if (["movie", "media"].includes(state.gallery.mode)) filterRow.append(createGalleryControlGroup("排序", sort));

  if (state.gallery.query || state.gallery.category !== "all" || state.gallery.seriesKey || (state.gallery.mode === "media" && state.gallery.mediaKind !== "all")) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "text-button gallery-filter-clear";
    clear.textContent = "清除筛选";
    clear.addEventListener("click", () => {
      state.gallery.query = "";
      state.gallery.category = "all";
      state.gallery.mediaKind = "all";
      state.gallery.person = "all";
      state.gallery.seriesKey = "";
      state.gallery.visibleLimit = 80;
      renderGalleryView();
      syncGalleryRoute("replace");
    });
    filterRow.append(clear);
  }
  const maintenance = document.createElement("div");
  maintenance.className = "gallery-maintenance gallery-media-maintenance";
  maintenance.append(refresh, status);
  filterRow.append(maintenance);
  controls.append(searchRow, filterRow);
  return controls;
}

function submitGallerySearch(value, options = {}) {
  const nextQuery = String(value || "").trim();
  if (state.gallery.query === nextQuery) {
    if (options.restoreFocus) restoreGallerySearchFocus();
    return;
  }
  const startingPhotoSearch = state.gallery.mode === "photo" && nextQuery && !String(state.gallery.query || "").trim();
  state.gallery.query = nextQuery;
  if (startingPhotoSearch) {
    state.gallery.photoView = "albums";
    state.gallery.photoCollection = null;
    state.gallery.sort = "updated";
    state.gallery.category = "all";
    state.gallery.subCategory = "all";
    state.gallery.person = "all";
    state.gallery.photoDate = "all";
  }
  const search = els.workGrid?.querySelector(".gallery-search");
  if (search && search.value !== nextQuery) search.value = nextQuery;
  state.gallery.visibleLimit = 80;
  resetGalleryReader();
  renderGalleryResults();
  syncGalleryRoute("replace");
  if (options.restoreFocus) restoreGallerySearchFocus();
}

function restoreGallerySearchFocus() {
  const focusSearch = () => {
    const search = els.workGrid?.querySelector(".gallery-search");
    search?.focus({ preventScroll: true });
    search?.setSelectionRange?.(search.value.length, search.value.length);
  };
  focusSearch();
  window.requestAnimationFrame(focusSearch);
  window.setTimeout(focusSearch, 0);
  window.setTimeout(focusSearch, 80);
  window.setTimeout(focusSearch, 180);
}

function activeGallerySearchValue() {
  const active = document.activeElement;
  return active?.classList?.contains("gallery-search") ? active.value : null;
}

function resetGalleryRenderedState() {
  disconnectPeopleIndexAutoload();
  cancelScheduledWorkRendering();
  resetProgressiveCoverLoading();
  galleryReaderImageGeneration += 1;
  galleryReaderImageQueue = [];
  activeGalleryReaderImageLoads = 0;
  galleryReaderStartupFigure = null;
  if (galleryCoverObserver) {
    galleryCoverObserver.disconnect();
    galleryCoverObserver = null;
  }
  if (galleryReaderObserver) {
    galleryReaderObserver.disconnect();
    galleryReaderObserver = null;
  }
  if (galleryReaderScrollCleanup) {
    galleryReaderScrollCleanup();
    galleryReaderScrollCleanup = null;
  }
  if (galleryMoreScrollCleanup) {
    galleryMoreScrollCleanup();
    galleryMoreScrollCleanup = null;
  }
  if (galleryPagerCleanup) {
    galleryPagerCleanup();
    galleryPagerCleanup = null;
  }
}

function renderGalleryContent(content) {
  if (state.gallery.album) {
    renderPhotoReader(content);
  } else if (state.gallery.comic) {
    renderMangaReader(content);
  } else if (state.gallery.media) {
    renderMediaReader(content);
  } else if (["photo", "manga"].includes(state.gallery.mode)) {
    renderPagedImageLibrary(content);
  } else if (["western", "media", "movie", "tv"].includes(state.gallery.mode)) {
    renderMediaShelf(content);
  } else {
    renderPagedImageLibraryMessage(content, "当前图库模式不可用");
  }
}

function currentImageLibraryList() {
  const key = getGalleryPage().imageLibraryListKey?.() || "";
  return key && state.gallery.list?.key === key ? state.gallery.list : null;
}

function captureGalleryScrollPosition() {
  const scrollingElement = document.scrollingElement || document.documentElement;
  return {
    top: Math.max(0, Number(window.scrollY || scrollingElement?.scrollTop || 0)),
    left: Math.max(0, Number(window.scrollX || scrollingElement?.scrollLeft || 0))
  };
}

function restoreGalleryScrollPosition(anchor) {
  if (!anchor) return;
  const generation = ++galleryScrollRestoreGeneration;
  const restore = () => {
    if (generation !== galleryScrollRestoreGeneration) return;
    const scrollingElement = document.scrollingElement || document.documentElement;
    const maxTop = Math.max(0, Number(scrollingElement?.scrollHeight || 0) - window.innerHeight);
    window.scrollTo({
      top: Math.min(Math.max(0, Number(anchor.top) || 0), maxTop),
      left: Math.max(0, Number(anchor.left) || 0),
      behavior: "auto"
    });
  };
  restore();
  window.requestAnimationFrame(() => window.requestAnimationFrame(restore));
}

function renderGalleryResults(options = {}) {
  const scrollAnchor = options.preserveScroll ? captureGalleryScrollPosition() : null;
  if (!scrollAnchor) galleryScrollRestoreGeneration += 1;
  resetGalleryRenderedState();
  const content = els.workGrid.querySelector(".gallery-content");
  if (!content) {
    renderGalleryView(options);
    return;
  }
  content.innerHTML = "";
  renderGalleryContent(content);
  restoreGalleryScrollPosition(scrollAnchor);
}

function currentGalleryCategoryFacets() {
  const facets = state.gallery.data?.facets || {};
  if (state.gallery.mode === "photo") return currentImageLibraryList()?.facets?.categories || facets.categories || [];
  const listFacets = currentImageLibraryList()?.facets || {};
  const kind = galleryMediaKindForMode(state.gallery.mode);
  if (kind === "media") {
    return listFacets.categories || facets.media?.categories || [];
  }
  return kind ? listFacets.categories || facets[kind]?.categories || [] : [];
}

function currentGalleryPeopleFacets() {
  const facets = state.gallery.data?.facets || {};
  if (state.gallery.mode === "photo") return currentImageLibraryList()?.facets?.people || facets.people || [];
  const listPeople = currentImageLibraryList()?.facets?.people;
  if (listPeople?.length) return listPeople;
  const kind = galleryMediaKindForMode(state.gallery.mode);
  if (kind === "tv") return currentTvSeriesFacets();
  if (kind === "western") return localGalleryFacets(filteredWesternItemsForGroups(), "personName");
  return [];
}

function currentTvSeriesFacets() {
  let items = mediaItemsForMode("tv");
  if (state.gallery.category !== "all") items = items.filter((item) => galleryCategoryMatchesItem(item));
  const query = state.gallery.query.trim();
  if (query) items = items.filter((item) => includesText(galleryText(item), query));
  return localGalleryFacets(items, "seriesName");
}

function galleryText(item) {
  const movieMetadata = item.mediaKind === "movie" ? item.movieMetadata || {} : {};
  const tvMetadata = ["tv", "anime"].includes(item.mediaKind) || item.type === "tvSeriesWork" ? item.tvSeries || {} : {};
  return [
    item.title,
    item.category,
    item.subCategory,
    item.personName,
    item.seriesName,
    item.rootLabel,
    item.relativePath,
    movieMetadata.title,
    movieMetadata.originalTitle,
    movieMetadata.imdbId,
    ...(movieMetadata.aliases || []),
    ...(movieMetadata.directors || []),
    ...(movieMetadata.writers || []),
    ...(movieMetadata.actors || []),
    ...(movieMetadata.genres || []),
    ...(movieMetadata.countries || []),
    tvMetadata.title,
    tvMetadata.originalTitle,
    tvMetadata.imdbId,
    ...(tvMetadata.aliases || []),
    ...(tvMetadata.directors || []),
    ...(tvMetadata.writers || []),
    ...(tvMetadata.actors || []),
    ...(tvMetadata.genres || []),
    ...(tvMetadata.countries || [])
  ].filter(Boolean).join("\n");
}

function photoPersonDisplayName(value) {
  const name = String(value || "").trim();
  if (!name) return "未归类";
  const bracketOnly = name.match(/^\[([^\]]+)\]$/);
  return bracketOnly ? bracketOnly[1].trim() || name : name;
}

function localGalleryFacets(items, fieldName) {
  const counts = new Map();
  for (const item of items) {
    const value = String(item[fieldName] || "").trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { numeric: true, sensitivity: "base" }));
}

function filteredMediaItems() {
  const list = currentImageLibraryList();
  if (list && ["western", "media", "movie", "tv"].includes(state.gallery.mode)) return list.items || [];
  const kind = galleryMediaKindForMode(state.gallery.mode);
  if (kind === "media") {
    if (state.gallery.person !== "all") {
      let episodes = mediaItemsForMode("tv");
      if (state.gallery.category !== "all") episodes = episodes.filter((item) => galleryCategoryMatchesItem(item));
      episodes = episodes.filter((item) => item.seriesName === state.gallery.person);
      const query = state.gallery.query.trim();
      if (query) episodes = episodes.filter((item) => includesText(galleryText(item), query));
      return [...episodes].sort((a, b) => String(a.title || "").localeCompare(String(b.title || ""), undefined, { numeric: true, sensitivity: "base" }));
    }
    let movies = mediaItemsForMode("movie");
    if (state.gallery.category !== "all") movies = movies.filter((item) => galleryCategoryMatchesItem(item));
    const query = state.gallery.query.trim();
    if (query) movies = movies.filter((item) => includesText(galleryText(item), query));
    return sortMovieItems([...movies, ...tvSeriesGroups().map(tvSeriesWorkItem)]);
  }
  let items = mediaItemsForMode(state.gallery.mode);
  if (state.gallery.category !== "all") items = items.filter((item) => galleryCategoryMatchesItem(item));
  if (state.gallery.person !== "all") {
    items = items.filter((item) => (kind === "tv" ? item.seriesName : item.personName) === state.gallery.person);
  }
  const query = state.gallery.query.trim();
  if (query) items = items.filter((item) => includesText(galleryText(item), query));
  if (kind === "movie") items = sortMovieItems(items);
  return items;
}

function tvSeriesWorkItem(group = {}) {
  return {
    id: group.value,
    type: "tvSeriesWork",
    mediaKind: "tv",
    title: tvSeriesDisplayTitle(group.title, group.tvSeries),
    category: group.category || "",
    subCategory: group.title || "",
    personName: group.title || "",
    seriesName: group.title || "",
    tvSeries: group.tvSeries || null,
    coverUrl: group.coverUrl || "",
    size: Number(group.size || 0),
    updatedAt: group.updatedAt || "",
    episodeCount: Number(group.count || 0),
    samples: group.samples || []
  };
}

function movieSortRating(item) {
  const metadata = screenMetadata(item);
  const rating = Number(metadata?.rating || item?.rating || 0);
  return Number.isFinite(rating) ? rating : 0;
}

function movieSortYear(item) {
  const metadata = screenMetadata(item);
  const year = Number.parseInt(String(metadata?.year || item?.year || "").match(/\d{4}/)?.[0] || "", 10);
  return Number.isFinite(year) ? year : 0;
}

function sortMovieItems(items = []) {
  const list = [...items];
  const sort = state.gallery.sort || "updated";
  if (sort === "rating") {
    return list.sort((a, b) => {
      const ratingDiff = movieSortRating(b) - movieSortRating(a);
      if (ratingDiff) return ratingDiff;
      const countDiff = Number(b?.movieMetadata?.ratingCount || 0) - Number(a?.movieMetadata?.ratingCount || 0);
      if (countDiff) return countDiff;
      return movieDisplayTitle(a).localeCompare(movieDisplayTitle(b), undefined, { numeric: true, sensitivity: "base" });
    });
  }
  if (sort === "year") {
    return list.sort((a, b) => {
      const yearDiff = movieSortYear(b) - movieSortYear(a);
      if (yearDiff) return yearDiff;
      return movieDisplayTitle(a).localeCompare(movieDisplayTitle(b), undefined, { numeric: true, sensitivity: "base" });
    });
  }
  if (sort === "size") {
    return list.sort((a, b) => Number(b.size || 0) - Number(a.size || 0) || movieDisplayTitle(a).localeCompare(movieDisplayTitle(b), undefined, { numeric: true, sensitivity: "base" }));
  }
  if (sort === "title") {
    return list.sort((a, b) => movieDisplayTitle(a).localeCompare(movieDisplayTitle(b), "zh-Hans-CN", { numeric: true, sensitivity: "base" }));
  }
  return list.sort((a, b) => {
    const timeDiff = new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    return timeDiff || movieDisplayTitle(a).localeCompare(movieDisplayTitle(b), undefined, { numeric: true, sensitivity: "base" });
  });
}

function movieListMetaLine(item) {
  const metadata = screenMetadata(item);
  return [
    metadata.year || "",
    ["tv", "anime"].includes(item.mediaKind) && metadata.pubdate ? `首播 ${metadata.pubdate}` : "",
    (metadata.countries || []).slice(0, 2).join(" / ") || item.category,
    (metadata.genres || []).slice(0, 3).join(" / ")
  ].filter(Boolean).join(" / ");
}

function movieListPeopleLine(item) {
  const metadata = screenMetadata(item);
  return [
    (metadata.directors || []).slice(0, 2).join(" / "),
    (metadata.actors || []).slice(0, 4).join(" / ")
  ].filter(Boolean).join(" / ");
}

function movieListRatingLine(item) {
  const metadata = screenMetadata(item);
  const rating = Number(metadata.rating || 0);
  if (Number.isFinite(rating) && rating > 0) {
    return {
      score: rating.toFixed(1),
      count: metadata.ratingCount ? `${formatNumber(metadata.ratingCount)} 人评价` : ""
    };
  }
  return null;
}

function filteredWesternItemsForGroups() {
  let items = mediaItemsForMode("western");
  if (state.gallery.category !== "all") items = items.filter((item) => item.category === state.gallery.category);
  const query = state.gallery.query.trim();
  if (query) items = items.filter((item) => includesText(galleryText(item), query));
  return items;
}

function westernPersonGroups() {
  const list = currentImageLibraryList();
  if (list && state.gallery.mode === "western" && state.gallery.person === "all") {
    return (list.items || []).map((item) => ({
      personName: item.personName || item.title || "未归类",
      count: Number(item.videoCount || 0),
      playableCount: Number(item.playableCount || 0),
      size: Number(item.size || 0),
      updatedAt: item.updatedAt || "",
      coverUrl: item.coverUrl || "",
      categories: new Map((item.categories || []).map((entry) => [entry.value, entry.count])),
      samples: item.samples || []
    }));
  }
  const groups = new Map();
  for (const item of filteredWesternItemsForGroups()) {
    const personName = String(item.personName || item.subCategory || item.category || "未归类").trim();
    const key = personName || "未归类";
    let group = groups.get(key);
    if (!group) {
      group = {
        personName: key,
        count: 0,
        playableCount: 0,
        size: 0,
        updatedAt: "",
        coverUrl: item.coverUrl || "",
        categories: new Map(),
        samples: []
      };
      groups.set(key, group);
    }
    group.count += 1;
    if (item.playable) group.playableCount += 1;
    group.size += Number(item.size || 0);
    if (item.category) group.categories.set(item.category, (group.categories.get(item.category) || 0) + 1);
    if (group.samples.length < 3 && item.title) group.samples.push(item.title);
    const itemTime = new Date(item.updatedAt || 0).getTime();
    const groupTime = new Date(group.updatedAt || 0).getTime();
    if (itemTime > groupTime) {
      group.updatedAt = item.updatedAt || group.updatedAt;
      if (item.coverUrl) group.coverUrl = item.coverUrl;
    } else if (!group.coverUrl && item.coverUrl) {
      group.coverUrl = item.coverUrl;
    }
  }
  return [...groups.values()].sort((a, b) => {
    const countDiff = b.count - a.count;
    if (countDiff) return countDiff;
    const timeDiff = new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    return timeDiff || a.personName.localeCompare(b.personName, undefined, { numeric: true, sensitivity: "base" });
  });
}

function filteredTvItemsForGroups() {
  let items = mediaItemsForMode("tv");
  if (state.gallery.category !== "all") items = items.filter((item) => galleryCategoryMatchesItem(item));
  const query = state.gallery.query.trim();
  if (query) items = items.filter((item) => includesText(galleryText(item), query));
  return items;
}

function tvSeriesGroups() {
  const list = currentImageLibraryList();
  if (list && state.gallery.mode === "tv" && state.gallery.person === "all") {
    return (list.items || []).map((item) => ({
      value: item.seriesKey || item.id,
      title: item.seriesName || item.title,
      category: item.category || "",
      count: Number(item.episodeCount || item.chapterCount || 0),
      size: Number(item.size || 0),
      updatedAt: item.updatedAt || "",
      samples: [],
      coverUrl: item.coverUrl || "",
      tvSeries: item.tvSeries || null
    }));
  }
  const groups = new Map();
  for (const item of filteredTvItemsForGroups()) {
    const seriesName = String(item.seriesName || item.subCategory || item.category || "未归类").trim();
    const region = String(item.category || "电视剧").trim();
    const value = `${region}\n${seriesName}`;
    let group = groups.get(value);
    if (!group) {
      group = {
        value,
        title: seriesName,
        category: region,
        count: 0,
        size: 0,
        updatedAt: "",
        samples: [],
        coverUrl: item.tvSeries?.coverUrl || "",
        tvSeries: item.tvSeries || null
      };
      groups.set(value, group);
    }
    group.count += 1;
    group.size += Number(item.size || 0);
    if (!group.tvSeries && item.tvSeries) group.tvSeries = item.tvSeries;
    if (!group.coverUrl && item.tvSeries?.coverUrl) group.coverUrl = item.tvSeries.coverUrl;
    if (group.samples.length < 2 && item.title) group.samples.push(item.title);
    const itemTime = new Date(item.updatedAt || 0).getTime();
    const groupTime = new Date(group.updatedAt || 0).getTime();
    if (itemTime > groupTime) group.updatedAt = item.updatedAt || group.updatedAt;
  }
  return [...groups.values()].sort((a, b) => {
    const regionDiff = a.category.localeCompare(b.category, undefined, { numeric: true, sensitivity: "base" });
    if (state.gallery.category === "all" && regionDiff) return regionDiff;
    const timeDiff = new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    return timeDiff || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
  });
}

function hasSelectedTvSeries() {
  return Boolean(state.gallery.seriesKey || state.gallery.person !== "all");
}

function selectedTvSeriesMetadata() {
  if (!["tv", "media"].includes(state.gallery.mode) || !hasSelectedTvSeries()) return null;
  return filteredMediaItems().find((item) => item.tvSeries)?.tvSeries || null;
}

function tvSeriesDisplayTitle(seriesName, metadata = null) {
  const title = metadata?.title || seriesName || "电视剧";
  return metadata?.year ? `${title}（${metadata.year}）` : title;
}

function tvSeriesRatingText(metadata = null) {
  if (!metadata?.rating) return "";
  const rating = `豆瓣 ${Number(metadata.rating).toFixed(1)}`;
  return metadata.ratingCount ? `${rating} · ${formatNumber(metadata.ratingCount)} 人评价` : rating;
}

function tvSeriesBetterThanText(metadata = null) {
  const items = Array.isArray(metadata?.ratingBetterThan) ? metadata.ratingBetterThan : [];
  return items
    .map((item) => (item?.percent && item?.type ? `好于 ${item.percent}% ${item.type}` : ""))
    .filter(Boolean)
    .join(" · ");
}

function formatMediaTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function hasCjkText(value) {
  return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(String(value || ""));
}

function screenMetadata(media = {}) {
  return ["tv", "anime"].includes(media?.mediaKind) || media?.type === "tvSeriesWork" ? media.tvSeries || {} : media.movieMetadata || {};
}

function movieChineseTitle(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!hasCjkText(text)) return text;
  const parts = text.split(" ");
  const lastCjk = parts.reduce((last, part, index) => (hasCjkText(part) ? index : last), -1);
  return lastCjk >= 0 ? parts.slice(0, lastCjk + 1).join(" ").trim() : text;
}

function moviePrimaryTitle(media = {}) {
  const metadata = screenMetadata(media);
  const aliases = Array.isArray(metadata.aliases) ? metadata.aliases : [];
  const candidates = [
    metadata.title,
    metadata.movieTitle,
    media.seriesName,
    ...aliases.filter(hasCjkText),
    media.title
  ].map((item) => String(item || "").trim()).filter(Boolean);
  const title = candidates.find(hasCjkText) || candidates[0] || "影视作品";
  return movieChineseTitle(title);
}

function movieDisplayTitle(media = {}) {
  const metadata = screenMetadata(media);
  const title = moviePrimaryTitle(media);
  return metadata.year && !String(title).includes(String(metadata.year)) ? `${title}（${metadata.year}）` : title;
}

function movieOriginalTitleText(media = {}) {
  const metadata = screenMetadata(media);
  const primary = moviePrimaryTitle(media);
  return [
    metadata.originalTitle && metadata.originalTitle !== primary ? metadata.originalTitle : "",
    metadata.title && metadata.title !== primary ? metadata.title : ""
  ].filter(Boolean).join(" / ");
}

function waitForMs(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function movieDoubanUrl(metadata = {}) {
  const directUrl = String(metadata?.doubanUrl || "").trim();
  if (directUrl) return directUrl;
  const id = String(metadata?.doubanId || "").trim();
  return /^\d{5,}$/.test(id) ? `https://movie.douban.com/subject/${id}/` : "";
}

function normalizeMovieDoubanInput(value) {
  const text = String(value || "").trim();
  const urlMatch = text.match(/(?:https?:)?\/\/(?:movie\.)?douban\.com\/subject\/(\d+)\/?/i);
  if (urlMatch) return `https://movie.douban.com/subject/${urlMatch[1]}/`;
  const pathMatch = text.match(/\bsubject\/(\d+)\/?/i);
  if (pathMatch) return `https://movie.douban.com/subject/${pathMatch[1]}/`;
  return /^\d{5,}$/.test(text) ? `https://movie.douban.com/subject/${text}/` : "";
}

async function waitForMovieDoubanTask(taskId, mediaId) {
  if (!taskId) return;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    await waitForMs(attempt ? 2500 : 800);
    const data = await api("/api/admin/tasks");
    const task = (data.tasks || []).find((item) => item.id === taskId);
    if (!task || task.status === "running" || task.status === "stopping") continue;
    if (task.status === "done") {
      setGalleryStatus("豆瓣校准已完成，正在刷新电影资料");
      await loadImageLibrary({ reload: true });
      if (state.gallery.media?.id === mediaId) {
        await openGalleryMedia(mediaId, { replaceRoute: true });
      } else {
        renderGalleryView();
      }
      setGalleryStatus("豆瓣资料已更新");
      return;
    }
    const tail = (task.logs || []).slice(-4).join(" / ");
    throw new Error(tail || `${task.label || "豆瓣校准"}没有完成`);
  }
  throw new Error("豆瓣校准还在后台运行，稍后刷新页面可以看到结果");
}

async function openMovieDoubanCalibration(media, metadata = null) {
  const current = movieDoubanUrl(metadata);
  const value = window.prompt("粘贴正确的豆瓣电影链接或 subject ID", current || "");
  if (value === null) return;
  const subjectUrl = normalizeMovieDoubanInput(value);
  if (!subjectUrl) {
    setGalleryStatus("豆瓣链接格式不对，请粘贴 movie.douban.com/subject/xxx/ 或纯数字 ID");
    return;
  }
  const mediaId = String(media?.id || "").trim();
  if (!mediaId) {
    setGalleryStatus("这条电影缺少媒体 ID，先刷新电影索引后再校准");
    return;
  }
  setGalleryStatus("正在启动豆瓣校准");
  try {
    const data = await api("/api/admin/scripts/run", {
      method: "POST",
      body: {
        scriptId: "douban-movie-metadata",
        options: {
          write: true,
          refresh: true,
          limit: 0,
          mediaId,
          doubanUrl: subjectUrl,
          sleep: 0,
          jitter: 0
        }
      }
    });
    setGalleryStatus("豆瓣校准已启动，等待后台写入");
    await waitForMovieDoubanTask(data.task?.id, mediaId);
  } catch (error) {
    setGalleryStatus(error.message || "豆瓣校准失败");
    if (openAdminScript) {
      openAdminScript("douban-movie-metadata", {
        defaults: {
          write: true,
          refresh: true,
          limit: 0,
          mediaId,
          doubanUrl: subjectUrl
        }
      });
    }
  }
}

function renderTvSeriesBar(container, total) {
  if (!["tv", "media"].includes(state.gallery.mode) || !hasSelectedTvSeries()) return;
  const metadata = selectedTvSeriesMetadata();
  const bar = document.createElement("div");
  bar.className = "gallery-person-bar gallery-series-hero";

  if (metadata?.coverUrl) {
    const poster = document.createElement("div");
    poster.className = "gallery-series-poster";
    const image = document.createElement("img");
    image.src = metadata.coverUrl;
    image.alt = `${tvSeriesDisplayTitle(state.gallery.person, metadata)} 海报`;
    poster.append(image);
    bar.append(poster);
  }

  const text = document.createElement("div");
  text.className = "gallery-person-bar-text gallery-series-copy";
  const eyebrow = document.createElement("span");
  eyebrow.className = "gallery-series-eyebrow";
  eyebrow.textContent = [state.gallery.mediaKind === "anime" ? "动漫" : "电视剧", state.gallery.category !== "all" ? galleryCategoryDisplayName(state.gallery.category) : ""].filter(Boolean).join(" · ");
  const title = document.createElement("h1");
  title.textContent = tvSeriesDisplayTitle(state.gallery.person, metadata);
  const stats = document.createElement("div");
  stats.className = "gallery-series-stats";
  const statItems = [
    metadata?.rating ? [Number(metadata.rating).toFixed(1), metadata?.ratingCount ? `${formatNumber(metadata.ratingCount)} 人评分` : "豆瓣评分"] : null,
    [formatNumber(metadata?.episodeCount || total), "集"],
    metadata?.episodeDuration ? [metadata.episodeDuration, "单集"] : null,
    metadata?.pubdate ? [String(metadata.pubdate).slice(0, 10), "首播"] : null
  ].filter(Boolean);
  for (const [value, label] of statItems) {
    const stat = document.createElement("span");
    const strong = document.createElement("strong");
    const small = document.createElement("small");
    strong.textContent = value;
    small.textContent = label;
    stat.append(strong, small);
    stats.append(stat);
  }
  const directors = metadata?.directors?.slice(0, 2) || [];
  const actors = metadata?.actors?.slice(0, 5) || [];
  const credits = document.createElement("p");
  credits.className = "gallery-series-credits";
  credits.textContent = [
    directors.length ? `导演 ${directors.join(" / ")}` : "",
    actors.length ? `主演 ${actors.join(" / ")}` : ""
  ].filter(Boolean).join(" · ");
  text.append(eyebrow, title, stats);
  if (credits.textContent) text.append(credits);

  const fullPeople = [
    metadata?.directors?.length ? `导演：${metadata.directors.join(" / ")}` : "",
    metadata?.writers?.length ? `编剧：${metadata.writers.join(" / ")}` : "",
    metadata?.actors?.length ? `主演：${metadata.actors.join(" / ")}` : "",
    metadata?.imdbId ? `IMDb：${metadata.imdbId}` : ""
  ].filter(Boolean).join(" · ");
  if (metadata?.summary || fullPeople) {
    const details = document.createElement("details");
    details.className = "gallery-series-more";
    const summaryToggle = document.createElement("summary");
    summaryToggle.textContent = "剧情与演职员";
    if (metadata?.summary) {
      const synopsis = document.createElement("p");
      synopsis.textContent = metadata.summary;
      details.append(summaryToggle, synopsis);
    } else {
      details.append(summaryToggle);
    }
    if (fullPeople) {
      const fullCredits = document.createElement("p");
      fullCredits.textContent = fullPeople;
      details.append(fullCredits);
    }
    text.append(details);
  }

  const actions = document.createElement("div");
  actions.className = "gallery-person-bar-actions gallery-series-actions";
  const allButton = document.createElement("button");
  allButton.type = "button";
  allButton.className = "text-button";
  allButton.textContent = state.gallery.mode === "media" ? "返回影视库" : "返回电视剧";
  allButton.addEventListener("click", () => {
    state.gallery.person = "all";
    state.gallery.seriesKey = "";
    state.gallery.visibleLimit = 80;
    renderGalleryView();
    syncGalleryRoute("replace");
  });
  actions.append(allButton);
  bar.append(text, actions);
  container.append(bar);
}

function renderTvSeriesShelf(container) {
  const groups = tvSeriesGroups();
  const visible = groups.slice(0, state.gallery.visibleLimit);
  const total = Number(currentImageLibraryList()?.total ?? groups.length);
  const grid = document.createElement("div");
  grid.className = "gallery-grid media-grid gallery-tv-series-grid";
  for (const group of visible) {
    const card = createGalleryCard(
      { title: tvSeriesDisplayTitle(group.title, group.tvSeries), coverUrl: group.coverUrl || "" },
      {
        meta: [
          group.category,
          group.tvSeries?.episodeCount ? `${formatNumber(group.tvSeries.episodeCount)} 集` : `${formatNumber(group.count)} 集`,
          group.tvSeries?.pubdate ? `首播 ${group.tvSeries.pubdate}` : ""
        ].filter(Boolean).join(" · "),
        extra: [
          tvSeriesRatingText(group.tvSeries),
          formatBytes(group.size),
          group.updatedAt ? `最近 ${formatDateTime(group.updatedAt)}` : group.samples.join(" / ")
        ].filter(Boolean).join(" · "),
        badges: group.tvSeries?.rating ? [`豆瓣 ${Number(group.tvSeries.rating).toFixed(1)}`] : [],
        placeholder: "待补海报",
        onOpen: () => {
          state.gallery.category = group.category || state.gallery.category;
          state.gallery.person = group.title || "all";
          state.gallery.seriesKey = group.value || "";
          state.gallery.visibleLimit = 80;
          renderGalleryView();
          window.scrollTo({ top: 0, behavior: "smooth" });
          syncGalleryRoute();
        }
      }
    );
    card.classList.add("gallery-tv-series-card");
    grid.append(card);
  }
  container.append(grid);
  activateGalleryLazyImages(grid);

  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.gallery.data ? "没有匹配的电视剧作品" : "正在等待图像资料库索引";
    container.append(empty);
  } else if (visible.length < total) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "text-button gallery-more";
    more.textContent = `显示更多作品 ${formatNumber(visible.length)} / ${formatNumber(total)}`;
    more.addEventListener("click", () => {
      state.gallery.visibleLimit += 80;
      renderGalleryView({ preserveScroll: true });
      if (getGalleryPage().imageLibraryListNeedsLoad?.() && !getGalleryPage().isImageLibraryListLoading?.()) {
        void getGalleryPage().loadImageLibraryItems?.({ renderStart: false });
      }
    });
    setupGalleryMoreAutoload(more);
    container.append(more);
  }
}

function renderWesternPersonBar(container, total) {
  if (state.gallery.mode !== "western" || state.gallery.person === "all") return;
  const items = filteredMediaItems();
  const size = items.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const categoryText = localGalleryFacets(items, "category").slice(0, 4).map((item) => `${item.value} ${formatNumber(item.count)}`).join(" · ");
  const latestAt = items.reduce((latest, item) => {
    const itemTime = new Date(item.updatedAt || 0).getTime();
    const latestTime = new Date(latest || 0).getTime();
    return itemTime > latestTime ? item.updatedAt : latest;
  }, "");

  const bar = document.createElement("div");
  bar.className = "gallery-person-bar";

  const text = document.createElement("div");
  text.className = "gallery-person-bar-text";
  const title = document.createElement("strong");
  title.textContent = photoPersonDisplayName(state.gallery.person);
  const meta = document.createElement("span");
  meta.textContent = [
    `${formatNumber(total)} 部视频`,
    formatBytes(size),
    latestAt ? `最近 ${formatDateTime(latestAt)}` : ""
  ].filter(Boolean).join(" · ");
  text.append(title, meta);
  if (categoryText) {
    const summary = document.createElement("small");
    summary.className = "gallery-tv-summary";
    summary.textContent = categoryText;
    text.append(summary);
  }

  const actions = document.createElement("div");
  actions.className = "gallery-person-bar-actions";
  const allButton = document.createElement("button");
  allButton.type = "button";
  allButton.className = "text-button";
  allButton.textContent = "全部人物";
  allButton.addEventListener("click", () => {
    state.gallery.person = "all";
    state.gallery.visibleLimit = 80;
    renderGalleryView();
    syncGalleryRoute("replace");
  });
  actions.append(allButton);
  bar.append(text, actions);
  container.append(bar);
}

function renderWesternPersonShelf(container) {
  const groups = westernPersonGroups();
  const visible = groups.slice(0, state.gallery.visibleLimit);
  const total = Number(currentImageLibraryList()?.total ?? groups.length);
  const grid = document.createElement("div");
  grid.className = "gallery-grid media-grid gallery-western-person-grid";
  for (const group of visible) {
    const categories = [...group.categories.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: "base" }))
      .slice(0, 3)
      .map(([category, count]) => `${category} ${formatNumber(count)}`)
      .join(" · ");
    const card = createGalleryCard(
      { title: photoPersonDisplayName(group.personName), coverUrl: group.coverUrl || "" },
      {
        meta: `${formatNumber(group.count)} 部 · ${formatBytes(group.size)}`,
        extra: [categories, group.updatedAt ? `最近 ${formatDateTime(group.updatedAt)}` : group.samples.join(" / ")].filter(Boolean).join(" · "),
        badges: group.playableCount && group.playableCount !== group.count ? [`可播 ${formatNumber(group.playableCount)}`] : [],
        placeholder: "人物",
        onOpen: () => {
          state.gallery.person = group.personName;
          state.gallery.visibleLimit = 80;
          renderGalleryView();
          window.scrollTo({ top: 0, behavior: "smooth" });
          syncGalleryRoute();
        }
      }
    );
    card.classList.add("gallery-western-person-card");
    grid.append(card);
  }
  container.append(grid);
  activateGalleryLazyImages(grid);

  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.gallery.data ? "没有匹配的欧美人物" : "正在等待图像资料库索引";
    container.append(empty);
  } else if (visible.length < total) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "text-button gallery-more";
    more.textContent = `显示更多人物 ${formatNumber(visible.length)} / ${formatNumber(total)}`;
    more.addEventListener("click", () => {
      state.gallery.visibleLimit += 80;
      renderGalleryView({ preserveScroll: true });
      if (getGalleryPage().imageLibraryListNeedsLoad?.() && !getGalleryPage().isImageLibraryListLoading?.()) {
        void getGalleryPage().loadImageLibraryItems?.({ renderStart: false });
      }
    });
    setupGalleryMoreAutoload(more);
    container.append(more);
  }
}

function activateGalleryLazyImages(root) {
  if (galleryCoverObserver) {
    galleryCoverObserver.disconnect();
    galleryCoverObserver = null;
  }
  const images = [...root.querySelectorAll("img[data-gallery-src]")];
  if (!images.length) return;
  if (!("IntersectionObserver" in window)) {
    for (const image of images) {
      image.src = image.dataset.gallerySrc;
      delete image.dataset.gallerySrc;
    }
    return;
  }
  galleryCoverObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const image = entry.target;
        image.src = image.dataset.gallerySrc;
        delete image.dataset.gallerySrc;
        galleryCoverObserver.unobserve(image);
      }
    },
    { rootMargin: "600px 0px" }
  );
  for (const image of images) galleryCoverObserver.observe(image);
}

function setupGalleryMoreAutoload(button) {
  if (!button) return;
  if (galleryMoreScrollCleanup) {
    galleryMoreScrollCleanup();
    galleryMoreScrollCleanup = null;
  }

  let scheduled = false;
  let userScrollIntentUntil = 0;
  let lastScrollY = window.scrollY;
  let touchScrolling = false;

  const scheduleGestureRelease = () => {
    window.clearTimeout(galleryMoreGestureReleaseTimer);
    galleryMoreGestureReleaseTimer = window.setTimeout(() => {
      galleryMoreGestureConsumed = false;
      galleryMoreGestureReleaseTimer = 0;
    }, GALLERY_MORE_GESTURE_IDLE_MS);
  };

  const run = () => {
    if (!button.isConnected || button.disabled || button.dataset.autoloading === "1") return;
    galleryMoreGestureConsumed = true;
    scheduleGestureRelease();
    button.dataset.autoloading = "1";
    button.click();
  };
  const check = () => {
    scheduled = false;
    if (!button.isConnected) {
      cleanup();
      if (galleryMoreScrollCleanup === cleanup) galleryMoreScrollCleanup = null;
      return;
    }
    if (Date.now() > userScrollIntentUntil) return;
    if (touchScrolling) return;
    const rect = button.getBoundingClientRect();
    if (rect.top > window.innerHeight + GALLERY_MORE_AUTO_LOAD_DISTANCE || rect.bottom < -GALLERY_MORE_AUTO_LOAD_DISTANCE) return;
    userScrollIntentUntil = 0;
    run();
  };
  const scheduleCheck = () => {
    if (scheduled) return;
    scheduled = true;
    window.requestAnimationFrame(check);
  };
  const markUserScrollIntent = (event) => {
    if (event.type === "wheel" && Number(event.deltaY || 0) <= 0) return;
    if (event.type === "keydown" && !["ArrowDown", "End", "PageDown", " "].includes(event.key)) return;
    if (event.type === "pointerdown" && Number(event.clientX || 0) < document.documentElement.clientWidth - 20) return;
    if (galleryMoreGestureConsumed) {
      scheduleGestureRelease();
      return;
    }
    userScrollIntentUntil = Date.now() + GALLERY_MORE_SCROLL_INTENT_MS;
  };
  const handleTouchStart = () => {
    touchScrolling = true;
  };
  const handleTouchEnd = () => {
    touchScrolling = false;
    if (Date.now() <= userScrollIntentUntil) window.setTimeout(scheduleCheck, 80);
  };
  const handleScroll = () => {
    const nextScrollY = window.scrollY;
    const movedDown = nextScrollY > lastScrollY + 1;
    lastScrollY = nextScrollY;
    if (!movedDown || Date.now() > userScrollIntentUntil) return;
    scheduleCheck();
  };

  window.addEventListener("wheel", markUserScrollIntent, { passive: true });
  window.addEventListener("touchstart", handleTouchStart, { passive: true });
  window.addEventListener("touchmove", markUserScrollIntent, { passive: true });
  window.addEventListener("touchend", handleTouchEnd, { passive: true });
  window.addEventListener("touchcancel", handleTouchEnd, { passive: true });
  window.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
  window.addEventListener("keydown", markUserScrollIntent);
  window.addEventListener("scroll", handleScroll, { passive: true });
  const cleanup = () => {
    window.removeEventListener("wheel", markUserScrollIntent);
    window.removeEventListener("touchstart", handleTouchStart);
    window.removeEventListener("touchmove", markUserScrollIntent);
    window.removeEventListener("touchend", handleTouchEnd);
    window.removeEventListener("touchcancel", handleTouchEnd);
    window.removeEventListener("pointerdown", markUserScrollIntent);
    window.removeEventListener("keydown", markUserScrollIntent);
    window.removeEventListener("scroll", handleScroll);
  };
  galleryMoreScrollCleanup = cleanup;
}

function activateGalleryReaderImages(root) {
  if (galleryReaderObserver) {
    galleryReaderObserver.disconnect();
    galleryReaderObserver = null;
  }
  if (galleryReaderScrollCleanup) {
    galleryReaderScrollCleanup();
    galleryReaderScrollCleanup = null;
  }
  const figures = [...root.querySelectorAll(".gallery-reader-figure[data-gallery-src]")];
  if (!figures.length) return;
  galleryReaderStartupFigure = figures[0];

  let progressTicking = false;
  const reportProgress = () => {
    progressTicking = false;
    const readingLine = Math.max(1, window.innerHeight * 0.46);
    const current = figures.find((figure) => figure.getBoundingClientRect().bottom >= readingLine) || figures.at(-1);
    const currentIndex = Math.max(1, Number(current?.dataset.imageIndex || 1));
    const totalCount = Math.max(currentIndex, Number(root.dataset.totalCount || figures.length));
    const toolbar = root.parentElement?.querySelector(".gallery-reader-toolbar");
    const progress = toolbar?.querySelector(".gallery-reader-progress");
    if (!toolbar || !progress) return;
    progress.dataset.currentIndex = String(currentIndex);
    progress.textContent = `${formatNumber(currentIndex)} / ${formatNumber(totalCount)}`;
    toolbar.style.setProperty("--reader-progress", `${Math.min(100, currentIndex / Math.max(1, totalCount) * 100)}%`);
  };
  const requestProgress = () => {
    if (progressTicking) return;
    progressTicking = true;
    window.requestAnimationFrame(reportProgress);
  };
  window.addEventListener("scroll", requestProgress, { passive: true });
  window.addEventListener("resize", requestProgress);
  galleryReaderScrollCleanup = () => {
    window.removeEventListener("scroll", requestProgress);
    window.removeEventListener("resize", requestProgress);
  };
  reportProgress();

  for (const figure of figures.slice(0, GALLERY_READER_EAGER_IMAGES)) enqueueGalleryReaderFigure(figure);

  if ("IntersectionObserver" in window) {
    galleryReaderObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) enqueueGalleryReaderFigure(entry.target);
          else releaseGalleryReaderFigure(entry.target);
        }
      },
      { root: null, rootMargin: GALLERY_READER_ROOT_MARGIN, threshold: 0 }
    );
    for (const figure of figures) galleryReaderObserver.observe(figure);
    return;
  }

  let ticking = false;
  const loadNearViewport = () => {
    ticking = false;
    const lower = window.innerHeight + 420;
    const upper = -420;
    for (const figure of figures) {
      if (!figure.dataset.gallerySrc) continue;
      const rect = figure.getBoundingClientRect();
      if (rect.top <= lower && rect.bottom >= upper) enqueueGalleryReaderFigure(figure);
      else releaseGalleryReaderFigure(figure);
    }
  };
  const requestCheck = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(loadNearViewport);
  };
  window.addEventListener("scroll", requestCheck, { passive: true });
  window.addEventListener("resize", requestCheck);
  const cleanupProgress = galleryReaderScrollCleanup;
  galleryReaderScrollCleanup = () => {
    window.removeEventListener("scroll", requestCheck);
    window.removeEventListener("resize", requestCheck);
    cleanupProgress?.();
  };
  loadNearViewport();
}

function enqueueGalleryReaderFigure(figure) {
  if (!figure?.isConnected || !figure.dataset.gallerySrc || figure.classList.contains("loaded") || figure.dataset.galleryQueued === "1" || figure.dataset.galleryLoading === "1") return;
  figure.dataset.galleryQueued = "1";
  galleryReaderImageQueue.push({ figure, generation: galleryReaderImageGeneration });
  drainGalleryReaderImageQueue();
}

function drainGalleryReaderImageQueue() {
  const concurrency = galleryReaderStartupFigure ? 1 : GALLERY_READER_IMAGE_CONCURRENCY;
  while (activeGalleryReaderImageLoads < concurrency && galleryReaderImageQueue.length) {
    const item = galleryReaderImageQueue.shift();
    const { figure, generation } = item;
    if (generation !== galleryReaderImageGeneration || !figure?.isConnected || !figure.dataset.gallerySrc) continue;
    const img = figure.querySelector("img");
    if (!img || img.hasAttribute("src")) {
      delete figure.dataset.galleryQueued;
      continue;
    }

    activeGalleryReaderImageLoads += 1;
    delete figure.dataset.galleryQueued;
    figure.dataset.galleryLoading = "1";
    figure.classList.remove("failed");
    const retry = figure.querySelector(".gallery-reader-retry");
    if (retry) retry.hidden = true;
    const imageUrl = figure.dataset.gallerySrc;

    const settle = (loaded) => {
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
      if (generation !== galleryReaderImageGeneration) return;
      activeGalleryReaderImageLoads = Math.max(0, activeGalleryReaderImageLoads - 1);
      if (galleryReaderStartupFigure === figure) galleryReaderStartupFigure = null;
      delete figure.dataset.galleryLoading;
      if (loaded) {
        figure.classList.add("loaded");
        figure.classList.remove("failed");
        if (figure.dataset.galleryPreview === "1") {
          delete figure.dataset.galleryPreview;
          figure.style.removeProperty("background-image");
          figure.style.removeProperty("background-position");
          figure.style.removeProperty("background-repeat");
          figure.style.removeProperty("background-size");
        }
        if (figure.dataset.galleryAriaLabel) figure.setAttribute("aria-label", figure.dataset.galleryAriaLabel);
        if (!galleryReaderFigureNearViewport(figure)) releaseGalleryReaderFigure(figure);
      } else {
        img.removeAttribute("src");
        figure.classList.add("failed");
        figure.classList.remove("loaded");
        figure.setAttribute("aria-label", `第 ${figure.dataset.imageIndex || "?"} 张加载失败，点按重试`);
        if (retry) retry.hidden = false;
      }
      drainGalleryReaderImageQueue();
    };
    const onLoad = () => settle(true);
    const onError = () => settle(false);
    img.addEventListener("load", onLoad);
    img.addEventListener("error", onError);
    img.src = imageUrl;
  }
}

function galleryReaderFigureNearViewport(figure) {
  const rect = figure?.getBoundingClientRect?.();
  if (!rect) return false;
  return rect.bottom >= -GALLERY_READER_PRELOAD_ABOVE && rect.top <= window.innerHeight + GALLERY_READER_PRELOAD_BELOW;
}

function releaseGalleryReaderFigure(figure) {
  if (!figure?.classList?.contains("loaded") || figure.dataset.galleryLoading === "1" || figure.dataset.galleryQueued === "1") return;
  const img = figure.querySelector("img");
  if (!img?.hasAttribute("src")) return;
  img.removeAttribute("src");
  figure.classList.remove("loaded");
}

function createGalleryCard(item, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gallery-card";
  button.addEventListener("click", options.onOpen);

  const cover = document.createElement("div");
  cover.className = "gallery-card-cover";
  cover.dataset.placeholder = options.placeholder || "封面";
  if (item.coverUrl) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.dataset.gallerySrc = item.coverUrl;
    img.addEventListener("error", () => {
      img.remove();
      cover.classList.add("empty");
    });
    cover.append(img);
  } else {
    cover.classList.add("empty");
  }
  if (Array.isArray(options.badges) && options.badges.length) {
    const badges = document.createElement("div");
    badges.className = "gallery-card-badges";
    for (const label of options.badges.slice(0, 2)) {
      const badge = document.createElement("span");
      badge.textContent = label;
      badges.append(badge);
    }
    cover.append(badges);
  }

  const body = document.createElement("div");
  body.className = "gallery-card-body";
  const title = document.createElement("strong");
  title.textContent = item.title || "未命名";
  const meta = document.createElement("span");
  meta.textContent = options.meta || "";
  body.append(title);
  if (options.meta) body.append(meta);
  if (options.extra) {
    const extra = document.createElement("small");
    extra.textContent = options.extra;
    body.append(extra);
  }
  button.append(cover, body);
  return button;
}

function renderPagedImageLibrary(container) {
  const page = getGalleryPage();
  const list = currentImageLibraryList();
  if (!state.gallery.data) {
    renderPagedImageLibraryMessage(container, "正在读取图库概览");
    return;
  }
  if (!list) {
    const key = page.imageLibraryListKey?.() || "";
    const currentError = state.gallery.listErrorKey === key ? state.gallery.listError : "";
    if (currentError) {
      renderPagedImageLibraryMessage(container, currentError, {
        action: "重试",
        onAction: () => page.loadImageLibraryItems?.({ force: true })
      });
      return;
    }
    renderPagedImageLibraryMessage(container, state.gallery.mode === "manga" ? "正在读取韩漫" : "正在读取套图");
    if (page.imageLibraryListNeedsLoad?.() && !page.isImageLibraryListLoading?.()) {
      void page.loadImageLibraryItems?.({ renderStart: false });
    }
    return;
  }

  if (state.gallery.mode === "manga") {
    renderPagedImageLibrarySearchSummary(container, list);
    renderPagedMangaShelf(container, list);
  } else if (state.gallery.photoCollection) {
    renderPagedImageLibrarySearchSummary(container, list);
    renderPagedPhotoCollectionPage(container, list);
  } else if (state.gallery.photoView === "collections") {
    renderPagedImageLibrarySearchSummary(container, list);
    renderPagedPhotoCollectionsShelf(container, list);
  } else {
    renderPagedImageLibrarySearchSummary(container, list);
    renderPagedPhotoShelf(container, list);
  }
}

function renderPagedImageLibrarySearchSummary(container, list = {}) {
  const query = String(list.query || "").trim();
  if (!query) return;
  const terms = Array.isArray(list.searchTerms) ? list.searchTerms.filter(Boolean) : [];
  const row = document.createElement("div");
  row.className = "gallery-search-summary";

  const copy = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = `“${query}”`;
  const detail = document.createElement("span");
  detail.textContent = [
    `${formatNumber(list.total || 0)} 个匹配`,
    terms.length > 1 ? `同时包含 ${terms.join(" + ")}` : "",
    list.sort === "relevance" ? "按相关性排序" : ""
  ].filter(Boolean).join(" · ");
  copy.append(strong, detail);

  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "text-button";
  clear.textContent = "清除搜索";
  clear.addEventListener("click", () => submitGallerySearch("", { restoreFocus: true }));
  row.append(copy, clear);
  container.append(row);
}

function gallerySearchMatchText(item = {}) {
  const labels = {
    title: "标题",
    person: "人物",
    collection: "合集",
    category: "分类",
    folder: "文件夹",
    metadata: "资料"
  };
  const fields = (Array.isArray(item.matchFields) ? item.matchFields : []).map((field) => labels[field]).filter(Boolean);
  return fields.length ? `匹配 ${fields.slice(0, 3).join(" / ")}` : "";
}

function renderPagedImageLibraryMessage(container, message, options = {}) {
  const empty = document.createElement("div");
  empty.className = "empty-state gallery-list-state";
  const text = document.createElement("span");
  text.textContent = message;
  empty.append(text);
  if (options.action && typeof options.onAction === "function") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.textContent = options.action;
    button.addEventListener("click", options.onAction);
    empty.append(button);
  }
  container.append(empty);
}

function renderPagedPhotoCollectionsShelf(container, list) {
  const items = photoCatalogCollections(list.items, state.gallery.sort || "updated");
  const visibleLimit = Math.max(1, Number(state.gallery.visibleLimit || 80));
  const visibleItems = items.slice(0, visibleLimit);
  const grid = document.createElement("div");
  grid.className = "gallery-grid gallery-collections-grid gallery-photo-catalog-grid";

  for (const [index, collection] of visibleItems.entries()) {
    const count = Number(collection.albumCount || 0);
    const card = createGalleryCard(
      { title: collection.title, coverUrl: collection.coverUrl || "" },
      {
        badges: count ? [`${formatNumber(count)} 期`] : [],
        meta: [count ? `${formatNumber(count)} 期` : "", formatBytes(collection.size)].filter(Boolean).join(" · "),
        placeholder: photoCategoryDisplayName(collection.catalogCategory) || "合集",
        onOpen: () => {
          state.gallery.photoView = "collections";
          state.gallery.photoCollection = collection.collectionId || collection.id;
          state.gallery.person = "all";
          state.gallery.photoDate = "all";
          state.gallery.visibleLimit = 80;
          renderGalleryView();
          window.scrollTo({ top: 0, behavior: "smooth" });
          syncGalleryRoute();
        }
      }
    );
    card.classList.add("gallery-collection-card", "gallery-photo-catalog-card");
    card.title = [collection.title, count ? `${formatNumber(count)} 期` : "", formatBytes(collection.size)].filter(Boolean).join(" · ");
    activateEagerGalleryCardImage(card, index);
    grid.append(card);
  }

  container.append(grid);
  activateGalleryLazyImages(grid);
  if (!items.length) renderPagedImageLibraryMessage(container, "没有匹配的小分类");
  appendPhotoCatalogMore(container, visibleItems.length, items.length);
}

function appendPhotoCatalogMore(container, shown, total) {
  if (shown >= total) return;
  const more = document.createElement("button");
  more.type = "button";
  more.className = "text-button gallery-more";
  more.textContent = `显示更多小分类 ${formatNumber(shown)} / ${formatNumber(total)}`;
  more.addEventListener("click", () => {
    state.gallery.visibleLimit = Math.min(total, Math.max(shown, Number(state.gallery.visibleLimit || 80)) + 80);
    renderGalleryResults({ preserveScroll: true });
  });
  container.append(more);
  setupGalleryMoreAutoload(more);
}

function renderPagedPhotoShelf(container, list) {
  const items = Array.isArray(list.items) ? list.items : [];
  renderPhotoPersonBar(container, Number(list.total || items.length));
  const grid = renderPagedPhotoCards(items);
  grid.classList.add("gallery-photo-catalog-grid", "gallery-photo-albums-grid");
  container.append(grid);
  activateGalleryLazyImages(grid);
  if (!items.length) renderPagedImageLibraryMessage(container, "没有匹配的套图");
  appendPagedGalleryMore(container, list, "套图");
}

function renderPagedPhotoCollectionPage(container, list) {
  const items = Array.isArray(list.items) ? list.items : [];
  const summary = list.collectionSummary || {};
  const page = document.createElement("section");
  page.className = "gallery-collection-page";

  const breadcrumb = document.createElement("nav");
  breadcrumb.className = "gallery-collection-breadcrumb";
  breadcrumb.setAttribute("aria-label", "图库层级");
  const libraryCrumb = document.createElement("button");
  libraryCrumb.type = "button";
  libraryCrumb.className = "text-button";
  libraryCrumb.textContent = "图库";
  libraryCrumb.addEventListener("click", () => leavePhotoCollection("collections"));
  const largeCrumb = document.createElement("span");
  largeCrumb.textContent = summary.largeCategoryTitle || [summary.rootLabel, summary.category].filter(Boolean).join(" / ") || "大类";
  const smallCrumb = document.createElement("strong");
  smallCrumb.textContent = summary.title || "小分类";
  breadcrumb.append(libraryCrumb, largeCrumb, smallCrumb);
  page.append(breadcrumb);

  const bar = document.createElement("div");
  bar.className = "gallery-collection-hero";
  const text = document.createElement("div");
  text.className = "gallery-collection-hero-copy";
  const eyebrow = document.createElement("span");
  eyebrow.className = "gallery-category-eyebrow";
  eyebrow.textContent = "小分类";
  const title = document.createElement("strong");
  title.textContent = summary.title || "套图合集";
  const meta = document.createElement("span");
  meta.textContent = [
    `${formatNumber(summary.count || list.total || 0)} 期`,
    summary.size ? formatBytes(summary.size) : "",
    summary.imageCount ? `${formatNumber(summary.imageCount)} 张` : ""
  ].filter(Boolean).join(" · ");
  text.append(eyebrow, title, meta);

  const actions = document.createElement("div");
  actions.className = "gallery-person-bar-actions";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "text-button";
  back.textContent = "返回大类";
  back.addEventListener("click", () => leavePhotoCollection("collections"));
  const all = document.createElement("button");
  all.type = "button";
  all.className = "text-button";
  all.textContent = "全部套图";
  all.addEventListener("click", () => leavePhotoCollection("albums"));
  actions.append(back, all);
  bar.append(text, actions);
  page.append(bar);

  const filters = document.createElement("div");
  filters.className = "gallery-collection-filters";
  const filterCopy = document.createElement("div");
  filterCopy.className = "gallery-collection-filter-copy";
  const dateFacets = Array.isArray(list.facets?.dates) ? list.facets.dates : [];
  const peopleFacets = Array.isArray(list.facets?.people) ? list.facets.people : [];
  const filterCount = Number(Boolean(dateFacets.length)) + Number(Boolean(peopleFacets.length));
  filters.classList.toggle("is-single-filter", filterCount === 1);
  const filterTitle = document.createElement("strong");
  filterTitle.textContent = dateFacets.length && peopleFacets.length
    ? "按日期和人物浏览"
    : dateFacets.length
      ? "按日期浏览"
      : "按人物浏览";
  const filterMeta = document.createElement("span");
  filterMeta.textContent = `${formatNumber(list.total || 0)} 期符合当前条件`;
  filterCopy.append(filterTitle, filterMeta);
  filters.append(filterCopy);
  if (dateFacets.length) {
    filters.append(createPhotoCollectionFilter("日期", "全部日期", dateFacets, state.gallery.photoDate, (value) => {
      state.gallery.photoDate = value;
      refreshPhotoCollectionFilters();
    }));
  }
  if (peopleFacets.length) {
    filters.append(createPhotoCollectionFilter("人物", "全部人物", peopleFacets, state.gallery.person, (value) => {
      state.gallery.person = value;
      refreshPhotoCollectionFilters();
    }));
  }
  if (filterCount) page.append(filters);

  const grid = renderPagedPhotoCards(items, { collection: true });
  grid.classList.add("gallery-photo-catalog-grid", "gallery-photo-albums-grid");
  page.append(grid);
  activateGalleryLazyImages(grid);
  if (!items.length) renderPagedImageLibraryMessage(page, "当前合集没有匹配的套图");
  appendPagedGalleryMore(page, list, "套图");
  container.append(page);
}

function leavePhotoCollection(photoView) {
  state.gallery.photoCollection = null;
  state.gallery.photoView = photoView;
  if (photoView === "collections") state.gallery.sort = "count";
  state.gallery.person = "all";
  state.gallery.photoDate = "all";
  if (photoView === "albums") state.gallery.subCategory = "all";
  state.gallery.visibleLimit = 80;
  renderGalleryView();
  syncGalleryRoute("replace");
}

function refreshPhotoCollectionFilters() {
  state.gallery.visibleLimit = 80;
  renderGalleryView();
  syncGalleryRoute("replace");
}

function createPhotoCollectionFilter(label, emptyLabel, values = [], currentValue = "all", onChange) {
  const wrapper = document.createElement("label");
  wrapper.className = "gallery-collection-filter";
  const text = document.createElement("span");
  text.textContent = label;
  const select = document.createElement("select");
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = emptyLabel;
  select.append(all);
  for (const item of Array.isArray(values) ? values : []) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = `${item.label || item.value} (${formatNumber(item.count || 0)})`;
    select.append(option);
  }
  select.value = currentValue || "all";
  select.addEventListener("change", () => onChange(select.value));
  wrapper.append(text, select);
  return wrapper;
}

function photoAlbumPersonName(item = {}) {
  const normalize = (value) => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const person = String(item.personName || "").trim();
  const structuralPeople = [item.subCategory, item.collectionTitle, item.albumNumber ? "" : item.albumSubject].map(normalize).filter(Boolean);
  return person && !structuralPeople.includes(normalize(person)) ? person : "";
}

function photoAlbumDisplayTitle(item = {}) {
  const title = String(item.title || "").trim();
  const sequence = title.match(/\b(VOL|N[O0])\.?\s*(\d+)\b/i);
  const albumNumber = String(item.albumNumber || (sequence ? `${/^VOL$/i.test(sequence[1]) ? "VOL." : "NO."}${sequence[2]}` : "")).trim();
  const meaningfulPerson = photoAlbumPersonName(item);
  const fallbackSubject = sequence
    ? title.slice(Number(sequence.index || 0) + sequence[0].length).replace(/\s*\[[^\]]*(?:P|MB|GB)[^\]]*\]\s*$/iu, "").trim()
    : "";
  const subject = String(item.albumSubject || fallbackSubject || meaningfulPerson).trim();
  if (albumNumber) return [albumNumber, subject].filter(Boolean).join(" · ");
  if (subject) return subject;
  return title
    .replace(/^\[[^\]]+\]\s*/u, "")
    .replace(/\s*\[[^\]]*(?:\d+\s*[PV]|(?:MB|GB)\b|\d+(?:\.\d+)?\s*M\b)[^\]]*\]\s*$/iu, "")
    .trim() || title || "未命名";
}

function renderPagedPhotoCards(items, options = {}) {
  const grid = document.createElement("div");
  grid.className = "gallery-grid";
  for (const [index, item] of items.entries()) {
    const collectionView = Boolean(options.collection);
    const collectionPerson = collectionView ? photoAlbumPersonName(item) : "";
    const card = createGalleryCard(collectionView ? { ...item, title: photoAlbumDisplayTitle(item) } : item, {
      badges: Number(item.imageCount || 0) ? [`${formatNumber(item.imageCount)} 张`] : [],
      meta: collectionView ? collectionPerson : [item.category, item.subCategory, item.personName].filter(Boolean).join(" · "),
      extra: [gallerySearchMatchText(item), collectionView ? item.archiveDate : "", formatBytes(item.size), collectionView ? "" : formatDateTime(item.updatedAt)].filter(Boolean).join(" · "),
      placeholder: "套图",
      onOpen: () => openPhotoSet(item.id)
    });
    card.classList.add("gallery-photo-album-card", "gallery-photo-catalog-card");
    activateEagerGalleryCardImage(card, index);
    grid.append(card);
  }
  return grid;
}

function renderPagedMangaShelf(container, list) {
  const items = Array.isArray(list.items) ? list.items : [];
  const grid = document.createElement("div");
  grid.className = "gallery-grid manga-grid";
  for (const [index, item] of items.entries()) {
    const card = createGalleryCard(item, {
      meta: `${item.category || "韩漫"} · ${formatNumber(item.chapterCount || 0)} 话`,
      extra: `${formatNumber(item.imageCount || 0)} 张 · ${formatDateTime(item.updatedAt)}`,
      placeholder: "韩漫",
      onOpen: () => openMangaComic(item.id)
    });
    activateEagerGalleryCardImage(card, index);
    grid.append(card);
  }
  container.append(grid);
  activateGalleryLazyImages(grid);
  if (!items.length) renderPagedImageLibraryMessage(container, "没有匹配的韩漫");
  appendPagedGalleryMore(container, list, "韩漫");
}

function activateEagerGalleryCardImage(card, index) {
  const image = card.querySelector("img[data-gallery-src]");
  if (!image || index >= 18) return;
  image.src = image.dataset.gallerySrc;
  delete image.dataset.gallerySrc;
}

function appendPagedGalleryMore(container, list, label) {
  const shown = Array.isArray(list.items) ? list.items.length : 0;
  const total = Number(list.total || 0);
  if (shown >= total) return;
  const more = document.createElement("button");
  more.type = "button";
  more.className = "text-button gallery-more";
  more.textContent = `显示更多${label} ${formatNumber(shown)} / ${formatNumber(total)}`;
  more.addEventListener("click", () => {
    state.gallery.visibleLimit = Math.min(total, Math.max(shown, Number(state.gallery.visibleLimit || 80)) + 80);
    renderGalleryResults({ preserveScroll: true });
    if (getGalleryPage().imageLibraryListNeedsLoad?.() && !getGalleryPage().isImageLibraryListLoading?.()) {
      void getGalleryPage().loadImageLibraryItems?.({ renderStart: false });
    }
  });
  container.append(more);
  setupGalleryMoreAutoload(more);
}

function renderPhotoPersonBar(container, total) {
  if (state.gallery.person === "all") return;
  const bar = document.createElement("div");
  bar.className = "gallery-person-bar";

  const text = document.createElement("div");
  text.className = "gallery-person-bar-text";
  const title = document.createElement("strong");
  title.textContent = photoPersonDisplayName(state.gallery.person);
  const meta = document.createElement("span");
  meta.textContent = `${formatNumber(total)} 套图`;
  text.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "gallery-person-bar-actions";
  const allButton = document.createElement("button");
  allButton.type = "button";
  allButton.className = "text-button";
  allButton.textContent = "全部套图";
  allButton.addEventListener("click", () => {
    state.gallery.person = "all";
    state.gallery.subCategory = "all";
    state.gallery.visibleLimit = 80;
    renderGalleryView();
    syncGalleryRoute("replace");
  });

  const peopleButton = document.createElement("button");
  peopleButton.type = "button";
  peopleButton.className = "text-button";
  peopleButton.textContent = "合集列表";
  peopleButton.addEventListener("click", () => {
    state.gallery.photoView = "collections";
    state.gallery.sort = "count";
    state.gallery.person = "all";
    state.gallery.subCategory = "all";
    state.gallery.visibleLimit = 80;
    renderGalleryView();
    syncGalleryRoute("replace");
  });
  actions.append(allButton, peopleButton);
  bar.append(text, actions);
  container.append(bar);
}

function createMovieExploreItem(item, index) {
  const metadata = screenMetadata(item);
  const isTvSeriesWork = item.type === "tvSeriesWork";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gallery-movie-list-item";
  button.addEventListener("click", () => {
    if (isTvSeriesWork) {
      state.gallery.mediaKind = item.mediaKind || state.gallery.mediaKind;
      state.gallery.category = item.category || state.gallery.category;
      state.gallery.person = item.seriesName || item.title || "all";
      state.gallery.seriesKey = item.seriesKey || "";
      state.gallery.visibleLimit = 80;
      renderGalleryView();
      window.scrollTo({ top: 0, behavior: "smooth" });
      syncGalleryRoute();
      return;
    }
    if (["movie", "tv", "anime"].includes(item.mediaKind)) {
      openScreenMediaPlayer(item);
    } else {
      openGalleryMedia(item.id);
    }
  });

  const poster = document.createElement("div");
  poster.className = "gallery-movie-list-poster";
  const coverUrl = metadata.coverUrl || item.coverUrl || "";
  if (coverUrl) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = index < 12 ? "eager" : "lazy";
    if (index < 12) img.src = coverUrl;
    else img.dataset.gallerySrc = coverUrl;
    img.addEventListener("error", () => poster.classList.add("empty"));
    poster.append(img);
  } else {
    poster.classList.add("empty");
    poster.dataset.placeholder = isTvSeriesWork ? (item.mediaKind === "anime" ? "动漫" : "电视剧") : "电影";
  }

  const copy = document.createElement("div");
  copy.className = "gallery-movie-list-copy";
  const title = document.createElement("strong");
  title.className = "gallery-movie-list-title";
  title.textContent = movieDisplayTitle(item);

  const meta = document.createElement("span");
  meta.className = "gallery-movie-list-meta";
  meta.textContent = movieListMetaLine(item) || item.category || "";

  const people = document.createElement("span");
  people.className = "gallery-movie-list-people";
  people.textContent = movieListPeopleLine(item);

  const rating = movieListRatingLine(item);
  const ratingRow = document.createElement("span");
  ratingRow.className = "gallery-movie-list-rating";
  if (rating) {
    const stars = document.createElement("i");
    stars.textContent = "★★★★★";
    const score = document.createElement("b");
    score.textContent = rating.score;
    ratingRow.append(stars, score);
    if (rating.count) {
      const count = document.createElement("em");
      count.textContent = rating.count;
      ratingRow.append(count);
    }
  } else {
    ratingRow.textContent = [formatBytes(item.size), item.updatedAt ? `最近 ${formatDateTime(item.updatedAt)}` : ""].filter(Boolean).join(" · ");
  }

  const local = document.createElement("small");
  local.textContent = [
    isTvSeriesWork ? (item.mediaKind === "anime" ? "动漫" : "电视剧") : "电影",
    item.category,
    isTvSeriesWork ? `${formatNumber(item.episodeCount || 0)} 集` : formatBytes(item.size),
    item.updatedAt ? `最近 ${formatDateTime(item.updatedAt)}` : ""
  ].filter(Boolean).join(" · ");

  copy.append(title, meta);
  if (people.textContent) copy.append(people);
  copy.append(ratingRow, local);
  button.append(poster, copy);
  return button;
}

function renderMovieExploreSidebar(aside, items) {
  const listState = currentImageLibraryList();
  const allTotal = state.gallery.mode === "media"
    ? (listState?.facets?.mediaKinds || []).reduce((sum, item) => sum + Number(item.count || 0), 0) || listState?.total || items.length
    : Number(state.gallery.data?.totals?.movies ?? listState?.total ?? items.length);
  const filteredTotal = Number(listState?.total ?? items.length);
  const ratedCount = Number(listState?.stats?.ratedCount ?? items.filter((item) => Number(screenMetadata(item)?.rating || 0) > 0).length);
  const totalSize = Number(listState?.stats?.totalBytes ?? items.reduce((sum, item) => sum + Number(item.size || 0), 0));
  const mediaLabel = state.gallery.mode === "media" ? "影视" : "电影";

  const summary = document.createElement("section");
  summary.className = "gallery-movie-sidebar-section";
  const summaryTitle = document.createElement("h3");
  summaryTitle.textContent = state.gallery.mode === "media" ? "本地影视" : "本地片库";
  const summaryList = document.createElement("div");
  summaryList.className = "gallery-movie-sidebar-stats";
  const hasActiveFilter = Boolean(state.gallery.query || state.gallery.category !== "all" || (state.gallery.mode === "media" && state.gallery.mediaKind !== "all"));
  const rows = [
    ...(hasActiveFilter ? [["当前筛选", `${formatNumber(filteredTotal)} 部`]] : []),
    [`全部${mediaLabel}`, `${formatNumber(allTotal)} 部`],
    ["豆瓣资料", `${formatNumber(ratedCount)} 部`],
    ["总大小", formatBytes(totalSize)]
  ];
  for (const [statLabel, value] of rows) {
    const row = document.createElement("span");
    row.innerHTML = "<strong></strong><small></small>";
    row.querySelector("strong").textContent = value;
    row.querySelector("small").textContent = statLabel;
    summaryList.append(row);
  }
  summary.append(summaryTitle, summaryList);
  aside.append(summary);
}

function renderMovieShelf(container) {
  const items = filteredMediaItems();
  const visible = items.slice(0, state.gallery.visibleLimit);
  const total = Number(currentImageLibraryList()?.total ?? items.length);

  const shell = document.createElement("section");
  shell.className = "gallery-movie-explore";

  const main = document.createElement("div");
  main.className = "gallery-movie-explore-main";
  const header = document.createElement("div");
  header.className = "gallery-movie-explore-header";
  const title = document.createElement("h2");
  title.textContent = state.gallery.mode === "media" ? "选影视作品" : "选电影";
  const meta = document.createElement("span");
  meta.textContent = [
    state.gallery.category !== "all" ? galleryCategoryDisplayName(state.gallery.category) : "全部",
    state.gallery.sort === "rating" ? "豆瓣高分" : "",
    `${formatNumber(total)} 部`
  ].filter(Boolean).join(" / ");
  header.append(title, meta);

  const list = document.createElement("div");
  list.className = "gallery-movie-list";
  for (const [index, item] of visible.entries()) {
    list.append(createMovieExploreItem(item, index));
  }
  main.append(header, list);

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.gallery.data ? `没有匹配的${state.gallery.mode === "media" ? "影视作品" : "电影"}` : "正在等待图像资料库索引";
    main.append(empty);
  } else if (visible.length < total) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "text-button gallery-more";
    more.textContent = `显示更多 ${formatNumber(visible.length)} / ${formatNumber(total)}`;
    more.addEventListener("click", () => {
      state.gallery.visibleLimit += 80;
      renderGalleryView({ preserveScroll: true });
      if (getGalleryPage().imageLibraryListNeedsLoad?.() && !getGalleryPage().isImageLibraryListLoading?.()) {
        void getGalleryPage().loadImageLibraryItems?.({ renderStart: false });
      }
    });
    setupGalleryMoreAutoload(more);
    main.append(more);
  }

  const aside = document.createElement("aside");
  aside.className = "gallery-movie-sidebar";
  renderMovieExploreSidebar(aside, items);
  shell.append(main, aside);
  container.append(shell);
  activateGalleryLazyImages(list);
}

function tvEpisodeNumber(item = {}) {
  const title = String(item.title || "").trim();
  const patterns = [
    /(?:^|\b)S\d{1,2}E(?:P)?\s*(\d{1,3})(?:\b|$)/i,
    /第\s*(\d{1,3})\s*集/,
    /^\s*0*(\d{1,3})(?:\s|[._-]|$)/
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match) return Number.parseInt(match[1], 10);
  }
  return 0;
}

function tvEpisodeQuality(item = {}) {
  const text = [item.title, item.relativePath, item.ext].filter(Boolean).join(" ");
  return text.match(/\b(?:4K|2160P|1080P|720P|HDR10\+?|HDR|DV)\b/i)?.[0]?.toUpperCase() || "";
}

function createTvEpisodeCard(item) {
  const episodeNumber = tvEpisodeNumber(item);
  const quality = tvEpisodeQuality(item);
  const title = episodeNumber ? `第 ${String(episodeNumber).padStart(2, "0")} 集` : item.title || "未命名单集";
  const card = createGalleryCard(
    { ...item, title },
    {
      meta: formatBytes(item.size),
      extra: item.updatedAt ? `更新于 ${formatDateTime(item.updatedAt)}` : "",
      badges: quality ? [quality] : [],
      placeholder: episodeNumber ? `第 ${episodeNumber} 集` : "单集",
      onOpen: () => openScreenMediaPlayer(item)
    }
  );
  card.classList.add("gallery-episode-card");
  card.setAttribute("aria-label", ["播放", title, quality, formatBytes(item.size)].filter(Boolean).join("，"));
  const play = document.createElement("span");
  play.className = "gallery-episode-play";
  play.textContent = "播放";
  card.querySelector(".gallery-card-body")?.append(play);
  return card;
}

function renderMediaShelf(container) {
  const page = getGalleryPage();
  const list = currentImageLibraryList();
  if (!list) {
    const key = page.imageLibraryListKey?.() || "";
    const currentError = state.gallery.listErrorKey === key ? state.gallery.listError : "";
    renderPagedImageLibraryMessage(container, currentError || `正在读取${galleryModeLabel(state.gallery.mode)}`, currentError ? {
      action: "重试",
      onAction: () => page.loadImageLibraryItems?.({ force: true })
    } : {});
    if (!currentError && page.imageLibraryListNeedsLoad?.() && !page.isImageLibraryListLoading?.()) {
      void page.loadImageLibraryItems?.({ renderStart: false });
    }
    return;
  }
  if (state.gallery.mode === "movie" || (state.gallery.mode === "media" && !hasSelectedTvSeries())) {
    renderMovieShelf(container);
    return;
  }
  if (state.gallery.mode === "western" && state.gallery.person === "all") {
    renderWesternPersonShelf(container);
    return;
  }
  if (state.gallery.mode === "tv" && !hasSelectedTvSeries()) {
    renderTvSeriesShelf(container);
    return;
  }
  const items = filteredMediaItems();
  const visible = items.slice(0, state.gallery.visibleLimit);
  const total = Number(list.total ?? items.length);
  const selectedSeries = ["media", "tv"].includes(state.gallery.mode) && hasSelectedTvSeries();
  renderWesternPersonBar(container, items.length);
  renderTvSeriesBar(container, items.length);
  if (selectedSeries) {
    const heading = document.createElement("div");
    heading.className = "gallery-episode-section-head";
    const title = document.createElement("h2");
    title.textContent = "选集播放";
    const meta = document.createElement("span");
    meta.textContent = `${formatNumber(total)} 集 · 点击卡片直接播放`;
    heading.append(title, meta);
    container.append(heading);
  }
  const grid = document.createElement("div");
  grid.className = `gallery-grid media-grid${selectedSeries ? " gallery-episode-grid" : ""}`;
  for (const item of visible) {
    if (selectedSeries) {
      grid.append(createTvEpisodeCard(item));
      continue;
    }
    const doubanMetadata = item.mediaKind === "movie" ? item.movieMetadata : item.tvSeries;
    const cardItem = item.mediaKind === "movie"
      ? { ...item, title: movieDisplayTitle(item), coverUrl: item.movieMetadata?.coverUrl || item.coverUrl }
      : item;
    const meta = item.mediaKind === "movie"
      ? [item.category, item.movieMetadata?.year, ...(item.movieMetadata?.genres || []).slice(0, 2)].filter(Boolean).join(" · ")
      : [item.category, item.subCategory, ["tv", "anime"].includes(item.mediaKind) ? item.seriesName : item.personName].filter(Boolean).join(" · ");
    const extra = [
      tvSeriesRatingText(doubanMetadata),
      formatBytes(item.size),
      item.updatedAt ? `最近 ${formatDateTime(item.updatedAt)}` : ""
    ].filter(Boolean).join(" · ");
    grid.append(
      createGalleryCard(cardItem, {
        meta,
        extra,
        badges: doubanMetadata?.rating ? [`豆瓣 ${Number(doubanMetadata.rating).toFixed(1)}`] : [],
        placeholder: item.kindLabel || galleryModeLabel(state.gallery.mode),
        onOpen: () => ["movie", "tv", "anime"].includes(item.mediaKind) ? openScreenMediaPlayer(item) : openGalleryMedia(item.id)
      })
    );
  }
  container.append(grid);
  activateGalleryLazyImages(grid);

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.gallery.data ? `没有匹配的${galleryModeLabel(state.gallery.mode)}` : "正在等待图像资料库索引";
    container.append(empty);
  } else if (visible.length < total) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "text-button gallery-more";
    more.textContent = `显示更多 ${formatNumber(visible.length)} / ${formatNumber(total)}`;
    more.addEventListener("click", () => {
      state.gallery.visibleLimit += 80;
      renderGalleryView({ preserveScroll: true });
      if (page.imageLibraryListNeedsLoad?.() && !page.isImageLibraryListLoading?.()) {
        void page.loadImageLibraryItems?.({ renderStart: false });
      }
    });
    setupGalleryMoreAutoload(more);
    container.append(more);
  }
}

async function openPhotoSet(albumId, options = {}) {
  await getGalleryPage().openPhotoSet(albumId, options);
}

async function openMangaComic(comicId, options = {}) {
  await getGalleryPage().openMangaComic(comicId, options);
}

async function openMangaChapter(chapterIndex, options = {}) {
  await getGalleryPage().openMangaChapter(chapterIndex, options);
}

async function openGalleryMedia(mediaId, options = {}) {
  await getGalleryPage().openGalleryMedia(mediaId, options);
}

function photoSetDetailPath(albumId, options = {}) {
  const params = new URLSearchParams();
  if (options.imageLimit === "all") {
    params.set("imageLimit", "all");
  } else if (Number.isFinite(Number(options.imageLimit)) && Number(options.imageLimit) > 0) {
    params.set("imageLimit", String(Math.floor(Number(options.imageLimit))));
  }
  if (Number.isFinite(Number(options.imageOffset)) && Number(options.imageOffset) > 0) {
    params.set("imageOffset", String(Math.floor(Number(options.imageOffset))));
  }
  const query = params.toString();
  return `/api/photo-sets/${encodeURIComponent(String(albumId || ""))}${query ? `?${query}` : ""}`;
}

async function loadPhotoReaderImages(limit) {
  const album = state.gallery.album;
  if (!album?.id) return null;
  const currentImages = Array.isArray(album.images) ? album.images : [];
  const totalCount = Math.max(Number(album.imageCount || 0), currentImages.length);
  if (currentImages.length >= totalCount) return album;
  const batchSize = photoReaderBatchSize();
  const requestedTotal = Math.max(currentImages.length + batchSize, Math.floor(Number(limit || 0)) || 0);
  const nextLimit = Math.min(totalCount - currentImages.length, requestedTotal - currentImages.length);
  const scrollAnchor = captureGalleryReaderScrollAnchor();
  setGalleryStatus("正在继续读取图片");
  try {
    const data = await api(photoSetDetailPath(album.id, { imageLimit: nextLimit, imageOffset: currentImages.length }));
    const nextAlbum = data.album || {};
    const images = mergePhotoReaderImages(currentImages, nextAlbum.images || []);
    state.gallery.album = {
      ...album,
      ...nextAlbum,
      images,
      imageOffset: 0,
      imageLimit: images.length,
      imagesTruncated: images.length < Math.max(Number(nextAlbum.imageCount || 0), totalCount),
      ...(album.fullImages ? { fullImages: album.fullImages } : {})
    };
    state.gallery.cache = data.cache || state.gallery.cache;
    renderGalleryView();
    restoreGalleryReaderScrollAnchor(scrollAnchor);
    return state.gallery.album;
  } finally {
    setGalleryStatus("");
  }
}

function mergePhotoReaderImages(existing, incoming) {
  const merged = new Map();
  for (const image of [...(existing || []), ...(incoming || [])]) {
    const key = Number(image?.index || 0) > 0 ? `index:${Number(image.index)}` : `url:${String(image?.url || image?.name || "")}`;
    if (key !== "url:") merged.set(key, image);
  }
  return [...merged.values()].sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
}

function captureGalleryReaderScrollAnchor() {
  const figures = [...els.workGrid.querySelectorAll(".gallery-reader-figure[data-image-index]")];
  const target = figures.find((figure) => figure.getBoundingClientRect().bottom > 0);
  if (!target) return null;
  return {
    index: target.dataset.imageIndex,
    top: target.getBoundingClientRect().top
  };
}

function restoreGalleryReaderScrollAnchor(anchor) {
  if (!anchor?.index) return;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      const target = [...els.workGrid.querySelectorAll(".gallery-reader-figure[data-image-index]")]
        .find((figure) => figure.dataset.imageIndex === String(anchor.index));
      if (!target) return;
      window.scrollBy({ top: target.getBoundingClientRect().top - Number(anchor.top || 0), behavior: "auto" });
    });
  });
}

function photoReaderBatchSize() {
  const mode = String(state.accessMode || "").trim();
  if (mode === "local" || mode === "lan") return PHOTO_READER_BATCH_SIZES[mode];
  if (mode === "remote") return PHOTO_READER_BATCH_SIZES.remote;
  return PHOTO_READER_BATCH_SIZES.fallback;
}

async function fullPhotoReaderImages(album = state.gallery.album) {
  if (!album?.id) return Array.isArray(album?.images) ? album.images : [];
  const images = Array.isArray(album.images) ? album.images : [];
  const total = Number(album.imageCount || images.length || 0);
  if (images.length >= total) return images;
  if (Array.isArray(album.fullImages) && album.fullImages.length >= total) return album.fullImages;

  const data = await api(photoSetDetailPath(album.id, { imageLimit: "all" }));
  const fullImages = Array.isArray(data.album?.images) ? data.album.images : images;
  album.fullImages = fullImages;
  return fullImages;
}

function readerToolbar(title, meta, onBack, options = {}) {
  const bar = document.createElement("div");
  bar.className = "gallery-reader-toolbar";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "text-button gallery-reader-back";
  back.textContent = "返回";
  back.addEventListener("click", () => {
    onBack?.();
    renderGalleryView();
    syncGalleryRoute("replace");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  const copy = document.createElement("div");
  copy.className = "gallery-reader-title";
  const strong = document.createElement("strong");
  strong.textContent = title || "阅读";
  const span = document.createElement("span");
  span.textContent = meta || "";
  copy.append(strong, span);

  const progress = document.createElement("span");
  progress.className = "gallery-reader-progress";
  progress.dataset.currentIndex = "1";
  progress.textContent = options.totalCount ? `1 / ${formatNumber(options.totalCount)}` : "";
  progress.hidden = !options.totalCount;

  const actions = document.createElement("div");
  actions.className = "gallery-reader-actions";
  const setFitWidth = (fitWidth) => {
    if (state.gallery.fitWidth === fitWidth) return;
    const scrollAnchor = captureGalleryReaderScrollAnchor();
    state.gallery.fitWidth = fitWidth;
    writeStoredFlag("fanhao.gallery.fitWidth", state.gallery.fitWidth);
    renderGalleryView();
    restoreGalleryReaderScrollAnchor(scrollAnchor);
  };
  if (options.showFit !== false) {
    const fitGroup = document.createElement("div");
    fitGroup.className = "gallery-reader-fit-group";
    fitGroup.setAttribute("role", "group");
    fitGroup.setAttribute("aria-label", "图片宽度");
    const fit = document.createElement("button");
    fit.type = "button";
    fit.textContent = "适应宽度";
    fit.setAttribute("aria-pressed", String(state.gallery.fitWidth));
    fit.addEventListener("click", () => setFitWidth(true));
    const natural = document.createElement("button");
    natural.type = "button";
    natural.textContent = "原始大小";
    natural.setAttribute("aria-pressed", String(!state.gallery.fitWidth));
    natural.addEventListener("click", () => setFitWidth(false));
    fitGroup.append(fit, natural);
    actions.append(fitGroup);
  }
  if (typeof options.onOpen === "function") {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "gallery-reader-open";
    open.textContent = "单页浏览";
    open.addEventListener("click", () => options.onOpen(Math.max(0, Number(progress.dataset.currentIndex || 1) - 1)));
    actions.append(open);
  }
  bar.append(back, copy, progress, actions);
  return bar;
}

function closeGalleryImagePager() {
  if (!galleryPagerCleanup) return;
  const cleanup = galleryPagerCleanup;
  galleryPagerCleanup = null;
  cleanup();
}

function openGalleryImagePager(images = [], startIndex = 0, title = "", meta = "", options = {}) {
  let list = (images || []).filter((image) => image?.url);
  if (!list.length) return;
  closeGalleryImagePager();

  let currentIndex = Math.min(Math.max(Number(startIndex) || 0, 0), list.length - 1);
  let hideTimer = null;
  let wheelLockedUntil = 0;
  let pointerStart = null;
  let rangeScrubbing = false;
  let zoomLevel = 1;
  const sourceKey = String(options.sourceKey || "");
  const previousOverflow = document.body.style.overflow;
  const abortController = new AbortController();
  const listenerOptions = { signal: abortController.signal };

  const overlay = document.createElement("div");
  overlay.className = "gallery-image-pager";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", title || "图片阅读器");

  const top = document.createElement("div");
  top.className = "gallery-image-pager-top";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "gallery-image-pager-button";
  close.textContent = "返回";
  close.addEventListener("click", closeGalleryImagePager, listenerOptions);
  const heading = document.createElement("div");
  heading.className = "gallery-image-pager-title";
  const strong = document.createElement("strong");
  strong.textContent = title || "图片";
  const sub = document.createElement("span");
  sub.textContent = meta || "";
  heading.append(strong, sub);
  const topActions = document.createElement("div");
  topActions.className = "gallery-image-pager-top-actions";
  const zoomOut = document.createElement("button");
  zoomOut.type = "button";
  zoomOut.className = "gallery-image-pager-button compact";
  zoomOut.textContent = "缩小";
  zoomOut.setAttribute("aria-label", "缩小图片");
  const zoomReset = document.createElement("button");
  zoomReset.type = "button";
  zoomReset.className = "gallery-image-pager-button compact gallery-image-pager-zoom";
  zoomReset.textContent = "100%";
  zoomReset.title = "恢复适应屏幕";
  const zoomIn = document.createElement("button");
  zoomIn.type = "button";
  zoomIn.className = "gallery-image-pager-button compact";
  zoomIn.textContent = "放大";
  zoomIn.setAttribute("aria-label", "放大图片");
  const fullscreen = document.createElement("button");
  fullscreen.type = "button";
  fullscreen.className = "gallery-image-pager-button compact";
  fullscreen.textContent = "全屏";
  topActions.append(zoomOut, zoomReset, zoomIn, fullscreen);
  top.append(close, heading, topActions);

  const stage = document.createElement("div");
  stage.className = "gallery-image-pager-stage";
  stage.tabIndex = 0;
  const imageNode = document.createElement("img");
  imageNode.alt = "";
  stage.append(imageNode);

  const controls = document.createElement("div");
  controls.className = "gallery-image-pager-controls";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "gallery-image-pager-button";
  prev.textContent = "上一张";
  const counter = document.createElement("span");
  counter.className = "gallery-image-pager-counter";
  const range = document.createElement("input");
  range.type = "range";
  range.className = "gallery-image-pager-range";
  range.min = "1";
  range.max = String(list.length);
  range.step = "1";
  range.setAttribute("aria-label", "图片进度");
  const next = document.createElement("button");
  next.type = "button";
  next.className = "gallery-image-pager-button";
  next.textContent = "下一张";
  const controlRow = document.createElement("div");
  controlRow.className = "gallery-image-pager-control-row";
  controlRow.append(prev, counter, range, next);
  const thumbnails = document.createElement("div");
  thumbnails.className = "gallery-image-pager-thumbnails";
  thumbnails.setAttribute("role", "list");
  thumbnails.setAttribute("aria-label", "图片缩略图");
  controls.append(controlRow, thumbnails);
  overlay.append(top, stage, controls);

  const scheduleHide = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => overlay.classList.add("chrome-hidden"), 2500);
  };
  const showChrome = () => {
    overlay.classList.remove("chrome-hidden");
    scheduleHide();
  };
  const preloadNeighbor = (index) => {
    const item = list[index];
    if (!item?.url) return;
    const preload = new Image();
    preload.src = item.url;
  };
  const clampPagerIndex = (index) => Math.min(Math.max(Number(index) || 0, 0), list.length - 1);
  const applyZoom = (nextZoom = zoomLevel, options = {}) => {
    zoomLevel = Math.min(3, Math.max(1, Math.round(Number(nextZoom || 1) * 4) / 4));
    const naturalWidth = Number(imageNode.naturalWidth || 0);
    const naturalHeight = Number(imageNode.naturalHeight || 0);
    const availableWidth = Math.max(1, stage.clientWidth - 24);
    const availableHeight = Math.max(1, stage.clientHeight - 24);
    const fitScale = naturalWidth && naturalHeight
      ? Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight)
      : 1;
    const displayScale = fitScale * zoomLevel;
    if (naturalWidth && naturalHeight) {
      imageNode.style.width = `${Math.max(1, Math.round(naturalWidth * displayScale))}px`;
      imageNode.style.height = `${Math.max(1, Math.round(naturalHeight * displayScale))}px`;
    }
    stage.classList.toggle("zoomed", zoomLevel > 1);
    zoomOut.disabled = zoomLevel <= 1;
    zoomIn.disabled = zoomLevel >= 3;
    zoomReset.textContent = `${Math.round(zoomLevel * 100)}%`;
    if (!options.preserveScroll) stage.scrollTo({ left: 0, top: 0, behavior: "auto" });
    showChrome();
  };
  const renderThumbnails = () => {
    thumbnails.innerHTML = "";
    const windowSize = Math.min(7, list.length);
    const start = Math.max(0, Math.min(currentIndex - 3, list.length - windowSize));
    const end = Math.min(list.length, start + windowSize);
    for (let index = start; index < end; index += 1) {
      const item = list[index];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "gallery-image-pager-thumbnail";
      button.dataset.index = String(index);
      button.setAttribute("role", "listitem");
      button.setAttribute("aria-label", `打开第 ${formatNumber(index + 1)} 张`);
      const thumb = document.createElement("img");
      thumb.alt = "";
      thumb.loading = "lazy";
      thumb.decoding = "async";
      thumb.src = item.url;
      const label = document.createElement("span");
      label.textContent = formatNumber(index + 1);
      button.append(thumb, label);
      button.addEventListener("click", () => goTo(index), listenerOptions);
      thumbnails.append(button);
    }
  };
  const updateThumbnails = () => {
    const buttons = [...thumbnails.querySelectorAll(".gallery-image-pager-thumbnail")];
    for (const button of buttons) {
      const index = Number(button.dataset.index || 0);
      const active = index === currentIndex;
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "true" : "false");
      if (active) button.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  };
  const previewRangeIndex = (index) => {
    const previewIndex = clampPagerIndex(index);
    const item = list[previewIndex] || {};
    counter.textContent = `第 ${formatNumber(previewIndex + 1)} / ${formatNumber(list.length)} 张`;
    range.value = String(previewIndex + 1);
    sub.textContent = [meta, item.name].filter(Boolean).join(" · ");
    showChrome();
  };
  const commitRangeIndex = () => {
    rangeScrubbing = false;
    goTo(Number(range.value) - 1);
  };
  const update = () => {
    const item = list[currentIndex] || {};
    zoomLevel = 1;
    imageNode.src = item.url;
    imageNode.alt = item.name || title || "";
    counter.textContent = `第 ${formatNumber(currentIndex + 1)} / ${formatNumber(list.length)} 张`;
    range.max = String(list.length);
    range.value = String(currentIndex + 1);
    prev.disabled = currentIndex <= 0;
    next.disabled = currentIndex >= list.length - 1;
    sub.textContent = [meta, item.name].filter(Boolean).join(" · ");
    applyZoom(1);
    renderThumbnails();
    updateThumbnails();
    preloadNeighbor(currentIndex - 1);
    preloadNeighbor(currentIndex + 1);
    showChrome();
  };
  const goTo = (index) => {
    const nextIndex = clampPagerIndex(index);
    if (nextIndex === currentIndex) {
      showChrome();
      return;
    }
    currentIndex = nextIndex;
    update();
  };
  const updateImages = (nextImages = [], updateOptions = {}) => {
    if (abortController.signal.aborted) return false;
    if (updateOptions.sourceKey && sourceKey && String(updateOptions.sourceKey) !== sourceKey) return false;
    const nextList = (nextImages || []).filter((image) => image?.url);
    if (!nextList.length) return false;

    const current = list[currentIndex] || {};
    const requestedIndex = Number(updateOptions.index);
    const matchedIndex = current.url ? nextList.findIndex((item) => item.url === current.url) : -1;
    currentIndex = Number.isFinite(requestedIndex) && requestedIndex >= 0
      ? Math.min(nextList.length - 1, requestedIndex)
      : matchedIndex >= 0
        ? matchedIndex
        : Math.min(currentIndex, nextList.length - 1);
    list = nextList;
    renderThumbnails();
    rangeScrubbing = false;
    update();
    return true;
  };

  prev.addEventListener("click", () => goTo(currentIndex - 1), listenerOptions);
  next.addEventListener("click", () => goTo(currentIndex + 1), listenerOptions);
  zoomOut.addEventListener("click", () => applyZoom(zoomLevel - 0.25), listenerOptions);
  zoomReset.addEventListener("click", () => applyZoom(1), listenerOptions);
  zoomIn.addEventListener("click", () => applyZoom(zoomLevel + 0.25), listenerOptions);
  fullscreen.addEventListener("click", async () => {
    if (document.fullscreenElement) await document.exitFullscreen?.();
    else await overlay.requestFullscreen?.();
  }, listenerOptions);
  document.addEventListener("fullscreenchange", () => {
    fullscreen.textContent = document.fullscreenElement ? "退出全屏" : "全屏";
    window.requestAnimationFrame(() => applyZoom(zoomLevel, { preserveScroll: true }));
  }, listenerOptions);
  imageNode.addEventListener("load", () => applyZoom(zoomLevel), listenerOptions);
  range.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    rangeScrubbing = true;
    range.setPointerCapture?.(event.pointerId);
    previewRangeIndex(Number(range.value) - 1);
  }, listenerOptions);
  range.addEventListener("pointerup", (event) => {
    event.stopPropagation();
    range.releasePointerCapture?.(event.pointerId);
    commitRangeIndex();
  }, listenerOptions);
  range.addEventListener("pointercancel", () => {
    rangeScrubbing = false;
    update();
  }, listenerOptions);
  range.addEventListener("input", () => {
    if (rangeScrubbing) previewRangeIndex(Number(range.value) - 1);
    else goTo(Number(range.value) - 1);
  }, listenerOptions);
  range.addEventListener("change", () => {
    commitRangeIndex();
  }, listenerOptions);
  stage.addEventListener("click", showChrome, listenerOptions);
  stage.addEventListener("dblclick", (event) => {
    event.preventDefault();
    applyZoom(zoomLevel > 1 ? 1 : 2);
  }, listenerOptions);
  overlay.addEventListener("pointermove", showChrome, listenerOptions);
  overlay.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".gallery-image-pager-top, .gallery-image-pager-controls")) return;
    pointerStart = { x: event.clientX, y: event.clientY };
    showChrome();
  }, listenerOptions);
  overlay.addEventListener("pointerup", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!pointerStart || target?.closest(".gallery-image-pager-top, .gallery-image-pager-controls")) return;
    const dy = event.clientY - pointerStart.y;
    const dx = event.clientX - pointerStart.x;
    pointerStart = null;
    if (zoomLevel > 1) return;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 52) return;
    if (Math.abs(dx) > Math.abs(dy)) goTo(currentIndex + (dx < 0 ? 1 : -1));
    else goTo(currentIndex + (dy < 0 ? 1 : -1));
  }, listenerOptions);
  overlay.addEventListener("wheel", (event) => {
    if (zoomLevel > 1) return;
    if (Math.abs(event.deltaY) < 18 || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
    event.preventDefault();
    const now = Date.now();
    if (now < wheelLockedUntil) return;
    wheelLockedUntil = now + 360;
    goTo(currentIndex + (event.deltaY > 0 ? 1 : -1));
  }, { signal: abortController.signal, passive: false });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeGalleryImagePager();
    } else if (["ArrowDown", "ArrowRight", "PageDown"].includes(event.key)) {
      event.preventDefault();
      goTo(currentIndex + 1);
    } else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(event.key)) {
      event.preventDefault();
      goTo(currentIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      goTo(0);
    } else if (event.key === "End") {
      event.preventDefault();
      goTo(list.length - 1);
    } else if (["+", "="].includes(event.key)) {
      event.preventDefault();
      applyZoom(zoomLevel + 0.25);
    } else if (event.key === "-") {
      event.preventDefault();
      applyZoom(zoomLevel - 0.25);
    } else if (event.key === "0") {
      event.preventDefault();
      applyZoom(1);
    } else if (event.key.toLowerCase() === "f") {
      event.preventDefault();
      fullscreen.click();
    }
  }, listenerOptions);

  galleryPagerCleanup = () => {
    window.clearTimeout(hideTimer);
    abortController.abort();
    overlay.remove();
    document.body.classList.remove("gallery-image-pager-open");
    document.body.style.overflow = previousOverflow;
  };
  document.body.classList.add("gallery-image-pager-open");
  document.body.style.overflow = "hidden";
  document.body.append(overlay);
  update();
  stage.focus({ preventScroll: true });
  return {
    updateImages,
    close: closeGalleryImagePager,
    sourceKey
  };
}

function renderReaderImages(container, images, options = {}) {
  const list = Array.isArray(images) ? images : [];
  const totalCount = Math.max(Number(options.totalCount || 0), list.length);
  const viewer = document.createElement("div");
  viewer.className = `gallery-reader-images${state.gallery.fitWidth ? " fit-width" : " natural-width"}`;
  viewer.dataset.totalCount = String(totalCount);
  for (const [index, image] of list.entries()) {
    const figure = document.createElement("figure");
    figure.className = "gallery-reader-figure";
    figure.dataset.gallerySrc = image.url;
    figure.dataset.imageIndex = String(image.index || index + 1);
    const previewUrl = index === 0 ? String(options.previewUrl || "").trim() : "";
    if (previewUrl) {
      figure.dataset.galleryPreview = "1";
      figure.style.backgroundImage = `url(${JSON.stringify(previewUrl)})`;
      figure.style.backgroundPosition = "center";
      figure.style.backgroundRepeat = "no-repeat";
      figure.style.backgroundSize = "contain";
    }
    figure.tabIndex = 0;
    figure.setAttribute("role", "button");
    const figureLabel = `打开第 ${formatNumber(image.index || index + 1)} 张`;
    figure.dataset.galleryAriaLabel = figureLabel;
    figure.setAttribute("aria-label", figureLabel);
    const openImage = () => {
      if (figure.classList.contains("failed")) {
        enqueueGalleryReaderFigure(figure);
        return;
      }
      const sourceKey = options.sourceKey || "";
      const fallbackIndex = Math.max(0, Number(image.index || index + 1) - 1);
      const pager = openGalleryImagePager(
        list,
        Math.min(list.length - 1, fallbackIndex),
        options.title || "",
        options.meta || "",
        { sourceKey }
      );
      if (typeof options.fullImages === "function") {
        options.fullImages()
          .then((pagerImages) => {
            const nextIndex = Math.max(0, Number(image.index || index + 1) - 1);
            pager?.updateImages?.(pagerImages, { sourceKey, index: nextIndex });
          })
          .catch(() => {});
      }
    };
    figure.addEventListener("click", openImage);
    figure.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      openImage();
    });
    const img = document.createElement("img");
    img.alt = image.name || "";
    img.loading = "lazy";
    img.decoding = "async";
    if ("fetchPriority" in img) img.fetchPriority = index < GALLERY_READER_EAGER_IMAGES ? "high" : "low";
    const caption = document.createElement("figcaption");
    caption.textContent = `${formatNumber(image.index || index + 1)} / ${formatNumber(totalCount || list.length)}`;
    const retry = document.createElement("span");
    retry.className = "gallery-reader-retry";
    retry.textContent = "加载失败，点按重试";
    retry.hidden = true;
    figure.append(img, caption, retry);
    viewer.append(figure);
  }
  container.append(viewer);
  window.requestAnimationFrame(() => {
    if (viewer.isConnected) activateGalleryReaderImages(viewer);
  });
}

function renderPhotoReader(container) {
  const album = state.gallery.album;
  const images = Array.isArray(album.images) ? album.images : [];
  const totalCount = Number(album.imageCount || images.length || 0);
  const visibleCount = images.length;
  const meta = [
    album.category,
    album.subCategory,
    album.personName,
    visibleCount < totalCount
      ? `已显示 ${formatNumber(visibleCount)} / ${formatNumber(totalCount)} 张`
      : `${formatNumber(totalCount)} 张`
  ].filter(Boolean).join(" · ");
  const sourceKey = album.id ? `photo:${album.id}` : "";
  const openPager = (startIndex = 0) => {
    const pager = openGalleryImagePager(images, startIndex, album.title, meta, { sourceKey });
    fullPhotoReaderImages(album)
      .then((pagerImages) => pager?.updateImages?.(pagerImages, { sourceKey, index: startIndex }))
      .catch(() => {});
  };
  container.append(readerToolbar(album.title, meta, () => {
    state.gallery.album = null;
  }, {
    totalCount,
    onOpen: openPager
  }));
  renderReaderImages(container, images, {
    title: album.title,
    meta,
    totalCount,
    sourceKey,
    previewUrl: album.coverUrl,
    fullImages: () => fullPhotoReaderImages(album)
  });
  if (visibleCount < totalCount) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "text-button gallery-more";
    more.textContent = `向下滑动继续显示 ${formatNumber(visibleCount)} / ${formatNumber(totalCount)}`;
    more.addEventListener("click", async () => {
      more.disabled = true;
      more.textContent = "正在继续读取图片";
      try {
        await loadPhotoReaderImages(visibleCount + photoReaderBatchSize());
      } catch (error) {
        more.disabled = false;
        more.textContent = error.message || "读取失败，点一下重试";
      }
    });
    setupGalleryMoreAutoload(more);
    container.append(more);
  }
}

function renderMangaReader(container) {
  const comic = state.gallery.comic;
  const chapter = state.gallery.chapter;
  const chapters = comic?.chapters || [];
  const currentIndex = chapters.findIndex((item) => item.index === chapter?.index);
  const toolbar = readerToolbar(comic.title, chapter ? `${chapter.title} · ${formatNumber(chapter.imageCount)} 张` : `${formatNumber(chapters.length)} 话`, () => {
    state.gallery.comic = null;
    state.gallery.chapter = null;
  }, { totalCount: Number(chapter?.imageCount || chapter?.images?.length || 0) });
  const chapterSelect = document.createElement("select");
  chapterSelect.className = "gallery-select";
  for (const item of chapters) {
    chapterSelect.append(new Option(`${String(item.index).padStart(3, "0")} · ${item.title}`, item.index));
  }
  chapterSelect.value = String(chapter?.index || "");
  chapterSelect.addEventListener("change", () => openMangaChapter(chapterSelect.value));
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "text-button";
  prev.textContent = "上一话";
  prev.disabled = currentIndex <= 0;
  prev.addEventListener("click", () => openMangaChapter(chapters[currentIndex - 1].index));
  const next = document.createElement("button");
  next.type = "button";
  next.className = "text-button";
  next.textContent = "下一话";
  next.disabled = currentIndex < 0 || currentIndex >= chapters.length - 1;
  next.addEventListener("click", () => openMangaChapter(chapters[currentIndex + 1].index));
  toolbar.append(prev, chapterSelect, next);
  container.append(toolbar);
  if (chapter) renderReaderImages(container, chapter.images || [], { title: comic.title, meta: chapter.title });
}

function createGalleryMediaPlayer(media, metadata = null) {
  const shell = document.createElement("div");
  shell.className = "web-player-shell gallery-media-web-player";

  const video = document.createElement("video");
  video.className = "video-player";
  video.controls = false;
  video.preload = "metadata";
  video.playsInline = true;
  if (media.coverUrl) video.poster = media.coverUrl;
  video.src = media.streamUrl;

  const chrome = document.createElement("div");
  chrome.className = "player-chrome";
  const abortController = new AbortController();
  const listenerOptions = { signal: abortController.signal };
  const top = document.createElement("div");
  top.className = "player-chrome-top";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "player-chrome-button player-chrome-back";
  back.textContent = "返回";
  back.addEventListener("click", () => {
    state.gallery.media = null;
    renderGalleryView();
    syncGalleryRoute("replace");
  }, listenerOptions);
  const title = document.createElement("div");
  title.className = "player-chrome-title";
  const strong = document.createElement("strong");
  strong.textContent = media.mediaKind === "movie" ? movieDisplayTitle(media) : media.title || "播放";
  const sub = document.createElement("span");
  sub.textContent = [media.kindLabel, media.category, ["tv", "anime"].includes(media.mediaKind) ? media.seriesName : media.personName, metadata?.rating ? `豆瓣 ${Number(metadata.rating).toFixed(1)}` : ""].filter(Boolean).join(" · ");
  title.append(strong, sub);
  top.append(back, title);

  const center = document.createElement("button");
  center.type = "button";
  center.className = "player-chrome-center";
  center.setAttribute("aria-label", "播放或暂停");

  const bottom = document.createElement("div");
  bottom.className = "player-chrome-bottom";
  const play = document.createElement("button");
  play.type = "button";
  play.className = "player-chrome-button";
  const time = document.createElement("span");
  time.className = "player-chrome-time";
  const seek = document.createElement("input");
  seek.type = "range";
  seek.className = "player-chrome-seek";
  seek.min = "0";
  seek.step = "1";
  seek.max = "1";
  seek.setAttribute("aria-label", "播放进度");
  const mode = document.createElement("span");
  mode.className = "player-chrome-mode";
  mode.textContent = [media.ext, formatBytes(media.size)].filter(Boolean).join(" · ");
  const mute = document.createElement("button");
  mute.type = "button";
  mute.className = "player-chrome-button";
  const full = document.createElement("button");
  full.type = "button";
  full.className = "player-chrome-button";
  full.textContent = "全屏";
  bottom.append(play, time, seek, mode, mute, full);
  chrome.append(top, center, bottom);

  let hideTimer = null;
  let seeking = false;
  abortController.signal.addEventListener("abort", () => window.clearTimeout(hideTimer), { once: true });
  const cleanupObserver = new MutationObserver(() => {
    if (shell.isConnected) return;
    abortController.abort();
    cleanupObserver.disconnect();
  });
  window.setTimeout(() => {
    if (shell.isConnected) cleanupObserver.observe(document.body, { childList: true, subtree: true });
  }, 0);
  const duration = () => {
    const value = Number(video.duration || 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  const update = (preview = null) => {
    const total = duration();
    const current = preview ?? Number(video.currentTime || 0);
    play.textContent = video.paused ? "播放" : "暂停";
    center.textContent = video.paused ? "播放" : "暂停";
    mute.textContent = video.muted ? "开声" : "静音";
    time.textContent = total > 0 ? `${formatMediaTime(current)} / ${formatMediaTime(total)}` : formatMediaTime(current);
    seek.disabled = total <= 0;
    seek.max = String(Math.max(1, Math.floor(total || 1)));
    if (!seeking) seek.value = String(Math.min(Math.floor(current), Math.floor(total || current || 0)));
  };
  const scheduleHide = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => shell.classList.add("chrome-hidden"), 2500);
  };
  const showChrome = () => {
    shell.classList.remove("chrome-hidden");
    scheduleHide();
  };
  const toggle = () => {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
    update();
    showChrome();
  };

  play.addEventListener("click", toggle, listenerOptions);
  center.addEventListener("click", toggle, listenerOptions);
  video.addEventListener("click", toggle, listenerOptions);
  shell.addEventListener("pointermove", showChrome, listenerOptions);
  shell.addEventListener("pointerdown", showChrome, listenerOptions);
  seek.addEventListener("input", () => {
    seeking = true;
    update(Number(seek.value || 0));
    showChrome();
  }, listenerOptions);
  seek.addEventListener("change", () => {
    const total = duration();
    video.currentTime = total > 0 ? Math.min(Math.max(Number(seek.value || 0), 0), total) : 0;
    seeking = false;
    update();
    showChrome();
  }, listenerOptions);
  mute.addEventListener("click", () => {
    video.muted = !video.muted;
    update();
    showChrome();
  }, listenerOptions);
  full.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else shell.requestFullscreen?.();
    showChrome();
  }, listenerOptions);
  video.addEventListener("timeupdate", () => update(), listenerOptions);
  video.addEventListener("loadedmetadata", () => update(), listenerOptions);
  video.addEventListener("canplay", () => update(), listenerOptions);
  video.addEventListener("play", () => {
    update();
    showChrome();
  }, listenerOptions);
  video.addEventListener("pause", () => {
    update();
    showChrome();
  }, listenerOptions);
  document.addEventListener("fullscreenchange", () => {
    full.textContent = document.fullscreenElement ? "退出" : "全屏";
  }, listenerOptions);
  shell.append(video, chrome);
  update();
  showChrome();
  return shell;
}

function ratingStarsText(metadata = null) {
  const stars = metadata?.ratingStars && typeof metadata.ratingStars === "object" ? metadata.ratingStars : {};
  const parts = [];
  for (const key of ["5", "4", "3", "2", "1"]) {
    const value = stars[key] || stars[`${key}星`] || stars[`${key}star`] || stars[`${key}_star`];
    if (value) parts.push(`${key}星 ${value}`);
  }
  return parts.join(" · ");
}

function movieRatingStarEntries(metadata = null) {
  const stars = metadata?.ratingStars && typeof metadata.ratingStars === "object" ? metadata.ratingStars : {};
  return ["5", "4", "3", "2", "1"].map((key) => {
    const raw = stars[key] || stars[`${key}星`] || stars[`${key}star`] || stars[`${key}_star`] || "";
    const percent = Number.parseFloat(String(raw).replace("%", ""));
    return {
      label: `${key}星`,
      text: String(raw || "").trim(),
      percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0
    };
  }).filter((item) => item.text || item.percent > 0);
}

function appendMovieFact(container, label, value, options = {}) {
  const text = Array.isArray(value) ? value.filter(Boolean).join(options.separator || " / ") : String(value || "").trim();
  if (!text) return;
  const row = document.createElement("div");
  row.className = "gallery-movie-fact";
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = text;
  if (options.mono) valueNode.className = "mono";
  row.append(labelNode, valueNode);
  container.append(row);
}

function createMovieRatingPanel(metadata = null) {
  const panel = document.createElement("aside");
  panel.className = "gallery-movie-rating";
  const label = document.createElement("span");
  label.className = "gallery-movie-rating-label";
  label.textContent = "豆瓣评分";
  panel.append(label);

  const rating = Number(metadata?.rating || 0);
  const hasRating = Number.isFinite(rating) && rating > 0;
  const scoreRow = document.createElement("div");
  scoreRow.className = "gallery-movie-score-row";
  const score = document.createElement("strong");
  score.className = "gallery-movie-score";
  score.textContent = hasRating ? rating.toFixed(1) : "-";
  const count = document.createElement("span");
  count.textContent = metadata?.ratingCount ? `${formatNumber(metadata.ratingCount)} 人评价` : "暂无评价";
  scoreRow.append(score, count);
  panel.append(scoreRow);

  const entries = movieRatingStarEntries(metadata);
  if (entries.length) {
    const bars = document.createElement("div");
    bars.className = "gallery-movie-rating-bars";
    for (const item of entries) {
      const row = document.createElement("div");
      row.className = "gallery-movie-rating-bar";
      const name = document.createElement("span");
      name.textContent = item.label;
      const track = document.createElement("i");
      const fill = document.createElement("b");
      fill.style.width = `${item.percent}%`;
      track.append(fill);
      const value = document.createElement("em");
      value.textContent = item.text || `${item.percent.toFixed(1)}%`;
      row.append(name, track, value);
      bars.append(row);
    }
    panel.append(bars);
  }

  const betterThan = tvSeriesBetterThanText(metadata);
  if (betterThan) {
    const better = document.createElement("p");
    better.className = "gallery-movie-better";
    better.textContent = betterThan;
    panel.append(better);
  }
  return panel;
}

function createMovieInfoPanel(media, metadata = null, onBack = null) {
  const panel = document.createElement("section");
  panel.className = "gallery-movie-detail";
  const isTv = media?.mediaKind === "tv";
  const isAnime = media?.mediaKind === "anime";
  const isEpisodic = isTv || isAnime;

  const header = document.createElement("div");
  header.className = "gallery-movie-detail-header";
  const titleBlock = document.createElement("div");
  const title = document.createElement("h1");
  title.textContent = movieDisplayTitle(media);
  titleBlock.append(title);

  const originalTitle = movieOriginalTitleText(media);
  if (originalTitle) {
    const sub = document.createElement("span");
    sub.textContent = originalTitle;
    titleBlock.append(sub);
  }

  const actions = document.createElement("div");
  actions.className = "gallery-movie-detail-actions";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "text-button";
  back.textContent = "返回书架";
  back.addEventListener("click", () => {
    onBack?.();
    renderGalleryView();
    syncGalleryRoute("replace");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  actions.append(back);
  const doubanUrl = movieDoubanUrl(metadata);
  if (doubanUrl) {
    const doubanLink = document.createElement("a");
    doubanLink.className = "text-button";
    doubanLink.href = doubanUrl;
    doubanLink.target = "_blank";
    doubanLink.rel = "noreferrer";
    doubanLink.textContent = "豆瓣";
    actions.append(doubanLink);
  }
  if (!isTv && state.accessMode === "local" && openAdminScript) {
    const calibrate = document.createElement("button");
    calibrate.type = "button";
    calibrate.className = "text-button";
    calibrate.textContent = "校准豆瓣";
    calibrate.addEventListener("click", () => openMovieDoubanCalibration(media, metadata));
    actions.append(calibrate);
  }
  if (media.streamUrl) {
    const openLink = document.createElement("a");
    openLink.className = "text-button";
    openLink.href = media.streamUrl;
    openLink.target = "_blank";
    openLink.rel = "noreferrer";
    openLink.textContent = "打开视频";
    actions.append(openLink);
  }
  header.append(titleBlock, actions);
  panel.append(header);

  const main = document.createElement("div");
  main.className = "gallery-movie-detail-main";

  const cover = document.createElement("div");
  cover.className = "gallery-movie-poster";
  const coverUrl = metadata?.coverUrl || media.coverUrl || "";
  if (coverUrl) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.src = coverUrl;
    cover.append(img);
  } else {
    cover.classList.add("empty");
    cover.textContent = isAnime ? "动漫" : isTv ? "电视剧" : "电影";
  }

  const facts = document.createElement("div");
  facts.className = "gallery-movie-facts";
  appendMovieFact(facts, "导演", metadata?.directors);
  appendMovieFact(facts, "编剧", metadata?.writers);
  appendMovieFact(facts, "主演", metadata?.actors);
  appendMovieFact(facts, "类型", metadata?.genres);
  appendMovieFact(facts, "制片国家/地区", metadata?.countries);
  appendMovieFact(facts, "语言", metadata?.languages);
  appendMovieFact(facts, isEpisodic ? "首播日期" : "上映日期", metadata?.releaseDates?.length ? metadata.releaseDates : metadata?.pubdate);
  appendMovieFact(facts, "季数", isEpisodic && metadata?.seasonCount ? `${formatNumber(metadata.seasonCount)} 季` : "");
  appendMovieFact(facts, "集数", isEpisodic && metadata?.episodeCount ? `${formatNumber(metadata.episodeCount)} 集` : "");
  appendMovieFact(facts, "片长", metadata?.durations?.length ? metadata.durations : metadata?.episodeDuration);
  appendMovieFact(facts, "又名", metadata?.aliases);
  appendMovieFact(facts, "IMDb", metadata?.imdbId, { mono: true });

  main.append(cover, facts, createMovieRatingPanel(metadata));
  panel.append(main);

  const sections = document.createElement("div");
  sections.className = "gallery-movie-sections";
  if (metadata?.summary) {
    const summary = document.createElement("section");
    summary.className = "gallery-movie-section";
    const heading = document.createElement("h2");
    heading.textContent = `${moviePrimaryTitle(media)}的剧情简介`;
    const text = document.createElement("p");
    text.textContent = metadata.summary;
    summary.append(heading, text);
    sections.append(summary);
  }

  const local = document.createElement("section");
  local.className = "gallery-movie-section gallery-movie-local-section";
  const localHeading = document.createElement("h2");
  localHeading.textContent = "本地文件";
  const localGrid = document.createElement("div");
  localGrid.className = "gallery-movie-local-grid";
  appendMovieFact(localGrid, "分类", [media.category, media.seriesName].filter(Boolean).join(" / "));
  appendMovieFact(localGrid, "类型", isAnime ? "动漫" : isTv ? "电视剧" : "电影");
  appendMovieFact(localGrid, "格式", media.ext);
  appendMovieFact(localGrid, "大小", formatBytes(media.size));
  appendMovieFact(localGrid, "文件名", media.title);
  appendMovieFact(localGrid, "路径", media.relativePath, { mono: true });
  local.append(localHeading, localGrid);
  sections.append(local);

  if (sections.childElementCount) panel.append(sections);
  return panel;
}

function appendMediaMetaItem(container, label, value, options = {}) {
  const text = Array.isArray(value) ? value.filter(Boolean).join(options.separator || " / ") : String(value || "").trim();
  if (!text) return;
  const item = document.createElement("div");
  item.className = "gallery-media-meta-item";
  if (options.wide) item.classList.add("wide");
  if (options.long) item.classList.add("long");
  const labelNode = document.createElement("span");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = text;
  if (options.mono) valueNode.className = "mono";
  item.append(labelNode, valueNode);
  container.append(item);
}

function renderMediaReader(container) {
  const media = state.gallery.media;
  const isMovie = media.mediaKind === "movie";
  const isScreenMedia = ["movie", "tv", "anime"].includes(media.mediaKind);
  const metadata = isMovie ? media.movieMetadata : media.tvSeries;
  if (!isScreenMedia) {
    const toolbar = readerToolbar(
      media.title,
      [media.kindLabel, media.category, ["tv", "anime"].includes(media.mediaKind) ? media.seriesName : media.personName, formatBytes(media.size)]
        .filter(Boolean)
        .join(" · "),
      () => {
        state.gallery.media = null;
      },
      { showFit: false }
    );
    const openLink = document.createElement("a");
    openLink.className = "text-button";
    openLink.href = media.streamUrl;
    openLink.target = "_blank";
    openLink.rel = "noreferrer";
    openLink.textContent = "打开视频";
    toolbar.append(openLink);
    container.append(toolbar);
  }

  const panel = document.createElement("section");
  panel.className = `gallery-media-player${isScreenMedia ? " gallery-media-player-movie" : ""}`;
  if (isScreenMedia) {
    panel.append(createMovieInfoPanel(media, metadata, () => {
      state.gallery.media = null;
    }));
  }
  if (media.playable) {
    panel.append(createGalleryMediaPlayer(media, metadata));
  }

  if (isScreenMedia) {
    container.append(panel);
    return;
  }

  const meta = document.createElement("div");
  meta.className = "gallery-media-meta";
  const commonRows = [
    ["豆瓣", tvSeriesRatingText(metadata)],
    ["好于", tvSeriesBetterThanText(metadata).replace(/^好于\s*/, "")],
    [isMovie ? "上映" : "首播", metadata?.pubdate || (metadata?.releaseDates || []).join(" / ")],
    [isMovie ? "中文片名" : "剧名", isMovie ? movieDisplayTitle(media) : media.tvSeries ? tvSeriesDisplayTitle(media.seriesName, media.tvSeries) : ""],
    ["原名", isMovie ? movieOriginalTitleText(media) : metadata?.originalTitle],
    ["又名", metadata?.aliases || []],
    ["导演", metadata?.directors || []],
    ["编剧", metadata?.writers || []],
    ["官网", metadata?.officialSite],
    ["IMDb", metadata?.imdbId],
    ["季数", !isMovie && metadata?.seasonCount ? `${formatNumber(metadata.seasonCount)} 季` : ""],
    ["集数", !isMovie && metadata?.episodeCount ? `${formatNumber(metadata.episodeCount)} 集` : ""],
    ["片长", (metadata?.durations || []).join(" / ") || metadata?.episodeDuration],
    ["类型", media.kindLabel],
    ["豆瓣类型", metadata?.genres || []],
    ["地区语言", [(metadata?.countries || []).join(" / "), (metadata?.languages || []).join(" / ")].filter(Boolean).join(" · ")],
    ["分类", media.category],
    ["系列", media.seriesName],
    ["演职员", (metadata?.actors || []).slice(0, isMovie ? 16 : 8).join(" / ")],
    ["人物", media.personName],
    ["格式", media.ext],
    ["大小", formatBytes(media.size)]
  ];
  for (const [label, value] of commonRows) appendMediaMetaItem(meta, label, value);
  appendMediaMetaItem(meta, "星级分布", ratingStarsText(metadata), { wide: true });
  appendMediaMetaItem(meta, "简介", metadata?.summary, { wide: true, long: true });
  appendMediaMetaItem(meta, "原始文件名", media.title, { wide: true });
  appendMediaMetaItem(meta, "路径", media.relativePath, { wide: true, mono: true });
  panel.append(meta);
  container.append(panel);
}

function renderGalleryView(options = {}) {
  const scrollAnchor = options.preserveScroll ? captureGalleryScrollPosition() : null;
  if (!scrollAnchor) galleryScrollRestoreGeneration += 1;
  const searchValueToRestore = activeGallerySearchValue();
  resetGalleryRenderedState();

  els.workGrid.innerHTML = "";
  const shell = document.createElement("section");
  shell.className = "gallery-shell";
  const imageReaderOpen = Boolean(state.gallery.album || state.gallery.comic);
  const seriesPageOpen = ["media", "tv"].includes(state.gallery.mode) && state.gallery.person !== "all" && !state.gallery.media;
  if (state.gallery.mode === "photo" && !imageReaderOpen) {
    shell.classList.add("gallery-photo-shell");
    if (state.gallery.photoView === "collections" && !state.gallery.photoCollection) shell.classList.add("gallery-photo-catalog-shell");
  }
  if (imageReaderOpen) shell.classList.add("gallery-reader-shell");
  else if (seriesPageOpen) shell.classList.add("gallery-series-shell");
  else shell.append(renderGalleryControls({ searchValue: searchValueToRestore }));

  const content = document.createElement("div");
  content.className = "gallery-content";
  renderGalleryContent(content);
  shell.append(content);
  els.workGrid.append(shell);
  if (searchValueToRestore !== null) restoreGallerySearchFocus();
  restoreGalleryScrollPosition(scrollAnchor);
}
  return {
    mediaKindForMode: galleryMediaKindForMode,
    modeLabel: galleryModeLabel,
    loadImageLibrary,
    openGalleryMedia,
    openMangaChapter,
    openMangaComic,
    openPhotoSet,
    renderStats: renderGalleryStats,
    renderView: renderGalleryView,
    resetReader: resetGalleryReader,
    setStatus: setGalleryStatus,
    syncRoute: syncGalleryRoute
  };
}
