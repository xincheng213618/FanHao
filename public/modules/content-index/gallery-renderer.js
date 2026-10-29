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
  let galleryListRegistration = null;
  let gallerySummaryRegistration = null;
  let gallerySummaryGeneration = 0;
  let galleryReaderObserver = null;
  let galleryReaderScrollCleanup = null;
  let galleryReaderImageQueue = [];
  let activeGalleryReaderImageLoads = 0;
  let galleryReaderImageGeneration = 0;
  let galleryReaderStartupFigure = null;
  let galleryReaderRegistration = null;
  let galleryReaderWidthRestore = null;
  let galleryMoreScrollCleanup = null;
  let galleryMoreGestureConsumed = false;
  let galleryMoreGestureReleaseTimer = 0;
  let galleryPagerCleanup = null;
  let galleryScrollRestoreGeneration = 0;
  let galleryListReturnRestore = null;
  const gallerySelectValues = new WeakMap();
  const photoCategoryStrips = new WeakMap();
  let mediaLayout = "posters";
  try {
    if (window.localStorage.getItem("fanhao.media.layout") === "list") mediaLayout = "list";
  } catch { /* Browsing still works when storage is unavailable. */ }

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
    if (mode === "manga") {
      window.location.assign("/manga");
      return;
    }
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

function currentPhotoCategoryStrip(record) {
  const strip = record.strip, controls = strip.closest(".gallery-controls");
  return strip.isConnected && state.activeView === "gallery" && state.gallery.mode === "photo" && !state.gallery.photoCollection
    && !state.gallery.album && !state.gallery.comic && !state.gallery.media
    && controls === els.workGrid.querySelector(".gallery-shell > .gallery-controls")
    && controls?.querySelector(".gallery-photo-category-strip") === strip;
}

function createPhotoCategoryButton(record, value, withCount) {
  const button = document.createElement("button"), text = document.createTextNode("");
  button.type = "button";
  button.append(text);
  const entry = { value, button, text, alive: true };
  if (withCount) {
    entry.count = document.createElement("small");
    entry.count.setAttribute("aria-hidden", "true");
    entry.countText = document.createTextNode("");
    entry.count.append(entry.countText);
    button.append(entry.count);
  }
  button.addEventListener("click", () => {
    if (!entry.alive || !button.isConnected || !record.strip.contains(button) || !currentPhotoCategoryStrip(record)) return;
    if ((state.gallery.category || "all") === entry.value && !state.gallery.photoCollection) return;
    state.gallery.photoView = "collections";
    state.gallery.photoCollection = null;
    state.gallery.sort = "count";
    state.gallery.category = entry.value;
    state.gallery.subCategory = "all";
    state.gallery.person = "all";
    state.gallery.seriesKey = "";
    state.gallery.photoDate = "all";
    state.gallery.visibleLimit = 80;
    resetGalleryReader();
    renderGalleryView();
    syncGalleryRoute();
  });
  return entry;
}

function updatePhotoCategoryButton(entry, label, count) {
  const active = (state.gallery.category || "all") === entry.value;
  const className = `gallery-category-chip${active ? " active" : ""}`;
  if (entry.button.className !== className) entry.button.className = className;
  if (entry.text.data !== label) entry.text.data = label;
  if (entry.button.getAttribute("aria-pressed") !== String(active)) entry.button.setAttribute("aria-pressed", String(active));
  if (count === undefined) {
    if (entry.button.hasAttribute("title")) entry.button.removeAttribute("title");
    if (entry.button.hasAttribute("aria-label")) entry.button.removeAttribute("aria-label");
  } else {
    const title = `${label} · ${formatNumber(count)} 期`;
    if (entry.button.title !== title) entry.button.title = title;
    const ariaLabel = `${label}，${formatNumber(count)} 期`;
    if (entry.button.getAttribute("aria-label") !== ariaLabel) entry.button.setAttribute("aria-label", ariaLabel);
  }
  if (entry.countText) {
    const text = String(formatNumber(count || 0));
    if (entry.countText.data !== text) entry.countText.data = text;
  }
}

function syncPhotoCategoryButtons(record, container, previous, facets, withCount, first = null, end = null) {
  const available = new Map();
  for (const entry of previous) {
    if (!available.has(entry.value)) available.set(entry.value, { entries: [], next: 0 });
    available.get(entry.value).entries.push(entry);
  }
  const retained = new Set(), entries = [];
  let focused = -1;
  for (const facet of facets) {
    const matches = available.get(facet.value);
    const entry = matches?.entries[matches.next++] || createPhotoCategoryButton(record, facet.value, withCount);
    updatePhotoCategoryButton(entry, photoCategoryDisplayName(facet.value), facet.count);
    if (entry.button === document.activeElement && entry.button.parentElement === container) focused = entries.length;
    entries.push(entry); retained.add(entry);
  }
  for (const entry of previous) if (!retained.has(entry)) { entry.alive = false; entry.button.remove(); }
  const place = (entry, before) => {
    if (entry.button !== before) container.insertBefore(entry.button, before || end);
    return entry.button.nextSibling;
  };
  let before = first ? first.nextSibling : container.firstChild;
  const prefix = focused < 0 ? entries.length : focused;
  for (let index = 0; index < prefix; index++) before = place(entries[index], before);
  if (focused >= 0) {
    // Moving the focused button itself would blur it even within one parent.
    before = entries[focused].button.nextSibling;
    for (let index = focused + 1; index < entries.length; index++) before = place(entries[index], before);
  }
  return entries;
}

function syncPhotoCategoryStrip(record) {
  const { strip } = record, active = document.activeElement;
  const ownedFocus = strip.contains(active), panel = record.menu?.panel;
  const focusedMenuButton = panel?.contains(active) && active.matches("button");
  const focusedTop = focusedMenuButton ? active.getBoundingClientRect().top : 0;
  const facets = currentGalleryCategoryFacets().filter((item) => !Object.values(MEDIA_KIND_CATEGORY_VALUES).includes(item.value));
  const featured = facets.slice(0, 4);
  let selected, total = 0;
  for (const facet of facets) {
    total += Number(facet.count || 0);
    if (selected === undefined && facet.value === state.gallery.category) selected = facet;
  }
  if (selected && !featured.includes(selected)) featured[featured.length - 1] = selected;
  updatePhotoCategoryButton(record.all, "全部大类", total);
  const needsMenu = facets.length > featured.length;
  if (needsMenu && !record.menu) {
    const details = document.createElement("details");
    details.className = "gallery-category-menu";
    const summary = document.createElement("summary");
    const text = document.createTextNode(""); summary.append(text);
    const nextPanel = document.createElement("div");
    nextPanel.className = "gallery-category-menu-panel";
    nextPanel.setAttribute("role", "group");
    nextPanel.setAttribute("aria-label", "全部套图分类");
    record.menu = { details, summary, text, panel: nextPanel, entries: [] };
    details.append(summary, nextPanel); strip.append(details);
    details.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !details.isConnected || !strip.contains(details) || record.menu?.details !== details || !currentPhotoCategoryStrip(record)) return;
      details.open = false;
      summary.focus();
    });
  } else if (!needsMenu && record.menu) {
    for (const entry of record.menu.entries) entry.alive = false;
    record.menu.details.remove(); record.menu = null;
  }
  record.featured = syncPhotoCategoryButtons(record, strip, record.featured, featured, false, record.all.button, record.menu?.details || null);
  if (record.menu) {
    const text = `全部分类 · ${formatNumber(facets.length)}`;
    if (record.menu.text.data !== text) record.menu.text.data = text;
    record.menu.entries = syncPhotoCategoryButtons(record, record.menu.panel, record.menu.entries, facets, true);
  }
  return () => {
    if (!currentPhotoCategoryStrip(record)) return;
    if (ownedFocus && !active.isConnected && document.activeElement === document.body) {
      (record.menu?.summary || record.all.button).focus({ preventScroll: true });
    } else if (focusedMenuButton && record.menu?.panel === panel && document.activeElement === active && panel.contains(active)) {
      const delta = active.getBoundingClientRect().top - focusedTop;
      if (delta) panel.scrollTop += delta;
    }
  };
}

function createPhotoCategoryStrip(options = {}) {
  const previous = options.reusePhotoCategoryStrip;
  const record = previous && photoCategoryStrips.get(previous);
  if (record) {
    options.finishPhotoCategoryUpdate = syncPhotoCategoryStrip(record);
    const slot = document.createElement("span");
    slot.dataset.galleryPhotoCategorySlot = "true";
    return slot;
  }
  const strip = document.createElement("div");
  strip.className = "gallery-category-strip gallery-photo-category-strip";
  strip.setAttribute("role", "group"); strip.setAttribute("aria-label", "套图大类");
  const next = { strip, featured: [], menu: null };
  next.all = createPhotoCategoryButton(next, "all", false); strip.append(next.all.button);
  photoCategoryStrips.set(strip, next);
  syncPhotoCategoryStrip(next);
  return strip;
}

function galleryBrowseDescription() {
  return state.gallery.mode === "photo"
    ? state.gallery.data ? `${formatNumber(state.gallery.data.totals?.photoSets || 0)} 期套图，按合集与分类浏览` : "按合集与分类浏览套图"
    : "电影、电视剧与动漫";
}

function createGalleryBrowseHeader() {
  const isPhoto = state.gallery.mode === "photo";
  const header = document.createElement("header");
  header.className = "gallery-browse-header";
  const copy = document.createElement("div");
  const eyebrow = document.createElement("span");
  eyebrow.className = "gallery-browse-eyebrow";
  eyebrow.textContent = "我的资料库";
  const title = document.createElement("h1");
  title.textContent = isPhoto ? "套图图库" : "影视资料库";
  const description = document.createElement("p");
  description.textContent = galleryBrowseDescription();
  copy.append(eyebrow, title, description);
  const nav = document.createElement("nav");
  nav.className = "gallery-browse-nav";
  nav.setAttribute("aria-label", "资料库导航");
  for (const [label, href, active] of [["套图", "/photo/collections", isPhoto], ["影视", "/media", !isPhoto], ["韩漫", "/manga", false]]) {
    const link = document.createElement("a");
    link.textContent = label;
    link.href = href;
    if (active) link.setAttribute("aria-current", "page");
    nav.append(link);
  }
  header.append(copy, nav);
  return header;
}

function createGalleryResultsHeader(titleText, detailText) {
  const header = document.createElement("div");
  header.className = "gallery-results-header";
  const copy = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = titleText;
  const detail = document.createElement("span");
  detail.textContent = detailText;
  detail.setAttribute("role", "status");
  copy.append(title, detail);
  header.append(copy);
  return header;
}

function gallerySelectOption(label, value, count) {
  const text = label === undefined ? "" : String(label);
  return { label: text, value: value === undefined ? text : String(value), title: count !== undefined ? `${label} · ${formatNumber(count)}` : "" };
}

function syncGallerySelectOptions(select, spec) {
  const selected = select.value;
  const available = new Map();
  for (const option of select.options) {
    if (!available.has(option.value)) available.set(option.value, { options: [], next: 0 });
    available.get(option.value).options.push(option);
  }
  const retained = new Set();
  for (const [index, item] of spec.options.entries()) {
    const matches = available.get(item.value);
    const option = matches?.options[matches.next++] || new Option(item.label, item.value);
    if (option.textContent !== item.label) option.textContent = item.label;
    if (option.title !== item.title) option.title = item.title;
    if (select.options[index] !== option) select.insertBefore(option, select.options[index] || null);
    retained.add(option);
  }
  for (const option of [...select.options]) if (!retained.has(option)) option.remove();
  // An unchanged committed value must not reset a native selection in progress.
  const value = String(spec.value);
  if (!gallerySelectValues.has(select) || gallerySelectValues.get(select) !== value || !spec.options.some(option => option.value === selected)) {
    if (select.value !== value) select.value = value;
  } else if (select.value !== selected) select.value = selected;
  gallerySelectValues.set(select, value);
}

function renderGallerySelectControl(controls, options, key, spec, onChange) {
  const previous = options.reuseSelects?.get(key);
  const select = previous || document.createElement("select");
  if (select.dataset.galleryControl !== key) select.dataset.galleryControl = key;
  if (select.className !== spec.className) select.className = spec.className;
  if (spec.label === undefined) {
    if (select.hasAttribute("aria-label")) select.removeAttribute("aria-label");
  } else if (select.getAttribute("aria-label") !== spec.label) select.setAttribute("aria-label", spec.label);
  if (select.disabled !== Boolean(spec.disabled)) select.disabled = Boolean(spec.disabled);
  syncGallerySelectOptions(select, spec);
  if (previous) {
    // The detached blueprint describes a slot; it never adopts a live control.
    const slot = document.createElement("span");
    slot.dataset.gallerySelectSlot = key;
    return slot;
  }
  const mode = state.gallery.mode;
  select.addEventListener("change", () => {
    if (!select.isConnected || !controls.isConnected || !controls.contains(select) || state.activeView !== "gallery"
        || state.gallery.mode !== mode || els.workGrid.querySelector(".gallery-shell > .gallery-controls") !== controls) return;
    onChange(select);
  });
  return select;
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
    if (list) {
      const badge = document.createElement("small");
      badge.textContent = formatNumber(count);
      badge.setAttribute("aria-hidden", "true");
      button.append(badge);
      button.title = `${label} · ${formatNumber(count)}`;
      button.setAttribute("aria-label", `${label}，${formatNumber(count)} 项`);
    }
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
  controls.dataset.galleryMode = state.gallery.mode;
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
  let composing = false;
  search.addEventListener("compositionstart", () => { composing = true; });
  search.addEventListener("compositionend", () => { composing = false; });
  search.addEventListener("search", () => {
    if (composing) return;
    if (!search.value && state.gallery.query) submitGallerySearch("");
  });
  search.addEventListener("keydown", (event) => {
    // Confirmation/cancellation belongs to the IME, including its trailing
    // keyCode 229 after compositionend on engines that clear isComposing early.
    if (composing || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
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

  // Only construct selects that this mode mounts. Large facet sets otherwise
  // create hundreds of detached options on every page/summary refresh.
  let category = null;
  if (mediaModule) {
    const categoryOptions = [gallerySelectOption(state.gallery.mode === "photo" ? "全部大类" : state.gallery.mode === "tv" ? "全部地区" : "全部片库分区", "all")];
    const categoryFacets = currentGalleryCategoryFacets().filter((item) => !Object.values(MEDIA_KIND_CATEGORY_VALUES).includes(item.value));
    for (const item of categoryFacets) {
      const label = state.gallery.mode === "photo" ? photoCategoryDisplayName(item.value) : galleryCategoryDisplayName(item.value);
      categoryOptions.push(gallerySelectOption(label, item.value, item.count));
    }
    if (
      state.gallery.category !== "all" &&
      !categoryFacets.some((item) => item.value === state.gallery.category)
    ) {
      const label = state.gallery.mode === "photo" ? photoCategoryDisplayName(state.gallery.category) : galleryCategoryDisplayName(state.gallery.category);
      categoryOptions.push(gallerySelectOption(label, state.gallery.category));
    }
    category = renderGallerySelectControl(controls, options, "category", {
      className: "gallery-select", label: state.gallery.mode === "photo" ? "套图分类" : "分类", value: state.gallery.category, options: categoryOptions
    }, select => {
      state.gallery.category = select.value || "all";
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
  }

  let people = null;
  if (["western", "tv"].includes(state.gallery.mode)) {
    const peopleOptions = [gallerySelectOption(state.gallery.mode === "tv" ? "全部作品" : "全部人物", "all")];
    const peopleFacets = currentGalleryPeopleFacets().slice(0, state.gallery.mode === "tv" ? 1000 : 300);
    for (const item of peopleFacets) {
      peopleOptions.push(gallerySelectOption(state.gallery.mode === "photo" ? photoPersonDisplayName(item.value) : item.value, item.value, item.count));
    }
    if (
      state.gallery.person !== "all" &&
      !peopleFacets.some((item) => item.value === state.gallery.person)
    ) {
      peopleOptions.push(gallerySelectOption(photoPersonDisplayName(state.gallery.person), state.gallery.person));
    }
    people = renderGallerySelectControl(controls, options, "people", { className: "gallery-select", value: state.gallery.person, options: peopleOptions }, select => {
      const nextPerson = select.value || "all";
      state.gallery.photoCollection = null;
      state.gallery.person = nextPerson;
      state.gallery.seriesKey = "";
      state.gallery.visibleLimit = 80;
      resetGalleryReader();
      renderGalleryView();
      syncGalleryRoute();
    });
  }

  const photoSearchActive = state.gallery.mode === "photo" && Boolean(String(state.gallery.query || "").trim());
  const sortOptions = photoSearchActive
    ? [["updated", "相关性排序"]]
    : state.gallery.mode === "photo"
      ? state.gallery.photoView === "collections" && !state.gallery.photoCollection
        ? PHOTO_COLLECTION_SORT_OPTIONS
        : PHOTO_ALBUM_SORT_OPTIONS
      : MEDIA_SORT_OPTIONS;
  if (!sortOptions.some(([value]) => value === state.gallery.sort)) state.gallery.sort = "updated";
  let sort = null;
  if (["photo", "movie", "media"].includes(state.gallery.mode)) {
    sort = renderGallerySelectControl(controls, options, "sort", {
      className: "gallery-select gallery-sort-select", label: "排序", disabled: photoSearchActive, value: state.gallery.sort || "updated",
      options: sortOptions.map(([value, label]) => gallerySelectOption(label, value))
    }, select => {
      state.gallery.sort = select.value || "updated";
      state.gallery.visibleLimit = 80;
      resetGalleryReader();
      renderGalleryView();
      syncGalleryRoute();
    });
  }

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
    searchRow.dataset.galleryControlRow = "search";
    const hierarchy = document.createElement("div");
    hierarchy.className = "gallery-control-row gallery-hierarchy-row";
    hierarchy.dataset.galleryControlRow = "facets";
    const maintenance = document.createElement("div");
    maintenance.className = "gallery-maintenance";
    maintenance.append(refresh, status);

    if (state.gallery.mode === "photo") {
      controls.classList.add("gallery-photo-controls");
      searchRow.classList.add("gallery-photo-primary-row");
      search.placeholder = "搜索标题、人物、合集";
      const searchBox = document.createElement("div");
      searchBox.className = "gallery-media-search-box";
      const submit = document.createElement("button");
      submit.type = "button";
      submit.className = "gallery-media-search-submit";
      submit.textContent = "搜索";
      submit.addEventListener("click", () => submitGallerySearch(search.value, { restoreFocus: true }));
      searchBox.append(search, submit);
      searchRow.append(
        createGalleryFilterField("搜索", searchBox, "gallery-search-field gallery-photo-search-field"),
        maintenance
      );

      hierarchy.classList.add("gallery-photo-secondary-row");
      // Inside a collection, its breadcrumb owns navigation. Its local facets
      // must not be presented as the categories or totals of the whole library.
      if (state.gallery.photoCollection) hierarchy.classList.add("gallery-photo-collection-controls");
      hierarchy.append(
        ...(!state.gallery.photoCollection ? [createPhotoCategoryStrip(options)] : []),
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
  searchRow.dataset.galleryControlRow = "search";
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
  filterRow.dataset.galleryControlRow = "facets";
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
  // Later renders restore their own focus; retries would override newer input.
  const search = els.workGrid?.querySelector(".gallery-search");
  search?.focus({ preventScroll: true });
  search?.setSelectionRange?.(search.value.length, search.value.length);
}

function activeGallerySearchValue() {
  const active = document.activeElement;
  return active?.classList?.contains("gallery-search") ? active.value : null;
}

function resetGalleryRenderedState() {
  galleryListReturnRestore?.abort();
  galleryListReturnRestore = null;
  galleryReaderWidthRestore = null;
  galleryListRegistration = null;
  gallerySummaryRegistration = null;
  gallerySummaryGeneration += 1;
  disconnectPeopleIndexAutoload();
  cancelScheduledWorkRendering();
  resetProgressiveCoverLoading();
  galleryReaderImageGeneration += 1;
  galleryReaderImageQueue = [];
  activeGalleryReaderImageLoads = 0;
  galleryReaderStartupFigure = null;
  galleryReaderRegistration = null;
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
    return (list.items || []).map(westernPersonListGroup);
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

function westernPersonListGroup(item) {
  return {
    personName: item.personName || item.title || "未归类",
    count: Number(item.videoCount || 0),
    playableCount: Number(item.playableCount || 0),
    size: Number(item.size || 0),
    updatedAt: item.updatedAt || "",
    coverUrl: item.coverUrl || "",
    categories: new Map((item.categories || []).map((entry) => [entry.value, entry.count])),
    samples: item.samples || []
  };
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
    return (list.items || []).map(tvSeriesListGroup);
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

function tvSeriesListGroup(item) {
  return {
    value: item.seriesKey || item.id,
    title: item.seriesName || item.title,
    category: item.category || "",
    count: Number(item.episodeCount || item.chapterCount || 0),
    size: Number(item.size || 0),
    updatedAt: item.updatedAt || "",
    samples: [],
    coverUrl: item.coverUrl || "",
    tvSeries: item.tvSeries || null
  };
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

function createTvSeriesCard(group) {
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
  return card;
}

function renderTvSeriesShelf(container) {
  const groups = tvSeriesGroups();
  const visible = groups.slice(0, state.gallery.visibleLimit);
  const list = currentImageLibraryList();
  const total = Number(list?.total ?? groups.length);
  const grid = document.createElement("div");
  grid.className = "gallery-grid media-grid gallery-tv-series-grid";
  for (const group of visible) grid.append(createTvSeriesCard(group));
  container.append(grid);
  activateGalleryLazyImages(grid);

  if (list) {
    registerGalleryList(grid, list, item => createTvSeriesCard(tvSeriesListGroup(item)), {
      items: (list.items || []).slice(0, state.gallery.visibleLimit),
      visible: next => (next.items || []).slice(0, state.gallery.visibleLimit),
      label: "作品", moreParent: container
    });
    if (galleryListRegistration?.grid === grid) {
      updateGalleryListMore();
      return;
    }
  }

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

function createWesternPersonCard(group) {
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
  return card;
}

function renderWesternPersonShelf(container) {
  const groups = westernPersonGroups();
  const visible = groups.slice(0, state.gallery.visibleLimit);
  const list = currentImageLibraryList();
  const total = Number(list?.total ?? groups.length);
  const grid = document.createElement("div");
  grid.className = "gallery-grid media-grid gallery-western-person-grid";
  for (const group of visible) grid.append(createWesternPersonCard(group));
  container.append(grid);
  activateGalleryLazyImages(grid);

  if (list && state.gallery.person === "all") {
    registerGalleryList(grid, list, item => createWesternPersonCard(westernPersonListGroup(item)), {
      items: (list.items || []).slice(0, state.gallery.visibleLimit),
      visible: next => (next.items || []).slice(0, state.gallery.visibleLimit),
      label: "人物", moreParent: container
    });
    if (galleryListRegistration?.grid === grid) {
      updateGalleryListMore();
      return;
    }
  }

  if (!groups.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = state.gallery.data ? "没有匹配的欧美人物" : "正在等待图像资料库索引";
    container.append(empty);
  } else if (visible.length < total && list?.hasMore !== false) {
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

function activateGalleryLazyImages(root, options = {}) {
  if (galleryCoverObserver && !options.append) {
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
  if (!galleryCoverObserver) galleryCoverObserver = new IntersectionObserver(
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

function galleryListItemKey(item) {
  const id = String(item?.id || item?.collectionId || item?.routePath || "");
  return id ? `${String(item?.type || "")}:${id}` : "";
}

function registerGalleryList(grid, list, createItem, options = {}) {
  const items = options.items || list.items || [];
  const keys = items.map(galleryListItemKey);
  if (!keys.length || keys.some(key => !key) || new Set(keys).size !== keys.length || grid.children.length !== keys.length) return;
  galleryListRegistration = {
    key: list.key, grid, list, createItem, options,
    entries: new Map(keys.map((key, index) => [key, { item: items[index], node: grid.children[index] }]))
  };
}

function refreshGalleryControls() {
  const description = els.workGrid.querySelector(".gallery-browse-header p");
  if (description) description.textContent = galleryBrowseDescription();
  const controls = els.workGrid.querySelector(".gallery-shell > .gallery-controls");
  if (!controls) return;
  if (controls.dataset.galleryMode !== state.gallery.mode) {
    renderGalleryView({ preserveScroll: true });
    return;
  }
  const active = document.activeElement;
  const search = controls.querySelector(".gallery-search");
  const selects = new Map([...controls.querySelectorAll("select[data-gallery-control]")].map(select => [select.dataset.galleryControl, select]));
  const categoryStrip = controls.querySelector(".gallery-photo-category-strip");
  const controlOptions = { searchValue: search?.value, reuseSelects: selects, reusePhotoCategoryStrip: categoryStrip };
  const replacement = renderGalleryControls(controlOptions);
  const oldField = search?.closest(".gallery-search-field, .gallery-media-search-field");
  const newField = replacement.querySelector(".gallery-search")?.closest(".gallery-search-field, .gallery-media-search-field");
  const rows = [...controls.children], nextRows = [...replacement.children];
  const plans = [], reused = new Set();
  let compatible = Boolean(oldField && newField && rows.length === 2 && nextRows.length === 2);
  for (const [index, next] of nextRows.entries()) {
    const row = rows[index], keep = new Map();
    if (!row || row.dataset.galleryControlRow !== next.dataset.galleryControlRow) { compatible = false; break; }
    if (newField?.parentElement === next) {
      if (oldField?.parentElement !== row) { compatible = false; break; }
      keep.set(newField, oldField);
    }
    const categorySlot = next.querySelector("[data-gallery-photo-category-slot]");
    if (categorySlot) {
      if (!categoryStrip || categoryStrip.parentElement !== row || categorySlot.parentElement !== next) { compatible = false; break; }
      keep.set(categorySlot, categoryStrip);
    }
    for (const slot of next.querySelectorAll("[data-gallery-select-slot]")) {
      const key = slot.dataset.gallerySelectSlot, select = selects.get(key);
      const group = select?.parentElement, nextGroup = slot.parentElement;
      if (!group?.classList.contains("gallery-control-group") || group.parentElement !== row || nextGroup.parentElement !== next || reused.has(key)) {
        compatible = false; break;
      }
      keep.set(nextGroup, group);
      reused.add(key);
    }
    const protectedChildren = new Set(keep.values());
    const existing = [...row.children].filter(child => protectedChildren.has(child));
    const wanted = [...next.children].filter(child => keep.has(child)).map(child => keep.get(child));
    if (existing.length !== wanted.length || existing.some((child, childIndex) => child !== wanted[childIndex])) compatible = false;
    plans.push({ row, next, keep, protectedChildren });
  }
  if (!compatible || reused.size !== selects.size) {
    renderGalleryView({ preserveScroll: true });
    return;
  }
  if (controls.className !== replacement.className) controls.className = replacement.className;
  for (const { row, next, keep, protectedChildren } of plans) {
    if (row.className !== next.className) row.className = next.className;
    // Only unprotected siblings are replaced. Search fields, native selects,
    // their labels/groups and both live rows never pass through the blueprint.
    for (const child of [...row.children]) if (!protectedChildren.has(child)) child.remove();
    let before = row.firstChild;
    for (const child of [...next.children]) {
      const retained = keep.get(child);
      if (retained) {
        if (retained.classList.contains("gallery-control-group")) {
          if (retained.className !== child.className) retained.className = child.className;
          if (retained.getAttribute("aria-label") !== child.getAttribute("aria-label")) retained.setAttribute("aria-label", child.getAttribute("aria-label"));
          const label = retained.querySelector(".gallery-control-label"), nextLabel = child.querySelector(".gallery-control-label");
          if (label && nextLabel && label.textContent !== nextLabel.textContent) label.textContent = nextLabel.textContent;
        }
        before = retained.nextSibling;
      } else row.insertBefore(child, before);
    }
  }
  controlOptions.finishPhotoCategoryUpdate?.();
  if (controls.contains(active) && active.isConnected && document.activeElement === document.body) {
    active.focus?.({ preventScroll: true });
  }
}

function galleryListMoreState(list) {
  const shown = list.items?.length || 0;
  return { shown, total: Number(list.total || shown), hasMore: list.hasMore !== false && Number(list.rawLoaded ?? shown) < Number(list.total || shown) };
}

function updateGalleryListMore() {
  const registration = galleryListRegistration;
  if (!registration) return;
  const list = currentImageLibraryList(), page = getGalleryPage();
  if (!list) return;
  const { shown, total, hasMore } = galleryListMoreState(list);
  const parent = registration.options.moreParent;
  let button = parent?.querySelector(":scope > .gallery-more");
  if (!hasMore) {
    button?.remove();
    if (galleryMoreScrollCleanup) { galleryMoreScrollCleanup(); galleryMoreScrollCleanup = null; }
    return;
  }
  if (!button && parent) {
    button = document.createElement("button");
    button.type = "button"; button.className = "text-button gallery-more";
    button.addEventListener("click", () => showMoreGalleryList(registration.options.label));
    parent.append(button); setupGalleryMoreAutoload(button);
  }
  if (!button) return;
  const loading = page.isImageLibraryListLoading?.();
  const error = state.gallery.listErrorKey === registration.key && state.gallery.listError;
  button.disabled = Boolean(loading);
  button.setAttribute("aria-busy", String(Boolean(loading)));
  button.textContent = `${loading ? "正在加载" : error ? "重试 · 显示更多" : "显示更多"}${registration.options.label || ""} ${formatNumber(shown)} / ${formatNumber(total)}`;
  if (!loading) delete button.dataset.autoloading;
}

function showMoreGalleryList(label = "") {
  const page = getGalleryPage();
  if (page.isImageLibraryListLoading?.()) return;
  const list = currentImageLibraryList();
  if (!list) return;
  const { shown, total, hasMore } = galleryListMoreState(list);
  if (!hasMore) return;
  if (state.gallery.listErrorKey !== list.key || !state.gallery.listError) {
    state.gallery.visibleLimit = Math.min(total, Math.max(shown, Number(state.gallery.visibleLimit || 80)) + 80);
  }
  if (!refreshGalleryList({ loading: true })) {
    if (["photo", "manga"].includes(state.gallery.mode)) renderGalleryResults({ preserveScroll: true });
    else renderGalleryView({ preserveScroll: true });
  }
  if (page.imageLibraryListNeedsLoad?.()) void page.loadImageLibraryItems?.({ renderStart: false });
  else refreshGalleryList({ listChanged: true });
}

function refreshGalleryList(options = {}) {
  if (state.activeView !== "gallery" || state.gallery.album || state.gallery.comic || state.gallery.media) return false;
  if (!options.readerActive && refreshGallerySummaryContent(options)) return true;
  const registration = galleryListRegistration, list = currentImageLibraryList();
  if (!registration?.grid.isConnected || !list || registration.key !== list.key) return false;
  if (options.loading !== undefined) { updateGalleryListMore(); return true; }
  const visible = registration.options.visible ? registration.options.visible(list) : list.items || [];
  const keys = visible.map(galleryListItemKey);
  const previousKeys = [...registration.entries.keys()];
  // A changed ordering/removal requires the existing complete render contract.
  if (keys.some(key => !key) || new Set(keys).size !== keys.length || previousKeys.some((key, index) => keys[index] !== key)) return false;
  const scroll = captureGalleryScrollPosition();
  for (const [index, item] of visible.entries()) {
    const key = keys[index], previous = registration.entries.get(key);
    if (previous && (previous.item === item || JSON.stringify(previous.item) === JSON.stringify(item))) { previous.item = item; continue; }
    const node = registration.createItem(item, index);
    if (previous) {
      const focused = previous.node.contains(document.activeElement);
      for (const image of previous.node.querySelectorAll("img")) galleryCoverObserver?.unobserve(image);
      previous.node.replaceWith(node);
      if (focused) node.focus({ preventScroll: true });
    } else registration.grid.append(node);
    registration.entries.set(key, { item, node });
    activateGalleryLazyImages(node, { append: true });
  }
  registration.list = list;
  if (options.listChanged) {
    registration.options.refreshMetadata?.(list);
    const summary = els.workGrid.querySelector(".gallery-content .gallery-search-summary");
    if (summary) {
      const replacement = document.createElement("div");
      renderPagedImageLibrarySearchSummary(replacement, list);
      if (replacement.firstElementChild) summary.replaceWith(replacement.firstElementChild);
    }
    refreshGalleryControls();
  } else refreshGalleryControls();
  updateGalleryListMore();
  // Existing rows retain geometry; avoid a full-tree synchronous scrollHeight read.
  if (window.scrollX !== scroll.left || window.scrollY !== scroll.top) window.scrollTo({ left: scroll.left, top: scroll.top, behavior: "auto" });
  return true;
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
  const cancelWidthRestoreForInput = (event) => {
    if (galleryReaderWidthRestore?.viewer !== root) return;
    const target = event.target instanceof Element ? event.target : null;
    if (event.type === "keydown") {
      if (!["PageUp", "PageDown", "Home", "End", " ", "ArrowUp", "ArrowDown"].includes(event.key)) return;
      if (target?.closest("input, select, textarea, [contenteditable='true']") || event.key === " " && target?.closest("button, a")) return;
    }
    if (event.type === "pointerdown" && target?.closest("button, input, select, textarea, a")) return;
    if (event.type === "focusin" && target?.closest(".gallery-reader-fit-group")) return;
    galleryReaderWidthRestore = null;
  };
  const widthInputTypes = ["wheel", "touchmove", "pointerdown", "keydown", "focusin"];
  for (const type of widthInputTypes) window.addEventListener(type, cancelWidthRestoreForInput, { passive: true });
  let checkNewFigures = null;
  galleryReaderRegistration = {
    root,
    register(newFigures) {
      figures.push(...newFigures);
      if (galleryReaderObserver) for (const figure of newFigures) galleryReaderObserver.observe(figure);
      else checkNewFigures?.();
      requestProgress();
    }
  };
  window.addEventListener("scroll", requestProgress, { passive: true });
  window.addEventListener("resize", requestProgress);
  galleryReaderScrollCleanup = () => {
    window.removeEventListener("scroll", requestProgress);
    window.removeEventListener("resize", requestProgress);
    for (const type of widthInputTypes) window.removeEventListener(type, cancelWidthRestoreForInput);
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
  checkNewFigures = requestCheck;
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
    // This queue already owns the preload window and concurrency slot. Native
    // lazy deferral can otherwise occupy every slot without starting a request.
    img.loading = "eager";
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
    gallerySummaryRegistration = { content: container, key: page.imageLibraryListKey?.() || "", generation: gallerySummaryGeneration, panel: null, complete: false };
    renderGallerySummaryState(gallerySummaryRegistration);
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

function refreshGallerySummaryContent(options) {
  const registration = gallerySummaryRegistration;
  if (!registration?.content.isConnected || registration.key !== getGalleryPage().imageLibraryListKey?.()) return false;
  if (!state.gallery.data) {
    renderGallerySummaryState(registration);
    if (options.summaryChanged) refreshGalleryControls();
    return true;
  }
  const content = registration.content;
  content.replaceChildren();
  renderGalleryContent(content);
  if (options.summaryChanged) refreshGalleryControls();
  // Keep the initial list response on the same browse shell as the summary:
  // an input composition must not be detached by either asynchronous receipt.
  if (currentImageLibraryList()) {
    registration.complete = true;
    gallerySummaryRegistration = null;
  }
  return true;
}

function renderGallerySummaryState(registration) {
  const page = getGalleryPage();
  const failure = page.getSummaryReadFailure?.();
  let panel = registration.panel;
  if (!panel) {
    panel = document.createElement("div");
    panel.className = "empty-state gallery-list-state gallery-summary-state";
    panel.append(document.createElement("span"));
    registration.panel = panel;
    registration.content.append(panel);
  }
  panel.classList.toggle("gallery-summary-recovery", Boolean(failure));
  panel.setAttribute("role", failure ? "alert" : "status");
  panel.firstElementChild.textContent = failure?.message || "正在读取图库概览";
  let retry = panel.querySelector(".gallery-summary-retry");
  if (!failure) { retry?.remove(); return; }
  if (!retry) {
    retry = document.createElement("button");
    retry.type = "button";
    retry.className = "text-button gallery-summary-retry";
    retry.textContent = "重试读取图库概览";
    let busy = false;
    retry.addEventListener("click", async () => {
      const owns = () => gallerySummaryRegistration === registration && registration.content.isConnected
        && panel.isConnected && panel.contains(retry) && state.activeView === "gallery"
        && registration.key === page.imageLibraryListKey?.() && !state.gallery.album && !state.gallery.comic && !state.gallery.media;
      const currentFailure = page.getSummaryReadFailure?.();
      if (busy || !owns() || !currentFailure) return;
      busy = true;
      retry.setAttribute("aria-disabled", "true");
      retry.setAttribute("aria-busy", "true");
      const hadFocus = document.activeElement === retry;
      const shell = registration.content.closest(".gallery-shell");
      const events = new AbortController();
      let newerIntent = false;
      let result = null;
      const noteIntent = (event) => {
        const activation = event.target === retry && event.type === "keydown"
          && ["Enter", " "].includes(event.key) && !event.ctrlKey && !event.metaKey && !event.altKey;
        if (activation || event.target === retry && ["pointerdown", "focusin"].includes(event.type)) return;
        newerIntent = true;
      };
      for (const type of ["keydown", "input", "compositionstart", "focusin", "pointerdown", "wheel", "touchstart"]) {
        document.addEventListener(type, noteIntent, { capture: true, signal: events.signal });
      }
      try {
        result = await page.retrySummaryRead?.(currentFailure);
      } finally {
        events.abort();
        busy = false;
        if (retry.isConnected) {
          retry.setAttribute("aria-disabled", "false");
          retry.setAttribute("aria-busy", "false");
        }
        if (!hadFocus || newerIntent || !result?.isCurrent() || !shell?.isConnected || state.activeView !== "gallery"
          || registration.generation !== gallerySummaryGeneration
          || registration.key !== page.imageLibraryListKey?.() || state.gallery.album || state.gallery.comic || state.gallery.media) return;
        if (owns()) retry.focus({ preventScroll: true });
        else if (state.gallery.data && (gallerySummaryRegistration === registration || registration.complete)) {
          const target = shell.querySelector(".gallery-browse-header h1") || registration.content;
          target.tabIndex = -1;
          target.focus({ preventScroll: true });
        }
      }
    });
    panel.append(retry);
  }
  retry.setAttribute("aria-disabled", String(Boolean(state.gallery.loading)));
  retry.setAttribute("aria-busy", String(Boolean(state.gallery.loading)));
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
  empty.setAttribute("role", options.action === "重试" ? "alert" : "status");
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
  const category = state.gallery.category === "all" ? "全部合集" : photoCategoryDisplayName(state.gallery.category);
  const totalAlbums = items.reduce((sum, item) => sum + Number(item.albumCount || 0), 0);
  const header = createGalleryResultsHeader(category, `${formatNumber(items.length)} 个合集 · ${formatNumber(totalAlbums)} 期`);
  if (state.gallery.category !== "all") {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "text-button gallery-filter-clear";
    clear.textContent = "查看全部分类";
    clear.addEventListener("click", () => {
      state.gallery.category = "all";
      state.gallery.visibleLimit = 80;
      renderGalleryView();
      syncGalleryRoute();
    });
    header.append(clear);
  }
  container.append(header);
  const grid = document.createElement("div");
  grid.className = "gallery-grid gallery-collections-grid gallery-photo-catalog-grid";

  for (const [index, collection] of visibleItems.entries()) {
    const count = Number(collection.albumCount || 0);
    const categoryLabel = photoCategoryDisplayName(collection.catalogCategory);
    const card = createGalleryCard(
      { title: collection.title, coverUrl: collection.coverUrl || "" },
      {
        badges: count ? [`${formatNumber(count)} 期`] : [],
        meta: [categoryLabel === collection.title ? "" : categoryLabel, formatBytes(collection.size)].filter(Boolean).join(" · "),
        placeholder: "暂无封面",
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
  if (!items.length) renderPagedImageLibraryMessage(container, "这个分类下还没有合集，可尝试其他分类。");
  appendPhotoCatalogMore(container, visibleItems.length, items.length);
}

function appendPhotoCatalogMore(container, shown, total) {
  if (shown >= total) return;
  const more = document.createElement("button");
  more.type = "button";
  more.className = "text-button gallery-more";
  more.textContent = `加载更多合集 · 已显示 ${formatNumber(shown)} / ${formatNumber(total)}`;
  more.addEventListener("click", () => {
    state.gallery.visibleLimit = Math.min(total, Math.max(shown, Number(state.gallery.visibleLimit || 80)) + 80);
    renderGalleryResults({ preserveScroll: true });
  });
  container.append(more);
  setupGalleryMoreAutoload(more);
}

function renderPagedPhotoShelf(container, list) {
  const items = Array.isArray(list.items) ? list.items : [];
  const header = !state.gallery.query ? createGalleryResultsHeader("全部套图", `${formatNumber(list.total || 0)} 期`) : null;
  if (header) container.append(header);
  renderPhotoPersonBar(container, Number(list.total || items.length));
  const grid = renderPagedPhotoCards(items);
  grid.classList.add("gallery-photo-catalog-grid", "gallery-photo-albums-grid");
  container.append(grid);
  activateGalleryLazyImages(grid);
  if (!items.length) renderPagedImageLibraryMessage(container, "没有匹配的套图");
  appendPagedGalleryMore(container, list, "套图");
  // A person-specific bar contains aggregate metadata; preserve its full fallback.
  if (state.gallery.person === "all") registerGalleryList(grid, list, createPagedPhotoCard, {
    label: "套图", moreParent: container,
    refreshMetadata: next => { if (header) header.querySelector("span").textContent = `${formatNumber(next.total || 0)} 期`; }
  });
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
    grid.append(createPagedPhotoCard(item, index, options));
  }
  return grid;
}

function createPagedPhotoCard(item, index, options = {}) {
  const collectionView = Boolean(options.collection);
  const collectionPerson = collectionView ? photoAlbumPersonName(item) : "";
  const card = createGalleryCard(collectionView ? { ...item, title: photoAlbumDisplayTitle(item) } : item, {
    badges: Number(item.imageCount || 0) ? [`${formatNumber(item.imageCount)} 张`] : [],
    meta: collectionView ? collectionPerson : [item.category, item.subCategory, item.personName].filter(Boolean).join(" · "),
    extra: [gallerySearchMatchText(item), collectionView ? item.archiveDate : "", formatBytes(item.size), collectionView ? "" : formatDateTime(item.updatedAt)].filter(Boolean).join(" · "),
    placeholder: "套图",
    onOpen: event => openPhotoSet(item.id, { listReturn: {
      albumId: String(item.id), top: event.currentTarget.getBoundingClientRect().top,
      restoreFocus: event.detail === 0 && document.activeElement === event.currentTarget
    } })
  });
  card.classList.add("gallery-photo-album-card", "gallery-photo-catalog-card");
  card.dataset.galleryAlbumId = String(item.id);
  activateEagerGalleryCardImage(card, index);
  return card;
}

function createPagedMangaCard(item, index) {
  const card = createGalleryCard(item, {
    meta: `${item.category || "韩漫"} · ${formatNumber(item.chapterCount || 0)} 话`,
    extra: `${formatNumber(item.imageCount || 0)} 张 · ${formatDateTime(item.updatedAt)}`,
    placeholder: "韩漫",
    onOpen: () => openMangaComic(item.id)
  });
  activateEagerGalleryCardImage(card, index);
  return card;
}

function renderPagedMangaShelf(container, list) {
  const items = Array.isArray(list.items) ? list.items : [];
  const grid = document.createElement("div");
  grid.className = "gallery-grid manga-grid";
  for (const [index, item] of items.entries()) {
    grid.append(createPagedMangaCard(item, index));
  }
  container.append(grid);
  activateGalleryLazyImages(grid);
  if (!items.length) renderPagedImageLibraryMessage(container, "没有匹配的韩漫");
  appendPagedGalleryMore(container, list, "韩漫");
  registerGalleryList(grid, list, createPagedMangaCard, { label: "韩漫", moreParent: container });
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
  if (shown >= total || list.hasMore === false) return;
  const more = document.createElement("button");
  more.type = "button";
  more.className = "text-button gallery-more";
  more.textContent = `显示更多${label} ${formatNumber(shown)} / ${formatNumber(total)}`;
  more.addEventListener("click", () => showMoreGalleryList(label));
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
  poster.dataset.placeholder = "暂无海报";
  const coverUrl = metadata.coverUrl || item.coverUrl || "";
  if (coverUrl) {
    const img = document.createElement("img");
    img.alt = "";
    img.loading = index < 12 ? "eager" : "lazy";
    if (index < 12) img.src = coverUrl;
    else img.dataset.gallerySrc = coverUrl;
    img.addEventListener("error", () => {
      img.remove();
      poster.classList.add("empty");
    });
    poster.append(img);
  } else {
    poster.classList.add("empty");
  }

  const kind = document.createElement("span");
  kind.className = "gallery-media-card-kind";
  kind.textContent = item.mediaKind === "anime" ? "动漫" : item.mediaKind === "tv" ? "电视剧" : "电影";
  poster.append(kind);

  const copy = document.createElement("div");
  copy.className = "gallery-movie-list-copy";
  const title = document.createElement("strong");
  title.className = "gallery-movie-list-title";
  title.textContent = moviePrimaryTitle(item);
  title.title = movieDisplayTitle(item);

  const meta = document.createElement("span");
  meta.className = "gallery-movie-list-meta";
  meta.textContent = [metadata.year, (metadata.countries || []).slice(0, 1).join(""), (metadata.genres || []).slice(0, 2).join(" / ")].filter(Boolean).join(" · ") || item.category || "";
  meta.title = movieListMetaLine(item);

  const people = document.createElement("span");
  people.className = "gallery-movie-list-people";
  people.textContent = movieListPeopleLine(item);

  const rating = movieListRatingLine(item);
  const ratingRow = document.createElement("span");
  ratingRow.className = "gallery-movie-list-rating";
  if (rating) {
    const stars = document.createElement("i");
    stars.textContent = "豆瓣";
    const score = document.createElement("b");
    score.textContent = rating.score;
    ratingRow.append(stars, score);
    if (rating.count) {
      const count = document.createElement("em");
      count.textContent = rating.count;
      ratingRow.append(count);
    }
  } else {
    ratingRow.textContent = "暂无评分";
  }

  const local = document.createElement("small");
  local.textContent = [
    isTvSeriesWork ? "" : (item.ext || "").toUpperCase(),
    isTvSeriesWork ? `${formatNumber(item.episodeCount || 0)} 集` : formatBytes(item.size),
  ].filter(Boolean).join(" · ");

  copy.append(title, meta);
  if (people.textContent) copy.append(people);
  copy.append(ratingRow, local);
  button.append(poster, copy);
  return button;
}

function createMediaLayoutSwitch() {
  const group = document.createElement("div");
  group.className = "gallery-layout-switch";
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", "影视显示方式");
  for (const [value, label] of [["posters", "海报"], ["list", "列表"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.layout = value;
    button.setAttribute("aria-pressed", String(mediaLayout === value));
    button.addEventListener("click", () => {
      mediaLayout = value;
      try { window.localStorage.setItem("fanhao.media.layout", value); } catch { /* Optional preference. */ }
      const shelf = group.closest(".gallery-movie-explore");
      if (shelf) shelf.dataset.layout = value;
      for (const control of group.querySelectorAll("button")) control.setAttribute("aria-pressed", String(control.dataset.layout === value));
    });
    group.append(button);
  }
  return group;
}

function renderMovieShelf(container) {
  const items = filteredMediaItems();
  const visible = items.slice(0, state.gallery.visibleLimit);
  const total = Number(currentImageLibraryList()?.total ?? items.length);

  const shell = document.createElement("section");
  shell.className = "gallery-movie-explore";
  shell.dataset.layout = mediaLayout;

  const main = document.createElement("div");
  main.className = "gallery-movie-explore-main";
  const kindLabel = { movie: "电影", tv: "电视剧", anime: "动漫" }[state.gallery.mediaKind] || "全部作品";
  const heading = state.gallery.query ? `“${state.gallery.query}”的搜索结果` : state.gallery.category !== "all" ? galleryCategoryDisplayName(state.gallery.category) : kindLabel;
  const stats = currentImageLibraryList()?.stats;
  const header = createGalleryResultsHeader(heading, [
    `${formatNumber(total)} 部作品`,
    stats?.ratedCount ? `${formatNumber(stats.ratedCount)} 部有评分` : "",
    stats?.totalBytes ? formatBytes(stats.totalBytes) : ""
  ].filter(Boolean).join(" · "));
  header.classList.add("gallery-movie-explore-header");
  header.append(createMediaLayoutSwitch());

  const list = document.createElement("div");
  list.className = "gallery-movie-list";
  for (const [index, item] of visible.entries()) {
    list.append(createMovieExploreItem(item, index));
  }
  main.append(header, list);

  if (!items.length) {
    renderPagedImageLibraryMessage(main, "没有找到匹配的作品，试试更短的片名，或清除筛选后重新浏览。");
  } else if (visible.length < total && currentImageLibraryList()?.hasMore !== false) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "text-button gallery-more";
    more.textContent = `显示更多 ${formatNumber(visible.length)} / ${formatNumber(total)}`;
    more.addEventListener("click", () => showMoreGalleryList());
    setupGalleryMoreAutoload(more);
    main.append(more);
  }

  shell.append(main);
  container.append(shell);
  activateGalleryLazyImages(list);
  registerGalleryList(list, currentImageLibraryList(), createMovieExploreItem, {
    items: visible, moreParent: main,
    visible: next => (next.items || []).slice(0, state.gallery.visibleLimit),
    refreshMetadata: next => {
      header.querySelector("[role=status]").textContent = [
        `${formatNumber(next.total || 0)} 部作品`, next.stats?.ratedCount ? `${formatNumber(next.stats.ratedCount)} 部有评分` : "",
        next.stats?.totalBytes ? formatBytes(next.stats.totalBytes) : ""
      ].filter(Boolean).join(" · ");
    }
  });
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

async function loadPhotoReaderImages(limit) {
  const album = await getGalleryPage().loadPhotoReaderImages(limit);
  if (album && state.gallery.album === album) appendPhotoReaderImages(album);
  return album;
}

function captureGalleryReaderScrollAnchor(viewer) {
  if (galleryReaderWidthRestore?.viewer === viewer) return galleryReaderWidthRestore.anchor;
  const figures = [...viewer.querySelectorAll(".gallery-reader-figure[data-image-index]")];
  const target = figures.find((figure) => figure.getBoundingClientRect().bottom > 0);
  if (!target) return null;
  return {
    index: target.dataset.imageIndex,
    top: target.getBoundingClientRect().top
  };
}

function restoreGalleryReaderScrollAnchor(anchor, viewer) {
  if (!anchor?.index) return;
  const owner = { anchor, viewer, generation: galleryReaderImageGeneration };
  galleryReaderWidthRestore = owner;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (galleryReaderWidthRestore !== owner) return;
      galleryReaderWidthRestore = null;
      if (owner.generation !== galleryReaderImageGeneration || !viewer.isConnected || state.activeView !== "gallery"
          || els.workGrid.querySelector(".gallery-reader-images") !== viewer) return;
      const target = [...viewer.querySelectorAll(".gallery-reader-figure[data-image-index]")]
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
  return getGalleryPage().fullPhotoReaderImages(album);
}

function restorePhotoListReturn(anchor) {
  if (!anchor?.albumId || !anchor.isCurrent()) return false;
  const root = els.workGrid.querySelector(".gallery-content");
  const card = [...(root?.querySelectorAll(".gallery-photo-album-card") || [])]
    .find(card => card.dataset.galleryAlbumId === anchor.albumId);
  if (!card) return false;
  galleryListReturnRestore?.abort();
  const controller = new AbortController();
  galleryListReturnRestore = controller;
  const generation = ++galleryScrollRestoreGeneration;
  let restoring = false;
  const finish = () => {
    controller.abort();
    if (galleryListReturnRestore === controller) galleryListReturnRestore = null;
  };
  const noteIntent = () => { if (!restoring) finish(); };
  for (const type of ["pointerdown", "keydown", "wheel", "touchmove", "focusin"]) {
    document.addEventListener(type, noteIntent, { capture: true, passive: true, signal: controller.signal });
  }
  const restore = () => {
    if (controller.signal.aborted || generation !== galleryScrollRestoreGeneration || !anchor.isCurrent()
      || !root.isConnected || els.workGrid.querySelector(".gallery-content") !== root || !card.isConnected) {
      finish();
      return;
    }
    restoring = true;
    const rect = card.getBoundingClientRect();
    const availableTop = window.innerHeight - rect.height;
    const top = Math.min(Math.max(Number(anchor.top) || 0, Math.min(0, availableTop)), Math.max(0, availableTop));
    window.scrollBy({ top: rect.top - top, behavior: "auto" });
    if (anchor.restoreFocus && document.activeElement === document.body) card.focus({ preventScroll: true });
    restoring = false;
  };
  restore();
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => { restore(); finish(); }));
  return true;
}

function readerToolbar(title, meta, onBack, options = {}) {
  const bar = document.createElement("div");
  bar.className = "gallery-reader-toolbar";
  const back = document.createElement("button");
  back.type = "button";
  back.className = "text-button gallery-reader-back";
  back.textContent = "返回";
  back.addEventListener("click", () => {
    if (!bar.isConnected || state.activeView !== "gallery") return;
    const listReturn = options.albumId ? getGalleryPage().closePhotoSet?.(options.albumId) : null;
    if (!listReturn) resetGalleryReader();
    onBack?.();
    renderGalleryView();
    syncGalleryRoute("replace");
    if (!restorePhotoListReturn(listReturn)) window.scrollTo({ top: 0, behavior: "smooth" });
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
    if (!bar.isConnected || state.activeView !== "gallery" || state.gallery.fitWidth === fitWidth) return;
    const viewer = bar.parentElement?.querySelector(".gallery-reader-images");
    if (!viewer) {
      state.gallery.fitWidth = fitWidth;
      writeStoredFlag("fanhao.gallery.fitWidth", state.gallery.fitWidth);
      renderGalleryView();
      return;
    }
    const scrollAnchor = captureGalleryReaderScrollAnchor(viewer);
    state.gallery.fitWidth = fitWidth;
    writeStoredFlag("fanhao.gallery.fitWidth", state.gallery.fitWidth);
    viewer.classList.toggle("fit-width", fitWidth);
    viewer.classList.toggle("natural-width", !fitWidth);
    for (const button of bar.querySelectorAll(".gallery-reader-fit-group button")) {
      button.setAttribute("aria-pressed", String(button.dataset.galleryFitWidth === String(fitWidth)));
    }
    if (galleryReaderRegistration?.root === viewer) galleryReaderRegistration.register([]);
    restoreGalleryReaderScrollAnchor(scrollAnchor, viewer);
  };
  if (options.showFit !== false) {
    const fitGroup = document.createElement("div");
    fitGroup.className = "gallery-reader-fit-group";
    fitGroup.setAttribute("role", "group");
    fitGroup.setAttribute("aria-label", "图片宽度");
    const fit = document.createElement("button");
    fit.type = "button";
    fit.dataset.galleryFitWidth = "true";
    fit.textContent = "适应宽度";
    fit.setAttribute("aria-pressed", String(state.gallery.fitWidth));
    fit.addEventListener("click", () => setFitWidth(true));
    const natural = document.createElement("button");
    natural.type = "button";
    natural.dataset.galleryFitWidth = "false";
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
  const opener = document.activeElement;

  let currentIndex = Math.min(Math.max(Number(startIndex) || 0, 0), list.length - 1);
  let hideTimer = null;
  let wheelLockedUntil = 0;
  let pointerStart = null;
  let imagePan = null;
  let rangeScrubbing = false;
  let pendingRangeImages = null;
  let zoomLevel = 1;
  let imageFailed = false;
  let imageRetrying = false;
  let preserveImageScroll = false;
  let restoreRetryFocus = false;
  let fullscreenOperation = null;
  let fullscreenFrame = null;
  let catalogRequest = null;
  let catalogFailed = false;
  let zoomAnchor = null;
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
  const fullscreenStatus = document.createElement("span");
  fullscreenStatus.className = "gallery-image-pager-fullscreen-status";
  fullscreenStatus.setAttribute("role", "status");
  fullscreenStatus.hidden = true;
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
  fullscreen.dataset.galleryFullscreen = "true";
  fullscreen.textContent = "全屏";
  topActions.append(zoomOut, zoomReset, zoomIn, fullscreen);
  top.append(close, heading, topActions, fullscreenStatus);

  const stage = document.createElement("div");
  stage.className = "gallery-image-pager-stage";
  stage.tabIndex = 0;
  const imageNode = document.createElement("img");
  imageNode.alt = "";
  stage.append(imageNode);
  const imageError = document.createElement("div");
  imageError.className = "gallery-image-pager-error";
  imageError.hidden = true;
  const imageErrorText = document.createElement("span");
  imageErrorText.setAttribute("role", "status");
  const imageRetry = document.createElement("button");
  imageRetry.type = "button";
  imageRetry.className = "gallery-image-pager-button gallery-image-pager-retry";
  imageRetry.textContent = "重试当前图片";
  imageError.append(imageErrorText, imageRetry);

  const controls = document.createElement("div");
  controls.className = "gallery-image-pager-controls";
  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "gallery-image-pager-button";
  prev.textContent = "上一张";
  const counter = document.createElement("button");
  counter.type = "button";
  counter.className = "gallery-image-pager-counter";
  counter.title = "跳到指定图片";
  counter.setAttribute("aria-expanded", "false");
  counter.setAttribute("aria-controls", "galleryPagerJump");
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
  const catalog = document.createElement("div");
  catalog.className = "gallery-image-pager-catalog";
  catalog.hidden = true;
  const catalogText = document.createElement("span");
  catalogText.setAttribute("role", "status");
  const catalogRetry = document.createElement("button");
  catalogRetry.type = "button";
  catalogRetry.className = "gallery-image-pager-button gallery-image-pager-catalog-retry";
  catalogRetry.textContent = "重试完整目录";
  catalogRetry.hidden = true;
  catalog.append(catalogText, catalogRetry);
  controls.append(catalog, controlRow, thumbnails);
  const jumpPanel = document.createElement("div");
  jumpPanel.id = "galleryPagerJump";
  jumpPanel.className = "gallery-image-pager-jump";
  jumpPanel.hidden = true;
  jumpPanel.setAttribute("role", "group");
  jumpPanel.setAttribute("aria-label", "跳到指定图片");
  const jumpLabel = document.createElement("label");
  jumpLabel.textContent = "跳到第几张？";
  const jumpInput = document.createElement("input");
  jumpInput.type = "text";
  jumpInput.inputMode = "numeric";
  jumpInput.enterKeyHint = "go";
  jumpInput.autocomplete = "off";
  jumpInput.maxLength = 16;
  jumpInput.setAttribute("aria-label", "目标图片序号");
  jumpInput.setAttribute("aria-describedby", "galleryPagerJumpHint galleryPagerJumpError");
  jumpLabel.append(jumpInput);
  const jumpHint = document.createElement("span");
  jumpHint.id = "galleryPagerJumpHint";
  jumpHint.className = "gallery-image-pager-jump-hint";
  const jumpError = document.createElement("span");
  jumpError.id = "galleryPagerJumpError";
  jumpError.className = "gallery-image-pager-jump-error";
  jumpError.setAttribute("role", "status");
  const jumpActions = document.createElement("div");
  jumpActions.className = "gallery-image-pager-jump-actions";
  const jumpSubmit = document.createElement("button");
  jumpSubmit.type = "button";
  jumpSubmit.className = "gallery-image-pager-button";
  jumpSubmit.textContent = "跳转";
  const jumpCancel = document.createElement("button");
  jumpCancel.type = "button";
  jumpCancel.className = "gallery-image-pager-button";
  jumpCancel.textContent = "取消跳转";
  jumpActions.append(jumpSubmit, jumpCancel);
  jumpPanel.append(jumpLabel, jumpHint, jumpError, jumpActions);
  let jumpComposing = false;
  overlay.append(top, stage, controls, imageError, jumpPanel);

  const scheduleHide = () => {
    window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!jumpPanel.hidden) return;
      if (imageFailed || imageRetrying || catalogFailed || top.contains(document.activeElement) || controls.contains(document.activeElement)) return;
      overlay.classList.add("chrome-hidden");
    }, 2500);
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
  const jumpTarget = () => {
    const value = jumpInput.value.trim(), target = Number(value);
    return /^[0-9]+$/.test(value) && Number.isSafeInteger(target) && target >= 1 && target <= list.length ? target : null;
  };
  const clearJumpError = () => {
    jumpInput.removeAttribute("aria-invalid");
    jumpError.textContent = "";
  };
  const updateJumpBounds = () => {
    jumpHint.textContent = `请输入 1 至 ${formatNumber(list.length)} 的整数`;
    if (jumpInput.getAttribute("aria-invalid") === "true") {
      if (jumpTarget() != null) clearJumpError();
      else jumpError.textContent = jumpHint.textContent;
    }
  };
  const closeJump = () => {
    const ownsFocus = jumpPanel.contains(document.activeElement);
    jumpPanel.hidden = true;
    jumpComposing = false;
    counter.setAttribute("aria-expanded", "false");
    if (ownsFocus && !abortController.signal.aborted && overlay.isConnected) counter.focus({ preventScroll: true });
    showChrome();
  };
  const openJump = () => {
    if (abortController.signal.aborted || !overlay.isConnected) return;
    jumpInput.value = String(currentIndex + 1);
    clearJumpError();
    updateJumpBounds();
    jumpPanel.hidden = false;
    counter.setAttribute("aria-expanded", "true");
    showChrome();
    jumpInput.focus({ preventScroll: true });
    jumpInput.select();
  };
  const finishImagePan = () => {
    const pan = imagePan;
    imagePan = null;
    pointerStart = null;
    stage.classList.remove("panning");
    if (pan && stage.hasPointerCapture?.(pan.id)) stage.releasePointerCapture(pan.id);
  };
  const stopZoomAnchor = () => {
    const anchor = zoomAnchor;
    zoomAnchor = null;
    anchor?.events.abort();
    if (anchor?.frame != null) window.cancelAnimationFrame(anchor.frame);
  };
  const keepZoomRegion = point => {
    // Follow the existing 160ms size transition, then release all listeners.
    const anchor = { ...point, source: imageNode.getAttribute("src"), events: new AbortController(), frame: null, until: performance.now() + 240 };
    zoomAnchor = anchor;
    const cancel = event => { if (zoomAnchor === anchor && (event.type !== "focusin" || event.target !== document.body)) stopZoomAnchor(); };
    for (const type of ["pointerdown", "keydown", "wheel", "touchstart", "focusin"]) document.addEventListener(type, cancel, { capture: true, passive: true, signal: anchor.events.signal });
    window.addEventListener("resize", () => { if (zoomAnchor === anchor) stopZoomAnchor(); }, { signal: anchor.events.signal });
    const follow = () => {
      if (zoomAnchor !== anchor) return;
      if (abortController.signal.aborted || !overlay.isConnected || imageNode.getAttribute("src") !== anchor.source || !imageNode.naturalWidth) { stopZoomAnchor(); return; }
      const bounds = stage.getBoundingClientRect(), rect = imageNode.getBoundingClientRect();
      stage.scrollTo({ left: stage.scrollLeft + rect.left + rect.width * anchor.u - bounds.left - stage.clientLeft - stage.clientWidth / 2,
        top: stage.scrollTop + rect.top + rect.height * anchor.v - bounds.top - stage.clientTop - stage.clientHeight / 2, behavior: "auto" });
      const settled = Math.abs(rect.width - parseFloat(imageNode.style.width)) < .5 && Math.abs(rect.height - parseFloat(imageNode.style.height)) < .5;
      if (settled || performance.now() >= anchor.until) stopZoomAnchor();
      else anchor.frame = window.requestAnimationFrame(follow);
    };
    anchor.frame = window.requestAnimationFrame(follow);
  };
  const applyZoom = (nextZoom = zoomLevel, options = {}) => {
    const nextLevel = Math.min(3, Math.max(1, Math.round(Number(nextZoom || 1) * 4) / 4));
    let point = null;
    if (nextLevel !== zoomLevel) {
      if (nextLevel > 1 && imageNode.naturalWidth && !options.preserveScroll) {
        const bounds = stage.getBoundingClientRect(), rect = imageNode.getBoundingClientRect();
        if (rect.width && rect.height) point = { u: Math.max(0, Math.min(1, (bounds.left + stage.clientLeft + stage.clientWidth / 2 - rect.left) / rect.width)),
          v: Math.max(0, Math.min(1, (bounds.top + stage.clientTop + stage.clientHeight / 2 - rect.top) / rect.height)) };
      }
      stopZoomAnchor(); finishImagePan();
    }
    zoomLevel = nextLevel;
    const naturalWidth = Number(imageNode.naturalWidth || 0);
    const naturalHeight = Number(imageNode.naturalHeight || 0);
    const availableWidth = Math.max(1, stage.clientWidth - 24);
    const availableHeight = Math.max(1, stage.clientHeight - 24);
    const fitScale = naturalWidth && naturalHeight
      ? Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight)
      : 1;
    const displayScale = fitScale * zoomLevel;
    if (zoomAnchor && options.preserveScroll) zoomAnchor.until = performance.now() + 240;
    if (naturalWidth && naturalHeight) {
      imageNode.style.width = `${Math.max(1, Math.round(naturalWidth * displayScale))}px`;
      imageNode.style.height = `${Math.max(1, Math.round(naturalHeight * displayScale))}px`;
    }
    stage.classList.toggle("zoomed", zoomLevel > 1);
    stage.setAttribute("aria-label", zoomLevel > 1 ? "放大图片，方向键和 Page Up、Page Down 可滚动查看" : "图片查看区域，方向键可切换图片");
    zoomOut.disabled = zoomLevel <= 1;
    zoomIn.disabled = zoomLevel >= 3;
    zoomReset.textContent = `${Math.round(zoomLevel * 100)}%`;
    if (point) keepZoomRegion(point);
    else if (!options.preserveScroll) { stopZoomAnchor(); stage.scrollTo({ left: 0, top: 0, behavior: "auto" }); }
    showChrome();
  };
  const renderThumbnails = () => {
    const restoreThumbnailFocus = thumbnails.contains(document.activeElement);
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
    if (restoreThumbnailFocus) thumbnails.querySelector(`[data-index="${currentIndex}"]`)?.focus({ preventScroll: true });
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
    counter.setAttribute("aria-label", `跳到指定图片，当前第 ${formatNumber(previewIndex + 1)} 张，共 ${formatNumber(list.length)} 张`);
    range.value = String(previewIndex + 1);
    sub.textContent = [meta, item.name].filter(Boolean).join(" · ");
    showChrome();
  };
  const commitRangeIndex = () => {
    rangeScrubbing = false;
    goTo(Number(range.value) - 1);
  };
  const update = ({ preserveView = false } = {}) => {
    const item = list[currentIndex] || {};
    if (!preserveView) {
      stopZoomAnchor();
      finishImagePan();
      zoomLevel = 1;
    }
    if (imageNode.getAttribute("src") !== item.url) {
      finishImagePan();
      imageFailed = false;
      imageRetrying = false;
      preserveImageScroll = false;
      restoreRetryFocus = false;
      imageError.hidden = true;
      imageRetry.disabled = false;
      imageRetry.textContent = "重试当前图片";
      stage.setAttribute("aria-busy", "true");
      imageNode.src = item.url;
    }
    if (imageFailed || imageRetrying) imageErrorText.textContent = imageRetrying ? `正在重新加载第 ${formatNumber(currentIndex + 1)} 张图片` : `第 ${formatNumber(currentIndex + 1)} 张图片加载失败，可以重试或继续翻页`;
    imageNode.alt = item.name || title || "";
    counter.textContent = `第 ${formatNumber(currentIndex + 1)} / ${formatNumber(list.length)} 张`;
    counter.setAttribute("aria-label", `跳到指定图片，当前第 ${formatNumber(currentIndex + 1)} 张，共 ${formatNumber(list.length)} 张`);
    updateJumpBounds();
    range.max = String(list.length);
    range.value = String(currentIndex + 1);
    prev.disabled = currentIndex <= 0;
    next.disabled = currentIndex >= list.length - 1;
    sub.textContent = [meta, item.name].filter(Boolean).join(" · ");
    applyZoom(zoomLevel, { preserveScroll: preserveView });
    renderThumbnails();
    updateThumbnails();
    preloadNeighbor(currentIndex - 1);
    preloadNeighbor(currentIndex + 1);
    showChrome();
  };
  const goTo = (index) => {
    if (!jumpPanel.hidden) closeJump();
    const nextIndex = clampPagerIndex(index);
    rangeScrubbing = false;
    if (pendingRangeImages) {
      const pending = pendingRangeImages;
      pendingRangeImages = null;
      updateImages(pending.images, { ...pending.options, index: nextIndex });
      return;
    }
    if (nextIndex === currentIndex) {
      showChrome();
      return;
    }
    currentIndex = nextIndex;
    update();
  };
  const submitJump = () => {
    if (abortController.signal.aborted || !overlay.isConnected || jumpPanel.hidden || jumpComposing) return;
    const target = jumpTarget();
    if (target == null) {
      jumpInput.setAttribute("aria-invalid", "true");
      jumpError.textContent = jumpHint.textContent;
      jumpInput.focus({ preventScroll: true });
      return;
    }
    closeJump();
    goTo(target - 1);
  };
  const updateImages = (nextImages = [], updateOptions = {}) => {
    if (abortController.signal.aborted) return false;
    if (updateOptions.sourceKey && sourceKey && String(updateOptions.sourceKey) !== sourceKey) return false;
    const nextList = (nextImages || []).filter((image) => image?.url);
    if (!nextList.length) return false;
    // A native range drag keeps its starting domain until release/cancel.
    if (rangeScrubbing) {
      pendingRangeImages = { images: nextList, options: { ...updateOptions } };
      return true;
    }

    const current = list[currentIndex] || {};
    const requestedIndex = Number(updateOptions.index);
    const matchedIndex = current.url ? nextList.findIndex((item) => item.url === current.url) : -1;
    currentIndex = Number.isFinite(requestedIndex) && requestedIndex >= 0
      ? Math.min(nextList.length - 1, requestedIndex)
      : matchedIndex >= 0
        ? matchedIndex
        : Math.min(currentIndex, nextList.length - 1);
    const preserveView = nextList[currentIndex]?.url === current.url;
    list = nextList;
    update({ preserveView });
    return true;
  };

  const loadCatalog = () => {
    if (abortController.signal.aborted || !overlay.isConnected || typeof options.fullImages !== "function") return Promise.resolve();
    if (catalogRequest) return catalogRequest.promise;
    const request = { promise: null, restoreFocus: document.activeElement === catalogRetry };
    catalogRequest = request;
    if (request.restoreFocus) stage.focus({ preventScroll: true });
    catalog.hidden = false;
    catalogFailed = false;
    catalogText.textContent = `正在读取完整目录，仍可浏览已加载的 ${formatNumber(list.length)} 张。`;
    catalogRetry.disabled = true;
    catalogRetry.textContent = "正在读取目录…";
    catalog.setAttribute("aria-busy", "true");
    applyZoom(zoomLevel, { preserveScroll: true });
    request.promise = (async () => {
      try {
        const images = await options.fullImages();
        if (abortController.signal.aborted || !overlay.isConnected) return;
        catalog.hidden = true;
        if (Array.isArray(images) && images.length) updateImages(images, { sourceKey });
        else applyZoom(zoomLevel, { preserveScroll: true });
      } catch {
        if (abortController.signal.aborted || !overlay.isConnected) return;
        catalogFailed = true;
        catalogText.textContent = `完整目录读取失败，仍可浏览已加载的 ${formatNumber(list.length)} 张。`;
        catalogRetry.hidden = false;
        catalogRetry.disabled = false;
        catalogRetry.textContent = "重试完整目录";
        applyZoom(zoomLevel, { preserveScroll: true });
        if (request.restoreFocus && document.activeElement === stage) catalogRetry.focus({ preventScroll: true });
      } finally {
        if (catalogRequest === request) catalogRequest = null;
        if (!abortController.signal.aborted && overlay.isConnected) catalog.removeAttribute("aria-busy");
      }
    })();
    return request.promise;
  };

  prev.addEventListener("click", () => goTo(currentIndex - 1), listenerOptions);
  next.addEventListener("click", () => goTo(currentIndex + 1), listenerOptions);
  counter.addEventListener("click", () => jumpPanel.hidden ? openJump() : closeJump(), listenerOptions);
  jumpSubmit.addEventListener("click", submitJump, listenerOptions);
  jumpCancel.addEventListener("click", closeJump, listenerOptions);
  catalogRetry.addEventListener("click", loadCatalog, listenerOptions);
  jumpInput.addEventListener("input", clearJumpError, listenerOptions);
  jumpInput.addEventListener("compositionstart", () => { jumpComposing = true; }, listenerOptions);
  jumpInput.addEventListener("compositionend", () => { jumpComposing = false; }, listenerOptions);
  jumpInput.addEventListener("keydown", (event) => {
    if (jumpComposing || event.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Enter" && !event.defaultPrevented) { event.preventDefault(); submitJump(); }
  }, listenerOptions);
  zoomOut.addEventListener("click", () => applyZoom(zoomLevel - 0.25), listenerOptions);
  zoomReset.addEventListener("click", () => applyZoom(1), listenerOptions);
  zoomIn.addEventListener("click", () => applyZoom(zoomLevel + 0.25), listenerOptions);
  const fullscreenCurrent = () => !abortController.signal.aborted && overlay.isConnected;
  const fullscreenSupported = () => Boolean(document.fullscreenEnabled && overlay.requestFullscreen && document.exitFullscreen);
  const updateFullscreen = () => {
    const active = document.fullscreenElement === overlay;
    fullscreen.hidden = !fullscreenSupported() || Boolean(document.fullscreenElement && !active);
    fullscreen.textContent = active ? "退出全屏" : "全屏";
    fullscreen.setAttribute("aria-pressed", String(active));
    fullscreen.setAttribute("aria-busy", String(Boolean(fullscreenOperation)));
    fullscreen.setAttribute("aria-disabled", String(Boolean(fullscreenOperation)));
  };
  fullscreen.addEventListener("click", () => {
    if (!fullscreenCurrent() || fullscreenOperation || !fullscreenSupported()
        || document.fullscreenElement && document.fullscreenElement !== overlay) return;
    const operation = { exiting: document.fullscreenElement === overlay };
    fullscreenOperation = operation;
    fullscreenStatus.hidden = true;
    fullscreenStatus.textContent = "";
    updateFullscreen();
    showChrome();
    // Invoke the native transition in this click's activation, while keeping
    // rejection and completion bound to this particular image reader.
    void (async () => {
      try {
        if (operation.exiting) await document.exitFullscreen();
        else await overlay.requestFullscreen();
        if (!fullscreenCurrent() && document.fullscreenElement === overlay) await document.exitFullscreen();
      } catch {
        if (fullscreenCurrent()) {
          fullscreenStatus.textContent = "全屏切换失败，请重试。";
          fullscreenStatus.hidden = false;
          applyZoom(zoomLevel, { preserveScroll: true });
          showChrome();
        }
      } finally {
        if (fullscreenOperation === operation) fullscreenOperation = null;
        if (fullscreenCurrent()) updateFullscreen();
      }
    })();
  }, listenerOptions);
  document.addEventListener("fullscreenchange", () => {
    if (!fullscreenCurrent()) return;
    stopZoomAnchor();
    updateFullscreen();
    if (fullscreenFrame != null) window.cancelAnimationFrame(fullscreenFrame);
    fullscreenFrame = window.requestAnimationFrame(() => {
      fullscreenFrame = null;
      if (fullscreenCurrent()) applyZoom(zoomLevel, { preserveScroll: true });
    });
  }, listenerOptions);
  updateFullscreen();
  const currentImage = () => !abortController.signal.aborted && overlay.isConnected
    && imageNode.getAttribute("src") === list[currentIndex]?.url;
  imageNode.addEventListener("load", () => {
    if (!currentImage() || !imageNode.complete || !imageNode.naturalWidth) return;
    imageFailed = false;
    imageRetrying = false;
    imageError.hidden = true;
    imageRetry.disabled = false;
    imageRetry.textContent = "重试当前图片";
    stage.removeAttribute("aria-busy");
    applyZoom(zoomLevel, { preserveScroll: preserveImageScroll });
    preserveImageScroll = false;
    restoreRetryFocus = false;
  }, listenerOptions);
  imageNode.addEventListener("error", () => {
    if (!currentImage() || !imageNode.complete || imageNode.naturalWidth) return;
    const returnFocus = restoreRetryFocus && document.activeElement === stage;
    imageFailed = true;
    imageRetrying = false;
    preserveImageScroll = false;
    restoreRetryFocus = false;
    imageError.hidden = false;
    imageErrorText.textContent = `第 ${formatNumber(currentIndex + 1)} 张图片加载失败，可以重试或继续翻页`;
    imageRetry.disabled = false;
    imageRetry.textContent = "重试当前图片";
    stage.removeAttribute("aria-busy");
    showChrome();
    if (returnFocus) imageRetry.focus({ preventScroll: true });
  }, listenerOptions);
  imageRetry.addEventListener("click", () => {
    if (!currentImage() || !imageFailed || imageRetrying) return;
    imageRetrying = true;
    preserveImageScroll = true;
    restoreRetryFocus = document.activeElement === imageRetry;
    if (restoreRetryFocus) stage.focus({ preventScroll: true });
    imageRetry.disabled = true;
    imageRetry.textContent = "正在重试…";
    imageErrorText.textContent = `正在重新加载第 ${formatNumber(currentIndex + 1)} 张图片`;
    stage.setAttribute("aria-busy", "true");
    imageNode.removeAttribute("src");
    imageNode.src = list[currentIndex].url;
  }, listenerOptions);
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
    const pending = pendingRangeImages;
    pendingRangeImages = null;
    if (pending) updateImages(pending.images, pending.options);
    else update();
  }, listenerOptions);
  range.addEventListener("input", () => {
    if (rangeScrubbing) previewRangeIndex(Number(range.value) - 1);
    else goTo(Number(range.value) - 1);
  }, listenerOptions);
  range.addEventListener("change", () => {
    commitRangeIndex();
  }, listenerOptions);
  stage.addEventListener("click", showChrome, listenerOptions);
  stage.addEventListener("pointerdown", (event) => {
    if (zoomLevel <= 1 || !imageNode.naturalWidth || event.button !== 0 || event.isPrimary === false || imagePan) return;
    imagePan = { id: event.pointerId, x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture?.(event.pointerId);
    stage.classList.add("panning");
    event.preventDefault();
    showChrome();
  }, listenerOptions);
  stage.addEventListener("pointermove", (event) => {
    if (!imagePan || imagePan.id !== event.pointerId) return;
    stage.scrollTo({ left: imagePan.left + imagePan.x - event.clientX, top: imagePan.top + imagePan.y - event.clientY, behavior: "auto" });
    event.preventDefault();
  }, listenerOptions);
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) stage.addEventListener(type, (event) => {
    if (imagePan?.id === event.pointerId) finishImagePan();
  }, listenerOptions);
  stage.addEventListener("dblclick", (event) => {
    event.preventDefault();
    applyZoom(zoomLevel > 1 ? 1 : 2);
  }, listenerOptions);
  overlay.addEventListener("pointermove", showChrome, listenerOptions);
  overlay.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".gallery-image-pager-top, .gallery-image-pager-controls, .gallery-image-pager-error, .gallery-image-pager-jump")) return;
    pointerStart = { x: event.clientX, y: event.clientY };
    showChrome();
  }, listenerOptions);
  overlay.addEventListener("pointerup", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!pointerStart || target?.closest(".gallery-image-pager-top, .gallery-image-pager-controls, .gallery-image-pager-error, .gallery-image-pager-jump")) return;
    const dy = event.clientY - pointerStart.y;
    const dx = event.clientX - pointerStart.x;
    pointerStart = null;
    if (zoomLevel > 1) return;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 52) return;
    if (Math.abs(dx) > Math.abs(dy)) goTo(currentIndex + (dx < 0 ? 1 : -1));
    else goTo(currentIndex + (dy < 0 ? 1 : -1));
  }, listenerOptions);
  overlay.addEventListener("wheel", (event) => {
    if (event.target instanceof Element && event.target.closest(".gallery-image-pager-error, .gallery-image-pager-jump")) return;
    if (zoomLevel > 1) return;
    if (Math.abs(event.deltaY) < 18 || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
    event.preventDefault();
    const now = Date.now();
    if (now < wheelLockedUntil) return;
    wheelLockedUntil = now + 360;
    goTo(currentIndex + (event.deltaY > 0 ? 1 : -1));
  }, { signal: abortController.signal, passive: false });
  document.addEventListener("focusin", (event) => {
    if (!overlay.contains(event.target)) stage.focus({ preventScroll: true });
    else showChrome();
  }, listenerOptions);
  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === "Tab") {
      showChrome();
      const focusRoot = jumpPanel.hidden ? overlay : jumpPanel;
      const targets = [...focusRoot.querySelectorAll("button, input, [href], [tabindex]")]
        .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
      const first = targets[0] || stage;
      const last = targets.at(-1) || stage;
      if (!focusRoot.contains(document.activeElement) || event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (!jumpPanel.hidden) closeJump();
      else closeGalleryImagePager();
    } else if (jumpPanel.contains(event.target)) {
      return;
    } else if (zoomLevel > 1 && imageNode.naturalWidth && event.target === stage
        && ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "PageDown", "PageUp"].includes(event.key)) {
      // The focused scrollable image keeps its native keyboard scrolling.
      return;
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
    pendingRangeImages = null;
    stopZoomAnchor();
    finishImagePan();
    const restoreFocus = overlay.contains(document.activeElement);
    abortController.abort();
    if (fullscreenFrame != null) window.cancelAnimationFrame(fullscreenFrame);
    if (document.fullscreenElement === overlay && !fullscreenOperation?.exiting) void document.exitFullscreen().catch(() => {});
    imageNode.removeAttribute("src");
    overlay.remove();
    document.body.classList.remove("gallery-image-pager-open");
    document.body.style.overflow = previousOverflow;
    if (restoreFocus && opener?.isConnected) opener.focus({ preventScroll: true });
  };
  document.body.classList.add("gallery-image-pager-open");
  document.body.style.overflow = "hidden";
  document.body.append(overlay);
  update();
  stage.focus({ preventScroll: true });
  void loadCatalog();
  return {
    updateImages,
    close: closeGalleryImagePager,
    sourceKey
  };
}

function createGalleryReaderFigure(image, index, list, options = {}) {
  const totalCount = Math.max(Number(options.totalCount || 0), list.length);
  const fallbackImages = options.albumId ? null : list;
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
    const currentList = options.albumId
      ? state.gallery.album?.id === options.albumId ? state.gallery.album.images : []
      : fallbackImages;
    if (!currentList?.length) return;
    openGalleryImagePager(
      currentList,
      Math.min(currentList.length - 1, fallbackIndex),
      options.title || "",
      options.meta || "",
      { sourceKey, fullImages: options.fullImages }
    );
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
  return figure;
}

function renderReaderImages(container, images, options = {}) {
  const list = Array.isArray(images) ? images : [];
  const viewer = document.createElement("div");
  viewer.className = `gallery-reader-images${state.gallery.fitWidth ? " fit-width" : " natural-width"}`;
  viewer.dataset.totalCount = String(Math.max(Number(options.totalCount || 0), list.length));
  viewer.dataset.loadedCount = String(list.length);
  if (options.albumId) viewer.dataset.photoAlbumId = options.albumId;
  for (const [index, image] of list.entries()) {
    viewer.append(createGalleryReaderFigure(image, index, list, options));
  }
  container.append(viewer);
  window.requestAnimationFrame(() => {
    if (galleryReaderRegistration?.root === viewer) return;
    if (viewer.isConnected) activateGalleryReaderImages(viewer);
  });
}

function photoReaderMeta(album) {
  const images = Array.isArray(album.images) ? album.images : [];
  const totalCount = Number(album.imageCount || images.length || 0);
  const visibleCount = images.length;
  return [
    album.category,
    album.subCategory,
    album.personName,
    visibleCount < totalCount
      ? `已显示 ${formatNumber(visibleCount)} / ${formatNumber(totalCount)} 张`
      : `${formatNumber(totalCount)} 张`
  ].filter(Boolean).join(" · ");
}

function photoReaderOptions(album) {
  const albumId = album.id;
  return { albumId, title: album.title, meta: photoReaderMeta(album), totalCount: Number(album.imageCount || album.images?.length || 0),
    sourceKey: albumId ? `photo:${albumId}` : "", previewUrl: album.coverUrl, fullImages: () => fullPhotoReaderImages({ id: albumId }) };
}

function appendPhotoReaderImages(album) {
  const viewer = els.workGrid.querySelector(".gallery-reader-images[data-photo-album-id]");
  if (!viewer || viewer.dataset.photoAlbumId !== album.id) return;
  const images = Array.isArray(album.images) ? album.images : [];
  const loaded = Number(viewer.dataset.loadedCount || 0);
  const options = photoReaderOptions(album);
  const figures = images.slice(loaded).map((image, offset) => createGalleryReaderFigure(image, loaded + offset, images, options));
  const fragment = document.createDocumentFragment();
  for (const figure of figures) fragment.append(figure);
  viewer.append(fragment);
  viewer.dataset.loadedCount = String(images.length);
  viewer.dataset.totalCount = String(Math.max(Number(album.imageCount || 0), images.length));
  if (galleryReaderRegistration?.root === viewer) galleryReaderRegistration.register(figures);
  else if (viewer.isConnected) activateGalleryReaderImages(viewer);
  const copy = viewer.parentElement.querySelector(".gallery-reader-title span");
  if (copy) copy.textContent = photoReaderMeta(album);
  renderPhotoReaderMore(viewer.parentElement, album);
}

function renderPhotoReader(container) {
  const album = state.gallery.album;
  const images = Array.isArray(album.images) ? album.images : [];
  const totalCount = Number(album.imageCount || images.length || 0);
  const meta = photoReaderMeta(album);
  const sourceKey = album.id ? `photo:${album.id}` : "";
  const openPager = (startIndex = 0) => {
    const currentImages = state.gallery.album?.id === album.id ? state.gallery.album.images : images;
    openGalleryImagePager(currentImages, startIndex, album.title, meta, { sourceKey, fullImages: () => fullPhotoReaderImages(album) });
  };
  container.append(readerToolbar(album.title, meta, () => {
    state.gallery.album = null;
  }, {
    albumId: album.id,
    totalCount,
    onOpen: openPager
  }));
  renderReaderImages(container, images, photoReaderOptions(album));
  renderPhotoReaderMore(container, album);
}

function renderPhotoReaderMore(container, album) {
  const visibleCount = album.images?.length || 0;
  const totalCount = Number(album.imageCount || visibleCount);
  const current = container.querySelector(".gallery-more");
  if (visibleCount >= totalCount) {
    if (current) { current.remove(); galleryMoreScrollCleanup?.(); galleryMoreScrollCleanup = null; }
    return;
  }
  if (current) {
    delete current.dataset.autoloading;
    current.textContent = `向下滑动继续显示 ${formatNumber(visibleCount)} / ${formatNumber(totalCount)}`;
    return;
  }
  if (visibleCount < totalCount) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "text-button gallery-more";
    more.textContent = `向下滑动继续显示 ${formatNumber(visibleCount)} / ${formatNumber(totalCount)}`;
    more.addEventListener("click", async () => {
      if (!more.isConnected || more.disabled || state.gallery.album?.id !== album.id) return;
      more.disabled = true;
      more.textContent = "正在继续读取图片";
      try {
        await loadPhotoReaderImages((state.gallery.album.images?.length || 0) + photoReaderBatchSize());
      } catch (error) {
        if (!more.isConnected || state.gallery.album?.id !== album.id) return;
        more.disabled = false;
        more.textContent = error.message || "读取失败，点一下重试";
      } finally {
        if (more.isConnected && state.gallery.album?.id === album.id) {
          more.disabled = false;
          delete more.dataset.autoloading;
        }
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
    resetGalleryReader();
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
  getGalleryPage().setListRefreshHandler?.(refreshGalleryList);
  const scrollAnchor = options.preserveScroll ? captureGalleryScrollPosition() : null;
  if (!scrollAnchor) galleryScrollRestoreGeneration += 1;
  const searchValueToRestore = activeGallerySearchValue();
  resetGalleryRenderedState();

  els.workGrid.innerHTML = "";
  const shell = document.createElement("section");
  shell.className = "gallery-shell";
  const imageReaderOpen = Boolean(state.gallery.album || state.gallery.comic);
  const seriesPageOpen = ["media", "tv"].includes(state.gallery.mode) && state.gallery.person !== "all" && !state.gallery.media;
  if (["photo", "media", "movie"].includes(state.gallery.mode) && !imageReaderOpen && !state.gallery.media && !seriesPageOpen) {
    shell.classList.add("gallery-browse-shell");
    shell.append(createGalleryBrowseHeader());
  }
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
