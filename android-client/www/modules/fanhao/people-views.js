import { formatNumber } from "../../js/format.js";
import { createFallbackCover, imageUrlForPerson } from "../../js/image.js?v=20260717-fanhao-cover-prepare-01";
import { createViewportImageLoader } from "./features/shared/viewport-image-loader.js?v=20260717-fanhao-people-first-paint-01";

const PEOPLE_SORT_STORAGE_KEY = "fanhao.android.peopleSort";
const PEOPLE_PAGE_SIZE = 64;
const PERSON_AVATAR_ROOT_MARGIN = "560px 320px";
const PEOPLE_SORTS = [
  { value: "smart", label: "默认", description: "头像优先" },
  { value: "works", label: "作品", description: "作品最多" },
  { value: "videos", label: "视频", description: "视频最多" },
  { value: "name", label: "名称", description: "按名称" }
];

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
    return (people || []).filter((person) => person?.actorProfile?.gender !== "male");
  }

  function renderPreviewPeople(people) {
    const list = visiblePeople(people);
    previewAvatarLoader.reset();
    els.personPreview.innerHTML = "";
    if (!list.length) {
      els.personPreview.innerHTML = `<div class="loading-row">暂无人物数据</div>`;
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

    els.viewKicker.textContent = "人物索引";
    els.viewTitle.textContent = "全部人物";
    els.viewMeta.textContent = `${formatNumber(people.length)} 人 · ${sortDescription(sortMode)}`;
    const controls = createPeopleSortControls(sortMode);
    const grid = document.createElement("div");
    grid.className = "people-grid";
    appendPeopleCards(grid, visible, indexAvatarLoader);
    peopleIndexCache = { controls, grid, loadMore: null, people, sortMode, sourcePeople };
    els.viewContent.replaceChildren(controls, grid);
    appendPeopleIndexLoadMore(peopleIndexCache);
  }

  function restorePeopleIndex(sourcePeople, sortMode) {
    const cache = peopleIndexCache;
    if (!cache || cache.sourcePeople !== sourcePeople || cache.sortMode !== sortMode) return false;
    syncPeopleLimit(cache.grid.children.length);
    els.viewKicker.textContent = "人物索引";
    els.viewTitle.textContent = "全部人物";
    els.viewMeta.textContent = `${formatNumber(cache.people.length)} 人 · ${sortDescription(sortMode)}`;
    const nodes = cache.loadMore ? [cache.controls, cache.grid, cache.loadMore] : [cache.controls, cache.grid];
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

  function createPeopleSortControls(activeMode) {
    const row = document.createElement("div");
    row.className = "people-sort-row";
    for (const option of PEOPLE_SORTS) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = option.label;
      button.classList.toggle("active", option.value === activeMode);
      button.setAttribute("aria-pressed", option.value === activeMode ? "true" : "false");
      button.addEventListener("click", () => {
        if (option.value === getPeopleSortMode()) return;
        localStorage.setItem(PEOPLE_SORT_STORAGE_KEY, option.value);
        renderPeopleIndex();
      });
      row.append(button);
    }
    return row;
  }

  function comparePeople(a, b, mode) {
    const aVisual = imageUrlForPerson(a) ? 1 : 0;
    const bVisual = imageUrlForPerson(b) ? 1 : 0;
    const byName = () => displayPersonName(a).localeCompare(displayPersonName(b), "zh-Hans-CN");
    if (mode === "works") {
      return (b.workCount || 0) - (a.workCount || 0)
        || (b.videoCount || 0) - (a.videoCount || 0)
        || bVisual - aVisual
        || byName();
    }
    if (mode === "videos") {
      return (b.videoCount || 0) - (a.videoCount || 0)
        || (b.workCount || 0) - (a.workCount || 0)
        || bVisual - aVisual
        || byName();
    }
    if (mode === "name") {
      return byName()
        || (b.workCount || 0) - (a.workCount || 0)
        || (b.videoCount || 0) - (a.videoCount || 0);
    }
    return bVisual - aVisual
      || (b.workCount || 0) - (a.workCount || 0)
      || (b.videoCount || 0) - (a.videoCount || 0)
      || byName();
  }

  function displayPersonName(person) {
    return String(person.actorProfile?.displayName || person.name || "");
  }

  function createPersonCard(person, mode, avatarLoader = mode === "preview" ? previewAvatarLoader : indexAvatarLoader) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = mode === "preview" ? "person-card" : "index-person-card";
    button.addEventListener("click", () => showView("personDetail", { personId: person.id }, { push: true }));

    const visual = createFallbackCover(person.name);
    button.append(visual);
    const imagePath = imageUrlForPerson(person);
    if (imagePath) {
      avatarLoader.schedule(visual, imagePath);
    }

    const name = document.createElement("strong");
    name.textContent = displayPersonName(person);

    if (mode === "preview") {
      const meta = document.createElement("span");
      const sources = person.sourceCount > 1 ? ` · ${formatNumber(person.sourceCount)} 处` : "";
      meta.textContent = `${formatNumber(person.workCount)} 部 · ${formatNumber(person.videoCount)} 视频${sources}`;
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

    button.append(body);
    return button;
  }

  return {
    renderPreviewPeople,
    renderPeopleIndex,
    createPersonCard,
    sortPeople
  };
}
