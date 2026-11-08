import { formatNumber } from "../../js/format.js";
import { createFallbackCover, portraitUrlForPerson } from "../../js/image.js?v=assets-0a663c3bea5d";
import { createViewportImageLoader } from "./features/shared/viewport-image-loader.js?v=assets-0a663c3bea5d";

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
  const filter = String(requestedFilter || "").trim().toLowerCase() === "western"
    ? "western"
    : normalizePeopleFilter(requestedFilter);
  return filterBrowsablePeople((people || []).filter(isBrowsableAuthor), filter);
}

function filterBrowsablePeople(candidates, filter) {
  if (filter === "western") return candidates.filter((person) => person?.isWestern);
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

function createPeopleRanker(people, compare, firstLimit) {
  if (people.length <= firstLimit) {
    people.sort(compare);
    return () => people;
  }
  const ranked = [];
  const heap = people.map((_person, index) => index);
  // Original positions break ties exactly as a stable sort would.
  const compareIndices = (a, b) => compare(people[a], people[b]) || a - b;

  function siftDown(parent) {
    const item = heap[parent];
    for (let child = parent * 2 + 1; child < heap.length; child = parent * 2 + 1) {
      if (child + 1 < heap.length && compareIndices(heap[child + 1], heap[child]) < 0) child++;
      if (compareIndices(item, heap[child]) <= 0) break;
      heap[parent] = heap[child];
      parent = child;
    }
    heap[parent] = item;
  }

  for (let index = Math.floor(heap.length / 2) - 1; index >= 0; index--) siftDown(index);
  return (limit) => {
    while (ranked.length < limit && heap.length) {
      const next = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        siftDown(0);
      }
      ranked.push(people[next]);
    }
    return ranked;
  };
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

    const candidates = sourcePeople.filter(isBrowsableAuthor);
    const people = filterBrowsablePeople(candidates, filterMode);
    const limit = getPeopleLimit();
    const { compare, validCounts } = peopleIndexComparator(people, sortMode);
    const rankUntil = createPeopleRanker(people, compare, validCounts ? limit + PEOPLE_PAGE_SIZE : people.length);
    const visible = rankUntil(limit + PEOPLE_PAGE_SIZE).slice(0, limit);
    indexAvatarLoader.reset();

    els.viewKicker.textContent = scope === "western" ? "欧美" : "演员";
    els.viewTitle.textContent = scope === "western" ? "人物" : peopleFilterTitle(filterMode);
    els.viewMeta.textContent = `${formatNumber(people.length)} 位演员 · ${sortDescription(sortMode)}`;
    const filterStrip = scope === "western" ? null : createPeopleFilterStrip(candidates, filterMode, people.length);
    const grid = document.createElement("div");
    grid.className = "people-grid";
    grid.classList.toggle("is-compact", shouldUseCompactPeopleLayout(people, scope));
    appendPeopleCards(grid, visible, indexAvatarLoader, scope);
    peopleIndexCache = { filterMode, filterStrip, grid, loadMore: null, peopleCount: people.length, rankUntil, scope, sortMode, sourcePeople };
    els.viewContent.replaceChildren(...[filterStrip, grid].filter(Boolean));
    appendPeopleIndexLoadMore(peopleIndexCache);
  }

  function restorePeopleIndex(sourcePeople, scope, sortMode, filterMode) {
    const cache = peopleIndexCache;
    if (!cache || cache.sourcePeople !== sourcePeople || cache.scope !== scope || cache.sortMode !== sortMode || cache.filterMode !== filterMode) return false;
    syncPeopleLimit(cache.grid.children.length);
    els.viewKicker.textContent = scope === "western" ? "欧美" : "演员";
    els.viewTitle.textContent = scope === "western" ? "人物" : peopleFilterTitle(filterMode);
    els.viewMeta.textContent = `${formatNumber(cache.peopleCount)} 位演员 · ${sortDescription(sortMode)}`;
    const nodes = (cache.loadMore ? [cache.filterStrip, cache.grid, cache.loadMore] : [cache.filterStrip, cache.grid]).filter(Boolean);
    els.viewContent.replaceChildren(...nodes);
    return true;
  }

  function createPeopleFilterStrip(candidates, activeFilter, activeCount) {
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
      count.textContent = formatNumber(active ? activeCount : filterBrowsablePeople(candidates, option.value).length);
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
    const { grid, peopleCount } = cache;
    const visibleCount = grid.children.length;
    if (visibleCount >= peopleCount) {
      cache.loadMore = null;
      return;
    }

    const loadMore = createLoadMoreButton(`向下滑动继续加载 ${formatNumber(visibleCount)} / ${formatNumber(peopleCount)}`, () => {
      const start = grid.children.length;
      syncPeopleLimit(start);
      increasePeopleLimit(PEOPLE_PAGE_SIZE);
      const nextLimit = Math.min(peopleCount, getPeopleLimit());
      appendPeopleCards(grid, cache.rankUntil(nextLimit).slice(start, nextLimit), indexAvatarLoader, cache.scope);
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

  function peopleIndexComparator(people, mode) {
    const sortFields = new Map();
    const usesSourceCount = mode === "sources" || mode === "smart";
    let validCounts = true;
    for (const person of people) {
      sortFields.set(person, { name: displayPersonName(person), visual: Boolean(portraitUrlForPerson(person)) });
      // Keep the old full-sort result for historical DTOs whose count
      // subtraction can fall through to a different comparator key.
      validCounts &&= Number.isFinite(Number(person.workCount || 0))
        && (!usesSourceCount || Number.isFinite(Number(person.sourceCount || 0)));
    }
    return { compare: (a, b) => comparePeople(a, b, mode, sortFields), validCounts };
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

  function comparePeople(a, b, mode, sortFields) {
    const aFields = sortFields?.get(a);
    const bFields = sortFields?.get(b);
    const aVisual = aFields?.visual ?? Boolean(portraitUrlForPerson(a));
    const bVisual = bFields?.visual ?? Boolean(portraitUrlForPerson(b));
    const byName = () => (aFields?.name ?? displayPersonName(a)).localeCompare(bFields?.name ?? displayPersonName(b), "zh-Hans-CN");
    if (mode === "works") {
      return (b.workCount || 0) - (a.workCount || 0)
        || bVisual - aVisual
        || byName();
    }
    if (mode === "sources") {
      return (b.sourceCount || 0) - (a.sourceCount || 0)
        || bVisual - aVisual
        || (b.workCount || 0) - (a.workCount || 0)
        || byName();
    }
    if (mode === "name") {
      return byName()
        || (b.workCount || 0) - (a.workCount || 0)
        || bVisual - aVisual;
    }
    return bVisual - aVisual
      || (b.workCount || 0) - (a.workCount || 0)
      || (b.sourceCount || 0) - (a.sourceCount || 0)
      || byName();
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
