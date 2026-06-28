export function createPeoplePage(deps) {
  const {
    api,
    appendEmpty,
    cancelScheduledWorkRendering,
    clearWorkFilter,
    clearWorkSearch,
    closeDrawer,
    coverUrl,
    createInfoChip,
    currentPageScrollTop,
    displayPersonName,
    els,
    formatLibraryPaths,
    formatNumber,
    hidePersonProfile,
    includesText,
    personSearchText,
    renderPersonProfile,
    renderPersonWorkStats,
    renderWorks,
    resetProgressiveCoverLoading,
    resetWorkPaging,
    restorePageScrollTop,
    setMainHeader,
    state,
    syncNavigationState,
    syncRouteAfterNavigation
  } = deps;

  let peopleIndexLoadObserver = null;

function filteredPeople() {
  return state.people.filter((person) => includesText(personSearchText(person), state.personQuery));
}

function renderPeople() {
  const filtered = filteredPeople();
  els.personList.innerHTML = "";

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "没有匹配的人物";
    els.personList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const person of filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `person-button${person.id === state.selectedPersonId && state.activeView === "people" ? " active" : ""}`;
    button.dataset.personId = person.id;
    button.addEventListener("click", () => {
      clearWorkSearch();
      state.activeView = "people";
      selectPerson(person.id);
    });

    const name = document.createElement("span");
    name.className = "person-name";
    name.textContent = displayPersonName(person);

    const count = document.createElement("span");
    count.className = "person-count";
    count.textContent =
      person.sourceCount > 1 ? `${formatNumber(person.workCount)} 部 · ${person.sourceCount} 处` : `${formatNumber(person.workCount)} 部`;

    button.append(name, count);
    fragment.append(button);
  }
  els.personList.append(fragment);
}

function updateActivePersonButton() {
  const buttons = els.personList.querySelectorAll(".person-button");
  if (!buttons.length) {
    renderPeople();
    return;
  }

  const activePersonId = state.activeView === "people" ? state.selectedPersonId || "" : "";
  for (const button of buttons) {
    button.classList.toggle("active", Boolean(activePersonId) && button.dataset.personId === activePersonId);
  }
}

function showPeopleIndex(options = {}) {
  state.activeView = "people";
  state.selectedPersonId = null;
  state.selectedPerson = null;
  state.searchPeople = [];
  state.works = [];
  state.personWorksTotal = 0;
  state.personWorksFacets = null;
  updateActivePersonButton();
  syncNavigationState("people");
  hidePersonProfile();
  setMainHeader("人物索引", "按人物浏览全部资料库");
  renderPeopleIndexStats();
  renderPeopleIndex();
  if (options.restoreScroll !== false) {
    restorePageScrollTop(state.peopleIndexScrollTop);
  }
  syncRouteAfterNavigation({
    ...options,
    routeOverrides: { view: "people", personId: "", q: "", workId: "", videoId: "" }
  });
}

function renderPeopleIndexStats() {
  const people = filteredPeople();
  const stats = [
    ["人物", people.length],
    ["有头像", people.filter((person) => actorAvatarUrl(person)).length],
    ["作品", people.reduce((sum, person) => sum + (person.workCount || 0), 0)],
    ["多来源", people.filter((person) => (person.sourceCount || 0) > 1).length]
  ];

  els.statsRow.innerHTML = "";
  for (const [label, value] of stats) {
    const stat = document.createElement("div");
    stat.className = "stat";
    stat.innerHTML = `<strong>${formatNumber(value)}</strong><span>${label}</span>`;
    els.statsRow.append(stat);
  }
}

function renderPeopleIndex() {
  disconnectPeopleIndexAutoload();
  cancelScheduledWorkRendering();
  resetProgressiveCoverLoading();
  const people = filteredPeople();
  els.workGrid.innerHTML = "";

  if (!people.length) {
    appendEmpty("没有匹配的人物。");
    return;
  }

  const fragment = document.createDocumentFragment();
  const visible = people.slice(0, state.personVisibleLimit);
  for (const person of visible) {
    fragment.append(createPersonIndexCard(person));
  }
  els.workGrid.append(fragment);

  if (visible.length < people.length) {
    appendPeopleIndexLoadMore(visible.length, people.length);
  }
}

function disconnectPeopleIndexAutoload() {
  if (!peopleIndexLoadObserver) return;
  peopleIndexLoadObserver.disconnect();
  peopleIndexLoadObserver = null;
}

function loadMorePeopleIndex() {
  if (state.activeView !== "people" || state.selectedPersonId) return;
  const people = filteredPeople();
  if (state.personVisibleLimit >= people.length) return;
  state.personVisibleLimit = Math.min(people.length, state.personVisibleLimit + state.personPageSize);
  renderPeopleIndex();
}

function observePeopleIndexLoadMore(target) {
  if (!("IntersectionObserver" in window)) return;
  peopleIndexLoadObserver = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      window.setTimeout(loadMorePeopleIndex, 80);
    },
    { root: null, rootMargin: "720px 0px", threshold: 0 }
  );
  peopleIndexLoadObserver.observe(target);
}

function appendPeopleIndexLoadMore(visibleCount, totalCount) {
  const wrap = document.createElement("div");
  wrap.className = "load-more-row";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "text-button";
  button.textContent = `显示更多人物 ${formatNumber(visibleCount)} / ${formatNumber(totalCount)}`;
  button.addEventListener("click", loadMorePeopleIndex);

  wrap.append(button);
  els.workGrid.append(wrap);
  observePeopleIndexLoadMore(wrap);
}

function actorAvatarUrl(person) {
  return person?.actorProfile?.avatarUrl || coverUrl(person?.coverId);
}

function createPersonIndexCard(person) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "person-index-card";
  card.addEventListener("click", () => {
    clearWorkSearch();
    selectPerson(person.id);
  });

  const avatar = document.createElement("div");
  avatar.className = "person-index-avatar";
  const avatarUrl = actorAvatarUrl(person);
  if (avatarUrl) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.decoding = "async";
    img.alt = "";
    img.src = avatarUrl;
    img.addEventListener("error", () => {
      img.remove();
      avatar.classList.add("empty");
      avatar.textContent = person.name.slice(0, 2);
    });
    avatar.append(img);
  } else {
    avatar.classList.add("empty");
    avatar.textContent = person.name.slice(0, 2);
  }

  const body = document.createElement("div");
  body.className = "person-index-body";

  const name = document.createElement("div");
  name.className = "person-index-name";
  name.textContent = person.actorProfile?.displayName || person.name;

  const sub = document.createElement("div");
  sub.className = "person-index-sub";
  const aliases = person.actorProfile?.aliases || [];
  sub.textContent = aliases.length ? aliases.slice(0, 3).join("、") : formatLibraryPaths(person.sourcePaths || [person.relativePath]);

  const metrics = document.createElement("div");
  metrics.className = "person-index-metrics";
  metrics.append(createInfoChip(`${formatNumber(person.workCount)} 部`, "code"));
  metrics.append(createInfoChip(`${formatNumber(person.videoCount)} 视频`));

  body.append(name, sub, metrics);
  card.append(avatar, body);
  return card;
}

async function selectPerson(personId, options = {}) {
  disconnectPeopleIndexAutoload();
  if (state.activeView === "people" && !state.selectedPersonId && options.captureIndexScroll !== false) {
    state.peopleIndexScrollTop = currentPageScrollTop();
  }
  state.selectedPersonId = personId;
  state.activeView = "people";
  state.searchPeople = [];
  if (options.resetFilter !== false) {
    clearWorkFilter();
  }
  syncNavigationState("people");
  updateActivePersonButton();
  els.workGrid.innerHTML = `<div class="empty-state">正在加载作品</div>`;

  const data = await fetchPersonWorksPage(personId, 0);
  state.selectedPerson = data.person;
  state.works = data.works || [];
  state.personWorksTotal = data.total || state.works.length;
  state.personWorksFacets = data.facets || null;
  resetWorkPaging();
  setMainHeader(state.selectedPerson.name, formatLibraryPaths(state.selectedPerson.sourcePaths || [state.selectedPerson.relativePath]));
  renderPersonProfile(state.selectedPerson);
  renderPersonWorkStats();
  renderWorks();
  syncRouteAfterNavigation({
    ...options,
    routeOverrides: { view: "people", personId, q: "", workId: "", videoId: "" }
  });
}

function personWorkPageSize() {
  return Math.max(80, Number(state.workPageSize || 160));
}

async function fetchPersonWorksPage(personId, offset = 0) {
  const params = new URLSearchParams({
    limit: String(personWorkPageSize()),
    offset: String(offset || 0),
    sort: state.sortMode || "updated",
    filter: state.filterMode || "all"
  });
  return api(`/api/people/${encodeURIComponent(personId)}?${params}`);
}

async function goToPerson(personId) {
  if (!personId) return;
  if (els.detailDrawer.classList.contains("open")) {
    closeDrawer();
  }
  clearWorkSearch();
  await selectPerson(personId);
}

function resetPersonPaging() {
  state.personVisibleLimit = state.personPageSize;
}

  return {
    disconnectIndexAutoload: disconnectPeopleIndexAutoload,
    fetchPersonWorksPage,
    goToPerson,
    personWorkPageSize,
    renderIndex: renderPeopleIndex,
    renderIndexStats: renderPeopleIndexStats,
    renderPeople,
    resetPaging: resetPersonPaging,
    selectPerson,
    showIndex: showPeopleIndex,
    updateActivePersonButton
  };
}
