const PHOTO_COLLECTION_ROOT_VALUE = "__fanhao_photo_collection_root__";
const DEFAULT_GALLERY_PHOTO_CATEGORY = "我喜欢的";
const PHOTO_QUICK_CATEGORIES = [
  DEFAULT_GALLERY_PHOTO_CATEGORY,
  "[XIUREN] 秀人网",
  "[COS]",
  "内购私拍",
  "日本写真集",
  "韩国写真集",
  "国模"
];
const PHOTO_CATEGORY_LABELS = new Map([
  [DEFAULT_GALLERY_PHOTO_CATEGORY, "我喜欢的"],
  ["[XIUREN] 秀人网", "秀人网"],
  ["[COS]", "COS"]
]);
const MOVIE_QUICK_CATEGORY_LIMIT = 14;
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
    normalizeUiConfig,
    openAdminScript,
    resetProgressiveCoverLoading,
    setAdminBusy,
    state,
    writeStoredFlag
  } = deps;

  let galleryCoverObserver = null;
  let galleryReaderObserver = null;
  let galleryReaderScrollCleanup = null;
  let galleryMoreObserver = null;
  let galleryPagerCleanup = null;

function setGalleryStatus(message) {
  getGalleryPage().setStatus(message);
}

function renderGalleryStats() {
  const data = state.gallery.data || {};
  const stats = [
    ["套图", data.totals?.photoSets || 0],
    ["韩漫", data.totals?.manga || 0],
    ["欧美", data.totals?.western || 0],
    ["电影", data.totals?.movies || 0],
    ["电视剧", data.totals?.tv || 0]
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
    movie: "电影",
    tv: "电视剧",
    cache: "缓存"
  };
  return labels[mode] || mode;
}

function galleryMediaKindForMode(mode) {
  if (mode === "western") return "western";
  if (mode === "movie") return "movie";
  if (mode === "tv") return "tv";
  return "";
}

function galleryImageModuleButton(mode, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `gallery-submode-button${state.gallery.mode === mode ? " active" : ""}`;
  button.textContent = label;
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
  row.append(galleryImageModuleButton("photo", "套图"), galleryImageModuleButton("manga", "韩漫"));
  return row;
}

function galleryPhotoViewButton(view, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `gallery-submode-button${state.gallery.photoView === view ? " active" : ""}`;
  button.textContent = label;
  button.addEventListener("click", () => {
    state.gallery.photoView = view;
    state.gallery.photoCollection = null;
    state.gallery.person = "all";
    state.gallery.subCategory = "all";
    state.gallery.visibleLimit = 80;
    resetGalleryReader();
    renderGalleryView();
    syncGalleryRoute();
  });
  return button;
}

function photoCategoryDisplayName(value) {
  const text = String(value || "").trim();
  if (!text) return "未归类";
  if (PHOTO_CATEGORY_LABELS.has(text)) return PHOTO_CATEGORY_LABELS.get(text);
  const bracketOnly = text.match(/^\[([^\]]+)\]$/);
  return bracketOnly ? bracketOnly[1].trim() || text : text;
}

function photoCategoryCounts() {
  const counts = new Map();
  for (const item of state.gallery.data?.photoSets || []) {
    const value = String(item.category || "").trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function appendFacetOption(select, label, value, count) {
  const option = new Option(label, value);
  if (count !== undefined) option.title = `${label} · ${formatNumber(count)}`;
  select.append(option);
}

function createPhotoCategoryStrip() {
  const counts = photoCategoryCounts();
  const strip = document.createElement("div");
  strip.className = "gallery-category-strip";

  const addChip = (value, label, count) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `gallery-category-chip${state.gallery.category === value ? " active" : ""}`;
    button.textContent = label;
    if (count !== undefined) {
      button.title = `${label} · ${formatNumber(count)}`;
      button.setAttribute("aria-label", `${label}，${formatNumber(count)} 项`);
    }
    button.addEventListener("click", () => {
      state.gallery.category = value;
      state.gallery.subCategory = "all";
      state.gallery.photoCollection = null;
      state.gallery.person = "all";
      state.gallery.visibleLimit = 80;
      resetGalleryReader();
      renderGalleryView();
      syncGalleryRoute();
    });
    strip.append(button);
  };

  addChip(DEFAULT_GALLERY_PHOTO_CATEGORY, "我喜欢的", counts.get(DEFAULT_GALLERY_PHOTO_CATEGORY) || 0);
  addChip("all", "全部", state.gallery.data?.totals?.photoSets || (state.gallery.data?.photoSets || []).length);
  for (const value of PHOTO_QUICK_CATEGORIES.filter((item) => item !== DEFAULT_GALLERY_PHOTO_CATEGORY)) {
    addChip(value, photoCategoryDisplayName(value), counts.get(value) || 0);
  }

  if (state.gallery.category !== "all" && !PHOTO_QUICK_CATEGORIES.includes(state.gallery.category)) {
    addChip(state.gallery.category, photoCategoryDisplayName(state.gallery.category), counts.get(state.gallery.category) || 0);
  }

  return strip;
}

function mediaItemsForMode(mode = state.gallery.mode) {
  const kind = galleryMediaKindForMode(mode);
  return kind ? (state.gallery.data?.mediaItems || []).filter((item) => item.mediaKind === kind) : [];
}

function createTvRegionStrip() {
  const regions = localGalleryFacets(mediaItemsForMode("tv"), "category");
  const total = mediaItemsForMode("tv").length;
  const strip = document.createElement("div");
  strip.className = "gallery-category-strip gallery-tv-region-strip";

  const addChip = (value, label, count) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `gallery-category-chip${state.gallery.category === value ? " active" : ""}`;
    button.textContent = label;
    button.title = `${label} · ${formatNumber(count)}`;
    button.setAttribute("aria-label", `${label}，${formatNumber(count)} 项`);
    button.addEventListener("click", () => {
      state.gallery.category = value;
      state.gallery.person = "all";
      state.gallery.visibleLimit = 80;
      resetGalleryReader();
      renderGalleryView();
      syncGalleryRoute();
    });
    strip.append(button);
  };

  addChip("all", "全部", total);
  for (const item of regions) addChip(item.value, item.value, item.count);
  if (state.gallery.category !== "all" && !regions.some((item) => item.value === state.gallery.category)) {
    const count = mediaItemsForMode("tv").filter((item) => item.category === state.gallery.category).length;
    addChip(state.gallery.category, state.gallery.category, count);
  }

  return strip;
}

function createMovieCategoryStrip() {
  const categories = localGalleryFacets(mediaItemsForMode("movie"), "category").slice(0, MOVIE_QUICK_CATEGORY_LIMIT);
  const total = mediaItemsForMode("movie").length;
  const strip = document.createElement("div");
  strip.className = "gallery-category-strip gallery-movie-category-strip";

  const addChip = (value, label, count) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `gallery-category-chip${state.gallery.category === value ? " active" : ""}`;
    button.textContent = label;
    button.title = `${label} · ${formatNumber(count)}`;
    button.setAttribute("aria-label", `${label}，${formatNumber(count)} 项`);
    button.addEventListener("click", () => {
      state.gallery.category = value;
      state.gallery.person = "all";
      state.gallery.visibleLimit = 80;
      resetGalleryReader();
      renderGalleryView();
      syncGalleryRoute();
    });
    strip.append(button);
  };

  addChip("all", "全部分类", total);
  for (const item of categories) addChip(item.value, item.value, item.count);
  if (state.gallery.category !== "all" && !categories.some((item) => item.value === state.gallery.category)) {
    const count = mediaItemsForMode("movie").filter((item) => item.category === state.gallery.category).length;
    addChip(state.gallery.category, state.gallery.category, count);
  }

  return strip;
}

function galleryRescanScopeForMode() {
  if (state.gallery.mode === "photo") return "photo";
  if (["western", "movie", "tv"].includes(state.gallery.mode)) return state.gallery.mode;
  return "all";
}

function renderGalleryControls(options = {}) {
  const controls = document.createElement("div");
  controls.className = "gallery-controls";

  const photoViews = document.createElement("div");
  photoViews.className = "gallery-submodes";
  photoViews.append(galleryPhotoViewButton("collections", "合集"), galleryPhotoViewButton("albums", "图包"));

  const search = document.createElement("input");
  search.type = "search";
  search.className = "gallery-search";
  search.placeholder = state.gallery.mode === "manga" ? "搜索漫画标题 / 分类 / 站点" : "搜索标题 / 分类 / 合集";
  search.value = options.searchValue ?? state.gallery.query;
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
  category.append(new Option(state.gallery.mode === "photo" ? "全部大类" : state.gallery.mode === "tv" ? "全部" : "全部分类", "all"));
  const categoryFacets = currentGalleryCategoryFacets();
  for (const item of categoryFacets) {
    const label = state.gallery.mode === "photo" ? photoCategoryDisplayName(item.value) : item.value;
    appendFacetOption(category, label, item.value, item.count);
  }
  if (
    state.gallery.category !== "all" &&
    !categoryFacets.some((item) => item.value === state.gallery.category)
  ) {
    category.append(new Option(photoCategoryDisplayName(state.gallery.category), state.gallery.category));
  }
  category.value = state.gallery.category;
  category.addEventListener("change", () => {
    state.gallery.category = category.value || "all";
    state.gallery.subCategory = "all";
    state.gallery.photoCollection = null;
    state.gallery.person = "all";
    state.gallery.visibleLimit = 80;
    resetGalleryReader();
    renderGalleryView();
    syncGalleryRoute();
  });

  const subCategory = document.createElement("select");
  subCategory.className = "gallery-select gallery-subcategory-select";
  subCategory.append(new Option("全部文件夹", "all"));
  const subCategoryFacets = currentPhotoSubCategoryFacets().slice(0, 500);
  for (const item of subCategoryFacets) {
    appendFacetOption(subCategory, photoPersonDisplayName(item.value), item.value, item.count);
  }
  if (
    state.gallery.subCategory !== "all" &&
    !subCategoryFacets.some((item) => item.value === state.gallery.subCategory)
  ) {
    subCategory.append(new Option(photoPersonDisplayName(state.gallery.subCategory), state.gallery.subCategory));
  }
  subCategory.value = state.gallery.subCategory || "all";
  subCategory.addEventListener("change", () => {
    state.gallery.subCategory = subCategory.value || "all";
    state.gallery.photoCollection = null;
    state.gallery.person = "all";
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
    state.gallery.visibleLimit = 80;
    resetGalleryReader();
    renderGalleryView();
    syncGalleryRoute();
  });

  const sort = document.createElement("select");
  sort.className = "gallery-select gallery-sort-select";
  for (const [value, label] of MEDIA_SORT_OPTIONS) sort.append(new Option(label, value));
  sort.value = state.gallery.sort || "updated";
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
  refresh.textContent = rescanScope === "all" ? "后台刷新" : `后台刷新${galleryModeLabel(state.gallery.mode)}`;
  refresh.disabled = state.gallery.loading;
  refresh.addEventListener("click", () => openAdminScript?.("image-library-rescan", { defaults: { scope: rescanScope } }));

  const status = document.createElement("span");
  status.className = "gallery-status";
  status.textContent = state.gallery.status || "";

  if (["photo", "manga"].includes(state.gallery.mode)) controls.append(createGalleryImageModuleSwitch());
  if (state.gallery.mode === "photo") controls.append(createPhotoCategoryStrip(), photoViews);
  if (state.gallery.mode === "movie") controls.append(createMovieCategoryStrip());
  if (state.gallery.mode === "tv") controls.append(createTvRegionStrip());
  controls.append(search);
  if (["photo", "western", "movie", "tv"].includes(state.gallery.mode)) controls.append(category);
  if (state.gallery.mode === "photo") controls.append(subCategory);
  if (["western", "tv"].includes(state.gallery.mode)) controls.append(people);
  if (state.gallery.mode === "movie") controls.append(sort);
  controls.append(refresh, status);
  return controls;
}

function submitGallerySearch(value, options = {}) {
  const nextQuery = String(value || "").trim();
  if (state.gallery.query === nextQuery) {
    if (options.restoreFocus) restoreGallerySearchFocus();
    return;
  }
  state.gallery.query = nextQuery;
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
  if (galleryMoreObserver) {
    galleryMoreObserver.disconnect();
    galleryMoreObserver = null;
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
  } else if (state.gallery.mode === "photo" && state.gallery.photoCollection) {
    renderPhotoCollectionPage(content);
  } else if (state.gallery.mode === "manga") {
    renderMangaShelf(content);
  } else if (["western", "movie", "tv"].includes(state.gallery.mode)) {
    renderMediaShelf(content);
  } else {
    renderPhotoShelf(content);
  }
}

function renderGalleryResults() {
  resetGalleryRenderedState();
  const content = els.workGrid.querySelector(".gallery-content");
  if (!content) {
    renderGalleryView();
    return;
  }
  content.innerHTML = "";
  renderGalleryContent(content);
}

function currentGalleryCategoryFacets() {
  const facets = state.gallery.data?.facets || {};
  if (state.gallery.mode === "photo") return facets.categories || [];
  const kind = galleryMediaKindForMode(state.gallery.mode);
  return kind ? facets[kind]?.categories || [] : [];
}

function currentGalleryPeopleFacets() {
  const facets = state.gallery.data?.facets || {};
  if (state.gallery.mode === "photo") return facets.people || [];
  const kind = galleryMediaKindForMode(state.gallery.mode);
  if (kind === "tv") return currentTvSeriesFacets();
  if (kind === "western") return localGalleryFacets(filteredWesternItemsForGroups(), "personName");
  return [];
}

function currentTvSeriesFacets() {
  let items = mediaItemsForMode("tv");
  if (state.gallery.category !== "all") items = items.filter((item) => item.category === state.gallery.category);
  const query = state.gallery.query.trim();
  if (query) items = items.filter((item) => includesText(galleryText(item), query));
  return localGalleryFacets(items, "seriesName");
}

function currentPhotoSubCategoryFacets() {
  let items = state.gallery.data?.photoSets || [];
  if (state.gallery.category !== "all") items = items.filter((item) => item.category === state.gallery.category);
  const query = state.gallery.query.trim();
  if (query) items = items.filter((item) => includesText(galleryText(item), query));
  return localGalleryFacets(items, "subCategory");
}

function galleryText(item) {
  const movieMetadata = item.mediaKind === "movie" ? item.movieMetadata || {} : {};
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
    ...(movieMetadata.countries || [])
  ].filter(Boolean).join("\n");
}

function photoPersonDisplayName(value) {
  const name = String(value || "").trim();
  if (!name) return "未归类";
  const bracketOnly = name.match(/^\[([^\]]+)\]$/);
  return bracketOnly ? bracketOnly[1].trim() || name : name;
}

function photoCollectionDir(item) {
  const relativePath = String(item.relativePath || "").replace(/[\\/]+/g, "/");
  const parts = relativePath.split("/").filter(Boolean);
  if (parts.length <= 1) return PHOTO_COLLECTION_ROOT_VALUE;
  return parts.slice(0, -1).join("/");
}

function photoCollectionValue(item) {
  return [item.sourceRoot || item.rootLabel || "", photoCollectionDir(item)].join("|");
}

function photoCollectionDisplayName(dirValue) {
  const dir = String(dirValue || "").trim();
  if (!dir || dir === PHOTO_COLLECTION_ROOT_VALUE) return "根目录合集";
  const last = dir.split("/").filter(Boolean).pop() || dir;
  return photoPersonDisplayName(last);
}

function photoCollectionPathLabel(group) {
  const pathText = group?.dir && group.dir !== PHOTO_COLLECTION_ROOT_VALUE ? group.dir.replaceAll("/", " / ") : group?.rootLabel || "";
  return pathText || group?.title || "";
}

function filteredPhotoSets(options = {}) {
  let items = state.gallery.data?.photoSets || [];
  if (state.gallery.category !== "all") items = items.filter((item) => item.category === state.gallery.category);
  if (state.gallery.subCategory !== "all") items = items.filter((item) => item.subCategory === state.gallery.subCategory);
  if (!options.ignorePerson && state.gallery.person !== "all") {
    items = items.filter((item) => item.personName === state.gallery.person);
  }
  const query = state.gallery.query.trim();
  if (query) items = items.filter((item) => includesText(galleryText(item), query));
  return items;
}

function photoCollectionGroups() {
  const groups = new Map();
  for (const item of filteredPhotoSets({ ignorePerson: true })) {
    const dir = photoCollectionDir(item);
    const value = photoCollectionValue(item);
    let group = groups.get(value);
    if (!group) {
      group = {
        value,
        title: photoCollectionDisplayName(dir),
        dir,
        rootLabel: item.rootLabel || "",
        sourceRoot: item.sourceRoot || "",
        count: 0,
        size: 0,
        updatedAt: "",
        coverUrl: item.coverUrl || "",
        categories: new Set(),
        subCategories: new Set(),
        samples: []
      };
      groups.set(value, group);
    }
    group.count += 1;
    group.size += Number(item.size || 0);
    if (!group.coverUrl && item.coverUrl) group.coverUrl = item.coverUrl;
    if (item.category) group.categories.add(item.category);
    if (item.subCategory) group.subCategories.add(item.subCategory);
    if (group.samples.length < 3 && item.title) group.samples.push(item.title);
    const itemTime = new Date(item.updatedAt || 0).getTime();
    const groupTime = new Date(group.updatedAt || 0).getTime();
    if (itemTime > groupTime) group.updatedAt = item.updatedAt || group.updatedAt;
  }
  return [...groups.values()].sort((a, b) => {
    const countDiff = b.count - a.count;
    if (countDiff) return countDiff;
    const timeDiff = new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
    return timeDiff || a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
  });
}

function photoCollectionAlbums(collectionValue, options = {}) {
  let items = state.gallery.data?.photoSets || [];
  items = items.filter((item) => photoCollectionValue(item) === collectionValue);
  if (!options.ignoreCategory && state.gallery.category !== "all") items = items.filter((item) => item.category === state.gallery.category);
  if (!options.ignoreSubCategory && state.gallery.subCategory !== "all") items = items.filter((item) => item.subCategory === state.gallery.subCategory);
  const query = options.ignoreQuery ? "" : state.gallery.query.trim();
  if (query) items = items.filter((item) => includesText(galleryText(item), query));
  return items;
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

function photoCollectionSummary(collectionValue) {
  const items = photoCollectionAlbums(collectionValue, { ignoreCategory: true, ignoreSubCategory: true, ignoreQuery: true });
  const first = items[0] || {};
  const dir = first.relativePath ? photoCollectionDir(first) : "";
  return {
    value: collectionValue,
    title: photoCollectionDisplayName(dir),
    dir,
    rootLabel: first.rootLabel || "",
    count: items.length,
    size: items.reduce((sum, item) => sum + Number(item.size || 0), 0),
    latestAt: items.reduce((latest, item) => {
      const itemTime = new Date(item.updatedAt || 0).getTime();
      const latestTime = new Date(latest || 0).getTime();
      return itemTime > latestTime ? item.updatedAt : latest;
    }, ""),
    categories: localGalleryFacets(items, "category"),
    subCategories: localGalleryFacets(items, "subCategory"),
    roots: localGalleryFacets(items, "rootLabel")
  };
}

function photoCollectionInitials(value) {
  const text = photoCollectionSummary(value).title.replace(/[\s()[\]【】._-]+/g, "");
  return [...text].slice(0, 2).join("") || "集";
}

function filteredManga() {
  let items = state.gallery.data?.manga || [];
  const query = state.gallery.query.trim();
  if (query) items = items.filter((item) => includesText([item.title, item.dirName, item.site].join("\n"), query));
  return items;
}

function filteredMediaItems() {
  const kind = galleryMediaKindForMode(state.gallery.mode);
  let items = mediaItemsForMode(state.gallery.mode);
  if (state.gallery.category !== "all") items = items.filter((item) => item.category === state.gallery.category);
  if (state.gallery.person !== "all") {
    items = items.filter((item) => (kind === "tv" ? item.seriesName : item.personName) === state.gallery.person);
  }
  const query = state.gallery.query.trim();
  if (query) items = items.filter((item) => includesText(galleryText(item), query));
  if (kind === "movie") items = sortMovieItems(items);
  return items;
}

function movieSortRating(item) {
  const rating = Number(item?.movieMetadata?.rating || item?.rating || 0);
  return Number.isFinite(rating) ? rating : 0;
}

function movieSortYear(item) {
  const year = Number.parseInt(String(item?.movieMetadata?.year || item?.year || "").match(/\d{4}/)?.[0] || "", 10);
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
  const metadata = item.movieMetadata || {};
  return [
    metadata.year || "",
    (metadata.countries || []).slice(0, 2).join(" / ") || item.category,
    (metadata.genres || []).slice(0, 3).join(" / ")
  ].filter(Boolean).join(" / ");
}

function movieListPeopleLine(item) {
  const metadata = item.movieMetadata || {};
  return [
    (metadata.directors || []).slice(0, 2).join(" / "),
    (metadata.actors || []).slice(0, 4).join(" / ")
  ].filter(Boolean).join(" / ");
}

function movieListRatingLine(item) {
  const metadata = item.movieMetadata || {};
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
  if (state.gallery.category !== "all") items = items.filter((item) => item.category === state.gallery.category);
  const query = state.gallery.query.trim();
  if (query) items = items.filter((item) => includesText(galleryText(item), query));
  return items;
}

function tvSeriesGroups() {
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

function selectedTvSeriesMetadata() {
  if (state.gallery.mode !== "tv" || state.gallery.person === "all") return null;
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

function movieChineseTitle(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!hasCjkText(text)) return text;
  const parts = text.split(" ");
  const lastCjk = parts.reduce((last, part, index) => (hasCjkText(part) ? index : last), -1);
  return lastCjk >= 0 ? parts.slice(0, lastCjk + 1).join(" ").trim() : text;
}

function moviePrimaryTitle(media = {}) {
  const metadata = media.movieMetadata || {};
  const aliases = Array.isArray(metadata.aliases) ? metadata.aliases : [];
  const candidates = [
    metadata.title,
    metadata.movieTitle,
    ...aliases.filter(hasCjkText),
    media.title
  ].map((item) => String(item || "").trim()).filter(Boolean);
  const title = candidates.find(hasCjkText) || candidates[0] || "电影";
  return movieChineseTitle(title);
}

function movieDisplayTitle(media = {}) {
  const metadata = media.movieMetadata || {};
  const title = moviePrimaryTitle(media);
  return metadata.year && !String(title).includes(String(metadata.year)) ? `${title}（${metadata.year}）` : title;
}

function movieOriginalTitleText(media = {}) {
  const metadata = media.movieMetadata || {};
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
  if (state.gallery.mode !== "tv" || state.gallery.person === "all") return;
  const metadata = selectedTvSeriesMetadata();
  const bar = document.createElement("div");
  bar.className = "gallery-person-bar";

  const text = document.createElement("div");
  text.className = "gallery-person-bar-text";
  const title = document.createElement("strong");
  title.textContent = tvSeriesDisplayTitle(state.gallery.person, metadata);
  const meta = document.createElement("span");
  meta.textContent = [
    state.gallery.category !== "all" ? state.gallery.category : "",
    tvSeriesRatingText(metadata),
    metadata?.pubdate ? `首播 ${metadata.pubdate}` : "",
    metadata?.episodeCount ? `${formatNumber(metadata.episodeCount)} 集` : `${formatNumber(total)} 集`,
    metadata?.episodeDuration || "",
    metadata?.imdbId ? `IMDb ${metadata.imdbId}` : ""
  ].filter(Boolean).join(" · ");
  text.append(title, meta);
  const betterThan = tvSeriesBetterThanText(metadata);
  const people = [
    metadata?.directors?.length ? `导演：${metadata.directors.join(" / ")}` : "",
    metadata?.writers?.length ? `编剧：${metadata.writers.join(" / ")}` : "",
    metadata?.actors?.length ? `主演：${metadata.actors.slice(0, 8).join(" / ")}` : ""
  ].filter(Boolean).join(" · ");
  if (betterThan || people) {
    const detail = document.createElement("small");
    detail.className = "gallery-tv-summary";
    detail.textContent = [betterThan, people].filter(Boolean).join(" · ");
    text.append(detail);
  }
  if (metadata?.summary) {
    const summary = document.createElement("small");
    summary.className = "gallery-tv-summary";
    summary.textContent = metadata.summary;
    text.append(summary);
  }

  const actions = document.createElement("div");
  actions.className = "gallery-person-bar-actions";
  const allButton = document.createElement("button");
  allButton.type = "button";
  allButton.className = "text-button";
  allButton.textContent = "全部作品";
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

function renderTvSeriesShelf(container) {
  const groups = tvSeriesGroups();
  const visible = groups.slice(0, state.gallery.visibleLimit);
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
          state.gallery.person = group.title;
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
  } else if (visible.length < groups.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "text-button gallery-more";
    more.textContent = `显示更多作品 ${formatNumber(visible.length)} / ${formatNumber(groups.length)}`;
    more.addEventListener("click", () => {
      state.gallery.visibleLimit += 80;
      renderGalleryView();
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
  } else if (visible.length < groups.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "text-button gallery-more";
    more.textContent = `显示更多人物 ${formatNumber(visible.length)} / ${formatNumber(groups.length)}`;
    more.addEventListener("click", () => {
      state.gallery.visibleLimit += 80;
      renderGalleryView();
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
  if (!button || !("IntersectionObserver" in window)) return;
  if (!galleryMoreObserver) {
    galleryMoreObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = entry.target;
          if (!(target instanceof HTMLButtonElement) || target.disabled || target.dataset.autoloading === "1") continue;
          target.dataset.autoloading = "1";
          galleryMoreObserver.unobserve(target);
          window.setTimeout(() => target.click(), 80);
        }
      },
      { rootMargin: "900px 0px 900px 0px" }
    );
  }
  galleryMoreObserver.observe(button);
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
  const loadFigure = (figure) => {
    const img = figure.querySelector("img");
    if (!img || img.hasAttribute("src")) return;
    img.src = figure.dataset.gallerySrc;
    delete figure.dataset.gallerySrc;
  };
  let ticking = false;
  const loadNearViewport = () => {
    ticking = false;
    const lower = window.innerHeight + 420;
    const upper = -420;
    for (const figure of figures) {
      if (!figure.dataset.gallerySrc) continue;
      const rect = figure.getBoundingClientRect();
      if (rect.top <= lower && rect.bottom >= upper) loadFigure(figure);
    }
  };
  const requestCheck = () => {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(loadNearViewport);
  };
  window.addEventListener("scroll", requestCheck, { passive: true });
  window.addEventListener("resize", requestCheck);
  galleryReaderScrollCleanup = () => {
    window.removeEventListener("scroll", requestCheck);
    window.removeEventListener("resize", requestCheck);
  };
  loadNearViewport();
}

function createGalleryCard(item, options = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gallery-card";
  button.addEventListener("click", options.onOpen);

  const cover = document.createElement("div");
  cover.className = "gallery-card-cover";
  if (item.coverUrl) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.dataset.gallerySrc = item.coverUrl;
    img.addEventListener("error", () => cover.classList.add("empty"));
    cover.append(img);
  } else {
    cover.classList.add("empty");
    cover.dataset.placeholder = options.placeholder || "封面";
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
  const extra = document.createElement("small");
  extra.textContent = options.extra || "";
  body.append(title, meta, extra);
  button.append(cover, body);
  return button;
}

function createGalleryProfileMetric(label, value) {
  const item = document.createElement("span");
  item.innerHTML = `<strong></strong><small></small>`;
  item.querySelector("strong").textContent = String(value);
  item.querySelector("small").textContent = label;
  return item;
}

function renderPhotoCollectionPage(container) {
  const collectionValue = state.gallery.photoCollection;
  if (!collectionValue) return;

  const summary = photoCollectionSummary(collectionValue);
  const items = photoCollectionAlbums(collectionValue);
  const visible = items.slice(0, state.gallery.visibleLimit);
  const categoryText = summary.categories.slice(0, 4).map((item) => `${item.value} ${formatNumber(item.count)}`).join(" · ");
  const subCategoryText = summary.subCategories.slice(0, 4).map((item) => item.value).join(" · ");

  const page = document.createElement("section");
  page.className = "gallery-collection-page";

  const profile = document.createElement("div");
  profile.className = "person-profile gallery-collection-profile";

  const avatar = document.createElement("div");
  avatar.className = "person-avatar gallery-collection-avatar empty";
  avatar.textContent = photoCollectionInitials(collectionValue);

  const copy = document.createElement("div");
  copy.className = "person-profile-copy";

  const nameRow = document.createElement("div");
  nameRow.className = "person-profile-name-row";
  const title = document.createElement("h3");
  title.textContent = summary.title;
  nameRow.append(title);

  const back = document.createElement("button");
  back.type = "button";
  back.className = "person-profile-link";
  back.textContent = "合集列表";
  back.addEventListener("click", () => {
    state.gallery.photoCollection = null;
    state.gallery.photoView = "collections";
    state.gallery.person = "all";
    state.gallery.visibleLimit = 80;
    renderGalleryView();
    syncGalleryRoute("replace");
  });
  nameRow.append(back);

  const all = document.createElement("button");
  all.type = "button";
  all.className = "person-profile-link";
  all.textContent = "全部图包";
  all.addEventListener("click", () => {
    state.gallery.photoCollection = null;
    state.gallery.photoView = "albums";
    state.gallery.person = "all";
    state.gallery.visibleLimit = 80;
    renderGalleryView();
    syncGalleryRoute("replace");
  });
  nameRow.append(all);

  const sub = document.createElement("div");
  sub.className = "person-profile-sub";
  sub.textContent = photoCollectionPathLabel(summary) || categoryText || subCategoryText || "套图合集";

  const metrics = document.createElement("div");
  metrics.className = "person-profile-metrics gallery-collection-metrics";
  metrics.append(
    createGalleryProfileMetric("期数", formatNumber(summary.count)),
    createGalleryProfileMetric("容量", formatBytes(summary.size)),
    createGalleryProfileMetric("分类", formatNumber(summary.categories.length)),
    createGalleryProfileMetric("最近", summary.latestAt ? formatDateTime(summary.latestAt) : "-")
  );

  copy.append(nameRow, sub, metrics);
  if (categoryText || subCategoryText) {
    const aliases = document.createElement("div");
    aliases.className = "gallery-collection-aliases";
    aliases.textContent = [categoryText, subCategoryText].filter(Boolean).join(" · ");
    copy.append(aliases);
  }

  profile.append(avatar, copy);
  page.append(profile);

  const sectionHead = document.createElement("div");
  sectionHead.className = "gallery-collection-section-head";
  const sectionTitle = document.createElement("strong");
  sectionTitle.textContent = "期数";
  const sectionMeta = document.createElement("span");
  const filtered = items.length !== summary.count;
  sectionMeta.textContent = filtered
    ? `${formatNumber(items.length)} / ${formatNumber(summary.count)} 期`
    : `${formatNumber(summary.count)} 期`;
  sectionHead.append(sectionTitle, sectionMeta);
  if (filtered) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "text-button";
    clear.textContent = "清空筛选";
    clear.addEventListener("click", () => {
      state.gallery.query = "";
      state.gallery.category = "all";
      state.gallery.subCategory = "all";
      state.gallery.visibleLimit = 80;
      renderGalleryView();
      syncGalleryRoute("replace");
    });
    sectionHead.append(clear);
  }
  page.append(sectionHead);

  const grid = document.createElement("div");
  grid.className = "gallery-grid";
  for (const [index, item] of visible.entries()) {
    const card = createGalleryCard(item, {
      meta: [item.category, item.subCategory, item.personName].filter(Boolean).join(" · "),
      extra: `${formatBytes(item.size)} · ${formatDateTime(item.updatedAt)}`,
      placeholder: "期",
      onOpen: () => openPhotoSet(item.id)
    });
    const image = card.querySelector("img[data-gallery-src]");
    if (image && index < 18) {
      image.src = image.dataset.gallerySrc;
      delete image.dataset.gallerySrc;
    }
    grid.append(card);
  }
  page.append(grid);
  activateGalleryLazyImages(grid);

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "当前筛选下没有这个合集的图包";
    page.append(empty);
  } else if (visible.length < items.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "text-button gallery-more";
    more.textContent = `显示更多 ${formatNumber(visible.length)} / ${formatNumber(items.length)}`;
    more.addEventListener("click", () => {
      state.gallery.visibleLimit += 80;
      renderGalleryView();
    });
    setupGalleryMoreAutoload(more);
    page.append(more);
  }

  container.append(page);
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
  meta.textContent = `${formatNumber(total)} 组图包`;
  text.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "gallery-person-bar-actions";
  const allButton = document.createElement("button");
  allButton.type = "button";
  allButton.className = "text-button";
  allButton.textContent = "全部图包";
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

function renderPhotoCollectionsShelf(container) {
  const groups = photoCollectionGroups();
  const visible = groups.slice(0, state.gallery.visibleLimit);
  const grid = document.createElement("div");
  grid.className = "gallery-grid gallery-collections-grid";
  for (const [index, group] of visible.entries()) {
    const categories = [...group.categories].slice(0, 3).join(" · ");
    const samples = group.samples.slice(0, 2).join(" / ");
    const card = createGalleryCard(
      { title: group.title, coverUrl: group.coverUrl || "" },
      {
        meta: `${formatNumber(group.count)} 期 · ${formatBytes(group.size)}`,
        extra: [categories, photoCollectionPathLabel(group), group.updatedAt ? `最近 ${formatDateTime(group.updatedAt)}` : samples].filter(Boolean).join(" · "),
        placeholder: "合集",
        onOpen: () => {
          state.gallery.photoView = "collections";
          state.gallery.photoCollection = group.value;
          state.gallery.person = "all";
          state.gallery.visibleLimit = 80;
          renderGalleryView();
          window.scrollTo({ top: 0, behavior: "smooth" });
          syncGalleryRoute();
        }
      }
    );
    card.classList.add("gallery-collection-card");
    const image = card.querySelector("img[data-gallery-src]");
    if (image && index < 18) {
      image.src = image.dataset.gallerySrc;
      delete image.dataset.gallerySrc;
    }
    grid.append(card);
  }
  container.append(grid);
  activateGalleryLazyImages(grid);

  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.gallery.data ? "没有匹配的合集" : "正在等待图像资料库索引";
    container.append(empty);
  } else if (visible.length < groups.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "text-button gallery-more";
    more.textContent = `显示更多合集 ${formatNumber(visible.length)} / ${formatNumber(groups.length)}`;
    more.addEventListener("click", () => {
      state.gallery.visibleLimit += 80;
      renderGalleryView();
    });
    setupGalleryMoreAutoload(more);
    container.append(more);
  }
}

function renderPhotoShelf(container) {
  if (state.gallery.photoView === "collections") {
    renderPhotoCollectionsShelf(container);
    return;
  }
  const items = filteredPhotoSets();
  const visible = items.slice(0, state.gallery.visibleLimit);
  renderPhotoPersonBar(container, items.length);
  const grid = document.createElement("div");
  grid.className = "gallery-grid";
  for (const [index, item] of visible.entries()) {
    const card = createGalleryCard(item, {
      meta: [item.category, item.subCategory, item.personName].filter(Boolean).join(" · "),
      extra: `${formatBytes(item.size)} · ${formatDateTime(item.updatedAt)}`,
      placeholder: "图包",
      onOpen: () => openPhotoSet(item.id)
    });
    const image = card.querySelector("img[data-gallery-src]");
    if (image && index < 18) {
      image.src = image.dataset.gallerySrc;
      delete image.dataset.gallerySrc;
    }
    grid.append(card);
  }
  container.append(grid);
  activateGalleryLazyImages(grid);

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.gallery.data ? "没有匹配的图包" : "正在等待图像资料库索引";
    container.append(empty);
  } else if (visible.length < items.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "text-button gallery-more";
    more.textContent = `显示更多 ${formatNumber(visible.length)} / ${formatNumber(items.length)}`;
    more.addEventListener("click", () => {
      state.gallery.visibleLimit += 80;
      renderGalleryView();
    });
    setupGalleryMoreAutoload(more);
    container.append(more);
  }
}

function renderMangaShelf(container) {
  const items = filteredManga();
  const grid = document.createElement("div");
  grid.className = "gallery-grid manga-grid";
  for (const item of items) {
    grid.append(
      createGalleryCard(item, {
        meta: `${item.site} · ${formatNumber(item.chapterCount)} 话`,
        extra: `${formatNumber(item.imageCount)} 张 · ${formatDateTime(item.updatedAt)}`,
        placeholder: "韩漫",
        onOpen: () => openMangaComic(item.id)
      })
    );
  }
  container.append(grid);
  activateGalleryLazyImages(grid);
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.gallery.data ? "没有匹配的漫画" : "正在等待图像资料库索引";
    container.append(empty);
  }
}

function createMovieExploreItem(item, index) {
  const metadata = item.movieMetadata || {};
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gallery-movie-list-item";
  button.addEventListener("click", () => openGalleryMedia(item.id));

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
    poster.dataset.placeholder = "电影";
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
  local.textContent = [item.category, formatBytes(item.size), item.updatedAt ? `最近 ${formatDateTime(item.updatedAt)}` : ""].filter(Boolean).join(" · ");

  copy.append(title, meta);
  if (people.textContent) copy.append(people);
  copy.append(ratingRow, local);
  button.append(poster, copy);
  return button;
}

function renderMovieExploreSidebar(aside, items) {
  const allMovies = mediaItemsForMode("movie");
  const ratedCount = allMovies.filter((item) => Number(item.movieMetadata?.rating || 0) > 0).length;
  const totalSize = allMovies.reduce((sum, item) => sum + Number(item.size || 0), 0);

  const summary = document.createElement("section");
  summary.className = "gallery-movie-sidebar-section";
  const summaryTitle = document.createElement("h3");
  summaryTitle.textContent = "本地片库";
  const summaryList = document.createElement("div");
  summaryList.className = "gallery-movie-sidebar-stats";
  for (const [label, value] of [
    ["当前筛选", `${formatNumber(items.length)} 部`],
    ["全部电影", `${formatNumber(allMovies.length)} 部`],
    ["豆瓣资料", `${formatNumber(ratedCount)} 部`],
    ["总大小", formatBytes(totalSize)]
  ]) {
    const row = document.createElement("span");
    row.innerHTML = "<strong></strong><small></small>";
    row.querySelector("strong").textContent = value;
    row.querySelector("small").textContent = label;
    summaryList.append(row);
  }
  summary.append(summaryTitle, summaryList);

  const categories = document.createElement("section");
  categories.className = "gallery-movie-sidebar-section";
  const categoriesTitle = document.createElement("h3");
  categoriesTitle.textContent = "热门分类";
  const list = document.createElement("div");
  list.className = "gallery-movie-sidebar-links";
  for (const item of currentGalleryCategoryFacets().slice(0, 8)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = state.gallery.category === item.value ? "active" : "";
    button.innerHTML = "<span></span><small></small>";
    button.querySelector("span").textContent = item.value;
    button.querySelector("small").textContent = `${formatNumber(item.count)} 部`;
    button.addEventListener("click", () => {
      state.gallery.category = item.value;
      state.gallery.visibleLimit = 80;
      resetGalleryReader();
      renderGalleryView();
      syncGalleryRoute();
    });
    list.append(button);
  }
  categories.append(categoriesTitle, list);
  aside.append(summary, categories);
}

function renderMovieShelf(container) {
  const items = filteredMediaItems();
  const visible = items.slice(0, state.gallery.visibleLimit);

  const shell = document.createElement("section");
  shell.className = "gallery-movie-explore";

  const main = document.createElement("div");
  main.className = "gallery-movie-explore-main";
  const header = document.createElement("div");
  header.className = "gallery-movie-explore-header";
  const title = document.createElement("h2");
  title.textContent = "选电影";
  const meta = document.createElement("span");
  meta.textContent = [
    state.gallery.category !== "all" ? state.gallery.category : "全部",
    state.gallery.sort === "rating" ? "豆瓣高分" : "",
    `${formatNumber(items.length)} 部`
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
    empty.textContent = state.gallery.data ? "没有匹配的电影" : "正在等待图像资料库索引";
    main.append(empty);
  } else if (visible.length < items.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "text-button gallery-more";
    more.textContent = `显示更多 ${formatNumber(visible.length)} / ${formatNumber(items.length)}`;
    more.addEventListener("click", () => {
      state.gallery.visibleLimit += 80;
      renderGalleryView();
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

function renderMediaShelf(container) {
  if (state.gallery.mode === "movie") {
    renderMovieShelf(container);
    return;
  }
  if (state.gallery.mode === "western" && state.gallery.person === "all") {
    renderWesternPersonShelf(container);
    return;
  }
  if (state.gallery.mode === "tv" && state.gallery.person === "all") {
    renderTvSeriesShelf(container);
    return;
  }
  const items = filteredMediaItems();
  const visible = items.slice(0, state.gallery.visibleLimit);
  renderWesternPersonBar(container, items.length);
  renderTvSeriesBar(container, items.length);
  const grid = document.createElement("div");
  grid.className = "gallery-grid media-grid";
  for (const item of visible) {
    const doubanMetadata = item.mediaKind === "movie" ? item.movieMetadata : item.tvSeries;
    const cardItem = item.mediaKind === "movie"
      ? { ...item, title: movieDisplayTitle(item), coverUrl: item.movieMetadata?.coverUrl || item.coverUrl }
      : item;
    const meta = item.mediaKind === "movie"
      ? [item.category, item.movieMetadata?.year, ...(item.movieMetadata?.genres || []).slice(0, 2)].filter(Boolean).join(" · ")
      : [item.category, item.subCategory, item.mediaKind === "tv" ? item.seriesName : item.personName].filter(Boolean).join(" · ");
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
        onOpen: () => openGalleryMedia(item.id)
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
  } else if (visible.length < items.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "text-button gallery-more";
    more.textContent = `显示更多 ${formatNumber(visible.length)} / ${formatNumber(items.length)}`;
    more.addEventListener("click", () => {
      state.gallery.visibleLimit += 80;
      renderGalleryView();
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
  const query = params.toString();
  return `/api/photo-sets/${encodeURIComponent(String(albumId || ""))}${query ? `?${query}` : ""}`;
}

async function loadPhotoReaderImages(limit) {
  const album = state.gallery.album;
  if (!album?.id) return null;
  const batchSize = photoReaderBatchSize();
  const nextLimit = Math.max(batchSize, Math.floor(Number(limit || 0)) || batchSize);
  setGalleryStatus("正在继续读取图片");
  const data = await api(photoSetDetailPath(album.id, { imageLimit: nextLimit }));
  state.gallery.album = { ...album, ...(data.album || {}) };
  state.gallery.cache = data.cache || state.gallery.cache;
  setGalleryStatus("");
  renderGalleryView();
  return state.gallery.album;
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

function readerToolbar(title, meta, onBack) {
  const bar = document.createElement("div");
  bar.className = "gallery-reader-toolbar";
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
  const copy = document.createElement("div");
  copy.className = "gallery-reader-title";
  const strong = document.createElement("strong");
  strong.textContent = title || "阅读";
  const span = document.createElement("span");
  span.textContent = meta || "";
  copy.append(strong, span);
  const fit = document.createElement("button");
  fit.type = "button";
  fit.className = "text-button";
  fit.textContent = state.gallery.fitWidth ? "原始宽度" : "适应宽度";
  fit.addEventListener("click", () => {
    state.gallery.fitWidth = !state.gallery.fitWidth;
    writeStoredFlag("fanhao.gallery.fitWidth", state.gallery.fitWidth);
    renderGalleryView();
  });
  bar.append(back, copy, fit);
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
  top.append(close, heading);

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
  controls.append(prev, counter, range, next);
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
    imageNode.src = item.url;
    imageNode.alt = item.name || title || "";
    counter.textContent = `第 ${formatNumber(currentIndex + 1)} / ${formatNumber(list.length)} 张`;
    range.max = String(list.length);
    range.value = String(currentIndex + 1);
    prev.disabled = currentIndex <= 0;
    next.disabled = currentIndex >= list.length - 1;
    sub.textContent = [meta, item.name].filter(Boolean).join(" · ");
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
    rangeScrubbing = false;
    update();
    return true;
  };

  prev.addEventListener("click", () => goTo(currentIndex - 1), listenerOptions);
  next.addEventListener("click", () => goTo(currentIndex + 1), listenerOptions);
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
    if (Math.abs(dy) < 52 || Math.abs(dy) < Math.abs(dx) * 1.25) return;
    goTo(currentIndex + (dy < 0 ? 1 : -1));
  }, listenerOptions);
  overlay.addEventListener("wheel", (event) => {
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
  for (const [index, image] of list.entries()) {
    const figure = document.createElement("figure");
    figure.className = "gallery-reader-figure";
    figure.dataset.gallerySrc = image.url;
    figure.tabIndex = 0;
    figure.setAttribute("role", "button");
    figure.setAttribute("aria-label", `打开第 ${formatNumber(image.index || index + 1)} 张`);
    figure.style.minHeight = "70vh";
    const openImage = () => {
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
    img.addEventListener("load", () => {
      figure.classList.add("loaded");
      figure.style.minHeight = "";
    });
    const caption = document.createElement("figcaption");
    caption.textContent = `${formatNumber(image.index || index + 1)} / ${formatNumber(totalCount || list.length)}`;
    figure.append(img, caption);
    viewer.append(figure);
  }
  container.append(viewer);
  activateGalleryReaderImages(viewer);
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
  container.append(
    readerToolbar(album.title, meta, () => {
      state.gallery.album = null;
    })
  );
  renderReaderImages(container, images, {
    title: album.title,
    meta,
    totalCount,
    sourceKey: album.id ? `photo:${album.id}` : "",
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
  });
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
  sub.textContent = [media.kindLabel, media.category, media.mediaKind === "tv" ? media.seriesName : media.personName, metadata?.rating ? `豆瓣 ${Number(metadata.rating).toFixed(1)}` : ""].filter(Boolean).join(" · ");
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

function compactPeopleLine(label, values, limit = 8) {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!list.length) return "";
  const text = list.slice(0, limit).join(" / ");
  return `${label}：${list.length > limit ? `${text} 等` : text}`;
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
  if (state.accessMode === "local" && openAdminScript) {
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
    cover.textContent = "电影";
  }

  const facts = document.createElement("div");
  facts.className = "gallery-movie-facts";
  appendMovieFact(facts, "导演", metadata?.directors);
  appendMovieFact(facts, "编剧", metadata?.writers);
  appendMovieFact(facts, "主演", metadata?.actors);
  appendMovieFact(facts, "类型", metadata?.genres);
  appendMovieFact(facts, "制片国家/地区", metadata?.countries);
  appendMovieFact(facts, "语言", metadata?.languages);
  appendMovieFact(facts, "上映日期", metadata?.releaseDates?.length ? metadata.releaseDates : metadata?.pubdate);
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
  const metadata = isMovie ? media.movieMetadata : media.tvSeries;
  if (!isMovie) {
    const toolbar = readerToolbar(
      media.title,
      [media.kindLabel, media.category, media.mediaKind === "tv" ? media.seriesName : media.personName, formatBytes(media.size)]
        .filter(Boolean)
        .join(" · "),
      () => {
        state.gallery.media = null;
      }
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
  panel.className = `gallery-media-player${isMovie ? " gallery-media-player-movie" : ""}`;
  if (isMovie) {
    panel.append(createMovieInfoPanel(media, metadata, () => {
      state.gallery.media = null;
    }));
  }
  if (media.playable) {
    panel.append(createGalleryMediaPlayer(media, metadata));
  }

  if (isMovie) {
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

function renderGalleryCache(container) {
  const cache = state.gallery.cache || state.gallery.data?.cache || {};
  const panel = document.createElement("section");
  panel.className = "gallery-cache-panel";

  const grid = document.createElement("div");
  grid.className = "gallery-cache-grid";
  for (const [label, value] of [
    ["缓存目录", cache.root || "data\\image-reader-cache"],
    ["当前大小", formatBytes(cache.currentBytes || 0)],
    ["缓存文件", formatNumber(cache.fileCount || 0)],
    ["定时清理", cache.cleanupIntervalMs ? `${Math.round(cache.cleanupIntervalMs / 60000)} 分钟` : "-"]
  ]) {
    const item = document.createElement("div");
    item.className = "gallery-cache-item";
    item.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    grid.append(item);
  }

  const form = document.createElement("div");
  form.className = "gallery-cache-form";
  const label = document.createElement("label");
  label.textContent = "缓存上限 GB";
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0.125";
  input.step = "0.25";
  input.value = String(((cache.maxBytes || state.uiConfig.imageReaderCacheMaxBytes) / 1024 / 1024 / 1024).toFixed(2));
  label.append(input);
  const save = document.createElement("button");
  save.type = "button";
  save.className = "text-button";
  save.textContent = "保存上限";
  save.addEventListener("click", () => saveImageReaderCacheLimit(input.value, save));
  const cleanup = document.createElement("button");
  cleanup.type = "button";
  cleanup.className = "text-button";
  cleanup.textContent = "清空阅读缓存";
  cleanup.addEventListener("click", () => cleanupImageReaderCache(cleanup));
  form.append(label, save, cleanup);

  panel.append(grid, form);
  container.append(panel);
}

async function saveImageReaderCacheLimit(gbValue, button) {
  const bytes = Math.max(0, Number(gbValue) || 0) * 1024 * 1024 * 1024;
  setAdminBusy(button, true, "保存中");
  try {
    const data = await api("/api/admin/config", {
      method: "PUT",
      body: { config: normalizeUiConfig({ ...state.uiConfig, imageReaderCacheMaxBytes: bytes }) }
    });
    state.uiConfig = normalizeUiConfig(data.config);
    const cacheData = await api("/api/image-reader/cache");
    state.gallery.cache = cacheData.cache;
    renderGalleryStats();
    renderGalleryView();
  } catch (error) {
    alert(error.message || "保存失败");
  } finally {
    setAdminBusy(button, false);
  }
}

async function cleanupImageReaderCache(button) {
  const confirmed = window.confirm("只会清空 data\\image-reader-cache 中的阅读缓存，不会删除 FanHao 缓存或原始压缩包。确定清空吗？");
  if (!confirmed) return;
  setAdminBusy(button, true, "清理中");
  try {
    const data = await api("/api/image-reader/cache/cleanup?force=1", { method: "POST" });
    state.gallery.cache = data.status || data.cache || state.gallery.cache;
    renderGalleryStats();
    renderGalleryView();
  } catch (error) {
    alert(error.message || "清理失败");
  } finally {
    setAdminBusy(button, false);
  }
}

function renderGalleryView() {
  const searchValueToRestore = activeGallerySearchValue();
  resetGalleryRenderedState();

  els.workGrid.innerHTML = "";
  const shell = document.createElement("section");
  shell.className = "gallery-shell";
  shell.append(renderGalleryControls({ searchValue: searchValueToRestore }));

  const content = document.createElement("div");
  content.className = "gallery-content";
  renderGalleryContent(content);
  shell.append(content);
  els.workGrid.append(shell);
  if (searchValueToRestore !== null) restoreGallerySearchFocus();
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
