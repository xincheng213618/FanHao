import { formatNumber } from "../../js/format.js";
import { createFallbackCover, portraitUrlForPerson } from "../../js/image.js?v=20260721-fanhao-author-portraits-06";
import { createViewportImageLoader } from "./features/shared/viewport-image-loader.js?v=20260717-fanhao-people-first-paint-01";

const PEOPLE_SORT_STORAGE_KEY = "fanhao.android.peopleSort";
const PEOPLE_PAGE_SIZE = 64;
const PERSON_AVATAR_ROOT_MARGIN = "560px 320px";
const PEOPLE_SORTS = [
  { value: "smart", label: "常用优先", description: "常用优先" },
  { value: "works", label: "作品最多", description: "作品最多" },
  { value: "sources", label: "多来源", description: "多来源优先" },
  { value: "name", label: "名称排序", description: "按名称" }
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

export function createPeopleViews(context) {
  const {
    els,
    getActiveUrl,
    getLibrary,
    getPeopleLimit,
    increasePeopleLimit,
    showView,
    setActiveBottom,
    createLoadMoreButton
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

  function visiblePeople(people) {
    return (people || []).filter((person) => person?.actorProfile?.gender !== "male" && isBrowsableAuthor(person));
  }

  function renderPreviewPeople(people) {
    const list = visiblePeople(people);
    previewAvatarLoader.reset();
    els.personPreview.innerHTML = "";
    if (!list.length) {
      els.personPreview.innerHTML = `<div class="loading-row">暂无作者数据</div>`;
      return;
    }

    for (const person of list) {
      els.personPreview.append(createPersonCard(person, "preview", previewAvatarLoader));
    }
  }

  function renderPeopleIndex() {
    setActiveBottom("people");
    const sortMode = getPeopleSortMode();
    const sourcePeople = getLibrary()?.people || [];
    if (restorePeopleIndex(sourcePeople, sortMode)) return;

    const people = visiblePeople(sourcePeople).sort((a, b) => comparePeople(a, b, sortMode));
    const visible = people.slice(0, getPeopleLimit());
    indexAvatarLoader.reset();

    els.viewKicker.textContent = "作者索引";
    els.viewTitle.textContent = "全部作者";
    els.viewMeta.textContent = `${formatNumber(people.length)} 位作者 · ${sortDescription(sortMode)}`;
    const grid = document.createElement("div");
    grid.className = "people-grid";
    appendPeopleCards(grid, visible, indexAvatarLoader);
    peopleIndexCache = { grid, loadMore: null, people, sortMode, sourcePeople };
    els.viewContent.replaceChildren(grid);
    appendPeopleIndexLoadMore(peopleIndexCache);
  }

  function restorePeopleIndex(sourcePeople, sortMode) {
    const cache = peopleIndexCache;
    if (!cache || cache.sourcePeople !== sourcePeople || cache.sortMode !== sortMode) return false;
    syncPeopleLimit(cache.grid.children.length);
    els.viewKicker.textContent = "作者索引";
    els.viewTitle.textContent = "全部作者";
    els.viewMeta.textContent = `${formatNumber(cache.people.length)} 位作者 · ${sortDescription(sortMode)}`;
    const nodes = cache.loadMore ? [cache.grid, cache.loadMore] : [cache.grid];
    els.viewContent.replaceChildren(...nodes);
    return true;
  }

  function appendPeopleCards(grid, people, avatarLoader) {
    const fragment = document.createDocumentFragment();
    for (const person of people) fragment.append(createPersonCard(person, "index", avatarLoader));
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
      appendPeopleCards(grid, people.slice(start, nextLimit), indexAvatarLoader);
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

  function sortDescription(mode) {
    return PEOPLE_SORTS.find((item) => item.value === mode)?.description || PEOPLE_SORTS[0].description;
  }

  function setPeopleSortMode(value) {
    if (!PEOPLE_SORTS.some((item) => item.value === value) || value === getPeopleSortMode()) return false;
    localStorage.setItem(PEOPLE_SORT_STORAGE_KEY, value);
    renderPeopleIndex();
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
    return authorPriority(b) - authorPriority(a)
      || (b.sourceCount || 0) - (a.sourceCount || 0)
      || bVisual - aVisual
      || (b.workCount || 0) - (a.workCount || 0)
      || byName();
  }

  function authorPriority(person) {
    return isBrowsableAuthor(person) ? 1 : 0;
  }

  function createPersonCard(person, mode, avatarLoader = mode === "preview" ? previewAvatarLoader : indexAvatarLoader) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = mode === "preview" ? "person-card" : "index-person-card";
    button.addEventListener("click", () => showView("personDetail", { personId: person.id }, { push: true }));

    const visual = createFallbackCover(person.name);
    button.append(visual);
    const imagePath = portraitUrlForPerson(person);
    if (imagePath) {
      avatarLoader.schedule(visual, imagePath);
    }

    const name = document.createElement("strong");
    name.textContent = displayPersonName(person);

    if (mode === "preview") {
      const meta = document.createElement("span");
      const sources = person.sourceCount > 1 ? ` · ${formatNumber(person.sourceCount)} 处` : "";
      meta.textContent = `${formatNumber(person.workCount)} 部${sources}`;
      button.append(name, meta);
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

    const meta = document.createElement("span");
    meta.className = "index-person-meta";
    const sources = person.sourceCount > 1 ? ` · ${formatNumber(person.sourceCount)} 来源` : "";
    meta.textContent = `${formatNumber(person.workCount)} 部${sources}`;
    body.append(meta);

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
