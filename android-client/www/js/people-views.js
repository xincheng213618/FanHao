import { formatNumber } from "./format.js";
import { absoluteUrl, createFallbackCover, imageUrlForPerson, loadPreviewImage } from "./image.js";

const PEOPLE_SORT_STORAGE_KEY = "fanhao.android.peopleSort";
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
    createLoadMoreButton,
    renderCurrentViewPreservingScroll
  } = context;

  function renderPreviewPeople(people) {
    els.personPreview.innerHTML = "";
    if (!people.length) {
      els.personPreview.innerHTML = `<div class="loading-row">暂无人物数据</div>`;
      return;
    }

    for (const person of people) {
      els.personPreview.append(createPersonCard(person, "preview"));
    }
  }

  function renderPeopleIndex() {
    setActiveBottom("people");
    const sortMode = getPeopleSortMode();
    const people = [...(getLibrary()?.people || [])].sort((a, b) => comparePeople(a, b, sortMode));
    const visible = people.slice(0, getPeopleLimit());

    els.viewKicker.textContent = "人物索引";
    els.viewTitle.textContent = "全部人物";
    els.viewMeta.textContent = `${formatNumber(people.length)} 人 · ${sortDescription(sortMode)}`;
    els.viewContent.innerHTML = "";
    els.viewContent.append(createPeopleSortControls(sortMode));

    const grid = document.createElement("div");
    grid.className = "people-grid";
    for (const person of visible) grid.append(createPersonCard(person, "index"));
    els.viewContent.append(grid);

    if (visible.length < people.length) {
      els.viewContent.append(createLoadMoreButton(`向下滑动继续加载 ${formatNumber(visible.length)} / ${formatNumber(people.length)}`, () => {
        increasePeopleLimit(80);
        if (renderCurrentViewPreservingScroll) return renderCurrentViewPreservingScroll();
        renderPeopleIndex();
      }));
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
    const aVisual = a.actorProfile?.avatarUrl ? 2 : a.coverId ? 1 : 0;
    const bVisual = b.actorProfile?.avatarUrl ? 2 : b.coverId ? 1 : 0;
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

  function createPersonCard(person, mode) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = mode === "preview" ? "person-card" : "index-person-card";
    button.addEventListener("click", () => showView("personDetail", { personId: person.id }, { push: true }));

    const visual = createFallbackCover(person.name);
    button.append(visual);
    const imagePath = imageUrlForPerson(person);
    if (imagePath) {
      const activeUrl = getActiveUrl();
      loadPreviewImage(visual, absoluteUrl(activeUrl, imagePath), { cacheBaseUrl: activeUrl });
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
