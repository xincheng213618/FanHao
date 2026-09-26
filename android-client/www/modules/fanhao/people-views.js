import { formatNumber } from "../../js/format.js";
import { createFallbackCover, portraitUrlForPerson } from "../../js/image.js?v=assets-0f97d6765d71";
import { createViewportImageLoader } from "./features/shared/viewport-image-loader.js?v=assets-0f97d6765d71";

const PEOPLE_SORT_STORAGE_KEY = "fanhao.android.peopleSort";
const PEOPLE_FILTER_STORAGE_KEY = "fanhao.android.peopleFilter";
const PEOPLE_PAGE_SIZE = 64;
const PERSON_AVATAR_ROOT_MARGIN = "560px 320px";
const PEOPLE_SORTS = [
  { value: "smart", label: "推荐排序", description: "推荐排序" },
  { value: "works", label: "本地作品", description: "本地作品数量排序" },
  { value: "sources", label: "多来源", description: "多来源优先" },
  { value: "name", label: "名称排序", description: "按名称" }
];
const PEOPLE_FILTERS = [
  { value: "recommended", label: "推荐", title: "推荐演员" },
  { value: "female", label: "女演员", title: "女演员" },
  { value: "male", label: "男演员", title: "男演员" },
  { value: "all", label: "全部", title: "全部演员" }
];

function displayPersonName(person) {
  return String(person?.actorProfile?.displayName || person?.name || "");
}

export function isBrowsableAuthor(person) {
  const name = displayPersonName(person).trim();
  const compact = name.toLocaleLowerCase().replace(/\s+/gu, "");
  if (!name || /^(?:noactor|unknownactor|unknown|未知|未知作者|无名|無名|なし)$/iu.test(compact)) return false;
  if (/^[\[【][^\]】]*[\]】]$/u.test(name)) return false;
  if (Array.from(name).length > 28) return false;
  if (/[（(]\d{4}\s*[-–—]\s*\d{4}[）)]/u.test(name)) return false;
  if (/(?:mega\s*pack|actress\s*pack|collection\s*videos?)/iu.test(name)) return false;
  return true;
}

export function normalizePeopleFilter(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return PEOPLE_FILTERS.some((item) => item.value === normalized) ? normalized : "recommended";
}

export function filterPeopleForIndex(people, requestedFilter = "recommended") {
  if (String(requestedFilter || "").trim().toLowerCase() === "western") {
    return (people || []).filter(isBrowsableAuthor).filter((person) => person?.isWestern);
  }
  const filter = normalizePeopleFilter(requestedFilter);
  const candidates = (people || []).filter(isBrowsableAuthor);
  if (filter === "female") return candidates.filter((person) => person?.actorProfile?.gender === "female");
  if (filter === "male") return candidates.filter((person) => person?.actorProfile?.gender === "male");
  if (filter === "all") return candidates;
  return candidates.filter((person) => (
    person?.actorProfile?.gender !== "male"
    && !person?.isWestern
    && Boolean(portraitUrlForPerson(person))
  ));
}

export function shouldUseCompactPeopleLayout(people, scope = "main") {
  if (normalizePeopleScope(scope) !== "western") return false;
  const candidates = (Array.isArray(people) ? people : []).filter(isBrowsableAuthor);
  if (candidates.length < 6) return false;
  const portraitCount = candidates.filter((person) => Boolean(portraitUrlForPerson(person))).length;
  return portraitCount * 2 < candidates.length;
}

export function createPeopleViews(context) {
  const {
    els,
    getActiveUrl,
    getLibrary,
    getPeopleLimit,
    increasePeopleLimit,
    showView,
    setActiveBottom,
    createLoadMoreButton,
    pageDataService
  } = context;
  const previewAvatarLoader = createViewportImageLoader({
    getActiveUrl,
    rootMargin: PERSON_AVATAR_ROOT_MARGIN
  });
  const indexAvatarLoader = createViewportImageLoader({
    getActiveUrl,
    rootMargin: PERSON_AVATAR_ROOT_MARGIN
  });
  let peopleIndexCache = null;
  let activePeopleScope = "main";

  function renderPreviewPeople(people) {
    const list = filterPeopleForIndex(people, "recommended").sort((a, b) => comparePeople(a, b, "smart")).slice(0, 12);
    previewAvatarLoader.reset();
    els.personPreview.innerHTML = "";
    if (!list.length) {
      els.personPreview.innerHTML = `<div class="loading-row">暂无演员数据</div>`;
      return;
    }

    for (const person of list) {
      els.personPreview.append(createPersonCard(person, "preview", previewAvatarLoader));
    }
  }

  async function renderPeopleIndex(requestedScope = "main", isActive = () => true) {
    const scope = normalizePeopleScope(requestedScope);
    activePeopleScope = scope;
    setActiveBottom("people");
    if (scope === "main") {
      renderPeopleData(getLibrary()?.people || [], scope);
      return;
    }

    els.viewKicker.textContent = "欧美";
    els.viewTitle.textContent = "人物";
    els.viewMeta.textContent = "正在读取欧美人物";
    els.viewContent.innerHTML = `<div class="loading-row">正在整理欧美人物</div>`;
    let renderedCache = false;
    try {
      const result = await pageDataService.load(getActiveUrl(), "/api/library?scope=western", {
        signal: isActive.signal,
        isActive,
        onCached(data) {
          renderedCache = true;
          renderPeopleData(data.people || [], scope);
        }
      });
      if (!result || !isActive()) return;
      if (!result.unchanged) renderPeopleData(result.data?.people || [], scope);
    } catch (error) {
      if (!isActive() || renderedCache) return;
      els.viewMeta.textContent = "读取失败";
      const message = document.createElement("div");
      message.className = "message-box error";
      message.textContent = String(error?.message || "欧美人物读取失败");
      els.viewContent.replaceChildren(message);
    }
  }

  function renderPeopleData(sourcePeople, scope) {
    const sortMode = getPeopleSortMode();
    const filterMode = scope === "western" ? "western" : getPeopleFilterMode();
    if (restorePeopleIndex(sourcePeople, scope, sortMode, filterMode)) return;

    const people = filterPeopleForIndex(sourcePeople, filterMode).sort((a, b) => comparePeople(a, b, sortMode));
    const visible = people.slice(0, getPeopleLimit());
    indexAvatarLoader.reset();

    els.viewKicker.textContent = scope === "western" ? "欧美" : "演员";
    els.viewTitle.textContent = scope === "western" ? "人物" : peopleFilterTitle(filterMode);
    els.viewMeta.textContent = `${formatNumber(people.length)} 位演员 · ${sortDescription(sortMode)}`;
    const filterStrip = scope === "western" ? null : createPeopleFilterStrip(sourcePeople, filterMode);
    const grid = document.createElement("div");
    grid.className = "people-grid";
    grid.classList.toggle("is-compact", shouldUseCompactPeopleLayout(people, scope));
    appendPeopleCards(grid, visible, indexAvatarLoader, scope);
    peopleIndexCache = { filterMode, filterStrip, grid, loadMore: null, people, scope, sortMode, sourcePeople };
    els.viewContent.replaceChildren(...[filterStrip, grid].filter(Boolean));
    appendPeopleIndexLoadMore(peopleIndexCache);
  }

  function restorePeopleIndex(sourcePeople, scope, sortMode, filterMode) {
    const cache = peopleIndexCache;
    if (!cache || cache.sourcePeople !== sourcePeople || cache.scope !== scope || cache.sortMode !== sortMode || cache.filterMode !== filterMode) return false;
    syncPeopleLimit(cache.grid.children.length);
    els.viewKicker.textContent = scope === "western" ? "欧美" : "演员";
    els.viewTitle.textContent = scope === "western" ? "人物" : peopleFilterTitle(filterMode);
    els.viewMeta.textContent = `${formatNumber(cache.people.length)} 位演员 · ${sortDescription(sortMode)}`;
    const nodes = (cache.loadMore ? [cache.filterStrip, cache.grid, cache.loadMore] : [cache.filterStrip, cache.grid]).filter(Boolean);
    els.viewContent.replaceChildren(...nodes);
    return true;
  }

  function createPeopleFilterStrip(sourcePeople, activeFilter) {
    const strip = document.createElement("nav");
    strip.className = "people-category-strip";
    strip.setAttribute("aria-label", "演员分类");
    for (const option of PEOPLE_FILTERS) {
      const button = document.createElement("button");
      button.type = "button";
      const active = option.value === activeFilter;
      button.className = active ? "active" : "";
      button.setAttribute("aria-pressed", active ? "true" : "false");
      const label = document.createElement("strong");
      label.textContent = option.label;
      const count = document.createElement("span");
      count.textContent = formatNumber(filterPeopleForIndex(sourcePeople, option.value).length);
      button.append(label, count);
      button.addEventListener("click", () => setPeopleFilterMode(option.value));
      strip.append(button);
    }
    return strip;
  }

  function appendPeopleCards(grid, people, avatarLoader, scope = activePeopleScope) {
    const fragment = document.createDocumentFragment();
    for (const person of people) fragment.append(createPersonCard(person, "index", avatarLoader, scope));
    grid.append(fragment);
  }

  function appendPeopleIndexLoadMore(cache) {
    const { grid, people } = cache;
    const visibleCount = grid.children.length;
    if (visibleCount >= people.length) {
      cache.loadMore = null;
      return;
    }

    const loadMore = createLoadMoreButton(`向下滑动继续加载 ${formatNumber(visibleCount)} / ${formatNumber(people.length)}`, () => {
      const start = grid.children.length;
      syncPeopleLimit(start);
      increasePeopleLimit(PEOPLE_PAGE_SIZE);
      const nextLimit = Math.min(people.length, getPeopleLimit());
      appendPeopleCards(grid, people.slice(start, nextLimit), indexAvatarLoader, cache.scope);
      loadMore.remove();
      cache.loadMore = null;
      appendPeopleIndexLoadMore(cache);
    });
    cache.loadMore = loadMore;
    els.viewContent.append(loadMore);
  }

  function syncPeopleLimit(renderedCount) {
    while (getPeopleLimit() < renderedCount) {
      const before = getPeopleLimit();
      increasePeopleLimit(Math.min(PEOPLE_PAGE_SIZE, renderedCount - before));
      if (getPeopleLimit() <= before) break;
    }
  }

  function sortPeople(a, b) {
    return comparePeople(a, b, "smart");
  }

  function getPeopleSortMode() {
    const value = localStorage.getItem(PEOPLE_SORT_STORAGE_KEY) || "smart";
    return PEOPLE_SORTS.some((item) => item.value === value) ? value : "smart";
  }

  function getPeopleFilterMode() {
    return normalizePeopleFilter(localStorage.getItem(PEOPLE_FILTER_STORAGE_KEY));
  }

  function peopleFilterTitle(mode) {
    return PEOPLE_FILTERS.find((item) => item.value === mode)?.title || PEOPLE_FILTERS[0].title;
  }

  function setPeopleFilterMode(value) {
    const normalized = normalizePeopleFilter(value);
    if (normalized === getPeopleFilterMode()) return false;
    localStorage.setItem(PEOPLE_FILTER_STORAGE_KEY, normalized);
    void renderPeopleIndex(activePeopleScope);
    return true;
  }

  function sortDescription(mode) {
    return PEOPLE_SORTS.find((item) => item.value === mode)?.description || PEOPLE_SORTS[0].description;
  }

  function setPeopleSortMode(value) {
    if (!PEOPLE_SORTS.some((item) => item.value === value) || value === getPeopleSortMode()) return false;
    localStorage.setItem(PEOPLE_SORT_STORAGE_KEY, value);
    void renderPeopleIndex(activePeopleScope);
    return true;
  }

  function comparePeople(a, b, mode) {
    const aVisual = portraitUrlForPerson(a) ? 1 : 0;
    const bVisual = portraitUrlForPerson(b) ? 1 : 0;
    const byName = () => displayPersonName(a).localeCompare(displayPersonName(b), "zh-Hans-CN");
    if (mode === "works") {
      return authorPriority(b) - authorPriority(a)
        || (b.workCount || 0) - (a.workCount || 0)
        || bVisual - aVisual
        || byName();
    }
    if (mode === "sources") {
      return authorPriority(b) - authorPriority(a)
        || (b.sourceCount || 0) - (a.sourceCount || 0)
        || bVisual - aVisual
        || (b.workCount || 0) - (a.workCount || 0)
        || byName();
    }
    if (mode === "name") {
      return authorPriority(b) - authorPriority(a)
        || byName()
        || (b.workCount || 0) - (a.workCount || 0)
        || bVisual - aVisual;
    }
    return bVisual - aVisual
      || (b.workCount || 0) - (a.workCount || 0)
      || (b.sourceCount || 0) - (a.sourceCount || 0)
      || byName();
  }

  function authorPriority(person) {
    return isBrowsableAuthor(person) ? 1 : 0;
  }

  function createPersonCard(person, mode, avatarLoader = mode === "preview" ? previewAvatarLoader : indexAvatarLoader, scope = "main") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = mode === "preview" ? "person-card" : "index-person-card";
    button.addEventListener("click", () => showView("personDetail", { personId: person.id, scope }, { push: true }));

    const visual = createFallbackCover(person.name);
    button.append(visual);
    const imagePath = portraitUrlForPerson(person);
    button.classList.add(imagePath ? "has-portrait" : "is-placeholder");
    if (imagePath) {
      avatarLoader.schedule(visual, imagePath);
    }

    const name = document.createElement("strong");
    name.textContent = displayPersonName(person);

    if (mode === "preview") {
      button.append(name);
      return button;
    }

    const body = document.createElement("div");
    body.className = "index-person-body";
    const rawName = String(person.name || "").trim();
    const displayName = String(person.actorProfile?.displayName || "").trim();
    if (displayName && rawName && displayName !== rawName) {
      const alias = document.createElement("span");
      alias.className = "index-person-alias";
      alias.textContent = rawName;
      body.append(name, alias);
    } else {
      body.append(name);
    }

    button.append(body);
    return button;
  }

  return {
    renderPreviewPeople,
    renderPeopleIndex,
    createPersonCard,
    getSortMode: getPeopleSortMode,
    getSortOptions: () => PEOPLE_SORTS.map(({ value, label }) => ({ value, label })),
    setSortMode: setPeopleSortMode,
    sortPeople
  };
}

function normalizePeopleScope(value) {
  return String(value || "main").trim().toLowerCase() === "western" ? "western" : "main";
}
