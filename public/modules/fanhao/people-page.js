import { createLatestRequestGate } from "./latest-request.js?v=20260717-fanhao-latest-request-01";
import { createPrefetchCache } from "./prefetch-cache.js?v=20261004-fanhao-requests-01";

const PERSON_DETAIL_DESKTOP_PAGE_SIZE = 64;
const PERSON_DETAIL_MOBILE_PAGE_SIZE = 48;
const PERSON_INDEX_DESKTOP_PAGE_SIZE = 64;
const PERSON_INDEX_MOBILE_PAGE_SIZE = 48;
const PERSON_DETAIL_PREFETCH_LIMIT = 8;
const PERSON_DETAIL_PREFETCH_TTL_MS = 15_000;
const PERSON_DETAIL_HOVER_DELAY_MS = 80;

export function createPeoplePage(deps) {
  const {
    api,
    appendEmpty,
    appendLoadedWorkPage,
    cancelScheduledWorkRendering,
    clearWorkFilter,
    clearWorkSearch,
    coverUrl,
    currentPageScrollTop,
    displayPersonName,
    els,
    formatLibraryPaths,
    formatNumber,
    getWorkFilterMode,
    hidePersonProfile,
    onNavigationStarted,
    preparePersonProfile,
    renderPersonProfile,
    renderPersonWorkStats,
    renderWorks,
    resetProgressiveCoverLoading,
    resetWorkPaging,
    restorePageScrollTop,
    setMainHeader,
    state,
    syncNavigationState,
    syncRouteAfterNavigation,
    toastInline,
    workCoverUrl
  } = deps;

  let peopleIndexLoadObserver = null;
  let peopleIndexLoadPending = false;
  let personDetailHoverTimer = null;
  let personDetailHoverTarget = "";
  const personIndexRecords = new WeakMap();
  const personDetailPrefetches = createPrefetchCache({ limit: PERSON_DETAIL_PREFETCH_LIMIT, ttlMs: PERSON_DETAIL_PREFETCH_TTL_MS });
  const personDetailRequests = createLatestRequestGate();
  bindPeopleIndexInteractions();

function cancelPendingSelection() {
  personDetailRequests.cancel();
  state.personWorksLoadingMore = false;
  cancelPersonDetailPrefetch();
  personDetailPrefetches.clear();
}

function filteredPeople() {
  return state.people.filter((person) => person?.actorProfile?.gender !== "male");
}

function showPeopleIndex(options = {}) {
  onNavigationStarted?.(options);
  cancelPendingSelection();
  state.activeView = "people";
  state.selectedPersonId = null;
  state.selectedPerson = null;
  state.searchPeople = [];
  state.works = [];
  state.personWorksTotal = 0;
  state.personWorksFacets = null;
  syncNavigationState("people");
  hidePersonProfile();
  setMainHeader(
    state.peopleScope === "western" ? "欧美人物" : "人物",
    `${formatNumber(filteredPeople().length)} 位人物 · 按人物浏览资料库`
  );
  renderPeopleIndexStats();
  renderPeopleIndex();
  if (options.restoreScroll !== false) {
    restorePageScrollTop(state.peopleIndexScrollTop);
  }
  syncRouteAfterNavigation({
    ...options,
    routeOverrides: { view: "people", peopleScope: state.peopleScope || "main", personId: "", q: "", workId: "", videoId: "" }
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
  disconnectPeopleIndexAutoload();

  const start = Math.max(0, state.personVisibleLimit);
  const nextLimit = Math.min(people.length, start + state.personPageSize);
  const loadMoreRow = els.workGrid.querySelector(".people-index-load-more");
  const fragment = document.createDocumentFragment();
  for (const person of people.slice(start, nextLimit)) {
    fragment.append(createPersonIndexCard(person));
  }
  if (loadMoreRow) loadMoreRow.before(fragment);
  else els.workGrid.append(fragment);
  state.personVisibleLimit = nextLimit;

  if (!loadMoreRow) return;
  if (nextLimit >= people.length) {
    loadMoreRow.remove();
    return;
  }
  const button = loadMoreRow.querySelector("button");
  if (button) button.textContent = `显示更多人物 ${formatNumber(nextLimit)} / ${formatNumber(people.length)}`;
  observePeopleIndexLoadMore(loadMoreRow);
}

function observePeopleIndexLoadMore(target) {
  if (!("IntersectionObserver" in window)) return;
  peopleIndexLoadObserver = new IntersectionObserver(
    (entries) => {
      if (peopleIndexLoadPending || !entries.some((entry) => entry.isIntersecting)) return;
      peopleIndexLoadPending = true;
      peopleIndexLoadObserver?.disconnect();
      window.setTimeout(() => {
        peopleIndexLoadPending = false;
        loadMorePeopleIndex();
      }, 80);
    },
    { root: null, rootMargin: "720px 0px", threshold: 0 }
  );
  peopleIndexLoadObserver.observe(target);
}

function appendPeopleIndexLoadMore(visibleCount, totalCount) {
  const wrap = document.createElement("div");
  wrap.className = "load-more-row people-index-load-more";

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
  return person?.avatarUrl || person?.actorProfile?.avatarUrl || coverUrl(person?.coverId);
}

function createPersonIndexCard(person) {
  const displayName = displayPersonName(person);
  const card = document.createElement("button");
  card.type = "button";
  card.className = "person-index-card";
  personIndexRecords.set(card, person);

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
      avatar.textContent = displayName.slice(0, 2);
    });
    avatar.append(img);
  } else {
    avatar.classList.add("empty");
    avatar.textContent = displayName.slice(0, 2);
  }

  const body = document.createElement("div");
  body.className = "person-index-body";

  const name = document.createElement("div");
  name.className = "person-index-name";
  name.textContent = displayName;
  name.title = displayName;

  body.append(name);
  card.append(avatar, body);
  return card;
}

function bindPeopleIndexInteractions() {
  const root = els.workGrid;
  root.addEventListener("click", (event) => {
    const person = personIndexRecord(root, event.target);
    if (!person) return;
    clearWorkSearch();
    selectPerson(person.id);
  });
  root.addEventListener("pointerover", (event) => {
    const card = personIndexCard(root, event.target);
    if (!card || card.contains(event.relatedTarget)) return;
    const person = personIndexRecords.get(card);
    if (!person) return;
    preparePersonProfile?.();
    schedulePersonDetailPrefetch(person.id);
  }, { passive: true });
  root.addEventListener("pointerout", (event) => {
    const card = personIndexCard(root, event.target);
    if (!card || card.contains(event.relatedTarget)) return;
    cancelPersonDetailPrefetch(personIndexRecords.get(card)?.id);
  }, { passive: true });
  root.addEventListener("focusin", (event) => preparePersonDetailFromIntent(root, event.target));
  root.addEventListener("pointerdown", (event) => preparePersonDetailFromIntent(root, event.target), { passive: true });
}

function preparePersonDetailFromIntent(root, target) {
  const person = personIndexRecord(root, target);
  if (!person) return;
  preparePersonProfile?.();
  prefetchPersonDetails(person.id);
}

function personIndexRecord(root, target) {
  const card = personIndexCard(root, target);
  return card ? personIndexRecords.get(card) : null;
}

function personIndexCard(root, target) {
  const card = target?.closest?.(".person-index-card");
  return card && root.contains(card) ? card : null;
}

async function selectPerson(personId, options = {}) {
  onNavigationStarted?.(options);
  const request = personDetailRequests.begin();
  state.personWorksLoadingMore = false;
  if (options.reusePrefetch === false) invalidatePersonDetailPrefetches(personId);
  preparePersonProfile?.();
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
  const indexedPerson = state.people.find((person) => String(person.id) === String(personId)) || null;
  state.works = [];
  els.workGrid.innerHTML = `<div class="empty-state">正在加载作品</div>`;
  if (indexedPerson) {
    state.selectedPerson = { ...indexedPerson, detailPending: true };
    setMainHeader(
      indexedPerson.actorProfile?.displayName || indexedPerson.name,
      formatLibraryPaths(indexedPerson.sourcePaths || [indexedPerson.relativePath])
    );
    renderPersonProfile(state.selectedPerson);
  }

  try {
    const data = await fetchPersonWorksPage(personId, 0, {
      reusePrefetch: options.reusePrefetch !== false,
      signal: request.signal
    });
    if (!request.isCurrent() || state.activeView !== "people" || state.selectedPersonId !== personId) return;
    state.selectedPerson = mergeIndexedPerson(indexedPerson, data.person, data.works);
    const resolvedPersonId = state.selectedPerson?.id || personId;
    state.selectedPersonId = resolvedPersonId;
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
      routeOverrides: { view: "people", peopleScope: state.peopleScope || "main", personId: resolvedPersonId, q: "", workId: "", videoId: "" }
    });
  } catch (error) {
    if (!request.signal.aborted) throw error;
  } finally {
    request.finish();
  }
}

async function loadMoreWorks(button) {
  if (state.personWorksLoadingMore || state.activeView !== "people" || !state.selectedPersonId) return;
  if (state.works.length >= state.personWorksTotal) return;
  const personId = state.selectedPersonId;
  const query = personDetailRequestUrl(personId, 0);
  const request = personDetailRequests.begin();
  state.personWorksLoadingMore = true;
  const originalText = button?.textContent || "";
  let restoreText = true;
  if (button) { button.disabled = true; button.textContent = "正在加载"; }
  try {
    const data = await fetchPersonWorksPage(personId, state.works.length, { signal: request.signal });
    if (!request.isCurrent() || state.activeView !== "people" || state.selectedPersonId !== personId
      || personDetailRequestUrl(personId, 0) !== query) return;
    const seen = new Set(state.works.map((work) => work.id));
    state.works.push(...(data.works || []).filter((work) => !seen.has(work.id)));
    state.workVisibleLimit = Math.max(state.workVisibleLimit, state.works.length);
    state.selectedPerson = data.person || state.selectedPerson;
    state.personWorksTotal = data.total ?? state.personWorksTotal ?? state.works.length;
    state.personWorksFacets = data.facets || state.personWorksFacets || null;
    renderPersonProfile(state.selectedPerson);
    renderPersonWorkStats();
    appendLoadedWorkPage();
  } catch (error) {
    if (!request.isCurrent()) return;
    toastInline(button, error.message || "加载失败", originalText);
    restoreText = false;
  } finally {
    if (request.isCurrent()) {
      state.personWorksLoadingMore = false;
      if (button?.isConnected) {
        button.disabled = false;
        if (restoreText) button.textContent = originalText || button.textContent;
      }
    }
    request.finish();
  }
}

function mergeIndexedPerson(indexedPerson, detailPerson, works = []) {
  const fallbackAvatarUrl = detailPerson?.avatarUrl
    || indexedPerson?.avatarUrl
    || works.map((work) => workCoverUrl(work)).find(Boolean)
    || "";
  if (!indexedPerson) return { ...detailPerson, avatarUrl: fallbackAvatarUrl, detailPending: false };
  return {
    ...indexedPerson,
    ...detailPerson,
    actorProfile: detailPerson?.actorProfile || indexedPerson.actorProfile || null,
    avatarUrl: fallbackAvatarUrl,
    detailPending: false
  };
}

function personWorkPageSize() {
  const viewportLimit = globalThis.matchMedia?.("(max-width: 720px)")?.matches
    ? PERSON_DETAIL_MOBILE_PAGE_SIZE
    : PERSON_DETAIL_DESKTOP_PAGE_SIZE;
  return Math.max(40, Math.min(viewportLimit, Number(state.workPageSize) || PERSON_DETAIL_MOBILE_PAGE_SIZE));
}

async function fetchPersonWorksPage(personId, offset = 0, options = {}) {
  const requestUrl = personDetailRequestUrl(personId, offset);
  if (options.reusePrefetch && offset === 0) {
    const cached = personDetailPrefetches.consume(requestUrl, options.signal);
    if (cached) {
      const result = await cached;
      if (options.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
      if (result.error) throw result.error;
      if (result.data !== null) return result.data;
    }
  }
  return api(requestUrl, options.signal ? { signal: options.signal } : {});
}

function personDetailRequestUrl(personId, offset = 0) {
  const params = new URLSearchParams({
    limit: String(personWorkPageSize()),
    offset: String(offset || 0),
    sort: state.sortMode || "releaseDesc",
    filter: typeof getWorkFilterMode === "function" ? getWorkFilterMode() : state.filterMode || "all",
    includeMissingLocal: state.showMissingLocalWorks ? "1" : "0",
    includeCompilation: state.showCompilationWorks ? "1" : "0"
  });
  if (state.peopleScope && state.peopleScope !== "main") params.set("scope", state.peopleScope);
  return `/api/people/${encodeURIComponent(personId)}?${params}`;
}

function schedulePersonDetailPrefetch(personId) {
  cancelPersonDetailPrefetch();
  personDetailHoverTarget = String(personId || "");
  personDetailHoverTimer = window.setTimeout(() => {
    personDetailHoverTimer = null;
    personDetailHoverTarget = "";
    prefetchPersonDetails(personId);
  }, PERSON_DETAIL_HOVER_DELAY_MS);
}

function cancelPersonDetailPrefetch(personId = "") {
  if (personId && personDetailHoverTarget !== String(personId)) return;
  if (personDetailHoverTimer) window.clearTimeout(personDetailHoverTimer);
  personDetailHoverTimer = null;
  personDetailHoverTarget = "";
}

function prefetchPersonDetails(personId) {
  cancelPersonDetailPrefetch();
  if (globalThis.navigator?.connection?.saveData) return Promise.resolve(null);
  const requestUrl = personDetailRequestUrl(personId, 0);
  return personDetailPrefetches.prefetch(requestUrl, (signal) => api(requestUrl, { signal }))
    .then((result) => result.data);
}

function invalidatePersonDetailPrefetches(personId) {
  const prefix = `/api/people/${encodeURIComponent(personId)}?`;
  personDetailPrefetches.clear((requestUrl) => requestUrl.startsWith(prefix));
}

async function goToPerson(personId) {
  if (!personId) return;
  clearWorkSearch();
  await selectPerson(personId);
}

function resetPersonPaging() {
  state.personVisibleLimit = state.personPageSize;
}

function personIndexPageSize() {
  return globalThis.matchMedia?.("(max-width: 720px)")?.matches
    ? PERSON_INDEX_MOBILE_PAGE_SIZE
    : PERSON_INDEX_DESKTOP_PAGE_SIZE;
}

  return {
    cancelPendingSelection,
    disconnectIndexAutoload: disconnectPeopleIndexAutoload,
    fetchPersonWorksPage,
    goToPerson,
    loadMoreWorks,
    personIndexPageSize,
    personWorkPageSize,
    renderIndex: renderPeopleIndex,
    renderIndexStats: renderPeopleIndexStats,
    resetPaging: resetPersonPaging,
    selectPerson,
    showIndex: showPeopleIndex
  };
}
