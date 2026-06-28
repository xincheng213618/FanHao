const PHOTO_COLLECTION_ROOT_VALUE = "__fanhao_photo_collection_root__";

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
    resetProgressiveCoverLoading,
    setAdminBusy,
    state,
    writeStoredFlag
  } = deps;

  let galleryCoverObserver = null;
  let galleryReaderObserver = null;
  let galleryReaderScrollCleanup = null;

function setGalleryStatus(message) {
  getGalleryPage().setStatus(message);
}

function renderGalleryStats() {
  const data = state.gallery.data || {};
  const stats = [
    ["韩漫", data.totals?.manga || 0],
    ["套图", data.totals?.photoSets || 0],
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

function galleryPhotoViewButton(view, label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `gallery-submode-button${state.gallery.photoView === view ? " active" : ""}`;
  button.textContent = label;
  button.addEventListener("click", () => {
    state.gallery.photoView = view;
    state.gallery.photoCollection = null;
    state.gallery.person = "all";
    state.gallery.visibleLimit = 80;
    resetGalleryReader();
    renderGalleryView();
    syncGalleryRoute();
  });
  return button;
}

function renderGalleryControls(options = {}) {
  const controls = document.createElement("div");
  controls.className = "gallery-controls";

  const photoViews = document.createElement("div");
  photoViews.className = "gallery-submodes";
  photoViews.append(galleryPhotoViewButton("albums", "图包"), galleryPhotoViewButton("collections", "合集"));

  const search = document.createElement("input");
  search.type = "search";
  search.className = "gallery-search";
  search.placeholder = "搜索标题 / 分类 / 合集";
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
  category.append(new Option("全部分类", "all"));
  for (const item of currentGalleryCategoryFacets()) {
    category.append(new Option(`${item.value} · ${formatNumber(item.count)}`, item.value));
  }
  category.value = state.gallery.category;
  category.addEventListener("change", () => {
    state.gallery.category = category.value || "all";
    state.gallery.subCategory = "all";
    state.gallery.visibleLimit = 80;
    resetGalleryReader();
    renderGalleryView();
    syncGalleryRoute();
  });

  const people = document.createElement("select");
  people.className = "gallery-select";
  people.append(new Option(state.gallery.mode === "tv" ? "全部系列" : "全部人物", "all"));
  const peopleFacets = currentGalleryPeopleFacets().slice(0, 300);
  for (const item of peopleFacets) {
    people.append(new Option(`${item.value} · ${formatNumber(item.count)}`, item.value));
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

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "text-button";
  refresh.textContent = state.gallery.loading ? "刷新中" : "刷新索引";
  refresh.disabled = state.gallery.loading;
  refresh.addEventListener("click", () => loadImageLibrary({ refresh: true }));

  const status = document.createElement("span");
  status.className = "gallery-status";
  status.textContent = state.gallery.status || "";

  if (state.gallery.mode === "photo") controls.append(photoViews);
  controls.append(search);
  if (["photo", "western", "movie", "tv"].includes(state.gallery.mode)) controls.append(category);
  if (["western", "tv"].includes(state.gallery.mode)) controls.append(people);
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
  if (kind === "tv") return facets.tv?.series || facets.tv?.people || [];
  if (kind === "western") return facets.western?.people || [];
  return [];
}

function galleryText(item) {
  return [item.title, item.category, item.subCategory, item.personName, item.seriesName, item.rootLabel, item.relativePath].filter(Boolean).join("\n");
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
  const items = photoCollectionAlbums(collectionValue, { ignoreCategory: true, ignoreQuery: true });
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
  let items = (state.gallery.data?.mediaItems || []).filter((item) => item.mediaKind === kind);
  if (state.gallery.category !== "all") items = items.filter((item) => item.category === state.gallery.category);
  if (state.gallery.person !== "all") {
    items = items.filter((item) => (kind === "tv" ? item.seriesName : item.personName) === state.gallery.person);
  }
  const query = state.gallery.query.trim();
  if (query) items = items.filter((item) => includesText(galleryText(item), query));
  return items;
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

function renderMediaShelf(container) {
  const items = filteredMediaItems();
  const visible = items.slice(0, state.gallery.visibleLimit);
  const grid = document.createElement("div");
  grid.className = "gallery-grid media-grid";
  for (const item of visible) {
    const meta = [item.category, item.subCategory, item.mediaKind === "tv" ? item.seriesName : item.personName].filter(Boolean).join(" · ");
    grid.append(
      createGalleryCard(item, {
        meta,
        extra: `${formatBytes(item.size)} · ${formatDateTime(item.updatedAt)}`,
        placeholder: item.kindLabel || galleryModeLabel(state.gallery.mode),
        onOpen: () => openGalleryMedia(item.id)
      })
    );
  }
  container.append(grid);

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

function renderReaderImages(container, images) {
  const viewer = document.createElement("div");
  viewer.className = `gallery-reader-images${state.gallery.fitWidth ? " fit-width" : " natural-width"}`;
  for (const image of images || []) {
    const figure = document.createElement("figure");
    figure.className = "gallery-reader-figure";
    figure.dataset.gallerySrc = image.url;
    figure.style.minHeight = "70vh";
    const img = document.createElement("img");
    img.alt = image.name || "";
    img.loading = "lazy";
    img.addEventListener("load", () => {
      figure.classList.add("loaded");
      figure.style.minHeight = "";
    });
    const caption = document.createElement("figcaption");
    caption.textContent = `${formatNumber(image.index)} / ${formatNumber(images.length)}`;
    figure.append(img, caption);
    viewer.append(figure);
  }
  container.append(viewer);
  activateGalleryReaderImages(viewer);
}

function renderPhotoReader(container) {
  const album = state.gallery.album;
  container.append(
    readerToolbar(album.title, [album.category, album.subCategory, album.personName, `${formatNumber(album.imageCount)} 张`].filter(Boolean).join(" · "), () => {
      state.gallery.album = null;
    })
  );
  renderReaderImages(container, album.images || []);
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
  if (chapter) renderReaderImages(container, chapter.images || []);
}

function renderMediaReader(container) {
  const media = state.gallery.media;
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

  const panel = document.createElement("section");
  panel.className = "gallery-media-player";
  if (media.playable) {
    const video = document.createElement("video");
    video.controls = true;
    video.preload = "metadata";
    video.src = media.streamUrl;
    panel.append(video);
  }

  const meta = document.createElement("div");
  meta.className = "gallery-media-meta";
  for (const [label, value] of [
    ["类型", media.kindLabel],
    ["分类", media.category],
    ["系列", media.seriesName],
    ["人物", media.personName],
    ["格式", media.ext],
    ["大小", formatBytes(media.size)],
    ["路径", media.relativePath]
  ]) {
    if (!value) continue;
    const item = document.createElement("div");
    item.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
    meta.append(item);
  }
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
